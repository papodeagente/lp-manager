// Banco de DEMONSTRAÇÃO para ver o painel localmente (nunca rodar em produção).
//   DATA_DIR=/tmp/lpm-demo node scripts/seed-demo.js <pasta-do-site>
// Cria o site "hipro" com os HTML da pasta, e 120 dias de visitas, cliques e leads
// fictícios com origem, palavra-chave e cidade. Tudo é sorteado com semente fixa.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb } from '../lib/db.js';
import { makePages } from '../lib/pages.js';
import { channelOf } from '../lib/tracking.js';

const DATA_DIR = process.env.DATA_DIR;
const SRC = process.argv[2];
if (!DATA_DIR || !SRC) { console.error('uso: DATA_DIR=... node scripts/seed-demo.js <pasta-do-site>'); process.exit(1); }
if (/\/app\/data/.test(DATA_DIR)) { console.error('isto é só para demonstração local'); process.exit(1); }

fs.mkdirSync(path.join(DATA_DIR, 'sites'), { recursive: true });
const db = openDb(path.join(DATA_DIR, 'lps.db'));
if (db.prepare('SELECT COUNT(*) AS n FROM visits').get().n) { console.error('o banco já tem visitas; use uma pasta vazia'); process.exit(1); }

const site = path.join(DATA_DIR, 'sites', 'hipro');
fs.cpSync(SRC, site, { recursive: true });
const now = Date.now();
db.prepare('INSERT OR IGNORE INTO lps (slug, name, custom_domain, index_file, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
  .run('hipro', 'Glazi Melo', 'draglazi.localhost', 'index.html', now, now);
const pages = makePages(db);
pages.sync('hipro', site, 'index.html');
const lista = pages.list ? pages.list('hipro') : db.prepare("SELECT * FROM pages WHERE slug = 'hipro'").all();
const home = lista.find((p) => p.path === '/');
const ff = lista.find((p) => p.path === '/fullface');
if (!home || !ff) { console.error('a pasta precisa ter index.html e fullface.html'); process.exit(1); }

// sorteio com semente fixa
let seed = 20261118;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const pick = (arr) => { const t = arr.reduce((s, x) => s + x[0], 0); let r = rnd() * t; for (const x of arr) { if ((r -= x[0]) <= 0) return x[1]; } return arr[arr.length - 1][1]; };
const id = () => crypto.randomBytes(9).toString('base64url');

const CIDADES = [
  [52, ['BR', 'Distrito Federal', 'Brasília', -15.798, -47.892]],
  [6, ['BR', 'Distrito Federal', 'Taguatinga', -15.833, -48.056]],
  [5, ['BR', 'Distrito Federal', 'Águas Claras', -15.834, -48.027]],
  [3, ['BR', 'Distrito Federal', 'Gama', -16.018, -48.067]],
  [5, ['BR', 'Goiás', 'Goiânia', -16.679, -49.254]],
  [3, ['BR', 'Goiás', 'Valparaíso de Goiás', -16.068, -47.976]],
  [2, ['BR', 'Goiás', 'Luziânia', -16.253, -47.95]],
  [2, ['BR', 'Goiás', 'Águas Lindas de Goiás', -15.762, -48.282]],
  [2, ['BR', 'Goiás', 'Anápolis', -16.327, -48.953]],
  [1, ['BR', 'Goiás', 'Formosa', -15.537, -47.334]],
  [4, ['BR', 'São Paulo', 'São Paulo', -23.556, -46.64]],
  [2, ['BR', 'Rio de Janeiro', 'Rio de Janeiro', -22.907, -43.173]],
  [2, ['BR', 'Minas Gerais', 'Belo Horizonte', -19.917, -43.934]],
  [1, ['BR', 'Bahia', 'Salvador', -12.971, -38.501]],
  [1, ['BR', 'Tocantins', 'Palmas', -10.184, -48.333]],
  [1, ['PT', 'Lisbon', 'Lisbon', 38.722, -9.139]],
  [8, null],
];
// palavra-chave -> [peso, chance de lead, página]
const TERMOS = [
  ['ultrassom microfocado brasilia', 18, 0.11, home], ['hipro ultrassom', 12, 0.14, home], ['ultraformer brasilia', 9, 0.06, home],
  ['flacidez facial tratamento', 8, 0.03, home], ['lifting sem cirurgia', 7, 0.04, home], ['ultrassom micro e macrofocado', 5, 0.09, home],
  ['harmonizacao facial brasilia', 10, 0.07, ff], ['full face brasilia', 6, 0.12, ff], ['preenchimento labial', 6, 0.02, ff],
  ['bioestimulador de colageno', 5, 0.05, ff], ['botox brasilia preço', 7, 0.01, ff], ['dermatologista asa sul', 3, 0.0, home],
];
const ORIGENS = [
  [46, 'ads'], [15, ['google', 'organic']], [18, ['(direct)', '(none)']], [9, ['instagram', 'social']],
  [3, ['chatgpt', 'ia']], [5, ['whatsapp', 'referral']], [4, ['bing', 'organic']],
];

const ins = {
  visit: db.prepare(`INSERT INTO visits (id, slug, visitor_id, started_at, last_seen, landing_path, landing_query, referrer, source, medium,
      campaign, term, content, click_type, click_id, channel, inherited, campaign_key, campaign_landing, device, is_new, pageviews, test,
      geo_country, geo_region, geo_city, geo_lat, geo_lon)
    VALUES (@id, 'hipro', @visitor_id, @t, @t2, @path, NULL, @referrer, @source, @medium, @campaign, @term, @content, @click_type, @click_id,
      @channel, 0, NULL, @path, @device, 1, @pvs, 0, @c, @r, @city, @lat, @lon)`),
  pv: db.prepare('INSERT INTO pageviews (id, visit_id, slug, page_id, path, ts, engaged_ms, max_scroll, updated_at) VALUES (?, ?, \'hipro\', ?, ?, ?, ?, ?, ?)'),
  click: db.prepare('INSERT INTO clicks (pageview_id, visit_id, slug, page_id, path, kind, label, target, ts) VALUES (?, ?, \'hipro\', ?, ?, ?, ?, ?, ?)'),
  lead: db.prepare(`INSERT INTO leads (slug, name, phone, message, source, page_url, user_agent, ip, webhook_status, created_at, page_id, page_path,
      visit_id, visitor_id, utm_source, utm_medium, utm_campaign, utm_term, utm_content, click_type, click_id, channel, referrer, landing_page,
      device, test, geo_country, geo_region, geo_city, geo_lat, geo_lon)
    VALUES ('hipro', @name, @phone, '', 'site', @url, 'demo', NULL, 'sem-webhook', @t, @page_id, @path, @visit_id, @visitor_id, @source, @medium,
      @campaign, @term, @content, @click_type, @click_id, @channel, @referrer, @path, @device, 0, @c, @r, @city, @lat, @lon)`),
};

const NOMES = ['Ana', 'Beatriz', 'Carla', 'Daniela', 'Fernanda', 'Gabriela', 'Juliana', 'Larissa', 'Mariana', 'Patrícia', 'Renata', 'Simone'];
let nVis = 0, nLead = 0;
db.transaction(() => {
  for (let d = 119; d >= 0; d--) {
    const base = now - d * 86400000;
    const dow = new Date(base - 3 * 3600000).getUTCDay();
    const n = Math.round((dow === 0 ? 14 : dow === 6 ? 20 : 34) * (0.75 + rnd() * 0.5) * (1 + (119 - d) / 240));
    for (let i = 0; i < n; i++) {
      const hour = pick([[1, 6], [3, 8], [5, 9], [6, 10], [6, 11], [6, 12], [5, 13], [5, 14], [5, 15], [5, 16], [5, 17], [6, 18], [7, 19], [8, 20], [8, 21], [6, 22], [3, 23], [1, 0]]);
      const t = base - (base % 86400000) + (hour + 3) * 3600000 + Math.floor(rnd() * 3600000) - 86400000 * (d === 0 && hour + 3 > new Date(now).getUTCHours() ? 1 : 0);
      if (t > now) continue;
      const o = pick(ORIGENS);
      let v = { source: null, medium: null, campaign: null, term: null, content: null, click_type: null, click_id: null, referrer: null };
      let page = rnd() < 0.55 ? home : ff, chance = 0.025;
      if (o === 'ads') {
        const tm = pick(TERMOS.map((x) => [x[1], x]));
        page = tm[3]; chance = tm[2];
        v = { source: 'google', medium: 'cpc', campaign: page === home ? 'hipro_bsb' : 'fullface_bsb', term: tm[0], content: String(70000 + Math.floor(rnd() * 6)), click_type: 'gclid', click_id: id(), referrer: 'www.google.com' };
      } else {
        v.source = o[0]; v.medium = o[1];
        if (o[1] === 'organic') { v.referrer = o[0] === 'bing' ? 'www.bing.com' : 'www.google.com'; chance = 0.06; }
        if (o[0] === 'instagram') { v.referrer = 'l.instagram.com'; chance = 0.03; }
        if (o[0] === 'chatgpt') { v.referrer = 'chatgpt.com'; chance = 0.08; }
        if (o[0] === '(direct)') chance = 0.05;
      }
      const geo = pick(CIDADES) || [null, null, null, null, null];
      const device = pick([[72, 'celular'], [24, 'computador'], [4, 'tablet']]);
      const vid = id(), visitor = id();
      const pvs = rnd() < 0.2 ? 2 : 1;
      const engaged = Math.floor(4000 + rnd() * (rnd() < 0.3 ? 240000 : 60000));
      ins.visit.run({ id: vid, visitor_id: visitor, t, t2: t + engaged, path: page.path, ...v, channel: channelOf(v), device, pvs,
        c: geo[0], r: geo[1], city: geo[2], lat: geo[3], lon: geo[4] });
      nVis++;
      const pvId = id();
      ins.pv.run(pvId, vid, page.id, page.path, t, engaged, Math.min(100, Math.floor(rnd() * 120)), t + engaged);
      if (pvs === 2) {
        const other = page === home ? ff : home;
        ins.pv.run(id(), vid, other.id, other.path, t + engaged, Math.floor(rnd() * 50000), Math.floor(rnd() * 100), t + engaged);
      }
      const converte = rnd() < chance * (device === 'computador' ? 1.3 : 1);
      if (converte || rnd() < chance * 0.8) {
        const kind = rnd() < 0.7 ? 'whatsapp' : 'formulario';
        ins.click.run(pvId, vid, page.id, page.path, kind, kind === 'whatsapp' ? 'Agendar pelo WhatsApp' : 'Enviar', kind === 'whatsapp' ? 'wa.me' : '#form', t + engaged - 2000);
      }
      if (converte) {
        nLead++;
        ins.lead.run({ name: `${NOMES[Math.floor(rnd() * NOMES.length)]} (demo)`, phone: '61900000000', url: `https://draglazi.localhost${page.path}`, t: t + engaged,
          page_id: page.id, path: page.path, visit_id: vid, visitor_id: visitor, ...v, channel: channelOf(v), device,
          c: geo[0], r: geo[1], city: geo[2], lat: geo[3], lon: geo[4] });
      }
    }
  }
})();
console.log(`demonstração pronta: ${nVis} visitas, ${nLead} leads em ${DATA_DIR}`);
