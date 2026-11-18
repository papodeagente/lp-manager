/* Central de Inteligência: copiar listas, salvar em PDF e acompanhar o relatório. */
(function () {
  'use strict';
  function iniciar() {
    // copiar palavras (formato aceito pelo Google Ads e pelo Google Ads Editor: uma por linha)
    document.querySelectorAll('[data-copiar]').forEach(function (b) {
      b.addEventListener('click', function () {
        var alvo = document.querySelector(b.getAttribute('data-copiar'));
        if (!alvo) return;
        var texto = alvo.value || alvo.textContent || '';
        var ok = function () {
          var antes = b.lastChild && b.lastChild.nodeType === 3 ? b.lastChild.nodeValue : null;
          if (antes != null) b.lastChild.nodeValue = 'Copiado';
          b.classList.add('copiado');
          setTimeout(function () { if (antes != null) b.lastChild.nodeValue = antes; b.classList.remove('copiado'); }, 1800);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(texto).then(ok, function () { manual(alvo); ok(); });
        else { manual(alvo); ok(); }
      });
    });
    function manual(el) {
      try { el.removeAttribute('aria-hidden'); el.select(); document.execCommand('copy'); el.setAttribute('aria-hidden', 'true'); } catch (e) {}
    }

    document.querySelectorAll('[data-imprimir]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('details').forEach(function (d) { d.dataset.estava = d.open ? '1' : ''; });
        window.print();
      });
    });

    // botão de gerar: evita o duplo envio
    document.querySelectorAll('form[data-enviando]').forEach(function (f) {
      f.addEventListener('submit', function () {
        var b = f.querySelector('button');
        if (!b) return;
        setTimeout(function () { b.disabled = true; b.lastChild.nodeValue = f.getAttribute('data-enviando'); }, 0);
      });
    });

    // relatório em andamento: confere a cada 6 s e recarrega quando terminar
    var acomp = document.querySelector('[data-acompanhar]');
    if (acomp) {
      var url = acomp.getAttribute('data-acompanhar');
      var ir = acomp.getAttribute('data-ir');
      var inicio = Date.now();
      var tempo = acomp.querySelector('[data-tempo]');
      var tique = function () {
        fetch(url, { credentials: 'same-origin', cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            if (j && (j.status === 'pronto' || j.status === 'erro')) { window.location.href = ir; return; }
            setTimeout(tique, 6000);
          })
          .catch(function () { setTimeout(tique, 12000); });
      };
      setTimeout(tique, 4000);
      if (tempo) {
        var base = tempo.textContent;
        setInterval(function () {
          var s = Math.round((Date.now() - inicio) / 1000);
          tempo.textContent = base + ' Acompanhando há ' + (s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s') + '.';
        }, 1000);
      }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
