/** Private host: built static frontend + the same guarded APIs used in development. */
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, extname, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import connect from 'connect';
import { mountChat } from './claudeChat.ts';
import { mountTts } from './tts.ts';
import { mountUsage } from './usage.ts';
import { guardApi, type GuardOptions } from './apiGuard.ts';

const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.ico': 'image/x-icon', '.json': 'application/json' };
export function productionApp(root: string, allowedHosts: string[] = []) {
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
  app.use('/api/health', (req, res) => {
    if (req.url !== '/' || req.method !== 'GET') { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, service: 'mugi', mode: 'production' }));
  });
  mountChat(app, root, 'production', guard);
  mountTts(app, root, 'production', guard);
  mountUsage(app, root, guard);
  app.use((req, res, next) => {
    void (async () => {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
      let pathname: string;
      try { pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname); }
      catch { res.writeHead(400); res.end(); return; }
      // Exact files only: never return the app shell for unknown APIs or private/dot paths.
      if (pathname.split('/').some(p => p.startsWith('.') || p.includes('\\')) || pathname.includes('\0')) { res.writeHead(404); res.end(); return; }
      const dist = await realpath(resolve(root, 'dist'));
      let file: string;
      try { file = await realpath(resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname))); }
      catch { res.writeHead(404); res.end(); return; }
      const rel = relative(dist, file);
      if (isAbsolute(rel) || rel.startsWith('..' + sep) || rel === '..' || !(await stat(file)).isFile()) { res.writeHead(404); res.end(); return; }
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
  const port = Number(process.env.MUGI_PORT ?? 3004);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MUGI_PORT');
  const allowed = (process.env.MUGI_ALLOWED_HOSTS ?? '').split(',').map(h => h.trim()).filter(Boolean);
  const server = createServer(productionApp(root, allowed));
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  server.listen(port, '127.0.0.1', () => console.log(`[mugi] production ready on loopback port ${port}`));
  server.on('error', () => { console.error('[mugi] startup/server error'); process.exitCode = 1; });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
