/* Mapa de origem: contornos locais (IBGE e Natural Earth) e um círculo por cidade.
   Sem mapa de terceiros: nada sai do painel. A tabela da tela traz os mesmos números. */
(function () {
  'use strict';
  function iniciar() {
    var el = document.getElementById('mapa');
    var fonte = document.getElementById('mapa-dados');
    if (!el || !fonte || !window.L) return;
    var dados;
    try { dados = JSON.parse(fonte.textContent); } catch (e) { return; }

    var css = getComputedStyle(document.documentElement);
    var cor = function (nome, padrao) { var v = css.getPropertyValue(nome).trim(); return v || padrao; };
    var ponto = cor('--mapa-ponto', '#B8F25B');
    var terra = cor('--mapa-terra', '#1f2a28');
    var borda = cor('--mapa-borda', '#3a4744');
    var bordaFina = cor('--mapa-borda-fina', '#303f3a');
    var bordaEntorno = cor('--mapa-borda-entorno', '#3d4b47');
    var nf = new Intl.NumberFormat('pt-BR');
    var nf1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

    var map = L.map(el, {
      zoomControl: false, attributionControl: false, minZoom: 2, maxZoom: 12,
      zoomSnap: 0.5, worldCopyJump: true, scrollWheelZoom: false,
    });
    L.control.zoom({ zoomInTitle: 'Aproximar', zoomOutTitle: 'Afastar' }).addTo(map);
    // rolar a página não dá zoom sem querer; com o mapa clicado, a roda passa a aproximar
    map.on('click focus', function () { map.scrollWheelZoom.enable(); });
    map.on('mouseout blur', function () { map.scrollWheelZoom.disable(); });

    map.createPane('mundo').style.zIndex = 200;
    map.createPane('estados').style.zIndex = 210;
    map.createPane('entorno').style.zIndex = 220;
    map.createPane('pontos').style.zIndex = 450;

    var base = el.getAttribute('data-geo');
    var v = el.getAttribute('data-v');
    var carrega = function (arq, pane, estilo, depois) {
      fetch(base + arq + '?v=' + v, { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (gj) {
          if (!gj) return;
          var camada = L.geoJSON(gj, { pane: pane, style: estilo, interactive: false });
          camada.addTo(map);
          if (depois) depois(camada);
        })
        .catch(function () {});
    };
    carrega('mundo.json', 'mundo', function () { return { color: bordaFina, weight: 0.6, fillColor: terra, fillOpacity: 0.55 }; });
    carrega('uf.json', 'estados', function () { return { color: borda, weight: 0.9, fillColor: terra, fillOpacity: 0.9 }; });
    var entorno = null;
    carrega('entorno.json', 'entorno', function () { return { color: bordaEntorno, weight: 0.7, fillOpacity: 0, dashArray: '2 3' }; }, function (c) {
      entorno = c;
      ajustaEntorno();
    });
    // os municípios do entorno só aparecem com o mapa aproximado
    function ajustaEntorno() {
      if (!entorno) return;
      var dentro = map.getZoom() >= 7;
      if (dentro && !map.hasLayer(entorno)) entorno.addTo(map);
      if (!dentro && map.hasLayer(entorno)) map.removeLayer(entorno);
    }
    map.on('zoomend', ajustaEntorno);

    var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
    var plural = function (n, um, varios) { return nf.format(n) + ' ' + (n === 1 ? um : varios); };
    var pontos = dados.points || [];
    var campo = dados.metric;
    var max = pontos.reduce(function (m, p) { return Math.max(m, p[campo] || 0); }, 0) || 1;
    var raio = function (x) { return 4 + 22 * Math.sqrt((x || 0) / max); };

    var grupo = L.featureGroup().addTo(map);
    // maiores primeiro, para os pequenos ficarem por cima e continuarem clicáveis
    pontos.slice().sort(function (a, b) { return (b[campo] || 0) - (a[campo] || 0); }).forEach(function (p) {
      var canais = Object.keys(p.channels || {}).map(function (k) { return [k, p.channels[k]]; })
        .sort(function (a, b) { return (b[1].visits || 0) - (a[1].visits || 0); }).slice(0, 4);
      var html = '<strong>' + esc(p.label) + '</strong>'
        + '<span class="dica-linha">' + plural(p.visits, 'visita', 'visitas') + ' · ' + plural(p.contacts, 'contato', 'contatos') + ' · ' + plural(p.leads, 'lead', 'leads')
        + (p.rate != null && p.visits ? ' (' + nf1.format(p.rate) + '%)' : '') + '</span>'
        + (canais.length ? '<span class="dica-canais">' + canais.map(function (c) {
          return esc(dados.channels[c[0]] || c[0]) + ' <b>' + nf.format(c[1].visits || 0) + '</b>';
        }).join(' · ') + '</span>' : '');
      var marca = L.circleMarker([p.lat, p.lon], {
        pane: 'pontos', radius: raio(p[campo]), color: ponto, weight: 1.5, opacity: 0.95, fillColor: ponto, fillOpacity: 0.32,
      }).bindTooltip(html, { className: 'mapa-dica', direction: 'top', offset: [0, -6], opacity: 1 });
      // pelo teclado (Tab), a cidade fora da área visível vem para dentro do mapa; o círculo só
      // ganha elemento quando entra no mapa (depois que o mapa tem uma vista)
      marca.on('add', function () {
        var alvo = marca.getElement();
        if (alvo) alvo.addEventListener('focus', function () { map.panInside(marca.getLatLng(), { padding: [70, 70], animate: false }); });
      });
      marca.addTo(grupo);
    });

    var vistas = {
      brasil: function () { map.fitBounds([[-33.8, -74.1], [5.3, -34.7]], { padding: [10, 10] }); },
      df: function () { map.fitBounds([[-16.6, -48.6], [-15.2, -47.2]], { padding: [10, 10] }); },
      // enquadra as cidades que somam 90% do número escolhido (uma visita de outro
      // continente não deixa o Brasil pequeno); as demais continuam no mapa
      dados: function () {
        if (!pontos.length) return vistas.brasil();
        var ord = pontos.slice().sort(function (a, b) { return (b[campo] || 0) - (a[campo] || 0); });
        var total = ord.reduce(function (s, p) { return s + (p[campo] || 0); }, 0);
        var soma = 0, foco = [];
        for (var i = 0; i < ord.length; i++) {
          foco.push([ord[i].lat, ord[i].lon]);
          soma += ord[i][campo] || 0;
          if (soma >= total * 0.9 && foco.length >= 2) break;
        }
        var b = L.latLngBounds(foco);
        if (b.getNorthEast().distanceTo(b.getSouthWest()) < 60000) b = b.pad(0.8);
        map.fitBounds(b, { padding: [40, 40], maxZoom: 9 });
      },
    };
    vistas.dados();
    document.querySelectorAll('[data-vista]').forEach(function (b) {
      b.addEventListener('click', function () { var f = vistas[b.getAttribute('data-vista')]; if (f) f(); });
    });
    window.addEventListener('resize', function () { map.invalidateSize(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
