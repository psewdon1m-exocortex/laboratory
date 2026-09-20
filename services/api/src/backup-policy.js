import { randomUUID } from "node:crypto";

const fail = message => Object.assign(new Error(message), { status: 409 });
const integer = (value, maximum) => Number.isInteger(value) && value >= 1 && value <= maximum;
export function validateBackupIntent(value) {
  if (value == null) return null;
  if (value.schema !== "exocortex.backup.intent.v1" || typeof value.archive?.enabled !== "boolean"
    || !integer(value.archive.intervalHours, 8760)
    || value.mirror !== null && (typeof value.mirror?.enabled !== "boolean" || !integer(value.mirror.intervalMinutes, 10080)))
    throw fail("The backup contains an invalid automatic-backup policy");
  // Recovery carries intent and non-secret provenance, never credentials/URLs.
  return { schema: "exocortex.backup.intent.v1",
    archive: { enabled: value.archive.enabled, intervalHours: value.archive.intervalHours },
    mirror: value.mirror === null ? null : { enabled: value.mirror.enabled, intervalMinutes: value.mirror.intervalMinutes },
    sourceRevision: Number.isSafeInteger(value.sourceRevision) ? value.sourceRevision : null };
}
export function restoredPolicyRecord(value) {
  const intent = validateBackupIntent(value);
  return intent ? { intent, requestId: randomUUID(), expectedRevision: null, resume: null } : null;
}

export function createBackupPolicy({ client, configured, readPending, writePending }) {
  let reconciling = false;
  return {
    pending: () => readPending(),
    assertExportReady() {
      if (readPending()) throw fail("Restored backup policy awaits verification; automatic export is paused");
    },
    async exportIntent() {
      const pending = readPending();
      if (pending) return validateBackupIntent(pending.intent);
      if (!configured()) return null;
      const policy = await client.policy();
      if (policy.schema !== "exocortex.backup.policy.v1") throw fail("Backup policy cannot be verified; upgrade Neptune and Saturn");
      return validateBackupIntent({ schema: "exocortex.backup.intent.v1", archive: policy.archive, mirror: policy.mirror, sourceRevision: policy.revision });
    },
    async read() {
      const pending = readPending();
      let current;
      try { current = await client.policy(); }
      catch (error) {
        if (!pending) throw error;
        current = { schema: "exocortex.backup.policy.v1", revision: 0, appliedRevision: 0, observed: {} };
      }
      return pending ? { ...current, ...validateBackupIntent(pending.intent), schema: "exocortex.backup.policy.v1",
        paused: true, restoredPending: true, revision: current.revision, appliedRevision: current.appliedRevision } : current;
    },
    async mutate(input) {
      const pending = structuredClone(readPending());
      if (!pending) return client.policy("PUT", input);
      if (input?.kind !== "resume" || !/^[0-9a-f-]{36}$/i.test(input.requestId || "")
        || Object.keys(input).some(key => !["kind", "requestId", "expectedRevision"].includes(key)))
        throw fail("Review and verify the restored backup policy before changing its schedule");
      if (reconciling) throw fail("Restored backup policy verification is already active");
      reconciling = true;
      const persist = value => {
        if (readPending()?.requestId !== pending.requestId)
          throw fail("Another restore replaced this policy; review the newly restored settings");
        writePending(value);
      };
      try {
        const current = await client.policy();
        if (pending.expectedRevision === null) {
          pending.expectedRevision = current.revision;
          persist(pending);
        }
        let restored;
        try {
          restored = await client.policy("PUT", { kind: "restore", expectedRevision: pending.expectedRevision,
            requestId: pending.requestId, archive: pending.intent.archive, mirror: pending.intent.mirror });
        } catch (error) {
          if (error.status === 409) {
            // Preserve the proposed intent. A subsequent explicit review gets
            // a new CAS attempt; no automatic stale write is retried.
            persist({ ...pending, expectedRevision: null, requestId: randomUUID(), resume: null });
          }
          throw error;
        }
        pending.resume ??= { kind: "resume", expectedRevision: restored.revision, requestId: input.requestId };
        persist(pending);
        const verified = await client.policy("PUT", pending.resume);
        if (verified.paused || verified.appliedRevision !== verified.revision) throw fail("The restored policy is not yet verified and applied");
        persist(null);
        return verified;
      } finally { reconciling = false; }
    },
    async runs(method = "GET", body) {
      if (method !== "GET") this.assertExportReady();
      return client.policy(method, body, "/runs");
    },
  };
}
