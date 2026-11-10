# No build step: tsx runs the TypeScript source directly, as in PA6.
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

CMD ["npx", "tsx", "src/server.ts"]
