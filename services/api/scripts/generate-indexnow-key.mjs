import crypto from "node:crypto";

// IndexNow accepts a hexadecimal ownership key. Keep the generated value in
// production configuration; the application exposes only the required proof
// file at /<key>.txt when the key is configured.
process.stdout.write(`${crypto.randomBytes(32).toString("hex")}\n`);
