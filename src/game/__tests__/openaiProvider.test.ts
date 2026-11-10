// The ChatGPT provider (server/llm/openaiProvider.ts), offline: the request conversion, the Responses stream read (deltas,
// completion, failure, a cut stream), the abort and the time limit, the error mapping, and the strict-schema rule for every
// JSON schema the server sends (OpenAI's strict json_schema needs additionalProperties false and every property required).
import { describe, expect, it, vi } from 'vitest';
import { CHAT_REPLY_SCHEMA, chatRequest, parseChatBody } from '../../../server/claudeChat.ts';
import { JUDGE_SCHEMA, LOOKUP_SCHEMA, TIP_FIX_SCHEMA } from '../../../server/claudeChat.ts';
import { OPENAI_MAX_OUTPUT_CHARS, OPENAI_STREAM_TIMEOUT_MS, OpenAIError, describeOpenAIError, openaiProvider, responsesBody, type OpenAITransport } from '../../../server/llm/openaiProvider.ts';
import { reminderPrompt, systemPrompt } from '../../../server/prompts.ts';

const sample = parseChatBody(JSON.stringify({
  messages: [{ role: 'user', content: 'A' }, { role: 'assistant', content: 'B' }, { role: 'user', content: 'C' }],
  role: 'Mugi', mode: 'teacher', context: {},
}));

/** an SSE body split into arbitrary chunks (a chunk may cut an event anywhere) */
function sseStream(text: string, cuts: number[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  const pieces: Uint8Array[] = [];
  let at = 0;
  for (const c of [...cuts, bytes.length]) {
    if (c > at) pieces.push(bytes.slice(at, c));
    at = c;
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of pieces) controller.enqueue(p);
      controller.close();
    },
  });
}

const events = (list: unknown[]) => list.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

/** a transport that answers with the given SSE text, and records what it was sent */
function transportWith(text: string, cuts: number[] = []) {
  const sent: { path: string; body: string; signal: AbortSignal }[] = [];
  const transport: OpenAITransport = async (path, init) => {
    sent.push({ path, body: init.body, signal: init.signal });
    return new Response(sseStream(text, cuts), { status: 200 });
  };
  return { transport, sent };
}

/** the JSON-schema rule of OpenAI's strict mode: every object closed, every property required; returns the places that break it */
function strictViolations(schema: unknown, path = '$'): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const s = schema as Record<string, unknown>;
  const out: string[] = [];
  if (s.type === 'object') {
    const props = (s.properties ?? {}) as Record<string, unknown>;
    if (s.additionalProperties !== false) out.push(`${path}: additionalProperties is not false`);
    const required = Array.isArray(s.required) ? (s.required as string[]) : [];
    for (const k of Object.keys(props)) if (!required.includes(k)) out.push(`${path}.${k}: not required`);
    for (const [k, v] of Object.entries(props)) out.push(...strictViolations(v, `${path}.${k}`));
  }
  if (s.type === 'array') out.push(...strictViolations(s.items, `${path}[]`));
  if (Array.isArray(s.anyOf)) (s.anyOf as unknown[]).forEach((v, i) => out.push(...strictViolations(v, `${path}.anyOf[${i}]`)));
  return out;
}

describe('request conversion (Anthropic shape → Responses shape)', () => {
  it('system text becomes instructions; messages become text input; the reply schema becomes a strict json_schema', () => {
    const body = responsesBody(chatRequest(sample, 'gpt-test'));
    expect(body.model).toBe('gpt-test');
    expect(body.instructions).toBe(systemPrompt('Mugi'));
    expect(body.input).toEqual([
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'B' },
      { role: 'user', content: `C\n\n<reminder>${reminderPrompt()}</reminder>` },
    ]);
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.text).toEqual({ format: { type: 'json_schema', name: 'mugi_reply', strict: true, schema: CHAT_REPLY_SCHEMA } });
    expect(JSON.stringify(body)).not.toContain('cache_control');
    expect(body).not.toHaveProperty('betas');
    expect(body).not.toHaveProperty('fallbacks');
  });

  it('a one-shot request keeps its own schema name, and a request without a schema has no text format', () => {
    const judge = responsesBody({
      model: 'gpt-test', max_tokens: 100, system: 'J', messages: [{ role: 'user', content: 'x' }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: JUDGE_SCHEMA } }, schemaName: 'mugi_judge',
    });
    expect(judge.text).toEqual({ format: { type: 'json_schema', name: 'mugi_judge', strict: true, schema: JUDGE_SCHEMA } });
    expect(judge.instructions).toBe('J');
    const plain = responsesBody({ model: 'gpt-test', max_tokens: 100, system: 'S', messages: [{ role: 'user', content: 'x' }] });
    expect(plain).not.toHaveProperty('text');
  });
});

