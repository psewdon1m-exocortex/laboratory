// A single SQLite-backed instance admits one memory-heavy operation at a time.
// Authentication must run before this wrapper. The lease covers body ingestion,
// processing and response buffering, including a client disconnect during work.
export function createOperationBudget() {
  let active = false;
  return (handler, upload) => async (req, res, next) => {
    if (active) return res.status(409).set("Retry-After", "5").json({ error: "An archive or upload operation is already running. Retry after it finishes." });
    active = true;
    try {
      if (upload) await new Promise((resolve, reject) => {
        const aborted = () => reject(Object.assign(new Error("Upload interrupted"), { status: 400 }));
        req.once("aborted", aborted);
        upload(req, res, error => {
          req.off("aborted", aborted);
          if (error) reject(error); else resolve();
        });
      });
      if (!req.aborted) await handler(req, res, next);
      if (res.writableEnded && !res.writableFinished && !res.destroyed) {
        await new Promise(resolve => {
          res.once("finish", resolve);
          res.once("close", resolve);
        });
      }
    } catch (error) {
      if (!req.aborted && !res.destroyed) next(error);
    } finally {
      // A disconnected caller cannot release a still-running worker's lease.
      active = false;
    }
  };
}
