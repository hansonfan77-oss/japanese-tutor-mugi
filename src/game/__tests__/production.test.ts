// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { productionApp } from '../../../server/production.ts';

let server: Server;
let base: string;
const root = mkdtempSync(join(tmpdir(), 'mugi-production-'));
const savedDataDir = process.env.MUGI_DATA_DIR;
beforeAll(async () => {
  process.env.MUGI_DATA_DIR = join(root, 'account');
  mkdirSync(join(root, 'dist/assets'), { recursive: true });
  writeFileSync(join(root, 'dist/index.html'), '<!doctype html><title>Mugi built</title>');
  writeFileSync(join(root, 'dist/assets/app.js'), 'console.log("built")');
  writeFileSync(join(root, '.env.local'), 'SECRET=must-not-leak');
  writeFileSync(join(root, 'dist/credentials.json'), 'secret-credentials');
  writeFileSync(join(root, 'dist/assets/backup.key'), 'secret-key');
  writeFileSync(join(root, 'dist/assets/source.js.map'), 'private-source-map');
  mkdirSync(join(root, 'dist/audio'), { recursive: true });
  writeFileSync(join(root, 'dist/audio/example.mp3'), 'public-audio');
  // Directory junction needs no symlink privilege on Windows; realpath must still reject escape.
  symlinkSync(root, join(root, 'dist/escape'), process.platform === 'win32' ? 'junction' : 'dir');
  server = createServer(productionApp(root, ['mugi.example.ts.net'], { mode: 'normal' }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('No server');
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
  if (savedDataDir === undefined) delete process.env.MUGI_DATA_DIR; else process.env.MUGI_DATA_DIR = savedDataDir;
});
function requestHost(path: string, host: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = request(base + path, { headers: { Host: host } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
}
// node:http preserves the exact Fetch Metadata under test (fetch may overwrite Sec-Fetch-Mode).
function navigationRequest(path: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<{ status: number | undefined; body: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
    const req = request(base + path, { method, headers: {
      Host: 'mugi.example.ts.net', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document',
      ...headers,
    } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject); req.end();
  });
}
describe('private production server (no external AI requests)', () => {
  it('serves built HTML and health; API is no-store', async () => {
    expect(await (await fetch(base)).text()).toContain('Mugi built');
    const r = await fetch(base + '/api/health');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({ ok: true, service: 'mugi', mode: 'production', runMode: 'normal' });
    const usage = await fetch(base + '/api/usage');
    expect(usage.status).toBe(200);
    expect(usage.headers.get('cache-control')).toBe('no-store');
    expect(await usage.json()).toHaveProperty('months');
  });
  it.each(['/', '/index.html', '/?from=launcher'])('allows public home document navigation at %s', async path => {
    for (const site of ['cross-site', 'same-site', 'same-origin', 'none']) {
      const r = await navigationRequest(path, { 'Sec-Fetch-Site': site });
      expect(r.status).toBe(200);
      expect(r.body).toContain('Mugi built');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it.each(['/', '/index.html', '/?vp=1'])('allows a service-worker-forwarded home navigation at %s', async path => {
    for (const site of ['cross-site', 'same-site']) {
      const r = await navigationRequest(path, { 'Sec-Fetch-Site': site, 'Sec-Fetch-Dest': 'empty' });
      expect(r.status).toBe(200);
      expect(r.body).toContain('Mugi built');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('does not treat the worker destination as API, file, Host or write authorization', async () => {
    const worker = { 'Sec-Fetch-Dest': 'empty' };
    for (const path of ['/api/health', '/api/runtime', '/api/usage', '/api/settings/keys', '/api/openai/status',
      '/auth/callback?code=fake', '/assets/app.js', '/.env.local', '/credentials.json']) {
      expect((await navigationRequest(path, worker)).status).toBe(403);
    }
    for (const host of ['evil.example', 'evil.mugi.example.ts.net', 'mugi.example.ts.net:0']) {
      expect((await navigationRequest('/', { ...worker, Host: host })).status).toBe(403);
    }
    for (const method of ['HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
      expect((await navigationRequest('/', { ...worker, 'Content-Type': 'application/json' }, method)).status).toBe(403);
    }
  });

  it('allows an external Origin only on the public top-level home navigation', async () => {
    expect((await navigationRequest('/', { Origin: 'https://other.example' })).status).toBe(200);
    expect((await navigationRequest('/api/health', { 'Sec-Fetch-Site': 'same-origin', Origin: 'https://other.example' })).status).toBe(403);
  });

  it('keeps cross-site fetches, frames, forms and unknown metadata outside the home exception', async () => {
    for (const headers of [
      { 'Sec-Fetch-Mode': 'cors' }, { 'Sec-Fetch-Mode': 'no-cors' }, { 'Sec-Fetch-Mode': '' },
      { 'Sec-Fetch-Dest': 'iframe' }, { 'Sec-Fetch-Dest': 'frame' }, { 'Sec-Fetch-Dest': '' },
      { 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors' },
      { 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'same-origin' },
      { 'Sec-Fetch-Site': 'unexpected' },
    ]) {
      expect((await navigationRequest('/', headers)).status).toBe(403);
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
      expect((await navigationRequest('/', { 'Content-Type': 'application/json' }, method)).status).toBe(403);
    }
  });

  it('still checks the exact Host on a cross-site home navigation', async () => {
    for (const host of ['evil.example', 'evil.mugi.example.ts.net', 'mugi.example.ts.net.evil.example', 'mugi.example.ts.net:0']) {
      expect((await navigationRequest('/', { Host: host })).status).toBe(403);
    }
  });

  it('does not extend the navigation exception to APIs, OAuth, assets or private files', async () => {
    for (const path of ['/api/health', '/api/runtime', '/api/usage', '/api/settings/keys', '/api/openai/status',
      '/auth/callback?code=fake', '/assets/app.js', '/.env.local', '/credentials.json', '/assets/source.js.map', '/api/unknown']) {
      const r = await navigationRequest(path);
      expect(r.status).toBe(403);
      expect(r.body).not.toMatch(/must-not-leak|secret-credentials|private-source-map/);
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    }
    for (const path of ['/api/chat', '/api/settings/keys', '/api/openai/login', '/api/openai/logout']) {
      const r = await navigationRequest(path, { 'Content-Type': 'application/json' }, 'POST');
      expect(r.status).toBe(403);
      expect(r.body).toContain('不接受其他網站發出的請求');
    }
  });

  it('serves immutable assets and supports HEAD', async () => {
    const r = await fetch(base + '/assets/app.js', { method: 'HEAD' });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toContain('immutable');
    expect(await r.text()).toBe('');
  });
  it('rejects unknown hosts and cross-site API requests', async () => {
    expect(await requestHost('/api/health', 'evil.example')).toBe(403);
    expect((await fetch(base + '/api/health', { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect(await requestHost('/api/health', 'mugi.example.ts.net')).toBe(200);
  });
  it('never exposes source, secrets, unknown APIs or auth to remote hosts', async () => {
    for (const path of ['/.env.local', '/src/main.tsx', '/api/unknown', '/%2eenv.local', '/assets/%5c..%5c.env.local', '/credentials.json', '/assets/backup.key', '/assets/source.js.map', '/assets/app.js:secret', '/escape/.env.local']) {
      const r = await fetch(base + path);
      expect(r.status).toBe(404);
      expect(await r.text()).not.toContain('must-not-leak');
    }
    expect(await requestHost('/auth/callback?code=fake', 'evil.example')).toBe(403);
  });
  it('rejects broad production host rules', () => {
    for (const host of ['.ts.net', '*', 'mugi.ts.net:443', 'https://mugi.ts.net']) {
      expect(() => productionApp(root, [host])).toThrow('exact DNS');
    }
  });
  it('retains built public audio and protects phone key writes and OAuth', async () => {
    expect(await (await fetch(base + '/audio/example.mp3')).text()).toBe('public-audio');
    for (const path of ['/api/settings/keys', '/api/openai/login', '/api/openai/logout']) {
      const r = await fetch(base + path, { method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-Forwarded-For': '100.64.0.1',
      }, body: '{}' });
      expect(r.status).toBe(403);
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
    expect(readFileSync(join(root, '.env.local'), 'utf8')).toBe('SECRET=must-not-leak');
  });
  it('keeps settings scoped to the provided checkout without exposing the full key', async () => {
    writeFileSync(join(root, '.env.local'), 'ANTHROPIC_API_KEY=mock-test-key-unique');
    const r = await fetch(base + '/api/settings/keys');
    const body = await r.text();
    expect(r.status).toBe(200);
    expect(body).toContain('ique');
    expect(body).not.toContain('mock-test-key-unique');
    writeFileSync(join(root, '.env.local'), 'SECRET=must-not-leak');
  });

});

// These route tests do not test Windows DPAPI. Auth/credential suites cover it with their own fixtures.
vi.mock('../../../server/openai/credentials.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../server/openai/credentials.ts')>();
  return { ...actual, defaultProtector: () => null,
    openCredentialStore: () => ({ data: { v: 1, hostId: 'route-test-only', account: null }, save() {} }),
  };
});
