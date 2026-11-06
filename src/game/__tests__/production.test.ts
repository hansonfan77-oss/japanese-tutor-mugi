// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  server = createServer(productionApp(root, ['mugi.example.ts.net']));
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
describe('private production server (no external AI requests)', () => {
  it('serves built HTML and health; API is no-store', async () => {
    expect(await (await fetch(base)).text()).toContain('Mugi built');
    const r = await fetch(base + '/api/health');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({ ok: true, service: 'mugi', mode: 'production' });
    const usage = await fetch(base + '/api/usage');
    expect(usage.status).toBe(200);
    expect(usage.headers.get('cache-control')).toBe('no-store');
    expect(await usage.json()).toHaveProperty('months');
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
