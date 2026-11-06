/** Private host: built static frontend + the same guarded APIs used in development. */
import { createServer } from 'node:http';
import { existsSync, unlinkSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, extname, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import connect from 'connect';
import { mountApplicationApis } from './appRuntime.ts';
import { runtimePolicy, type RunMode } from './runtimePolicy.ts';
import { guardApi, type GuardOptions } from './apiGuard.ts';

const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.ico': 'image/x-icon', '.json': 'application/json' };
// Serve only supported public resources, even if a secret/backup is accidentally copied into dist.
// Colon and trailing dot/space rejection also closes Windows ADS and filename normalization aliases.
function publicPath(path: string): boolean {
  if (path.split('/').some(p => p.startsWith('.') || /[\\:\x00-\x1f]/.test(p) || /[. ]$/.test(p))) return false;
  if (['/', '/index.html', '/offline.html', '/sw.js', '/manifest.webmanifest', '/favicon.ico'].includes(path)) return true;
  if (/^\/(?:favicon-32|apple-touch-icon|icon-192|icon-512|icon-maskable-512)\.png$/.test(path)) return true;
  if (/^\/assets\/[a-zA-Z0-9_/-]+\.(?:js|css|woff2?)$/.test(path)) return true;
  if (/^\/(?:characters|backgrounds)\/[a-zA-Z0-9_/-]+\.(?:png|webp|jpe?g)$/.test(path)) return true;
  if (/^\/characters\/[a-zA-Z0-9_-]+\/tutor\.json$/.test(path)) return true;
  return /^\/audio\/[a-zA-Z0-9_/-]+\.(?:mp3|wav|ogg)$/.test(path);
}

export function productionApp(root: string, allowedHosts: string[] = [], options: { mode?: RunMode; acceptanceRoot?: string } = {}) {
  if (allowedHosts.some(h => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(h))) {
    throw new Error('Production allowed hosts must be exact DNS names, without wildcards, suffix rules or ports');
  }
  const policy = runtimePolicy(root, options);
  const app = connect();
  const guard: GuardOptions = { allowedHosts, lan: false };
  // Also applies to SSE, OAuth callbacks, errors and health responses.
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    // Host/cross-site guard applies to the static frontend too; keep OAuth POST semantics in its handler.
    if (req.url?.split('?')[0] === '/auth/callback') return next();
    return guardApi((_req, _res) => next(), guard)(req, res);
  });
  mountApplicationApis(app, root, 'production', guard, policy);
  app.use((req, res, next) => {
    void (async () => {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
      let pathname: string;
      try { pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname); }
      catch { res.writeHead(400); res.end(); return; }
      // Exact files only: never return the app shell for unknown APIs or private/dot paths.
      if (!publicPath(pathname)) { res.writeHead(404); res.end(); return; }
      const dist = await realpath(resolve(root, 'dist'));
      let file: string;
      try { file = await realpath(resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname))); }
      catch { res.writeHead(404); res.end(); return; }
      const rel = relative(dist, file);
      if (isAbsolute(rel) || rel.startsWith('..' + sep) || rel === '..' || !publicPath('/' + rel.split(sep).join('/')) || !(await stat(file)).isFile()) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
      if (rel.startsWith('assets' + sep)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      const data = await readFile(file);
      res.setHeader('Content-Length', data.length);
      res.end(req.method === 'HEAD' ? undefined : data);
    })().catch(next);
  });
  app.use((_err: unknown, _req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, _next: connect.NextFunction) => {
    // Do not log requests, headers, exception bodies or credentials.
    if (!res.headersSent) res.writeHead(500);
    if (!res.writableEnded) res.end('Internal server error');
  });
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  await stat(resolve(root, 'dist/index.html'));
  const policy = runtimePolicy(root);
  const port = Number(process.env.MUGI_PORT ?? (policy.mode === 'acceptance' ? 3006 : 3004));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MUGI_PORT');
  const allowed = (process.env.MUGI_ALLOWED_HOSTS ?? '').split(',').map(h => h.trim()).filter(Boolean);
  const server = createServer(productionApp(root, allowed));
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  server.listen(port, '127.0.0.1', () => console.log(`[mugi] production ready on loopback port ${port}`));
  let stopping = false;
  let stopTimer: ReturnType<typeof setInterval> | undefined;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(stopTimer);
    // exit hooks in UsageStore flush accounting; in-flight requests get up to ten seconds.
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  const ownerArg = process.argv.find(arg => arg.startsWith('--mugi-owner='));
  if (ownerArg) {
    const owner = ownerArg.slice('--mugi-owner='.length);
    if (!/^[a-f0-9]{32}$/.test(owner)) throw new Error('Invalid supervisor owner');
    const stopFile = resolve(policy.controlDir, `node-stop-${owner}.request`);
    stopTimer = setInterval(() => {
      if (existsSync(stopFile)) {
        try { unlinkSync(stopFile); } catch { /* a concurrent stop request is harmless */ }
        shutdown();
      }
    }, 1000);
    stopTimer.unref();
  }
  server.on('error', () => {
    console.error('[mugi] startup/server error');
    // Do not leave a supervisor-owned process polling forever after EADDRINUSE.
    process.exit(1);
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, shutdown);
}
