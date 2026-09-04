import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.js";

/** Minimal manager stub recording calls. */
function stubManager() {
  const calls = [];
  return {
    calls,
    start(courtId, rtmpUrl) {
      calls.push(["start", courtId, rtmpUrl]);
      if (!rtmpUrl || !rtmpUrl.startsWith("rtmp")) {
        throw new Error("rtmpUrl must be an rtmp(s) URL");
      }
      return { courtId, srtPort: 10000 + courtId, rtmpUrl };
    },
    stop(courtId) {
      calls.push(["stop", courtId]);
      return true;
    },
    courtStatus(courtId) {
      return { courtId, running: false, srtPort: 10000 + courtId };
    },
    status() {
      return [];
    },
  };
}

/** Start the app on an ephemeral port; return base url + close(). */
function serve(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

describe("gateway control API (token required)", () => {
  const TOKEN = "secret-token";
  let ctx;
  let srv;
  before(async () => {
    ctx = stubManager();
    srv = await serve(createApp(ctx, { token: TOKEN }));
  });
  after(() => srv.close());

  const authed = (path, init = {}) =>
    fetch(srv.base + path, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
    });

  it("serves /healthz without a token", async () => {
    const res = await fetch(srv.base + "/healthz");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });

  it("rejects /status without a token", async () => {
    const res = await fetch(srv.base + "/status");
    assert.equal(res.status, 401);
  });

  it("rejects a wrong token", async () => {
    const res = await fetch(srv.base + "/status", {
      headers: { Authorization: "Bearer nope" },
    });
    assert.equal(res.status, 401);
  });

  it("starts a court with the given rtmp url", async () => {
    const res = await authed("/courts/1/start", {
      method: "POST",
      body: JSON.stringify({ rtmpUrl: "rtmp://a.rtmp.youtube.com/live2/key1" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.courtId, 1);
    assert.deepEqual(ctx.calls.at(-1), ["start", 1, "rtmp://a.rtmp.youtube.com/live2/key1"]);
  });

  it("rejects a start with a bad rtmp url", async () => {
    const res = await authed("/courts/1/start", {
      method: "POST",
      body: JSON.stringify({ rtmpUrl: "http://nope" }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /rtmpUrl/);
  });

  it("validates the court id", async () => {
    const res = await authed("/courts/0/start", {
      method: "POST",
      body: JSON.stringify({ rtmpUrl: "rtmp://x/live2/k" }),
    });
    assert.equal(res.status, 400);
  });

  it("stops a court", async () => {
    const res = await authed("/courts/2/stop", { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).stopped, true);
    assert.deepEqual(ctx.calls.at(-1), ["stop", 2]);
  });

  it("returns court status", async () => {
    const res = await authed("/courts/3/status");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).courtId, 3);
  });
});

describe("gateway control API (open when no token)", () => {
  let srv;
  before(async () => {
    srv = await serve(createApp(stubManager(), {}));
  });
  after(() => srv.close());

  it("allows /status without a token when none configured", async () => {
    const res = await fetch(srv.base + "/status");
    assert.equal(res.status, 200);
  });
});
