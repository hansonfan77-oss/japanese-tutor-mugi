// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    for (const path of ['/.env.local', '/src/main.tsx', '/api/unknown', '/%2eenv.local', '/assets/%5c..%5c.env.local']) {
      const r = await fetch(base + path);
      expect(r.status).toBe(404);
      expect(await r.text()).not.toContain('must-not-leak');
    }
    expect(await requestHost('/auth/callback?code=fake', 'evil.example')).toBe(403);
  });
});
