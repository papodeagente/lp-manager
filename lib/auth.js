import crypto from 'node:crypto';
import { promisify } from 'node:util';
import session from 'express-session';

// ── Senhas ────────────────────────────────────────────────────────────────
// scrypt do próprio Node (sem dependência nova), sal por usuário. Formato sem
// "$" para a variável de ambiente do Coolify não tentar interpolar:
//   scrypt:N:r:p:<sal base64url>:<hash base64url>
const scryptAsync = promisify(crypto.scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1 };
const MAXMEM = 96 * 1024 * 1024;

const b64 = (buf) => Buffer.from(buf).toString('base64url');

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(String(pw).normalize('NFKC'), salt, 64, { ...SCRYPT, maxmem: MAXMEM });
  return `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${b64(salt)}:${b64(key)}`;
}

export function isPasswordHash(s) {
  return /^scrypt:\d+:\d+:\d+:[A-Za-z0-9_-]{16,}:[A-Za-z0-9_-]{40,}$/.test(String(s || ''));
}

// Hash de mentira usado quando o e-mail não existe: o tempo de resposta fica igual
// e não dá para descobrir quais e-mails têm conta.
let dummyHash = null;

export async function verifyPassword(pw, stored) {
  const real = isPasswordHash(stored);
  if (!real) {
    dummyHash = dummyHash || await hashPassword(crypto.randomBytes(16).toString('hex'));
    stored = dummyHash;
  }
  const [, N, r, p, salt, hash] = stored.split(':');
  const expected = Buffer.from(hash, 'base64url');
  const key = await scryptAsync(String(pw).normalize('NFKC'), Buffer.from(salt, 'base64url'), expected.length,
    { N: +N, r: +r, p: +p, maxmem: MAXMEM });
  return crypto.timingSafeEqual(key, expected) && real;
}

const COMMON = new Set(['12345678', '123456789', '1234567890', 'password', 'password1', 'senha123', 'senha1234',
  'qwerty123', '11111111', '00000000', 'abc12345', 'mudar123', 'admin123', 'iloveyou', 'brasil123']);

// Regras: 8 a 200 caracteres, não pode ser o próprio e-mail nem uma senha óbvia.
export function passwordProblem(pw, email) {
  const s = String(pw || '');
  if (s.length < 8) return 'A senha precisa ter pelo menos 8 caracteres.';
  if (s.length > 200) return 'A senha pode ter no máximo 200 caracteres.';
  if (email && s.toLowerCase() === String(email).toLowerCase()) return 'A senha não pode ser o seu e-mail.';
  if (COMMON.has(s.toLowerCase()) || /^(.)\1+$/.test(s)) return 'Essa senha é fácil de adivinhar. Escolha outra.';
  return null;
}

// Senha provisória legível: 3 blocos de 4, sem caracteres que se confundem (0/O, 1/l).
export function tempPassword() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) {
    if (i && i % 4 === 0) out += '-';
    out += abc[bytes[i] % abc.length];
  }
  return out;
}

export function normEmail(s) {
  return String(s || '').trim().toLowerCase().slice(0, 200);
}

