# Capstone kit: the payment, inventory, shipping and notification mocks.
# One image; MOCK_SERVICE picks the service. PORT defaults to 4001–4004.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
HEALTHCHECK --interval=3s --timeout=3s --start-period=10s --retries=10 CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/main.js"]
