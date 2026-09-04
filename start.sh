#!/bin/bash
set -e

echo "Starting Komet Media Gateway"

SRT_PORT=${SRT_PORT:-10001}
YOUTUBE_RTMP_URL=${YOUTUBE_RTMP_URL:-rtmp://a.rtmp.youtube.com/live2}
YOUTUBE_STREAM_KEY=${YOUTUBE_STREAM_KEY:-}

if [ -z "$YOUTUBE_STREAM_KEY" ]; then
  echo "ERROR: YOUTUBE_STREAM_KEY is not set"
  exit 1
fi

echo "Listening for SRT on UDP port ${SRT_PORT}"

ffmpeg \
  -listen 1 \
  -i "srt://0.0.0.0:${SRT_PORT}?mode=listener&latency=200000" \
  -c:v copy \
  -c:a aac \
  -f flv \
  "${YOUTUBE_RTMP_URL}/${YOUTUBE_STREAM_KEY}"
