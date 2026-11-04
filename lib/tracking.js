import crypto from 'node:crypto';
import { normalizePath, pathOfUrl } from './pages.js';

// ── Medição própria das páginas ──────────────────────────────────────────────
// O servidor injeta /_lpm/t.js em todo HTML servido nos domínios das páginas. O
// script manda três tipos de evento para /_lpm/e: visualização (pv), tempo e
// rolagem (ping) e clique (c). Nada vai para terceiros; o visitante é um número
// aleatório num cookie próprio, HttpOnly, de 13 meses no máximo, que não é renovado
// a cada visita. Com Sec-GPC ou DNT ligado o cookie vale só até fechar o navegador.
//
// Regras de atribuição (as mesmas do Google Analytics):
// - visita = sequência de acessos sem 30 minutos parados; um link com outra
//   campanha (UTM ou gclid diferente) abre visita nova;
// - origem da visita: UTM > identificador de clique (gclid, fbclid...) > site de onde
//   veio > direto;
// - visita direta herda a última origem não direta do mesmo visitante nos últimos
//   90 dias ("último clique não direto"), para o retorno de quem veio por anúncio
//   não virar "direto";
// - o lead leva a origem da visita em que converteu e o primeiro contato do visitante.

export const VISIT_GAP = 30 * 60 * 1000;
export const LOOKBACK = 90 * 24 * 3600 * 1000;
const VISITOR_MAX_AGE = 395 * 24 * 3600; // segundos (13 meses)
const MAX_ENGAGED = 4 * 3600 * 1000;

export const CHANNELS = {
  google_ads: 'Google Ads',
  meta_ads: 'Anúncios Instagram/Facebook',
  outros_anuncios: 'Outros anúncios',
  busca: 'Busca orgânica',
  social: 'Redes sociais',
  ia: 'Assistentes de IA',
  email: 'E-mail',
  whatsapp: 'WhatsApp',
  sites: 'Outros sites',
  direto: 'Direto',
  outros: 'Outras origens',
};

export const CLICK_KINDS = {
  whatsapp: 'WhatsApp',
  formulario: 'Formulário',
  telefone: 'Telefone',
  email: 'E-mail',
  instagram: 'Instagram',
  facebook: 'Facebook',
  mapa: 'Mapa',
  avaliacoes: 'Perfil no Google',
  'link-interno': 'Link para outra página',
  'link-externo': 'Link externo',
  cta: 'Botão que leva ao formulário',
  navegacao: 'Menu e âncoras',
  faq: 'Pergunta frequente',
  botao: 'Outro botão',
};
// cliques que mostram intenção de contato (contam no indicador "Cliques")
export const CONTACT_KINDS = ['whatsapp', 'formulario', 'telefone', 'email'];

const CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid', 'li_fat_id', 'twclid'];
const PAID = /^(cpc|ppc|paid|paid[-_ ]?search|paidsearch|paid[-_ ]?social|paidsocial|cpm|cpv|cpa|display|banner|ads?|anuncios?|an[uú]ncio|retargeting|remarketing)$/;
const SOCIAL_MEDIUM = /^(social|social[-_ ]?(network|media)|sm|rede[-_ ]?social|redes[-_ ]?sociais|organic[-_ ]?social|bio|stories|story|reels?|post|feed|perfil)$/;
const EMAIL_MEDIUM = /^(e-?mail|newsletter|mail|email[-_ ]?marketing)$/;
const META_SOURCES = /^(facebook|fb|instagram|ig|meta|an|msg|messenger|audience[-_ ]?network|threads)$/;
const SOCIAL_SOURCES = /^(facebook|fb|instagram|ig|threads|youtube|yt|tiktok|linkedin|twitter|x|pinterest|kwai|telegram|snapchat)$/;
const AI_SOURCES = /^(chatgpt|openai|perplexity|gemini|claude|copilot|deepseek|meta[-_ ]?ai|grok)$/;
const SEARCH_SOURCES = /^(google|bing|yahoo|duckduckgo|ecosia|yandex|baidu|brave|startpage)$/;

