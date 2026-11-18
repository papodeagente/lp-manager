// Mapa e Central de Inteligência: localização, agregados e o relatório da IA (com a
// OpenAI simulada, sem rede). Rodar com: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../lib/db.js';
import { publicIp, fromRecord, ufOf } from '../lib/geo.js';
import { geoColumns } from '../lib/tracking.js';
import { makeInsights, pageText, placeLabel } from '../lib/insights.js';
import { makeIntel, REPORT_SCHEMA, matchSyntax, safeUrl, cleanText, cleanOutput } from '../lib/intel.js';
import { parsePeriod } from '../lib/stats.js';
import { corta } from '../lib/format.js';

test('IP interno, reservado ou inválido não tem cidade', () => {
  for (const ip of ['10.0.0.1', '192.168.1.9', '172.20.3.4', '127.0.0.1', '100.64.1.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', 'lixo', '']) {
    assert.equal(publicIp(ip), null, ip);
  }
  assert.equal(publicIp('::ffff:189.6.0.1'), '189.6.0.1');
  assert.equal(publicIp('2804:14c::1'), '2804:14c::1');
});

test('registro da base vira cidade, estado em português e UF', () => {
  const g = fromRecord({ country: { iso_code: 'BR' }, subdivisions: [{ names: { en: 'Federal District' } }], city: { names: { en: 'Brasília' } }, location: { latitude: -15.79751, longitude: -47.89192 } });
  assert.deepEqual(g, { country: 'BR', region: 'Distrito Federal', city: 'Brasília', lat: -15.798, lon: -47.892 });
  assert.equal(ufOf('Distrito Federal'), 'DF');
  assert.equal(ufOf('Goiás'), 'GO');
  assert.equal(fromRecord(null), null);
  assert.equal(placeLabel('BR', 'Goiás', 'Anápolis'), 'Anápolis · GO');
  assert.equal(placeLabel('', '', ''), 'Sem localização');
});

test('colunas de localização: sem base fica nulo, sem cidade fica país vazio', () => {
  assert.equal(geoColumns(null, '1.2.3.4').geo_country, null);
  const pronta = (r) => ({ ready: () => true, lookup: () => r });
  assert.equal(geoColumns({ ready: () => false, lookup: () => null }, '1.2.3.4').geo_country, null);
  assert.equal(geoColumns(pronta(null), '1.2.3.4').geo_country, '');
  assert.deepEqual(geoColumns(pronta({ country: 'BR', region: 'Goiás', city: 'Goiânia', lat: -16.6, lon: -49.2 }), '1.2.3.4'),
    { geo_country: 'BR', geo_region: 'Goiás', geo_city: 'Goiânia', geo_lat: -16.6, geo_lon: -49.2 });
});

test('texto da página: sem script, estilo nem marcação', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpm-txt-'));
  fs.writeFileSync(path.join(dir, 'p.html'), '<html><head><title>Flacidez | Dra.</title><meta name="description" content="Ultrassom microfocado"><style>.x{}</style></head><body><script>alert(1)</script><h1>Tratamento &amp; cuidado</h1><p>Agende sua avaliação</p></body></html>');
  const t = pageText(dir, 'p.html');
  assert.match(t, /Título: Flacidez \| Dra\./);
  assert.match(t, /Descrição: Ultrassom microfocado/);
  assert.match(t, /Tratamento & cuidado/);
  assert.doesNotMatch(t, /alert|\.x\{/);
  assert.equal(pageText(dir, 'nao-existe.html'), '');
});

test('formato do relatório é estrito em todos os níveis', () => {
  const walk = (s, where) => {
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false, where);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), where);
      for (const [k, v] of Object.entries(s.properties)) walk(v, `${where}.${k}`);
    } else if (s.type === 'array') walk(s.items, `${where}[]`);
  };
  walk(REPORT_SCHEMA, 'relatorio');
});

test('palavra no formato do Google Ads e link seguro', () => {
  assert.equal(matchSyntax('ultrassom brasilia', 'exata'), '[ultrassom brasilia]');
  assert.equal(matchSyntax('ultrassom brasilia', 'frase'), '"ultrassom brasilia"');
  assert.equal(matchSyntax('ultrassom brasilia', 'ampla'), 'ultrassom brasilia');
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('https://exemplo.com/a'), 'https://exemplo.com/a');
  assert.equal(corta('Harmonização Facial Full Face em Brasília', 20), 'Harmonização Facial…');
});

