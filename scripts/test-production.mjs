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
function launch(root, listenPort, owner, extra = {}) {
  const child = spawn(process.execPath, [bundle, `--mugi-owner=${owner}`], {
    cwd: root,
    env: { ...process.env, MUGI_DATA_DIR: join(root, 'account'), MUGI_PORT: String(listenPort), MUGI_ALLOWED_HOSTS: '', MUGI_RUN_MODE: 'normal', ...extra },
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
    for (let i = 0; i < 450; i++) {
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


test('acceptance bundle ignores poisoned credentials and forbids HTTP/engine/credential access', async () => {
  const root = await fixture();
  await rm(join(root, '.runtime'), { recursive: true });
  const data = await mkdtemp(join(tmpdir(), 'mugi-accept data-'));
  const formal = await mkdtemp(join(tmpdir(), 'mugi-formal-sentinel-'));
  const owner = randomUUID().replaceAll('-', '');
  const listenPort = await port();
  await writeFile(join(formal, 'credentials.json'), '{"fake":"never-read"}');
  const guardPath = join(root, 'deny-network.cjs');
  const violation = join(root, 'violation.txt');
  await writeFile(guardPath, `
    const fs = require('node:fs');
    const mark = (label) => { fs.appendFileSync(${JSON.stringify(violation)}, label); throw new Error('Forbidden acceptance IO'); };
    globalThis.fetch = () => mark('fetch');
    for (const name of ['node:http', 'node:https']) {
      const module = require(name); module.request = module.get = () => mark(name);
    }
    const cp = require('node:child_process'); cp.spawn = cp.exec = cp.execFile = () => mark('engine');
    for (const name of ['readFileSync', 'writeFileSync']) {
      const original = fs[name]; fs[name] = function(path, ...args) {
        if (String(path).startsWith(${JSON.stringify(formal)})) return mark('formal-data');
        return original.call(fs, path, ...args);
      };
    }
    require('node:module').syncBuiltinESMExports();
  `);
  const { child, exited } = launch(root, listenPort, owner, {
    MUGI_RUN_MODE: 'acceptance', MUGI_ACCEPTANCE_ROOT: data,
    MUGI_DATA_DIR: formal, VOICEVOX_DIR: formal, MUGI_DAILY_USD: '0',
    ANTHROPIC_API_KEY: 'fake-anthropic', GOOGLE_TTS_API_KEY: 'fake-google', AZURE_SPEECH_KEY: 'fake-azure',
    NODE_OPTIONS: `--require="${guardPath}"`,
  });
  try {
    const base = `http://127.0.0.1:${listenPort}`;
    let ready = false;
    for (let i = 0; i < 450; i++) {
      if (child.exitCode !== null) throw new Error('Acceptance bundle exited');
      try { ready = (await fetch(base + '/api/health')).ok; } catch { }
      if (ready) break; await delay(100);
    }
    assert.equal(ready, true);
    assert.equal((await (await fetch(base + '/api/runtime')).json()).mode, 'acceptance');
    for (const path of ['/api/chat','/api/chat/judge','/api/chat/fix-tip','/api/lookup','/api/tts','/api/voicevox/start','/api/openai/login','/api/images/generate','/api/settings/budget','/api/runtime']) {
      const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'normal', usd: 0, providers: ['openai','anthropic'] }) });
      assert.equal(r.status, 423, path); assert.equal((await r.json()).error, 'acceptance_mode');
    }
    for (const path of ['/api/chat/status', '/api/openai/status', '/api/tts/status', '/api/usage']) assert.equal((await fetch(base + path)).status, 200);
    await assert.rejects(() => import('node:fs/promises').then(fs => fs.stat(violation)), { code: 'ENOENT' });
    await writeFile(join(data, `runtime/node-stop-${owner}.request`), '');
    assert.equal(await boundedExit(exited), 0);
    assert.equal(await (await import('node:fs/promises')).readFile(join(formal, 'credentials.json'), 'utf8'), '{"fake":"never-read"}');
  } finally {
    if (child.exitCode === null) child.kill(); await boundedExit(exited);
    for (const dir of [root, data, formal]) await rm(dir, { recursive: true, force: true });
  }
});
