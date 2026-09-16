FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-bookworm-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
RUN mkdir -p /data

ENV PORT=8787
ENV RADAR_DB_PATH=/data/radar.sqlite
EXPOSE 8787
CMD ["node", "dist/src/server.js"]
