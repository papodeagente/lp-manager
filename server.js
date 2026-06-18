import express from 'express';
import session from 'express-session';
import compression from 'compression';
import multer from 'multer';
import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SITES_DIR = path.join(DATA_DIR, 'sites');
const DB_PATH = path.join(DATA_DIR, 'lps.db');

const ADMIN_HOST = process.env.ADMIN_HOST || 'admin.lps.entur.com.br';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const COOLIFY_HOST = process.env.COOLIFY_HOST || '';
const COOLIFY_TOKEN = process.env.COOLIFY_TOKEN || '';
const COOLIFY_APP_UUID = process.env.COOLIFY_APP_UUID || '';

fs.mkdirSync(SITES_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS lps (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    custom_domain TEXT UNIQUE,
    index_file TEXT NOT NULL DEFAULT 'index.html',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

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

// ── Leads + webhook por LP ───────────────────────────────────────────────────
// Migração idempotente: adiciona a coluna de webhook se ainda não existir.
try { db.exec('ALTER TABLE lps ADD COLUMN webhook_url TEXT'); } catch (_) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL,
    name TEXT,
    phone TEXT,
    message TEXT,
    source TEXT,
    page_url TEXT,
    user_agent TEXT,
    ip TEXT,
    webhook_status TEXT,
    created_at INTEGER NOT NULL
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_leads_slug ON leads(slug, created_at)');

const leadStmts = {
  insert: db.prepare(`INSERT INTO leads (slug, name, phone, message, source, page_url, user_agent, ip, webhook_status, created_at)
    VALUES (@slug, @name, @phone, @message, @source, @page_url, @user_agent, @ip, @webhook_status, @created_at)`),
  listBySlug: db.prepare('SELECT * FROM leads WHERE slug = ? ORDER BY created_at DESC LIMIT 2000'),
  countBySlug: db.prepare('SELECT COUNT(*) AS n FROM leads WHERE slug = ?'),
  setStatus: db.prepare('UPDATE leads SET webhook_status = ? WHERE id = ?'),
  delete: db.prepare('DELETE FROM leads WHERE id = ? AND slug = ?'),
};
const setWebhookUrl = db.prepare('UPDATE lps SET webhook_url = ? WHERE slug = ?');

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

function webhookPayload(lp, lead) {
  const ph = normalizePhone(lead.phone);
  return {
    event: 'lead.created',
    lp: lp.slug,
    lp_name: lp.name,
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
    // objeto aninhado pra automações que esperam contact.*
    contact: { name: lead.name, phone: ph.full, phone_e164: ph.e164, email: '' },
  };
}

async function fireWebhook(lp, lead) {
  if (!lp.webhook_url) return 'sem-webhook';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(lp.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'lp-manager-webhook/1' },
      body: JSON.stringify(webhookPayload(lp, lead)),
      signal: ctrl.signal,
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
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

function isAdminHost(req) {
  const host = (req.hostname || '').toLowerCase();
  return host === ADMIN_HOST.toLowerCase() || host === 'localhost' || host.endsWith('.sslip.io');
}

function requireAuth(req, res, next) {
  if (req.session?.admin) return next();
  if (req.method === 'GET') return res.redirect('/admin/login');
  return res.status(401).json({ error: 'unauthorized' });
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

function serveStatic(req, res, lp, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const v = lp.updated_at;
  if (ext === '.html' || ext === '.htm' || ext === '') {
    res.set('Cache-Control', 'no-cache');
    return res.type('html').send(bustRefs(fs.readFileSync(filePath, 'utf8'), v));
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
    'Para VER os leads cadastrados, acesse o painel admin:\n' +
    'http://op9b10kp8njuotvz5x9d4y6a.187.127.6.135.sslip.io/admin'
  );
});

app.post('/api/lead', async (req, res) => {
  try {
    const host = (req.hostname || '').toLowerCase();
    const apex = host.startsWith('www.') ? host.slice(4) : host;
    const lp = isAdminHost(req)
      ? (req.body.slug ? stmts.get.get(slugify(req.body.slug)) : null)
      : stmts.getByDomain.get(apex);
    if (!lp) return res.status(404).json({ ok: false, error: 'lp-not-found' });

    if (req.body.company) return res.json({ ok: true }); // honeypot: bot preencheu campo oculto
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    if (!leadRateOk(ip)) return res.status(429).json({ ok: false, error: 'rate-limit' });

    const name = String(req.body.name || '').trim().slice(0, 120);
    const phone = String(req.body.phone || '').trim().slice(0, 40);
    const message = String(req.body.message || '').trim().slice(0, 1000);
    if (!name && !phone) return res.status(400).json({ ok: false, error: 'empty' });

    const lead = {
      slug: lp.slug, name, phone, message,
      source: String(req.body.source || 'site').slice(0, 60),
      page_url: String(req.body.page_url || req.headers.referer || '').slice(0, 300),
      user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
      ip, webhook_status: null, created_at: Date.now(),
    };
    const info = leadStmts.insert.run(lead);
    res.json({ ok: true, id: info.lastInsertRowid });

    if (lp.webhook_url) {
      fireWebhook(lp, lead).then((status) => {
        try { leadStmts.setStatus.run(status, info.lastInsertRowid); } catch (_) {}
      });
    }
  } catch (e) {
    console.error('[lead]', e.message);
    res.status(500).json({ ok: false, error: 'server' });
  }
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
  const filePath = path.join(siteDir(lp.slug), cleanPath);
  const dir = siteDir(lp.slug);
  if (!filePath.startsWith(dir + path.sep) && filePath !== path.join(dir, lp.index_file)) {
    return res.status(403).send('forbidden');
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return res.status(404).type('text/plain').send('Not found');
  }
  return serveStatic(req, res, lp, filePath);
});

app.get('/', (req, res) => res.redirect('/admin'));

app.get('/admin/login', (req, res) => {
  if (req.session?.admin) return res.redirect('/admin');
  res.render('login', { error: null });
});

app.post('/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.render('login', { error: 'ADMIN_PASSWORD não configurado no servidor' });
  }
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.admin = true;
    return res.redirect('/admin');
  }
  res.status(401).render('login', { error: 'Senha incorreta' });
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

app.get('/admin', requireAuth, (req, res) => {
  res.render('dashboard', {
    lps: listLPs(),
    flash: req.session.flash || null,
    flashWarn: req.session.flashWarn || null,
  });
  req.session.flash = null;
  req.session.flashWarn = null;
});

app.post('/admin/lps', requireAuth, upload.single('zip'), async (req, res) => {
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
    req.session.flashWarn = warn;
    req.session.flash = `LP "${slug}" criada`
      + (unb ? ` · standalone desempacotado (${unb.assets} assets)` : '')
      + (opt.count ? ` · ${opt.count} imagens otimizadas (${fmtKB(opt.before)} → ${fmtKB(opt.after)})` : '');
    res.redirect('/admin');
  } catch (e) {
    console.error(e);
    res.status(500).send(`Erro: ${e.message}`);
  }
});

app.post('/admin/lps/:slug/upload', requireAuth, upload.single('zip'), async (req, res) => {
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
    stmts.updateIndex.run(indexFile, Date.now(), lp.slug);
    req.session.flashWarn = warn;
    req.session.flash = `ZIP importado para "${lp.slug}" (index: ${indexFile})`
      + (unb ? ` · standalone desempacotado (${unb.assets} assets)` : '')
      + (opt.count ? ` · ${opt.count} imagens otimizadas (${fmtKB(opt.before)} → ${fmtKB(opt.after)})` : '');
    res.redirect('/admin');
  } catch (e) {
    console.error(e);
    res.status(500).send(`Erro: ${e.message}`);
  }
});

