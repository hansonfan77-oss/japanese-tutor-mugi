// The service order and the fallback (server/aiChain.ts, claudeChat.streamReply), with fake services and no network: the body
// fields, which errors move on, the one-shot run, and the chat stream (a fallback only before any text reached the player).
import { describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { fallbackWorthy, firstServing, parseRouting, RoutingError, routingOf, type Service } from '../../../server/aiChain.ts';
import { parseChatBody, streamReply, type ReplyIo } from '../../../server/claudeChat.ts';
import { OpenAIError, openaiProvider } from '../../../server/llm/openaiProvider.ts';
import type { LlmProvider } from '../../../server/llm/provider.ts';
import type { ProviderId } from '../../game/claudeProtocol.ts';

/** a fake service: its deltas go out, then it fails with `error` (or completes); streamChat is a spy */
function fake(id: ProviderId, behaviour: { deltas?: string[]; error?: unknown; spend?: boolean } = {}): Service & { stream: ReturnType<typeof vi.fn> } {
  const deltas = behaviour.deltas ?? [];
  const stream = vi.fn((_req: unknown, onDelta: (t: string) => void) => {
    const done = (async () => {
      for (const d of deltas) onDelta(d);
      if (behaviour.error) throw behaviour.error;
      return { text: deltas.join(''), model: `${id}-served`, stopReason: 'end_turn' };
    })();
    return { abort: () => {}, done, usageSoFar: () => undefined };
  });
  const provider: LlmProvider = {
    id,
    streamChat: stream as unknown as LlmProvider['streamChat'],
    complete: async () => { throw new Error('not used here'); },
    describeError: (e) => ({ status: 500, message: `failed: ${(e as Error).message}` }),
  };
  return { id, model: `${id}-model`, provider, spend: behaviour.spend ?? id === 'anthropic', stream };
}

const limited = () => Object.assign(new Error('too many'), { status: 429 });
const refused = () => Object.assign(new Error('bad input'), { status: 422 });
const body = parseChatBody(JSON.stringify({
  messages: [{ role: 'user', content: '嗨' }], role: 'Mugi', mode: 'teacher', context: {},
}));

/** the reply's io: what was sent, and the calls the caller made */
function fakeIo(gone = false) {
  const events: Record<string, unknown>[] = [];
  const io: ReplyIo = {
    send: vi.fn((ev: Record<string, unknown>) => { events.push(ev); }),
    gone: () => gone,
    track: vi.fn(),
    spendEnded: vi.fn(),
    spendDone: vi.fn(),
    finish: vi.fn(async (svc: Service) => { events.push({ type: 'done', provider: svc.id }); }),
    failed: vi.fn(),
  };
  return { io, events };
}

describe('routing fields of a body', () => {
  it('no list is Claude alone; a list keeps its order; the ChatGPT model is trimmed', () => {
    expect(parseRouting({})).toEqual({ providers: ['anthropic'] });
    expect(parseRouting({ providers: null })).toEqual({ providers: ['anthropic'] });
    expect(parseRouting({ providers: ['openai', 'anthropic'], openaiModel: ' gpt-5.4 ' })).toEqual({ providers: ['openai', 'anthropic'], openaiModel: 'gpt-5.4' });
    expect(parseRouting({ providers: ['openai'], openaiModel: '' })).toEqual({ providers: ['openai'] });
  });

  it('a list that is not 1 to 2 known ids, none repeated, is a 400', () => {
    for (const providers of [['gemini'], [], ['anthropic', 'anthropic'], ['anthropic', 'openai', 'openai'], 'openai', ['openai', 7]]) {
      expect(() => parseRouting({ providers })).toThrow(RoutingError);
    }
    expect(new RoutingError('x').status).toBe(400);
  });

  it('an openaiModel that is not a string, or too long, is a 400', () => {
    expect(() => parseRouting({ openaiModel: 5 })).toThrow(RoutingError);
    expect(() => parseRouting({ openaiModel: 'x'.repeat(101) })).toThrow(RoutingError);
  });

  it('a raw body gives its routing', () => {
    expect(routingOf(JSON.stringify({ q: 'x', providers: ['openai'] }))).toEqual({ providers: ['openai'] });
  });
});

describe('which errors move on to the next service', () => {
  it('a refused, unauthorised, limited or server failure moves on; an abort does not', () => {
    for (const status of [400, 401, 403, 404, 429, 500, 502, 503]) expect(fallbackWorthy(Object.assign(new Error('x'), { status }))).toBe(true);
    expect(fallbackWorthy(refused())).toBe(false);
    expect(fallbackWorthy(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(false);
    expect(fallbackWorthy(new Error('一般錯誤'))).toBe(false);
    expect(fallbackWorthy(null)).toBe(false);
  });

  it('a time limit, a dropped connection and a network failure move on', () => {
    expect(fallbackWorthy(Object.assign(new Error('逾時'), { timeout: true }))).toBe(true);
    expect(fallbackWorthy(new TypeError('fetch failed'))).toBe(true);
    expect(fallbackWorthy(new Anthropic.APIConnectionError({ message: 'connection error' }))).toBe(true);
  });

  it('the limit and quota codes of OpenAI move on; an incomplete reply does not', () => {
    expect(fallbackWorthy(new OpenAIError('x', { code: 'usage_limit' }))).toBe(true);
    expect(fallbackWorthy(new OpenAIError('ChatGPT 回覆未完成（rate_limit_exceeded）'))).toBe(true);
    expect(fallbackWorthy(new OpenAIError('x', { code: 'max_output_tokens' }))).toBe(false);
  });
});

describe('firstServing (one-shot calls)', () => {
  it('the first service that serves is the one used; the others are not called', async () => {
    const a = fake('anthropic');
    const b = fake('openai');
    const run = vi.fn(async (s: Service) => (s.id === 'anthropic' ? 'A' : 'B'));
    const r = await firstServing([a, b], run);
    expect(r).toEqual({ ok: true, value: 'A', served: a });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a failure that moves on hands the call to the next service', async () => {
    const a = fake('anthropic');
    const b = fake('openai');
    const r = await firstServing([a, b], async (s) => { if (s.id === 'anthropic') throw limited(); return 'B'; });
    expect(r).toEqual({ ok: true, value: 'B', served: b });
  });

  it('a failure that does not move on ends the call with that service', async () => {
    const a = fake('anthropic');
    const b = fake('openai');
    const run = vi.fn(async () => { throw refused(); });
    const r = await firstServing([a, b], run);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failed).toBe(a);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('when every service fails the last failure is reported', async () => {
    const a = fake('anthropic');
    const b = fake('openai');
    const r = await firstServing([a, b], async (s) => {
      throw Object.assign(new Error(s.id === 'openai' ? 'openai down' : 'anthropic down'), { status: 503 });
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failed).toBe(b);
      expect((r.error as Error).message).toBe('openai down');
    }
  });
});

describe('streamReply (the chat reply over the services)', () => {
  it('the list order is the order of the attempts, and the first that answers ends it', async () => {
    const openai = fake('openai', { deltas: ['你好'] });
    const anthropic = fake('anthropic', { deltas: ['不會用到'] });
    const { io, events } = fakeIo();
    const served = await streamReply([openai, anthropic], body, io);
    expect(served).toBe(openai);
    expect(anthropic.stream).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: 'delta', text: '你好' }, { type: 'done', provider: 'openai' }]);
    expect(io.spendDone).not.toHaveBeenCalled(); // ChatGPT: not Claude spend
  });

  it('a Claude reply that finishes records its spend', async () => {
    const anthropic = fake('anthropic', { deltas: ['嗨'] });
    const { io } = fakeIo();
    await streamReply([anthropic], body, io);
    expect(io.spendDone).toHaveBeenCalledWith(anthropic, expect.objectContaining({ text: '嗨' }));
  });

  it('a limit before any text moves on to the next service, and the early end of Claude is recorded', async () => {
    const anthropic = fake('anthropic', { error: limited() });
    const openai = fake('openai', { deltas: ['換人了'] });
    const { io, events } = fakeIo();
    const served = await streamReply([anthropic, openai], body, io);
    expect(served).toBe(openai);
    expect(io.spendEnded).toHaveBeenCalledTimes(1);
    expect(io.failed).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: 'delta', text: '換人了' }, { type: 'done', provider: 'openai' }]);
  });

  it('a failure after a delta went out does not move on: it ends the reply with an error', async () => {
    const anthropic = fake('anthropic', { deltas: ['她說到一半'], error: Object.assign(new Error('overloaded'), { status: 503 }) });
    const openai = fake('openai', { deltas: ['不該出現'] });
    const { io } = fakeIo();
    const served = await streamReply([anthropic, openai], body, io);
    expect(served).toBe(anthropic);
    expect(openai.stream).not.toHaveBeenCalled();
    expect(io.failed).toHaveBeenCalledWith(anthropic, expect.objectContaining({ status: 503 }));
  });

  it('a failure the service does not move on from ends the reply with that service', async () => {
    const anthropic = fake('anthropic', { error: refused() });
    const openai = fake('openai', { deltas: ['不該出現'] });
    const { io } = fakeIo();
    expect(await streamReply([anthropic, openai], body, io)).toBe(anthropic);
    expect(openai.stream).not.toHaveBeenCalled();
    expect(io.failed).toHaveBeenCalledTimes(1);
  });

  it('the last service that fails ends the reply with its error', async () => {
    const openai = fake('openai', { error: limited() });
    const { io } = fakeIo();
    expect(await streamReply([openai], body, io)).toBe(openai);
    expect(io.failed).toHaveBeenCalledWith(openai, expect.anything());
  });

  it('a player who has left is neither answered nor moved on', async () => {
    const anthropic = fake('anthropic', { error: limited() });
    const openai = fake('openai', { deltas: ['x'] });
    const { io } = fakeIo(true);
    expect(await streamReply([anthropic, openai], body, io)).toBeNull();
    expect(openai.stream).not.toHaveBeenCalled();
    expect(io.failed).not.toHaveBeenCalled();
  });
});


