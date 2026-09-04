# Node base with FFmpeg installed. The container runs the control API, which
# spawns one FFmpeg process per active court (SRT ingest -> YouTube RTMP).
FROM node:20-bookworm-slim

# FFmpeg for the media pipeline; curl for the Coolify healthcheck.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production deps first (better layer caching).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

# Control API port (internal). SRT ports are UDP 10001..10004 (exposed in
# Coolify/compose, not here, since they are UDP and host-mapped).
ENV CONTROL_PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -fsS http://localhost:8080/healthz || exit 1

CMD ["node", "src/server.js"]
