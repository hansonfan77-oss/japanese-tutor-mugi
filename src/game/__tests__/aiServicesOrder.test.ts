// Which services a request gets (claudeChat.servicesFor): the player's order, Claude needs its key, ChatGPT needs the signed-in
// plan and a model (the one named when listed, only an absent choice uses the first listed). No network: the Claude key is only read, never called,
// and the ChatGPT service is a fake. The folder is a temporary one, so no .env.local is read.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { servicesFor } from '../../../server/claudeChat.ts';
import type { ChatGptService } from '../../../server/openai/service.ts';
import type { LlmProvider } from '../../../server/llm/provider.ts';

let dir: string;
const savedKey = process.env.ANTHROPIC_API_KEY;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mugi-tutor-order-'));
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  rmSync(dir, { recursive: true, force: true });
});

const provider = { id: 'openai', streamChat: () => { throw new Error('not called'); }, complete: async () => { throw new Error('not called'); }, describeError: () => ({ status: 500, message: '' }) } as unknown as LlmProvider;

/** a ChatGPT service that is signed in with these models (or not ready, or failing to list them) */
function chatgptWith(opts: { ready?: boolean; models?: { slug: string; label: string }[]; fail?: boolean } = {}): ChatGptService {
  return {
    ready: () => opts.ready ?? true,
    status: async () => ({ signedIn: true, planEnabled: true, models: [] }),
    models: async () => {
      if (opts.fail) throw new Error('模型清單失敗');
      return opts.models ?? [{ slug: 'gpt-5.5-sol', label: 'GPT 5.5 Sol' }, { slug: 'gpt-5.4', label: 'GPT 5.4' }];
    },
    provider: () => provider,
    beginLogin: async () => '',
    finishLogin: async () => {},
    logout: async () => ({ ok: true as const }),
  };
}

const ask = (providers: ('anthropic' | 'openai')[], chatgpt: ChatGptService | null, openaiModel?: string) =>
  servicesFor({ providers, ...(openaiModel ? { openaiModel } : {}) }, { root: dir, mode: 'development', chatgpt });

describe('servicesFor', () => {
  it('keeps the player’s order when both are ready', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-used';
    const r = await ask(['openai', 'anthropic'], chatgptWith());
    expect(r.services.map((s) => s.id)).toEqual(['openai', 'anthropic']);
    expect(r.services[0].spend).toBe(false);
    expect(r.services[1].spend).toBe(true);
  });

  it('Claude without its key is passed over, and ChatGPT answers', async () => {
    const r = await ask(['anthropic', 'openai'], chatgptWith());
    expect(r.services.map((s) => s.id)).toEqual(['openai']);
    expect(r.dailyCapped).toBe(false);
  });

  it('nothing ready gives no services (the caller answers 503)', async () => {
    const r = await ask(['anthropic'], chatgptWith());
    expect(r).toEqual({ services: [], dailyCapped: false });
    const none = await ask(['openai'], chatgptWith({ ready: false }));
    expect(none.services).toEqual([]);
    expect(await ask(['openai'], null)).toEqual({ services: [], dailyCapped: false });
  });

  it('a ChatGPT model list that fails leaves ChatGPT out', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-used';
    const r = await ask(['openai', 'anthropic'], chatgptWith({ fail: true }));
    expect(r.services.map((s) => s.id)).toEqual(['anthropic']);
  });

  it('the ChatGPT model is the one named when the plan lists it, only an absent choice uses the first listed one', async () => {
    expect((await ask(['openai'], chatgptWith(), 'gpt-5.4')).services[0].model).toBe('gpt-5.4');
    expect((await ask(['openai'], chatgptWith(), 'gpt-9-gone')).services).toEqual([]);
    expect((await ask(['openai'], chatgptWith())).services[0].model).toBe('gpt-5.5-sol');
  });

  it('a Claude model passed in is the one the Claude service uses', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-used';
    const r = await servicesFor({ providers: ['anthropic'] }, { root: dir, mode: 'development', claudeModel: 'claude-opus-5-5', chatgpt: null });
    expect(r.services[0].model).toBe('claude-opus-5-5');
  });
});
