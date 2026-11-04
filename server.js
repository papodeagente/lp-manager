import express from 'express';
import session from 'express-session';
import compression from 'compression';
import multer from 'multer';
import AdmZip from 'adm-zip';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, once } from './lib/db.js';
import {
  SqliteStore, verifyPassword, isPasswordHash, normEmail, loginAttempt, loginSucceeded, sleep,
  sameOriginOnly, tokenMatches, safeNext,
} from './lib/auth.js';
import { webhookProblem } from './lib/webhook.js';
import { makePages, pathOfUrl } from './lib/pages.js';
import {
  makeTracking, ensureVisitor, visitorOf, isBot, eventRateOk, injectTracker, trackerVersion,
  leadAttributionFromUrl, deviceOf, CHANNELS,
} from './lib/tracking.js';
import { makeStats } from './lib/stats.js';
import * as fmt from './lib/format.js';
import { registerAdmin } from './lib/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SITES_DIR = path.join(DATA_DIR, 'sites');
const DB_PATH = path.join(DATA_DIR, 'lps.db');

const ADMIN_HOST = process.env.ADMIN_HOST || 'admin.lps.entur.com.br';
// Suporta múltiplos hosts admin (separados por vírgula).
const ADMIN_HOSTS = ADMIN_HOST.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
// Dono do painel: criado no boot a partir do hash (nunca da senha em texto). Gere o
// hash com `node scripts/hash-password.js`.
const SUPERADMIN_EMAIL = normEmail(process.env.SUPERADMIN_EMAIL);
const SUPERADMIN_NAME = (process.env.SUPERADMIN_NAME || '').trim();
const SUPERADMIN_PASSWORD_HASH = (process.env.SUPERADMIN_PASSWORD_HASH || '').trim();
// Token para publicar ZIP por linha de comando (Authorization: Bearer ...).
const DEPLOY_TOKEN = (process.env.DEPLOY_TOKEN || '').trim();
const PANEL_TITLE = (process.env.PANEL_TITLE || 'Glazi Melo').trim();

const COOLIFY_HOST = process.env.COOLIFY_HOST || '';
const COOLIFY_TOKEN = process.env.COOLIFY_TOKEN || '';
const COOLIFY_APP_UUID = process.env.COOLIFY_APP_UUID || '';

fs.mkdirSync(SITES_DIR, { recursive: true });

const db = openDb(DB_PATH);

const stmts = {
  list: db.prepare('SELECT * FROM lps ORDER BY updated_at DESC'),
  get: db.prepare('SELECT * FROM lps WHERE slug = ?'),
  getByDomain: db.prepare('SELECT * FROM lps WHERE custom_domain = ?'),
  insert: db.prepare('INSERT INTO lps (slug, name, custom_domain, index_file, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'),
  updateDomain: db.prepare('UPDATE lps SET custom_domain = ?, updated_at = ? WHERE slug = ?'),
  updateIndex: db.prepare('UPDATE lps SET index_file = ?, updated_at = ? WHERE slug = ?'),
  touch: db.prepare('UPDATE lps SET updated_at = ? WHERE slug = ?'),
  delete: db.prepare('DELETE FROM lps WHERE slug = ?'),
};

// ── Leads + webhook por site (e, se configurado, por página) ────────────────
const leadStmts = {
  insert: db.prepare(`INSERT INTO leads (slug, name, phone, message, source, page_url, user_agent, ip, webhook_status, created_at,
      page_id, page_path, visit_id, visitor_id, utm_source, utm_medium, utm_campaign, utm_term, utm_content, click_type, click_id,
      channel, referrer, landing_page, device, first_source, first_medium, first_campaign, first_seen)
    VALUES (@slug, @name, @phone, @message, @source, @page_url, @user_agent, @ip, @webhook_status, @created_at,
      @page_id, @page_path, @visit_id, @visitor_id, @utm_source, @utm_medium, @utm_campaign, @utm_term, @utm_content, @click_type, @click_id,
      @channel, @referrer, @landing_page, @device, @first_source, @first_medium, @first_campaign, @first_seen)`),
  countBySlug: db.prepare('SELECT COUNT(*) AS n FROM leads WHERE slug = ?'),
  setStatus: db.prepare('UPDATE leads SET webhook_status = ? WHERE id = ?'),
};
const setWebhookUrl = db.prepare('UPDATE lps SET webhook_url = ? WHERE slug = ?');

const pages = makePages(db);
const tracking = makeTracking(db, pages);
const stats = makeStats(db);
const LEAD_FIELDS = ['page_id', 'page_path', 'visit_id', 'visitor_id', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term',
  'utm_content', 'click_type', 'click_id', 'channel', 'referrer', 'landing_page', 'device', 'first_source', 'first_medium',
  'first_campaign', 'first_seen'];

// Dispara o webhook do CRM (POST JSON). Retorna um status curto pra log/UI.
// Normaliza telefone BR pra formatos que CRMs entendem (limpo, com DDI 55).
function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '').replace(/^0+/, '');
  if (!d) return { full: '', e164: '', local: '' };
  let full;
  if (d.startsWith('55') && d.length >= 12) full = d;            // já tem DDI
  else if (d.length === 10 || d.length === 11) full = '55' + d;  // DDD + número
  else full = d;
  const local = full.startsWith('55') ? full.slice(2) : full;
  return { full, e164: '+' + full, local };
}

function webhookPayload(lp, lead, page) {
  const ph = normalizePhone(lead.phone);
  const utm = {
    source: lead.utm_source || '', medium: lead.utm_medium || '', campaign: lead.utm_campaign || '',
    term: lead.utm_term || '', content: lead.utm_content || '',
  };
  return {
    event: 'lead.created',
    lp: lp.slug,
    lp_name: lp.name,
    page: lead.page_path || '',
    page_name: page ? page.name : '',
    name: lead.name,
    // telefone em vários formatos pra mapear em qualquer CRM:
    phone: ph.full,               // 5561999990000 (limpo, com DDI)
    phone_e164: ph.e164,          // +5561999990000
    phone_local: ph.local,        // 61999990000
    phone_formatted: lead.phone,  // (61) 99999-0000 (exibição)
    email: '',
    message: lead.message,
    source: lead.source,
    page_url: lead.page_url,
    created_at: new Date(lead.created_at).toISOString(),
    // origem atribuída (UTM da visita que converteu; ver lib/tracking.js)
    utm_source: utm.source,
    utm_medium: utm.medium,
    utm_campaign: utm.campaign,
    utm_term: utm.term,
    utm_content: utm.content,
    utm,
    channel: lead.channel ? (CHANNELS[lead.channel] || lead.channel) : '',
    gclid: lead.click_type === 'gclid' ? lead.click_id : '',
    click_id: lead.click_id || '',
    click_id_type: lead.click_type || '',
    landing_page: lead.landing_page || '',
    referrer: lead.referrer || '',
    device: lead.device || '',
    first_touch: lead.first_source ? {
      source: lead.first_source, medium: lead.first_medium || '', campaign: lead.first_campaign || '',
      date: lead.first_seen ? new Date(lead.first_seen).toISOString() : '',
    } : null,
    // objeto aninhado pra automações que esperam contact.*
    contact: { name: lead.name, phone: ph.full, phone_e164: ph.e164, email: '' },
  };
}

