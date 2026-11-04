/* Medição própria da página (lp-manager): acessos, tempo de leitura, rolagem e
   cliques. Fica no mesmo domínio, não usa cookie de terceiros e não lê o que é
   digitado nos formulários. ?lpm=off desliga neste navegador; ?lpm=on religa. */
(function () {
  'use strict';
  var w = window, d = document, n = navigator, loc = location;
  if (w.__lpm) return;
  w.__lpm = 1;
  try {
    var modo = new URLSearchParams(loc.search).get('lpm');
    if (modo === 'off') localStorage.setItem('lpm_off', '1');
    else if (modo === 'on') localStorage.removeItem('lpm_off');
    if (localStorage.getItem('lpm_off') === '1') return;
  } catch (e) {}
  if (n.webdriver) return;

  var URL_EVENTO = '/_lpm/e';
  var PARADO = 60000;   // sem mexer por 1 min: o tempo para de contar
  var A_CADA = 15000;   // manda o tempo acumulado a cada 15 s de leitura
  var pid, tempo, ultimo, visivel, mexeu, rolagem, enviadoT, enviadoR;

  function agora() { return Date.now(); }
  function novoId() {
    var a = new Uint8Array(12), s = '', i;
    (w.crypto || w.msCrypto).getRandomValues(a);
    for (i = 0; i < a.length; i++) s += ('0' + a[i].toString(16)).slice(-2);
    return s;
  }
  function envia(o, beacon) {
    o.pid = pid;
    o.p = loc.pathname;
    var corpo = JSON.stringify(o);
    try {
      if (beacon && n.sendBeacon && n.sendBeacon(URL_EVENTO, new Blob([corpo], { type: 'text/plain' }))) return;
    } catch (e) {}
    try {
      fetch(URL_EVENTO, { method: 'POST', body: corpo, keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'text/plain' } })
        .catch(function () {});
    } catch (e) {}
  }

  // tempo de leitura: só com a aba visível e até 1 min depois do último movimento
  function conta() {
    var t = agora();
    if (visivel) {
      var fim = Math.min(t, mexeu + PARADO);
      if (fim > ultimo) tempo += fim - ultimo;
    }
    ultimo = t;
  }
  function mede() {
    var h = d.documentElement, b = d.body;
    var alto = Math.max(h.scrollHeight, b ? b.scrollHeight : 0);
    var viu = (w.scrollY || h.scrollTop || 0) + w.innerHeight;
    var p = alto > 0 ? Math.min(100, Math.round(viu / alto * 100)) : 100;
    if (p > rolagem) rolagem = p;
  }
  function atividade() {
    conta();
    mexeu = agora();
  }
  function descarrega(beacon) {
    if (!pid) return;
    conta();
    var t = Math.round(tempo);
    if (t === enviadoT && rolagem === enviadoR) return;
    enviadoT = t;
    enviadoR = rolagem;
    envia({ t: 'ping', e: t, s: rolagem }, beacon);
  }
  function comeca() {
    pid = novoId();
    tempo = 0;
    ultimo = agora();
    mexeu = ultimo;
    visivel = d.visibilityState !== 'hidden';
    rolagem = 0;
    enviadoT = -1;
    enviadoR = -1;
    mede();
    envia({ t: 'pv', u: loc.href, r: d.referrer, tp: n.maxTouchPoints || 0 });
  }

  var rolando = false;
  w.addEventListener('scroll', function () {
    atividade();
    if (!rolando) {
      rolando = true;
      (w.requestAnimationFrame || setTimeout)(function () { rolando = false; mede(); });
    }
  }, { passive: true });
  ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(function (ev) {
    w.addEventListener(ev, atividade, { passive: true, capture: true });
  });
  var moveu = 0;
  w.addEventListener('mousemove', function () {
    var t = agora();
    if (t - moveu > 1000) { moveu = t; atividade(); }
  }, { passive: true });

  d.addEventListener('visibilitychange', function () {
    conta();
    visivel = d.visibilityState !== 'hidden';
    if (visivel) mexeu = agora();
    else descarrega(true);
  });
  w.addEventListener('pagehide', function () { descarrega(true); });
  w.addEventListener('pageshow', function (e) { if (e.persisted) comeca(); });
  setInterval(function () {
    conta();
    if (tempo - Math.max(enviadoT, 0) >= A_CADA) descarrega(true);
  }, 5000);

  // cliques: que tipo de elemento foi, o texto dele e para onde leva
  function tipo(el, href) {
    var k = el.getAttribute('data-track-kind');
    if (k) return k;
    var h = href.toLowerCase();
    if (/wa\.me|whatsapp\.com/.test(h)) return 'whatsapp';
    if (h.indexOf('tel:') === 0) return 'telefone';
    if (h.indexOf('mailto:') === 0) return 'email';
    if (/instagram\.com/.test(h)) return 'instagram';
    if (/facebook\.com|fb\.com/.test(h)) return 'facebook';
    if (/google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps|maps\.google\./.test(h)) return 'mapa';
    if (/google\.[a-z.]+\/search|g\.page|share\.google/.test(h)) return 'avaliacoes';
    if (el.tagName === 'SUMMARY') return 'faq';
    if ((el.tagName === 'BUTTON' && (el.getAttribute('type') || 'submit') === 'submit' && el.form) ||
        (el.tagName === 'INPUT' && el.type === 'submit')) return 'formulario';
    if (h.charAt(0) === '#') {
      // âncora que leva ao formulário (o próprio form ou o cartão em volta dele, não a página inteira)
      var alvo = h.length > 1 && d.getElementById(href.slice(1));
      var cartao = alvo && alvo.querySelector('form') && !/^(MAIN|BODY|HTML)$/.test(alvo.tagName) && !alvo.querySelector('section,main,article');
      return alvo && (alvo.tagName === 'FORM' || cartao) ? 'cta' : 'navegacao';
    }
    if (/^https?:/.test(h)) return el.host && el.host !== loc.host ? 'link-externo' : 'link-interno';
    if (h) return 'link-interno';
    if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.hasAttribute('data-track')) return 'botao';
    return null;
  }
  function destino(el, href) {
    var src = el.getAttribute('data-src');
    if (src) return src;
    if (href.charAt(0) === '#') return href;
    if (/^(tel|mailto):/i.test(href)) return href.split(':')[0];
    try {
      var u = new URL(href, loc.href);
      return u.host === loc.host ? u.pathname : u.host + u.pathname;
    } catch (e) { return ''; }
  }
  d.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('a,button,summary,[role=button],input[type=submit],[data-track]') : null;
    if (!el || !pid) return;
    var href = el.getAttribute('href') || '';
    var k = tipo(el, href);
    if (!k) return;
    var rotulo = el.getAttribute('data-track') || el.getAttribute('aria-label') || el.textContent || el.value || '';
    envia({ t: 'c', k: k, l: rotulo.replace(/\s+/g, ' ').trim().slice(0, 80), h: destino(el, href) }, true);
  }, true);

  if (d.prerendering) d.addEventListener('prerenderingchange', comeca, { once: true });
  else comeca();
})();
