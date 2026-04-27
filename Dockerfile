FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install --omit=dev --package-lock=false
COPY src ./src
COPY config ./config

ENV NODE_ENV=production
EXPOSE 8088
CMD ["node", "src/index.js"]
