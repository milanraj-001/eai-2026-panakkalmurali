FROM node:20-bookworm-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY shared ./shared
COPY intake ./intake

ENV SERVICE_NAME=intake
CMD ["node", "intake/server.js"]
