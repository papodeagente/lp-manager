import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import net from 'node:net';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import maxmind from 'maxmind';

// ── Localização aproximada das visitas (cidade, estado, país) ──────────────
// Base: DB-IP "IP to City Lite" (CC BY 4.0, https://db-ip.com), baixada uma vez
// por mês para DATA_DIR/geo. A consulta é local: nenhum IP sai do servidor e o IP
// da visita não é guardado, só a cidade. Sem a base (download falhou, primeiro
// boot), as visitas ficam sem cidade e o resto segue normal.

export const GEO_CREDIT = { text: 'Localização por DB-IP', url: 'https://db-ip.com' };

// estados do Brasil: nome em inglês da base -> [UF, nome em português]
const UF = {
  'Acre': ['AC', 'Acre'], 'Alagoas': ['AL', 'Alagoas'], 'Amapá': ['AP', 'Amapá'], 'Amapa': ['AP', 'Amapá'],
  'Amazonas': ['AM', 'Amazonas'], 'Bahia': ['BA', 'Bahia'], 'Ceará': ['CE', 'Ceará'], 'Ceara': ['CE', 'Ceará'],
  'Federal District': ['DF', 'Distrito Federal'], 'Distrito Federal': ['DF', 'Distrito Federal'],
  'Espírito Santo': ['ES', 'Espírito Santo'], 'Espirito Santo': ['ES', 'Espírito Santo'], 'Goiás': ['GO', 'Goiás'], 'Goias': ['GO', 'Goiás'],
  'Maranhão': ['MA', 'Maranhão'], 'Maranhao': ['MA', 'Maranhão'], 'Mato Grosso': ['MT', 'Mato Grosso'],
  'Mato Grosso do Sul': ['MS', 'Mato Grosso do Sul'], 'Minas Gerais': ['MG', 'Minas Gerais'], 'Pará': ['PA', 'Pará'], 'Para': ['PA', 'Pará'],
  'Paraíba': ['PB', 'Paraíba'], 'Paraiba': ['PB', 'Paraíba'], 'Paraná': ['PR', 'Paraná'], 'Parana': ['PR', 'Paraná'],
  'Pernambuco': ['PE', 'Pernambuco'], 'Piauí': ['PI', 'Piauí'], 'Piaui': ['PI', 'Piauí'], 'Rio de Janeiro': ['RJ', 'Rio de Janeiro'],
  'Rio Grande do Norte': ['RN', 'Rio Grande do Norte'], 'Rio Grande do Sul': ['RS', 'Rio Grande do Sul'],
  'Rondônia': ['RO', 'Rondônia'], 'Rondonia': ['RO', 'Rondônia'], 'Roraima': ['RR', 'Roraima'],
  'Santa Catarina': ['SC', 'Santa Catarina'], 'São Paulo': ['SP', 'São Paulo'], 'Sao Paulo': ['SP', 'São Paulo'],
  'Sergipe': ['SE', 'Sergipe'], 'Tocantins': ['TO', 'Tocantins'],
};

let countryNames = null;
try { countryNames = new Intl.DisplayNames(['pt-BR'], { type: 'region' }); } catch (_) {}
export function countryName(code) {
  if (!code) return '';
  try { return (countryNames && countryNames.of(code)) || code; } catch (_) { return code; }
}

// IP de rede interna, loopback ou reservado não tem cidade
export function publicIp(raw) {
  let ip = String(raw || '').trim();
  if (ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  const v = net.isIP(ip);
  if (!v) return null;
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return null;
    return ip;
  }
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::' || /^f[cd]/.test(low) || /^fe[89ab]/.test(low)) return null;
  return ip;
}

// Converte o registro da base no formato guardado nas visitas e nos leads.
export function fromRecord(rec) {
  if (!rec || !rec.country || !rec.country.iso_code) return null;
  const country = rec.country.iso_code;
  const regionEn = rec.subdivisions && rec.subdivisions[0] && rec.subdivisions[0].names ? rec.subdivisions[0].names.en || '' : '';
  const cityEn = rec.city && rec.city.names ? rec.city.names.en || '' : '';
  let region = regionEn;
  if (country === 'BR' && UF[regionEn]) region = UF[regionEn][1];
  const loc = rec.location || {};
  const round = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
  return {
    country,
    region: region ? region.slice(0, 80) : null,
    city: cityEn ? cityEn.slice(0, 80) : null,
    lat: round(loc.latitude),
    lon: round(loc.longitude),
  };
}

export function ufOf(region) {
  for (const [, v] of Object.entries(UF)) if (v[1] === region) return v[0];
  return '';
}

const MONTH = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