describe('the schemas the server sends are strict-compatible (no change to the Claude schemas needed)', () => {
  it.each([
    ['chat reply', CHAT_REPLY_SCHEMA],
    ['judge', JUDGE_SCHEMA],
    ['tip rewrite', TIP_FIX_SCHEMA],
    ['lookup', LOOKUP_SCHEMA],
  ])('%s: every object is closed and every property is required', (_name, schema) => {
    expect(strictViolations(schema)).toEqual([]);
  });

  it('the checker itself catches an open object', () => {
    expect(strictViolations({ type: 'object', properties: { a: { type: 'string' } }, required: [], additionalProperties: true }).length).toBe(2);
  });
});

describe('streamChat', () => {
  it('sends the deltas to onDelta as they come and resolves with the whole text and the model', async () => {
    const text = events([
      { type: 'response.created', response: {} },
      { type: 'response.output_text.delta', delta: '{"segments":' },
      { type: 'response.output_text.delta', delta: '[]}' },
      { type: 'response.completed', response: { model: 'gpt-test', status: 'completed' } },
    ]);
    // cut the stream inside an event, and inside a line break
    const { transport, sent } = transportWith(text, [5, 40, text.length - 9]);
    const got: string[] = [];
    const s = openaiProvider(transport).streamChat(chatRequest(sample, 'gpt-test'), (t) => got.push(t));
    const r = await s.done;
    expect(got).toEqual(['{"segments":', '[]}']);
    expect(r).toEqual({ text: '{"segments":[]}', model: 'gpt-test', stopReason: 'completed' });
    expect(s.usageSoFar()).toBeUndefined();
    expect(sent[0].path).toBe('/responses');
    const wire = JSON.parse(sent[0].body);
    expect(wire.store).toBe(false);
    expect(wire.stream).toBe(true);
    expect(wire.model).toBe('gpt-test');
    expect(Object.keys(wire).sort()).toEqual(['input', 'instructions', 'model', 'store', 'stream', 'text']);
  });

  it('a failed response ends with its code (usage_limit is a limit, so the chain may move on)', async () => {
    const { transport } = transportWith(events([{ type: 'response.failed', response: { error: { code: 'usage_limit' } } }]));
    const s = openaiProvider(transport).streamChat(chatRequest(sample, 'gpt-test'), () => {});
    await expect(s.done).rejects.toMatchObject({ code: 'usage_limit' });
    await expect(openaiProvider(transport).streamChat(chatRequest(sample, 'gpt-test'), () => {}).done).rejects.toThrow('ChatGPT 回覆未完成（usage_limit）');
  });

  it('an incomplete response names its reason', async () => {
    const { transport } = transportWith(events([{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]));
    await expect(openaiProvider(transport).streamChat(chatRequest(sample, 'gpt-test'), () => {}).done).rejects.toMatchObject({ code: 'max_output_tokens' });
  });

  it('a stream that ends without response.completed is a dropped line', async () => {
    const { transport } = transportWith(events([{ type: 'response.output_text.delta', delta: 'x' }]));
    await expect(openaiProvider(transport).streamChat(chatRequest(sample, 'gpt-test'), () => {}).done).rejects.toThrow('連線中斷');
  });

  it('abort reaches the request', async () => {
    let seen: AbortSignal | undefined;
    const transport: OpenAITransport = async (_p, init) => {
      seen = init.signal;
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
    };
    const s = openaiProvider(transport).streamChat(chatRequest(sample, 'gpt-test'), () => {});
    s.abort();
    expect(seen?.aborted).toBe(true);
    await expect(s.done).rejects.toBeDefined();
  });
});

describe('complete', () => {
  it('returns the collected text; a limit the caller sets ends the request as a timeout', async () => {
    const { transport } = transportWith(events([
      { type: 'response.output_text.delta', delta: '{"ok":true,"feedback":"好"}' },
      { type: 'response.completed', response: { model: 'gpt-test', status: 'completed' } },
    ]));
    const r = await openaiProvider(transport).complete({ model: 'gpt-test', max_tokens: 50, system: 'J', messages: [{ role: 'user', content: 'x' }] }, { timeout: 1000 });
    expect(r.text).toBe('{"ok":true,"feedback":"好"}');

    const hang: OpenAITransport = (_p, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const err = await openaiProvider(hang).complete({ model: 'gpt-test', max_tokens: 50, system: 'J', messages: [] }, { timeout: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAIError);
    expect((err as OpenAIError).timeout).toBe(true);
  });
});

describe('describeOpenAIError', () => {
  it('maps the failures to the messages the player sees (no token, no reply text)', () => {
    expect(describeOpenAIError(new OpenAIError('x', { status: 401 }))).toEqual({ status: 401, message: '請重新登入 ChatGPT' });
    expect(describeOpenAIError(new OpenAIError('x', { status: 403 }))).toEqual({ status: 403, message: 'ChatGPT 方案權限或政策不允許此請求，請檢查授權與帳號限制。' });
    expect(describeOpenAIError(new OpenAIError('x', { status: 429 }))).toEqual({ status: 429, message: 'ChatGPT 額度已用完或太頻繁，請稍後再試' });
    expect(describeOpenAIError(new OpenAIError('x', { code: 'usage_limit' }))).toEqual({ status: 429, message: 'ChatGPT 額度已用完或太頻繁，請稍後再試' });
    expect(describeOpenAIError(new OpenAIError('x', { status: 503 }))).toEqual({ status: 502, message: 'OpenAI 暫時有問題，請稍後再試' });
    expect(describeOpenAIError(new OpenAIError('x', { status: 400 }))).toEqual({ status: 502, message: 'ChatGPT 回應錯誤（400）' });
    expect(describeOpenAIError(new OpenAIError('x', { timeout: true }))).toEqual({ status: 504, message: 'ChatGPT 回應逾時，已中止' });
    expect(describeOpenAIError(new TypeError('fetch failed'))).toEqual({ status: 502, message: '連不上 ChatGPT' });
    expect(describeOpenAIError(new Error('boom'))).toEqual({ status: 500, message: 'boom' });
  });
});


describe('T1 streamed terminal events and local guards', () => {
  it.each(['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable'])('%s has the same Chinese recovery before and after a delta', async (code) => {
    for (const partial of [false, true]) {
      const { transport } = transportWith(events([
        ...(partial ? [{ type: 'response.output_text.delta', delta: 'partial' }] : []),
        { type: 'response.failed', response: { error: { code } } },
      ]));
      const got = vi.fn();
      const error = await openaiProvider(transport).streamChat(chatRequest(sample, 'gpt-test'), got).done.catch(e => e);
      expect(error).toMatchObject({ code });
      expect(!!error.partialOutput).toBe(partial);
      expect(got).toHaveBeenCalledTimes(partial ? 1 : 0);
      const mapped = describeOpenAIError(error);
      expect(mapped.status).toBe(code.endsWith('exceeded') ? 429 : 503);
      expect(mapped.message).toContain(code.endsWith('exceeded') ? '方案使用已達限制' : '暫時無法確認');
    }
  });

  it.each([
    [[{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]],
    [[{ type: 'error', code: 'subscription_sharing_usage_unavailable' }]],
    [[]],
  ])('does not succeed with partial text and terminal events %j', async (terminal) => {
    const { transport } = transportWith(events([{ type: 'response.output_text.delta', delta: 'partial' }, ...terminal]));
    await expect(openaiProvider(transport).complete({ model: 'gpt-test', max_tokens: 10, system: '', messages: [] })).rejects.toMatchObject({ partialOutput: true });
  });

  it('requires a complete terminal event, not DONE or a truncated completed event', async () => {
    for (const suffix of ['data: [DONE]\n\n', 'data: {"type":"response.completed"}']) {
      const { transport } = transportWith(events([{ type: 'response.output_text.delta', delta: 'x' }]) + suffix);
      await expect(openaiProvider(transport).streamChat(chatRequest(sample, 'gpt-test'), () => {}).done).rejects.toThrow('連線中斷');
    }
  });

  it('cancels a locked pending reader after output without waiting for the global timeout', async () => {
    const cancel = vi.fn();
    let emitted!: () => void;
    const firstDelta = new Promise<void>(resolve => { emitted = resolve; });
    const transport: OpenAITransport = async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(events([{ type: 'response.output_text.delta', delta: 'partial' }]))); }, cancel,
    }));
    const s = openaiProvider(transport).streamChat(chatRequest(sample, 'gpt-test'), emitted);
    const rejected = expect(s.done).rejects.toMatchObject({ name: 'AbortError', partialOutput: true });
    await firstDelta;
    s.abort();
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('bounds output locally and cancels upstream without reporting success', async () => {
    const cancel = vi.fn();
    const transport: OpenAITransport = async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(events([
        { type: 'response.output_text.delta', delta: 'a'.repeat(OPENAI_MAX_OUTPUT_CHARS) },
        { type: 'response.output_text.delta', delta: 'overflow' },
        { type: 'response.completed' },
      ]))); }, cancel,
    }));
    const delta = vi.fn();
    await expect(openaiProvider(transport).streamChat(chatRequest(sample, 'gpt-test'), delta).done)
      .rejects.toMatchObject({ code: 'local_output_limit', partialOutput: true });
    expect(delta).toHaveBeenCalledOnce();
    expect(delta.mock.calls[0][0]).toHaveLength(OPENAI_MAX_OUTPUT_CHARS);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(['chat', 'complete'])('%s has a default timeout even while its reader is locked', async (kind) => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const transport: OpenAITransport = async () => new Response(new ReadableStream({ start() {}, cancel }));
      const p = openaiProvider(transport);
      const done = kind === 'chat' ? p.streamChat(chatRequest(sample, 'gpt-test'), () => {}).done
        : p.complete({ model: 'gpt-test', max_tokens: 10, system: '', messages: [] });
      const rejected = expect(done).rejects.toMatchObject({ timeout: true });
      await vi.advanceTimersByTimeAsync(OPENAI_STREAM_TIMEOUT_MS);
      await rejected;
      expect(cancel).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});
