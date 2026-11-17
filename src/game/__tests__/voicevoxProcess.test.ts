import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createVoicevoxProcess, engineExeName, voicevoxExe, voicevoxRoute, VoicevoxError, VOICEVOX_ARGS, type VoicevoxProcessDeps } from '../../../server/voicevoxProcess.ts';
import { sameOriginRequest } from '../../../server/tts.ts';

const DIR = resolve('voicevox_engine');
const EXE = join(DIR, engineExeName());

/** a fake machine: the engine on the port (or none), its process path and memory, and the calls made to it */
function machine(opts: { up?: boolean; pid?: number | null; path?: string | null; exists?: boolean; spawnFails?: boolean; upAfterSpawn?: number } = {}) {
  let up = opts.up ?? false;
  let portPid: number | null = opts.pid === undefined ? (up ? 4242 : null) : opts.pid;
  let spawned = 0;
  let pollsAfterSpawn = 0;
  const killed: number[] = [];
  const spawns: { exe: string; args: readonly string[]; cwd: string }[] = [];
  const logs: string[] = [];
  const fetchCalls: string[] = [];
  // the background wait sleeps through this gate: the test releases it step by step
  const gate: (() => void)[] = [];
  let holding = false;
  const release = async () => { while (gate.length) gate.shift()!(); await new Promise((r) => setTimeout(r, 0)); };
  const deps: VoicevoxProcessDeps = {
    dir: () => DIR,
    root: 'C:\\no-such-project',
    subfolders: () => [],
    base: () => 'http://127.0.0.1:50021',
    fetch: (async (input: string | URL | Request) => {
      const u = String(input);
      fetchCalls.push(u);
      if (u.endsWith('/version')) {
        const isUp = up || (opts.upAfterSpawn !== undefined && spawned > 0 && ++pollsAfterSpawn > opts.upAfterSpawn);
        if (!isUp) throw new TypeError('fetch failed');
        return new Response(JSON.stringify('0.25.2'), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('x', { status: 404 });
    }) as unknown as typeof fetch,
    spawn: (exe, args, cwd) => {
      spawns.push({ exe, args, cwd });
      spawned++;
      const ee = { err: null as ((e: Error) => void) | null };
      if (opts.spawnFails) queueMicrotask(() => ee.err?.(new Error('EACCES')));
      if (opts.upAfterSpawn === undefined && !opts.spawnFails) { up = true; portPid = 4242; }
      if (opts.spawnFails) { /* stays down */ }
      return { on: (_ev, fn) => { ee.err = fn; return undefined; }, unref: () => undefined };
    },
    exists: () => opts.exists ?? true,
    portOwner: async () => (portPid === null ? null : { pid: portPid, path: opts.path === undefined ? EXE : opts.path, workingSetMB: 1229 }),
    kill: (pid) => { killed.push(pid); up = false; portPid = null; },
    now: () => 0,
    sleep: () => (holding ? new Promise<void>((r) => gate.push(r)) : Promise.resolve()),
    log: (m) => logs.push(m),
    sameOrigin: sameOriginRequest,
  };
  return { deps, killed, spawns, logs, fetchCalls, release, hold: (v: boolean) => { holding = v; }, get spawned() { return spawned; } };
}

describe('VOICEVOX status', () => {
  it('reports running, its version, PID and memory when the engine answers', async () => {
    const m = machine({ up: true });
    const ctl = createVoicevoxProcess(m.deps);
    expect(await ctl.status()).toEqual({ running: true, starting: false, version: '0.25.2', pid: 4242, memoryMB: 1229 });
  });

  it('reports off with no PID when nothing answers', async () => {
    const ctl = createVoicevoxProcess(machine().deps);
    expect(await ctl.status()).toEqual({ running: false, starting: false });
  });
});

describe('VOICEVOX start', () => {
  it('is a no-op when the engine already answers (nothing is spawned)', async () => {
    const m = machine({ up: true });
    const s = await createVoicevoxProcess(m.deps).start();
    expect(s.running).toBe(true);
    expect(m.spawns).toHaveLength(0);
  });

  it('spawns the fixed run.exe with the fixed arguments, detached in the engine folder', async () => {
    const m = machine();
    const s = await createVoicevoxProcess(m.deps).start();
    expect(s).toEqual({ running: false, starting: true });
    expect(m.spawns).toEqual([{ exe: EXE, args: VOICEVOX_ARGS, cwd: DIR }]);
    expect([...VOICEVOX_ARGS]).toEqual(['--host', '127.0.0.1', '--port', '50021']);
  });

  it('refuses when run.exe is missing, and when another program holds the port', async () => {
    await expect(createVoicevoxProcess(machine({ exists: false }).deps).start()).rejects.toMatchObject({ status: 404, code: 'not_found' });
    const busy = machine({ pid: 99 });
    await expect(createVoicevoxProcess(busy.deps).start()).rejects.toMatchObject({ status: 409, code: 'port_busy' });
    expect(busy.spawns).toHaveLength(0);
  });

  it('reports starting while it waits, and stops reporting it once the engine answers', async () => {
    const m = machine({ upAfterSpawn: 2 });
    m.hold(true);
    const ctl = createVoicevoxProcess(m.deps);
    await ctl.start();
    expect(await ctl.status()).toMatchObject({ running: false, starting: true });
    for (let i = 0; i < 10 && (await ctl.status()).starting; i++) await m.release();
    expect(await ctl.status()).toMatchObject({ running: true, starting: false });
  });

  it('a failed spawn does not leave it starting forever', async () => {
    const m = machine({ spawnFails: true });
    const ctl = createVoicevoxProcess(m.deps);
    await ctl.start();
    await new Promise((r) => setTimeout(r, 5));
    expect((await ctl.status()).starting).toBe(false);
    expect(m.logs.some((l) => l.includes('start failed'))).toBe(true);
  });
});

describe('VOICEVOX stop: only the verified run.exe, by PID', () => {
  it('kills the PID on the port when its executable is the run.exe under VOICEVOX_DIR', async () => {
    const m = machine({ up: true });
    const s = await createVoicevoxProcess(m.deps).stop();
    expect(m.killed).toEqual([4242]);
    expect(s).toEqual({ running: false, starting: false });
  });

  it('refuses a foreign process on the port and kills nothing', async () => {
    const m = machine({ up: true, path: 'C:\\Windows\\System32\\other.exe' });
    const err = await createVoicevoxProcess(m.deps).stop().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VoicevoxError);
    expect((err as VoicevoxError).status).toBe(409);
    expect((err as VoicevoxError).code).toBe('foreign_process');
    expect(m.killed).toEqual([]);
  });

  it('refuses a run.exe from another folder (the path must match VOICEVOX_DIR exactly)', async () => {
    const m = machine({ up: true, path: 'C:\\other\\run.exe' });
    await expect(createVoicevoxProcess(m.deps).stop()).rejects.toMatchObject({ code: 'foreign_process' });
    expect(m.killed).toEqual([]);
  });

  it('refuses when the path of the PID cannot be read', async () => {
    const m = machine({ up: true, path: null });
    await expect(createVoicevoxProcess(m.deps).stop()).rejects.toMatchObject({ code: 'foreign_process' });
    expect(m.killed).toEqual([]);
  });

  it('is a no-op when the engine is not running', async () => {
    const m = machine();
    expect(await createVoicevoxProcess(m.deps).stop()).toEqual({ running: false, starting: false });
    expect(m.killed).toEqual([]);
  });

  it('never kills by image name: the only kill is process.kill(pid), injected here and asserted by PID', async () => {
    const m = machine({ up: true });
    const kill = vi.spyOn(m.deps, 'kill');
    await createVoicevoxProcess(m.deps).stop();
    expect(kill).toHaveBeenCalledWith(4242);
  });
});

describe('VOICEVOX route: same-origin guard and shapes', () => {
  function call(method: string, url: string, headers: Record<string, string>, ctl: ReturnType<typeof createVoicevoxProcess>) {
    const handler = voicevoxRoute(ctl, { sameOrigin: sameOriginRequest });
    const req = { method, url, headers, socket: { remoteAddress: '127.0.0.1' } } as never;
    const out: { code?: number; body?: unknown } = {};
    const res = {
      headersSent: false,
      writeHead(code: number) { out.code = code; return this; },
      end(b: string) { out.body = JSON.parse(b); },
    } as never;
    return handler(req, res).then(() => out);
  }

  it('answers the same origin and refuses a cross-site request with 403', async () => {
    const ctl = createVoicevoxProcess(machine({ up: true }).deps);
    const ok = await call('GET', '/status', { host: 'localhost:3004', origin: 'http://localhost:3004' }, ctl);
    expect(ok.code).toBe(200);
    expect(ok.body).toMatchObject({ running: true, pid: 4242, memoryMB: 1229 });
    const cross = await call('POST', '/stop', { host: 'localhost:3004', origin: 'https://evil.example' }, ctl);
    expect(cross.code).toBe(403);
    const fetchSite = await call('POST', '/start', { host: 'localhost:3004', 'sec-fetch-site': 'cross-site' }, ctl);
    expect(fetchSite.code).toBe(403);
  });

  it('maps a refusal to its status and code, and an unknown route to 404', async () => {
    const m = machine({ up: true, path: 'C:\\x\\other.exe' });
    const ctl = createVoicevoxProcess(m.deps);
    const r = await call('POST', '/stop', { host: 'localhost:3004', origin: 'http://localhost:3004' }, ctl);
    expect(r.code).toBe(409);
    expect(r.body).toMatchObject({ error: 'foreign_process' });
    const nf = await call('POST', '/kill-everything', { host: 'localhost:3004' }, ctl);
    expect(nf.code).toBe(404);
  });
});

/** the engine folder rules, on real temp folders (created inside each test, removed after it) */
describe('VOICEVOX engine folder: VOICEVOX_DIR, else <project>/voicevox_engine (one sub-folder deep)', () => {
  const NAME = engineExeName();
  const NOT_FOUND = '找不到 VOICEVOX 引擎：請把引擎放在專案資料夾的 voicevox_engine/（或執行 scripts/get-voicevox），或設定環境變數 VOICEVOX_DIR，再重新啟動開發伺服器';
  const made: string[] = [];

  afterEach(() => {
    // only the folders this file made
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** a fresh project root (a temp folder) */
  function tempRoot(): string {
    const d = mkdtempSync(join(tmpdir(), 'mugi-vv-'));
    made.push(d);
    return d;
  }

  /** an engine executable (an empty file) at folder/run.exe, the folder is created */
  function engineIn(folder: string): string {
    mkdirSync(folder, { recursive: true });
    const exe = join(folder, NAME);
    writeFileSync(exe, '');
    return exe;
  }

  /** the machine with the real file checks and the real sub-folder listing (the engine is never started for real) */
  function onDisk(root: string, dir = '') {
    const m = machine();
    const ctl = createVoicevoxProcess({
      ...m.deps,
      dir: () => dir,
      root,
      exists: existsSync,
      subfolders: (f: string) => {
        try {
          return readdirSync(f, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
        } catch {
          return [];
        }
      },
    });
    return { m, ctl };
  }

  it('uses VOICEVOX_DIR when it is set, even when the default folder also has an engine', async () => {
    const root = tempRoot();
    engineIn(join(root, 'voicevox_engine'));
    const envDir = tempRoot();
    const exe = engineIn(envDir);
    const { m, ctl } = onDisk(root, envDir);
    await ctl.start();
    expect(m.spawns).toHaveLength(1);
    expect(m.spawns[0].exe).toBe(exe);
  });

  it('refuses when VOICEVOX_DIR is set but has no engine, and does not fall back to the default folder', async () => {
    const root = tempRoot();
    engineIn(join(root, 'voicevox_engine'));
    const envDir = tempRoot();
    const { m, ctl } = onDisk(root, envDir);
    await expect(ctl.start()).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(m.spawns).toHaveLength(0);
  });

  it('uses the engine directly in <project>/voicevox_engine when VOICEVOX_DIR is unset', async () => {
    const root = tempRoot();
    const exe = engineIn(join(root, 'voicevox_engine'));
    const { m, ctl } = onDisk(root);
    await ctl.start();
    expect(m.spawns).toHaveLength(1);
    expect(m.spawns[0].exe).toBe(exe);
    expect(m.spawns[0].exe).toBe(voicevoxExe(join(root, 'voicevox_engine')));
  });

  it('uses the engine in one sub-folder of <project>/voicevox_engine', async () => {
    const root = tempRoot();
    const exe = engineIn(join(root, 'voicevox_engine', 'voicevox_engine-cpu-x64'));
    const { m, ctl } = onDisk(root);
    await ctl.start();
    expect(m.spawns).toHaveLength(1);
    expect(m.spawns[0].exe).toBe(exe);
  });

  it('prefers the shallower match: the engine directly in the folder over one in a sub-folder', async () => {
    const root = tempRoot();
    const top = engineIn(join(root, 'voicevox_engine'));
    engineIn(join(root, 'voicevox_engine', 'sub'));
    const { m, ctl } = onDisk(root);
    await ctl.start();
    expect(m.spawns[0].exe).toBe(top);
  });

  it('does not look two sub-folders deep', async () => {
    const root = tempRoot();
    engineIn(join(root, 'voicevox_engine', 'a', 'b'));
    const { m, ctl } = onDisk(root);
    await expect(ctl.start()).rejects.toMatchObject({ status: 404, code: 'no_engine' });
    expect(m.spawns).toHaveLength(0);
  });

  it('refuses with the Chinese message when nothing is found, and spawns nothing', async () => {
    const root = tempRoot();
    mkdirSync(join(root, 'voicevox_engine'));
    const { m, ctl } = onDisk(root);
    const err = await ctl.start().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VoicevoxError);
    expect((err as VoicevoxError).message).toBe(NOT_FOUND);
    expect(m.spawns).toHaveLength(0);
  });

  it('refuses when the default folder does not exist at all', async () => {
    const root = tempRoot();
    const { m, ctl } = onDisk(root);
    await expect(ctl.start()).rejects.toThrow(NOT_FOUND);
    expect(m.spawns).toHaveLength(0);
  });
});
