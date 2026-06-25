// piper-manager.js
// Manages the Piper TTS HTTP server as a child process inside this
// container, alongside the existing Node/Express app.

const { spawn } = require("child_process");

const PIPER_HOST = "127.0.0.1";
const PIPER_PORT = 5000;
const PIPER_VOICE = process.env.PIPER_VOICE || "en_US-ryan-high";
const PIPER_DATA_DIR = process.env.PIPER_DATA_DIR || "/app/piper-voices";

let piperProcess = null;
let isReady = false;
let restartCount = 0;
const MAX_RESTARTS = 5;

function startPiperServer() {
  console.log(`[piper] starting server with voice=${PIPER_VOICE}, data-dir=${PIPER_DATA_DIR}`);
  isReady = false;

  piperProcess = spawn(
    "python3",
    [
      "-m", "piper.http_server",
      "-m", PIPER_VOICE,
      "--data-dir", PIPER_DATA_DIR,
      "--host", PIPER_HOST,
      "--port", String(PIPER_PORT),
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  piperProcess.stdout.on("data", (chunk) => {
    console.log(`[piper stdout] ${chunk.toString().trim()}`);
  });

  piperProcess.stderr.on("data", (chunk) => {
    console.error(`[piper stderr] ${chunk.toString().trim()}`);
  });

  piperProcess.on("exit", (code, signal) => {
    isReady = false;
    console.error(`[piper] process exited (code=${code}, signal=${signal})`);
    restartCount += 1;
    if (restartCount <= MAX_RESTARTS) {
      const delayMs = 2000 * restartCount;
      console.log(`[piper] restarting in ${delayMs}ms (attempt ${restartCount}/${MAX_RESTARTS})`);
      setTimeout(startPiperServer, delayMs);
    } else {
      console.error("[piper] exceeded max restart attempts - staying down.");
    }
  });

  piperProcess.on("error", (err) => {
    console.error("[piper] failed to spawn process:", err.message);
  });
}

async function waitForPiperReady(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://${PIPER_HOST}:${PIPER_PORT}/voices`);
      if (res.ok) {
        isReady = true;
        restartCount = 0;
        console.log("[piper] server is ready");
        return true;
      }
    } catch (_) {
      // not up yet, keep polling
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error("[piper] did not become ready within timeout");
  return false;
}

function isPiperReady() {
  return isReady;
}

function getPiperEndpoint() {
  return `http://${PIPER_HOST}:${PIPER_PORT}`;
}

module.exports = {
  startPiperServer,
  waitForPiperReady,
  isPiperReady,
  getPiperEndpoint,
};