export function makeGeo({ dataDir, onReady } = {}) {
  const dir = path.join(dataDir, 'geo');
  const file = path.join(dir, 'dbip-city-lite.mmdb');
  const stamp = path.join(dir, 'dbip-city-lite.month');
  const fixed = process.env.GEO_DB_FILE || '';
  let reader = null, month = null, busy = false, lastError = null, tries = 0, retryTimer = null;
  const causa = (e) => [e && e.message, e && e.cause && (e.cause.code || e.cause.message)].filter(Boolean).join(': ');
  // para a tela: nunca o endereço (GEO_DB_URL pode ter usuário, senha ou token). O download já
  // monta o erro só com o host; isto é a segunda barreira.
  const semEndereco = (m) => String(m).replace(/\S*\/\/\S*|\S+:\S*@\S*/g, '[endereço]').slice(0, 120);
  const curta = (m) => (m ? semEndereco(m).slice(0, 160) : m);

  async function open(f) {
    const r = await maxmind.open(f, { cache: { max: 5000 } });
    reader = r;
    if (onReady) { try { onReady(); } catch (e) { console.error('[geo] depois de abrir:', e.message); } }
  }

  async function download(m) {
    const url = (process.env.GEO_DB_URL || 'https://download.db-ip.com/free/dbip-city-lite-{m}.mmdb.gz').replace('{m}', m);
    let alvo = null;
    try { alvo = new URL(url); } catch (_) {}
    if (!alvo) throw new Error('endereço da base inválido (GEO_DB_URL)');
    // o fetch recusa endereço com usuário e senha: diz isso, sem mostrar o endereço
    if (alvo.username || alvo.password) throw new Error('GEO_DB_URL com usuário e senha no endereço não funciona; use um endereço sem credenciais');
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
    } catch (e) {
      // o erro do fetch pode trazer o endereço inteiro (com token): fica só o host e o motivo
      const err = new Error(`não deu para baixar de ${alvo.host}`);
      const motivo = (e && e.cause && e.cause.code) || (e && e.name === 'TimeoutError' ? 'tempo esgotado'
        : semEndereco((e && e.cause && e.cause.message) || (e && e.message) || ''));
      if (motivo) err.cause = { code: motivo };
      throw err;
    }
    if (!res.ok || !res.body) throw new Error(`download ${m}: HTTP ${res.status}`);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.baixando';
    try {
      await pipeline(Readable.fromWeb(res.body), zlib.createGunzip(), fs.createWriteStream(tmp));
      // confere que abre antes de trocar a base em uso
      const test = await maxmind.open(tmp);
      if (!test.get('8.8.8.8')) throw new Error('base baixada sem dados');
      fs.renameSync(tmp, file);
      fs.writeFileSync(stamp, m);
    } catch (e) {
      fs.rmSync(tmp, { force: true }); // não deixa 130 MB pela metade no volume
      throw e;
    }
  }

  // Abre a base que já existe e, se for de outro mês, baixa a do mês (ou a do mês anterior).
  async function refresh() {
    if (busy || process.env.GEO_DISABLE === '1') return;
    busy = true;
    try {
      if (fixed) { if (!reader) { await open(fixed); month = 'arquivo'; } return; }
      let have = fs.existsSync(file) ? (fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').trim() : 'antiga') : null;
      if (have && !reader) {
        try {
          await open(file);
          month = have;
          console.log(`[geo] base de localização ${have} aberta`);
        } catch (e) {
          // erro do sistema (permissão, arquivos abertos demais): o arquivo pode estar bom; fica no
          // volume e a abertura é tentada de novo mais tarde
          if (e && e.code) {
            lastError = causa(e);
            console.error('[geo] não deu para abrir a base do volume:', lastError);
            return;
          }
          // base ilegível no volume (download antigo pela metade, disco cheio): apaga e baixa de novo
          console.error('[geo] base no volume não abriu, baixando de novo:', causa(e));
          fs.rmSync(file, { force: true });
          fs.rmSync(stamp, { force: true });
          have = null;
        }
      }
      const now = new Date();
      const cur = MONTH(now);
      if (have === cur) return;
      const prev = MONTH(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
      if (have === prev && now.getUTCDate() < 3) return; // a base do mês sai nos primeiros dias
      for (const m of [cur, prev]) {
        if (m === have) break;
        try {
          await download(m);
          await open(file);
          month = m;
          lastError = null;
          console.log(`[geo] base de localização ${m} pronta`);
          return;
        } catch (e) { lastError = causa(e); }
      }
      if (lastError) console.error('[geo] não deu para baixar a base:', lastError);
    } catch (e) {
      lastError = causa(e);
      console.error('[geo]', lastError);
    } finally {
      busy = false;
      // sem base nenhuma: tenta de novo em 5, 15 e 60 minutos (e depois de hora em hora),
      // em vez de esperar a conferência diária
      if (!reader && !fixed && process.env.GEO_DISABLE !== '1' && !retryTimer) {
        const espera = [5, 15, 60][Math.min(tries, 2)] * 60 * 1000;
        tries++;
        retryTimer = setTimeout(() => { retryTimer = null; refresh(); }, espera);
        retryTimer.unref();
      }
      if (reader) tries = 0;
    }
  }

  function lookup(rawIp) {
    if (!reader) return null;
    const ip = publicIp(rawIp);
    if (!ip) return null;
    try { return fromRecord(reader.get(ip)); } catch (_) { return null; }
  }

  return {
    refresh,
    lookup,
    ready: () => !!reader,
    status: () => ({ ready: !!reader, month, error: curta(lastError), disabled: process.env.GEO_DISABLE === '1' }),
    start() {
      // abre já a base que está no volume (visita sem cidade não ganha cidade depois)
      refresh();
      setInterval(refresh, 24 * 3600 * 1000).unref();
    },
  };
}
