// Regras puras do painel: origem das visitas, caminhos das páginas, UTM, senhas e período.
// Rodar com: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { campaignFrom, referrerFrom, channelOf, deviceOf, isBot, injectTracker, leadAttributionFromUrl, parseCookies } from '../lib/tracking.js';
import { pathForFile, normalizePath, pathOfUrl, kindForPath } from '../lib/pages.js';
import { hashPassword, verifyPassword, isPasswordHash, passwordProblem, tempPassword, safeNext, normEmail } from '../lib/auth.js';
import { parsePeriod, dayIndex, dayStart } from '../lib/stats.js';
import { utmValue, utmUrl } from '../lib/admin.js';
import { delta, dur, pct } from '../lib/format.js';

const q = (s) => new URLSearchParams(s);
const pick = (r) => [r.source, r.medium];

test('anúncio do Google com UTM e gclid', () => {
  const a = campaignFrom(q('utm_source=Google&utm_medium=CPC&utm_campaign=hipro_bsb&utm_term=flacidez%20rosto&gclid=abc'), null);
  assert.equal(a.source, 'google');
  assert.equal(a.medium, 'cpc');
  assert.equal(a.term, 'flacidez rosto');
  assert.equal(a.click_type, 'gclid');
  assert.equal(channelOf(a), 'google_ads');
});

test('só gclid, gbraid ou gad_source viram Google Ads', () => {
  for (const s of ['gclid=1', 'gbraid=2', 'wbraid=3', 'gad_source=1&gad_campaignid=99']) {
    const a = campaignFrom(q(s), null);
    assert.equal(a.source, 'google', s);
    assert.equal(channelOf(a), 'google_ads', s);
  }
});

test('Meta: parâmetros dinâmicos e fbclid sozinho', () => {
  assert.equal(channelOf(campaignFrom(q('utm_source=ig&utm_medium=paid_social&utm_campaign=x'), null)), 'meta_ads');
  assert.equal(channelOf(campaignFrom(q('utm_source=fb&utm_medium=paid'), null)), 'meta_ads');
  const ref = referrerFrom('https://l.instagram.com/', 'draglazi.com.br');
  const a = campaignFrom(q('fbclid=xyz'), ref);
  assert.deepEqual([a.source, a.medium, channelOf(a)], ['instagram', 'social', 'social']);
});

test('URL sem campanha não abre campanha', () => {
  assert.equal(campaignFrom(q('foo=1&lpm=test'), null), null);
});

test('referrers: busca, IA, redes, app Android, interno', () => {
  const site = 'draglazi.com.br';
  assert.deepEqual(pick(referrerFrom('https://www.google.com.br/', site)), ['google', 'organic']);
  assert.deepEqual(pick(referrerFrom('https://gemini.google.com/app', site)), ['gemini', 'ia']);
  assert.deepEqual(pick(referrerFrom('https://chatgpt.com/', site)), ['chatgpt', 'ia']);
  assert.deepEqual(pick(referrerFrom('https://m.facebook.com/', site)), ['facebook', 'social']);
  assert.deepEqual(pick(referrerFrom('android-app://com.google.android.googlequicksearchbox/', site)), ['google', 'organic']);
  assert.deepEqual(pick(referrerFrom('https://exemplo.com.br/post', site)), ['exemplo.com.br', 'referral']);
  assert.equal(referrerFrom('https://www.draglazi.com.br/fullface', site), null);
  assert.equal(referrerFrom('https://admin.draglazi.com.br/admin', site), null);
  assert.equal(referrerFrom('', site), null);
  assert.equal(referrerFrom('javascript:alert(1)', site), null);
  assert.equal(channelOf({ source: 'google', medium: 'organic' }), 'busca');
  assert.equal(channelOf({ source: 'chatgpt', medium: 'ia' }), 'ia');
  assert.equal(channelOf({ source: 'exemplo.com.br', medium: 'referral' }), 'sites');
  assert.equal(channelOf({ source: '(direct)', medium: '(none)' }), 'direto');
  assert.equal(channelOf({ source: 'whatsapp', medium: 'mensagem' }), 'whatsapp');
  assert.equal(channelOf({ source: 'newsletter', medium: 'email' }), 'email');
});

