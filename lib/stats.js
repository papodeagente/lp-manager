import { CHANNELS, CONTACT_KINDS } from './tracking.js';

// ── Números do painel ────────────────────────────────────────────────────────
// Dias e horas contados no horário de Brasília (UTC-3, sem horário de verão desde
// 2019). Visitas marcadas como teste (?lpm=test) nunca entram nos números.

export const TZ_OFFSET = -3 * 3600 * 1000;
const DAY = 86400000, HOUR = 3600000;

export const dayIndex = (ts) => Math.floor((ts + TZ_OFFSET) / DAY);
export const dayStart = (idx) => idx * DAY - TZ_OFFSET;
export const isoDay = (idx) => new Date(idx * DAY).toISOString().slice(0, 10);

function idxFromIso(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Number.isFinite(t) ? Math.floor(t / DAY) : null;
}

export const PERIODS = [['hoje', 'Hoje'], ['7d', '7 dias'], ['30d', '30 dias'], ['90d', '90 dias'], ['mes', 'Este mês']];

export function parsePeriod(query, now = Date.now()) {
  const today = dayIndex(now);
  let key = String(query.p || '30d');
  let a, b;
  if (key === 'hoje') { a = b = today; }
  else if (key === '7d') { a = today - 6; b = today; }
  else if (key === '90d') { a = today - 89; b = today; }
  else if (key === 'mes') { const d = new Date(now + TZ_OFFSET); a = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / DAY); b = today; }
  else if (key === 'custom') {
    a = idxFromIso(query.de); b = idxFromIso(query.ate);
    if (a == null || b == null) { key = '30d'; a = today - 29; b = today; }
    else {
      if (a > b) [a, b] = [b, a];
      b = Math.min(b, today);
      a = Math.max(a, b - 399);
    }
  } else { key = '30d'; a = today - 29; b = today; }
  const len = b - a + 1;
  const from = dayStart(a);
  const to = Math.min(dayStart(b + 1), now + 1);
  const shift = len * DAY;
  const label = key === 'custom'
    ? `${fmtDay(a)} a ${fmtDay(b)}`
    : (PERIODS.find(([k]) => k === key) || [, '30 dias'])[1];
  return { key, label, a, b, len, from, to, prev: { from: from - shift, to: to - shift }, hourly: len === 1, de: isoDay(a), ate: isoDay(b) };
}

