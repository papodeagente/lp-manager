# lp-manager

Mapa de direcionamento. Leia antes de explorar. Se o código contradisser este arquivo, o código vale; corrija este arquivo.

## O que é
Servidor das landing pages e do painel, em um processo só:
- Nos domínios das páginas (ex.: `draglazi.com.br`), serve o site publicado e injeta a medição.
- No domínio do painel (`ADMIN_HOST`, ex.: `admin.draglazi.com.br`), serve o painel em `/admin`.

Stack: Node 22, Express, SQLite (`better-sqlite3`) e EJS. Sem etapa de build. Dados em `DATA_DIR` (`lps.db` e `sites/<slug>/`). No Coolify, esse diretório é um volume persistente.

## Variáveis de ambiente
- `ADMIN_HOST`: domínio(s) do painel, separados por vírgula
- `SESSION_SECRET`: assina o cookie. Precisa ser fixo entre deploys, senão as sessões caem.
- `SUPERADMIN_EMAIL`: dono do painel. É criado (ou reativado) a cada boot.
- `SUPERADMIN_PASSWORD_HASH`: hash da senha, nunca a senha. Gere com `node scripts/hash-password.js`.
- `SUPERADMIN_NAME`: opcional
- `OPENAI_API_KEY`: relatórios da Central de Inteligência (`INTEL_MODEL`, `INTEL_EFFORT`, `INTEL_WEB_SEARCH`, `INTEL_DAILY_LIMIT` opcionais)
- `GEO_DB_FILE`, `GEO_DB_URL`, `GEO_DISABLE`: base de localização (opcionais; o padrão baixa a DB-IP do mês)

## Onde fica o quê
- `server.js`: entrada
- `lib/`: lógica (`geo.js` localização, `insights.js` agregados do mapa e da IA, `intel.js` relatório da OpenAI, `central.js` rotas do Mapa e da Inteligência, `tlds.js` lista de domínios da IANA usada na limpeza do texto que vai para a IA)
- `views/`: templates EJS
- `public/`: assets do painel
- `scripts/`: utilitários (`seed-demo.js` cria um banco de demonstração local)
- `test/`: testes

## Comandos
- `npm start`, `npm run dev` (com watch), `npm test` (`node --test`)

## Regras
Nunca colocar senha ou segredo em arquivo versionado.