// URL do webhook de um lead: a da página, se tiver, senão a do site.
function webhookFor(lp, page) {
  return (page && page.webhook_url) || lp.webhook_url || null;
}

async function fireWebhook(lp, lead, page, url = webhookFor(lp, page)) {
  if (!url) return 'sem-webhook';
  try {
    const problem = await webhookProblem(url);
    if (problem) return `erro: ${problem}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'lp-manager-webhook/1' },
      body: JSON.stringify(webhookPayload(lp, lead, page)),
      signal: ctrl.signal,
      redirect: 'manual',
    });
    clearTimeout(t);
    return r.ok ? `ok ${r.status}` : `http ${r.status}`;
  } catch (e) {
    return `erro: ${(e.message || 'falha').slice(0, 50)}`;
  }
}

// Rate-limit simples por IP (anti-spam): máx 8 leads/min.
const leadRate = new Map();
function leadRateOk(ip) {
  const now = Date.now();
  const arr = (leadRate.get(ip) || []).filter((t) => now - t < 60000);
  if (arr.length >= 8) { leadRate.set(ip, arr); return false; }
  arr.push(now); leadRate.set(ip, arr); return true;
}

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(compression({ threshold: 1024 }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const sessionStore = new SqliteStore(db);
const adminSession = session({
  name: 'lpm.sid',
  secret: SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

function isAdminHost(req) {
  const host = (req.hostname || '').toLowerCase();
  return ADMIN_HOSTS.includes(host) || host === 'localhost' || host.endsWith('.sslip.io');
}

// ── Quem está usando o painel ────────────────────────────────────────────────
// Dois papéis: "super" (dono: usuários, arquivos, domínios) e "admin" (resultados,
// leads, links e páginas). A sessão guarda só o id do usuário; a cada pedido o
// usuário é relido do banco, então desativar ou trocar a senha derruba na hora.
const userQ = {
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
  byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  touchLogin: db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?'),
  count: db.prepare('SELECT COUNT(*) AS n FROM users'),
};
const auditInsert = db.prepare('INSERT INTO audit (user_id, user_email, action, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)');

function clientIp(req) {
  return String(req.ip || '').slice(0, 64);
}

// Rotas assíncronas: o erro vai para o tratador do Express em vez de derrubar o
// processo (que serve também as páginas públicas e o /api/lead).
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function audit(req, action, detail = null, who = req.user) {
  try {
    auditInsert.run(who?.id || null, who?.email || null, action, detail ? String(detail).slice(0, 300) : null, clientIp(req), Date.now());
  } catch (e) { console.error('[audit]', e.message); }
}

function loadUser(req, res, next) {
  const uid = req.session?.uid;
  if (uid) {
    const u = userQ.byId.get(uid);
    if (u && u.active && u.password_changed_at === req.session.pwdAt) req.user = u;
    else delete req.session.uid;
  }
  res.locals.user = req.user || null;
  next();
}

function deployTokenOk(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  return !!m && tokenMatches(m[1].trim(), DEPLOY_TOKEN);
}

function requireAuth(req, res, next) {
  if (req.user) {
    if (req.user.must_change_password && !['/admin/conta/senha', '/admin/logout'].includes(req.path)) {
      return req.method === 'GET' ? res.redirect('/admin/conta/senha') : res.status(403).send('Troque a senha provisória antes de continuar.');
    }
    return next();
  }
  if (req.method === 'GET') return res.redirect('/admin/login' + (req.originalUrl !== '/admin' ? '?next=' + encodeURIComponent(req.originalUrl) : ''));
  return res.status(401).json({ error: 'unauthorized' });
}

function requireSuper(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role === 'super') return next();
    res.status(403);
    return render(req, res, 'error', { title: 'Sem acesso', message: 'Esta área é só do super admin.' });
  });
}

// Upload e lista de arquivos aceitam também o token de publicação.
function requireSuperOrToken(req, res, next) {
  if (deployTokenOk(req)) {
    req.user = { id: null, email: 'token-de-publicacao', name: 'Token de publicação', role: 'super' };
    req.viaToken = true;
    return next();
  }
  return requireSuper(req, res, next);
}

const ASSET_V = (() => {
  const h = crypto.createHash('sha256');
  for (const f of ['admin.css', 'admin.js']) { try { h.update(fs.readFileSync(path.join(__dirname, 'public', f))); } catch (_) {} }
  return h.digest('hex').slice(0, 10);
})();

// Toda tela do painel passa por aqui: sem cache (tem dado pessoal) e com o menu.
function render(req, res, view, data = {}) {
  res.set('Cache-Control', 'no-store');
  res.render(view, {
    title: '', flash: null, flashWarn: null, panelTitle: PANEL_TITLE, assetV: ASSET_V, fmt,
    navPages: req.user ? pages.live() : [], path: req.path, user: req.user || null, ...data,
  });
}

function takeFlash(req) {
  const out = { flash: req.session?.flash || null, flashWarn: req.session?.flashWarn || null };
  if (req.session) { req.session.flash = null; req.session.flashWarn = null; }
  return out;
}

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function siteDir(slug) {
  return path.join(SITES_DIR, slug);
}

function listLPs() {
  return stmts.list.all().map((lp) => {
    const dir = siteDir(lp.slug);
    const exists = fs.existsSync(dir);
    let size = 0;
    let files = 0;
    if (exists) {
      const walk = (p) => {
        for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
          const fp = path.join(p, entry.name);
          if (entry.isDirectory()) walk(fp);
          else {
            files++;
            size += fs.statSync(fp).size;
          }
        }
      };
      try { walk(dir); } catch (_) {}
    }
    const htmls = exists ? listHtmls(dir) : [];
    const leads_count = leadStmts.countBySlug.get(lp.slug).n;
    return { ...lp, files, size, has_files: exists, htmls, leads_count };
  });
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function extractZip(buffer, destDir) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries().filter((e) => !e.entryName.startsWith('__MACOSX/') && !e.entryName.endsWith('/.DS_Store'));
  if (!entries.length) throw new Error('ZIP vazio');

  const topLevels = new Set();
  for (const e of entries) {
    const top = e.entryName.split('/')[0];
    if (top) topLevels.add(top);
  }
  const stripRoot = topLevels.size === 1 && entries.some((e) => e.entryName.includes('/'));
  const rootPrefix = stripRoot ? [...topLevels][0] + '/' : '';

  rmrf(destDir);
  fs.mkdirSync(destDir, { recursive: true });

  for (const e of entries) {
    if (e.isDirectory) continue;
    const relPath = stripRoot && e.entryName.startsWith(rootPrefix)
      ? e.entryName.slice(rootPrefix.length)
      : e.entryName;
    if (!relPath) continue;
    const outPath = path.join(destDir, relPath);
    if (!outPath.startsWith(destDir + path.sep)) continue;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, e.getData());
  }

  return detectIndex(destDir);
}

function detectIndex(dir) {
  if (fs.existsSync(path.join(dir, 'index.html'))) return 'index.html';
  const htmls = [];
  const walk = (p, rel = '') => {
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const sub = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(p, entry.name), sub);
      else if (entry.name.toLowerCase().endsWith('.html')) htmls.push(sub);
    }
  };
  walk(dir);
  return htmls[0] || 'index.html';
}

// ── Cache-busting ──────────────────────────────────────────────────────────
// Acrescenta ?v=<versão da LP> nas referências de assets do HTML/CSS. Assim os
// assets ficam com cache "immutable" (carregamento ultra rápido em revisitas),
// mas todo re-upload muda a versão → a URL muda → o browser baixa o novo. Sem
// isso, imagens de mesmo nome ficavam presas no cache por 1 ano.
const BUSTABLE_EXT = new Set([
  'css', 'js', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico', 'avif',
  'woff', 'woff2', 'ttf', 'eot', 'otf', 'mp4', 'webm', 'ogg', 'mp3', 'm4a',
]);

function isBustable(url) {
  if (!url) return false;
  const u = url.trim();
  if (/^(https?:)?\/\//i.test(u)) return false;
  if (/^(data:|blob:|mailto:|tel:|javascript:|#)/i.test(u)) return false;
  const ext = u.split(/[?#]/)[0].split('.').pop()?.toLowerCase();
  return !!ext && BUSTABLE_EXT.has(ext);
}

function withVersion(url, v) {
  if (!isBustable(url) || /[?&]v=/.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + 'v=' + v;
}

function bustRefs(text, v) {
  text = text.replace(/\b(src|href|poster)\s*=\s*("|')(.*?)\2/gi,
    (_m, attr, q, url) => `${attr}=${q}${withVersion(url, v)}${q}`);
  text = text.replace(/\bsrcset\s*=\s*("|')(.*?)\1/gi, (_m, q, val) => {
    const out = val.split(',').map((part) => {
      const seg = part.trim();
      const sp = seg.indexOf(' ');
      return sp === -1
        ? withVersion(seg, v)
        : withVersion(seg.slice(0, sp), v) + seg.slice(sp);
    }).join(', ');
    return `srcset=${q}${out}${q}`;
  });
  text = text.replace(/url\(\s*("|'|)([^"')]+)\1\s*\)/gi,
    (_m, q, url) => `url(${q}${withVersion(url, v)}${q})`);
  return text;
}

const IMMUTABLE = 'public, max-age=31536000, immutable';
const LONG_CACHE_EXT = new Set([
  '.js', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico', '.avif',
  '.mp4', '.webm', '.ogg', '.mp3', '.m4a', '.woff', '.woff2', '.ttf', '.eot', '.otf',
]);

// Script de medição (public/t.js), versionado pelo conteúdo.
const TRACKER_SRC = fs.readFileSync(path.join(__dirname, 'public', 't.js'), 'utf8');
const TRACKER_V = trackerVersion(TRACKER_SRC);

function serveStatic(req, res, lp, filePath, { track = false } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const v = lp.updated_at;
  if (ext === '.html' || ext === '.htm' || ext === '') {
    res.set('Cache-Control', 'no-cache');
    let html = bustRefs(fs.readFileSync(filePath, 'utf8'), v);
    if (track) {
      html = injectTracker(html, TRACKER_V);
      ensureVisitor(req, res);
    }
    return res.type('html').send(html);
  }
  if (ext === '.css') {
    res.set('Cache-Control', IMMUTABLE);
    return res.type('css').send(bustRefs(fs.readFileSync(filePath, 'utf8'), v));
  }
  res.set('Cache-Control', LONG_CACHE_EXT.has(ext) ? IMMUTABLE : 'no-cache');
  return res.sendFile(filePath);
}

// ── Compressão de imagens ──────────────────────────────────────────────────
// Roda após extrair o ZIP: redimensiona imagens gigantes e re-encoda (mantendo
// o formato, pra não quebrar as referências) — só substitui se ficar menor.
const MAX_IMG_WIDTH = 2000;

// Carrega o sharp sob demanda. Se o binário nativo não estiver disponível no
// host, a compressão é pulada silenciosamente em vez de derrubar o servidor.
let _sharp;
async function loadSharp() {
  if (_sharp !== undefined) return _sharp;
  try {
    _sharp = (await import('sharp')).default;
  } catch (e) {
    console.error('[optimize] sharp indisponível, pulando compressão:', e.message);
    _sharp = null;
  }
  return _sharp;
}

async function optimizeImages(dir) {
  const sharp = await loadSharp();
  if (!sharp) return { count: 0, before: 0, after: 0 };

  const files = [];
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const fp = path.join(p, e.name);
      if (e.isDirectory()) walk(fp);
      else files.push(fp);
    }
  };
  try { walk(dir); } catch { return { count: 0, before: 0, after: 0 }; }

  let count = 0, before = 0, after = 0;
  for (const fp of files) {
    const ext = path.extname(fp).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) continue;
    try {
      const orig = fs.readFileSync(fp);
      const img = sharp(orig, { failOn: 'none' }).rotate();
      const meta = await img.metadata();
      let pipe = img;
      if (meta.width && meta.width > MAX_IMG_WIDTH) {
        pipe = pipe.resize({ width: MAX_IMG_WIDTH, withoutEnlargement: true });
      }
      if (ext === '.png') pipe = pipe.png({ compressionLevel: 9, effort: 10 });
      else if (ext === '.webp') pipe = pipe.webp({ quality: 80, effort: 5 });
      else pipe = pipe.jpeg({ quality: 82, mozjpeg: true });
      const out = await pipe.toBuffer();
      if (out.length < orig.length) {
        fs.writeFileSync(fp, out);
        count++; before += orig.length; after += out.length;
      }
    } catch (e) {
      console.warn('[optimize] skip', fp, e.message);
    }
  }
  return { count, before, after };
}

function fmtKB(b) {
  return b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1024 / 1024).toFixed(2)} MB`;
}

// ── Unbundle do "standalone" do Claude Design ──────────────────────────────
// O export standalone é um HTML de vários MB: 99% JS, com os assets em
// base64+gzip num <script type="__bundler/manifest"> e o HTML real num
// <script type="__bundler/template">, remontados via blob: no cliente
// (lento). Aqui desempacotamos: gravamos cada asset como arquivo real,
// convertemos fotos PNG/JPEG pra WebP e reescrevemos as refs do template.
// Resultado: HTML pequeno + assets cacheáveis em paralelo.
const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg',
  'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
  'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf',
  'application/font-woff2': 'woff2', 'application/font-woff': 'woff',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3',
  'text/css': 'css', 'application/javascript': 'js', 'text/javascript': 'js',
};
function mimeToExt(mime) {
  if (MIME_EXT[mime]) return MIME_EXT[mime];
  const sub = String(mime || '').split('/')[1] || 'bin';
  return sub.split('+')[0].replace(/[^a-z0-9]/gi, '') || 'bin';
}

