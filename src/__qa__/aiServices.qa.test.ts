// QA: which services a request gets (server/claudeChat.ts servicesFor), the daily cap, the chat slots, and the fallback rule
// (server/aiChain.ts). Temp folders and fake services only; no network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fallbackWorthy } from '../../server/aiChain';
import {
  servicesFor, dailyCapReached, takeChatSlot, releaseChatSlot, parseDailyUsd, CHAT_MAX_ACTIVE, type ChatSlots,
} from '../../server/claudeChat';
import { getUsageStore } from '../../server/usage';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'mugi-qa-svc-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const notReady = { ready: () => false, models: async () => [], provider: () => ({} as never) } as never;

describe('services of a request', () => {
  it('no key and no ChatGPT sign-in: no services (the caller answers 503)', async () => {
    const plan = await servicesFor({ providers: ['anthropic', 'openai'] }, { root, mode: 'test', chatgpt: notReady });
    expect(plan).toEqual({ services: [], dailyCapped: false });
  });

  it('a Claude key in .env.local gives the Claude service with the player model', async () => {
    fs.writeFileSync(path.join(root, '.env.local'), 'ANTHROPIC_API_KEY=sk-ant-QAFAKE-abcd1234\n');
    const plan = await servicesFor({ providers: ['anthropic'] }, { root, mode: 'test', claudeModel: 'claude-opus-5-5', chatgpt: null });
    expect(plan.services.map((s) => [s.id, s.model, s.spend])).toEqual([['anthropic', 'claude-opus-5-5', true]]);
  });

  it('the order of the routing is the order of the services', async () => {
    fs.writeFileSync(path.join(root, '.env.local'), 'ANTHROPIC_API_KEY=sk-ant-QAFAKE-abcd1234\n');
    const fakeGpt = { ready: () => true, models: async () => [{ slug: 'gpt-a' }], provider: () => ({} as never) } as never;
    const plan = await servicesFor({ providers: ['openai', 'anthropic'] }, { root, mode: 'test', chatgpt: fakeGpt });
    expect(plan.services.map((s) => s.id)).toEqual(['openai', 'anthropic']);
  });

  it('an empty ChatGPT model list gives no ChatGPT service', async () => {
    const fakeGpt = { ready: () => true, models: async () => [], provider: () => ({} as never) } as never;
    const plan = await servicesFor({ providers: ['openai'] }, { root, mode: 'test', chatgpt: fakeGpt });
    expect(plan.services).toEqual([]);
  });

  it('a saved ChatGPT model missing from the catalog is not silently replaced', async () => {
    const fakeGpt = { ready: () => true, models: async () => [{ slug: 'gpt-a' }, { slug: 'gpt-b' }], provider: () => ({} as never) } as never;
    const plan = await servicesFor({ providers: ['openai'], openaiModel: 'gpt-zzz' }, { root, mode: 'test', chatgpt: fakeGpt });
    expect(plan.services).toEqual([]);
  });

  it('a ChatGPT model list that throws is skipped (the other service still answers)', async () => {
    fs.writeFileSync(path.join(root, '.env.local'), 'ANTHROPIC_API_KEY=sk-ant-QAFAKE-abcd1234\n');
    const bad = { ready: () => true, models: async () => { throw new Error('down'); }, provider: () => ({} as never) } as never;
    const plan = await servicesFor({ providers: ['openai', 'anthropic'] }, { root, mode: 'test', chatgpt: bad });
    expect(plan.services.map((s) => s.id)).toEqual(['anthropic']);
  });
});