test('citações da busca saem do texto e o utm_source=openai sai dos endereços', () => {
  const c = [];
  assert.equal(cleanText('Botox está na lista. ([support.google.com](https://support.google.com/a?hl=pt-BR&utm_source=openai))', c), 'Botox está na lista.');
  assert.deepEqual(c, ['https://support.google.com/a?hl=pt-BR']);
  assert.equal(cleanText('Consulte [o Coren](https://coren-df.gov.br/) antes.'), 'Consulte o Coren antes.');
  const { out, cited } = cleanOutput({ resumo: 'a ([x.com](https://x.com/?utm_source=openai)).', pesquisa_de_mercado: [{ achado: 'b', fonte_url: 'https://y.com/p?utm_source=openai' }], orcamento_pct: 70 });
  assert.deepEqual(out, { resumo: 'a.', pesquisa_de_mercado: [{ achado: 'b', fonte_url: 'https://y.com/p' }], orcamento_pct: 70 });
  assert.deepEqual(cited, ['https://x.com/']);
});

// ── banco de teste com visitas, cliques e leads ──────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpm-intel-'));
const db = openDb(path.join(dir, 'lps.db'));
after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
const now = Date.now();
db.prepare("INSERT INTO lps (slug, name, custom_domain, index_file, created_at, updated_at) VALUES ('s', 'Site', 'ex.com.br', 'index.html', ?, ?)").run(now, now);
const pid = db.prepare("INSERT INTO pages (slug, path, file, name, kind, present, created_at, updated_at) VALUES ('s', '/', 'index.html', 'Home', 'landing', 1, ?, ?)").run(now, now).lastInsertRowid;
let n = 0;
function visita({ ch = 'google_ads', src = 'google', med = 'cpc', term = null, city = 'Brasília', region = 'Distrito Federal', country = 'BR', test = 0, contato = false, lead = false, t = now - 3600000 }) {
  const id = 'v' + (++n);
  db.prepare(`INSERT INTO visits (id, slug, visitor_id, started_at, last_seen, landing_path, source, medium, term, channel, device, pageviews, test,
      geo_country, geo_region, geo_city, geo_lat, geo_lon) VALUES (?, 's', ?, ?, ?, '/', ?, ?, ?, ?, 'celular', 1, ?, ?, ?, ?, ?, ?)`)
    .run(id, 'p' + n, t, t, src, med, term, ch, test, country, country ? region : null, country ? city : null, country ? -15.8 : null, country ? -47.9 : null);
  db.prepare("INSERT INTO pageviews (id, visit_id, slug, page_id, path, ts, engaged_ms, max_scroll) VALUES (?, ?, 's', ?, '/', ?, 30000, 80)").run('pv' + n, id, pid, t);
  if (contato) db.prepare("INSERT INTO clicks (pageview_id, visit_id, slug, page_id, path, kind, ts) VALUES (?, ?, 's', ?, '/', 'whatsapp', ?)").run('pv' + n, id, pid, t + 1000);
  if (lead) db.prepare(`INSERT INTO leads (slug, name, created_at, page_id, visit_id, channel, utm_term, test, geo_country, geo_region, geo_city, geo_lat, geo_lon)
    VALUES ('s', 'x', ?, ?, ?, ?, ?, 0, ?, ?, ?, -15.8, -47.9)`).run(t + 2000, pid, id, ch, term, country, region, city);
}
for (let i = 0; i < 10; i++) visita({ term: 'ultrassom brasilia', contato: i < 4, lead: i < 2 });
for (let i = 0; i < 5; i++) visita({ term: 'botox preço' });
for (let i = 0; i < 4; i++) visita({ ch: 'busca', med: 'organic', city: 'Goiânia', region: 'Goiás', contato: i === 0, lead: i === 0 });
visita({ ch: 'direto', src: '(direct)', med: '(none)', country: '' });
visita({ test: 1, lead: true });

const insights = makeInsights(db);
const period = parsePeriod({ p: '7d' }, now);

test('mapa: cidades, canais, sem localização e testes fora', () => {
  const g = insights.geo([pid], period.from, period.to, '');
  const bsb = g.points.find((p) => p.city === 'Brasília');
  assert.equal(bsb.visits, 15);
  assert.equal(bsb.contacts, 4);
  assert.equal(bsb.leads, 2);
  assert.equal(bsb.label, 'Brasília · DF');
  assert.equal(g.unknown.visits, 1);
  assert.equal(g.totals.visits, 20);
  const org = insights.geo([pid], period.from, period.to, 'busca');
  assert.deepEqual(org.points.map((p) => [p.city, p.visits, p.leads]), [['Goiânia', 4, 1]]);
  assert.equal(org.regions[0].uf, 'GO');
});