function grabBundlerTag(html, type) {
  const re = new RegExp(`<script\\s+type="${type.replace('/', '\\/')}"[^>]*>([\\s\\S]*?)<\\/script>`, 'i');
  const m = re.exec(html);
  return m ? m[1] : null;
}

function isStandaloneBundle(html) {
  return /<script\s+type="__bundler\/manifest"/i.test(html);
}

async function unbundleStandalone(html) {
  const manifestRaw = grabBundlerTag(html, '__bundler/manifest');
  const templateRaw = grabBundlerTag(html, '__bundler/template');
  if (!manifestRaw || !templateRaw) return null;
  let manifest, template;
  try {
    manifest = JSON.parse(manifestRaw);
    template = JSON.parse(templateRaw);
  } catch {
    return null;
  }

  const sharp = await loadSharp();
  const assets = [];
  const map = {};
  for (const [uuid, a] of Object.entries(manifest)) {
    let buf = Buffer.from(a.data, 'base64');
    if (a.compressed) { try { buf = zlib.gunzipSync(buf); } catch {} }
    let ext = mimeToExt(a.mime);
    if (sharp && (a.mime === 'image/png' || a.mime === 'image/jpeg')) {
      try {
        const img = sharp(buf, { failOn: 'none' }).rotate();
        const meta = await img.metadata();
        let pipe = img;
        if (meta.width && meta.width > MAX_IMG_WIDTH) {
          pipe = pipe.resize({ width: MAX_IMG_WIDTH, withoutEnlargement: true });
        }
        const webp = await pipe.webp({ quality: 82, effort: 5 }).toBuffer();
        if (webp.length < buf.length) { buf = webp; ext = 'webp'; }
      } catch (e) {
        console.warn('[unbundle] conversão webp falhou', uuid, e.message);
      }
    }
    const rel = `assets/${uuid}.${ext}`;
    assets.push({ name: rel, buffer: buf });
    map[uuid] = rel;
  }
  for (const [uuid, rel] of Object.entries(map)) template = template.split(uuid).join(rel);
  return { indexHtml: template, assets };
}

