# The rewards runner (src/bot.ts): hourly snapshots and daily epochs.
# Node runs the TypeScript sources directly, so there is no build step. The image carries the program
# file and config/ of the commit it was built from; all state lives in /data.
#
#   docker build -t hydration-rewards --build-arg VCS_REF="$(git rev-parse HEAD)" .
#   docker run --rm -e FIRST_EPOCH=<date of the first epoch> -v hydration-rewards-data:/data hydration-rewards

# Dependencies are plain JavaScript and installed without scripts, so they are installed once on the
# build machine's own platform, whatever platform the image is for.
FROM --platform=$BUILDPLATFORM node:26-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:26-bookworm-slim

ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="hydration-rewards" \
      org.opencontainers.image.source="https://github.com/galacticcouncil/hydration-rewards" \
      org.opencontainers.image.revision="${VCS_REF}"

ENV NODE_ENV=production \
    DATA_DIR=/data

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY config ./config
COPY programs ./programs

# The runner's only state: snapshots, epochs, trees and the files the app reads. Mount a volume here.
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node

# Healthy while the runner refreshes its lock, which it does every minute for as long as it runs,
# also during a long catch-up. A pass that keeps failing shows in /data/status.json, not here.
HEALTHCHECK --interval=60s --timeout=5s --start-period=90s --retries=3 \
  CMD find "$DATA_DIR/bot.lock" -mmin -3 | grep -q . || exit 1

# FIRST_EPOCH is required. RPC_HYDRATION defaults to the public node in config/mainnet.json.
# node is process 1, so it gets SIGTERM and releases the lock when the container stops.
CMD ["node", "src/bot.ts"]
