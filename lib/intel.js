// ── Central de Inteligência: relatório de palavras-chave e campanhas pela IA ─
// O painel junta os números medidos no site (lib/insights.js), manda para a OpenAI
// (Responses API, em segundo plano, com busca na web) e guarda o relatório. Nada
// pessoal vai junto: só contagens, palavras-chave, cidades e o texto das páginas.
// Chave e modelo vêm do ambiente: OPENAI_API_KEY, INTEL_MODEL, INTEL_EFFORT.

const API = 'https://api.openai.com/v1/responses';
const POLL_MS = 8000;
const MAX_RUN_MS = 40 * 60 * 1000;

export const DEFAULT_GOAL = 'Encontrar as palavras-chave que mais trazem pacientes, cortar o que não funciona e montar novas campanhas no Google para aumentar os agendamentos de avaliação.';

const str = { type: 'string' };
const arr = (items) => ({ type: 'array', items });
const obj = (props) => ({ type: 'object', additionalProperties: false, required: Object.keys(props), properties: props });
const en = (...v) => ({ type: 'string', enum: v });

export const REPORT_SCHEMA = obj({
  resumo: str,
  confianca: obj({ nivel: en('alta', 'média', 'baixa'), motivo: str }),
  diagnostico: obj({ funciona: arr(str), nao_funciona: arr(str), oportunidades: arr(str) }),
  palavras_investir: arr(obj({ palavra: str, evidencia: str, acao: str })),
  palavras_revisar: arr(obj({ palavra: str, evidencia: str, acao: str })),
  palavras_novas: arr(obj({
    palavra: str, correspondencia: en('exata', 'frase', 'ampla'), grupo: str,
    intencao: en('contratar agora', 'comparando opções', 'informacional'), prioridade: en('alta', 'média', 'baixa'), motivo: str,
  })),
  negativas: arr(obj({ palavra: str, correspondencia: en('exata', 'frase', 'ampla'), motivo: str })),
  campanhas: arr(obj({
    nome: str, objetivo: str, tipo: str, pagina: str, orcamento_pct: { type: 'integer' }, estrategia_de_lance: str,
    locais: str, horarios: str,
    grupos: arr(obj({ nome: str, palavras: arr(str), titulos: arr(str), descricoes: arr(str) })),
  })),
  locais: arr(obj({ local: str, recomendacao: en('aumentar', 'manter', 'reduzir', 'excluir', 'testar'), motivo: str })),
  horarios_e_aparelhos: arr(obj({ item: str, recomendacao: str, motivo: str })),
  organico: arr(obj({ acao: str, motivo: str })),
  paginas: arr(obj({ pagina: str, acao: str, motivo: str })),
  proximos_passos: arr(obj({ acao: str, impacto: en('alto', 'médio', 'baixo'), esforco: en('baixo', 'médio', 'alto'), quando: str })),
  cuidados: arr(str),
  pesquisa_de_mercado: arr(obj({ achado: str, fonte_url: str })),
  limitacoes_dos_dados: arr(str),
});

