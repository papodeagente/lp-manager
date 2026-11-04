import { CHANNELS, CLICK_KINDS } from './tracking.js';

// ── Ficha do lead: todo o rastreamento ──────────────────────────────────────
// A origem atribuída já está no próprio lead (copiada da visita que converteu).
// Aqui se monta o resto: todas as visitas do mesmo visitante no site, com o que
// ele abriu, quanto leu, onde clicou e quando enviou o contato, e os parâmetros
// do endereço da página no momento do envio.

// Parâmetros que o painel reconhece no endereço, na ordem em que aparecem na ficha.
export const PARAMS = {
  utm_source: 'Origem',
  utm_medium: 'Mídia',
  utm_campaign: 'Campanha',
  utm_term: 'Palavra-chave',
  utm_content: 'Anúncio ou conteúdo',
  utm_id: 'Id da campanha',
  gclid: 'Clique do Google Ads',
  gbraid: 'Clique do Google Ads (iPhone)',
  wbraid: 'Clique do Google Ads (iPhone)',
  gad_source: 'Marcador do Google Ads',
  gad_campaignid: 'Campanha no Google Ads',
  fbclid: 'Clique do Instagram/Facebook',
  msclkid: 'Clique do Microsoft Ads',
  ttclid: 'Clique do TikTok',
  li_fat_id: 'Clique do LinkedIn',
  twclid: 'Clique do X',
};

// Todos os parâmetros de uma URL ou query: os conhecidos primeiro, depois o resto.
export function urlParams(raw) {
  if (!raw) return [];
  let params;
  try {
    const s = String(raw);
    params = /^https?:\/\//i.test(s) ? new URL(s).searchParams : new URLSearchParams(s.replace(/^\?/, ''));
  } catch (_) { return []; }
  const out = [];
  for (const [key, value] of params) {
    if (!value) continue;
    out.push({ key, value: value.slice(0, 500), label: PARAMS[key] || null });
  }
  const order = Object.keys(PARAMS);
  return out.sort((a, b) => {
    const ia = order.indexOf(a.key), ib = order.indexOf(b.key);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}

// Botão ou formulário que gerou o lead (campo "source" que a página manda).
const ONDE = [
  [/hero-alt/, 'topo'], [/header|cabecalho/, 'cabeçalho'], [/flutuante/, 'botão flutuante'], [/fixo|sticky/, 'barra fixa'],
  [/rodape|footer/, 'rodapé'], [/menu/, 'menu'], [/consulta/, 'seção da consulta'], [/cta/, 'chamada da página'], [/hero/, 'topo'],
];
export function sourceLabel(source) {
  const s = String(source || '').toLowerCase();
  if (!s) return 'Não informado';
  const where = (ONDE.find(([re]) => re.test(s)) || [])[1];
  if (/form/.test(s)) return 'Formulário' + (where ? ` (${where})` : '');
  if (/whatsapp|^fullface-|^wa-/.test(s)) return 'Botão de WhatsApp' + (where ? ` (${where})` : '');
  if (s === 'teste-webhook') return 'Teste do webhook';
  return s;
}

export function makeJourney(db) {
  const q = {
    visits: db.prepare('SELECT * FROM visits WHERE visitor_id = ? AND slug = ? ORDER BY started_at LIMIT 60'),
    pageviews: db.prepare(`SELECT pv.id, pv.visit_id, pv.path, pv.ts, pv.engaged_ms, pv.max_scroll, p.name AS page_name
      FROM pageviews pv LEFT JOIN pages p ON p.id = pv.page_id
      WHERE pv.visit_id IN (SELECT value FROM json_each(?)) ORDER BY pv.ts`),
    clicks: db.prepare(`SELECT visit_id, path, kind, label, target, ts FROM clicks
      WHERE visit_id IN (SELECT value FROM json_each(?)) ORDER BY ts`),
    leads: db.prepare('SELECT id, name, source, page_path, visit_id, created_at FROM leads WHERE visitor_id = ? AND slug = ? ORDER BY created_at'),
  };

  // Visitas do visitante do lead, cada uma com a sequência do que aconteceu nela.
  function forLead(lead) {
    if (!lead.visitor_id) return [];
    const visits = q.visits.all(lead.visitor_id, lead.slug);
    if (!visits.length) return [];
    const ids = JSON.stringify(visits.map((v) => v.id));
    const pvs = q.pageviews.all(ids);
    const cls = q.clicks.all(ids);
    const leads = q.leads.all(lead.visitor_id, lead.slug);
    return visits.map((v) => {
      const pages = pvs.filter((p) => p.visit_id === v.id);
      const events = [
        ...pages.map((p) => ({ t: p.ts, type: 'page', path: p.path, name: p.page_name, engaged: p.engaged_ms, scroll: p.max_scroll })),
        ...cls.filter((c) => c.visit_id === v.id).map((c) => ({ t: c.ts, type: 'click', kind: CLICK_KINDS[c.kind] || c.kind, label: c.label, target: c.target })),
        ...leads.filter((l) => l.visit_id === v.id).map((l) => ({ t: l.created_at, type: 'lead', id: l.id, self: l.id === lead.id, how: sourceLabel(l.source) })),
      ].sort((a, b) => a.t - b.t || (a.type === 'page' ? -1 : 1));
      return {
        ...v,
        channel_label: CHANNELS[v.channel] || 'Outras origens',
        engaged: pages.reduce((s, p) => s + (p.engaged_ms || 0), 0),
        pages: pages.length,
        events,
        converted: v.id === lead.visit_id,
        after: v.started_at > lead.created_at && v.id !== lead.visit_id,
        params: urlParams(v.landing_query),
      };
    });
  }

  return { forLead };
}
