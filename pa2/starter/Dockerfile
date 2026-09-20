# One image, two roles. docker-compose.yml points `command:` at
# src/producer.ts for the producer service and src/consumer.ts for the
# consumer service — same dependencies, same TypeScript, no build step.
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY src ./src

CMD ["npx", "tsx", "src/producer.ts"]