function listHtmls(dir) {
  const out = [];
  const walk = (p, rel = '') => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const sub = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(p, e.name), sub);
      else if (e.name.toLowerCase().endsWith('.html')) out.push(sub);
    }
  };
  try { walk(dir); } catch {}
  return out;
}

// Decide qual HTML é a home. Se tem index.html, usa. Se tem 1 só, usa. Se tem
// vários e nenhum index.html, marca ambíguo (o handler avisa e deixa escolher).
function resolveIndex(dir) {
  if (fs.existsSync(path.join(dir, 'index.html'))) {
    return { index: 'index.html', ambiguous: false, candidates: ['index.html'] };
  }
  const htmls = listHtmls(dir);
  if (htmls.length === 0) return { index: 'index.html', ambiguous: false, candidates: [] };
  if (htmls.length === 1) return { index: htmls[0], ambiguous: false, candidates: htmls };
  // Vários HTMLs sem index.html: default = um que contenha "index", senão o 1º.
  const prefer = htmls.find((h) => /index/i.test(path.basename(h))) || htmls[0];
  return { index: prefer, ambiguous: true, candidates: htmls };
}

// Desempacota UM arquivo HTML específico se ele for standalone; senão retorna null.
async function unbundleHtml(dir, htmlAbsPath) {
  let html;
  try { html = fs.readFileSync(htmlAbsPath, 'utf8'); } catch { return null; }
  if (!isStandaloneBundle(html)) return null;
  const result = await unbundleStandalone(html);
  if (!result) return null;
  for (const a of result.assets) {
    const out = path.join(dir, a.name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, a.buffer);
  }
  fs.writeFileSync(path.join(dir, 'index.html'), result.indexHtml);
  if (path.basename(htmlAbsPath).toLowerCase() !== 'index.html') { try { fs.rmSync(htmlAbsPath); } catch {} }
  return { index: 'index.html', assets: result.assets.length };
}

function domainVariants(apex) {
  return [`https://${apex}`, `https://www.${apex}`];
}

async function coolifyAddDomain(domain) {
  if (!COOLIFY_HOST || !COOLIFY_TOKEN || !COOLIFY_APP_UUID) {
    console.warn('[coolify] credentials missing, skipping domain sync');
    return { ok: false, reason: 'missing-credentials' };
  }
  const cur = await coolifyGetApp();
  if (!cur) return { ok: false, reason: 'get-app-failed' };
  const fqdns = (cur.fqdn || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const target of domainVariants(domain)) {
    if (!fqdns.includes(target)) fqdns.push(target);
  }
  return coolifyPatchFqdn(fqdns);
}

async function coolifyRemoveDomain(domain) {
  if (!COOLIFY_HOST || !COOLIFY_TOKEN || !COOLIFY_APP_UUID) return { ok: false, reason: 'missing-credentials' };
  const cur = await coolifyGetApp();
  if (!cur) return { ok: false, reason: 'get-app-failed' };
  const drop = new Set([
    `https://${domain}`, `http://${domain}`,
    `https://www.${domain}`, `http://www.${domain}`,
  ]);
  const fqdns = (cur.fqdn || '').split(',').map((s) => s.trim()).filter(Boolean)
    .filter((f) => !drop.has(f));
  return coolifyPatchFqdn(fqdns);
}

