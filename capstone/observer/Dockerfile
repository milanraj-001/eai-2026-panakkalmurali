FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY shared ./shared
ENV SERVICE_NAME=observer
ENV CONSUMER_QUEUE=trace.store
CMD ["node", "shared/service.js"]
