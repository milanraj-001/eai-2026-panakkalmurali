# No build step: tsx runs the TypeScript source directly, same as PA2's
# services. See ../docs/adr-004.md for why this project prefers tsx over a
# tsc-then-node compile step for its long-running consumer/producer daemons.
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
# ../shared is bind-mounted at /shared and imports "amqplib" too. Node looks
# for it by walking up from /shared, which ends at /node_modules, so link this
# image's own dependencies there. No host-side install is needed.
RUN npm install && ln -s /app/node_modules /node_modules

COPY src ./src

CMD ["npx", "tsx", "src/server.ts"]