async function coolifyGetApp() {
  try {
    const res = await fetch(`${COOLIFY_HOST}/api/v1/applications/${COOLIFY_APP_UUID}`, {
      headers: { Authorization: `Bearer ${COOLIFY_TOKEN}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error('[coolify] get app failed', e.message);
    return null;
  }
}

async function coolifyPatchFqdn(fqdns) {
  try {
    const res = await fetch(`${COOLIFY_HOST}/api/v1/applications/${COOLIFY_APP_UUID}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${COOLIFY_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ domains: fqdns.join(',') }),
    });
    if (!res.ok) return { ok: false, reason: `patch-${res.status}` };
    return { ok: true, fqdns };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function scheduleCoolifyRestart() {
  if (!COOLIFY_HOST || !COOLIFY_TOKEN || !COOLIFY_APP_UUID) return;
  setTimeout(async () => {
    try {
      const res = await fetch(`${COOLIFY_HOST}/api/v1/applications/${COOLIFY_APP_UUID}/restart`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${COOLIFY_TOKEN}` },
      });
      console.log(`[coolify] auto-restart queued, HTTP ${res.status}`);
    } catch (e) {
      console.error('[coolify] auto-restart failed', e.message);
    }
  }, 2000);
}

// ── Captura de lead (chamado pelo form da LP, mesma origem) ─────────────────
// Abrir no navegador (GET) só explica: este endpoint recebe POST do formulário.
app.get('/api/lead', (req, res) => {
  res.type('text/plain').send(
    'Este endereço recebe os envios do formulário da landing page (método POST).\n' +
    'Ele não é uma página para abrir no navegador.\n\n' +
    'Para ver os leads cadastrados, entre no painel.'
  );
});

app.post('/api/lead', ah(async (req, res) => {
  try {
    const host = (req.hostname || '').toLowerCase();
    const apex = host.startsWith('www.') ? host.slice(4) : host;
    const lp = isAdminHost(req)
      ? (req.body.slug ? stmts.get.get(slugify(req.body.slug)) : null)
      : stmts.getByDomain.get(apex);
    if (!lp) return res.status(404).json({ ok: false, error: 'lp-not-found' });

    if (req.body.company) return res.json({ ok: true }); // honeypot: bot preencheu campo oculto
    const ip = clientIp(req);
    if (!leadRateOk(ip)) return res.status(429).json({ ok: false, error: 'rate-limit' });

    const name = String(req.body.name || '').trim().slice(0, 120);
    const phone = String(req.body.phone || '').trim().slice(0, 40);
    const message = String(req.body.message || '').trim().slice(0, 1000);
    if (!name && !phone) return res.status(400).json({ ok: false, error: 'empty' });

    const now = Date.now();
    const pageUrl = String(req.body.page_url || req.headers.referer || '').slice(0, 2000);
    const lead = {
      slug: lp.slug, name, phone, message,
      source: String(req.body.source || 'site').slice(0, 60),
      page_url: pageUrl,
      user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
      ip, webhook_status: null, created_at: now,
      ...Object.fromEntries(LEAD_FIELDS.map((k) => [k, null])),
    };
    try {
      Object.assign(lead, tracking.attributeLead(lp, visitorOf(req), pageUrl, now));
      if (!lead.device) lead.device = deviceOf(lead.user_agent, 0);
    } catch (e) { console.error('[lead:origem]', e.message); }
    const info = leadStmts.insert.run(lead);
    res.json({ ok: true, id: info.lastInsertRowid });

    const page = lead.page_id ? pages.get(lead.page_id) : null;
    if (webhookFor(lp, page)) {
      fireWebhook(lp, lead, page).then((status) => {
        try { leadStmts.setStatus.run(status, info.lastInsertRowid); } catch (_) {}
      });
    }
  } catch (e) {
    console.error('[lead]', e.message);
    if (!res.headersSent) res.status(500).json({ ok: false, error: 'server' });
  }
}));

// Resolve URL limpa (sem extensão): /obrigado -> obrigado.html ; /x/ -> x/index.html
function resolveFile(fp) {
  try {
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) return fp;
    for (const c of [fp + '.html', path.join(fp, 'index.html')]) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
  } catch {}
  return null;
}

// ── Medição: script e coletor (nos domínios das páginas) ────────────────────
app.get('/_lpm/t.js', (req, res) => {
  res.type('application/javascript; charset=utf-8');
  res.set('Cache-Control', req.query.v === TRACKER_V ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(TRACKER_SRC);
});

app.post('/_lpm/e', express.text({ type: () => true, limit: '16kb' }), (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (isAdminHost(req)) return res.status(204).end();
    const ua = String(req.headers['user-agent'] || '');
    if (isBot(ua) || !eventRateOk(clientIp(req))) return res.status(204).end();
    const host = (req.hostname || '').toLowerCase();
    const lp = stmts.getByDomain.get(host.startsWith('www.') ? host.slice(4) : host);
    if (!lp) return res.status(204).end();
    let ev;
    try { ev = JSON.parse(typeof req.body === 'string' ? req.body : ''); } catch (_) { return res.status(204).end(); }
    tracking.record(lp, ensureVisitor(req, res), ev, ua, Date.now());
  } catch (e) {
    console.error('[medicao]', e.message);
  }
  res.status(204).end();
});

app.use((req, res, next) => {
  const host = (req.hostname || '').toLowerCase();

  if (isAdminHost(req)) return next();

  const apex = host.startsWith('www.') ? host.slice(4) : host;
  const lp = stmts.getByDomain.get(apex);
  if (!lp) {
    return res.status(404).type('text/plain').send(`Nenhuma LP configurada para ${host}`);
  }

  const cleanPath = req.path === '/' ? `/${lp.index_file}` : req.path;
  const dir = siteDir(lp.slug);
  const filePath = path.join(dir, cleanPath);
  if (!filePath.startsWith(dir + path.sep) && filePath !== path.join(dir, lp.index_file)) {
    return res.status(403).send('forbidden');
  }
  const target = resolveFile(filePath);
  if (!target) {
    return res.status(404).type('text/plain').send('Not found');
  }
  return serveStatic(req, res, lp, target, { track: true });
});

app.get('/healthz', (req, res) => res.json({ ok: true, lps: stmts.list.all().length }));

// ── Daqui para baixo: só o host do painel ────────────────────────────────────
app.use((req, res, next) => {
  const local = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
  if (!req.secure && !local) return res.redirect(301, `https://${ADMIN_HOSTS[0]}${req.originalUrl}`);
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  if (!req.path.startsWith('/p/')) {
    res.set('X-Frame-Options', 'DENY');
    res.set('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
      + "script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'");
  }
  next();
});
app.use('/admin/static', express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders: (res, _p) => res.set('Cache-Control', 'public, max-age=31536000, immutable'),
}));
app.use(adminSession);
app.use(loadUser);
app.use(sameOriginOnly(deployTokenOk));

app.get('/', (req, res) => res.redirect('/admin'));

app.get('/admin/login', (req, res) => {
  if (req.user) return res.redirect('/admin');
  render(req, res, 'login', { title: 'Entrar', error: null, email: '', next: safeNext(req.query.next), noUsers: userQ.count.get().n === 0 });
});

app.post('/admin/login', ah(async (req, res) => {
  const email = normEmail(req.body.email);
  const next = safeNext(req.body.next);
  const ip = clientIp(req);
  const fail = (status, error) => {
    res.status(status);
    render(req, res, 'login', { title: 'Entrar', error, email, next, noUsers: userQ.count.get().n === 0 });
  };
  try {
    const tentativa = loginAttempt(ip, email || '-');
    if (!tentativa.ok) {
      if (tentativa.firstBlock) audit(req, 'login_bloqueado', email, null);
      return fail(429, 'Muitas tentativas seguidas. Espere 15 minutos e tente de novo.');
    }
    if (tentativa.delayMs) await sleep(tentativa.delayMs);
    const user = email ? userQ.byEmail.get(email) : null;
    const ok = await verifyPassword(String(req.body.password || ''), user ? user.password_hash : null);
    if (!ok || !user || !user.active) {
      audit(req, 'login_recusado', email + (user && !user.active ? ' (usuário desativado)' : ''), null);
      return fail(200, 'E-mail ou senha incorretos.');
    }
    loginSucceeded(ip, email, tentativa.stamp);
    req.session.regenerate((err) => {
      if (err) return fail(500, 'Não deu para abrir a sessão. Tente de novo.');
      req.session.uid = user.id;
      req.session.pwdAt = user.password_changed_at;
      userQ.touchLogin.run(Date.now(), user.id);
      audit(req, 'login', null, user);
      req.session.save(() => res.redirect(user.must_change_password ? '/admin/conta/senha' : next));
    });
  } catch (e) {
    console.error('[login]', e.message);
    fail(500, 'Erro ao entrar. Tente de novo.');
  }
}));

app.post('/admin/logout', (req, res) => {
  if (req.user) audit(req, 'logout');
  req.session.destroy(() => {
    res.clearCookie('lpm.sid');
    res.redirect('/admin/login');
  });
});

// ── Site e arquivos (super admin) ────────────────────────────────────────────
app.get('/admin/site', requireSuper, (req, res) => {
  const lps = listLPs().map((lp) => ({ ...lp, pages: pages.list(lp.slug), status: stats.status(lp.slug) }));
  render(req, res, 'site', { title: 'Site e arquivos', lps, ...takeFlash(req) });
});

app.post('/admin/lps', requireSuper, upload.single('zip'), ah(async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    let slug = slugify(req.body.slug || name);
    if (!slug) return res.status(400).send('Slug inválido');
    if (stmts.get.get(slug)) return res.status(409).send(`Slug "${slug}" já existe`);

    let indexFile = 'index.html';
    let opt = { count: 0, before: 0, after: 0 };
    let unb = null;
    let warn = null;
    if (req.file) {
      extractZip(req.file.buffer, siteDir(slug));
      const r = resolveIndex(siteDir(slug));
      indexFile = r.index;
      if (r.ambiguous) {
        warn = `ZIP com ${r.candidates.length} páginas e sem index.html. Servindo "${r.index}" por padrão — escolha a correta em "Arquivo index" abaixo.`;
      } else {
        unb = await unbundleHtml(siteDir(slug), path.join(siteDir(slug), r.index));
        if (unb) indexFile = unb.index;
      }
      opt = await optimizeImages(siteDir(slug));
    } else {
      fs.mkdirSync(siteDir(slug), { recursive: true });
      fs.writeFileSync(path.join(siteDir(slug), 'index.html'),
        `<!doctype html><html><body><h1>${name || slug}</h1><p>LP criada vazia. Faça upload de um ZIP.</p></body></html>`);
    }

    const now = Date.now();
    stmts.insert.run(slug, name || slug, null, indexFile, now, now);
    pages.sync(slug, siteDir(slug), indexFile);
    audit(req, 'site_criado', slug);
    req.session.flashWarn = warn;
    req.session.flash = `Site "${slug}" criado`
      + (unb ? ` · standalone desempacotado (${unb.assets} assets)` : '')
      + (opt.count ? ` · ${opt.count} imagens otimizadas (${fmtKB(opt.before)} → ${fmtKB(opt.after)})` : '');
    res.redirect('/admin/site');
  } catch (e) {
    console.error(e);
    res.status(500).send(`Erro: ${e.message}`);
  }
}));

app.post('/admin/lps/:slug/upload', requireSuperOrToken, upload.single('zip'), ah(async (req, res) => {
  try {
    const lp = stmts.get.get(req.params.slug);
    if (!lp) return res.status(404).send('LP não existe');
    if (!req.file) return res.status(400).send('ZIP ausente');

    extractZip(req.file.buffer, siteDir(lp.slug));
    const r = resolveIndex(siteDir(lp.slug));
    let indexFile = r.index;
    let unb = null;
    let warn = null;
    if (r.ambiguous) {
      warn = `ZIP com ${r.candidates.length} páginas e sem index.html. Servindo "${r.index}" por padrão — escolha a correta em "Arquivo index" abaixo.`;
    } else {
      unb = await unbundleHtml(siteDir(lp.slug), path.join(siteDir(lp.slug), r.index));
      if (unb) indexFile = unb.index;
    }
    const opt = await optimizeImages(siteDir(lp.slug));
    const updatedAt = Date.now();
    stmts.updateIndex.run(indexFile, updatedAt, lp.slug);
    const sitePages = pages.sync(lp.slug, siteDir(lp.slug), indexFile);
    const msg = `ZIP importado para "${lp.slug}" (index: ${indexFile})`
      + (unb ? ` · standalone desempacotado (${unb.assets} assets)` : '')
      + (opt.count ? ` · ${opt.count} imagens otimizadas (${fmtKB(opt.before)} → ${fmtKB(opt.after)})` : '');
    audit(req, 'site_publicado', `${lp.slug} · ${req.file.size} bytes`);
    if (req.viaToken) {
      return res.json({ ok: true, slug: lp.slug, index_file: indexFile, updated_at: updatedAt, warning: warn, message: msg,
        pages: sitePages.filter((pg) => pg.present).map((pg) => ({ path: pg.path, name: pg.name, kind: pg.kind })) });
    }
    req.session.flashWarn = warn;
    req.session.flash = msg;
    res.redirect('/admin/site');
  } catch (e) {
    console.error(e);
    res.status(500).send(`Erro: ${e.message}`);
  }
}));

app.get('/admin/lps/:slug/files', requireSuperOrToken, (req, res) => {
  const lp = stmts.get.get(req.params.slug);
  if (!lp) return res.status(404).json({ error: 'LP não existe' });
  const dir = siteDir(lp.slug);
  const out = [];
  const walk = (p, rel = '') => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const sub = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(p, e.name), sub);
      else out.push({ path: sub, size: fs.statSync(path.join(p, e.name)).size });
    }
  };
  try { walk(dir); } catch (e) { return res.status(500).json({ error: e.message }); }
  out.sort((a, b) => b.size - a.size);
  res.json({
    slug: lp.slug, index_file: lp.index_file, updated_at: lp.updated_at,
    count: out.length, total: out.reduce((s, f) => s + f.size, 0), files: out,
  });
});

