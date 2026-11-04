/* Painel das páginas: gráficos com dica ao passar o mouse, seletores, copiar e
   confirmar. Tudo funciona sem este arquivo (as tabelas ficam visíveis); ele só
   desenha e deixa mais rápido. */
(function () {
  'use strict';
  var d = document;
  d.documentElement.classList.add('js');
  var nf = new Intl.NumberFormat('pt-BR');
  var NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, parent) {
    var e = d.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function dados(id) {
    var s = d.getElementById(id);
    try { return s ? JSON.parse(s.textContent) : null; } catch (e) { return null; }
  }
  // teto "redondo" para o eixo: 1, 2, 5 vezes potência de 10
  function teto(max) {
    if (max <= 4) return Math.max(1, Math.ceil(max));
    var p = Math.pow(10, Math.floor(Math.log10(max))), r = max / p;
    return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * p;
  }
  function marcas(top) {
    var n = top <= 4 ? top : 4, out = [];
    for (var i = 0; i <= n; i++) out.push(Math.round(top * i / n));
    return out.filter(function (v, i, a) { return a.indexOf(v) === i; });
  }
  function compacto(v) {
    return v >= 10000 ? nf.format(Math.round(v / 1000)) + ' mil' : nf.format(v);
  }

  // dica: o valor vem primeiro, o nome da série depois
  function dica(box) {
    var t = d.createElement('div');
    t.className = 'dica';
    t.hidden = true;
    t.setAttribute('role', 'status');
    box.appendChild(t);
    return {
      mostra: function (titulo, linhas, x, y) {
        t.textContent = '';
        var s = d.createElement('strong'); s.textContent = titulo; t.appendChild(s);
        linhas.forEach(function (l) {
          var row = d.createElement('div');
          var i = d.createElement('i'); if (l.cls) i.className = l.cls; row.appendChild(i);
          var b = d.createElement('b'); b.textContent = l.valor; row.appendChild(b);
          if (l.nome) { var sp = d.createElement('span'); sp.textContent = l.nome; row.appendChild(sp); }
          t.appendChild(row);
        });
        t.hidden = false;
        var w = box.clientWidth, tw = t.offsetWidth;
        t.style.left = Math.max(0, Math.min(w - tw, x - tw / 2)) + 'px';
        t.style.top = Math.max(0, y - t.offsetHeight - 12) + 'px';
      },
      esconde: function () { t.hidden = true; },
    };
  }

  // linhas (uma ou mais séries) com mira que acha o dia mais próximo
  function linhas(box, cfg) {
    var series = cfg.series, labels = cfg.labels, n = labels.length;
    var H = cfg.altura || 220;
    var max = 0;
    series.forEach(function (s) { s.values.forEach(function (v) { if (v > max) max = v; }); });
    var top = teto(max), ticks = marcas(top);
    var svgHolder = d.createElement('div');
    box.appendChild(svgHolder);
    var tip = dica(box);
    var idx = -1;

    function desenha() {
      var W = Math.max(280, box.clientWidth);
      svgHolder.textContent = '';
      var left = 10 + String(compacto(top)).length * 7.5, right = series.length === 1 ? 44 : 12, topo = 10, baixo = 26;
      var pw = W - left - right, ph = H - topo - baixo;
      var X = function (i) { return left + (n > 1 ? pw * i / (n - 1) : pw / 2); };
      var Y = function (v) { return topo + ph - (top ? ph * v / top : 0); };
      var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img', 'aria-label': cfg.titulo || '' }, svgHolder);
      ticks.forEach(function (t) {
        el('line', { x1: left, x2: W - right, y1: Y(t), y2: Y(t), 'class': t === 0 ? 'base' : 'grade' }, svg);
        el('text', { x: left - 8, y: Y(t) + 4, 'text-anchor': 'end', 'class': 'eixo' }, svg).textContent = compacto(t);
      });
      rotulosX(n, pw, function (i) {
        el('text', { x: X(i), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle', 'class': 'eixo' }, svg).textContent = labels[i];
      });
      // com uma série só, a cor é a da página aberta (--cor); com várias, cada página tem a sua
      var serie = function (k) { return series.length > 1 && k < 3 ? 's' + (k + 1) : ''; };
      series.forEach(function (s, k) {
        var cls = serie(k), pts = s.values.map(function (v, i) { return X(i).toFixed(1) + ',' + Y(v).toFixed(1); });
        if (series.length === 1 && n > 1) el('path', { d: 'M' + X(0) + ',' + Y(0) + ' L' + pts.join(' L') + ' L' + X(n - 1) + ',' + Y(0) + ' Z', 'class': 'area' }, svg);
        if (n > 1) el('polyline', { points: pts.join(' '), 'class': 'linha ' + cls }, svg);
        var last = s.values[n - 1];
        el('circle', { cx: X(n - 1), cy: Y(last), r: 4, 'class': 'ponto-fim ' + cls }, svg);
        if (series.length === 1) el('text', { x: X(n - 1) + 9, y: Y(last) + 4, 'class': 'rotulo' }, svg).textContent = compacto(last);
      });
      var mira = el('line', { y1: topo, y2: topo + ph, 'class': 'mira', visibility: 'hidden' }, svg);
      var pontos = series.map(function (s, k) { return el('circle', { r: 4, 'class': 'ponto-fim ' + serie(k), visibility: 'hidden' }, svg); });
      function mostra(i) {
        idx = i;
        var x = X(i);
        mira.setAttribute('x1', x); mira.setAttribute('x2', x); mira.setAttribute('visibility', 'visible');
        pontos.forEach(function (p, k) { p.setAttribute('cx', x); p.setAttribute('cy', Y(series[k].values[i])); p.setAttribute('visibility', 'visible'); });
        var y = Math.min.apply(null, series.map(function (s) { return Y(s.values[i]); }));
        tip.mostra(labels[i], series.map(function (s, k) {
          return { cls: serie(k), valor: nf.format(s.values[i]), nome: series.length > 1 ? s.name : (cfg.unidade || '') };
        }), x, y);
      }
      function some() {
        idx = -1;
        mira.setAttribute('visibility', 'hidden');
        pontos.forEach(function (p) { p.setAttribute('visibility', 'hidden'); });
        tip.esconde();
      }
      var porX = function (e) {
        var r = svg.getBoundingClientRect(), x = (e.clientX - r.left) * (W / r.width);
        mostra(Math.max(0, Math.min(n - 1, Math.round(n > 1 ? (x - left) / pw * (n - 1) : 0))));
      };
      svg.addEventListener('pointermove', porX);
      svg.addEventListener('pointerdown', function (e) { if (e.pointerType !== 'mouse') porX(e); });
      svg.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') some(); });
      toqueFora(box, some);
      box.onkeydown = function (e) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          mostra(Math.max(0, Math.min(n - 1, (idx < 0 ? n - 1 : idx) + (e.key === 'ArrowRight' ? 1 : -1))));
        } else if (e.key === 'Escape') some();
      };
      box.onblur = some;
    }
    box.tabIndex = 0;
    desenha();
    observa(box, desenha);
  }

  // colunas finas (até 24 px), canto arredondado só na ponta de cima
  function colunas(box, cfg) {
    var vals = cfg.values, labels = cfg.labels, n = vals.length, H = cfg.altura || 130;
    var max = Math.max.apply(null, vals.concat([0])), top = teto(max), ticks = marcas(top);
    var holder = d.createElement('div');
    box.appendChild(holder);
    var tip = dica(box), mostras = [], atual = -1;
    box.tabIndex = 0;
    box.onkeydown = function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        var i = Math.max(0, Math.min(n - 1, (atual < 0 ? n - 1 : atual) + (e.key === 'ArrowRight' ? 1 : -1)));
        if (mostras[i]) mostras[i]();
      } else if (e.key === 'Escape') { atual = -1; tip.esconde(); }
    };
    box.onblur = function () { atual = -1; tip.esconde(); };
    toqueFora(box, function () { atual = -1; tip.esconde(); });
    function desenha() {
      var W = Math.max(280, box.clientWidth);
      holder.textContent = '';
      var left = 10 + String(compacto(top)).length * 7.5, right = cfg.direita || 44, topo = 8, baixo = 26;
      var pw = W - left - right, ph = H - topo - baixo, banda = pw / n;
      var bw = Math.max(2, Math.min(24, banda - 2));
      var Y = function (v) { return topo + ph - (top ? ph * v / top : 0); };
      var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img', 'aria-label': cfg.titulo || '' }, holder);
      ticks.forEach(function (t) {
        el('line', { x1: left, x2: W - right, y1: Y(t), y2: Y(t), 'class': t === 0 ? 'base' : 'grade' }, svg);
        el('text', { x: left - 8, y: Y(t) + 4, 'text-anchor': 'end', 'class': 'eixo' }, svg).textContent = compacto(t);
      });
      rotulosX(n, pw, function (i) {
        el('text', { x: left + banda * (i + 0.5), y: H - 6, 'text-anchor': 'middle', 'class': 'eixo' }, svg).textContent = labels[i];
      });
      vals.forEach(function (v, i) {
        var cx = left + banda * (i + 0.5), x = cx - bw / 2, y = Y(v), h = Y(0) - y, r = Math.min(4, bw / 2, h);
        if (v > 0) {
          el('path', {
            d: 'M' + x + ',' + Y(0) + ' V' + (y + r) + ' Q' + x + ',' + y + ' ' + (x + r) + ',' + y + ' H' + (x + bw - r) +
              ' Q' + (x + bw) + ',' + y + ' ' + (x + bw) + ',' + (y + r) + ' V' + Y(0) + ' Z',
            'class': 'coluna',
          }, svg);
        }
        var hit = el('rect', { x: left + banda * i, y: topo, width: banda, height: ph, fill: 'transparent' }, svg);
        mostras[i] = function () { atual = i; tip.mostra(labels[i], [{ valor: nf.format(v), nome: cfg.unidade || '' }], cx, y); };
        hit.addEventListener('pointerenter', mostras[i]);
        hit.addEventListener('pointerdown', function (e) { if (e.pointerType !== 'mouse') mostras[i](); });
        hit.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') tip.esconde(); });
      });
      if (!max && cfg.vazio) {
        el('text', { x: left + pw / 2, y: topo + ph / 2, 'text-anchor': 'middle', 'class': 'eixo' }, svg).textContent = cfg.vazio;
      }
    }
    desenha();
    observa(box, desenha);
  }

  // quais dias ganham rótulo: o primeiro, o último e os do meio a cada ~70 px,
  // pulando o que ficaria colado no último
  function rotulosX(n, pw, desenha) {
    var passo = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 70))));
    for (var i = 0; i < n - 1; i += passo) {
      if (i && n - 1 - i < passo * 0.75) continue;
      desenha(i);
    }
    if (n > 1) desenha(n - 1);
    else if (n === 1) desenha(0);
  }

  // toque fora do gráfico fecha a dica aberta pelo toque
  function toqueFora(box, fecha) {
    d.addEventListener('pointerdown', function (e) { if (e.pointerType !== 'mouse' && !box.contains(e.target)) fecha(); });
  }

  function observa(box, fn) {
    if (!('ResizeObserver' in window)) return;
    var w = box.clientWidth, t = 0;
    new ResizeObserver(function () {
      if (Math.abs(box.clientWidth - w) < 2) return;
      w = box.clientWidth;
      clearTimeout(t);
      t = setTimeout(fn, 60);
    }).observe(box);
  }

  d.querySelectorAll('[data-grafico]').forEach(function (box) {
    var cfg = dados(box.getAttribute('data-dados'));
    if (!cfg) return;
    box.classList.add('pronto');
    var tipo = box.getAttribute('data-grafico');
    var titulo = box.getAttribute('aria-label') || '';
    if (tipo === 'linhas') linhas(box, { labels: cfg.labels, series: cfg.series, titulo: titulo, unidade: box.getAttribute('data-unidade') });
    else if (tipo === 'acessos') linhas(box, { labels: cfg.labels, series: [{ name: 'Acessos', values: cfg.visits }], titulo: titulo, unidade: 'acessos', altura: 200 });
    else if (tipo === 'conversoes') colunas(box, { labels: cfg.labels, values: cfg.leads, titulo: titulo, unidade: 'conversões', vazio: 'Nenhuma conversão no período' });
  });

  // seletor de dimensão: mostra uma tabela por vez
  d.querySelectorAll('[data-dims]').forEach(function (wrap) {
    var botoes = wrap.querySelectorAll('[data-dim-btn]'), paineis = wrap.querySelectorAll('[data-dim]');
    var seg = wrap.querySelector('.segm');
    if (seg) seg.hidden = false;
    function escolhe(k) {
      botoes.forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-dim-btn') === k ? 'true' : 'false'); });
      paineis.forEach(function (p) { p.hidden = p.getAttribute('data-dim') !== k; });
      try { sessionStorage.setItem('lpm-dim', k); } catch (e) {}
    }
    botoes.forEach(function (b) { b.addEventListener('click', function () { escolhe(b.getAttribute('data-dim-btn')); }); });
    var salvo = null;
    try { salvo = sessionStorage.getItem('lpm-dim'); } catch (e) {}
    escolhe(salvo && wrap.querySelector('[data-dim="' + salvo + '"]') ? salvo : botoes[0].getAttribute('data-dim-btn'));
  });

  // copiar endereço
  d.addEventListener('click', function (e) {
    var b = e.target.closest('[data-copiar]');
    if (!b) return;
    var alvo = d.getElementById(b.getAttribute('data-copiar'));
    var texto = alvo ? (alvo.value || alvo.textContent) : b.getAttribute('data-texto');
    var feito = function () {
      var antes = b.textContent;
      b.textContent = 'Copiado';
      setTimeout(function () { b.textContent = antes; }, 1600);
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(texto).then(feito, function () {});
    else if (alvo && alvo.select) { alvo.select(); try { d.execCommand('copy'); feito(); } catch (err) {} }
  });

  function botoes(f) {
    return Array.prototype.filter.call(f.elements, function (el) { return el.tagName === 'BUTTON'; });
  }

  // confirmar antes de ações sem volta e travar o botão para não enviar duas vezes
  d.addEventListener('submit', function (e) {
    var f = e.target, msg = f.getAttribute('data-confirmar');
    if (msg && !window.confirm(msg)) { e.preventDefault(); return; }
    if (f.method.toLowerCase() !== 'post') return;
    if (f.dataset.enviando) { e.preventDefault(); return; }
    f.dataset.enviando = '1';
    // f.elements inclui os botões de fora do formulário ligados a ele pelo atributo form
    setTimeout(function () { botoes(f).forEach(function (b) { b.disabled = true; }); }, 0);
  });
  // ao voltar pelo histórico, a página volta com os botões soltos
  window.addEventListener('pageshow', function () {
    d.querySelectorAll('form[data-enviando]').forEach(function (f) {
      delete f.dataset.enviando;
      botoes(f).forEach(function (b) { b.disabled = false; });
    });
  });

  // aba ativa sempre visível quando as abas rolam de lado (celular)
  d.querySelectorAll('.abas [aria-current="page"]').forEach(function (a) {
    var abas = a.parentNode;
    if (abas.scrollWidth <= abas.clientWidth) return;
    var ra = a.getBoundingClientRect(), rb = abas.getBoundingClientRect();
    abas.scrollLeft += (ra.left - rb.left) - (abas.clientWidth - ra.width) / 2;
  });

  // filtros que se aplicam sozinhos ao mudar
  d.querySelectorAll('[data-auto]').forEach(function (s) {
    s.addEventListener('change', function () { if (s.form) s.form.submit(); });
  });

  // mostrar senha
  d.querySelectorAll('[data-ver-senha]').forEach(function (b) {
    var input = d.getElementById(b.getAttribute('data-ver-senha'));
    b.hidden = false;
    b.addEventListener('click', function () {
      var ver = input.type === 'password';
      input.type = ver ? 'text' : 'password';
      b.textContent = ver ? 'Ocultar' : 'Mostrar';
      b.setAttribute('aria-pressed', ver ? 'true' : 'false');
    });
  });

  // gerar senha provisória no formulário de usuário
  d.querySelectorAll('[data-gerar]').forEach(function (b) {
    var input = d.getElementById(b.getAttribute('data-gerar'));
    b.hidden = false;
    b.addEventListener('click', function () {
      var abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789', a = new Uint8Array(12), s = '';
      crypto.getRandomValues(a);
      for (var i = 0; i < 12; i++) { if (i && i % 4 === 0) s += '-'; s += abc[a[i] % abc.length]; }
      input.value = s;
      input.type = 'text';
    });
  });

  // menu do celular: em navegador sem popover, o botão abre e fecha a gaveta por classe
  if (!Object.prototype.hasOwnProperty.call(HTMLElement.prototype, 'popover')) {
    d.querySelectorAll('[popovertarget]').forEach(function (b) {
      var alvo = d.getElementById(b.getAttribute('popovertarget'));
      if (!alvo) return;
      b.addEventListener('click', function () {
        alvo.classList.toggle('aberta', b.getAttribute('popovertargetaction') === 'hide' ? false : !alvo.classList.contains('aberta'));
      });
    });
  }

  // montador de link com UTM: mesma limpeza que o servidor faz ao salvar
  var form = d.getElementById('utm-form');
  if (form) {
    var base = form.getAttribute('data-base');
    var prev = d.getElementById('utm-previa');
    var limpa = function (v) {
      return String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
        .replace(/[\s/]+/g, '-').replace(/[^a-z0-9._{}-]+/g, '').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
    };
    var atualiza = function () {
      var f = form.elements, q = [];
      [['utm_source', 'source'], ['utm_medium', 'medium'], ['utm_campaign', 'campaign'], ['utm_content', 'content'], ['utm_term', 'term']]
        .forEach(function (p) { var v = limpa(f[p[1]].value); if (v) q.push(p[0] + '=' + encodeURIComponent(v)); });
      prev.value = base + (q.length ? '?' + q.join('&') : '');
    };
    form.addEventListener('input', atualiza);
    d.querySelectorAll('[data-modelo]').forEach(function (b) {
      b.addEventListener('click', function () {
        var m = JSON.parse(b.getAttribute('data-modelo'));
        for (var k in m) if (form.elements[k]) form.elements[k].value = m[k];
        atualiza();
        form.elements.campaign.focus();
      });
    });
    atualiza();
  }
})();
