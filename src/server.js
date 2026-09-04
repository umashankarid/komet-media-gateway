import { CourtProcessManager } from "./CourtProcessManager.js";
import { createApp } from "./app.js";

const PORT = Number(process.env.CONTROL_PORT ?? 8080);
const SRT_BASE_PORT = Number(process.env.SRT_BASE_PORT ?? 10001);
const TOKEN = process.env.GATEWAY_TOKEN ?? "";

const manager = new CourtProcessManager({ srtBasePort: SRT_BASE_PORT });
const app = createApp(manager, { token: TOKEN });

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Komet Media Gateway control API on :${PORT}`);
  console.log(`SRT base port: ${SRT_BASE_PORT} (court N -> ${SRT_BASE_PORT}+N-1)`);
  console.log(`Auth: ${TOKEN ? "bearer token required" : "OPEN (no GATEWAY_TOKEN set)"}`);
});

function shutdown() {
  manager.stopAll();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
