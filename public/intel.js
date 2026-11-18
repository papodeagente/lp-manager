/* Central de Inteligência: copiar listas, salvar em PDF e acompanhar o relatório. */
(function () {
  'use strict';
  function iniciar() {
    // copiar palavras (formato aceito pelo Google Ads e pelo Google Ads Editor: uma por linha).
    // Atributo próprio (data-copiar-lista): o data-copiar do admin.js espera um id sem "#".
    document.querySelectorAll('[data-copiar-lista]').forEach(function (b) {
      b.addEventListener('click', function () {
        var alvo = document.querySelector(b.getAttribute('data-copiar-lista'));
        if (!alvo) return;
        var texto = alvo.value || alvo.textContent || '';
        var ok = function () {
          var t = b.lastChild && b.lastChild.nodeType === 3 ? b.lastChild : null;
          if (!t) return;
          if (b.dataset.rotulo == null) b.dataset.rotulo = t.nodeValue;
          t.nodeValue = 'Copiado';
          b.classList.add('copiado');
          clearTimeout(b._copiado);
          b._copiado = setTimeout(function () { t.nodeValue = b.dataset.rotulo; b.classList.remove('copiado'); }, 1800);
        };
        if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
          navigator.clipboard.writeText(texto).then(ok, function () { if (manual(alvo)) ok(); });
        } else if (manual(alvo)) ok();
      });
    });
    function manual(el) {
      try {
        el.removeAttribute('aria-hidden');
        el.select();
        var feito = document.execCommand('copy');
        el.setAttribute('aria-hidden', 'true');
        return feito;
      } catch (e) { return false; }
    }

    // PDF: abre os detalhes do relatório (buscas da IA) para irem ao papel e fecha depois.
    // Vale para o botão e para Ctrl/Cmd+P.
    var detalhes = function () { return document.querySelectorAll('.conteudo details.mais'); };
    window.addEventListener('beforeprint', function () {
      detalhes().forEach(function (d) { d.dataset.estava = d.open ? '1' : ''; d.open = true; });
    });
    window.addEventListener('afterprint', function () {
      detalhes().forEach(function (d) { if (d.dataset.estava != null) { d.open = d.dataset.estava === '1'; delete d.dataset.estava; } });
    });
    document.querySelectorAll('[data-imprimir]').forEach(function (b) {
      b.addEventListener('click', function () { window.print(); });
    });

    // botão de gerar: evita o duplo envio
    document.querySelectorAll('form[data-enviando]').forEach(function (f) {
      f.addEventListener('submit', function () {
        var b = f.querySelector('button');
        if (!b) return;
        setTimeout(function () {
          b.disabled = true;
          if (b.lastChild && b.lastChild.nodeType === 3) b.lastChild.nodeValue = f.getAttribute('data-enviando');
        }, 0);
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
