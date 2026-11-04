import dns from 'node:dns/promises';
import net from 'node:net';

// ── Destino de webhook ──────────────────────────────────────────────────────
// O servidor faz POST para o endereço cadastrado; sem esta conferência, um
// endereço interno (127.0.0.1, 10.x, 169.254.x...) faria o servidor sondar a
// própria rede. WEBHOOK_ALLOW_PRIVATE=1 libera só para teste local.

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff');
}

// Motivo para recusar o endereço, ou null quando ele serve.
export async function webhookProblem(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch (_) { return 'endereço inválido'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'use um endereço que comece com https://';
  if (process.env.WEBHOOK_ALLOW_PRIVATE === '1') return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  if (net.isIP(host)) addrs = [host];
  else {
    try { addrs = (await dns.lookup(host, { all: true })).map((a) => a.address); } catch (_) { return 'o domínio do endereço não existe'; }
  }
  if (!addrs.length || addrs.some(privateIp)) return 'endereço de rede interna não é aceito';
  return null;
}
