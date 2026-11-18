import { parsePeriod } from './stats.js';
import { CHANNELS } from './tracking.js';
import { DEFAULT_GOAL, matchSyntax, safeUrl, hostOf, cleanOutput } from './intel.js';

// ── Telas: Mapa de origem e Central de Inteligência ─────────────────────────

const json = (x) => JSON.stringify(x).replace(/</g, '\\u003c');
const METRICS = { visitas: 'Visitas', contatos: 'Contatos', leads: 'Leads' };

export function registerCentral(app, ctx) {
  const { pages, insights, intel, geo, render, takeFlash, requireAuth, audit, ah, siteDirOf } = ctx;

  // página escolhida (?pg=id) ou todas as páginas no ar
  function pagesFor(req) {
    const live = pages.live();
    const id = parseInt(req.query.pg, 10);
    const sel = live.find((p) => p.id === id) || null;
    return { live, list: sel ? [sel] : live, sel };
  }
  const qs = (o) => Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  // ── Mapa ─────────────────────────────────────────────────────────────────
  app.get('/admin/mapa', requireAuth, (req, res) => {
    const period = parsePeriod(req.query);
    const { live, list, sel } = pagesFor(req);
    const canal = CHANNELS[req.query.canal] ? req.query.canal : '';
    const metrica = METRICS[req.query.m] ? req.query.m : 'visitas';
    const ids = list.map((p) => p.id);
    const data = ids.length ? insights.geo(ids, period.from, period.to, canal) : null;
    // canais com visita no período (para os filtros), contados sem o filtro de canal
    const todos = ids.length ? (canal ? insights.geo(ids, period.from, period.to, '') : data) : null;
    const canais = {};
    if (todos) for (const p of todos.points) for (const [ch, v] of Object.entries(p.channels)) canais[ch] = (canais[ch] || 0) + v.visits;
    if (todos) for (const [ch] of Object.entries(CHANNELS)) if (!(ch in canais) && ch === canal) canais[ch] = 0;
    const field = { visitas: 'visits', contatos: 'contacts', leads: 'leads' }[metrica];
    const points = data ? data.points.filter((p) => p[field] > 0) : [];
    render(req, res, 'map', {
      title: 'Mapa', period, live, sel, canal, metrica, METRICS, data, CHANNELS,
      canais: Object.entries(canais).sort((a, b) => b[1] - a[1]),
      geoStatus: geo.status(),
      extra: qs({ pg: sel ? sel.id : '', canal, m: metrica }),
      qs,
      mapJson: json({
        metric: field, metricLabel: METRICS[metrica], channels: CHANNELS,
        points: points.map((p) => ({ label: p.label, lat: p.lat, lon: p.lon, visits: p.visits, contacts: p.contacts, leads: p.leads, rate: p.rate, channels: p.channels })),
      }),
      ...takeFlash(req),
    });
  });

  // ── Central de Inteligência ──────────────────────────────────────────────
  app.get('/admin/inteligencia', requireAuth, (req, res) => {
    const period = parsePeriod(req.query.p ? req.query : { p: '90d' });
    const { live, list, sel } = pagesFor(req);
    const data = list.length ? insights.forAi({
      pages: list.map((p) => ({ ...p, url: `https://${p.domain}${p.path === '/' ? '/' : p.path}` })),
      from: period.from, to: period.to, prevFrom: period.prev.from, prevTo: period.prev.to, siteDirOf: null,
    }) : null;
    const reports = intel.list(12);
    const running = intel.running()[0] || null;
    render(req, res, 'intel', {
      title: 'Inteligência', period, live, sel, data, reports, running, CHANNELS,
      cfg: intel.cfg(), health: intel.health(), goal: intel.lastGoal(), DEFAULT_GOAL,
      extra: qs({ pg: sel ? sel.id : '' }),
      ...takeFlash(req),
    });
  });

  app.post('/admin/inteligencia/relatorios', requireAuth, ah(async (req, res) => {
    const period = parsePeriod({ p: req.body.p || '90d', de: req.body.de, ate: req.body.ate });
    const { list } = pagesFor({ query: { pg: req.body.pg } });
    const r = await intel.create({ user: req.user, period, pageList: list, goal: req.body.goal });
    if (r.error && !r.id) {
      req.session.flashWarn = r.error;
      return res.redirect('/admin/inteligencia');
    }
    audit(req, 'relatorio_ia', `${period.label}${list.length === 1 ? ' · ' + list[0].name : ''}`);
    if (r.error) req.session.flashWarn = r.error;
    res.redirect(`/admin/inteligencia/relatorios/${r.id}`);
  }));

  app.get('/admin/inteligencia/relatorios/:id', requireAuth, (req, res, next) => {
    const r = intel.get(parseInt(req.params.id, 10));
    if (!r) return next();
    let out = null, input = null, sources = null, usage = null;
    try { out = r.output_json ? cleanOutput(JSON.parse(r.output_json)).out : null; } catch (_) {}
    try { input = r.input_json ? JSON.parse(r.input_json) : null; } catch (_) {}
    try { sources = r.sources_json ? JSON.parse(r.sources_json) : null; } catch (_) {}
    try { usage = r.usage_json ? JSON.parse(r.usage_json) : null; } catch (_) {}
    const ids = (() => { try { return JSON.parse(r.page_ids || '[]'); } catch (_) { return []; } })();
    const pageNames = ids.map((id) => (pages.get(id) || {}).name).filter(Boolean);
    render(req, res, 'intel-report', {
      title: 'Relatório da IA', r, out, input, sources, usage, pageNames, matchSyntax, safeUrl, hostOf, ...takeFlash(req),
    });
  });

  app.get('/admin/inteligencia/relatorios/:id/status', requireAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const r = intel.get(parseInt(req.params.id, 10));
    if (!r) return res.status(404).json({ ok: false });
    res.json({ ok: true, status: r.status, error: r.error || null });
  });
}