app.post('/admin/lps/:slug/duplicate', requireSuper, (req, res) => {
  try {
    const src = stmts.get.get(req.params.slug);
    if (!src) return res.status(404).send('LP origem não existe');
    let newSlug = slugify(req.body.new_slug || `${src.slug}-copy`);
    if (!newSlug) return res.status(400).send('Slug inválido');
    if (stmts.get.get(newSlug)) return res.status(409).send(`Slug "${newSlug}" já existe`);

    const srcDir = siteDir(src.slug);
    const dstDir = siteDir(newSlug);
    if (fs.existsSync(srcDir)) copyDir(srcDir, dstDir);
    else fs.mkdirSync(dstDir, { recursive: true });

    const now = Date.now();
    stmts.insert.run(newSlug, `${src.name} (cópia)`, null, src.index_file, now, now);
    pages.sync(newSlug, dstDir, src.index_file);
    audit(req, 'site_duplicado', `${src.slug} → ${newSlug}`);
    req.session.flash = `Site "${src.slug}" duplicado como "${newSlug}"`;
    res.redirect('/admin/site');
  } catch (e) {
    console.error(e);
    res.status(500).send(`Erro: ${e.message}`);
  }
});

app.post('/admin/lps/:slug/domain', requireSuper, ah(async (req, res) => {
  try {
    const lp = stmts.get.get(req.params.slug);
    if (!lp) return res.status(404).send('LP não existe');
    const newDomain = (req.body.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '') || null;

    if (newDomain && ADMIN_HOSTS.includes(newDomain)) {
      return res.status(400).send('Esse domínio é reservado pro admin');
    }
    if (newDomain) {
      const taken = stmts.getByDomain.get(newDomain);
      if (taken && taken.slug !== lp.slug) {
        return res.status(409).send(`Domínio em uso pela LP "${taken.slug}"`);
      }
    }

    const domainChanged = (lp.custom_domain || null) !== newDomain;
    if (lp.custom_domain && lp.custom_domain !== newDomain) {
      await coolifyRemoveDomain(lp.custom_domain);
    }
    stmts.updateDomain.run(newDomain, Date.now(), lp.slug);
    let coolifyResult = null;
    if (newDomain) coolifyResult = await coolifyAddDomain(newDomain);

    if (domainChanged) scheduleCoolifyRestart();
    if (domainChanged) audit(req, 'dominio_alterado', `${lp.slug}: ${lp.custom_domain || '(nenhum)'} → ${newDomain || '(nenhum)'}`);

    req.session.flash = newDomain
      ? `Domínio "${newDomain}" associado a "${lp.slug}". Aponte DNS A → 187.127.6.135. App reiniciando pra aplicar Traefik labels (~30s — aguarde antes de testar).${coolifyResult?.ok === false ? ` (Coolify sync: ${coolifyResult.reason})` : ''}`
      : `Domínio removido de "${lp.slug}". App reiniciando (~30s).`;
    res.redirect('/admin/site');
  } catch (e) {
    console.error(e);
    res.status(500).send(`Erro: ${e.message}`);
  }
}));