export const SYSTEM_PROMPT = `Você é estrategista sênior de Google Ads e de SEO local para clínicas de estética e saúde no Brasil, com longa experiência em campanhas de pesquisa que geram agendamentos. Escreva em português do Brasil, para o dono do negócio: claro, direto, sem jargão desnecessário (explique sigla na primeira vez). Não use travessão (—).

Você recebe os números MEDIDOS no próprio site (JSON). Regras:
1. Os dados medidos são a base. Toda afirmação de desempenho cita os números (ex.: "33 leads em 302 visitas, 10,9%"). Contato = clique em WhatsApp, formulário, telefone ou e-mail; lead = contato registrado.
2. Amostra pequena: com menos de 30 visitas ou menos de 3 leads, trate como sinal fraco e diga isso. Nunca recomende pausar uma palavra-chave com menos de 30 visitas só por não ter lead.
3. "palavra_chave" vem do utm_term das visitas pagas: normalmente é a palavra-chave da conta (ValueTrack {keyword}), não o termo exato pesquisado. Os dados NÃO têm custo, CPC, impressões nem CTR: nunca invente esses números; quando a decisão depender deles, diga o que conferir no Google Ads.
4. Na busca orgânica o Google não informa o termo pesquisado; baseie o SEO nas páginas de entrada, no conteúdo das páginas e na pesquisa.
5. Use a busca na web para: concorrentes na mesma cidade oferecendo os mesmos tratamentos (como se posicionam, que nomes de tratamento e aparelhos usam), termos que o público usa, sazonalidade e as regras atuais de publicidade (políticas do Google Ads para saúde e procedimentos estéticos e as normas do conselho profissional aplicável à profissional da página). Registre cada achado usado em "pesquisa_de_mercado" com a URL. Não invente volume de busca; se citar um número, diga a fonte.
6. Anúncios: títulos de até 30 caracteres e descrições de até 90 caracteres (conte os caracteres), de 3 a 6 títulos e 2 a 4 descrições por grupo; sem promessa de resultado garantido, sem "antes e depois", sem preço que a página não mostra; coerentes com a página de destino; use a cidade quando ajudar.
7. Palavras novas: priorize intenção de contratar (tratamento + cidade, bairro ou região onde os dados mostram procura, "clínica", "agendar", "avaliação", "valor"), nomes que o público usa (inclusive nomes comerciais de aparelhos citados na página) e variações locais. Não repita palavras que já estão nos dados.
8. Negativas: termos que trazem o público errado (emprego, curso, como fazer em casa, gratuito, SUS, faculdade etc.) e o que os dados mostrarem.
9. Campanhas: proponha a estrutura completa (2 a 4 campanhas), com grupos de anúncios temáticos; "orcamento_pct" soma 100 entre elas. Indique a página de destino certa para cada uma.
10. Locais, dias, horários e aparelhos: recomende ajustes só com base nos dados medidos e diga o tamanho da amostra.
11. Considere o objetivo informado. Se houver relatório anterior, diga o que mudou desde então.
12. Seja específico e acionável. Nada genérico do tipo "melhore os anúncios".`;

