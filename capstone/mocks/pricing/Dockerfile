# Capstone kit: the pricing mock. PORT defaults to 4100.
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js products.json ./
USER node
EXPOSE 4100
HEALTHCHECK --interval=3s --timeout=3s --start-period=10s --retries=10 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||4100)+'/health', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"
CMD ["node", "server.js"]
