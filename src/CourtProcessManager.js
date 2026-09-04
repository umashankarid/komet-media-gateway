import { spawn } from "node:child_process";

/**
 * Manages one FFmpeg process per court. Each court has a fixed SRT listener
 * port (base + courtId - 1). Starting a court spawns FFmpeg reading that SRT
 * input and pushing to the given RTMP target (YouTube). Stopping kills it.
 *
 * Video is copied (-c:v copy) to stay cheap on a 2-vCPU VPS; audio is
 * transcoded to AAC for YouTube compatibility. No overlay yet (Rule: keep
 * stream-copy mode available).
 */
export class CourtProcessManager {
  /**
   * @param {object} [opts]
   * @param {number} [opts.srtBasePort] SRT port for court 1 (default 10001).
   * @param {(cmd: string, args: string[]) => import("node:child_process").ChildProcess} [opts.spawnFn]
   *   Injectable spawn (for tests). Defaults to child_process.spawn.
   * @param {number} [opts.srtLatencyMicros] SRT latency in microseconds.
   */
  constructor(opts = {}) {
    this.srtBasePort = opts.srtBasePort ?? 10001;
    this.spawnFn = opts.spawnFn ?? spawn;
    this.srtLatencyMicros = opts.srtLatencyMicros ?? 200000;
    /** How recent FFmpeg progress must be to count as "connected" (ms). */
    this.ingestFreshnessMs = opts.ingestFreshnessMs ?? 10000;
    /** @type {Map<number, { proc: import("node:child_process").ChildProcess, rtmpUrl: string, startedAt: number, srtPort: number }>} */
    this.courts = new Map();
  }

  /** SRT listener port for a court. */
  srtPort(courtId) {
    return this.srtBasePort + (courtId - 1);
  }

  /** Build the FFmpeg args: SRT listener input -> FLV/RTMP output. */
  buildArgs(courtId, rtmpUrl) {
    const port = this.srtPort(courtId);
    return [
      "-i",
      `srt://0.0.0.0:${port}?mode=listener&latency=${this.srtLatencyMicros}`,
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-f",
      "flv",
      rtmpUrl,
    ];
  }

  /**
   * Start (or restart) streaming for a court to the given RTMP URL.
   * @returns {{ courtId: number, srtPort: number, rtmpUrl: string }}
   */
  start(courtId, rtmpUrl) {
    if (!Number.isInteger(courtId) || courtId < 1) {
      throw new Error("courtId must be a positive integer");
    }
    if (typeof rtmpUrl !== "string" || !rtmpUrl.startsWith("rtmp")) {
      throw new Error("rtmpUrl must be an rtmp(s) URL");
    }
    // Restart if already running.
    if (this.courts.has(courtId)) this.stop(courtId);

    const args = this.buildArgs(courtId, rtmpUrl);
    const proc = this.spawnFn("ffmpeg", args);
    const srtPort = this.srtPort(courtId);
    const entry = {
      proc,
      rtmpUrl,
      startedAt: Date.now(),
      srtPort,
      // Ingest activity: set once FFmpeg emits encoding progress (data flowing).
      lastProgressAt: 0,
      media: {},
    };
    this.courts.set(courtId, entry);

    // FFmpeg writes progress ("frame=... fps=... bitrate=...") to stderr once
    // video is actually flowing. We treat any such line as "ingest active" and
    // parse resolution/fps when the stream info appears.
    if (proc && proc.stderr && typeof proc.stderr.on === "function") {
      proc.stderr.on("data", (chunk) => {
        const cur = this.courts.get(courtId);
        if (!cur || cur.proc !== proc) return;
        const text = chunk.toString();
        this.parseProgress(cur, text);
      });
    }

    // Clean up bookkeeping when the process exits on its own.
    if (proc && typeof proc.on === "function") {
      proc.on("exit", () => {
        const cur = this.courts.get(courtId);
        if (cur && cur.proc === proc) this.courts.delete(courtId);
      });
    }
    return { courtId, srtPort, rtmpUrl };
  }

  /** Parse an FFmpeg stderr chunk: mark progress + extract media info. */
  parseProgress(entry, text) {
    // Progress lines contain "frame=" and/or "bitrate="; their presence means
    // FFmpeg is receiving and encoding data → ingest is active.
    if (/\bframe=\s*\d+/.test(text) || /\bbitrate=\s*[\d.]+/.test(text)) {
      entry.lastProgressAt = Date.now();
    }
    // Stream info line, e.g. "Stream #0:0: Video: h264 ..., 1920x1080, 30 fps".
    const res = text.match(/(\d{2,5})x(\d{2,5})/);
    if (res) {
      entry.media.width = Number(res[1]);
      entry.media.height = Number(res[2]);
    }
    // Prefer the progress "fps= NN" form; else the stream-info "NN fps" form.
    const fpsEq = text.match(/fps=\s*([\d.]+)/);
    const fpsInfo = text.match(/([\d.]+)\s*fps\b/);
    if (fpsEq) entry.media.fps = Math.round(Number(fpsEq[1]));
    else if (fpsInfo) entry.media.fps = Math.round(Number(fpsInfo[1]));
    const br = text.match(/bitrate=\s*([\d.]+)\s*kbits\/s/);
    if (br) entry.media.bitrateKbps = Math.round(Number(br[1]));
  }

  /**
   * Stop streaming for a court.
   * @returns {boolean} true if a process was running.
   */
  stop(courtId) {
    const entry = this.courts.get(courtId);
    if (!entry) return false;
    try {
      if (entry.proc && typeof entry.proc.kill === "function") {
        entry.proc.kill("SIGTERM");
      }
    } finally {
      this.courts.delete(courtId);
    }
    return true;
  }

  /** True if a court is currently streaming. */
  isRunning(courtId) {
    return this.courts.has(courtId);
  }

  /** Status of one court. */
  courtStatus(courtId) {
    const entry = this.courts.get(courtId);
    // "connected" = FFmpeg is running AND we've seen encoding progress within
    // the freshness window (data is actually flowing from the phone).
    const connected = Boolean(
      entry &&
        entry.lastProgressAt > 0 &&
        Date.now() - entry.lastProgressAt < this.ingestFreshnessMs,
    );
    return {
      courtId,
      running: Boolean(entry),
      connected,
      srtPort: this.srtPort(courtId),
      rtmpUrl: entry?.rtmpUrl,
      startedAt: entry?.startedAt,
      uptimeMs: entry ? Date.now() - entry.startedAt : 0,
      lastSeenAt: entry?.lastProgressAt || undefined,
      media: entry && connected ? entry.media : undefined,
    };
  }

  /** Status of all currently running courts. */
  status() {
    return [...this.courts.keys()].sort((a, b) => a - b).map((id) => this.courtStatus(id));
  }

  /** Stop everything (used on shutdown). */
  stopAll() {
    for (const id of [...this.courts.keys()]) this.stop(id);
  }
}
