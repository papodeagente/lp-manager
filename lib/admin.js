import { parsePeriod, DIM_KEYS, DIM_LABELS, dayIndex } from './stats.js';
import { CHANNELS, CLICK_KINDS } from './tracking.js';
import { KINDS } from './pages.js';
import { makeJourney, urlParams, sourceLabel } from './journey.js';
import { hashPassword, passwordProblem, tempPassword, normEmail, validEmail, verifyPassword } from './auth.js';
import { webhookProblem } from './webhook.js';
import * as fmt from './format.js';

// ── Telas do painel: visão geral, páginas, leads, links, usuários e conta ────

export const ACTIONS = {
  login: 'Entrou no painel',
  logout: 'Saiu do painel',
  login_recusado: 'Login recusado',
  login_bloqueado: 'Login bloqueado por excesso de tentativas',
  usuario_criado: 'Criou usuário',
  usuario_alterado: 'Alterou usuário',
  usuario_desativado: 'Desativou usuário',
  usuario_reativado: 'Reativou usuário',
  usuario_excluido: 'Excluiu usuário',
  senha_redefinida: 'Gerou senha provisória',
  senha_alterada: 'Trocou a própria senha',
  site_criado: 'Criou site',
  site_publicado: 'Publicou arquivos do site',
  site_duplicado: 'Duplicou site',
  site_excluido: 'Excluiu site',
  dominio_alterado: 'Alterou domínio',
  index_alterado: 'Trocou a página inicial',
  webhook_alterado: 'Alterou webhook',
  webhook_testado: 'Testou webhook',
  pagina_alterada: 'Alterou página',
  link_criado: 'Criou link com UTM',
  link_excluido: 'Excluiu link com UTM',
  lead_excluido: 'Excluiu lead',
};

// UTM no padrão: minúsculas, sem acento, espaço vira hífen.
export function utmValue(v, max = 100) {
  return String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
    .replace(/[\s/]+/g, '-').replace(/[^a-z0-9._{}-]+/g, '').replace(/-{2,}/g, '-').replace(/^-|-$/g, '').slice(0, max);
}

export function pageUrl(page) {
  return `https://${page.domain}${page.path === '/' ? '/' : page.path}`;
}

export function utmUrl(page, l) {
  const q = new URLSearchParams({ utm_source: l.source, utm_medium: l.medium, utm_campaign: l.campaign });
  if (l.content) q.set('utm_content', l.content);
  if (l.term) q.set('utm_term', l.term);
  return `${pageUrl(page)}?${q.toString()}`;
}

const json = (x) => JSON.stringify(x).replace(/</g, '\\u003c');

