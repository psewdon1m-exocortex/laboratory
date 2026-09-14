import { parentPort, workerData } from "node:worker_threads";
import { parseBackup } from "./backup.js";

try {
  const result = parseBackup(workerData);
  const transfers = [];
  for (const [name, bytes] of Object.entries(result.files)) {
    transfers.push(bytes.buffer);
  }
  parentPort.postMessage({ result }, [...new Set(transfers)]);
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