test('aparelho e robôs', () => {
  assert.equal(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile/15E148', 5), 'celular');
  assert.equal(deviceOf('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Safari/537.36', 5), 'tablet');
  assert.equal(deviceOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.5 Safari/605.1.15', 5), 'tablet');
  assert.equal(deviceOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0 Safari/537.36', 0), 'computador');
  assert.ok(isBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'));
  assert.ok(isBot('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0 Safari/537.36'));
  assert.ok(isBot('WhatsApp/2.23.20.0 A'));
  assert.ok(isBot('curl/8.4.0'));
  assert.ok(!isBot('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0.0.0'));
  assert.ok(!isBot('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 [FBAN/EMA;FBLC/pt_BR]'));
});

test('lead antigo: origem pela URL', () => {
  const a = leadAttributionFromUrl('https://draglazi.com.br/?utm_source=google&utm_medium=cpc&utm_campaign=hipro_bsb&utm_term=flacidez&gbraid=x');
  assert.deepEqual([a.utm_source, a.utm_campaign, a.utm_term, a.click_type, a.channel], ['google', 'hipro_bsb', 'flacidez', 'gbraid', 'google_ads']);
  assert.equal(leadAttributionFromUrl('').channel, 'direto');
  assert.equal(leadAttributionFromUrl('lixo').channel, 'direto');
});

test('script da medição entra antes de </head>', () => {
  assert.equal(injectTracker('<html><head><title>x</title></head><body></body></html>', 'v1'),
    '<html><head><title>x</title><script src="/_lpm/t.js?v=v1" defer></script></head><body></body></html>');
  assert.ok(injectTracker('<p>sem head</p></body>', 'v1').includes('<script src="/_lpm/t.js?v=v1" defer></script></body>'));
});

test('cookies', () => {
  assert.deepEqual(parseCookies('a=1; _lpm_v=abc; b=x=y'), { a: '1', _lpm_v: 'abc', b: 'x=y' });
});

test('caminho de cada arquivo e de cada URL', () => {
  assert.equal(pathForFile('index.html', 'index.html'), '/');
  assert.equal(pathForFile('fullface.html', 'index.html'), '/fullface');
  assert.equal(pathForFile('obrigado.html', 'index.html'), '/obrigado');
  assert.equal(pathForFile('promo/index.html', 'index.html'), '/promo');
  assert.equal(pathForFile('home.html', 'home.html'), '/');
  for (const [u, p] of [['/', '/'], ['/index.html', '/'], ['/fullface', '/fullface'], ['/fullface/', '/fullface'], ['/fullface.html', '/fullface'], ['/x/index.html', '/x'], ['//a//b/', '/a/b']]) {
    assert.equal(normalizePath(u), p, u);
  }
  assert.equal(pathOfUrl('https://draglazi.com.br/fullface?utm_source=x#topo'), '/fullface');
  assert.equal(pathOfUrl('nada'), null);
  assert.equal(kindForPath('/obrigado'), 'thanks');
  assert.equal(kindForPath('/fullface'), 'landing');
});

test('UTM no padrão: minúsculas, sem acento, hífen', () => {
  assert.equal(utmValue(' Perfil Clínica  Novembro '), 'perfil-clinica-novembro');
  assert.equal(utmValue('Bio/Instagram'), 'bio-instagram');
  assert.equal(utmValue('{{campaign.name}}'), '{{campaign.name}}');
  assert.equal(utmValue('<script>'), 'script');
  assert.equal(utmUrl({ domain: 'draglazi.com.br', path: '/fullface' }, { source: 'instagram', medium: 'social', campaign: 'perfil', content: 'bio' }),
    'https://draglazi.com.br/fullface?utm_source=instagram&utm_medium=social&utm_campaign=perfil&utm_content=bio');
});

test('senha: hash, conferência e regras', async () => {
  const h = await hashPassword('Senha-de-Teste-123');
  assert.ok(isPasswordHash(h));
  assert.ok(!h.includes('$'));
  assert.equal(await verifyPassword('Senha-de-Teste-123', h), true);
  assert.equal(await verifyPassword('senha-de-teste-123', h), false);
  assert.equal(await verifyPassword('qualquer', null), false);
  assert.equal(await verifyPassword('qualquer', 'texto-que-nao-e-hash'), false);
  assert.ok(passwordProblem('curta'));
  assert.ok(passwordProblem('12345678'));
  assert.ok(passwordProblem('aaaaaaaaaa'));
  assert.ok(passwordProblem('ana@exemplo.com', 'ana@exemplo.com'));
  assert.equal(passwordProblem('Exemplo1990#'), null);
  assert.match(tempPassword(), /^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);
  assert.equal(normEmail('  Ana@Exemplo.COM '), 'ana@exemplo.com');
});

test('volta depois do login só para dentro do painel', () => {
  assert.equal(safeNext('/admin/leads?p=7d'), '/admin/leads?p=7d');
  assert.equal(safeNext('/admin?p=7d'), '/admin?p=7d');
  assert.equal(safeNext('https://evil.example'), '/admin');
  assert.equal(safeNext('//evil.example'), '/admin');
  assert.equal(safeNext('/admin//evil.example'), '/admin');
  assert.equal(safeNext('/admin/login'), '/admin');
  assert.equal(safeNext('/administrador'), '/admin');
});

test('período no horário de Brasília', () => {
  const now = Date.UTC(2026, 10, 4, 2, 30); // 03/11 23h30 em Brasília
  const p = parsePeriod({ p: 'hoje' }, now);
  assert.equal(p.from, Date.UTC(2026, 10, 3, 3, 0));
  assert.equal(p.hourly, true);
  assert.equal(p.de, '2026-11-03');
  const s = parsePeriod({ p: '7d' }, now);
  assert.equal(s.len, 7);
  assert.equal(s.prev.to - s.prev.from, s.to - s.from);
  const c = parsePeriod({ p: 'custom', de: '2026-11-03', ate: '2026-10-01' }, now);
  assert.deepEqual([c.de, c.ate, c.len], ['2026-10-01', '2026-11-03', 34]);
  assert.equal(parsePeriod({ p: 'custom', de: 'x' }, now).key, '30d');
  assert.equal(parsePeriod({ p: 'qualquer' }, now).key, '30d');
  assert.equal(dayStart(dayIndex(now)), Date.UTC(2026, 10, 3, 3, 0));
});

test('formatação', () => {
  assert.equal(dur(72000), '1 min 12 s');
  assert.equal(dur(9000), '9 s');
  assert.equal(pct(0.333), '33,3%');
  assert.equal(delta(10, 0), null);
  assert.deepEqual(delta(12, 10), { dir: 'up', text: '+20%' });
  assert.deepEqual(delta(8, 10), { dir: 'down', text: '-20%' });
});

test('webhook: só destino público, nunca rede interna', async () => {
  const { webhookProblem } = await import('../lib/webhook.js');
  const antes = process.env.WEBHOOK_ALLOW_PRIVATE;
  delete process.env.WEBHOOK_ALLOW_PRIVATE;
  try {
    for (const u of ['http://127.0.0.1:3000/x', 'https://10.1.2.3/', 'https://169.254.169.254/latest', 'https://192.168.0.10/', 'https://172.20.0.5/',
      'https://[::1]/', 'https://[fd00::1]/', 'http://0.0.0.0/']) {
      assert.ok(await webhookProblem(u), u);
    }
    assert.ok(await webhookProblem('ftp://8.8.8.8/x'));
    assert.ok(await webhookProblem('não é url'));
    assert.equal(await webhookProblem('https://8.8.8.8/hook'), null);
  } finally {
    if (antes !== undefined) process.env.WEBHOOK_ALLOW_PRIVATE = antes;
  }
});

test('login: bloqueio por e-mail+IP, dono entra de outro IP, rajada não passa do limite', async () => {
  const { loginAttempt, loginSucceeded } = await import('../lib/auth.js');
  const email = 'dono-' + Date.now() + '@exemplo.com';
  // 8 tentativas erradas do mesmo IP (contadas antes da senha, como numa rajada)
  for (let i = 0; i < 8; i++) assert.equal(loginAttempt('203.0.113.9', email).ok, true, 'tentativa ' + (i + 1));
  const bloqueado = loginAttempt('203.0.113.9', email);
  assert.equal(bloqueado.ok, false);
  assert.equal(bloqueado.firstBlock, true);
  assert.equal(loginAttempt('203.0.113.9', email).firstBlock, false);
  // de outro IP o dono ainda entra, só que com espera
  const outro = loginAttempt('198.51.100.7', email);
  assert.equal(outro.ok, true);
  assert.ok(outro.delayMs >= 1000 && outro.delayMs <= 30000, String(outro.delayMs));
  loginSucceeded('198.51.100.7', email, outro.stamp);
  assert.equal(loginAttempt('198.51.100.7', email).delayMs, 0);
});
