// Ficha do lead: parâmetros do endereço e nome do botão/formulário de origem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { urlParams, sourceLabel } from '../lib/journey.js';

test('parâmetros do endereço: os conhecidos primeiro, com nome', () => {
  const ps = urlParams('https://draglazi.com.br/?gclid=Cj0K&foo=1&utm_term=flacidez+rosto&utm_source=google&gad_source=1&utm_medium=cpc');
  assert.deepEqual(ps.map((p) => p.key), ['utm_source', 'utm_medium', 'utm_term', 'gclid', 'gad_source', 'foo']);
  assert.equal(ps.find((p) => p.key === 'utm_term').value, 'flacidez rosto');
  assert.equal(ps.find((p) => p.key === 'gclid').label, 'Clique do Google Ads');
  assert.equal(ps.find((p) => p.key === 'foo').label, null);
});

test('parâmetros: aceita só a query, ignora vazios e lixo', () => {
  assert.deepEqual(urlParams('?utm_source=instagram&utm_medium=').map((p) => p.key), ['utm_source']);
  assert.deepEqual(urlParams('utm_campaign=perfil').map((p) => [p.key, p.value]), [['utm_campaign', 'perfil']]);
  assert.deepEqual(urlParams(''), []);
  assert.deepEqual(urlParams(null), []);
  assert.deepEqual(urlParams('https://draglazi.com.br/'), []);
});

test('nome do botão ou formulário', () => {
  assert.equal(sourceLabel('site-hipro-form'), 'Formulário');
  assert.equal(sourceLabel('fullface-form'), 'Formulário');
  assert.equal(sourceLabel('whatsapp-header'), 'Botão de WhatsApp (cabeçalho)');
  assert.equal(sourceLabel('whatsapp-hero-alt'), 'Botão de WhatsApp (topo)');
  assert.equal(sourceLabel('whatsapp-flutuante'), 'Botão de WhatsApp (botão flutuante)');
  assert.equal(sourceLabel('fullface-fixo'), 'Botão de WhatsApp (barra fixa)');
  assert.equal(sourceLabel('fullface-consulta'), 'Botão de WhatsApp (seção da consulta)');
  assert.equal(sourceLabel('whatsapp'), 'Botão de WhatsApp');
  assert.equal(sourceLabel(''), 'Não informado');
  assert.equal(sourceLabel('outra-coisa'), 'outra-coisa');
});

test('mesmo parâmetro repetido aparece duas vezes, na ordem', () => {
  const ps = urlParams('?utm_source=a&utm_source=b');
  assert.deepEqual(ps.map((p) => p.value), ['a', 'b']);
});
