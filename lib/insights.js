import fs from 'node:fs';
import { domainToASCII } from 'node:url';
import { TLDS } from './tlds.js';
import { CHANNELS, CONTACT_KINDS, CLICK_KINDS } from './tracking.js';
import { TZ_OFFSET } from './stats.js';
import { countryName, ufOf } from './geo.js';

// ── Dados agregados para o Mapa e para a Central de Inteligência ───────────
// Mesmas regras dos números do painel: visitas que viram as páginas escolhidas no
// período, testes (?lpm=test) fora, "contato" = visita que clicou em WhatsApp,
// formulário, telefone ou e-mail, conversão = visita que virou lead.

const IN = 'SELECT value FROM json_each(?)';
const CONTACT = JSON.stringify(CONTACT_KINDS);
const DAY = 86400000;
const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const DEVICES = { celular: 'Celular', computador: 'Computador', tablet: 'Tablet' };

const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const secs = (ms) => (ms == null ? null : Math.round(ms / 1000));

// Textos que chegam por links, cliques e endereços de entrada (UTM, rótulo do clique,
// caminho) podem ser escritos por qualquer pessoa. No pacote para a IA (só nele: a tela
// mostra o valor como ele é) endereço não chega inteiro: o ponto vira "[.]" e o ":" vira
// "[:]", então o valor continua legível, mas não dá para abrir nem citar. Caracteres
// invisíveis saem, controles viram espaço e < > ` viram ‹ › '. Conta como endereço o que tem
// esquema (https://, hxxps://), "//", "www.", IP ou um nome com ponto cuja última parte é
// um domínio de verdade (lista da IANA em lib/tlds.js): "bsb.search.botox", "Dra.Ana" e
// "Botox.DF" ficam como estão. Letra larga, ponto ideográfico e %2e também revelam
// endereço, inclusive em %XX (%E3%80%82 é o ponto ideográfico). Esquema especial (https:, ftp:, ws:)
// conta mesmo sem as barras e grudado em qualquer coisa, como o navegador aceita; barras antes
// de um IP em número ("//1249710593") são quebradas; IP escrito de outro jeito ("74.125.18.0x1",
// "-74.125.18.1") conta como IP.
// Custo linear: o valor é cortado no tamanho máximo antes da busca (e de novo depois da forma
// normalizada, que pode crescer), e cada parte da expressão só começa no início de uma palavra.
const INVISIVEL = /\p{Default_Ignorable_Code_Point}/gu;
const CONTROLE = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const MARCA = { '<': '‹', '>': '›', '`': "'" };
const R = '[\\p{L}\\p{M}\\p{N}_-]'; // caractere de um nome de site (com acento e marca combinante)
const ENDERECO = new RegExp([
  '(?<![a-z])(?:https?|wss?|ftp):\\S*', // esquema especial: com ou sem barras ("https:1249710593"), depois de "-", "." ou número
  '(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,30}:\\/\\/\\S*', // outro esquema (hxxps://)
  '\\b(?:javascript|vbscript|file):\\S+',
  '\\bdata:[a-z]+\\/\\S*', // data:text/html... (não pega "Data:04/12")
  '[\\/\\\\]{2}\\S+', // sem esquema: //site.com (ou com barra invertida)
  '\\bwww\\d*\\.\\S+',
  // IPv4 (grudado num nome, "10.0.0.1clinica.com", fica para o nome com ponto)
  '(?<![\\p{N}.])\\d{1,3}(?:\\.\\d{1,3}){3}(?!\\.?\\p{N})(?![\\p{L}\\p{M}_-])(?::\\d{1,5})?(?:[/?#]\\S*)?',
  '(\\[[0-9a-f:.]{2,45}\\])', // IPv6 entre colchetes: só com dois ":" ou mais ("[08:00]" fica)
  `(?<!${R})(${R}+(?:\\.${R}+)+)`, // nome com ponto: endereço se a última parte for domínio de verdade
].join('|'), 'giu');
// a última parte é um domínio de verdade, também com "-", "_", acento solto ou letra modificadora
// grudados no fim ("evil.com-", "evil.com_"): quem lê ainda vê evil.com
function dominio(nome) {
  const fim = nome.slice(nome.lastIndexOf('.') + 1);
  const limpo = fim.replace(/[-_\p{M}\p{Lm}]+$/u, '');
  return tld(fim) || (limpo !== fim && tld(limpo));
}
function tld(fim) {
  if (!fim) return false;
  if (TLDS.has(fim.toLowerCase())) return true;
  if (/^[\x00-\x7f]*$/.test(fim)) return false;
  // terminação em outro alfabeto ou em letra larga (рф, ｃｏｍ): confere pela forma do IDNA
  const a = domainToASCII('x.' + fim);
  return !!a && TLDS.has(a.slice(a.lastIndexOf('.') + 1));
}
// "[.]" e "[:]" que já estão no texto ficam como estão
const desarma = (m) => m.replace(/\[[.:]\]|[.:]/g, (x) => (x.length > 1 ? x : `[${x}]`));
// Barras seguidas de um site que o navegador lê como IP (número, 0x…, [IPv6]) ou de nada
// ("////1249710593"): "//1249710593/x" abre mesmo com o esquema desarmado. O site é o que vem
// depois do último "@" (antes dele é usuário e senha), sem a porta. Cada sequência de barras é
// olhada, e todas as barras depois da primeira ficam entre colchetes ("/[/][/]"), para a forma
// normalizada não achar duas juntas de novo. "GS//Botox//BSB" fica como está.
const quebraBarras = (d) => d.replace(/([\/\\]{2,})([^\/\\?#\s]*)/g, (x, barras, auth) => {
  const host = auth.slice(auth.lastIndexOf('@') + 1).replace(/(?:\[:\]|:)\d*$/, '');
  return host === '' || /^(?:0x[0-9a-f]*|\d+|\[.*)$/i.test(host) ? barras[0] + barras.slice(1).replace(/./g, '[$&]') + auth : x;
});
// esquema especial grudado em qualquer coisa ("a.https:", "xhttps:", "https:1249710593"): a palavra
// inteira depois dele é endereço e é desarmada antes da busca ("https:evil.com-" -> "https[:]evil[.]com-").
// Custo: "News:Botox", sem espaço, vira "News[:]Botox".
const esquema = (x) => x.replace(/(?:https?|wss?|ftp):(?=\S)\S*/gi, (m) => quebraBarras(desarma(m)));
// nome com ponto que contém um IP que o navegador lê ("-74.125.18.1", "IP_74.125.18.1",
// "ip.74.125.18.1", "74.125.18.0x1", "0112.0175.0022.01", "74.125.18.1-"). Versão fica:
// "2.0.1.3-beta", "v2.0.1.3", "74.125.18.1a" e "1.2.3.4.5" não são IP.
function ip4(nome) {
  const s = nome.normalize('NFKC').replace(/\p{M}/gu, '');
  for (const m of s.matchAll(/(?<![\p{L}\p{N}]|\p{N}\.)(?:0x[0-9a-f]*|\d+)(?:\.(?:0x[0-9a-f]*|\d+)){3}(?![-_]*[\p{L}\p{N}]|\.\p{N})/giu)) {
    try { if (/^\d+(?:\.\d+){3}$/.test(new URL('http://' + m[0]).hostname)) return true; } catch (_) {}
  }
  return false;
}
function troca(m, v6, nome) {
  if (v6 !== undefined) {
    // IPv6 só com dois ":" ou mais ("[08:00]" fica); entre colchetes também pode vir um nome ou IP
    // com ponto que só tem letras de "a" a "f" ("[cafe.de]", "[74.125.18.1]", "[cafe.de:443]",
    // "[cafe.de.]"): cada parte entre ":" é olhada sem os pontos do fim
    const partes = v6.slice(1, -1).split(':').map((p) => p.replace(/\.+$/, ''));
    return v6.split(':').length > 2 || partes.some((p) => p.includes('.') && (dominio(p) || ip4(p))) ? desarma(m) : m;
  }
  if (nome !== undefined) return dominio(nome) || ip4(nome) ? desarma(m) : m;
  return quebraBarras(desarma(m));
}
const temEndereco = (x) => {
  if (esquema(x) !== x) return true;
  for (const a of x.matchAll(ENDERECO)) if (troca(a[0], a[1], a[2]) !== a[0]) return true;
  return false;
};
// %XX em sequência vira o texto (UTF-8; byte inválido vira �), duas vezes por causa do %25
const utf8 = new TextDecoder();
const pct = (x) => x.replace(/(?:%[0-9a-f]{2})+/gi, (r) => utf8.decode(Uint8Array.from(r.match(/%[0-9a-f]{2}/gi), (h) => parseInt(h.slice(1), 16))));
// < > ` que a forma normalizada traz de volta (%3C, letra larga) viram ‹ › ' como no original
const normal = (x) => pct(pct(x)).normalize('NFKC').replace(INVISIVEL, '').replace(CONTROLE, ' ')
  .replace(/[。．｡]/g, '.').replace(/[<>`]/g, (c) => MARCA[c]).replace(/\s+/g, ' ').trim();
export function livre(s, max = 80) {
  let t = String(s == null ? '' : s).replace(INVISIVEL, '').replace(CONTROLE, ' ').replace(/[<>`]/g, (c) => MARCA[c])
    .replace(/\s+/g, ' ').trim();
  if (!t) return t;
  let corte = '';
  if (t.length > max) { t = t.slice(0, max - 1).replace(/[\ud800-\udbff]$/, '').trimEnd(); corte = '…'; }
  let d = esquema(t).replace(ENDERECO, troca);
  // letra larga (ｈｔｔｐｓ), ponto ideográfico e %2e: se a forma normalizada do texto já desarmado
  // ainda mostra endereço, havia um escondido, e o valor vai normalizado (e desarmado). A forma
  // normalizada pode crescer muito (um "ﷺ" vira 18 letras): é cortada de novo no máximo.
  let n = normal(d);
  if (n !== d && temEndereco(n)) {
    if (n.length > max) { n = n.slice(0, max - 1).replace(/[\ud800-\udbff]$/, '').trimEnd(); corte = '…'; }
    d = esquema(n).replace(ENDERECO, troca);
  }
  return d + corte;
}
// o mesmo valor se repete em vários lugares do pacote: cada valor é limpo uma vez só
function limpador() {
  const memo = new Map();
  return (x, max = 80) => {
    if (x == null || x === '') return '';
    const k = max + '\u0000' + x;
    let r = memo.get(k);
    if (r === undefined) { r = livre(x, max); memo.set(k, r); }
    return r;
  };
}

function hostOfUrl(u) {
  try { return new URL(u).host; } catch (_) { return ''; }
}

export function placeLabel(c, r, city) {
  if (!c) return 'Sem localização';
  if (c !== 'BR') return [city, countryName(c)].filter(Boolean).join(', ');
  const uf = ufOf(r);
  return city ? `${city}${uf ? ' · ' + uf : ''}` : (r || 'Brasil');
}

export function makeInsights(db) {
  // Mesma regra do painel (stats.js): a visita conta se viu uma das páginas no período;
  // contato e lead só contam se aconteceram nessas páginas, no período, nessa visita.
  const IDS = 'SELECT value FROM json_each(@ids)';
  const visitsIn = `SELECT DISTINCT visit_id FROM pageviews WHERE page_id IN (${IDS}) AND ts >= @from AND ts < @to`;
  const contactOf = (alias) => `EXISTS (SELECT 1 FROM clicks c WHERE c.visit_id = ${alias}.id AND c.page_id IN (${IDS})
      AND c.ts >= @from AND c.ts < @to AND c.kind IN (SELECT value FROM json_each(@contact)))`;
  // a visita do lead viu uma das páginas no período (busca pela visita, com o índice dela)
  const measuredVisit = (alias) => `SELECT 1 FROM pageviews pv INDEXED BY idx_pv_visit JOIN visits v ON v.id = pv.visit_id
      WHERE pv.visit_id = ${alias}.visit_id AND v.test = 0 AND pv.page_id IN (${IDS}) AND pv.ts >= @from AND pv.ts < @to`;
  const leadOf = (alias) => `EXISTS (SELECT 1 FROM leads l WHERE l.visit_id = ${alias}.id AND l.page_id IN (${IDS})
      AND l.created_at >= @from AND l.created_at < @to AND COALESCE(l.test, 0) = 0)`;
  const q = {
    geo: db.prepare(`SELECT COALESCE(v.geo_country, '') AS c, COALESCE(v.geo_region, '') AS r, COALESCE(v.geo_city, '') AS city,
        AVG(v.geo_lat) AS lat, AVG(v.geo_lon) AS lon, v.channel AS ch, COUNT(*) AS visits,
        SUM(${contactOf('v')}) AS contacts, SUM(${leadOf('v')}) AS leads
      FROM visits v WHERE v.test = 0 AND v.id IN (${visitsIn}) AND (@ch = '' OR v.channel = @ch)
      GROUP BY c, r, city, ch`),
    // leads do período que não vieram de uma visita medida nessas páginas (script bloqueado,
    // leads antigos): ficam fora da conta por cidade e da taxa, contados à parte
    geoUntracked: db.prepare(`SELECT COUNT(*) AS n FROM leads l
      WHERE l.page_id IN (${IDS}) AND l.created_at >= @from AND l.created_at < @to AND COALESCE(l.test, 0) = 0
        AND (@ch = '' OR COALESCE(l.channel, 'outros') = @ch)
        AND NOT EXISTS (SELECT 1 FROM visits v WHERE v.id = l.visit_id AND v.test = 1)
        AND NOT EXISTS (${measuredVisit('l')})`),

    // ── para a IA ──
    byVisit: db.prepare(`SELECT v.slug AS slug, v.channel AS ch, v.source AS src, v.medium AS med, COALESCE(v.campaign, '') AS camp,
        COALESCE(v.term, '') AS term, COALESCE(v.content, '') AS content, COALESCE(v.device, '') AS dev,
        COALESCE(v.geo_country, '') AS c, COALESCE(v.geo_region, '') AS r, COALESCE(v.geo_city, '') AS city,
        v.started_at AS t, v.landing_path AS landing, v.referrer AS ref, v.is_new AS is_new,
        (SELECT MAX(pv.engaged_ms) FROM pageviews pv WHERE pv.visit_id = v.id AND pv.page_id IN (${IDS}) AND pv.ts >= @from AND pv.ts < @to) AS eng,
        (SELECT MAX(pv.max_scroll) FROM pageviews pv WHERE pv.visit_id = v.id AND pv.page_id IN (${IDS}) AND pv.ts >= @from AND pv.ts < @to) AS scroll,
        ${contactOf('v')} AS contact,
        ${leadOf('v')} AS lead
      FROM visits v WHERE v.test = 0 AND v.id IN (${visitsIn})`),
    untrackedLeads: db.prepare(`SELECT COUNT(*) AS n FROM leads l
      WHERE l.page_id IN (${IDS}) AND l.created_at >= @from AND l.created_at < @to AND COALESCE(l.test, 0) = 0
        AND NOT EXISTS (SELECT 1 FROM visits v WHERE v.id = l.visit_id AND v.test = 1)
        AND NOT EXISTS (${measuredVisit('l')})`),
    pageStats: db.prepare(`SELECT pv.page_id AS id, COUNT(DISTINCT pv.visit_id) AS visits, AVG(pv.engaged_ms) AS eng, AVG(pv.max_scroll) AS scroll,
        AVG(pv.max_scroll >= 90) AS read_end
      FROM pageviews pv JOIN visits v ON v.id = pv.visit_id
      WHERE pv.page_id IN (${IDS}) AND pv.ts >= @from AND pv.ts < @to AND v.test = 0 GROUP BY pv.page_id`),
    // por página: visitas que viram ESTA página no período e clicaram em contato / viraram lead nela
    pageContacts: db.prepare(`SELECT c.page_id AS id, COUNT(DISTINCT c.visit_id) AS n FROM clicks c JOIN visits v ON v.id = c.visit_id
      WHERE c.page_id IN (${IDS}) AND c.ts >= @from AND c.ts < @to AND c.kind IN (SELECT value FROM json_each(@contact)) AND v.test = 0
        AND EXISTS (SELECT 1 FROM pageviews pv INDEXED BY idx_pv_visit
          WHERE pv.visit_id = c.visit_id AND pv.page_id = c.page_id AND pv.ts >= @from AND pv.ts < @to)
      GROUP BY c.page_id`),
    pageLeads: db.prepare(`SELECT l.page_id AS id, COUNT(DISTINCT l.visit_id) AS n FROM leads l
      WHERE l.page_id IN (${IDS}) AND l.created_at >= @from AND l.created_at < @to AND COALESCE(l.test, 0) = 0
        AND EXISTS (SELECT 1 FROM pageviews pv INDEXED BY idx_pv_visit JOIN visits v ON v.id = pv.visit_id
          WHERE pv.visit_id = l.visit_id AND pv.page_id = l.page_id AND pv.ts >= @from AND pv.ts < @to AND v.test = 0)
      GROUP BY l.page_id`),
    topClicks: db.prepare(`SELECT c.kind, c.label, COUNT(DISTINCT c.visit_id) AS visits
      FROM clicks c JOIN visits v ON v.id = c.visit_id
      WHERE c.page_id IN (${IDS}) AND c.ts >= @from AND c.ts < @to AND v.test = 0
      GROUP BY c.kind, c.label ORDER BY visits DESC LIMIT 20`),
  };

  // ── Mapa ──────────────────────────────────────────────────────────────────
  function geo(pageIds, from, to, channel = '') {
    const args = { ids: JSON.stringify(pageIds), from, to, contact: CONTACT, ch: channel || '' };
    const places = new Map();
    const channels = {};
    for (const x of q.geo.all(args)) {
      const key = `${x.c}|${x.r}|${x.city}`;
      let p = places.get(key);
      if (!p) {
        p = { key, country: x.c, region: x.r, city: x.city, label: placeLabel(x.c, x.r, x.city), lat: null, lon: null, wsum: 0,
          visits: 0, contacts: 0, leads: 0, channels: {} };
        places.set(key, p);
      }
      // centro da cidade: média ponderada pelas visitas que têm coordenada
      if (x.lat != null && x.lon != null) {
        p.lat = ((p.lat || 0) * p.wsum + x.lat * x.visits) / (p.wsum + x.visits);
        p.lon = ((p.lon || 0) * p.wsum + x.lon * x.visits) / (p.wsum + x.visits);
        p.wsum += x.visits;
      }
      p.visits += x.visits; p.contacts += x.contacts || 0; p.leads += x.leads || 0;
      const c = p.channels[x.ch] || (p.channels[x.ch] = { visits: 0, contacts: 0, leads: 0 });
      c.visits += x.visits; c.contacts += x.contacts || 0; c.leads += x.leads || 0;
      // visitas por canal, inclusive as sem cidade (são os números dos filtros)
      channels[x.ch] = (channels[x.ch] || 0) + x.visits;
    }

    const unknown = { visits: 0, contacts: 0, leads: 0 };
    const located = [];
    for (const p of places.values()) {
      delete p.wsum;
      if (!p.country || p.lat == null) { unknown.visits += p.visits; unknown.contacts += p.contacts; unknown.leads += p.leads; continue; }
      p.lat = Math.round(p.lat * 1000) / 1000;
      p.lon = Math.round(p.lon * 1000) / 1000;
      p.rate = rate(p.leads, p.visits);
      const top = Object.entries(p.channels).sort((a, b) => b[1].visits - a[1].visits)[0];
      p.topChannel = top ? top[0] : null;
      located.push(p);
    }
    located.sort((a, b) => b.visits - a.visits || b.leads - a.leads);

    // estados (e países fora do Brasil)
    const regions = new Map();
    for (const p of located) {
      const key = p.country === 'BR' ? `BR|${p.region}` : p.country;
      const label = p.country === 'BR' ? (p.region || 'Brasil') : countryName(p.country);
      const r = regions.get(key) || { key, label, uf: p.country === 'BR' ? ufOf(p.region) : '', country: p.country, visits: 0, contacts: 0, leads: 0, cities: 0 };
      r.visits += p.visits; r.contacts += p.contacts; r.leads += p.leads; r.cities++;
      regions.set(key, r);
    }
    const regionList = [...regions.values()].sort((a, b) => b.visits - a.visits);
    for (const r of regionList) r.rate = rate(r.leads, r.visits);

    const totals = located.reduce((t, p) => ({ visits: t.visits + p.visits, contacts: t.contacts + p.contacts, leads: t.leads + p.leads }),
      { visits: 0, contacts: 0, leads: 0 });
    totals.visits += unknown.visits; totals.contacts += unknown.contacts; totals.leads += unknown.leads;
    return { points: located, regions: regionList, unknown, totals, channels, untracked: q.geoUntracked.get(args).n };
  }

  // ── Pacote de dados para a IA ────────────────────────────────────────────
  // paraIa: limpa os textos que qualquer pessoa pode escrever (UTM, cliques, caminho). A tela
  // da Central chama sem isso e mostra os valores como eles são (o EJS já escapa o HTML).
  // A contagem é sempre pelo valor como foi gravado (os números são os da tela); só os nomes
  // que entram no pacote são limpos, então valor inventado aos milhares não pesa na conta.
  function forAi({ pages, from, to, prevFrom, prevTo, siteDirOf, paraIa = false }) {
    const pageIds = pages.map((p) => p.id);
    const ids = JSON.stringify(pageIds);
    const args = { ids, from, to, contact: CONTACT };
    const txt = paraIa ? limpador() : (x) => (x == null ? '' : String(x));
    const prep = (v) => ({ ...v, src: v.src || '', med: v.med || '' });
    const rows = q.byVisit.all(args).map(prep);
    const prevRows = prevFrom != null ? q.byVisit.all({ ...args, from: prevFrom, to: prevTo }).map(prep) : [];

    const group = (list, keyFn) => {
      const m = new Map();
      for (const v of list) {
        const k = keyFn(v);
        if (k == null) continue;
        let g = m.get(k);
        if (!g) { g = { k, visitas: 0, contatos: 0, leads: 0, _eng: 0, _engN: 0, _mob: 0, _new: 0, _sub: {} }; m.set(k, g); }
        g.visitas++; g.contatos += v.contact ? 1 : 0; g.leads += v.lead ? 1 : 0;
        if (v.eng != null) { g._eng += v.eng; g._engN++; }
        if (v.dev === 'celular') g._mob++;
        if (v.is_new) g._new++;
      }
      return [...m.values()].map((g) => {
        const out = { ...g, taxa_lead_pct: rate(g.leads, g.visitas), taxa_contato_pct: rate(g.contatos, g.visitas),
          tempo_medio_s: g._engN ? secs(g._eng / g._engN) : null, celular_pct: rate(g._mob, g.visitas) };
        delete out._eng; delete out._engN; delete out._mob; delete out._new; delete out._sub;
        return out;
      }).sort((a, b) => b.visitas - a.visitas || b.leads - a.leads);
    };
    const named = (arr, name, n) => arr.slice(0, n).map(({ k, ...r }) => ({ [name]: k, ...r }));
    const topOf = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

    const totalOf = (list) => {
      const t = { visitas: list.length, contatos: 0, leads: 0 };
      for (const v of list) { t.contatos += v.contact ? 1 : 0; t.leads += v.lead ? 1 : 0; }
      t.taxa_lead_pct = rate(t.leads, t.visitas);
      t.taxa_contato_pct = rate(t.contatos, t.visitas);
      return t;
    };

    const ads = rows.filter((v) => v.ch === 'google_ads');
    const prevAds = prevRows.filter((v) => v.ch === 'google_ads');
    const prevTerms = new Map(group(prevAds, (v) => v.term || '(sem palavra-chave)').map((g) => [g.k, g]));
    // nome da página pelo site e caminho (o "/" de cada site é uma página diferente); página
    // fora da seleção vai como endereço com o domínio do site (o caminho pode ter sido inventado)
    const pagePath = new Map(pages.map((p) => [`${p.slug}|${p.path}`, p.name]));
    const siteHost = new Map(pages.map((p) => [p.slug, hostOfUrl(p.url)]));
    const caminhos = new Map(); // endereço de página fora da seleção -> [domínio do site, caminho]
    const pageName = (v) => {
      if (!v.landing) return '';
      const n = pagePath.get(`${v.slug}|${v.landing}`);
      if (n) return n;
      const h = siteHost.get(v.slug);
      const nome = h ? `https://${h}${v.landing}` : v.landing;
      if (paraIa && !caminhos.has(nome)) caminhos.set(nome, [h, v.landing]);
      return nome;
    };
    // no pacote da IA o caminho (que qualquer pessoa inventa) vai limpo; o domínio é o do site
    const paginaIa = (nome) => {
      const x = paraIa ? caminhos.get(nome) : null;
      if (!x) return nome;
      const c = x[1] === '/' ? '/' : txt(x[1], 100);
      return x[0] ? `https://${x[0]}${c}` : c;
    };
    const origens = new Map(); // "origem / mídia" -> [origem, mídia]
    const origemDe = (v) => {
      const k = `${v.src} / ${v.med}`;
      if (paraIa && !origens.has(k)) origens.set(k, [v.src, v.med]);
      return k;
    };
    const origemIa = (k) => {
      const x = paraIa ? origens.get(k) : null;
      return x ? `${txt(x[0], 60)} / ${txt(x[1], 60)}` : k;
    };
    // troca o nome de cada linha pelo nome limpo (no pacote da IA)
    const rotulo = (list, campo, f) => (paraIa ? list.map((o) => ({ ...o, [campo]: f(o[campo]) })) : list);

    const termos = group(ads, (v) => v.term || '(sem palavra-chave)');
    // campanhas, páginas de entrada e cidades de cada palavra-chave
    const det = new Map();
    for (const v of ads) {
      const k = v.term || '(sem palavra-chave)';
      const d = det.get(k) || { camps: {}, land: {}, cities: {} };
      d.camps[v.camp || '(sem campanha)'] = (d.camps[v.camp || '(sem campanha)'] || 0) + 1;
      const lp = pageName(v);
      d.land[lp] = (d.land[lp] || 0) + 1;
      if (v.c) { const pl = placeLabel(v.c, v.r, v.city); d.cities[pl] = (d.cities[pl] || 0) + 1; }
      det.set(k, d);
    }
    const palavras = termos.slice(0, 150).map((g) => {
      const d = det.get(g.k) || { camps: {}, land: {}, cities: {} };
      const p = prevTerms.get(g.k);
      const { k, ...r } = g;
      return { palavra_chave: txt(k, 80), ...r, campanhas: topOf(d.camps, 3).map((x) => txt(x, 120)),
        paginas_de_entrada: topOf(d.land, 2).map(paginaIa), cidades_principais: topOf(d.cities, 3),
        periodo_anterior: p ? { visitas: p.visitas, leads: p.leads } : { visitas: 0, leads: 0 } };
    });

    const cidades = group(rows.filter((v) => v.c), (v) => placeLabel(v.c, v.r, v.city));
    // visitas e leads de cada canal em cada cidade
    const cityCh = new Map();
    for (const v of rows) {
      if (!v.c) continue;
      const k = placeLabel(v.c, v.r, v.city);
      const m = cityCh.get(k) || {};
      const nome = CHANNELS[v.ch] || v.ch;
      const c = m[nome] || (m[nome] = { visitas: 0, leads: 0 });
      c.visitas++; c.leads += v.lead ? 1 : 0;
      cityCh.set(k, m);
    }

    const hora = (t) => new Date(t + TZ_OFFSET).getUTCHours();
    const dia = (t) => WEEKDAYS[new Date(t + TZ_OFFSET).getUTCDay()];
    const semanas = (to - from) / (7 * DAY);

    // páginas
    const ps = new Map(q.pageStats.all(args).map((r) => [r.id, r]));
    const pc = new Map(q.pageContacts.all(args).map((r) => [r.id, r.n]));
    const pl = new Map(q.pageLeads.all(args).map((r) => [r.id, r.n]));
    const paginas = pages.map((p) => {
      const s = ps.get(p.id) || {};
      return {
        nome: p.name, endereco: p.url, visitas: s.visits || 0, contatos: pc.get(p.id) || 0, leads: pl.get(p.id) || 0,
        taxa_lead_pct: rate(pl.get(p.id) || 0, s.visits || 0), tempo_medio_s: s.eng != null ? secs(s.eng) : null,
        rolagem_media_pct: s.scroll != null ? Math.round(s.scroll) : null, leram_ate_o_fim_pct: s.read_end != null ? Math.round(s.read_end * 100) : null,
        conteudo: siteDirOf ? pageText(siteDirOf(p), p.file) : '',
      };
    });

    const untracked = q.untrackedLeads.get(args).n;
    const iso = (t) => new Date(t + TZ_OFFSET).toISOString().slice(0, 10);
    const horas = (list) => named(group(list, (v) => hora(v.t)), 'hora', 24).sort((a, b) => a.hora - b.hora)
      .map((h) => ({ hora: `${String(h.hora).padStart(2, '0')}h`, visitas: h.visitas, contatos: h.contatos, leads: h.leads }));
    return {
      // o dia em andamento conta como um dia
      periodo: { dias: Math.ceil((to - from) / DAY), de: iso(from), ate: iso(to - 1) },
      periodo_anterior: prevFrom != null ? { dias: Math.ceil((prevTo - prevFrom) / DAY), de: iso(prevFrom), ate: iso(prevTo - 1) } : null,
      totais: totalOf(rows),
      totais_periodo_anterior: prevRows.length ? totalOf(prevRows) : null,
      leads_sem_visita_medida: untracked,
      canais: named(group(rows, (v) => CHANNELS[v.ch] || v.ch), 'canal', 20),
      google_ads: {
        totais: totalOf(ads),
        totais_periodo_anterior: prevAds.length ? totalOf(prevAds) : null,
        campanhas: rotulo(named(group(ads, (v) => v.camp || '(sem campanha)'), 'campanha', 30), 'campanha', (x) => txt(x, 120)),
        palavras_chave: palavras,
        palavras_chave_omitidas: Math.max(0, termos.length - 150),
        anuncios: rotulo(named(group(ads.filter((v) => v.content), (v) => v.content), 'anuncio_utm_content', 25), 'anuncio_utm_content', (x) => txt(x, 80)),
        aparelhos: named(group(ads, (v) => DEVICES[v.dev] || 'Não identificado'), 'aparelho', 5),
        cidades: named(group(ads.filter((v) => v.c), (v) => placeLabel(v.c, v.r, v.city)), 'cidade', 20),
        horas_do_dia: horas(ads),
        dias_da_semana: named(group(ads, (v) => dia(v.t)), 'dia', 7),
      },
      busca_organica: {
        totais: totalOf(rows.filter((v) => v.ch === 'busca')),
        buscadores: rotulo(named(group(rows.filter((v) => v.ch === 'busca'), (v) => v.src), 'buscador', 10), 'buscador', (x) => txt(x, 60)),
        paginas_de_entrada: rotulo(named(group(rows.filter((v) => v.ch === 'busca'), pageName), 'pagina', 10), 'pagina', paginaIa),
        observacao: 'O Google não informa ao site o que a pessoa pesquisou na busca orgânica; aqui só há o buscador e a página de entrada.',
      },
      outras_origens: rotulo(named(group(rows.filter((v) => !['google_ads', 'busca', 'direto'].includes(v.ch)), origemDe), 'origem', 20), 'origem', origemIa),
      localizacao: {
        cidades: named(cidades, 'cidade', 30).map((c) => ({ ...c, canais: cityCh.get(c.cidade) || {} })),
        estados_e_paises: named(group(rows.filter((v) => v.c), (v) => (v.c === 'BR' ? (v.r || 'Brasil') : countryName(v.c))), 'local', 20),
        sem_localizacao: rows.filter((v) => !v.c).length,
        observacao: 'Cidade aproximada pela conexão de internet (base DB-IP). Pessoas de cidades vizinhas podem aparecer na cidade da operadora.',
      },
      aparelhos: named(group(rows, (v) => DEVICES[v.dev] || 'Não identificado'), 'aparelho', 5),
      dias_da_semana: named(group(rows, (v) => dia(v.t)), 'dia', 7),
      horas_do_dia: horas(rows),
      // só com uma semana ou mais (o dia em andamento conta), sem arredondar o número de semanas
      media_semanal: semanas >= 6 / 7
        ? { visitas: Math.round(rows.length / semanas), leads: Math.round(rows.filter((v) => v.lead).length / semanas * 10) / 10 }
        : null,
      paginas,
      cliques_mais_comuns: q.topClicks.all(args).map((c) => ({ tipo: CLICK_KINDS[c.kind] || c.kind, texto: txt(c.label || '', 90), visitas: c.visits })),
    };
  }

  return { geo, forAi, _q: q }; // _q: testes (planos de consulta)
}

// Texto visível de uma página publicada (título, descrição, títulos e o começo do
// texto), para a IA saber o que a página oferece. Sem scripts, estilos e marcação.
export function pageText(dir, file, max = 3500) {
  if (!dir || !file) return '';
  let html = '';
  try { html = fs.readFileSync(`${dir}/${file}`, 'utf8'); } catch (_) { return ''; }
  const dec = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '';
  const desc = (/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html) || [])[1] || '';
  let body = html.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const heads = [...body.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => dec(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()).filter(Boolean);
  const text = dec(body.replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|li|h\d|div|section|a|button)>/gi, '. ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').replace(/(\.\s*){2,}/g, '. ').trim();
  const out = [`Título: ${dec(title).trim()}`, desc ? `Descrição: ${dec(desc).trim()}` : '', heads.length ? `Títulos da página: ${heads.slice(0, 30).join(' | ')}` : '', `Texto: ${text}`]
    .filter(Boolean).join('\n');
  return out.slice(0, max);
}