export function validEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// ── Sessões do painel no próprio SQLite ──────────────────────────────────────
// O padrão do express-session guarda na memória: todo deploy derrubava o login e
// o processo crescia sem limite. Aqui ficam numa tabela, com o id do usuário em
// coluna própria para dar para encerrar as sessões de alguém de uma vez.
export class SqliteStore extends session.Store {
  constructor(db) {
    super();
    this.q = {
      get: db.prepare('SELECT sess, expires FROM admin_sessions WHERE sid = ?'),
      set: db.prepare(`INSERT INTO admin_sessions (sid, user_id, sess, expires) VALUES (?, ?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET user_id = excluded.user_id, sess = excluded.sess, expires = excluded.expires`),
      touch: db.prepare('UPDATE admin_sessions SET expires = ? WHERE sid = ?'),
      destroy: db.prepare('DELETE FROM admin_sessions WHERE sid = ?'),
      destroyUser: db.prepare('DELETE FROM admin_sessions WHERE user_id = ?'),
      destroyUserExcept: db.prepare('DELETE FROM admin_sessions WHERE user_id = ? AND sid <> ?'),
      prune: db.prepare('DELETE FROM admin_sessions WHERE expires < ?'),
    };
    const t = setInterval(() => { try { this.q.prune.run(Date.now()); } catch (_) {} }, 15 * 60 * 1000);
    t.unref();
  }
  static expiresOf(sess) {
    const e = sess?.cookie?.expires;
    return e ? new Date(e).getTime() : Date.now() + 24 * 3600 * 1000;
  }
  get(sid, cb) {
    try {
      const row = this.q.get.get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      this.q.set.run(sid, sess.uid || null, JSON.stringify(sess), SqliteStore.expiresOf(sess));
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  touch(sid, sess, cb) {
    try { this.q.touch.run(SqliteStore.expiresOf(sess), sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) {
    try { this.q.destroy.run(sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
  // encerra todas as sessões de um usuário (menos, opcionalmente, a atual)
  endUser(userId, exceptSid) {
    if (exceptSid) this.q.destroyUserExcept.run(userId, exceptSid);
    else this.q.destroyUser.run(userId);
  }
}

// ── Tentativas de login ──────────────────────────────────────────────────────
// Cada tentativa é contada ANTES de conferir a senha (o scrypt é assíncrono; contar
// depois deixava uma rajada de pedidos simultâneos passar do limite) e descontada
// quando dá certo. Bloqueio rígido só pelo par e-mail + IP (8 erros em 15 minutos)
// e pelo IP (30 erros), para quem ataca de fora não trancar o dono: pelo e-mail
// sozinho, a resposta só fica mais lenta (1 s, 2 s, 4 s... até 30 s).
const WINDOW = 15 * 60 * 1000;
const fails = new Map();

function recent(key) {
  const now = Date.now();
  const arr = (fails.get(key) || []).filter((t) => now - t < WINDOW);
  if (arr.length) fails.set(key, arr); else fails.delete(key);
  return arr;
}

const keysOf = (ip, email) => ['ip:' + ip, 'em:' + email, 'par:' + email + '|' + ip];

// Registra a tentativa e diz se ela pode seguir. Quem recebe { ok: true } chama
// loginSucceeded() se a senha conferir; se não conferir, a tentativa já está contada.
export function loginAttempt(ip, email) {
  const [kIp, kEm, kPar] = keysOf(ip, email);
  if (recent(kIp).length >= 30 || recent(kPar).length >= 8) {
    const firstBlock = !blockedLogged.has(kPar);
    blockedLogged.add(kPar);
    return { ok: false, firstBlock };
  }
  const n = recent(kEm).length;
  const now = Date.now();
  for (const k of [kIp, kEm, kPar]) { const arr = recent(k); arr.push(now); fails.set(k, arr); }
  return { ok: true, delayMs: n >= 8 ? Math.min(30000, 1000 * 2 ** (n - 8)) : 0, stamp: now };
}

export function loginSucceeded(ip, email, stamp) {
  const [kIp, kEm, kPar] = keysOf(ip, email);
  fails.delete(kEm);
  fails.delete(kPar);
  blockedLogged.delete(kPar);
  const arr = recent(kIp);
  const i = arr.lastIndexOf(stamp);
  if (i !== -1) arr.splice(i, 1);
}

// bloqueios já registrados na Atividade (uma linha por bloqueio, não por pedido)
const blockedLogged = new Set();

setInterval(() => {
  for (const k of fails.keys()) recent(k);
  for (const k of blockedLogged) if (!fails.has(k)) blockedLogged.delete(k);
}, 60 * 1000).unref();

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Pedidos de outro site ────────────────────────────────────────────────────
// O cookie do painel já é SameSite=Lax; aqui, além disso, todo POST precisa vir
// da própria origem do painel (cabeçalhos Origin/Sec-Fetch-Site/Referer). Só o
// pedido com o token de publicação válido passa sem essa conferência.
export const sameOriginOnly = (tokenOk) => (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (tokenOk(req)) return next();
  const host = (req.get('host') || '').toLowerCase();
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return refuse(res);
  const origin = req.get('origin');
  if (origin && origin !== 'null') {
    try { if (new URL(origin).host.toLowerCase() !== host) return refuse(res); } catch { return refuse(res); }
  } else if (origin === 'null') {
    return refuse(res);
  } else {
    const ref = req.get('referer');
    if (ref) { try { if (new URL(ref).host.toLowerCase() !== host) return refuse(res); } catch { return refuse(res); } }
  }
  next();
};

function refuse(res) {
  res.status(403).type('text/plain').send('Pedido recusado: ele não veio do próprio painel. Recarregue a página e tente de novo.');
}

// Compara o token de publicação em tempo constante.
export function tokenMatches(given, expected) {
  if (!given || !expected) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// Para onde voltar depois do login: só caminhos do próprio painel.
export function safeNext(raw) {
  const s = String(raw || '');
  return /^\/admin(?:[/?][A-Za-z0-9\-._~%/?=&+]*)?$/.test(s) && !s.includes('//') && !s.includes('/login') ? s : '/admin';
}
