import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLaboratoryApp } from '../src/server.js';

test('restore inspection is authenticated, read-only and binds restoration to the verified ZIP', async context => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'laboratory-inspection-'));
  const app = await createLaboratoryApp({ port: 0, dataDir, accessKey: 'inspection-test-access-key',
    sessionSecret: 'inspection-test-session-secret-at-least-thirty-two', kernelUrl: '', kernelServiceToken: '', cookieSecure: false, derivedContentEnabled: false });
  const runtime = app.locals.laboratory;
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  context.after(async () => {
    await new Promise(resolve => server.close(resolve));
    runtime.register.stop(); runtime.githubLibrary.stop(); runtime.derivedContent.stop(); runtime.searchNotifications.stop();
    await runtime.audit.queue; runtime.store.close(); await fs.rm(dataDir, { recursive: true, force: true });
  });
  const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ access_key: 'inspection-test-access-key' }) });
  assert.equal(login.status, 200);
  const session = await login.json(), cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const headers = { Cookie: cookie, 'X-CSRF-Token': session.csrfToken };
  const archive = Buffer.from(await (await fetch(base + '/api/admin/backup', { headers })).arrayBuffer());
  const upload = (bytes = archive) => { const form = new FormData(); form.append('file', new Blob([bytes]), 'snapshot.zip'); return form; };
  const epoch = runtime.store.restoreEpoch;
  assert.equal((await fetch(base + '/api/admin/restore/inspect', { method: 'POST', body: upload() })).status, 401);
  assert.equal((await fetch(base + '/api/admin/restore/inspect', { method: 'POST', headers: { Cookie: cookie }, body: upload() })).status, 403);
  const inspection = await fetch(base + '/api/admin/restore/inspect', { method: 'POST', headers, body: upload() });
  assert.equal(inspection.status, 200);
  assert.match(inspection.headers.get('cache-control'), /no-store/);
  const info = await inspection.json();
  assert.equal(info.sha256, crypto.createHash('sha256').update(archive).digest('hex'));
  assert.equal(info.sizeBytes, archive.length);
  assert.equal(info.component, 'laboratory');
  assert.equal(runtime.store.restoreEpoch, epoch);
  assert.ok(!('snapshot' in info) && !('files' in info));
  const bad = await fetch(base + '/api/admin/restore/inspect', { method: 'POST', headers, body: upload(Buffer.from('invalid ZIP')) });
  assert.ok(bad.status >= 400);
  const mismatch = await fetch(base + '/api/admin/restore', { method: 'POST', headers: { ...headers, 'X-Backup-SHA256': '0'.repeat(64) }, body: upload() });
  assert.equal(mismatch.status, 400);
  assert.equal(runtime.store.restoreEpoch, epoch);
  const restored = await fetch(base + '/api/admin/restore', { method: 'POST', headers: { ...headers, 'X-Backup-SHA256': info.sha256 }, body: upload() });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).reauthenticate, true);
  assert.equal((await fetch(base + '/api/admin/state', { headers })).status, 401);
});
