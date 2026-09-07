import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { CourtProcessManager } from "../src/CourtProcessManager.js";

/** A fake child process that records kills and can emit exit/stderr. */
class FakeProc extends EventEmitter {
  constructor() {
    super();
    this.killed = false;
    this.killSignal = undefined;
    this.stderr = new EventEmitter();
  }
  kill(signal) {
    this.killed = true;
    this.killSignal = signal;
    this.emit("exit", 0, signal);
  }
  /** Simulate FFmpeg emitting a stderr chunk. */
  emitStderr(text) {
    this.stderr.emit("data", Buffer.from(text));
  }
}

/** A spawn stub that records invocations and returns FakeProc instances. */
function fakeSpawn() {
  const calls = [];
  const procs = [];
  const fn = (cmd, args) => {
    const proc = new FakeProc();
    calls.push({ cmd, args });
    procs.push(proc);
    return proc;
  };
  return { fn, calls, procs };
}

describe("CourtProcessManager", () => {
  it("maps court ids to SRT ports from the base", () => {
    const m = new CourtProcessManager({ srtBasePort: 10001, spawnFn: fakeSpawn().fn });
    assert.equal(m.srtPort(1), 10001);
    assert.equal(m.srtPort(2), 10002);
    assert.equal(m.srtPort(4), 10004);
  });

  it("builds ffmpeg args: SRT listener input -> flv rtmp output", () => {
    const m = new CourtProcessManager({ srtBasePort: 10001, spawnFn: fakeSpawn().fn });
    const args = m.buildArgs(1, "rtmp://a.rtmp.youtube.com/live2/key1");
    assert.ok(args.includes("-i"));
    assert.ok(args.some((a) => a.includes("srt://0.0.0.0:10001?mode=listener")));
    // -f mpegts must come before -i (describes the incoming SRT container).
    const fIdx = args.indexOf("mpegts");
    const iIdx = args.indexOf("-i");
    assert.ok(fIdx > -1 && fIdx < iIdx, "-f mpegts must precede -i");
    // codec/format flags present
    const joined = args.join(" ");
    assert.ok(joined.includes("-c:v copy"));
    assert.ok(joined.includes("-c:a aac"));
    assert.ok(joined.includes("-f flv"));
    assert.equal(args[args.length - 1], "rtmp://a.rtmp.youtube.com/live2/key1");
  });

  it("starts a court, spawning ffmpeg with the right port and target", () => {
    const spawn = fakeSpawn();
    const m = new CourtProcessManager({ srtBasePort: 10001, spawnFn: spawn.fn });
    const res = m.start(2, "rtmp://x/live2/key2");
    assert.equal(res.courtId, 2);
    assert.equal(res.srtPort, 10002);
    assert.equal(spawn.calls.length, 1);
    assert.equal(spawn.calls[0].cmd, "ffmpeg");
    assert.ok(spawn.calls[0].args.some((a) => a.includes("srt://0.0.0.0:10002")));
    assert.ok(m.isRunning(2));
  });

  it("rejects invalid court id and rtmp url", () => {
    const m = new CourtProcessManager({ spawnFn: fakeSpawn().fn });
    assert.throws(() => m.start(0, "rtmp://x"), /courtId/);
    assert.throws(() => m.start(1, "http://not-rtmp"), /rtmpUrl/);
  });

  it("restarts a court by killing the old process first", () => {
    const spawn = fakeSpawn();
    const m = new CourtProcessManager({ spawnFn: spawn.fn });
    m.start(1, "rtmp://x/live2/a");
    const firstProc = spawn.procs[0];
    m.start(1, "rtmp://x/live2/b");
    assert.equal(firstProc.killed, true);
    assert.equal(spawn.calls.length, 2);
    assert.equal(m.courtStatus(1).rtmpUrl, "rtmp://x/live2/b");
  });

  it("stops a court and reports it", () => {
    const spawn = fakeSpawn();
    const m = new CourtProcessManager({ spawnFn: spawn.fn });
    m.start(3, "rtmp://x/live2/c");
    assert.equal(m.stop(3), true);
    assert.equal(m.isRunning(3), false);
    assert.equal(spawn.procs[0].killed, true);
    // Stopping again returns false.
    assert.equal(m.stop(3), false);
  });

  it("respawns ffmpeg if it exits while still desired (start-order safe)", () => {
    const spawn = fakeSpawn();
    // Run the restart timer synchronously for the test.
    const m = new CourtProcessManager({
      spawnFn: spawn.fn,
      logFfmpeg: false,
      setTimeoutFn: (fn) => {
        fn();
        return { unref() {} };
      },
    });
    m.start(1, "rtmp://x/live2/a");
    assert.equal(spawn.calls.length, 1);
    // FFmpeg exits (e.g. no data yet) → should respawn because still desired.
    spawn.procs[0].emit("exit", 1, null);
    assert.ok(m.isRunning(1), "court should still be desired/running");
    assert.equal(spawn.calls.length, 2, "ffmpeg should be respawned");
  });

  it("does not respawn after stop()", () => {
    const spawn = fakeSpawn();
    const m = new CourtProcessManager({
      spawnFn: spawn.fn,
      logFfmpeg: false,
      setTimeoutFn: (fn) => {
        fn();
        return { unref() {} };
      },
    });
    m.start(1, "rtmp://x/live2/a");
    m.stop(1);
    assert.equal(m.isRunning(1), false);
    // Any exit event after stop must not respawn.
    spawn.procs[0].emit("exit", 0, "SIGTERM");
    assert.equal(spawn.calls.length, 1);
  });

  it("reports status for running courts sorted by id", () => {
    const spawn = fakeSpawn();
    const m = new CourtProcessManager({ spawnFn: spawn.fn });
    m.start(3, "rtmp://x/live2/c");
    m.start(1, "rtmp://x/live2/a");
    const status = m.status();
    assert.deepEqual(status.map((s) => s.courtId), [1, 3]);
    assert.equal(status[0].running, true);
    assert.equal(status[0].srtPort, 10001);
  });

  it("stopAll stops every court", () => {
    const spawn = fakeSpawn();
    const m = new CourtProcessManager({ spawnFn: spawn.fn });
    m.start(1, "rtmp://x/live2/a");
    m.start(2, "rtmp://x/live2/b");
    m.stopAll();
    assert.equal(m.status().length, 0);
  });

  it("builds a copy pipeline when overlay is off", () => {
    const m = new CourtProcessManager({ spawnFn: fakeSpawn().fn });
    const args = m.buildArgs(1, "rtmp://x/live2/a", { overlay: false });
    assert.ok(args.join(" ").includes("-c:v copy"));
    assert.ok(!args.join(" ").includes("libx264"));
  });

  it("builds an overlay/encode pipeline with x11grab when overlay is on", () => {
    const m = new CourtProcessManager({ spawnFn: fakeSpawn().fn });
    const args = m.buildArgs(1, "rtmp://x/live2/a", { overlay: true, display: ":100" });
    const j = args.join(" ");
    assert.ok(j.includes("x11grab"), "should grab the X display");
    assert.ok(j.includes(":100"), "should use the given display");
    assert.ok(j.includes("overlay=0:0"), "should composite overlay");
    assert.ok(j.includes("libx264"), "should re-encode");
    assert.ok(!j.includes("-c:v copy"), "must not copy when overlaying");
  });

  it("starts and stops an overlay renderer for overlay mode", () => {
    const events = [];
    const rendererFactory = (display, url) => ({
      start() { events.push(["start", display, url]); },
      stop() { events.push(["stop", display, url]); },
    });
    const m = new CourtProcessManager({ spawnFn: fakeSpawn().fn, rendererFactory });
    m.start(1, "rtmp://x/live2/a", {
      overlay: true,
      overlayUrl: "https://stream/broadcast-overlay?court=1&mode=full",
    });
    assert.deepEqual(events[0], ["start", ":100", "https://stream/broadcast-overlay?court=1&mode=full"]);
    m.stop(1);
    assert.equal(events.some((e) => e[0] === "stop"), true);
  });

  it("does not start a renderer when overlay is off", () => {
    let created = false;
    const rendererFactory = () => { created = true; return { start() {}, stop() {} }; };
    const m = new CourtProcessManager({ spawnFn: fakeSpawn().fn, rendererFactory });
    m.start(1, "rtmp://x/live2/a", { overlay: false });
    assert.equal(created, false);
  });

  it("reports connected only after ffmpeg emits progress", () => {
    const spawn = fakeSpawn();
    const m = new CourtProcessManager({ spawnFn: spawn.fn });
    m.start(1, "rtmp://x/live2/a");
    // Running but no data yet.
    assert.equal(m.courtStatus(1).running, true);
    assert.equal(m.courtStatus(1).connected, false);
    // FFmpeg emits a progress line → connected.
    spawn.procs[0].emitStderr("frame=  120 fps= 30 q=-1.0 size=1024kB bitrate=6000.0kbits/s");
    assert.equal(m.courtStatus(1).connected, true);
    assert.equal(m.courtStatus(1).lastSeenAt > 0, true);
  });

  it("parses resolution, fps and bitrate from ffmpeg output", () => {
    const spawn = fakeSpawn();
    const m = new CourtProcessManager({ spawnFn: spawn.fn });
    m.start(1, "rtmp://x/live2/a");
    spawn.procs[0].emitStderr(
      "Stream #0:0: Video: h264, yuv420p, 1920x1080, 30 fps",
    );
    spawn.procs[0].emitStderr("frame=  10 fps= 30 bitrate=6034.0kbits/s");
    const s = m.courtStatus(1);
    assert.equal(s.connected, true);
    assert.equal(s.media.width, 1920);
    assert.equal(s.media.height, 1080);
    assert.equal(s.media.fps, 30);
    assert.equal(s.media.bitrateKbps, 6034);
  });

  it("treats stale progress as not connected", () => {
    const spawn = fakeSpawn();
    const m = new CourtProcessManager({ spawnFn: spawn.fn, ingestFreshnessMs: 5 });
    m.start(1, "rtmp://x/live2/a");
    spawn.procs[0].emitStderr("frame= 1 bitrate=100.0kbits/s");
    // Force lastProgressAt into the past.
    m.courts.get(1).lastProgressAt = Date.now() - 1000;
    assert.equal(m.courtStatus(1).connected, false);
  });
});
