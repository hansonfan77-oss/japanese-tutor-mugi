// Run after npm run build. Executes the actual bundle with isolated data; never calls AI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, cp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const bundle = resolve('dist-server/production.js');
async function port() {
  const socket = createServer();
  await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const value = socket.address().port;
  await new Promise(r => socket.close(r));
  return value;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mugi-built-'));
  await cp(resolve('dist'), join(root, 'dist'), { recursive: true });
  await mkdir(join(root, '.runtime'));
  return root;
}
function launch(root, listenPort, owner) {
  const child = spawn(process.execPath, [bundle, `--mugi-owner=${owner}`], {
    cwd: root,
    env: { ...process.env, MUGI_DATA_DIR: join(root, 'account'), MUGI_PORT: String(listenPort), MUGI_ALLOWED_HOSTS: '' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const exited = new Promise((resolve, reject) => { child.once('exit', code => resolve(code)); child.once('error', reject); });
  return { child, exited };
}
async function boundedExit(exited) {
  const timeout = new AbortController();
  try {
    return await Promise.race([exited, delay(20_000, null, { signal: timeout.signal }).then(() => { throw new Error('Bundle did not exit'); })]);
  } finally { timeout.abort(); }
}

test('built production bundle serves PWA/API, hides source, and drains on owned stop request', async () => {
  const root = await fixture();
  const owner = randomUUID().replaceAll('-', '');
  const listenPort = await port();
  const { child, exited } = launch(root, listenPort, owner);
  try {
    const base = `http://127.0.0.1:${listenPort}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error('Bundle exited before readiness');
      try { ready = (await fetch(base + '/api/health')).ok; } catch { /* bounded startup */ }
      if (ready) break;
      await delay(100);
    }
    assert.equal(ready, true);
    for (const path of ['/', '/sw.js', '/manifest.webmanifest', '/offline.html', '/api/chat/status', '/api/openai/status', '/api/tts/status', '/api/usage']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get('cache-control'), 'no-store', path);
      if (path === '/manifest.webmanifest') assert.equal((await res.json()).display, 'standalone');
    }
    for (const path of ['/.env.local', '/src/main.tsx', '/credentials.json', '/.runtime/server.json']) {
      assert.equal((await fetch(base + path)).status, 404, path);
    }
    // Wrong owner cannot stop the server.
    await writeFile(join(root, '.runtime/node-stop-00000000000000000000000000000000.request'), '');
    await delay(1100);
    assert.equal((await fetch(base + '/api/health')).status, 200);
    await writeFile(join(root, `.runtime/node-stop-${owner}.request`), '');
    assert.equal(await boundedExit(exited), 0);
  } finally {
    if (child.exitCode === null) child.kill();
    await boundedExit(exited);
    await rm(root, { recursive: true, force: true });
  }
});

test('port collision exits the owned bundle without terminating the port holder', async () => {
  const root = await fixture();
  const holder = createServer();
  await new Promise(r => holder.listen(0, '127.0.0.1', r));
  const { child, exited } = launch(root, holder.address().port, randomUUID().replaceAll('-', ''));
  try {
    assert.equal(await boundedExit(exited), 1);
    assert.equal(holder.listening, true);
  } finally {
    if (child.exitCode === null) child.kill();
    await boundedExit(exited);
    await new Promise(r => holder.close(r));
    await rm(root, { recursive: true, force: true });
  }
});
