// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import * as credentials from '../../../server/openai/credentials.ts';
import * as oauth from '../../../server/openai/oauth.ts';
import * as engine from '../../../server/voicevoxProcess.ts';
import * as envFile from '../../../server/envFile.ts';
import { productionApp } from '../../../server/production.ts';
import { readRunMode, runtimePolicy } from '../../../server/runtimePolicy.ts';

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn(() => { throw new Error('No Anthropic client allowed'); }) }));
const fixture = mkdtempSync(join(tmpdir(), 'mugi-acceptance-'));
const checkout = join(fixture, 'checkout');
const data = join(fixture, 'isolated data');
const formal = join(fixture, 'formal');
let server: Server;
let base: string;
const sentinels = ['.env.local', 'credentials.json', 'usage.json', 'speech.wav'];
const forbidden = {
  oauth: vi.spyOn(oauth, 'createOAuth').mockImplementation(() => { throw new Error('OAuth must not initialize'); }),
  credentials: vi.spyOn(credentials, 'openCredentialStore').mockImplementation(() => { throw new Error('Credentials must not be read'); }),
  engine: vi.spyOn(engine, 'defaultVoicevoxDeps').mockImplementation(() => { throw new Error('Engine must not initialize'); }),
  env: vi.spyOn(envFile, 'readEnvFile').mockImplementation(() => { throw new Error('.env must not be read'); }),
  fetch: vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Supplier HTTP forbidden')),
};
function call(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      let value = ''; res.on('data', c => { value += c; });
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(value) }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
beforeAll(async () => {
  mkdirSync(join(checkout, 'dist'), { recursive: true });
  mkdirSync(formal); writeFileSync(join(checkout, 'dist/index.html'), 'public');
  for (const file of sentinels) writeFileSync(join(formal, file), `do-not-read-or-write-${file}`);
  vi.stubEnv('ANTHROPIC_API_KEY', 'mock-valid-looking-anthropic-key');
  vi.stubEnv('AZURE_SPEECH_KEY', 'mock-azure-key'); vi.stubEnv('GOOGLE_TTS_API_KEY', 'mock-google-key');
  vi.stubEnv('MUGI_DATA_DIR', formal); vi.stubEnv('VOICEVOX_DIR', formal);
  vi.stubEnv('MUGI_DAILY_USD', '0');
  server = createServer(productionApp(checkout, ['mugi.ts.net'], { mode: 'acceptance', acceptanceRoot: data }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(fixture, { recursive: true, force: true });
});
describe('server-enforced acceptance with poisoned keys/login paths and no supplier clients', () => {
  it('reports acceptance independently of keys and unlimited budget', async () => {
    const r = await call('/api/runtime');
    expect(r.body).toMatchObject({ mode: 'acceptance', externalServices: false, browserSpeech: false });
    expect((await call('/api/chat/status')).body.ok).toBe(false);
    expect((await call('/api/openai/status')).body.signedIn).toBe(false);
    expect((await call('/api/tts/status')).body).toMatchObject({ azure: false, google: false, voicevox: false });
  });
  it('blocks every operation, both fallback orders, auth callback and future image endpoints', async () => {
    for (const path of ['/api/chat', '/api/chat/judge', '/api/chat/fix-tip', '/api/lookup', '/api/tts', '/api/voicevox/start', '/api/openai/login', '/api/openai/logout', '/api/images/generate', '/api/settings/keys', '/api/settings/budget', '/api/runtime']) {
      for (const providers of [['anthropic', 'openai'], ['openai', 'anthropic']]) {
        const r = await call(path, 'POST', { providers, text: 'test', usd: 0, mode: 'normal', anthropicKey: 'replacement' });
        expect(r.status, path).toBe(423); expect(r.body.error).toBe('acceptance_mode');
        expect(r.body).not.toHaveProperty('ok', true);
      }
    }
    expect((await call('/auth/callback?code=fake&state=fake')).status).toBe(423);
    expect((await call('/api/runtime')).body.mode).toBe('acceptance');
  });
  it('does not change mode after process env or frontend writes change', async () => {
    vi.stubEnv('MUGI_RUN_MODE', 'normal');
    expect((await call('/api/runtime')).body.mode).toBe('acceptance');
    expect((await call('/api/chat', 'POST', {})).status).toBe(423);
  });
  it('preserves Host/Origin protections', async () => {
    expect((await call('/api/chat', 'POST', {}, { Host: 'evil.example' })).status).toBe(403);
    expect((await call('/api/chat', 'POST', {}, { Origin: 'https://evil.example' })).status).toBe(403);
  });
  it('uses only the marked isolated state and never initializes credentials, OAuth, HTTP or engines', async () => {
    expect((await call('/api/usage')).status).toBe(200);
    for (const file of sentinels) expect(readFileSync(join(formal, file), 'utf8')).toBe(`do-not-read-or-write-${file}`);
    expect(readdirSync(formal).sort()).toEqual([...sentinels].sort());
    expect(readdirSync(checkout).sort()).toEqual(['.mugi-acceptance', 'dist']);
    expect(readdirSync(data).sort()).toEqual(['acceptance-root.json', 'runtime', 'state']);
    for (const spy of Object.values(forbidden)) expect(spy).not.toHaveBeenCalled();
    expect(Anthropic).not.toHaveBeenCalled();
  });
  it('fails closed on missing/invalid mode, data root, dirty checkout or mismatched ownership', () => {
    vi.stubEnv('MUGI_RUN_MODE', undefined);
    expect(readRunMode()).toBe('acceptance');
    expect(() => readRunMode('typo')).toThrow(); expect(() => readRunMode('')).toThrow();
    expect(() => runtimePolicy(checkout, { mode: 'normal' })).toThrow('marked for acceptance');
    expect(() => runtimePolicy(checkout, { mode: 'acceptance', acceptanceRoot: formal })).toThrow('empty');
    const dirty = join(fixture, 'dirty'); mkdirSync(dirty); writeFileSync(join(dirty, '.env.local'), 'formal-secret');
    expect(() => runtimePolicy(dirty, { mode: 'acceptance', acceptanceRoot: join(fixture, 'unused') })).toThrow('dedicated checkout');
    expect(readFileSync(join(dirty, '.env.local'), 'utf8')).toBe('formal-secret');
  });
});
