FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV LAKE_ROOT=/lake
ENV STATE_DB_PATH=/state/data-backtest.db
ENV DATA_BACKTEST_PORT=3100

EXPOSE 3100

CMD ["node", "src/server.js"]
