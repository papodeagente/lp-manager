import Database from 'better-sqlite3';

// Abre o SQLite e roda as migrações. Tudo aqui é idempotente: roda a cada boot
// e só cria o que ainda não existe (tabelas, colunas, índices).
export function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function addColumn(db, table, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`); } catch (_) {}
}

function migrate(db) {
  // ── Sites (cada "LP" do painel antigo é um site, com um domínio) ──────────
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
  addColumn(db, 'lps', 'webhook_url TEXT');

  // ── Leads ──────────────────────────────────────────────────────────────────
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
  // de que página veio, a visita que converteu e a origem (UTM) atribuída
  for (const col of [
    'page_id INTEGER', 'page_path TEXT', 'visit_id TEXT', 'visitor_id TEXT',
    'utm_source TEXT', 'utm_medium TEXT', 'utm_campaign TEXT', 'utm_term TEXT', 'utm_content TEXT',
    'click_type TEXT', 'click_id TEXT', 'channel TEXT', 'referrer TEXT', 'landing_page TEXT', 'device TEXT',
    'first_source TEXT', 'first_medium TEXT', 'first_campaign TEXT', 'first_seen INTEGER',
  ]) addColumn(db, 'leads', col);
  db.exec('CREATE INDEX IF NOT EXISTS idx_leads_page ON leads(page_id, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_leads_visit ON leads(visit_id)');

  // ── Controle das migrações de dados (rodam uma vez só) ───────────────────
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');

  // ── Usuários do painel, sessões e registro de atividade ──────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      password_changed_at INTEGER NOT NULL,
      last_login_at INTEGER,
      created_by INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_sessions (
      sid TEXT PRIMARY KEY,
      user_id INTEGER,
      sess TEXT NOT NULL,
      expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_exp ON admin_sessions(expires);
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_user ON admin_sessions(user_id);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      user_email TEXT,
      action TEXT NOT NULL,
      detail TEXT,
      ip TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_time ON audit(created_at);
  `);

  // ── Páginas de cada site (home, /fullface, /obrigado...) ─────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      path TEXT NOT NULL,
      file TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'landing',
      webhook_url TEXT,
      present INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(slug, path)
    );
  `);

  // ── Medição: visitas (sessões de navegação), visualizações e cliques ─────
  db.exec(`
    CREATE TABLE IF NOT EXISTS visits (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      visitor_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      landing_path TEXT,
      referrer TEXT,
      source TEXT NOT NULL,
      medium TEXT NOT NULL,
      campaign TEXT,
      term TEXT,
      content TEXT,
      click_type TEXT,
      click_id TEXT,
      channel TEXT NOT NULL,
      inherited INTEGER NOT NULL DEFAULT 0,
      campaign_key TEXT,
      device TEXT,
      is_new INTEGER NOT NULL DEFAULT 1,
      pageviews INTEGER NOT NULL DEFAULT 0,
      test INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_visits_visitor ON visits(visitor_id, last_seen);
    CREATE INDEX IF NOT EXISTS idx_visits_slug ON visits(slug, started_at);
    CREATE TABLE IF NOT EXISTS pageviews (
      id TEXT PRIMARY KEY,
      visit_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      page_id INTEGER,
      path TEXT NOT NULL,
      ts INTEGER NOT NULL,
      engaged_ms INTEGER NOT NULL DEFAULT 0,
      max_scroll INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_pv_page ON pageviews(page_id, ts);
    CREATE INDEX IF NOT EXISTS idx_pv_slug ON pageviews(slug, ts);
    CREATE INDEX IF NOT EXISTS idx_pv_visit ON pageviews(visit_id);
    CREATE TABLE IF NOT EXISTS clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pageview_id TEXT,
      visit_id TEXT,
      slug TEXT NOT NULL,
      page_id INTEGER,
      path TEXT,
      kind TEXT NOT NULL,
      label TEXT,
      target TEXT,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_clicks_page ON clicks(page_id, ts);
    CREATE INDEX IF NOT EXISTS idx_clicks_visit ON clicks(visit_id);
  `);

  // parâmetros do endereço de entrada da visita (a ficha do lead mostra todos)
  addColumn(db, 'visits', 'landing_query TEXT');
  // página por onde entrou a visita que trouxe a campanha (a própria entrada, ou a da
  // visita de origem quando esta só herdou a origem): é por ela que o link com UTM conta
  addColumn(db, 'visits', 'campaign_landing TEXT');
  // lead enviado de aparelho de teste ou com a medição desligada: fica fora dos números
  addColumn(db, 'leads', 'test INTEGER NOT NULL DEFAULT 0');

  // ── Links com UTM salvos por página ───────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS utm_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      medium TEXT NOT NULL,
      campaign TEXT NOT NULL,
      term TEXT,
      content TEXT,
      created_by INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_utm_links_page ON utm_links(page_id);
  `);
}

// Marca uma migração de dados como feita; devolve false se já tinha rodado.
export function once(db, key, fn) {
  const done = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  if (done) return false;
  db.transaction(() => {
    fn();
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, String(Date.now()));
  })();
  return true;
}
