FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY shared ./shared
ENV SERVICE_NAME=notifier
ENV CONSUMER_QUEUE=notifications.queue
CMD ["node", "shared/service.js"]
