import express from "express";

/**
 * Build the gateway control API.
 *
 *   GET  /healthz                 -> { status: "ok" }
 *   GET  /status                  -> running courts
 *   GET  /courts/:id/status       -> one court's status
 *   POST /courts/:id/start        -> { rtmpUrl } starts FFmpeg for the court
 *   POST /courts/:id/stop         -> stops FFmpeg for the court
 *
 * All /courts and /status routes require a bearer token (GATEWAY_TOKEN) so the
 * internal API is not open. /healthz is unauthenticated for Coolify checks.
 *
 * @param {import("./CourtProcessManager.js").CourtProcessManager} manager
 * @param {{ token?: string }} [opts]
 */
export function createApp(manager, opts = {}) {
  const app = express();
  app.use(express.json());

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

  // Bearer-token guard for everything except /healthz.
  app.use((req, res, next) => {
    if (req.path === "/healthz") return next();
    if (!opts.token) return next(); // no token configured => open (dev only)
    const auth = req.headers.authorization || "";
    const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (provided !== opts.token) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return next();
  });

  const parseCourtId = (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      const err = new Error("courtId must be a positive integer");
      err.status = 400;
      throw err;
    }
    return id;
  };

  const handle = (fn) => (req, res) => {
    try {
      fn(req, res);
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  };

  app.get(
    "/status",
    handle((_req, res) => res.json({ courts: manager.status() })),
  );

  app.get(
    "/courts/:id/status",
    handle((req, res) => res.json(manager.courtStatus(parseCourtId(req)))),
  );

  app.post(
    "/courts/:id/start",
    handle((req, res) => {
      const courtId = parseCourtId(req);
      const rtmpUrl = req.body?.rtmpUrl;
      const overlay = Boolean(req.body?.overlay);
      const overlayUrl = typeof req.body?.overlayUrl === "string" ? req.body.overlayUrl : undefined;
      const result = manager.start(courtId, rtmpUrl, { overlay, overlayUrl });
      res.json({ ok: true, ...result });
    }),
  );

  app.post(
    "/courts/:id/stop",
    handle((req, res) => {
      const courtId = parseCourtId(req);
      const stopped = manager.stop(courtId);
      res.json({ ok: true, stopped });
    }),
  );

  return app;
}