export function registerAdmin(app, ctx) {
  const { db, pages, stats, stmts, render, takeFlash, audit, requireAuth, requireSuper, sessionStore, fireWebhook, webhookFor, testLead, userQ, ah } = ctx;

  const q = {
    links: db.prepare('SELECT * FROM utm_links WHERE page_id = ? ORDER BY created_at DESC'),
    link: db.prepare('SELECT * FROM utm_links WHERE id = ? AND page_id = ?'),
    insertLink: db.prepare(`INSERT INTO utm_links (page_id, name, source, medium, campaign, term, content, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    deleteLink: db.prepare('DELETE FROM utm_links WHERE id = ? AND page_id = ?'),
    lead: db.prepare('SELECT * FROM leads WHERE id = ?'),
    deleteLead: db.prepare('DELETE FROM leads WHERE id = ?'),
    users: db.prepare("SELECT * FROM users ORDER BY (role = 'super') DESC, active DESC, name COLLATE NOCASE"),
    supers: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'super' AND active = 1"),
    insertUser: db.prepare(`INSERT INTO users (email, name, password_hash, role, active, must_change_password, password_changed_at, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`),
    updateUser: db.prepare('UPDATE users SET name = ?, role = ?, updated_at = ? WHERE id = ?'),
    setActive: db.prepare('UPDATE users SET active = ?, updated_at = ? WHERE id = ?'),
    setPassword: db.prepare('UPDATE users SET password_hash = ?, must_change_password = ?, password_changed_at = ?, updated_at = ? WHERE id = ?'),
    setName: db.prepare('UPDATE users SET name = ?, updated_at = ? WHERE id = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    auditList: db.prepare(`SELECT * FROM audit WHERE id < ? AND (? = '' OR (? = 'acessos' AND action IN ('login', 'logout', 'login_recusado', 'login_bloqueado'))
      OR (? = 'alteracoes' AND action NOT IN ('login', 'logout', 'login_recusado', 'login_bloqueado'))) ORDER BY id DESC LIMIT 101`),
    firstLead: db.prepare('SELECT MIN(created_at) AS t FROM leads'),
  };

  function loadPage(req, res) {
    const id = parseInt(req.params.id, 10);
    const page = id ? pages.get(id) : null;
    const lp = page ? stmts.get.get(page.slug) : null;
    if (!page || !lp) {
      res.status(404);
      render(req, res, 'error', { title: 'Página não encontrada', message: 'Essa página não existe mais no painel.' });
      return null;
    }
    return { page: { ...page, domain: lp.custom_domain }, lp };
  }

  function back(req, fallback) {
    const ref = req.get('referer') || '';
    try {
      const u = new URL(ref);
      if (u.host === req.get('host') && u.pathname.startsWith('/admin')) return u.pathname + u.search;
    } catch (_) {}
    return fallback;
  }

  // ── Visão geral ──────────────────────────────────────────────────────────
  app.get('/admin', requireAuth, (req, res) => {
    const period = parsePeriod(req.query);
    const live = pages.live();
    const ids = live.map((p) => p.id);
    const rows = live.map((p) => ({
      page: p,
      k: stats.kpis([p.id], period.from, period.to),
      kp: stats.kpis([p.id], period.prev.from, period.prev.to),
    }));
    let total = null, totalPrev = null, chart = null, canais = [], recent = [];
    if (ids.length) {
      total = stats.kpis(ids, period.from, period.to);
      totalPrev = stats.kpis(ids, period.prev.from, period.prev.to);
      const s = stats.series(ids, period);
      chart = { labels: s.labels, series: live.map((p) => ({ name: p.name, values: s.visits[p.id] })) };
      for (const r of rows) r.spark = s.visits[r.page.id];
      canais = stats.breakdown(ids, 'canal', period.from, period.to);
      recent = stats.recentLeads(ids, 6);
    }
    const status = [...new Set(live.map((p) => p.slug))].map((slug) => stats.status(slug));
    render(req, res, 'overview', {
      title: 'Visão geral', period, rows, total, totalPrev, chartJson: chart ? json(chart) : null, canais, recent,
      status: status[0] || null, CHANNELS, ...takeFlash(req),
    });
  });

  // ── Página: resultados ───────────────────────────────────────────────────
  app.get('/admin/paginas/:id', requireAuth, (req, res) => {
    const ctxp = loadPage(req, res);
    if (!ctxp) return;
    const { page } = ctxp;
    const period = parsePeriod(req.query);
    const ids = [page.id];
    const k = stats.kpis(ids, period.from, period.to);
    const kp = stats.kpis(ids, period.prev.from, period.prev.to);
    const s = stats.series(ids, period);
    const dims = Object.fromEntries(DIM_KEYS.map((d) => [d, stats.breakdown(ids, d, period.from, period.to)]));
    render(req, res, 'page', {
      title: page.name, page, tab: 'resultados', period, k, kp,
      chartJson: json({ labels: s.labels, visits: s.visits[page.id], leads: s.leads[page.id], hourly: period.hourly }),
      series: s, dims, DIM_KEYS, DIM_LABELS,
      buckets: stats.buckets(ids, period.from, period.to),
      clicks: stats.topClicks(ids, period.from, period.to),
      recent: stats.recentLeads(ids, 6),
      status: stats.status(page.slug), CHANNELS, CLICK_KINDS, pageUrl: pageUrl(page), ...takeFlash(req),
    });
  });

  // ── Leads (todas as páginas ou uma) ──────────────────────────────────────
  function leadFilters(req, fixedPage) {
    const p = String(req.query.p || 'tudo');
    let period;
    if (p === 'tudo') {
      const first = q.firstLead.get().t;
      period = { ...parsePeriod({ p: '30d' }), key: 'tudo', label: 'Tudo', from: 0, to: Date.now() + 1 };
      if (first) period.a = dayIndex(first);
    } else period = parsePeriod(req.query);
    const pagina = fixedPage ? fixedPage.id : (parseInt(req.query.pagina, 10) || 0);
    const canal = CHANNELS[req.query.canal] ? req.query.canal : '';
    const busca = String(req.query.q || '').trim().slice(0, 60);
    return { period, pagina, canal, busca };
  }

  function findLeads(f, limit = 500) {
    const where = ['l.created_at >= ?', 'l.created_at < ?'];
    const args = [f.period.from, f.period.to];
    if (f.pagina) { where.push('l.page_id = ?'); args.push(f.pagina); }
    if (f.canal) { where.push('l.channel = ?'); args.push(f.canal); }
    if (f.busca) {
      const like = '%' + f.busca.replace(/[%_]/g, '') + '%';
      const dig = f.busca.replace(/\D/g, '');
      where.push(dig.length >= 4 ? "(l.name LIKE ? OR REPLACE(REPLACE(REPLACE(REPLACE(l.phone, ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?)" : 'l.name LIKE ?');
      args.push(like);
      if (dig.length >= 4) args.push('%' + dig + '%');
    }
    return db.prepare(`SELECT l.*, p.name AS page_name, p.path AS pg_path FROM leads l LEFT JOIN pages p ON p.id = l.page_id
      WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC LIMIT ${limit}`).all(...args);
  }

  function renderLeads(req, res, fixed) {
    const f = leadFilters(req, fixed && fixed.page);
    const leads = findLeads(f);
    const allPages = db.prepare(`SELECT p.id, p.name, p.path FROM pages p JOIN lps l ON l.slug = p.slug
      WHERE l.custom_domain IS NOT NULL AND p.kind = 'landing' ORDER BY (p.path = '/') DESC, p.path`).all();
    const qs = new URLSearchParams();
    if (f.period.key === 'custom') { qs.set('p', 'custom'); qs.set('de', f.period.de); qs.set('ate', f.period.ate); } else qs.set('p', f.period.key);
    if (f.pagina) qs.set('pagina', f.pagina);
    if (f.canal) qs.set('canal', f.canal);
    if (f.busca) qs.set('q', f.busca);
    render(req, res, fixed ? 'page-leads' : 'leads', {
      title: fixed ? `Leads · ${fixed.page.name}` : 'Leads', page: fixed ? fixed.page : null, tab: 'leads',
      f, leads, allPages, CHANNELS, csvHref: '/admin/leads.csv?' + qs.toString(), ...takeFlash(req),
    });
  }

  app.get('/admin/leads', requireAuth, (req, res) => renderLeads(req, res, null));

  app.get('/admin/paginas/:id/leads', requireAuth, (req, res) => {
    const ctxp = loadPage(req, res);
    if (ctxp) renderLeads(req, res, ctxp);
  });

  app.get('/admin/leads.csv', requireAuth, (req, res) => {
    const leads = findLeads(leadFilters(req, null), 20000);
    const esc = (v) => {
      const s = String(v == null ? '' : v);
      return '"' + (/^[=+\-@\t\r]/.test(s) ? "'" + s : s).replace(/"/g, '""') + '"';
    };
    const head = ['data', 'nome', 'telefone', 'mensagem', 'pagina', 'botao_ou_formulario', 'canal', 'utm_source', 'utm_medium',
      'utm_campaign', 'utm_term', 'utm_content', 'id_do_clique', 'tipo_do_id', 'aparelho', 'primeiro_contato_origem',
      'primeiro_contato_midia', 'primeiro_contato_campanha', 'primeiro_contato_data', 'url', 'webhook'];
    const lines = leads.map((l) => [
      fmt.datetime(l.created_at), l.name, l.phone, l.message, l.page_name || l.page_path, l.source,
      l.channel ? CHANNELS[l.channel] || l.channel : '', l.utm_source, l.utm_medium, l.utm_campaign, l.utm_term, l.utm_content,
      l.click_id, l.click_type, l.device, l.first_source, l.first_medium, l.first_campaign, l.first_seen ? fmt.datetime(l.first_seen) : '',
      l.page_url, l.webhook_status,
    ].map(esc).join(','));
    res.set('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + head.map(esc).join(',') + '\n' + lines.join('\n'));
  });

  // ── Ficha do lead: origem, primeiro contato, jornada e parâmetros ────────
  const journey = makeJourney(db);
  app.get('/admin/leads/:id', requireAuth, (req, res) => {
    const lead = q.lead.get(parseInt(req.params.id, 10) || 0);
    if (!lead) {
      res.status(404);
      return render(req, res, 'error', { title: 'Lead não encontrado', message: 'Esse lead não existe mais (pode ter sido excluído).' });
    }
    const page = lead.page_id ? pages.get(lead.page_id) : null;
    const backfill = db.prepare("SELECT value FROM meta WHERE key = 'backfill_leads_v1'").get();
    render(req, res, 'lead', {
      title: lead.name || 'Lead', lead, page, siteExiste: !!(page && stmts.get.get(page.slug)),
      j: journey.forLead(lead), params: urlParams(lead.page_url),
      // a versão anterior cortava o endereço em 300 caracteres: o gclid do fim pode estar incompleto
      cortado: !!(lead.page_url && lead.page_url.length === 300 && backfill && lead.created_at < Number(backfill.value)),
      antigo: !!(backfill && lead.created_at < Number(backfill.value)),
      CHANNELS, sourceLabel, medicaoDesde: stats.status(lead.slug).first, ...takeFlash(req),
    });
  });

  app.post('/admin/leads/:id/delete', requireAuth, (req, res) => {
    const lead = q.lead.get(parseInt(req.params.id, 10) || 0);
    if (lead) {
      q.deleteLead.run(lead.id);
      audit(req, 'lead_excluido', `lead #${lead.id} de ${fmt.datetime(lead.created_at)}`);
      req.session.flash = 'Lead excluído.';
    }
    const volta = back(req, '/admin/leads');
    res.redirect(lead && volta.split('?')[0] === `/admin/leads/${lead.id}` ? '/admin/leads' : volta);
  });

  // ── Página: links com UTM ────────────────────────────────────────────────
  app.get('/admin/paginas/:id/links', requireAuth, (req, res) => {
    const ctxp = loadPage(req, res);
    if (!ctxp) return;
    const { page } = ctxp;
    const period = parsePeriod(req.query);
    const links = q.links.all(page.id).map((l) => ({ ...l, url: utmUrl(page, l), ...stats.linkStats(page, l, period.from, period.to) }));
    const draft = req.session.linkDraft || null;
    req.session.linkDraft = null;
    render(req, res, 'page-links', {
      title: `Links com UTM · ${page.name}`, page, tab: 'links', period, links, draft,
      baseUrl: pageUrl(page), ...takeFlash(req),
    });
  });

  app.post('/admin/paginas/:id/links', requireAuth, (req, res) => {
    const ctxp = loadPage(req, res);
    if (!ctxp) return;
    const { page } = ctxp;
    const l = {
      name: String(req.body.name || '').trim().slice(0, 80),
      source: utmValue(req.body.source), medium: utmValue(req.body.medium), campaign: utmValue(req.body.campaign, 150),
      content: utmValue(req.body.content, 150) || null, term: utmValue(req.body.term, 150) || null,
    };
    if (!l.name || !l.source || !l.medium || !l.campaign) {
      req.session.flashWarn = 'Preencha nome, origem, mídia e campanha.';
      req.session.linkDraft = { ...req.body };
      return res.redirect(`/admin/paginas/${page.id}/links`);
    }
    q.insertLink.run(page.id, l.name, l.source, l.medium, l.campaign, l.term, l.content, req.user.id, Date.now());
    audit(req, 'link_criado', `${page.path}: ${l.name}`);
    req.session.flash = `Link "${l.name}" salvo. Copie o endereço na lista abaixo.`;
    res.redirect(`/admin/paginas/${page.id}/links`);
  });

  app.post('/admin/paginas/:id/links/:lid/delete', requireAuth, (req, res) => {
    const ctxp = loadPage(req, res);
    if (!ctxp) return;
    const link = q.link.get(parseInt(req.params.lid, 10) || 0, ctxp.page.id);
    if (link) {
      q.deleteLink.run(link.id, ctxp.page.id);
      audit(req, 'link_excluido', `${ctxp.page.path}: ${link.name}`);
      req.session.flash = 'Link excluído. Os acessos que ele trouxe continuam nos números.';
    }
    res.redirect(`/admin/paginas/${ctxp.page.id}/links`);
  });

  // ── Página: configurações ────────────────────────────────────────────────
  app.get('/admin/paginas/:id/config', requireAuth, (req, res) => {
    const ctxp = loadPage(req, res);
    if (!ctxp) return;
    const d = req.session.cfgDraft && req.session.cfgDraft.pageId === ctxp.page.id ? req.session.cfgDraft : null;
    req.session.cfgDraft = null;
    render(req, res, 'page-config', {
      title: `Configurações · ${ctxp.page.name}`, page: ctxp.page, lp: ctxp.lp, tab: 'config', KINDS,
      pageUrl: pageUrl(ctxp.page), draft: d, ...takeFlash(req),
    });
  });

  app.post('/admin/paginas/:id/config', requireAuth, ah(async (req, res) => {
    const ctxp = loadPage(req, res);
    if (!ctxp) return;
    const { page } = ctxp;
    const name = String(req.body.name || '').trim().slice(0, 80) || page.name;
    const kind = KINDS[req.body.kind] ? req.body.kind : page.kind;
    // para onde vão os leads é decisão do super admin; o admin muda só nome e tipo
    const url = req.user.role === 'super' ? String(req.body.webhook_url || '').trim() : (page.webhook_url || '');
    const problem = url && url !== (page.webhook_url || '') ? await webhookProblem(url) : null;
    pages.rename(page.id, name, kind);
    if (name !== page.name || kind !== page.kind) audit(req, 'pagina_alterada', `${page.path}: ${name} (${KINDS[kind]})`);
    if (problem) {
      req.session.flashWarn = `Nome e tipo salvos. Webhook não salvo: ${problem}.`;
      req.session.cfgDraft = { pageId: page.id, webhook_url: url };
      return res.redirect(`/admin/paginas/${page.id}/config`);
    }
    if ((page.webhook_url || '') !== url) {
      pages.setWebhook(page.id, url || null);
      audit(req, 'webhook_alterado', `${page.path}: ${url || '(usa o do site)'}`);
    }
    req.session.flash = 'Configurações salvas.';
    res.redirect(`/admin/paginas/${page.id}/config`);
  }));

  // Testa o endereço digitado no campo (sem salvar) ou, vazio, o que vale hoje.
  app.post('/admin/paginas/:id/webhook/test', requireSuper, ah(async (req, res) => {
    const ctxp = loadPage(req, res);
    if (!ctxp) return;
    const { page, lp } = ctxp;
    const typed = String(req.body.webhook_url || '').trim();
    const url = typed || webhookFor(lp, page);
    if (!url) {
      req.session.flashWarn = 'Nenhum webhook digitado nem configurado para esta página ou para o site.';
      return res.redirect(`/admin/paginas/${page.id}/config`);
    }
    const status = await fireWebhook(lp, testLead(page), page, url);
    audit(req, 'webhook_testado', `${page.path} → ${status}`);
    if (typed && typed !== (page.webhook_url || '')) req.session.cfgDraft = { pageId: page.id, webhook_url: typed };
    const ok = status.startsWith('ok');
    req.session[ok ? 'flash' : 'flashWarn'] = `Teste para ${url}: ${ok ? 'recebido' : 'falhou'} (${status}).`
      + (typed && typed !== (page.webhook_url || '') ? ' O endereço ainda não foi salvo.' : '');
    res.redirect(`/admin/paginas/${page.id}/config`);
  }));

  // ── Usuários (super admin) ───────────────────────────────────────────────
  app.get('/admin/usuarios', requireSuper, (req, res) => {
    const shown = req.session.newPassword || null;
    const draft = req.session.userDraft || null;
    req.session.newPassword = null;
    req.session.userDraft = null;
    render(req, res, 'users', {
      title: 'Usuários', users: q.users.all(), shown, draft,
      panelUrl: `${req.protocol}://${req.get('host')}/admin`, ...takeFlash(req),
    });
  });

  app.post('/admin/usuarios', requireSuper, ah(async (req, res) => {
    const email = normEmail(req.body.email);
    const name = String(req.body.name || '').trim().slice(0, 80);
    const role = req.body.role === 'super' ? 'super' : 'admin';
    const typed = String(req.body.password || '');
    const fail = (msg) => {
      req.session.flashWarn = msg;
      req.session.userDraft = { email, name, role };
      res.redirect('/admin/usuarios');
    };
    if (!name) return fail('Informe o nome.');
    if (!validEmail(email)) return fail('E-mail inválido.');
    if (userQ.byEmail.get(email)) return fail('Já existe um usuário com esse e-mail.');
    const pw = typed || tempPassword();
    const problem = passwordProblem(pw, email);
    if (problem) return fail(problem);
    const hash = await hashPassword(pw);
    const now = Date.now();
    try {
      q.insertUser.run(email, name, hash, role, now, req.user.id, now, now);
    } catch (e) {
      // dois envios ao mesmo tempo: o segundo chega aqui depois do primeiro gravar
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const ja = userQ.byEmail.get(email);
        if (ja && ja.created_by === req.user.id && Date.now() - ja.created_at < 15000) return res.redirect('/admin/usuarios');
        return fail('Já existe um usuário com esse e-mail.');
      }
      throw e;
    }
    audit(req, 'usuario_criado', `${email} (${role === 'super' ? 'Super admin' : 'Admin'})`);
    req.session.newPassword = { email, name, password: pw, created: true };
    res.redirect('/admin/usuarios');
  }));

  function loadUser(req, res) {
    const u = userQ.byId.get(parseInt(req.params.id, 10) || 0);
    if (!u) { req.session.flashWarn = 'Usuário não encontrado.'; res.redirect('/admin/usuarios'); return null; }
    return u;
  }
  const lastSuper = (u) => u.role === 'super' && u.active && q.supers.get().n <= 1;

  app.post('/admin/usuarios/:id', requireSuper, (req, res) => {
    const u = loadUser(req, res);
    if (!u) return;
    const name = String(req.body.name || '').trim().slice(0, 80) || u.name;
    const role = req.body.role === 'super' ? 'super' : 'admin';
    if (role !== u.role && (u.id === req.user.id || lastSuper(u))) {
      req.session.flashWarn = u.id === req.user.id ? 'Você não pode mudar o seu próprio papel.' : 'O painel precisa de pelo menos um super admin ativo.';
      return res.redirect('/admin/usuarios');
    }
    q.updateUser.run(name, role, Date.now(), u.id);
    audit(req, 'usuario_alterado', `${u.email}: ${name}, ${role === 'super' ? 'Super admin' : 'Admin'}`);
    req.session.flash = 'Usuário atualizado.';
    res.redirect('/admin/usuarios');
  });

  app.post('/admin/usuarios/:id/status', requireSuper, (req, res) => {
    const u = loadUser(req, res);
    if (!u) return;
    if (u.id === req.user.id || (u.active && lastSuper(u))) {
      req.session.flashWarn = u.id === req.user.id ? 'Você não pode desativar a sua própria conta.' : 'O painel precisa de pelo menos um super admin ativo.';
      return res.redirect('/admin/usuarios');
    }
    const active = u.active ? 0 : 1;
    q.setActive.run(active, Date.now(), u.id);
    if (!active) sessionStore.endUser(u.id);
    audit(req, active ? 'usuario_reativado' : 'usuario_desativado', u.email);
    req.session.flash = active ? `${u.name} pode entrar de novo.` : `${u.name} foi desativado e saiu do painel.`;
    res.redirect('/admin/usuarios');
  });

  app.post('/admin/usuarios/:id/senha', requireSuper, ah(async (req, res) => {
    const u = loadUser(req, res);
    if (!u) return;
    if (u.id === req.user.id) {
      req.session.flashWarn = 'Para trocar a sua senha, use "Minha conta".';
      return res.redirect('/admin/usuarios');
    }
    const pw = tempPassword();
    const now = Date.now();
    q.setPassword.run(await hashPassword(pw), 1, now, now, u.id);
    sessionStore.endUser(u.id);
    audit(req, 'senha_redefinida', u.email);
    req.session.newPassword = { email: u.email, name: u.name, password: pw, created: false };
    res.redirect('/admin/usuarios');
  }));

  app.post('/admin/usuarios/:id/excluir', requireSuper, (req, res) => {
    const u = loadUser(req, res);
    if (!u) return;
    if (u.id === req.user.id || lastSuper(u)) {
      req.session.flashWarn = u.id === req.user.id ? 'Você não pode excluir a sua própria conta.' : 'O painel precisa de pelo menos um super admin ativo.';
      return res.redirect('/admin/usuarios');
    }
    q.deleteUser.run(u.id);
    sessionStore.endUser(u.id);
    audit(req, 'usuario_excluido', u.email);
    req.session.flash = `${u.name} foi excluído.`;
    res.redirect('/admin/usuarios');
  });

  // ── Minha conta ──────────────────────────────────────────────────────────
  app.get('/admin/conta', requireAuth, (req, res) => {
    render(req, res, 'account', { title: 'Minha conta', ...takeFlash(req) });
  });

  app.post('/admin/conta', requireAuth, (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 80);
    if (name && name !== req.user.name) q.setName.run(name, Date.now(), req.user.id);
    req.session.flash = 'Nome atualizado.';
    res.redirect('/admin/conta');
  });

  app.get('/admin/conta/senha', requireAuth, (req, res) => {
    render(req, res, 'password', { title: 'Trocar senha', forced: !!req.user.must_change_password, ...takeFlash(req) });
  });

  app.post('/admin/conta/senha', requireAuth, ah(async (req, res) => {
    const forced = !!req.user.must_change_password;
    const fail = (msg) => {
      res.status(400);
      render(req, res, 'password', { title: 'Trocar senha', forced, flashWarn: msg, flash: null });
    };
    if (!forced && !(await verifyPassword(String(req.body.current || ''), req.user.password_hash))) return fail('A senha atual não confere.');
    const pw = String(req.body.password || '');
    const problem = passwordProblem(pw, req.user.email);
    if (problem) return fail(problem);
    if (pw !== String(req.body.confirm || '')) return fail('A confirmação não é igual à nova senha.');
    if (await verifyPassword(pw, req.user.password_hash)) return fail('A nova senha precisa ser diferente da atual.');
    const now = Date.now();
    q.setPassword.run(await hashPassword(pw), 0, now, now, req.user.id);
    req.session.pwdAt = now;
    sessionStore.endUser(req.user.id, req.sessionID);
    audit(req, 'senha_alterada');
    req.session.flash = forced ? 'Senha definida. Bem-vindo ao painel.' : 'Senha trocada. As outras sessões abertas foram encerradas.';
    req.session.save(() => res.redirect(forced ? '/admin' : '/admin/conta'));
  }));

  // ── Atividade (super admin) ──────────────────────────────────────────────
  app.get('/admin/atividade', requireSuper, (req, res) => {
    const tipo = ['acessos', 'alteracoes'].includes(req.query.tipo) ? req.query.tipo : '';
    const antes = parseInt(req.query.antes, 10) || Number.MAX_SAFE_INTEGER;
    const rows = q.auditList.all(antes, tipo, tipo, tipo);
    const mais = rows.length > 100 ? rows[99].id : null;
    render(req, res, 'activity', { title: 'Atividade', rows: rows.slice(0, 100), ACTIONS, tipo, mais, primeira: antes === Number.MAX_SAFE_INTEGER });
  });
}
