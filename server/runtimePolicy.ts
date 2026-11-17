/** Immutable startup policy. No setting, request body, .env file or fallback can change it. */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync, lstatSync } from 'node:fs';
import { isAbsolute, relative, resolve, dirname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CHAT_ROLES } from '../src/game/claudeProtocol.ts';
import { defaultPersona } from './prompts.ts';
import { keysStatus } from './settingsRoutes.ts';

export type RunMode = 'acceptance' | 'normal';
export const ACCEPTANCE_MESSAGE = '驗收模式：外部 AI／雲端語音已停用';
export function readRunMode(value = process.env.MUGI_RUN_MODE): RunMode {
  if (value === undefined) return 'acceptance';
  if (value !== 'acceptance' && value !== 'normal') throw new Error('MUGI_RUN_MODE must be acceptance or normal; refusing to start');
  return value;
}
export function assertAcceptanceCheckout(root: string) {
  const forbidden = readdirSync(root).some(name =>
    (/^\.env(?:\.|$)/i.test(name) && name !== '.env.example') ||
    ['.usage', '.tts-cache', '.tts-keep', '.runtime', 'voicevox_engine', '.npmrc'].includes(name.toLowerCase()));
  if (forbidden) throw new Error('Acceptance requires a clean dedicated checkout without .env, usage, caches, runtime or engines. Clone the branch into a new directory; do not delete production data.');
}
function overlaps(a: string, b: string): boolean {
  const within = (x: string, y: string) => { const r = relative(x, y); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
  return within(a, b) || within(b, a);
}
/** Own only an empty dedicated directory, or a previously marked directory for this exact checkout. */
export function acceptanceRoot(checkout: string, target: string | undefined): string {
  if (!target || !isAbsolute(target)) throw new Error('Set an absolute MUGI_ACCEPTANCE_ROOT for isolated acceptance data');
  checkout = realpathSync(checkout);
  const path = resolve(target);
  if (overlaps(checkout, path)) throw new Error('Acceptance data must be outside the checkout');
  const normalAccount = process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA, 'MugiTutor');
  if (normalAccount && overlaps(normalAccount, path)) throw new Error('Acceptance data cannot overlap the normal account directory');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const actual = realpathSync(path);
  for (let cursor = path; ; cursor = dirname(cursor)) {
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('Acceptance root cannot use symlinks/junctions');
    if (dirname(cursor) === cursor) break;
  }
  if (overlaps(checkout, actual)) throw new Error('Acceptance data symlink overlaps checkout');
  const marker = resolve(actual, 'acceptance-root.json');
  if (!existsSync(marker)) {
    if (readdirSync(actual).length) throw new Error('Acceptance root must be empty or already marked for this checkout');
    writeFileSync(marker, JSON.stringify({ schema: 1, checkout }), { flag: 'wx', mode: 0o600 });
  }
  const record = JSON.parse(readFileSync(marker, 'utf8').replace(/^\uFEFF/, ''));
  const recordedCheckout = typeof record.checkout === 'string' ? realpathSync(record.checkout) : '';
  if (record.schema !== 1 || (process.platform === 'win32' ? recordedCheckout.toLowerCase() !== checkout.toLowerCase() : recordedCheckout !== checkout)) throw new Error('Acceptance root belongs to another checkout');
  for (const part of ['state', 'runtime']) {
    const dir = resolve(actual, part);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink()) throw new Error('Acceptance state/runtime cannot be symlinks');
  }
  const noLinks = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const child = resolve(dir, name);
      const info = lstatSync(child);
      if (info.isSymbolicLink()) throw new Error('Acceptance data cannot contain symlinks/junctions');
      if (info.isDirectory()) noLinks(child);
    }
  };
  noLinks(actual);
  return actual;
}
export type RuntimePolicy = Readonly<{ mode: RunMode; stateRoot: string; controlDir: string }>;
export function runtimePolicy(root: string, options: { mode?: RunMode; acceptanceRoot?: string } = {}): RuntimePolicy {
  const mode = readRunMode(options.mode);
  if (mode === 'normal') {
    if (existsSync(resolve(root, '.mugi-acceptance'))) throw new Error('Use a separate normal checkout; this checkout is marked for acceptance');
    return Object.freeze({ mode, stateRoot: root, controlDir: resolve(root, '.runtime') });
  }
  assertAcceptanceCheckout(root);
  const data = acceptanceRoot(root, options.acceptanceRoot ?? process.env.MUGI_ACCEPTANCE_ROOT);
  writeFileSync(resolve(root, '.mugi-acceptance'), 'acceptance\n', { mode: 0o600 });
  return Object.freeze({ mode, stateRoot: resolve(data, 'state'), controlDir: resolve(data, 'runtime') });
}
export function runtimeStatus(policy: RuntimePolicy) {
  return { mode: policy.mode, externalServices: policy.mode === 'normal', browserSpeech: policy.mode === 'normal', message: policy.mode === 'acceptance' ? ACCEPTANCE_MESSAGE : '一般模式' };
}
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
/** Acceptance registers no provider/engine handlers. Unknown future API operations are denied too. */
export function acceptanceApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const path = (req.url ?? '/').split('?')[0].replace(/\/+$/, '');
  if (req.method === 'GET') {
    const status: Record<string, unknown> = {
      '/api/chat/status': { ok: false, model: '', personas: Object.fromEntries(CHAT_ROLES.map(role => [role, defaultPersona(role)])) },
      '/api/openai/status': { signedIn: false, planEnabled: false, models: [] },
      '/api/tts/status': { azure: false, google: false, voicevox: false, voices: { azure: { zh: [], ja: [] }, google: { zh: [], ja: [] }, voicevox: { zh: [], ja: [] } } },
      '/api/voicevox/status': { running: false, starting: false },
      '/api/settings/keys': { status: keysStatus('') },
      '/api/settings/budget': { usd: 2, spentTodayUsd: 0 },
    };
    if (Object.hasOwn(status, path)) return json(res, 200, { ...(status[path] as object), acceptance: true });
    if (path === '/api/usage') return next();
  }
  if (path === '/api' || path.startsWith('/api/') || path === '/auth' || path.startsWith('/auth/')) {
    return json(res, 423, { error: 'acceptance_mode', message: ACCEPTANCE_MESSAGE + '；此功能留待一般模式另行驗收。' });
  }
  next();
}