// site de onde veio -> [origem, mídia]
const REF_RULES = [
  [/(^|\.)gemini\.google\.com$/, 'gemini', 'ia'],
  [/(^|\.)(chatgpt\.com|chat\.openai\.com)$/, 'chatgpt', 'ia'],
  [/(^|\.)perplexity\.ai$/, 'perplexity', 'ia'],
  [/(^|\.)claude\.ai$/, 'claude', 'ia'],
  [/(^|\.)copilot\.microsoft\.com$/, 'copilot', 'ia'],
  [/(^|\.)chat\.deepseek\.com$/, 'deepseek', 'ia'],
  [/(^|\.)meta\.ai$/, 'meta-ai', 'ia'],
  [/(^|\.)grok\.com$/, 'grok', 'ia'],
  [/(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|syndicatedsearch\.goog)$/, 'google', 'display'],
  [/(^|\.)google(\.[a-z]{2,3}){1,2}$/, 'google', 'organic'],
  [/(^|\.)bing\.com$/, 'bing', 'organic'],
  [/(^|\.)yahoo\.com$/, 'yahoo', 'organic'],
  [/(^|\.)duckduckgo\.com$/, 'duckduckgo', 'organic'],
  [/(^|\.)ecosia\.org$/, 'ecosia', 'organic'],
  [/(^|\.)yandex(\.[a-z]{2,3}){1,2}$/, 'yandex', 'organic'],
  [/(^|\.)baidu\.com$/, 'baidu', 'organic'],
  [/^search\.brave\.com$/, 'brave', 'organic'],
  [/(^|\.)instagram\.com$/, 'instagram', 'social'],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, 'facebook', 'social'],
  [/(^|\.)threads\.(net|com)$/, 'threads', 'social'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'youtube', 'social'],
  [/(^|\.)(t\.co|twitter\.com|x\.com)$/, 'x', 'social'],
  [/(^|\.)(linkedin\.com|lnkd\.in)$/, 'linkedin', 'social'],
  [/(^|\.)tiktok\.com$/, 'tiktok', 'social'],
  [/(^|\.)pinterest(\.[a-z]{2,3}){1,2}$/, 'pinterest', 'social'],
  [/(^|\.)(whatsapp\.com|wa\.me)$/, 'whatsapp', 'referral'],
];
// referrer de aplicativo Android (android-app://pacote)
const APP_RULES = {
  'com.google.android.googlequicksearchbox': ['google', 'organic'],
  'com.google.android.gm': ['gmail', 'email'],
  'com.instagram.android': ['instagram', 'social'],
  'com.facebook.katana': ['facebook', 'social'],
  'com.facebook.lite': ['facebook', 'social'],
  'com.whatsapp': ['whatsapp', 'referral'],
  'com.zhiliaoapp.musically': ['tiktok', 'social'],
  'com.linkedin.android': ['linkedin', 'social'],
};

const clean = (v, max = 150) => {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};
const low = (v) => (v ? v.toLowerCase() : v);

export function apexOf(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '');
}

