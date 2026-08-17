# 沈晏后端 —— Railway 迁移产物（2026-08-17）
# ⚠️ package.json 的 main 写的是 index.js，但仓库里没有 index.js，
#    必须显式用 node server.js 启动（Nixpacks/Docker 都吃这个坑）。
# ⚠️ node:20 会崩：supabase-js ^2.110 需要原生 WebSocket（Node 22+）→ 用 24。
FROM node:24-alpine

WORKDIR /app

# 依赖都是纯 JS（express/cors/dotenv/@supabase），--omit=dev 即可，不需要编译
COPY package.json package-lock.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com

COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
