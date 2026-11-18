# lp-manager

Servidor das landing pages e do painel. Um processo só:

- nos domínios das páginas (ex.: `draglazi.com.br`), serve os arquivos do site publicado e injeta a medição;
- no domínio do painel (`ADMIN_HOST`, ex.: `admin.draglazi.com.br`), serve o painel em `/admin`.

Node 22 + Express + SQLite (`better-sqlite3`) + EJS, sem etapa de build. Dados em `DATA_DIR`
(`lps.db` e `sites/<slug>/`), que no Coolify é um volume persistente.

## Variáveis de ambiente

| variável | para quê |
|---|---|
| `ADMIN_HOST` | domínio(s) do painel, separados por vírgula |
| `SESSION_SECRET` | assina o cookie de sessão do painel (fixo entre deploys) |
| `SUPERADMIN_EMAIL` | e-mail do dono do painel; criado (ou reativado como super admin) a cada boot |
| `SUPERADMIN_PASSWORD_HASH` | hash da senha do dono, nunca a senha: `node scripts/hash-password.js` |
| `SUPERADMIN_NAME` | opcional; nome exibido (padrão: a parte do e-mail antes do @) |
| `SUPERADMIN_PASSWORD_RESET` | `1` faz o boot regravar a senha do dono com o hash acima (recuperação). Vale uma vez por hash: para recuperar de novo, gere outro hash (a mesma senha gera outro). Desligue depois de usar |
| `DEPLOY_TOKEN` | token para publicar ZIP por linha de comando (`Authorization: Bearer`) |
| `PANEL_TITLE` | nome no topo do painel (padrão: `Glazi Melo`) |
| `COOLIFY_HOST`, `COOLIFY_TOKEN`, `COOLIFY_APP_UUID` | para o painel incluir/remover domínios no Coolify |
| `DATA_DIR`, `PORT` | onde ficam os dados e a porta (padrões: `./data`, `3000`) |
| `OPENAI_API_KEY` | chave da OpenAI para os relatórios da Central de Inteligência (sem ela, o resto funciona e a Central avisa) |
| `INTEL_MODEL`, `INTEL_EFFORT` | modelo e esforço de raciocínio do relatório (padrões: `gpt-6.2-astra`, `high`) |
| `INTEL_WEB_SEARCH` | `0` desliga a pesquisa na web durante o relatório (padrão: ligada) |
| `INTEL_DAILY_LIMIT` | relatórios por 24 horas (padrão: `10`) |
| `GEO_DB_FILE` | usa uma base de localização `.mmdb` já baixada em vez de baixar (testes) |
| `GEO_DB_URL`, `GEO_DISABLE` | outro endereço da base (com `{m}` no lugar do mês) / `1` desliga a localização |

Gerar o hash sem a senha passar pela linha de comando:

```bash
node scripts/hash-password.js        # digite a senha e aperte Ctrl+D
```

## Usuários e papéis

- **Super admin**: tudo, inclusive usuários, arquivos do site, domínio, destino dos leads (webhook), reenvio
  ao CRM, mostrar ou ocultar páginas e o registro de atividade.
- **Admin**: visão geral, resultados das páginas, leads, links com UTM e o nome das páginas; vê se o envio ao
  CRM está funcionando, sem ver nem mudar o endereço.

Usuário novo recebe uma senha provisória (mostrada uma vez) e troca no primeiro acesso.
Desativar, excluir ou trocar a senha encerra as sessões da pessoa na hora. O painel não deixa
ficar sem super admin ativo. Senhas com scrypt. Tentativas erradas (contadas antes de conferir a
senha) bloqueiam por 15 minutos o par e-mail + IP depois de 8 erros e o IP depois de 30. Pelo e-mail
sozinho, depois de 8 erros, aparelho desconhecido entra numa fila (uma tentativa por vez, com intervalo
de até 30 s); o aparelho onde a pessoa já entrou (cookie assinado `lpm_ap`) fica fora da fila. Todo
POST do painel precisa vir da própria origem. Webhook só para endereço público (nada de rede interna),
sem seguir redirecionamento; quem muda ou testa webhook é o super admin.

## Páginas

Cada HTML do site vira uma página com endereço próprio: o arquivo index é `/`, `fullface.html` é
`/fullface`, `pasta/index.html` é `/pasta`. O nome sai do `<title>` e muda em Configurações. Só páginas
de captação de sites com domínio aparecem no menu; a de obrigado já nasce fora, e o super admin oculta ou
mostra qualquer página em Configurações (ela continua no ar e medindo).

Cada página pode ter um webhook próprio; sem ele, vale o webhook do site. Configurações mostra se o envio
ao CRM está funcionando (entregues e falhas dos últimos 30 dias, com o motivo), testa o destino marcado
sem salvar e reenvia os leads que falharam (até 25 por vez). A ficha do lead também reenvia.

## Medição

O servidor injeta `<script src="/_lpm/t.js?v=…" defer>` antes do `</head>` de todo HTML servido nos
domínios públicos e põe o cookie `_lpm_v` (visitante; aleatório, HttpOnly, 13 meses, não renovado;
só da sessão quando o navegador manda `Sec-GPC: 1` ou `DNT: 1`). O script manda para `POST /_lpm/e`:

- `pv`: visualização, com a URL (UTM e ids de clique) e o referrer;
- `ping`: tempo de leitura acumulado (só com a aba visível e até 1 min depois do último movimento) e
  quanto da página foi visto;
- `c`: clique em link ou botão, com tipo (WhatsApp, formulário, telefone, Instagram, mapa...), texto e destino.

Regras de atribuição (as do Google Analytics): visita fecha depois de 30 minutos parada; link com
outra campanha abre visita nova; a origem é UTM > id de clique (gclid, gbraid, wbraid, gad_source,
fbclid, msclkid...) > site de onde veio > direto; visita direta herda a última origem não direta do
mesmo visitante nos 90 dias anteriores. O lead leva a origem da visita em que converteu e o primeiro
contato do visitante; sem visita (script bloqueado), a origem vem da UTM do endereço da página.

Fora dos números: robôs (user-agent), navegadores automatizados (`navigator.webdriver`), aparelhos
que abriram a página com `?lpm=off` (volta com `?lpm=on`; o link pronto fica em Minha conta) e visitas abertas com `?lpm=test` (ficam
marcadas como teste, visíveis só no status de Site e arquivos). A medição fica 25 meses; leads ficam.

## Localização e Mapa

Cada visita nova ganha país, estado, cidade e o centro da cidade, consultados no próprio servidor na base
gratuita DB-IP City Lite (licença CC BY 4.0, baixada para `DATA_DIR/geo` e trocada uma vez por mês). O IP da
visita não é guardado, só a cidade; o do lead já era guardado e os leads antigos ganham cidade quando a base
abre. A precisão é a da operadora: quem mora numa cidade vizinha pode aparecer na cidade dela.

`/admin/mapa` mostra visitas, contatos ou leads por cidade, com filtro de período, página e canal (Google
Ads, busca orgânica, redes sociais, direto, IA...). O mapa é Leaflet (`public/vendor/leaflet`, licença
BSD-2) sobre contornos locais (`public/geo`: estados e municípios do entorno do DF pela API de malhas do
IBGE, países pelo Natural Earth 1:110m, domínio público): nada é pedido a servidor de mapas de terceiros.
A tabela da tela traz os mesmos números (versão acessível do mapa).

## Central de Inteligência

`/admin/inteligencia` mostra as palavras-chave do Google Ads medidas no site (visitas, contatos, leads,
taxa, período anterior e cidade principal), os canais e as cidades. O botão "Gerar relatório" junta os
números do período (`lib/insights.js`: palavras-chave, campanhas, anúncios, canais, cidades, dias, horas,
aparelhos, páginas e o texto delas) e manda para a OpenAI (`lib/intel.js`, Responses API em segundo plano,
com pesquisa na web e resposta num formato fixo). Nenhum nome, telefone ou mensagem de lead vai junto; a
tela do relatório mostra exatamente o que foi enviado. O relatório traz resumo, diagnóstico, palavras para
investir, revisar, testar e negativar (com botão de copiar no formato do Google Ads), campanhas com grupos e
anúncios (com contagem de caracteres), locais, horários, SEO, ajustes nas páginas, próximos passos, cuidados
com as políticas e a pesquisa de mercado com as fontes. Um relatório por vez; se o servidor reiniciar no
meio, ele continua acompanhando. No boot, o painel confere se a chave é aceita e se o modelo existe.

Os dados não têm custo, impressões nem CTR (isso fica no Google Ads); o relatório é instruído a não
inventar esses números e a tratar amostra pequena como sinal fraco.

## Visual

Menu lateral no computador e gaveta no celular (atributo `popover`, com reserva em `admin.js` para
navegador antigo), modo claro e escuro pelo sistema. Interface neutra; cor só onde é dado: cada página tem a
sua (bolinha no menu, linhas e barras dos gráficos), conferida com validador de paleta para daltonismo.
Fonte Figtree (`public/fonts`, licença SIL OFL) e ícones Lucide (licença ISC) desenhados inline em
`lib/icons.js`.

## Publicar um site por linha de comando

```bash
curl -s -H "Authorization: Bearer $DEPLOY_TOKEN" -F "zip=@site.zip" https://admin.draglazi.com.br/admin/lps/hipro/upload
curl -s -H "Authorization: Bearer $DEPLOY_TOKEN" https://admin.draglazi.com.br/admin/lps/hipro/files
```

Com o token, o upload responde JSON (`ok`, `index_file`, `updated_at`, `pages`). O upload substitui
todos os arquivos do site.

## Desenvolvimento

```bash
npm ci
npm test                      # atribuição, caminhos, UTM, senhas, período, localização e relatório da IA
DATA_DIR=./data ADMIN_HOST=localhost SUPERADMIN_EMAIL=voce@exemplo.com \
  SUPERADMIN_PASSWORD_HASH="$(node scripts/hash-password.js)" npm run dev
```

Para ver o painel com dados (visitas, leads, palavras-chave e cidades fictícios), gere um banco de
demonstração numa pasta vazia: `DATA_DIR=/tmp/lpm-demo node scripts/seed-demo.js <pasta-com-index.html-e-fullface.html>`.

O painel abre em `http://localhost:3000/admin`. Para ver uma página como no domínio, aponte um
nome para 127.0.0.1 e cadastre esse nome como domínio do site.