// De onde a pessoa veio (null quando é o próprio site ou não há referrer).
export function referrerFrom(raw, siteApex) {
  if (!raw) return null;
  let u;
  try { u = new URL(String(raw)); } catch (_) { return null; }
  if (u.protocol === 'android-app:') {
    const pkg = u.hostname.toLowerCase();
    const [source, medium] = APP_RULES[pkg] || [pkg, 'referral'];
    return { host: pkg, path: '', source, medium };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = apexOf(u.hostname);
  if (siteApex && (host === siteApex || host.endsWith('.' + siteApex))) return null;
  const pathName = u.pathname.slice(0, 120);
  for (const [re, source, medium] of REF_RULES) if (re.test(host)) return { host, path: pathName, source, medium };
  return { host, path: pathName, source: host, medium: 'referral' };
}

// UTMs e identificadores de clique da URL (null quando a URL não traz campanha).
export function campaignFrom(params, ref) {
  const q = params instanceof URLSearchParams ? params : new URLSearchParams(params || '');
  const utm = {
    source: low(clean(q.get('utm_source'), 100)),
    medium: low(clean(q.get('utm_medium'), 100)),
    campaign: clean(q.get('utm_campaign')),
    term: clean(q.get('utm_term')),
    content: clean(q.get('utm_content')),
  };
  let clickType = null, clickId = null;
  for (const k of CLICK_IDS) {
    const v = clean(q.get(k), 200);
    if (v) { clickType = k; clickId = v; break; }
  }
  // gad_source vem nos anúncios do Google mesmo quando o gclid não chega
  if (!clickType && q.get('gad_source')) { clickType = 'gad'; clickId = clean(q.get('gad_campaignid'), 60); }
  if (!utm.source && !utm.medium && !utm.campaign && !clickType) return null;

  let source = utm.source, medium = utm.medium;
  if (!source) {
    if (clickType === 'gclid' || clickType === 'gbraid' || clickType === 'wbraid' || clickType === 'gad') source = 'google';
    else if (clickType === 'msclkid') source = 'bing';
    else if (clickType === 'ttclid') source = 'tiktok';
    else if (clickType === 'li_fat_id') source = 'linkedin';
    else if (clickType === 'twclid') source = 'x';
    else if (clickType === 'fbclid') source = ref && ref.source === 'instagram' ? 'instagram' : 'facebook';
    else source = (ref && ref.source) || '(sem origem)';
  }
  if (!medium) {
    if (clickType && clickType !== 'fbclid') medium = 'cpc';
    else if (clickType === 'fbclid') medium = 'social'; // o Meta põe fbclid até em post orgânico
    else medium = (ref && ref.medium) || '(não informado)';
  }
  return { source, medium, campaign: utm.campaign, term: utm.term, content: utm.content, click_type: clickType, click_id: clickId };
}

export function channelOf(a) {
  const s = String(a.source || '').toLowerCase();
  const m = String(a.medium || '').toLowerCase();
  const c = a.click_type || '';
  if (c === 'gclid' || c === 'gbraid' || c === 'wbraid' || c === 'gad' || (/^(google|adwords|google[-_ ]?ads)$/.test(s) && PAID.test(m))) return 'google_ads';
  if (META_SOURCES.test(s) && PAID.test(m)) return 'meta_ads';
  if (PAID.test(m) || ['msclkid', 'ttclid', 'li_fat_id', 'twclid'].includes(c)) return 'outros_anuncios';
  if (m === 'organic' || m === 'seo' || (SEARCH_SOURCES.test(s) && m === '(não informado)')) return 'busca';
  if (EMAIL_MEDIUM.test(m) || s === 'email' || s === 'gmail' || s === 'newsletter') return 'email';
  if (/^(whatsapp|wa|zap)$/.test(s) || m === 'whatsapp') return 'whatsapp';
  if (m === 'ia' || m === 'ai' || AI_SOURCES.test(s)) return 'ia';
  if (SOCIAL_MEDIUM.test(m) || SOCIAL_SOURCES.test(s)) return 'social';
  if (m === 'referral') return 'sites';
  if (s === '(direct)') return 'direto';
  return 'outros';
}

export function campaignKey(a) {
  return [a.source, a.medium, a.campaign, a.term, a.content, a.click_id].map((x) => x || '').join('|');
}

export const DIRECT = { source: '(direct)', medium: '(none)', campaign: null, term: null, content: null, click_type: null, click_id: null };

export function deviceOf(ua, touchPoints) {
  const s = String(ua || '');
  if (/iPad|Tablet|PlayBook|Silk|Kindle|Android(?!.*Mobi)/i.test(s)) return 'tablet';
  if (/Mobi|iPhone|iPod|Windows Phone|Opera Mini|IEMobile/i.test(s)) return 'celular';
  if (/Macintosh/i.test(s) && Number(touchPoints) > 1) return 'tablet'; // iPad que se apresenta como Mac
  return 'computador';
}

const BOT_UA = /(?:bot|crawl|crawler|spider|slurp)(?:[\s/;)-]|$)|facebookexternalhit|facebookcatalog|meta-externalagent|^whatsapp\/|telegrambot|discordbot|slackbot|skypeuripreview|preview|headless|lighthouse|pagespeed|gtmetrix|pingdom|uptime|curl\/|wget\/|python|httpclient|java\/|go-http|axios|node-fetch|undici|okhttp|scrapy|phantomjs|selenium|puppeteer|playwright|adsbot|mediapartners|google-inspectiontool|google-read-aloud|feedfetcher|apis-google|duplexweb|storebot|ahrefs|semrush|mj12|petalbot|bytespider|gptbot|chatgpt-user|oai-searchbot|claude-(?:web|user|searchbot)|perplexity-user|ccbot|amazonbot|applebot|yandex|baiduspider|embedly|quora link preview|redditbot|vkshare|ia_archiver/i;