app.post('/admin/lps/:slug/index-file', requireSuper, ah(async (req, res) => {
  try {
    const lp = stmts.get.get(req.params.slug);
    if (!lp) return res.status(404).send('LP não existe');
    const file = (req.body.index_file || '').trim();
    if (!file) return res.status(400).send('arquivo vazio');
    const fp = path.join(siteDir(lp.slug), file);
    if (!fp.startsWith(siteDir(lp.slug) + path.sep) || !fs.existsSync(fp)) {
      return res.status(404).send(`${file} não existe na LP`);
    }
    // Se a página escolhida for um standalone, desempacota na hora.
    let idx = file;
    let extra = '';
    const unb = await unbundleHtml(siteDir(lp.slug), fp);
    if (unb) {
      idx = unb.index;
      const opt = await optimizeImages(siteDir(lp.slug));
      extra = ` · standalone desempacotado (${unb.assets} assets`
        + (opt.count ? `, ${opt.count} imgs ${fmtKB(opt.before)}→${fmtKB(opt.after)}` : '') + ')';
    }
    stmts.updateIndex.run(idx, Date.now(), lp.slug);
    pages.sync(lp.slug, siteDir(lp.slug), idx);
    audit(req, 'index_alterado', `${lp.slug} → ${idx}`);
    req.session.flash = `Index de "${lp.slug}" → ${idx}${extra}`;
    res.redirect('/admin/site');
  } catch (e) {
    console.error(e);
    res.status(500).send(`Erro: ${e.message}`);
  }
}));

app.post('/admin/lps/:slug/delete', requireSuper, ah(async (req, res) => {
  const lp = stmts.get.get(req.params.slug);
  if (!lp) return res.status(404).send('LP não existe');
  if (lp.custom_domain) await coolifyRemoveDomain(lp.custom_domain);
  rmrf(siteDir(lp.slug));
  stmts.delete.run(lp.slug);
  pages.removeSite(lp.slug);
  audit(req, 'site_excluido', lp.slug);
  req.session.flash = `Site "${lp.slug}" excluído`;
  res.redirect('/admin/site');
}));

// ── Webhook do site (vale para as páginas que não têm um próprio) ───────────
app.get('/admin/lps/:slug/leads', requireAuth, (req, res) => res.redirect('/admin/leads'));
app.get('/admin/lps/:slug/leads.csv', requireAuth, (req, res) => res.redirect('/admin/leads.csv?p=tudo'));

app.post('/admin/lps/:slug/webhook', requireSuper, ah(async (req, res) => {
  const lp = stmts.get.get(req.params.slug);
  if (!lp) return res.status(404).send('LP não existe');
  const url = (req.body.webhook_url || '').trim();
  const problem = url ? await webhookProblem(url) : null;
  if (problem) {
    req.session.flashWarn = `Webhook não salvo: ${problem}.`;
    return res.redirect('/admin/site');
  }
  setWebhookUrl.run(url || null, lp.slug);
  audit(req, 'webhook_alterado', `${lp.slug} (site): ${url || '(removido)'}`);
  req.session.flash = url ? 'Webhook do site salvo.' : 'Webhook do site removido.';
  res.redirect('/admin/site');
}));

app.post('/admin/lps/:slug/webhook/test', requireSuper, ah(async (req, res) => {
  const lp = stmts.get.get(req.params.slug);
  if (!lp) return res.status(404).send('LP não existe');
  const url = (req.body.webhook_url || '').trim() || lp.webhook_url;
  if (!url) {
    req.session.flashWarn = 'Digite ou salve um webhook antes de testar.';
    return res.redirect('/admin/site');
  }
  const status = await fireWebhook(lp, testLead(), null, url);
  audit(req, 'webhook_testado', `${lp.slug} (site) → ${status}`);
  req.session[status.startsWith('ok') ? 'flash' : 'flashWarn'] = `Teste para ${url}: ${status.startsWith('ok') ? 'recebido' : 'falhou'} (${status}).`
    + (url !== lp.webhook_url ? ' O endereço ainda não foi salvo.' : '');
  res.redirect('/admin/site');
}));

// Lead de mentira para os botões "Testar webhook".
function testLead(page) {
  return {
    name: 'Lead de teste', phone: '(61) 90000-0000', message: 'Disparo de teste do painel', source: 'teste-webhook',
    page_url: '', page_path: page ? page.path : '', created_at: Date.now(),
    utm_source: 'teste', utm_medium: 'painel', utm_campaign: 'teste-webhook', channel: 'outros',
  };
}

