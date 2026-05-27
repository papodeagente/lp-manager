import express from 'express';
import session from 'express-session';
import multer from 'multer';
import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
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

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

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
    return { ...lp, files, size, has_files: exists };
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
  return res.sendFile(filePath);
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
  res.render('dashboard', { lps: listLPs(), flash: req.session.flash || null });
  req.session.flash = null;
});

app.post('/admin/lps', requireAuth, upload.single('zip'), async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    let slug = slugify(req.body.slug || name);
    if (!slug) return res.status(400).send('Slug inválido');
    if (stmts.get.get(slug)) return res.status(409).send(`Slug "${slug}" já existe`);

    let indexFile = 'index.html';
    if (req.file) {
      indexFile = extractZip(req.file.buffer, siteDir(slug));
    } else {
      fs.mkdirSync(siteDir(slug), { recursive: true });
      fs.writeFileSync(path.join(siteDir(slug), 'index.html'),
        `<!doctype html><html><body><h1>${name || slug}</h1><p>LP criada vazia. Faça upload de um ZIP.</p></body></html>`);
    }

    const now = Date.now();
    stmts.insert.run(slug, name || slug, null, indexFile, now, now);
    req.session.flash = `LP "${slug}" criada`;
    res.redirect('/admin');
  } catch (e) {
    console.error(e);
    res.status(500).send(`Erro: ${e.message}`);
  }
});

app.post('/admin/lps/:slug/upload', requireAuth, upload.single('zip'), (req, res) => {
  try {
    const lp = stmts.get.get(req.params.slug);
    if (!lp) return res.status(404).send('LP não existe');
    if (!req.file) return res.status(400).send('ZIP ausente');

    const indexFile = extractZip(req.file.buffer, siteDir(lp.slug));
    stmts.updateIndex.run(indexFile, Date.now(), lp.slug);
    req.session.flash = `ZIP importado para "${lp.slug}" (index: ${indexFile})`;
    res.redirect('/admin');
  } catch (e) {
    console.error(e);
    res.status(500).send(`Erro: ${e.message}`);
  }
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

    if (lp.custom_domain && lp.custom_domain !== newDomain) {
      await coolifyRemoveDomain(lp.custom_domain);
    }
    stmts.updateDomain.run(newDomain, Date.now(), lp.slug);
    let coolifyResult = null;
    if (newDomain) coolifyResult = await coolifyAddDomain(newDomain);

    req.session.flash = newDomain
      ? `Domínio "${newDomain}" associado a "${lp.slug}". Aponte DNS A → 187.127.6.135.${coolifyResult?.ok === false ? ` (Coolify sync: ${coolifyResult.reason})` : ''}`
      : `Domínio removido de "${lp.slug}"`;
    res.redirect('/admin');
  } catch (e) {
    console.error(e);
    res.status(500).send(`Erro: ${e.message}`);
  }
});

app.post('/admin/lps/:slug/index-file', requireAuth, (req, res) => {
  const lp = stmts.get.get(req.params.slug);
  if (!lp) return res.status(404).send('LP não existe');
  const file = (req.body.index_file || '').trim();
  if (!file) return res.status(400).send('arquivo vazio');
  const fp = path.join(siteDir(lp.slug), file);
  if (!fs.existsSync(fp)) return res.status(404).send(`${file} não existe na LP`);
  stmts.updateIndex.run(file, Date.now(), lp.slug);
  req.session.flash = `Index de "${lp.slug}" → ${file}`;
  res.redirect('/admin');
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
  res.sendFile(fp);
});

app.get('/healthz', (req, res) => res.json({ ok: true, lps: stmts.list.all().length }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`lp-manager listening on :${PORT}`);
  console.log(`  ADMIN_HOST=${ADMIN_HOST}`);
  console.log(`  DATA_DIR=${DATA_DIR}`);
  console.log(`  COOLIFY sync=${COOLIFY_HOST && COOLIFY_TOKEN && COOLIFY_APP_UUID ? 'enabled' : 'disabled'}`);
});