describe('daily cap (MUGI_DAILY_USD)', () => {
  it('spending at the cap refuses the Claude service and reports dailyCapped (429 path)', async () => {
    fs.writeFileSync(path.join(root, '.env.local'), 'ANTHROPIC_API_KEY=sk-ant-QAFAKE-abcd1234\nMUGI_DAILY_USD=0.01\n');
    // a large Haiku call: well over one cent
    getUsageStore(root).recordClaude('claude-haiku-5-5', { input_tokens: 2_000_000, output_tokens: 2_000_000 });
    expect(dailyCapReached(root, 'test')).toBe(true);
    const plan = await servicesFor({ providers: ['anthropic'] }, { root, mode: 'test', chatgpt: null });
    expect(plan).toEqual({ services: [], dailyCapped: true });
  });

  it('with a ChatGPT service ready the capped Claude service is simply skipped', async () => {
    fs.writeFileSync(path.join(root, '.env.local'), 'ANTHROPIC_API_KEY=sk-ant-QAFAKE-abcd1234\nMUGI_DAILY_USD=0.01\n');
    getUsageStore(root).recordClaude('claude-haiku-5-5', { input_tokens: 2_000_000, output_tokens: 2_000_000 });
    const fakeGpt = { ready: () => true, models: async () => [{ slug: 'gpt-a' }], provider: () => ({} as never) } as never;
    const plan = await servicesFor({ providers: ['anthropic', 'openai'] }, { root, mode: 'test', chatgpt: fakeGpt });
    expect(plan.services.map((s) => s.id)).toEqual(['openai']);
    expect(plan.dailyCapped).toBe(true);
  });

  it('MUGI_DAILY_USD=0 means no cap', () => {
    fs.writeFileSync(path.join(root, '.env.local'), 'MUGI_DAILY_USD=0\n');
    getUsageStore(root).recordClaude('claude-haiku-5-5', { input_tokens: 2_000_000, output_tokens: 2_000_000 });
    expect(dailyCapReached(root, 'test')).toBe(false);
  });

  it('a garbage MUGI_DAILY_USD falls back to the default cap ($2)', () => {
    expect(parseDailyUsd('abc')).toBe(2);
    expect(parseDailyUsd('-3')).toBe(2);
    expect(parseDailyUsd('')).toBe(2);
  });
});

describe('chat slots (per minute and at once)', () => {
  it('the third chat at once is busy; a released slot is free again', () => {
    const slots: ChatSlots = { times: [], active: 0 };
    expect(takeChatSlot(0, 0, slots)).toBe('ok');
    expect(takeChatSlot(0, 0, slots)).toBe('ok');
    expect(takeChatSlot(0, 0, slots)).toBe('busy');
    releaseChatSlot(slots);
    expect(takeChatSlot(0, 0, slots)).toBe('ok');
    expect(CHAT_MAX_ACTIVE).toBe(2);
  });

  it('the per-minute limit refuses the start after the limit, and frees after a minute', () => {
    const slots: ChatSlots = { times: [], active: 0 };
    for (let i = 0; i < 3; i++) { expect(takeChatSlot(3, i, slots)).toBe('ok'); releaseChatSlot(slots); }
    expect(takeChatSlot(3, 10, slots)).toBe('rate');
    expect(takeChatSlot(3, 60_001, slots)).toBe('ok');
  });

  it('a refused (rate or busy) take does not count as running', () => {
    const slots: ChatSlots = { times: [], active: 0 };
    takeChatSlot(1, 0, slots);
    releaseChatSlot(slots);
    expect(takeChatSlot(1, 1, slots)).toBe('rate');
    expect(slots.active).toBe(0);
  });
});

describe('fallback rule (fallbackWorthy)', () => {
  const withStatus = (status: number, message = '') => Object.assign(new Error(message), { status });
  it('400, 401, 403, 404, 429 and 5xx move on; 413 and 422 do not', () => {
    for (const s of [400, 401, 403, 404, 429, 500, 503]) expect(fallbackWorthy(withStatus(s))).toBe(true);
    for (const s of [413, 422]) expect(fallbackWorthy(withStatus(s))).toBe(false);
  });
  it('a plain error with no status does not move on', () => {
    expect(fallbackWorthy(new Error('bad reply shape'))).toBe(false);
  });
  it('an abort never moves on', () => {
    expect(fallbackWorthy(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(false);
  });
});
