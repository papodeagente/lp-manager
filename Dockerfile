FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

RUN apk add --no-cache tini

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# os módulos precisam carregar com as dependências de produção: um erro de import derruba o
# build aqui, com a mensagem no log do deploy, em vez de o contêiner morrer em silêncio
RUN node -e "Promise.all(['./lib/db.js','./lib/geo.js','./lib/insights.js','./lib/intel.js','./lib/central.js'].map((m) => import(m))).then(() => console.log('módulos ok'))"

RUN mkdir -p /app/data/sites

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