export function makeIntel({ db, insights, pages, siteDirOf, panelUrl }) {
  const cfg = () => ({
    key: (process.env.OPENAI_API_KEY || '').trim(),
    model: (process.env.INTEL_MODEL || 'gpt-6.2-astra').trim(),
    effort: (process.env.INTEL_EFFORT || 'high').trim(),
    web: process.env.INTEL_WEB_SEARCH !== '0',
    daily: Math.max(1, parseInt(process.env.INTEL_DAILY_LIMIT || '10', 10) || 10),
  });

  const q = {
    insert: db.prepare(`INSERT INTO intel_reports (status, period_from, period_to, period_label, page_ids, goal, model, input_json, created_by, created_at)
      VALUES ('preparando', ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    started: db.prepare("UPDATE intel_reports SET status = 'gerando', openai_id = ? WHERE id = ?"),
    done: db.prepare(`UPDATE intel_reports SET status = 'pronto', output_json = ?, sources_json = ?, usage_json = ?, finished_at = ? WHERE id = ?`),
    fail: db.prepare("UPDATE intel_reports SET status = 'erro', error = ?, usage_json = COALESCE(?, usage_json), finished_at = ? WHERE id = ?"),
    running: db.prepare("SELECT * FROM intel_reports WHERE status IN ('preparando', 'gerando') ORDER BY id"),
    get: db.prepare('SELECT r.*, u.name AS author_name, u.email AS author_email FROM intel_reports r LEFT JOIN users u ON u.id = r.created_by WHERE r.id = ?'),
    list: db.prepare(`SELECT r.id, r.status, r.period_label, r.period_from, r.period_to, r.page_ids, r.model, r.error, r.created_at, r.finished_at,
        r.usage_json, u.name AS author_name, u.email AS author_email,
        json_extract(r.output_json, '$.resumo') AS resumo, json_extract(r.output_json, '$.confianca.nivel') AS confianca
      FROM intel_reports r LEFT JOIN users u ON u.id = r.created_by ORDER BY r.id DESC LIMIT ?`),
    lastDone: db.prepare("SELECT * FROM intel_reports WHERE status = 'pronto' ORDER BY id DESC LIMIT 1"),
    lastGoal: db.prepare("SELECT goal FROM intel_reports WHERE goal IS NOT NULL AND goal != '' ORDER BY id DESC LIMIT 1"),
    today: db.prepare("SELECT COUNT(*) AS n FROM intel_reports WHERE created_at >= ? AND status != 'erro'"),
  };

  async function api(method, url, body) {
    const { key } = cfg();
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch (_) {}
    if (!res.ok) {
      const msg = (j && j.error && j.error.message) || text.slice(0, 200) || `HTTP ${res.status}`;
      const e = new Error(msg); e.status = res.status; throw e;
    }
    return j;
  }

  function friendly(e) {
    const m = String((e && e.message) || e || '');
    if (e && e.status === 401) return 'A chave da OpenAI foi recusada. Confira a variável OPENAI_API_KEY no servidor.';
    if (e && e.status === 429) return /quota|billing|credit/i.test(m) ? 'A conta da OpenAI está sem créditos ou passou do limite de uso.' : 'A OpenAI pediu para esperar (muitas solicitações). Tente de novo em alguns minutos.';
    if (e && e.status === 404) return 'O modelo configurado não está disponível para esta chave da OpenAI.';
    if (/timeout|aborted/i.test(m)) return 'A OpenAI demorou demais para responder. Tente de novo.';
    return `A OpenAI recusou o pedido: ${m.slice(0, 200)}`;
  }

  // Começa um relatório. Devolve { id } ou { error }.
  async function create({ user, period, pageList, goal }) {
    const c = cfg();
    if (!c.key) return { error: 'A IA ainda não está ligada: falta a chave da OpenAI no servidor (OPENAI_API_KEY).' };
    if (q.running.all().length) return { error: 'Já tem um relatório sendo gerado. Espere ele terminar.' };
    const since = Date.now() - 24 * 3600 * 1000;
    if (q.today.get(since).n >= c.daily) return { error: `Limite de ${c.daily} relatórios por dia atingido. Tente amanhã.` };
    if (!pageList.length) return { error: 'Nenhuma página publicada para analisar.' };

    const data = insights.forAi({
      pages: pageList.map((p) => ({ ...p, url: `https://${p.domain}${p.path === '/' ? '/' : p.path}` })),
      from: period.from, to: period.to, prevFrom: period.prev.from, prevTo: period.prev.to, siteDirOf,
    });
    const prev = q.lastDone.get();
    if (prev) {
      try {
        const o = JSON.parse(prev.output_json);
        data.relatorio_anterior = {
          gerado_em: new Date(prev.created_at - 3 * 3600000).toISOString().slice(0, 16).replace('T', ' '),
          periodo: prev.period_label, resumo: o.resumo, proximos_passos: (o.proximos_passos || []).map((p) => p.acao).slice(0, 8),
        };
      } catch (_) {}
    }
    const goalText = String(goal || '').trim().slice(0, 1500) || DEFAULT_GOAL;
    const info = q.insert.run(period.from, period.to, period.label, JSON.stringify(pageList.map((p) => p.id)), goalText, c.model,
      JSON.stringify(data), user ? user.id : null, Date.now());
    const id = Number(info.lastInsertRowid);

    const body = {
      model: c.model,
      background: true,
      store: true,
      reasoning: { effort: c.effort },
      max_output_tokens: 60000,
      input: [
        { role: 'developer', content: SYSTEM_PROMPT },
        { role: 'user', content: `Objetivo deste relatório: ${goalText}\n\nDados medidos no site (JSON):\n${JSON.stringify(data)}` },
      ],
      text: { format: { type: 'json_schema', name: 'relatorio_campanhas', strict: true, schema: REPORT_SCHEMA } },
      metadata: { painel: String(panelUrl || '').slice(0, 100), relatorio: String(id) },
    };
    if (c.web) body.tools = [{ type: 'web_search', user_location: { type: 'approximate', country: 'BR' } }];
    try {
      const r = await api('POST', API, body);
      q.started.run(r.id, id);
      ensurePolling();
      return { id };
    } catch (e) {
      q.fail.run(friendly(e), null, Date.now(), id);
      return { id, error: friendly(e) };
    }
  }

  // ── acompanhamento dos relatórios em andamento ────────────────────────────
  let timer = null, polling = false;
  function ensurePolling() {
    if (timer) return;
    timer = setInterval(poll, POLL_MS);
    timer.unref();
  }
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const rows = q.running.all();
      if (!rows.length) { clearInterval(timer); timer = null; return; }
      for (const r of rows) await check(r);
    } finally { polling = false; }
  }
  async function check(r) {
    const now = Date.now();
    if (!r.openai_id) {
      // ficou em "preparando" (servidor reiniciou no meio do envio)
      if (now - r.created_at > 2 * 60 * 1000) q.fail.run('O envio para a IA foi interrompido. Gere de novo.', null, now, r.id);
      return;
    }
    let j;
    try { j = await api('GET', `${API}/${encodeURIComponent(r.openai_id)}`); }
    catch (e) {
      if (e.status === 404 || now - r.created_at > MAX_RUN_MS) q.fail.run(friendly(e), null, now, r.id);
      return;
    }
    const usage = j.usage ? JSON.stringify({ ...j.usage, segundos: Math.round((now - r.created_at) / 1000) }) : null;
    if (j.status === 'queued' || j.status === 'in_progress') {
      if (now - r.created_at > MAX_RUN_MS) {
        try { await api('POST', `${API}/${encodeURIComponent(r.openai_id)}/cancel`); } catch (_) {}
        q.fail.run('A IA passou de 40 minutos sem terminar. Gere de novo.', usage, now, r.id);
      }
      return;
    }
    if (j.status !== 'completed') {
      const why = j.incomplete_details && j.incomplete_details.reason === 'max_output_tokens'
        ? 'A resposta da IA ficou grande demais e foi cortada. Gere de novo com um período menor.'
        : (j.error && j.error.message) ? `A IA não concluiu: ${String(j.error.message).slice(0, 200)}` : `A IA não concluiu (${j.status}).`;
      q.fail.run(why, usage, now, r.id);
      return;
    }
    const { text, refusal, searches } = readOutput(j);
    if (refusal) { q.fail.run(`A IA recusou: ${refusal.slice(0, 200)}`, usage, now, r.id); return; }
    let out;
    try { out = JSON.parse(text); } catch (_) { q.fail.run('A resposta da IA veio num formato inesperado. Gere de novo.', usage, now, r.id); return; }
    q.done.run(JSON.stringify(out), JSON.stringify({ buscas: searches }), usage, now, r.id);
  }

  function readOutput(j) {
    let text = '', refusal = '';
    const searches = [];
    for (const o of j.output || []) {
      if (o.type === 'message') {
        for (const c of o.content || []) {
          if (c.type === 'output_text') text += c.text || '';
          if (c.type === 'refusal') refusal += c.refusal || '';
        }
      } else if (o.type === 'web_search_call' && o.action && o.action.query) searches.push(o.action.query);
    }
    return { text, refusal, searches };
  }

  // Confere no boot se a chave é aceita e o modelo existe (só leitura, sem custo).
  let health = { ok: null, error: null };
  async function checkKey() {
    const c = cfg();
    if (!c.key) { health = { ok: false, error: null }; return health; }
    try {
      await api('GET', `https://api.openai.com/v1/models/${encodeURIComponent(c.model)}`);
      health = { ok: true, error: null };
      console.log(`[ia] chave da OpenAI aceita; modelo ${c.model} disponível`);
    } catch (e) {
      health = { ok: false, error: friendly(e) };
      console.error('[ia]', health.error);
    }
    return health;
  }

  function start() {
    if (q.running.all().length) ensurePolling();
    checkKey();
  }

  return {
    create, start, cfg, checkKey, health: () => health,
    _poll: poll, // testes
    get: (id) => q.get.get(id),
    list: (n = 20) => q.list.all(n),
    lastGoal: () => (q.lastGoal.get() || {}).goal || DEFAULT_GOAL,
    running: () => q.running.all(),
  };
}

// ── Ajudantes de exibição ──────────────────────────────────────────────────
export function matchSyntax(palavra, corresp) {
  const p = String(palavra || '').trim();
  if (corresp === 'exata') return `[${p}]`;
  if (corresp === 'frase') return `"${p}"`;
  return p;
}

export function safeUrl(u) {
  try {
    const x = new URL(String(u || ''));
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null;
  } catch (_) { return null; }
}

export function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}
