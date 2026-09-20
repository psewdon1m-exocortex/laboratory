// Own-client recovery intent only: no endpoint, token, credential or shared grants.
export const INTENT_KEY = "wyvernBindingIntent";
export const INTENT_SCHEMA = "exocortex.wyvern.binding-intent.v1";
const id = value => typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
export const emptyIntent = () => ({ schema: INTENT_SCHEMA, state: "unconfigured", instance_id: null, client_id: null, revision: null, bindings: {} });
export function validateIntent(value) {
  if (!value || Object.keys(value).sort().join(",") !== "bindings,client_id,instance_id,revision,schema,state" || value.schema !== INTENT_SCHEMA
    || !["unconfigured", "observed", "pending_verification"].includes(value.state) || !value.bindings || typeof value.bindings !== "object"
    || Array.isArray(value.bindings) || Object.keys(value.bindings).length > 64) throw Error("Invalid Wyvern recovery intent");
  for (const [name, binding] of Object.entries(value.bindings)) {
    if (!id(name) || !binding || Object.keys(binding).sort().join(",") !== "adapter_id,profile" || !id(binding.adapter_id) || !id(binding.profile)) throw Error("Invalid Wyvern function binding");
  }
  if (value.state === "unconfigured") {
    if (Object.keys(value.bindings).length || value.instance_id !== null || value.client_id !== null || value.revision !== null) throw Error("Invalid unconfigured Wyvern intent");
  } else if (!id(value.instance_id) || !id(value.client_id) || !Number.isSafeInteger(value.revision) || value.revision < 1) throw Error("Invalid Wyvern intent provenance");
  return structuredClone(value);
}
export function readIntent(db) {
  const row = db?.prepare("SELECT value FROM settings WHERE key=?").get(INTENT_KEY);
  return row ? validateIntent(JSON.parse(row.value)) : null;
}
export function saveIntent(db, intent) {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(INTENT_KEY, JSON.stringify(validateIntent(intent)));
}
export const intentFromStatus = status => validateIntent({ schema: INTENT_SCHEMA, state: "observed", instance_id: status.instance_id,
  client_id: status.client_id, revision: status.binding_revision, bindings: status.bindings });
export const intentMatches = (intent, status) => intent.instance_id === status.instance_id && intent.client_id === status.client_id
  && Object.keys(intent.bindings).length === Object.keys(status.bindings ?? {}).length
  && Object.entries(intent.bindings).every(([name, binding]) => binding.adapter_id === status.bindings?.[name]?.adapter_id && binding.profile === status.bindings?.[name]?.profile);
