// Run after npm run build. Executes the actual bundle with isolated data; never calls AI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
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
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let diagnostic = '';
  child.stderr.on('data', value => { diagnostic = (diagnostic + value).slice(-6000); });
  child.once('exit', code => {
    if (code !== 0 && extra.MUGI_RUN_MODE === 'acceptance') console.error('::error title=Acceptance bundle startup::' + diagnostic.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A'));
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

// All connections stay on this runner's loopback; the Host/Fetch Metadata simulate a private HTTPS proxy.
async function homeNavigationBoundary(base) {
  const send = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = request(base + path, { headers: {
      Host: 'mugi.example.ts.net', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document',
      'X-Forwarded-For': '192.0.2.1', 'X-Forwarded-Proto': 'https', ...headers,
    } }, res => {
      let body = '';
      res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject); req.end();
  });
  for (const site of ['cross-site', 'same-site']) {
    const home = await send('/', { 'Sec-Fetch-Site': site });
    assert.equal(home.status, 200);
    assert.match(home.headers['content-type'], /text\/html/);
    assert.equal(home.headers['cache-control'], 'no-store');
    assert.equal(home.headers['access-control-allow-origin'], undefined);
  }
  for (const path of ['/api/health', '/api/runtime', '/api/settings/keys', '/api/openai/status']) {
    const api = await send(path);
    assert.equal(api.status, 403, path);
    assert.equal(JSON.parse(api.body).message, '不接受其他網站發出的請求');
  }
  assert.equal((await send('/', { Host: 'wrong.example' })).status, 403);
  assert.equal((await send('/', { 'Sec-Fetch-Dest': 'iframe' })).status, 403);
  for (const path of ['/.env.local', '/credentials.json', '/src/main.tsx']) {
    assert.equal((await send(path)).status, 403, path);
    assert.equal((await send(path, { 'Sec-Fetch-Site': 'same-origin' })).status, 404, path);
  }
}

test('built production bundle serves PWA/API, hides source, and drains on owned stop request', async () => {
  const root = await fixture();
  const owner = randomUUID().replaceAll('-', '');
  const listenPort = await port();
  const { child, exited } = launch(root, listenPort, owner, { MUGI_ALLOWED_HOSTS: 'mugi.example.ts.net' });
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
    await homeNavigationBoundary(base);
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
  const fakeLogin = JSON.stringify({ v: 1, hostId: 'acceptance-sentinel', account: {
    client_id: 'fake-client', subject: 'fake-user', email: 'fake@example.invalid', name: 'Fake',
    access_token: 'fake-access', refresh_token: 'fake-refresh', id_token: 'fake-id', scopes: ['openid'], expiresAt: 0,
  } });
  await writeFile(join(formal, 'credentials.json'), fakeLogin);
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
    MUGI_RUN_MODE: 'acceptance', MUGI_ACCEPTANCE_ROOT: data, MUGI_ALLOWED_HOSTS: 'mugi.example.ts.net',
    MUGI_DATA_DIR: formal, VOICEVOX_DIR: formal, MUGI_DAILY_USD: '0',
    ANTHROPIC_API_KEY: 'fake-anthropic', GOOGLE_TTS_API_KEY: 'fake-google', AZURE_SPEECH_KEY: 'fake-azure',
    NODE_OPTIONS: `--require=${JSON.stringify(guardPath)}`,
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
    await homeNavigationBoundary(base);
    const runtime = await (await fetch(base + '/api/runtime')).json();
    assert.equal(runtime.mode, 'acceptance');
    assert.equal(runtime.externalServices, false);
    assert.equal(runtime.browserSpeech, false);
    for (const path of ['/api/chat','/api/chat/judge','/api/chat/fix-tip','/api/lookup','/api/tts','/api/voicevox/start','/api/openai/login','/api/images/generate','/api/settings/budget','/api/runtime']) {
      const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'normal', usd: 0, providers: ['openai','anthropic'] }) });
      assert.equal(r.status, 423, path); assert.equal((await r.json()).error, 'acceptance_mode');
    }
    for (const path of ['/api/chat/status', '/api/openai/status', '/api/tts/status', '/api/usage']) assert.equal((await fetch(base + path)).status, 200);
    await assert.rejects(() => import('node:fs/promises').then(fs => fs.stat(violation)), { code: 'ENOENT' });
    await writeFile(join(data, `runtime/node-stop-${owner}.request`), '');
    assert.equal(await boundedExit(exited), 0);
    assert.equal(await (await import('node:fs/promises')).readFile(join(formal, 'credentials.json'), 'utf8'), fakeLogin);
  } finally {
    if (child.exitCode === null) child.kill(); await boundedExit(exited);
    for (const dir of [root, data, formal]) await rm(dir, { recursive: true, force: true });
  }
});
