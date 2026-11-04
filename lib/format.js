import { TZ_OFFSET } from './stats.js';

// ── Formatação para as telas (pt-BR, horário de Brasília) ───────────────────

const nf = new Intl.NumberFormat('pt-BR');
const nf1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const int = (n) => (n == null ? '-' : nf.format(Math.round(n)));

export function pct(x, digits = 1) {
  if (x == null || !Number.isFinite(x)) return '-';
  const v = x * 100;
  return (digits === 1 ? nf1.format(v) : nf.format(Math.round(v))) + '%';
}

export function dur(ms) {
  if (ms == null) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return r ? `${m} min ${r} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

// Variação contra o período anterior. Sem base (zero ou sem dado) não mostra nada.
export function delta(cur, prev) {
  if (cur == null || prev == null || !Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) return null;
  const d = (cur - prev) / Math.abs(prev);
  if (Math.abs(d) < 0.005) return { dir: 'flat', text: 'igual' };
  return { dir: d > 0 ? 'up' : 'down', text: (d > 0 ? '+' : '-') + nf.format(Math.round(Math.abs(d) * 100)) + '%' };
}

function parts(ts) {
  const d = new Date(ts + TZ_OFFSET);
  const p = (n) => String(n).padStart(2, '0');
  return { d: p(d.getUTCDate()), m: p(d.getUTCMonth() + 1), y: d.getUTCFullYear(), h: p(d.getUTCHours()), mi: p(d.getUTCMinutes()) };
}

export function date(ts) {
  if (!ts) return '-';
  const x = parts(ts);
  return `${x.d}/${x.m}/${x.y}`;
}

export function datetime(ts) {
  if (!ts) return '-';
  const x = parts(ts);
  return `${x.d}/${x.m}/${x.y} ${x.h}:${x.mi}`;
}

export function rel(ts, now = Date.now()) {
  if (!ts) return 'nunca';
  const s = Math.round((now - ts) / 1000);
  if (s < 60) return 'agora mesmo';
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'ontem' : `há ${d} dias`;
}

export function bytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1).replace('.', ',') + ' KB';
  return (b / 1024 / 1024).toFixed(2).replace('.', ',') + ' MB';
}

export function digits(v) {
  return String(v || '').replace(/\D/g, '');
}

// Link do WhatsApp para o telefone do lead (acrescenta o 55 quando falta).
export function waLink(phone) {
  const d = digits(phone);
  if (!d) return null;
  return 'https://wa.me/' + (d.length <= 11 ? '55' + d : d);
}

// Endereço curto para mostrar na tela: domínio e caminho, sem a query (que costuma
// levar o token do webhook) e cortado no meio do caminho quando é longo.
export function curto(raw, max = 44) {
  let u;
  try { u = new URL(String(raw || '')); } catch (_) { return ''; }
  const s = u.host + (u.pathname === '/' ? '' : u.pathname);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