test('dados para a IA: palavras-chave, canais e nada pessoal', () => {
  const d = insights.forAi({ pages: [{ id: pid, name: 'Home', path: '/', file: 'index.html', url: 'https://ex.com.br/' }], from: period.from, to: period.to,
    prevFrom: period.prev.from, prevTo: period.prev.to, siteDirOf: null });
  const kw = d.google_ads.palavras_chave.find((p) => p.palavra_chave === 'ultrassom brasilia');
  assert.equal(kw.visitas, 10);
  assert.equal(kw.contatos, 4);
  assert.equal(kw.leads, 2);
  assert.equal(kw.taxa_lead_pct, 20);
  assert.deepEqual(kw.cidades_principais, ['Brasília · DF']);
  assert.equal(d.totais.visitas, 20);
  assert.equal(d.busca_organica.totais.leads, 1);
  assert.equal(d.localizacao.sem_localizacao, 1);
  assert.deepEqual(d.localizacao.cidades.find((c) => c.cidade === 'Goiânia · GO').canais, { 'Busca orgânica': { visitas: 4, leads: 1 } });
  assert.deepEqual(d.google_ads.cidades.map((c) => [c.cidade, c.visitas, c.leads]), [['Brasília · DF', 15, 2]]);
  assert.equal(d.google_ads.horas_do_dia.reduce((s, h) => s + h.visitas, 0), 15);
  assert.ok(d.periodo_anterior && d.periodo_anterior.dias === 7);
  const s = JSON.stringify(d);
  assert.doesNotMatch(s, /"name"|telefone|phone/);
});

test('relatório da IA: envio, espera e resposta lida (OpenAI simulada)', async () => {
  const exemplo = {
    resumo: 'Invista em ultrassom.', confianca: { nivel: 'média', motivo: 'amostra pequena' },
    diagnostico: { funciona: ['a'], nao_funciona: ['b'], oportunidades: ['c'] },
    palavras_investir: [], palavras_revisar: [], palavras_novas: [], negativas: [], campanhas: [], locais: [],
    horarios_e_aparelhos: [], organico: [], paginas: [], proximos_passos: [], cuidados: [], pesquisa_de_mercado: [], limitacoes_dos_dados: [],
  };
  const pedidos = [];
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (url, opt = {}) => {
    pedidos.push({ url, method: opt.method, body: opt.body ? JSON.parse(opt.body) : null });
    const body = opt.method === 'POST'
      ? { id: 'resp_teste', status: 'queued' }
      : { id: 'resp_teste', status: 'completed', usage: { input_tokens: 10, output_tokens: 5 },
        output: [{ type: 'web_search_call', action: { query: 'clínicas brasília' } }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(exemplo) }] }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const envOriginal = { ...process.env };
  process.env.OPENAI_API_KEY = 'sk-teste';
  process.env.INTEL_MODEL = 'modelo-teste';
  try {
    const intel = makeIntel({ db, insights, pages: null, siteDirOf: null, panelUrl: 'https://painel.teste' });
    const semPagina = await intel.create({ user: null, period, pageList: [], goal: '' });
    assert.match(semPagina.error, /Nenhuma página/);
    const r = await intel.create({ user: null, period, pageList: [{ id: pid, name: 'Home', path: '/', file: 'index.html', domain: 'ex.com.br' }], goal: 'mais pacientes' });
    assert.ok(r.id && !r.error, JSON.stringify(r));
    const dup = await intel.create({ user: null, period, pageList: [{ id: pid, name: 'Home', path: '/', file: 'index.html', domain: 'ex.com.br' }], goal: '' });
    assert.match(dup.error, /Já tem um relatório/);
    const env = pedidos[0].body;
    assert.equal(env.model, 'modelo-teste');
    assert.equal(env.background, true);
    assert.equal(env.text.format.type, 'json_schema');
    assert.equal(env.tools[0].type, 'web_search');
    assert.match(env.input[1].content, /mais pacientes/);
    await intel._poll();
    const row = intel.get(r.id);
    assert.equal(row.status, 'pronto');
    assert.equal(JSON.parse(row.output_json).resumo, 'Invista em ultrassom.');
    assert.deepEqual(JSON.parse(row.sources_json).buscas, ['clínicas brasília']);
    // sem chave: não envia nada
    delete process.env.OPENAI_API_KEY;
    const semChave = await intel.create({ user: null, period, pageList: [{ id: pid, name: 'Home', path: '/', file: 'index.html', domain: 'ex.com.br' }], goal: '' });
    assert.match(semChave.error, /chave da OpenAI/);
  } finally {
    globalThis.fetch = fetchOriginal;
    for (const k of ['OPENAI_API_KEY', 'INTEL_MODEL']) { if (k in envOriginal) process.env[k] = envOriginal[k]; else delete process.env[k]; }
  }
});
