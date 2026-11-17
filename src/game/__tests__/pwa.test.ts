// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

function worker() {
  const events: Record<string, (e: unknown) => void> = {};
  const cached: string[] = [];
  vm.runInNewContext(readFileSync('public/sw.js', 'utf8'), {
    URL, fetch: async () => { throw new Error('offline'); },
    self: { location: { origin: 'https://mugi.example' }, clients: { claim: async () => {} }, addEventListener: (name: string, fn: (e: unknown) => void) => { events[name] = fn; } },
    caches: { open: async () => ({ addAll: async (paths: string[]) => cached.push(...paths) }), match: async (p: string) => p },
  });
  return { events, cached };
}
describe('PWA privacy boundary', () => {
  it('provides valid install icons and standalone metadata', () => {
    const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    for (const icon of manifest.icons) expect(existsSync('public' + icon.src)).toBe(true);
  });
  it('precaches only public offline assets', async () => {
    const { events, cached } = worker();
    let done: Promise<unknown> = Promise.resolve();
    events.install({ waitUntil: (p: Promise<unknown>) => { done = p; } }); await done;
    expect(cached).toEqual(['/offline.html', '/icon-192.png', '/icon-512.png']);
  });
  it('does not intercept API, OAuth, POST, cross-origin or normal static requests', () => {
    const { events } = worker();
    for (const [path, method, mode] of [['/api/chat?token=x','GET','navigate'], ['/api/settings','POST','cors'], ['/auth/callback?code=x','GET','navigate'], ['/assets/app.js','GET','cors'], ['https://other.example/','GET','navigate']]) {
      let intercepted = false;
      events.fetch({ request: { url: new URL(path, 'https://mugi.example').href, method, mode }, respondWith: () => { intercepted = true; } });
      expect(intercepted).toBe(false);
    }
  });
  it('shows a public offline notice when navigation fails', async () => {
    const { events } = worker();
    let reply: Promise<unknown> = Promise.resolve();
    events.fetch({ request: { url: 'https://mugi.example/', method: 'GET', mode: 'navigate' }, respondWith: (p: Promise<unknown>) => { reply = p; } });
    expect(await reply).toBe('/offline.html');
  });
});
