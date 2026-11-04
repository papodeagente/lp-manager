import fs from 'node:fs';
import path from 'node:path';

// ── Páginas de um site ──────────────────────────────────────────────────────
// Cada HTML do ZIP vira uma página com endereço próprio: o arquivo index vira "/",
// "fullface.html" vira "/fullface" e "x/index.html" vira "/x". O nome sai do
// <title> e pode ser trocado no painel; a página nunca é apagada sozinha, só marcada
// como ausente se sumir num upload (os números antigos continuam lá).

export function pathForFile(file, indexFile) {
  const f = String(file).replace(/\\/g, '/').replace(/^\/+/, '');
  if (f === indexFile) return '/';
  if (/(^|\/)index\.html?$/i.test(f)) return '/' + f.replace(/\/?index\.html?$/i, '');
  return '/' + f.replace(/\.html?$/i, '');
}

// Caminho de uma URL do jeito que o painel guarda: sem barra final, sem ".html",
// sem "index" e sem a query. Serve tanto para o que o navegador manda quanto para
// a page_url gravada nos leads antigos.
export function normalizePath(raw) {
  let p = String(raw || '/').split(/[?#]/)[0];
  try { p = decodeURIComponent(p); } catch (_) {}
  p = p.replace(/\/{2,}/g, '/').replace(/\.html?$/i, '').replace(/\/index$/i, '').replace(/\/+$/, '');
  if (!p.startsWith('/')) p = '/' + p;
  return p.slice(0, 300) || '/';
}

export function pathOfUrl(raw) {
  if (!raw) return null;
  try { return normalizePath(new URL(raw).pathname); } catch (_) { return null; }
}

function titleOf(file) {
  try {
    const html = fs.readFileSync(file, 'utf8').slice(0, 20000);
    const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
    if (!m) return '';
    const t = m[1].replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
    return t.split(/\s+[|·–—-]\s+/)[0].trim().slice(0, 80);
  } catch (_) { return ''; }
}

export function kindForPath(p) {
  return /obrigad|thank|sucesso|success|confirmad/i.test(p) ? 'thanks' : 'landing';
}

export const KINDS = { landing: 'Página de captação', thanks: 'Página de obrigado', other: 'Outra página' };

export function makePages(db) {
  const q = {
    bySlug: db.prepare('SELECT * FROM pages WHERE slug = ? ORDER BY (path = \'/\') DESC, path'),
    byId: db.prepare('SELECT * FROM pages WHERE id = ?'),
    byPath: db.prepare('SELECT * FROM pages WHERE slug = ? AND path = ?'),
    insert: db.prepare(`INSERT INTO pages (slug, path, file, name, kind, present, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)`),
    refresh: db.prepare('UPDATE pages SET file = ?, present = 1, updated_at = ? WHERE id = ?'),
    absent: db.prepare('UPDATE pages SET present = 0, updated_at = ? WHERE slug = ? AND present = 1 AND id NOT IN (SELECT value FROM json_each(?))'),
    rename: db.prepare('UPDATE pages SET name = ?, kind = ?, updated_at = ? WHERE id = ?'),
    setWebhook: db.prepare('UPDATE pages SET webhook_url = ?, updated_at = ? WHERE id = ?'),
    absentSlug: db.prepare('UPDATE pages SET present = 0, updated_at = ? WHERE slug = ?'),
    // páginas de captação dos sites que têm domínio (o que está no ar)
    live: db.prepare(`SELECT p.*, l.custom_domain AS domain, l.name AS site_name FROM pages p
      JOIN lps l ON l.slug = p.slug
      WHERE l.custom_domain IS NOT NULL AND p.kind = 'landing' AND p.present = 1
      ORDER BY l.created_at, (p.path = '/') DESC, p.created_at, p.path`),
  };

  // Lê os HTMLs da pasta do site e acerta a tabela de páginas.
  function sync(slug, dir, indexFile) {
    const files = [];
    const walk = (p, rel = '') => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const sub = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!e.name.startsWith('.') && e.name !== '__MACOSX') walk(path.join(p, e.name), sub); }
        else if (/\.html?$/i.test(e.name)) files.push(sub);
      }
    };
    try { walk(dir); } catch (_) { return []; }
    const now = Date.now();
    const seen = [];
    db.transaction(() => {
      for (const file of files) {
        const p = pathForFile(file, indexFile);
        const cur = q.byPath.get(slug, p);
        if (cur) { q.refresh.run(file, now, cur.id); seen.push(cur.id); continue; }
        const name = titleOf(path.join(dir, file)) || (p === '/' ? 'Página principal' : p.slice(1));
        const info = q.insert.run(slug, p, file, name, kindForPath(p), now, now);
        seen.push(Number(info.lastInsertRowid));
      }
      q.absent.run(now, slug, JSON.stringify(seen));
    })();
    return q.bySlug.all(slug);
  }

  return {
    sync,
    list: (slug) => q.bySlug.all(slug),
    get: (id) => q.byId.get(id),
    find: (slug, p) => q.byPath.get(slug, p),
    live: () => q.live.all(),
    rename: (id, name, kind) => q.rename.run(name, kind, Date.now(), id),
    setWebhook: (id, url) => q.setWebhook.run(url, Date.now(), id),
    // site excluído: as páginas ficam (ausentes), com os mesmos ids, para os leads e
    // os números continuarem ligados; se o site voltar com o mesmo slug, o sync as reativa
    removeSite: (slug) => q.absentSlug.run(Date.now(), slug),
  };
}
