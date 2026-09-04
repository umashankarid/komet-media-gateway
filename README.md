# Komet Media Gateway

Controllable per-court media gateway for BMK Komet badminton streaming.

Komet Control (stream.bmkkomet.se) tells this gateway, per court, which YouTube
RTMP target to push to. The gateway runs one FFmpeg process per active court,
reading that court's SRT input and pushing to YouTube.

```
Phone -> SRT (UDP 1000N) -> FFmpeg (court N) -> YouTube RTMP
                              ▲
                              │ POST /courts/N/start { rtmpUrl }
                        Komet Control (internal HTTP)
```

Each court has a fixed SRT port: court N listens on `SRT_BASE_PORT + N - 1`.
Default: Court 1 = 10001, Court 2 = 10002, Court 3 = 10003, Court 4 = 10004.

Video is stream-copied (`-c:v copy`) to stay light on a 2-vCPU VPS; audio is
transcoded to AAC. No overlay burn-in yet.

## Control API

All routes except `/healthz` require `Authorization: Bearer <GATEWAY_TOKEN>`.

- `GET  /healthz` — health check (unauthenticated).
- `GET  /status` — list running courts.
- `GET  /courts/:id/status` — one court's status.
- `POST /courts/:id/start` — body `{ "rtmpUrl": "rtmp://a.rtmp.youtube.com/live2/<key>" }`.
- `POST /courts/:id/stop` — stop that court.

## Environment variables

- `CONTROL_PORT` — control API port (default 8080, internal only).
- `SRT_BASE_PORT` — SRT port for court 1 (default 10001).
- `GATEWAY_TOKEN` — shared secret; Komet Control must send it as a bearer token.
  If unset, the API is open (development only — always set it in production).

## Ports to expose in Coolify

- TCP 8080 — control API (internal network only; do NOT expose publicly).
- UDP 10001–10004 — SRT ingest from phones (one per court).
```