export function fmtDay(idx) {
  const d = new Date(idx * DAY);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Dimensões de origem: coluna na visita e coluna equivalente no lead.
const DIMS = {
  canal: { v: 'v.channel', l: 'l.channel', label: 'Canal' },
  origem: { v: "v.source || ' / ' || v.medium", l: "COALESCE(l.utm_source, '(direct)') || ' / ' || COALESCE(l.utm_medium, '(none)')", label: 'Origem / mídia' },
  campanha: { v: "COALESCE(v.campaign, '')", l: "COALESCE(l.utm_campaign, '')", label: 'Campanha' },
  termo: { v: "COALESCE(v.term, '')", l: "COALESCE(l.utm_term, '')", label: 'Palavra-chave' },
  conteudo: { v: "COALESCE(v.content, '')", l: "COALESCE(l.utm_content, '')", label: 'Anúncio / conteúdo' },
  dispositivo: { v: "COALESCE(v.device, '')", l: "COALESCE(l.device, '')", label: 'Aparelho' },
};
export const DIM_KEYS = Object.keys(DIMS);
export const DIM_LABELS = Object.fromEntries(Object.entries(DIMS).map(([k, d]) => [k, d.label]));

export function dimLabel(dim, key) {
  if (dim === 'canal') return CHANNELS[key] || 'Outras origens';
  if (dim === 'origem') return key === '(direct) / (none)' ? 'Direto' : key;
  if (dim === 'dispositivo') return { celular: 'Celular', computador: 'Computador', tablet: 'Tablet' }[key] || 'Não identificado';
  if (!key) return { campanha: '(sem campanha)', termo: '(sem palavra-chave)', conteudo: '(sem identificação)' }[dim] || '(vazio)';
  return key;
}

export function makeStats(db) {
  const IN = 'SELECT value FROM json_each(?)';
  const q = {
    views: db.prepare(`SELECT COUNT(*) AS views, COUNT(DISTINCT pv.visit_id) AS visits, COUNT(DISTINCT v.visitor_id) AS visitors,
        AVG(pv.engaged_ms) AS avg_ms, AVG(pv.max_scroll) AS avg_scroll, SUM(pv.max_scroll >= 90) AS read_end
      FROM pageviews pv JOIN visits v ON v.id = pv.visit_id
      WHERE pv.page_id IN (${IN}) AND pv.ts >= ? AND pv.ts < ? AND v.test = 0`),
    // "Cliques em contato": um por tipo em cada visualização (clicar duas vezes no mesmo
    // botão ou repetir o envio recusado pela validação não infla o número)
    clicks: db.prepare(`SELECT COUNT(DISTINCT c.pageview_id || ':' || c.kind) AS clicks
      FROM clicks c JOIN visits v ON v.id = c.visit_id
      WHERE c.page_id IN (${IN}) AND c.ts >= ? AND c.ts < ? AND v.test = 0 AND c.kind IN (${IN})`),
    // funil e taxa: só as visitas que viram a página no período (o denominador)
    visitsClicked: db.prepare(`SELECT COUNT(DISTINCT c.visit_id) AS n FROM clicks c
      WHERE c.page_id IN (${IN}) AND c.kind IN (${IN})
      AND c.visit_id IN (SELECT pv.visit_id FROM pageviews pv JOIN visits v ON v.id = pv.visit_id
        WHERE pv.page_id IN (${IN}) AND pv.ts >= ? AND pv.ts < ? AND v.test = 0)`),
    trackedConv: db.prepare(`SELECT COUNT(DISTINCT l.visit_id) AS n FROM leads l
      WHERE l.page_id IN (${IN}) AND l.visit_id IN (SELECT pv.visit_id FROM pageviews pv JOIN visits v ON v.id = pv.visit_id
        WHERE pv.page_id IN (${IN}) AND pv.ts >= ? AND pv.ts < ? AND v.test = 0)`),
    leads: db.prepare(`SELECT COUNT(*) AS leads, COUNT(DISTINCT COALESCE(l.visit_id, 'l' || l.id)) AS conversions,
        SUM(l.visit_id IS NULL) AS untracked
      FROM leads l LEFT JOIN visits v ON v.id = l.visit_id
      WHERE l.page_id IN (${IN}) AND l.created_at >= ? AND l.created_at < ? AND COALESCE(v.test, 0) = 0`),
    seriesVisits: db.prepare(`SELECT pv.page_id AS page, CAST((pv.ts + ?) / ? AS INTEGER) AS b, COUNT(DISTINCT pv.visit_id) AS n
      FROM pageviews pv JOIN visits v ON v.id = pv.visit_id
      WHERE pv.page_id IN (${IN}) AND pv.ts >= ? AND pv.ts < ? AND v.test = 0 GROUP BY page, b`),
    seriesLeads: db.prepare(`SELECT l.page_id AS page, CAST((l.created_at + ?) / ? AS INTEGER) AS b,
        COUNT(DISTINCT COALESCE(l.visit_id, 'l' || l.id)) AS n
      FROM leads l LEFT JOIN visits v ON v.id = l.visit_id
      WHERE l.page_id IN (${IN}) AND l.created_at >= ? AND l.created_at < ? AND COALESCE(v.test, 0) = 0 GROUP BY page, b`),
    buckets: db.prepare(`SELECT SUM(pv.engaged_ms < 10000) AS b0, SUM(pv.engaged_ms >= 10000 AND pv.engaged_ms < 30000) AS b1,
        SUM(pv.engaged_ms >= 30000 AND pv.engaged_ms < 60000) AS b2, SUM(pv.engaged_ms >= 60000 AND pv.engaged_ms < 180000) AS b3,
        SUM(pv.engaged_ms >= 180000) AS b4
      FROM pageviews pv JOIN visits v ON v.id = pv.visit_id
      WHERE pv.page_id IN (${IN}) AND pv.ts >= ? AND pv.ts < ? AND v.test = 0`),
    topClicks: db.prepare(`SELECT c.kind, c.label, c.target, COUNT(*) AS n, COUNT(DISTINCT c.visit_id) AS visits
      FROM clicks c JOIN visits v ON v.id = c.visit_id
      WHERE c.page_id IN (${IN}) AND c.ts >= ? AND c.ts < ? AND v.test = 0
      GROUP BY c.kind, c.label, c.target ORDER BY n DESC LIMIT 15`),
    recentLeads: db.prepare(`SELECT l.*, p.name AS page_name FROM leads l LEFT JOIN pages p ON p.id = l.page_id
      WHERE l.page_id IN (${IN}) ORDER BY l.created_at DESC LIMIT ?`),
    statusLast: db.prepare(`SELECT pv.ts FROM pageviews pv JOIN visits v ON v.id = pv.visit_id
      WHERE pv.slug = ? AND v.test = 0 ORDER BY pv.ts DESC LIMIT 1`),
    statusFirst: db.prepare(`SELECT pv.ts FROM pageviews pv JOIN visits v ON v.id = pv.visit_id
      WHERE pv.slug = ? AND v.test = 0 ORDER BY pv.ts ASC LIMIT 1`),
    statusDay: db.prepare(`SELECT COUNT(*) AS n FROM pageviews pv JOIN visits v ON v.id = pv.visit_id
      WHERE pv.slug = ? AND pv.ts >= ? AND v.test = 0`),
    testStatus: db.prepare(`SELECT COUNT(*) AS n, MAX(pv.ts) AS last FROM pageviews pv JOIN visits v ON v.id = pv.visit_id
      WHERE pv.slug = ? AND v.test = 1 AND pv.ts >= ?`),
    linkVisits: db.prepare(`SELECT COUNT(*) AS n FROM visits WHERE slug = ? AND landing_path = ? AND test = 0 AND inherited = 0
      AND source = ? AND medium = ? AND COALESCE(campaign, '') = ? AND (? = '' OR COALESCE(content, '') = ?) AND (? = '' OR COALESCE(term, '') = ?)
      AND started_at >= ? AND started_at < ?`),
    linkLeads: db.prepare(`SELECT COUNT(*) AS n FROM leads l LEFT JOIN visits v ON v.id = l.visit_id
      WHERE l.slug = ? AND COALESCE(l.landing_page, l.page_path) = ? AND COALESCE(v.test, 0) = 0
      AND l.utm_source = ? AND l.utm_medium = ? AND COALESCE(l.utm_campaign, '') = ? AND (? = '' OR COALESCE(l.utm_content, '') = ?)
      AND (? = '' OR COALESCE(l.utm_term, '') = ?) AND l.created_at >= ? AND l.created_at < ?`),
  };
  const dimQ = {};
  for (const [k, d] of Object.entries(DIMS)) {
    dimQ[k] = {
      v: db.prepare(`SELECT ${d.v} AS k, COUNT(*) AS visits FROM visits v
        WHERE v.test = 0 AND v.id IN (SELECT DISTINCT visit_id FROM pageviews WHERE page_id IN (${IN}) AND ts >= ? AND ts < ?)
        GROUP BY k`),
      l: db.prepare(`SELECT ${d.l} AS k, COUNT(DISTINCT COALESCE(l.visit_id, 'l' || l.id)) AS conv,
          COUNT(DISTINCT CASE WHEN l.visit_id IN (SELECT visit_id FROM pageviews WHERE page_id IN (${IN}) AND ts >= ? AND ts < ?)
            THEN l.visit_id END) AS tconv
        FROM leads l LEFT JOIN visits v ON v.id = l.visit_id
        WHERE l.page_id IN (${IN}) AND l.created_at >= ? AND l.created_at < ? AND COALESCE(v.test, 0) = 0 GROUP BY k`),
    };
  }
  const contact = JSON.stringify(CONTACT_KINDS);

  function kpis(pageIds, from, to) {
    const ids = JSON.stringify(pageIds);
    const v = q.views.get(ids, from, to);
    const c = q.clicks.get(ids, from, to, contact);
    const l = q.leads.get(ids, from, to);
    const clicked = q.visitsClicked.get(ids, contact, ids, from, to).n || 0;
    const tracked = q.trackedConv.get(ids, ids, from, to).n || 0;
    const visits = v.visits || 0;
    return {
      visits, views: v.views || 0, visitors: v.visitors || 0,
      avg_ms: v.views ? Math.round(v.avg_ms || 0) : null,
      avg_scroll: v.views ? Math.round(v.avg_scroll || 0) : null,
      read_end: v.read_end || 0,
      clicks: c.clicks || 0, visits_clicked: Math.min(clicked, visits),
      leads: l.leads || 0, conversions: l.conversions || 0,
      tracked_conversions: Math.min(tracked, visits), untracked: l.untracked || 0,
      // taxa = visitas que converteram ÷ visitas que viram a página (só o que foi medido)
      rate: visits ? Math.min(1, tracked / visits) : null,
      click_rate: visits ? Math.min(1, clicked / visits) : null,
    };
  }

  // Série por dia (ou por hora, no período de um dia só), uma linha por página.
  function series(pageIds, period) {
    const ids = JSON.stringify(pageIds);
    const size = period.hourly ? HOUR : DAY;
    const n = period.hourly ? 24 : period.len;
    const base = period.hourly ? period.a * 24 : period.a;
    const empty = () => Array.from({ length: n }, () => 0);
    const visits = Object.fromEntries(pageIds.map((id) => [id, empty()]));
    const leads = Object.fromEntries(pageIds.map((id) => [id, empty()]));
    for (const r of q.seriesVisits.all(TZ_OFFSET, size, ids, period.from, period.to)) {
      const i = r.b - base;
      if (visits[r.page] && i >= 0 && i < n) visits[r.page][i] = r.n;
    }
    for (const r of q.seriesLeads.all(TZ_OFFSET, size, ids, period.from, period.to)) {
      const i = r.b - base;
      if (leads[r.page] && i >= 0 && i < n) leads[r.page][i] = r.n;
    }
    const labels = period.hourly
      ? Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}h`)
      : Array.from({ length: n }, (_, i) => fmtDay(period.a + i));
    return { labels, visits, leads };
  }

  // Tabela por origem: acessos vêm das visitas, conversões vêm dos leads (os leads
  // antigos, de antes da medição, também entram aqui pela UTM da URL).
  function breakdown(pageIds, dim, from, to) {
    const ids = JSON.stringify(pageIds);
    const rows = new Map();
    for (const r of dimQ[dim].v.all(ids, from, to)) rows.set(r.k ?? '', { key: r.k ?? '', visits: r.visits, conv: 0, tconv: 0 });
    for (const r of dimQ[dim].l.all(ids, from, to, ids, from, to)) {
      const k = r.k ?? '';
      const row = rows.get(k) || { key: k, visits: 0, conv: 0, tconv: 0 };
      row.conv += r.conv;
      row.tconv += r.tconv;
      rows.set(k, row);
    }
    // a taxa usa só as conversões de visitas medidas, para nunca passar de 100%
    const out = [...rows.values()]
      .map((r) => ({ ...r, label: dimLabel(dim, r.key), rate: r.visits ? Math.min(1, r.tconv / r.visits) : null }))
      .sort((x, y) => y.visits - x.visits || y.conv - x.conv);
    const max = Math.max(1, ...out.map((r) => r.visits));
    return out.slice(0, 12).map((r) => ({ ...r, share: r.visits / max }));
  }

  function buckets(pageIds, from, to) {
    const r = q.buckets.get(JSON.stringify(pageIds), from, to);
    const vals = [r.b0, r.b1, r.b2, r.b3, r.b4].map((x) => x || 0);
    const total = vals.reduce((s, x) => s + x, 0);
    const names = ['Menos de 10 s', '10 a 30 s', '30 s a 1 min', '1 a 3 min', 'Mais de 3 min'];
    return names.map((name, i) => ({ name, n: vals[i], share: total ? vals[i] / total : 0 }));
  }

  const topClicks = (pageIds, from, to) => q.topClicks.all(JSON.stringify(pageIds), from, to);
  const recentLeads = (pageIds, limit = 8) => q.recentLeads.all(JSON.stringify(pageIds), limit);

  function status(slug, now = Date.now()) {
    const last = q.statusLast.get(slug), first = q.statusFirst.get(slug);
    const t = q.testStatus.get(slug, now - DAY);
    return { last: last ? last.ts : null, first: first ? first.ts : null, day: q.statusDay.get(slug, now - DAY).n || 0,
      test_day: t.n || 0, test_last: t.last };
  }

  // Números de um link com UTM: acessos que entraram por esta página com essas UTMs
  // (sem os de teste e sem os retornos que só herdaram a origem) e os leads atribuídos.
  function linkStats(page, link, from, to) {
    const c = link.content || '', t = link.term || '', camp = link.campaign || '';
    return {
      visits: q.linkVisits.get(page.slug, page.path, link.source, link.medium, camp, c, c, t, t, from, to).n,
      leads: q.linkLeads.get(page.slug, page.path, link.source, link.medium, camp, c, c, t, t, from, to).n,
    };
  }

  return { kpis, series, breakdown, buckets, topClicks, recentLeads, status, linkStats };
}
