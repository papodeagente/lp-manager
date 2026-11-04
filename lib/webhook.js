import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

// ── Destino de webhook ──────────────────────────────────────────────────────
// O servidor faz POST para o endereço cadastrado; sem esta conferência, um
// endereço interno (127.0.0.1, 10.x, 169.254.x...) faria o servidor sondar a
// própria rede. A conferência acontece na própria conexão (lookup do socket),
// então um domínio que muda de IP entre a checagem e o envio não escapa.
// WEBHOOK_ALLOW_PRIVATE=1 libera só para teste local.

const blocked = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) {
  blocked.addSubnet(a, p, 'ipv4');
}
// IPv4 escrito como IPv6 (::ffff:127.0.0.1) já cai nas regras de IPv4 acima: o BlockList do Node
// compara os dois formatos. Uma regra ::ffff:0:0/96 aqui bloquearia TODO endereço IPv4.
for (const [a, p] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) {
  blocked.addSubnet(a, p, 'ipv6');
}

const allowPrivate = () => process.env.WEBHOOK_ALLOW_PRIVATE === '1';

export function blockedIp(ip) {
  const v = String(ip || '').replace(/^\[|\]$/g, '');
  if (net.isIPv4(v)) return blocked.check(v, 'ipv4');
  if (net.isIPv6(v)) return blocked.check(v, 'ipv6');
  return true;
}

const BLOCK_MSG = 'endereço de rede interna não é aceito';

function guardedLookup(hostname, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = allowPrivate() ? addrs : addrs.filter((a) => !blockedIp(a.address));
    if (!ok.length) return cb(Object.assign(new Error(BLOCK_MSG), { code: 'EBLOCKED' }));
    if (opts.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

// Motivo para recusar o endereço (na hora de salvar), ou null quando ele serve.
export async function webhookProblem(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch (_) { return 'endereço inválido'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'use um endereço que comece com https://';
  if (allowPrivate()) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return blockedIp(host) ? BLOCK_MSG : null;
  try {
    const addrs = await dns.promises.lookup(host, { all: true });
    if (!addrs.length || addrs.every((a) => blockedIp(a.address))) return BLOCK_MSG;
  } catch (_) { return 'o domínio do endereço não existe'; }
  return null;
}

// POST JSON sem seguir redirecionamento. Devolve o status HTTP.
export function postJson(raw, payload, { timeout = 8000, userAgent = 'lp-manager-webhook/1' } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(raw); } catch (_) { return reject(new Error('endereço inválido')); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return reject(new Error('endereço inválido'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate() && net.isIP(host) && blockedIp(host)) return reject(new Error(BLOCK_MSG));
    const body = JSON.stringify(payload);
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': userAgent },
      lookup: guardedLookup,
      timeout,
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => req.destroy(new Error('tempo esgotado')));
    req.on('error', reject);
    req.end(body);
  });
}
