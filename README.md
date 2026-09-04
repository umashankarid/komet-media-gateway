# Komet Media Gateway

Headless media gateway for BMK Komet badminton streaming.

Initial flow:

Android phone -> SRT -> FFmpeg -> YouTube Live

## Environment variables

- SRT_PORT=10001
- YOUTUBE_RTMP_URL=rtmp://a.rtmp.youtube.com/live2
- YOUTUBE_STREAM_KEY=<secret>