// All providers here are in-memory substitutes. No keys or paid services are configured or called.
describe('T1 exact plan codes, cancellation and partial-output boundary', () => {
  const codes = ['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable'];
  it.each(codes)('%s already matches the generic fallback rule', (code) => {
    expect(fallbackWorthy(new OpenAIError('x', { code }))).toBe(true);
    expect(fallbackWorthy(Object.assign(new OpenAIError('x', { code }), { partialOutput: true }))).toBe(false);
  });

  it.each(codes)('%s uses only the explicitly supplied fallback and only before text', async (code) => {
    for (const partial of [false, true]) {
      const source = fake('openai', { error: new OpenAIError('x', { code }), deltas: partial ? ['partial'] : [] });
      const fallback = fake('anthropic', { deltas: ['substitute only'], spend: false });
      const { io } = fakeIo();
      await streamReply([source, fallback], body, io);
      expect(fallback.stream).toHaveBeenCalledTimes(partial ? 0 : 1);
      const alone = fakeIo();
      await streamReply([source], body, alone.io);
      expect(alone.io.failed).toHaveBeenCalledOnce();
    }
  });

  it('an explicit abort cannot fallback even before output', async () => {
    const source = fake('openai', { error: Object.assign(new Error('cancelled'), { name: 'AbortError' }) });
    const fallback = fake('anthropic', { spend: false });
    await streamReply([source, fallback], body, fakeIo().io);
    expect(fallback.stream).not.toHaveBeenCalled();
  });

  it.each(codes)('buffered one-shot output followed by %s cannot fallback', async (code) => {
    const source = fake('openai');
    source.provider = openaiProvider(async () => new Response([
      { type: 'response.output_text.delta', delta: 'partial' },
      { type: 'response.failed', response: { error: { code } } },
    ].map(e => `data: ${JSON.stringify(e)}\n\n`).join('')));
    const fallback = fake('anthropic', { spend: false });
    const run = vi.fn((s: Service) => s.provider.complete({ model: s.model, max_tokens: 10, system: '', messages: [] }));
    const result = await firstServing([source, fallback], run);
    expect(result.ok).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });
});
