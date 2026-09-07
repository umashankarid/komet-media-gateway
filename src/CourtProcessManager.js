import { spawn } from "node:child_process";
import { defaultRendererFactory } from "./OverlayRenderer.js";

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
    /** Log FFmpeg stderr to the gateway console (for diagnostics). */
    this.logFfmpeg = opts.logFfmpeg ?? true;
    /** Delay before respawning FFmpeg after an unexpected exit (ms). */
    this.restartDelayMs = opts.restartDelayMs ?? 500;
    /** Injectable setTimeout (for tests). */
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
    /**
     * Factory that creates an overlay renderer (Xvfb + Chromium) for a display
     * and URL. Injectable for tests. Defaults to the real renderer.
     */
    this.rendererFactory = opts.rendererFactory ?? defaultRendererFactory;
    /** @type {Map<number, { proc: import("node:child_process").ChildProcess, rtmpUrl: string, startedAt: number, srtPort: number }>} */
    this.courts = new Map();
  }

  /** SRT listener port for a court. */
  srtPort(courtId) {
    return this.srtBasePort + (courtId - 1);
  }

  /**
   * Build the FFmpeg args.
   *  - No overlay: SRT (MPEG-TS) in -> copy video -> FLV/RTMP (cheap).
   *  - Overlay: SRT video + an X11 display (Chromium rendering the overlay page)
   *    composited via the overlay filter, then re-encoded to H.264 (heavier).
   *
   * @param {number} courtId
   * @param {string} rtmpUrl
   * @param {{ overlay?: boolean, display?: string, videoBitrate?: string }} [opts]
   */
  buildArgs(courtId, rtmpUrl, opts = {}) {
    const port = this.srtPort(courtId);
    const srtInput = `srt://0.0.0.0:${port}?mode=listener&latency=${this.srtLatencyMicros}&listen_timeout=-1`;

    if (!opts.overlay) {
      // Lightweight passthrough (no re-encode).
      return [
        "-f", "mpegts",
        "-i", srtInput,
        "-c:v", "copy",
        "-c:a", "aac",
        "-f", "flv",
        rtmpUrl,
      ];
    }

    // Overlay burn-in: composite the X11 display (transparent overlay page,
    // rendered by Chromium into Xvfb) over the phone video, then encode.
    const display = opts.display || ":99";
    const vBitrate = opts.videoBitrate || "6000k";
    return [
      // Larger input queues avoid "Thread message queue blocking" stalls when
      // mixing the live SRT input with the x11grab display.
      "-thread_queue_size", "512",
      "-fflags", "+genpts",
      "-f", "mpegts",
      "-i", srtInput,
      // Second input: the virtual display where Chromium renders the overlay.
      "-thread_queue_size", "512",
      "-f", "x11grab",
      "-framerate", "30",
      "-video_size", "1920x1080",
      "-i", display,
      // Scale phone video to 1080p, force 30fps (the phone stream reports a 90k
      // timebase that FFmpeg otherwise misreads as 90k fps and x264 rejects),
      // then overlay the captured page on top.
      "-filter_complex",
      "[0:v]scale=1920:1080,fps=30,setpts=PTS-STARTPTS[bg];[bg][1:v]overlay=0:0:format=auto[v]",
      "-map", "[v]",
      "-map", "0:a?",
      "-r", "30",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-tune", "zerolatency",
      "-b:v", vBitrate,
      "-maxrate", vBitrate,
      "-bufsize", "12000k",
      "-pix_fmt", "yuv420p",
      "-g", "60",
      "-c:a", "aac",
      "-ar", "44100",
      "-f", "flv",
      rtmpUrl,
    ];
  }

  /**
   * Start (or restart) streaming for a court.
   * @param {number} courtId
   * @param {string} rtmpUrl
   * @param {{ overlay?: boolean, overlayUrl?: string }} [options]
   */
  start(courtId, rtmpUrl, options = {}) {
    if (!Number.isInteger(courtId) || courtId < 1) {
      throw new Error("courtId must be a positive integer");
    }
    if (typeof rtmpUrl !== "string" || !rtmpUrl.startsWith("rtmp")) {
      throw new Error("rtmpUrl must be an rtmp(s) URL");
    }
    // Restart if already running.
    if (this.courts.has(courtId)) this.stop(courtId);

    const srtPort = this.srtPort(courtId);
    // Each overlay court gets its own X11 display (:99 + courtId) so multiple
    // courts don't collide.
    const display = `:${99 + courtId}`;
    const entry = {
      proc: undefined,
      rtmpUrl,
      startedAt: Date.now(),
      srtPort,
      lastProgressAt: 0,
      media: {},
      desired: true,
      restartTimer: undefined,
      overlay: Boolean(options.overlay),
      overlayUrl: options.overlayUrl,
      display,
      renderer: undefined,
    };
    this.courts.set(courtId, entry);

    // For overlay mode, start the headless renderer (Xvfb + Chromium) that
    // paints the overlay page into this court's X11 display before FFmpeg
    // captures it.
    if (entry.overlay && entry.overlayUrl && this.rendererFactory) {
      entry.renderer = this.rendererFactory(display, entry.overlayUrl);
      if (entry.renderer && typeof entry.renderer.start === "function") {
        entry.renderer.start();
      }
    }

    this.spawnFor(courtId);
    return { courtId, srtPort, rtmpUrl, overlay: entry.overlay };
  }

  /** Spawn (or respawn) the FFmpeg process for a court that is 'desired'. */
  spawnFor(courtId) {
    const entry = this.courts.get(courtId);
    if (!entry || !entry.desired) return;
    const args = this.buildArgs(courtId, entry.rtmpUrl, {
      overlay: entry.overlay,
      display: entry.display,
    });
    const proc = this.spawnFn("ffmpeg", args);
    entry.proc = proc;

    if (proc && proc.stderr && typeof proc.stderr.on === "function") {
      proc.stderr.on("data", (chunk) => {
        const cur = this.courts.get(courtId);
        if (!cur || cur.proc !== proc) return;
        const text = chunk.toString();
        this.parseProgress(cur, text);
        if (this.logFfmpeg) process.stderr.write(`[court ${courtId}] ${text}`);
      });
    }

    if (proc && typeof proc.on === "function") {
      proc.on("exit", (code, signal) => {
        // eslint-disable-next-line no-console
        console.log(
          `[court ${courtId}] ffmpeg exited code=${code} signal=${signal}`,
        );
        const cur = this.courts.get(courtId);
        if (!cur || cur.proc !== proc) return;
        cur.proc = undefined;
        // Respawn if still desired (e.g. exited before the phone connected).
        if (cur.desired) {
          cur.restartTimer = this.setTimeoutFn(() => {
            this.spawnFor(courtId);
          }, this.restartDelayMs);
          if (cur.restartTimer && typeof cur.restartTimer.unref === "function") {
            cur.restartTimer.unref();
          }
        } else {
          this.courts.delete(courtId);
        }
      });
      proc.on("error", (err) => {
        // eslint-disable-next-line no-console
        console.log(`[court ${courtId}] ffmpeg spawn error: ${err.message}`);
      });
    }
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
    // Mark undesired first so the exit handler does not respawn it.
    entry.desired = false;
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
    }
    if (entry.renderer && typeof entry.renderer.stop === "function") {
      try { entry.renderer.stop(); } catch { /* ignore */ }
    }
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