// Prévia do site no painel. O HTML só abre para quem está logado e roda isolado
// (CSP sandbox sem allow-same-origin): vira uma origem opaca, que não lê nem usa a
// sessão do painel, mesmo que o site publicado tenha script malicioso. Por isso os
// demais arquivos (imagens, CSS, fontes) saem sem login, como já saem no domínio
// público, e com CORS aberto para as fontes carregarem na origem opaca.
app.use('/p/:slug', (req, res, next) => {
  const lp = stmts.get.get(req.params.slug);
  if (!lp) return res.status(404).send('not found');
  const rel = req.path === '/' ? `/${lp.index_file}` : req.path;
  const dir = siteDir(lp.slug);
  const fp = path.join(dir, rel);
  if (!fp.startsWith(dir + path.sep) && fp !== path.join(dir, lp.index_file)) {
    return res.status(403).send('forbidden');
  }
  const target = resolveFile(fp);
  if (!target) return res.status(404).send('not found');
  const ext = path.extname(target).toLowerCase();
  if (ext === '.html' || ext === '.htm' || ext === '') {
    return requireAuth(req, res, () => {
      res.set('Content-Security-Policy', "sandbox allow-scripts allow-forms allow-popups allow-modals; frame-ancestors 'none'");
      res.set('X-Frame-Options', 'DENY');
      serveStatic(req, res, lp, target);
    });
  }
  res.set('Access-Control-Allow-Origin', '*');
  return serveStatic(req, res, lp, target);
});

registerAdmin(app, {
  db, pages, stats, stmts, render, takeFlash, audit, requireAuth, requireSuper, sessionStore,
  fireWebhook, webhookFor, testLead, userQ, ah,
});

app.use((err, req, res, next) => {
  console.error('[erro]', req.method, req.path, err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  const status = err && err.code === 'LIMIT_FILE_SIZE' ? 413 : 500;
  res.status(status);
  if (isAdminHost(req) && req.accepts('html')) {
    return render(req, res, 'error', { title: 'Algo deu errado', message: status === 413 ? 'O arquivo passa do limite de 200 MB.' : 'Não deu para concluir. Tente de novo; se repetir, avise o suporte.' });
  }
  res.type('text/plain').send('Erro');
});

process.on('unhandledRejection', (e) => console.error('[promessa sem tratamento]', e && e.stack ? e.stack : e));

// ── Boot ─────────────────────────────────────────────────────────────────────
// Cria (ou reativa) o dono do painel a partir do hash da variável de ambiente.
// Se o usuário já existe, a senha só é trocada com SUPERADMIN_PASSWORD_RESET=1.
function seedSuperAdmin() {
  if (SUPERADMIN_EMAIL && !isPasswordHash(SUPERADMIN_PASSWORD_HASH)) {
    console.warn('[auth] SUPERADMIN_PASSWORD_HASH ausente ou inválido: gere com node scripts/hash-password.js');
  }
  if (!SUPERADMIN_EMAIL || !isPasswordHash(SUPERADMIN_PASSWORD_HASH)) {
    if (!userQ.count.get().n) console.warn('[auth] nenhum usuário: defina SUPERADMIN_EMAIL e SUPERADMIN_PASSWORD_HASH');
    return;
  }
  const now = Date.now();
  const cur = userQ.byEmail.get(SUPERADMIN_EMAIL);
  const name = SUPERADMIN_NAME || SUPERADMIN_EMAIL.split('@')[0].replace(/^./, (c) => c.toUpperCase());
  if (!cur) {
    db.prepare(`INSERT INTO users (email, name, password_hash, role, active, must_change_password, password_changed_at, created_at, updated_at)
      VALUES (?, ?, ?, 'super', 1, 0, ?, ?, ?)`).run(SUPERADMIN_EMAIL, name, SUPERADMIN_PASSWORD_HASH, now, now, now);
    console.log(`[auth] super admin criado: ${SUPERADMIN_EMAIL}`);
    return;
  }
  if (cur.role !== 'super' || !cur.active) {
    db.prepare("UPDATE users SET role = 'super', active = 1, updated_at = ? WHERE id = ?").run(now, cur.id);
  }
  // a redefinição vale uma vez para cada hash: esquecida ligada, não desfaz a troca de senha seguinte
  if (process.env.SUPERADMIN_PASSWORD_RESET === '1') {
    const applied = db.prepare("SELECT value FROM meta WHERE key = 'superadmin_reset_hash'").get();
    if ((!applied || applied.value !== SUPERADMIN_PASSWORD_HASH) && cur.password_hash !== SUPERADMIN_PASSWORD_HASH) {
      db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
        .run(SUPERADMIN_PASSWORD_HASH, now, now, cur.id);
      sessionStore.endUser(cur.id);
      auditInsert.run(null, 'sistema', 'senha_redefinida', `${SUPERADMIN_EMAIL} pela variável SUPERADMIN_PASSWORD_RESET`, null, now);
      console.log('[auth] senha do super admin redefinida pela variável de ambiente (desligue SUPERADMIN_PASSWORD_RESET)');
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('superadmin_reset_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(SUPERADMIN_PASSWORD_HASH);
  }
}

// Páginas de todos os sites + origem dos leads gravados antes da medição.
function bootData() {
  for (const lp of stmts.list.all()) pages.sync(lp.slug, siteDir(lp.slug), lp.index_file);
  once(db, 'backfill_leads_v1', () => {
    const upd = db.prepare(`UPDATE leads SET page_id = @page_id, page_path = @page_path, landing_page = @page_path,
      utm_source = @utm_source, utm_medium = @utm_medium, utm_campaign = @utm_campaign, utm_term = @utm_term,
      utm_content = @utm_content, click_type = @click_type, click_id = @click_id, channel = @channel, device = @device
      WHERE id = @id`);
    for (const l of db.prepare('SELECT id, slug, page_url, source, user_agent FROM leads WHERE channel IS NULL').all()) {
      const p = pathOfUrl(l.page_url) || (/^fullface/.test(l.source || '') ? '/fullface' : '/');
      const page = pages.find(l.slug, p);
      upd.run({ id: l.id, page_id: page ? page.id : null, page_path: p, device: deviceOf(l.user_agent, 0), ...leadAttributionFromUrl(l.page_url) });
    }
  });
}

// Guarda a medição por 25 meses; leads ficam para sempre.
function pruneTracking() {
  const cut = Date.now() - 760 * 24 * 3600 * 1000;
  try {
    db.prepare('DELETE FROM clicks WHERE ts < ?').run(cut);
    db.prepare('DELETE FROM pageviews WHERE ts < ?').run(cut);
    db.prepare('DELETE FROM visits WHERE last_seen < ?').run(cut);
    db.prepare('DELETE FROM audit WHERE created_at < ?').run(cut);
  } catch (e) { console.error('[limpeza]', e.message); }
}

seedSuperAdmin();
bootData();
pruneTracking();
setInterval(pruneTracking, 24 * 3600 * 1000).unref();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`lp-manager listening on :${PORT}`);
  console.log(`  ADMIN_HOST=${ADMIN_HOST}`);
  console.log(`  DATA_DIR=${DATA_DIR}`);
  console.log(`  COOLIFY sync=${COOLIFY_HOST && COOLIFY_TOKEN && COOLIFY_APP_UUID ? 'enabled' : 'disabled'}`);
  console.log(`  usuários=${userQ.count.get().n} · publicação por token=${DEPLOY_TOKEN ? 'ligada' : 'desligada'} · medição=${TRACKER_V}`);
});
