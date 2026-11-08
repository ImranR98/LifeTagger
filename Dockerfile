# syntax=docker/dockerfile:1

FROM node:26-bookworm AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY web/package.json web/package-lock.json ./web/
RUN npm ci --ignore-scripts \
    && npm rebuild @tensorflow/tfjs-node \
    && npm --prefix web ci --ignore-scripts

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:26-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg libatomic1 libgomp1 perl tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    MEDIA_ROOT=/media \
    ALLOWED_MEDIA_ROOTS=/media \
    HOME=/tmp

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist

RUN mkdir -p /data /media && chown -R node:node /data
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
