import { spawn } from "node:child_process";

/**
 * Renders a transparent overlay web page into a virtual X11 display so FFmpeg
 * can capture it (x11grab) and composite it over the phone video.
 *
 * Pipeline per court:
 *   Xvfb :<display> 1920x1080  <-- virtual framebuffer
 *   chromium --headless=new? no -- we need on-screen rendering into Xvfb, so
 *   chromium runs with DISPLAY=:<n> in kiosk mode painting the overlay URL.
 *
 * This is intentionally simple and best-effort: if Xvfb/chromium are missing
 * the process errors are logged and the FFmpeg overlay grab will show black,
 * but the stream itself still runs.
 */
export class OverlayRenderer {
  /**
   * @param {string} display e.g. ":100"
   * @param {string} url overlay page URL
   * @param {object} [opts]
   * @param {(cmd:string,args:string[],options?:object)=>import("node:child_process").ChildProcess} [opts.spawnFn]
   * @param {string} [opts.chromiumBin]
   */
  constructor(display, url, opts = {}) {
    this.display = display;
    this.url = url;
    this.spawnFn = opts.spawnFn ?? spawn;
    this.chromiumBin = opts.chromiumBin ?? process.env.CHROMIUM_BIN ?? "chromium";
    this.xvfb = undefined;
    this.chromium = undefined;
  }

  start() {
    const size = "1920x1080x24";
    // 1) Virtual framebuffer for this display.
    this.xvfb = this.spawnFn("Xvfb", [this.display, "-screen", "0", size, "-nolisten", "tcp"]);
    this.xvfb.on?.("error", (e) =>
      console.log(`[overlay ${this.display}] Xvfb error: ${e.message}`),
    );

    // 2) Chromium paints the overlay URL into that display. A short delay lets
    // Xvfb come up first.
    setTimeout(() => {
      this.chromium = this.spawnFn(
        this.chromiumBin,
        [
          "--no-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--kiosk",
          "--window-position=0,0",
          "--window-size=1920,1080",
          // Transparent background so the overlay composites cleanly.
          "--default-background-color=00000000",
          "--force-device-scale-factor=1",
          this.url,
        ],
        { env: { ...process.env, DISPLAY: this.display } },
      );
      this.chromium.on?.("error", (e) =>
        console.log(`[overlay ${this.display}] chromium error: ${e.message}`),
      );
    }, 800);
  }

  stop() {
    for (const p of [this.chromium, this.xvfb]) {
      try {
        if (p && typeof p.kill === "function") p.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    this.chromium = undefined;
    this.xvfb = undefined;
  }
}

/** Default factory used by CourtProcessManager. */
export function defaultRendererFactory(display, url) {
  return new OverlayRenderer(display, url);
}
