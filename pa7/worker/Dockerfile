# Debian, not Alpine: the Temporal SDK's native core is built against glibc.
# No build step: tsx runs the TypeScript source directly, as in PA5 and PA6.
# The worker bundles src/workflows/ itself when it starts.
FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

CMD ["npx", "tsx", "src/worker.ts"]