app.get('/admin/lps/:slug/files', requireAuth, (req, res) => {
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

app.post('/admin/lps/:slug/duplicate', requireAuth, (req, res) => {
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
    req.session.flash = `LP "${src.slug}" duplicada como "${newSlug}"`;
    res.redirect('/admin');
  } catch (e) {
    console.error(e);
    res.status(500).send(`Erro: ${e.message}`);
  }
});

app.post('/admin/lps/:slug/domain', requireAuth, async (req, res) => {
  try {
    const lp = stmts.get.get(req.params.slug);
    if (!lp) return res.status(404).send('LP não existe');
    const newDomain = (req.body.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '') || null;

    if (newDomain && newDomain === ADMIN_HOST.toLowerCase()) {
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

    req.session.flash = newDomain
      ? `Domínio "${newDomain}" associado a "${lp.slug}". Aponte DNS A → 187.127.6.135. App reiniciando pra aplicar Traefik labels (~30s — aguarde antes de testar).${coolifyResult?.ok === false ? ` (Coolify sync: ${coolifyResult.reason})` : ''}`
      : `Domínio removido de "${lp.slug}". App reiniciando (~30s).`;
    res.redirect('/admin');
  } catch (e) {
    console.error(e);
    res.status(500).send(`Erro: ${e.message}`);
  }
});

app.post('/admin/lps/:slug/index-file', requireAuth, async (req, res) => {
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
    req.session.flash = `Index de "${lp.slug}" → ${idx}${extra}`;
    res.redirect('/admin');
  } catch (e) {
    console.error(e);
    res.status(500).send(`Erro: ${e.message}`);
  }
});

app.post('/admin/lps/:slug/delete', requireAuth, async (req, res) => {
  const lp = stmts.get.get(req.params.slug);
  if (!lp) return res.status(404).send('LP não existe');
  if (lp.custom_domain) await coolifyRemoveDomain(lp.custom_domain);
  rmrf(siteDir(lp.slug));
  stmts.delete.run(lp.slug);
  req.session.flash = `LP "${lp.slug}" deletada`;
  res.redirect('/admin');
});

// ── Admin: leads + webhook ───────────────────────────────────────────────────
app.get('/admin/lps/:slug/leads', requireAuth, (req, res) => {
  const lp = stmts.get.get(req.params.slug);
  if (!lp) return res.status(404).send('LP não existe');
  const leads = leadStmts.listBySlug.all(lp.slug);
  res.render('leads', { lp, leads, flash: req.session.flash || null });
  req.session.flash = null;
});

app.post('/admin/lps/:slug/webhook', requireAuth, (req, res) => {
  const lp = stmts.get.get(req.params.slug);
  if (!lp) return res.status(404).send('LP não existe');
  const url = (req.body.webhook_url || '').trim();
  if (url && !/^https?:\/\//i.test(url)) {
    req.session.flash = 'URL inválida — use http:// ou https://';
    return res.redirect(`/admin/lps/${lp.slug}/leads`);
  }
  setWebhookUrl.run(url || null, lp.slug);
  req.session.flash = url ? 'Webhook salvo.' : 'Webhook removido.';
  res.redirect(`/admin/lps/${lp.slug}/leads`);
});

app.post('/admin/lps/:slug/webhook/test', requireAuth, async (req, res) => {
  const lp = stmts.get.get(req.params.slug);
  if (!lp) return res.status(404).send('LP não existe');
  if (!lp.webhook_url) {
    req.session.flash = 'Configure e salve o webhook antes de testar.';
    return res.redirect(`/admin/lps/${lp.slug}/leads`);
  }
  const status = await fireWebhook(lp, {
    name: 'Lead de teste', phone: '(61) 90000-0000',
    message: 'Disparo de teste do lp-manager', source: 'teste-webhook',
    page_url: '', created_at: Date.now(),
  });
  req.session.flash = `Teste enviado ao webhook → ${status}`;
  res.redirect(`/admin/lps/${lp.slug}/leads`);
});

app.post('/admin/lps/:slug/leads/:id/delete', requireAuth, (req, res) => {
  const lp = stmts.get.get(req.params.slug);
  if (!lp) return res.status(404).send('LP não existe');
  leadStmts.delete.run(parseInt(req.params.id, 10) || 0, lp.slug);
  req.session.flash = 'Lead removido.';
  res.redirect(`/admin/lps/${lp.slug}/leads`);
});

app.get('/admin/lps/:slug/leads.csv', requireAuth, (req, res) => {
  const lp = stmts.get.get(req.params.slug);
  if (!lp) return res.status(404).send('LP não existe');
  const leads = leadStmts.listBySlug.all(lp.slug);
  const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const head = ['data', 'nome', 'telefone', 'mensagem', 'origem', 'pagina', 'webhook'];
  const lines = leads.map((l) => [
    new Date(l.created_at).toISOString(), l.name, l.phone, l.message, l.source, l.page_url, l.webhook_status,
  ].map(esc).join(','));
  const csv = '﻿' + head.map(esc).join(',') + '\n' + lines.join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="leads-${lp.slug}.csv"`);
  res.send(csv);
});

app.use('/p/:slug', requireAuth, (req, res, next) => {
  const lp = stmts.get.get(req.params.slug);
  if (!lp) return res.status(404).send('LP não existe');
  const rel = req.path === '/' ? `/${lp.index_file}` : req.path;
  const fp = path.join(siteDir(lp.slug), rel);
  const dir = siteDir(lp.slug);
  if (!fp.startsWith(dir + path.sep) && fp !== path.join(dir, lp.index_file)) {
    return res.status(403).send('forbidden');
  }
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) return res.status(404).send('not found');
  return serveStatic(req, res, lp, fp);
});

app.get('/healthz', (req, res) => res.json({ ok: true, lps: stmts.list.all().length }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`lp-manager listening on :${PORT}`);
  console.log(`  ADMIN_HOST=${ADMIN_HOST}`);
  console.log(`  DATA_DIR=${DATA_DIR}`);
  console.log(`  COOLIFY sync=${COOLIFY_HOST && COOLIFY_TOKEN && COOLIFY_APP_UUID ? 'enabled' : 'disabled'}`);
});
