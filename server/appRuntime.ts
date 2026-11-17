import type { Server } from 'connect';
import type { Plugin } from 'vite';
import { mountChat } from './claudeChat.ts';
import { mountTts } from './tts.ts';
import { mountUsage } from './usage.ts';
import { guardApi, guardOptionsFrom, type GuardOptions } from './apiGuard.ts';
import { acceptanceApi, runtimePolicy, runtimeStatus, type RuntimePolicy } from './runtimePolicy.ts';

/** The same acceptance boundary is used by the development and built servers. */
export function mountApplicationApis(app: Server, root: string, mode: string, guard: GuardOptions, policy: RuntimePolicy) {
  app.use((req, res, next) => {
    const path = (req.url ?? '/').split('?')[0];
    if (!(path === '/api' || path.startsWith('/api/') || path === '/auth' || path.startsWith('/auth/'))) return next();
    const handle = () => {
      if (req.method === 'GET' && (path === '/api/runtime' || path === '/api/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(path === '/api/runtime' ? runtimeStatus(policy) : { ok: true, service: 'mugi', mode, runMode: policy.mode }));
        return;
      }
      if (policy.mode === 'acceptance') return acceptanceApi(req, res, next);
      next();
    };
    // OAuth's external top-level callback has its own local-only + PKCE/state guard in normal mode.
    if (policy.mode === 'normal' && path === '/auth/callback') return handle();
    return guardApi(handle, guard)(req, res);
  });
  if (policy.mode === 'normal') {
    mountChat(app, root, mode, guard);
    mountTts(app, root, mode, guard);
  }
  mountUsage(app, policy.stateRoot, guard);
}
export function appRuntimePlugin(): Plugin {
  let root = process.cwd();
  let mode = 'development';
  return {
    name: 'mugi-runtime', apply: 'serve',
    configResolved(config) { root = config.root; mode = config.mode; },
    configureServer(server) {
      mountApplicationApis(server.middlewares, root, mode, guardOptionsFrom(server), runtimePolicy(root));
    },
  };
}
