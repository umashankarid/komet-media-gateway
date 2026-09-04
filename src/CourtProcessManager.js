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
    const entry = { proc, rtmpUrl, startedAt: Date.now(), srtPort };
    this.courts.set(courtId, entry);

    // Clean up bookkeeping when the process exits on its own.
    if (proc && typeof proc.on === "function") {
      proc.on("exit", () => {
        const cur = this.courts.get(courtId);
        if (cur && cur.proc === proc) this.courts.delete(courtId);
      });
    }
    return { courtId, srtPort, rtmpUrl };
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
    return {
      courtId,
      running: Boolean(entry),
      srtPort: this.srtPort(courtId),
      rtmpUrl: entry?.rtmpUrl,
      startedAt: entry?.startedAt,
      uptimeMs: entry ? Date.now() - entry.startedAt : 0,
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
