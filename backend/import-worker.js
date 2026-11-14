// One website import, in its own thread (see runImport in importer.js). workerData: { kind: "site" | "event", url, meter, deadlineMs }.
"use strict";
const { parentPort, workerData } = require("worker_threads");
const ai = require("./ai");
const importer = require("./importer");

parentPort.on("message", (m) => { if (m && m.type === "ai-taken") ai.answered(m); });
// A tick a second: the main thread stops this worker if they stop (its thread is stuck on something).
setInterval(() => parentPort.postMessage({ type: "tick" }), 1000);
// A few seconds before the main thread's deadline, every fetch stops, so what's been read so far can still come back.
const ac = new AbortController();
{ const d = workerData.deadlineMs || 150000; setTimeout(() => ac.abort(), d - Math.min(8000, d * 0.2)).unref(); }
(async () => {
  // Tests only: an address containing JF_TEST_IMPORT_HANG gets a thread stuck for good, to show the main thread stops it.
  if (process.env.JF_TEST_IMPORT_HANG && String(workerData.url).includes(process.env.JF_TEST_IMPORT_HANG)) for (;;);
  const fn = workerData.kind === "event" ? importer.importEvent : importer.importSite;
  try {
    const r = await fn(workerData.url, { meter: workerData.meter, signal: ac.signal, log: (text) => parentPort.postMessage({ type: "log", text: String(text) }) });
    parentPort.postMessage({ type: "done", result: r });
  } catch (e) {
    parentPort.postMessage({ type: "error", importError: e instanceof importer.ImportError, message: String((e && e.message) || e).slice(0, 300) });
  }
})();
