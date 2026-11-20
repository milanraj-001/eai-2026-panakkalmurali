FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY orchestrator ./orchestrator
ENV SERVICE_NAME=orchestrator
CMD ["node", "orchestrator/server.js"]