export function isBot(ua) {
  return !ua || ua.length < 20 || BOT_UA.test(ua);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

const ID_RE = /^[A-Za-z0-9_-]{16,40}$/;
export const newId = () => crypto.randomBytes(16).toString('base64url');

// Garante o cookie do visitante (no HTML da página e, se faltar, no evento).
export function ensureVisitor(req, res) {
  const cur = parseCookies(req.headers.cookie)._lpm_v;
  if (cur && ID_RE.test(cur)) return cur;
  const id = newId();
  const optOut = req.get('sec-gpc') === '1' || req.get('dnt') === '1';
  const parts = [`_lpm_v=${id}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (!optOut) parts.push(`Max-Age=${VISITOR_MAX_AGE}`);
  if (req.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
  return id;
}

export function visitorOf(req) {
  const cur = parseCookies(req.headers.cookie)._lpm_v;
  return cur && ID_RE.test(cur) ? cur : null;
}

export function makeTracking(db, pages) {
  const q = {
    latestVisit: db.prepare('SELECT * FROM visits WHERE visitor_id = ? AND slug = ? ORDER BY last_seen DESC LIMIT 1'),
    firstVisit: db.prepare('SELECT * FROM visits WHERE visitor_id = ? AND slug = ? ORDER BY started_at ASC LIMIT 1'),
    lastNonDirect: db.prepare(`SELECT * FROM visits WHERE visitor_id = ? AND slug = ? AND inherited = 0
      AND source <> '(direct)' AND started_at >= ? ORDER BY started_at DESC LIMIT 1`),
    insertVisit: db.prepare(`INSERT INTO visits (id, slug, visitor_id, started_at, last_seen, landing_path, landing_query, referrer,
      source, medium, campaign, term, content, click_type, click_id, channel, inherited, campaign_key, device, is_new, pageviews, test)
      VALUES (@id, @slug, @visitor_id, @started_at, @last_seen, @landing_path, @landing_query, @referrer, @source, @medium, @campaign,
      @term, @content, @click_type, @click_id, @channel, @inherited, @campaign_key, @device, @is_new, 0, @test)`),
    insertPv: db.prepare(`INSERT OR IGNORE INTO pageviews (id, visit_id, slug, page_id, path, ts, engaged_ms, max_scroll, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`),
    bumpVisit: db.prepare('UPDATE visits SET last_seen = MAX(last_seen, ?), pageviews = pageviews + ? WHERE id = ?'),
    pv: db.prepare('SELECT id, visit_id, page_id, path, slug FROM pageviews WHERE id = ?'),
    ping: db.prepare(`UPDATE pageviews SET engaged_ms = MAX(engaged_ms, ?), max_scroll = MAX(max_scroll, ?), updated_at = ?
      WHERE id = ? AND slug = ?`),
    insertClick: db.prepare(`INSERT INTO clicks (pageview_id, visit_id, slug, page_id, path, kind, label, target, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    hasVisits: db.prepare('SELECT 1 FROM visits WHERE visitor_id = ? AND slug = ? LIMIT 1'),
  };

  // Abre (ou continua) a visita deste visitante para uma visualização.
  function visitFor(site, visitorId, url, rawRef, device, now) {
    const apex = apexOf(site.custom_domain);
    const ref = referrerFrom(rawRef, apex);
    const camp = campaignFrom(url.searchParams, ref);
    const test = url.searchParams.get('lpm') === 'test' ? 1 : 0;
    const cur = q.latestVisit.get(visitorId, site.slug);
    const fresh = cur && now - cur.last_seen < VISIT_GAP;
    // visita aberta continua, a não ser que chegue outra campanha ou um teste (?lpm=test)
    // numa visita que não era de teste: aí abre outra, para o teste não entrar nos números
    if (fresh && (!camp || cur.campaign_key === campaignKey(camp)) && !(test && !cur.test)) return cur;

    let attr = camp || (ref ? { ...DIRECT, source: ref.source, medium: ref.medium } : { ...DIRECT });
    let inherited = 0;
    if (attr.source === '(direct)') {
      const prev = q.lastNonDirect.get(visitorId, site.slug, now - LOOKBACK);
      if (prev) {
        attr = { source: prev.source, medium: prev.medium, campaign: prev.campaign, term: prev.term, content: prev.content, click_type: prev.click_type, click_id: prev.click_id };
        inherited = 1;
      }
    }
    const visit = {
      id: newId(), slug: site.slug, visitor_id: visitorId, started_at: now, last_seen: now,
      landing_path: normalizePath(url.pathname),
      landing_query: url.search.length > 1 ? url.search.slice(1, 1500) : null,
      referrer: ref ? (ref.host + (ref.path && ref.path !== '/' ? ref.path : '')).slice(0, 200) : null,
      ...attr, channel: channelOf(attr), inherited,
      campaign_key: attr.source === '(direct)' ? null : campaignKey(attr),
      device, is_new: cur || q.hasVisits.get(visitorId, site.slug) ? 0 : 1, test: test || (fresh && cur.test) ? 1 : 0,
    };
    q.insertVisit.run(visit);
    return visit;
  }

  // Processa um evento do script. Devolve false quando o evento é descartado.
  function record(site, visitorId, ev, ua, now) {
    if (!ev || typeof ev !== 'object') return false;
    const pid = typeof ev.pid === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(ev.pid) ? ev.pid : null;
    if (!pid) return false;

    if (ev.t === 'pv') {
      let url;
      try { url = new URL(String(ev.u || '')); } catch (_) { return false; }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      const p = normalizePath(url.pathname);
      const page = pages.find(site.slug, p);
      const visit = visitFor(site, visitorId, url, typeof ev.r === 'string' ? ev.r : '', deviceOf(ua, ev.tp), now);
      const info = q.insertPv.run(pid, visit.id, site.slug, page ? page.id : null, p, now, now);
      q.bumpVisit.run(now, info.changes ? 1 : 0, visit.id);
      return true;
    }

    if (ev.t === 'ping') {
      const e = Math.max(0, Math.min(MAX_ENGAGED, Math.round(Number(ev.e) || 0)));
      const s = Math.max(0, Math.min(100, Math.round(Number(ev.s) || 0)));
      const info = q.ping.run(e, s, now, pid, site.slug);
      if (!info.changes) return false;
      const pv = q.pv.get(pid);
      if (pv) q.bumpVisit.run(now, 0, pv.visit_id);
      return true;
    }

    if (ev.t === 'c') {
      const kind = typeof ev.k === 'string' && CLICK_KINDS[ev.k] ? ev.k : null;
      if (!kind) return false;
      let pv = q.pv.get(pid);
      if (pv && pv.slug !== site.slug) return false;
      let visitId = pv ? pv.visit_id : null, pageId = pv ? pv.page_id : null, p = pv ? pv.path : normalizePath(ev.p);
      if (!pv) {
        // o clique chegou antes da visualização (corrida de rede): usa a visita atual
        const cur = q.latestVisit.get(visitorId, site.slug);
        if (!cur || now - cur.last_seen > VISIT_GAP) return false;
        visitId = cur.id;
        const page = pages.find(site.slug, p);
        pageId = page ? page.id : null;
      }
      q.insertClick.run(pid, visitId, site.slug, pageId, p, kind, clean(ev.l, 90), clean(ev.h, 160), now);
      q.bumpVisit.run(now, 0, visitId);
      return true;
    }
    return false;
  }

  // Origem e página de um lead novo. Usa a visita atual do visitante; sem ela
  // (cookie bloqueado, script bloqueado), lê as UTMs da URL de onde o form saiu.
  function attributeLead(site, visitorId, pageUrl, now) {
    const p = pathOfUrl(pageUrl);
    const page = p ? pages.find(site.slug, p) : null;
    const out = { page_id: page ? page.id : null, page_path: p, visit_id: null, visitor_id: visitorId || null };
    const visit = visitorId ? q.latestVisit.get(visitorId, site.slug) : null;
    if (visit && now - visit.last_seen < 24 * 3600 * 1000) {
      Object.assign(out, {
        visit_id: visit.id, utm_source: visit.source, utm_medium: visit.medium, utm_campaign: visit.campaign,
        utm_term: visit.term, utm_content: visit.content, click_type: visit.click_type, click_id: visit.click_id,
        channel: visit.channel, referrer: visit.referrer, landing_page: visit.landing_path, device: visit.device,
      });
      const first = q.firstVisit.get(visitorId, site.slug);
      if (first) Object.assign(out, { first_source: first.source, first_medium: first.medium, first_campaign: first.campaign, first_seen: first.started_at });
      return out;
    }
    Object.assign(out, leadAttributionFromUrl(pageUrl));
    return out;
  }

  return { record, attributeLead, visitFor };
}

// Origem de um lead só pela URL (usado para os leads antigos e quando não há visita).
export function leadAttributionFromUrl(pageUrl) {
  let params = null;
  try { params = new URL(String(pageUrl || '')).searchParams; } catch (_) {}
  const a = (params && campaignFrom(params, null)) || { ...DIRECT };
  return {
    utm_source: a.source, utm_medium: a.medium, utm_campaign: a.campaign, utm_term: a.term, utm_content: a.content,
    click_type: a.click_type, click_id: a.click_id, channel: channelOf(a),
  };
}

// Script do navegador, servido com a versão no nome (cache de um ano).
export function trackerVersion(src) {
  return crypto.createHash('sha256').update(src).digest('hex').slice(0, 10);
}

export function injectTracker(html, version) {
  const tag = `<script src="/_lpm/t.js?v=${version}" defer></script>`;
  const i = html.search(/<\/head>/i);
  if (i !== -1) return html.slice(0, i) + tag + html.slice(i);
  const j = html.search(/<\/body>/i);
  return j !== -1 ? html.slice(0, j) + tag + html.slice(j) : html + tag;
}

// Freio simples por IP para o coletor (240 eventos por minuto).
const evRate = new Map();
export function eventRateOk(ip) {
  const now = Date.now();
  const cur = evRate.get(ip);
  if (!cur || now - cur.t > 60000) { evRate.set(ip, { t: now, n: 1 }); return true; }
  cur.n++;
  return cur.n <= 240;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of evRate) if (now - v.t > 60000) evRate.delete(k); }, 60000).unref();
