// The AI 模型 and 人設 settings: the model and persona fields of the request bodies (server and phone), the validation that
// refuses anything else, the system prompt with a persona, and the helper routes (速查, 小提醒 judge, tip rewrite) taking
// their model from the body. Nothing here calls Claude: the upstream is a fake provider or a fetch stub, and the routes
// are driven only up to their 400 answers (or the status read), with a test key and a temporary folder.
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmCompleteRequest, LlmProvider } from '../../../server/llm/provider.ts';
import { CLAUDE_PRICES } from '../../../server/usage.ts';
import {
  bodyModel, chatRequest, claudeChatPlugin, lookupAnswerWith, parseChatBody, parseModel, parsePersona, rewriteTipWith,
} from '../../../server/claudeChat.ts';
import { defaultPersona, systemPrompt } from '../../../server/prompts.ts';
import {
  CHAT_MODEL_CHOICES, PERSONA_MAX_CHARS, chatModelLabel, isChatModelId, personaText,
} from '../claudeProtocol';
import { DEFAULT_TUTOR, TUTOR_KEY, cleanPersonaSetting, loadTutor, migrateTutor } from '../tutor';
import { askClaude, claudeStatus, reviseTip } from '../claudeBrain';
import { judgeSaid } from '../tipsJudge';
import { askLookup } from '../lookup';

const base = { messages: [{ role: 'user', content: '嗨' }], role: 'Mugi', mode: 'teacher', context: {} };

/** the HTTP status and message a throwing call carries (HttpError), or null when it did not throw */
function refusal(f: () => unknown): { status: number; message: string } | null {
  try {
    f();
  } catch (e) {
    return { status: (e as { status?: number }).status ?? 0, message: (e as Error).message };
  }
  return null;
}

/** a provider that records the one-shot requests and answers with the given text */
function fakeProvider(text: string) {
  const calls: LlmCompleteRequest[] = [];
  const provider = {
    id: 'anthropic',
    streamChat: vi.fn(),
    describeError: vi.fn(),
    complete: vi.fn(async (req: LlmCompleteRequest) => {
      calls.push(req);
      return { text, model: req.model, usage: { input_tokens: 1, output_tokens: 1 } };
    }),
  };
  return { provider: provider as unknown as LlmProvider, calls };
}

/** localStorage stand-in (the node test environment has none) */
function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

const CHOICE_IDS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];

describe('the model choices', () => {
  it('lists Haiku (the default), Sonnet and Opus, in that order', () => {
    expect(CHAT_MODEL_CHOICES.map((m) => m.id)).toEqual(CHOICE_IDS);
    expect(CHAT_MODEL_CHOICES.map((m) => m.label)).toEqual(['Haiku 5.5', 'Sonnet 5.5', 'Opus 5.5']);
  });
  it('every model in the list has a price in server/usage.ts (the daily cap can count it)', () => {
    for (const m of CHAT_MODEL_CHOICES) expect(CLAUDE_PRICES[m.id]).toBeDefined();
  });
  it('isChatModelId accepts only the listed ids; the label of an unknown id is the id itself', () => {
    expect(isChatModelId('claude-opus-5-5')).toBe(true);
    expect(isChatModelId('claude-fable-5-1')).toBe(false);
    expect(isChatModelId('')).toBe(false);
    expect(chatModelLabel('claude-sonnet-5-5')).toBe('Sonnet 5.5');
    expect(chatModelLabel('claude-x')).toBe('claude-x');
  });
});

describe('the model of a request body (server)', () => {
  it('parseModel: absent or null is no model; a listed id is kept; anything else is a 400', () => {
    expect(parseModel(undefined)).toBeUndefined();
    expect(parseModel(null)).toBeUndefined();
    expect(parseModel('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(refusal(() => parseModel('gpt-4o'))).toEqual({ status: 400, message: '不支援的模型' });
    expect(refusal(() => parseModel('claude-fable-5-1'))).toEqual({ status: 400, message: '不支援的模型' });
    expect(refusal(() => parseModel(3))).toEqual({ status: 400, message: '不支援的模型' });
  });
  it('the chat body keeps a listed model and refuses an unlisted one with 400', () => {
    expect(parseChatBody(JSON.stringify({ ...base, model: 'claude-sonnet-5-5' })).model).toBe('claude-sonnet-5-5');
    expect(refusal(() => parseChatBody(JSON.stringify({ ...base, model: 'claude-x' })))).toEqual({ status: 400, message: '不支援的模型' });
  });
  it('a body without a model has none: the server then uses its own', () => {
    expect(parseChatBody(JSON.stringify(base))).not.toHaveProperty('model');
    expect(parseChatBody(JSON.stringify({ ...base, model: null }))).not.toHaveProperty('model');
  });
  it('bodyModel reads the model of a raw helper body, with the same refusal', () => {
    expect(bodyModel('{"tip":"x","model":"claude-opus-5-5"}')).toBe('claude-opus-5-5');
    expect(bodyModel('{"tip":"x"}')).toBeUndefined();
    expect(refusal(() => bodyModel('{"tip":"x","model":"nope"}'))?.status).toBe(400);
  });
  it('the request sent upstream uses the model it was given', () => {
    const body = parseChatBody(JSON.stringify(base));
    expect(chatRequest(body, 'claude-opus-5-5').model).toBe('claude-opus-5-5');
  });
});

describe('the persona of a request body (server)', () => {
  it('personaText removes control characters, turns line breaks and tabs into one space, and trims', () => {
    expect(personaText('  愛撒嬌\u0007的倉鼠\n第二行\u0000\r\t ')).toBe('愛撒嬌的倉鼠 第二行');
  });
  it('parsePersona keeps the text (line breaks as spaces), with < and > made full-width', () => {
    expect(parsePersona('  愛撒嬌\u0007的倉鼠\n第二行<b>x</b>  ')).toBe('愛撒嬌的倉鼠 第二行＜b＞x＜/b＞');
  });
  it('parsePersona: absent or null is no persona; empty, blank, over the limit or not text is a 400', () => {
    expect(parsePersona(undefined)).toBeUndefined();
    expect(parsePersona(null)).toBeUndefined();
    expect(refusal(() => parsePersona(''))?.status).toBe(400);
    expect(refusal(() => parsePersona('  \u0007 \n '))?.status).toBe(400);
    expect(refusal(() => parsePersona('a'.repeat(PERSONA_MAX_CHARS + 1)))?.status).toBe(400);
    expect(refusal(() => parsePersona(42))?.status).toBe(400);
  });
  it('400 characters is the longest allowed; the limit counts characters, not the spaces around them', () => {
    expect(parsePersona('あ'.repeat(PERSONA_MAX_CHARS))).toBe('あ'.repeat(PERSONA_MAX_CHARS));
    expect(parsePersona(`  ${'あ'.repeat(PERSONA_MAX_CHARS)}  `)).toBe('あ'.repeat(PERSONA_MAX_CHARS));
    expect(refusal(() => parsePersona('あ'.repeat(PERSONA_MAX_CHARS + 1)))?.status).toBe(400);
  });
  it('the chat body carries the persona when there is one, and none when there is not', () => {
    expect(parseChatBody(JSON.stringify({ ...base, persona: '冷靜的老師' })).persona).toBe('冷靜的老師');
    expect(parseChatBody(JSON.stringify(base))).not.toHaveProperty('persona');
  });
});

describe('the system prompt with a persona', () => {
  it('without a persona the prompt is the default one, with the default personality line', () => {
    expect(systemPrompt('Mugi')).toBe(systemPrompt('Mugi', undefined));
    expect(systemPrompt('Mugi')).toContain(`個性：${defaultPersona('Mugi')}稱呼對方為「你」。`);
  });
  it('a persona replaces only the personality line; the rules and the reply format after it do not change', () => {
    const custom = systemPrompt('Mugi', '冷靜沉穩的老師');
    expect(custom).toContain('個性：冷靜沉穩的老師\n稱呼對方為「你」。');
    expect(custom).not.toContain(defaultPersona('Mugi'));
    const tail = (s: string) => s.slice(s.indexOf('\n你同時是使用者的日語會話夥伴'));
    expect(tail(custom)).toBe(tail(systemPrompt('Mugi')));
    expect(custom.slice(0, custom.indexOf('個性：'))).toBe(systemPrompt('Mugi').slice(0, systemPrompt('Mugi').indexOf('個性：')));
  });
  it('the chat request puts the persona in its system block; the cache breakpoint stays on it', () => {
    const body = parseChatBody(JSON.stringify({ ...base, persona: '冷靜沉穩的老師' }));
    const req = chatRequest(body, 'claude-haiku-5-5');
    expect(req.system).toEqual([{ type: 'text', text: systemPrompt('Mugi', '冷靜沉穩的老師'), cache_control: { type: 'ephemeral' } }]);
  });
  it('a body without a persona sends the same system block as before', () => {
    const req = chatRequest(parseChatBody(JSON.stringify(base)), 'claude-haiku-5-5');
    expect(req.system).toEqual([{ type: 'text', text: systemPrompt('Mugi'), cache_control: { type: 'ephemeral' } }]);
  });
});

describe('the helper calls take their model from the request', () => {
  it('速查 runs on the model it is given, and on the default one without it', async () => {
    const a = fakeProvider('{"items":[],"grammar":[],"examples":[],"message":"好"}');
    await lookupAnswerWith(a.provider, '去學校', undefined, 'claude-sonnet-5-5');
    expect(a.calls[0].model).toBe('claude-sonnet-5-5');
    const b = fakeProvider('{"items":[],"grammar":[],"examples":[],"message":"好"}');
    await lookupAnswerWith(b.provider, '去學校');
    expect(b.calls[0].model).toBe('claude-haiku-5-5');
  });
  it('the tip rewrite runs on the model it is given, and on the default one without it', async () => {
    const a = fakeProvider('{"tip":"要說 <ja>行きましょう</ja>"}');
    await rewriteTipWith(a.provider, '<ja>行きましょう</ja>', undefined, 'claude-opus-5-5');
    expect(a.calls[0].model).toBe('claude-opus-5-5');
    const b = fakeProvider('{"tip":"要說 <ja>行きましょう</ja>"}');
    await rewriteTipWith(b.provider, '<ja>行きましょう</ja>');
    expect(b.calls[0].model).toBe('claude-haiku-5-5');
  });
});

// ---------------------------------------------------------------- the routes, driven through the Vite plugin

type Handler = (req: unknown, res: unknown) => void;

/** the plugin mounted on a fake dev server: its middlewares by path. Settings come from the temporary folder and process.env. */
function mountRoutes(root: string): Record<string, Handler> {
  const plugin = claudeChatPlugin();
  (plugin.configResolved as unknown as (c: { root: string; mode: string }) => void)({ root, mode: 'development' });
  const mounted: Record<string, Handler> = {};
  const server = {
    config: { server: { allowedHosts: [] } },
    middlewares: { use: (path: string, h: Handler) => { mounted[path] = h; } },
  };
  (plugin.configureServer as unknown as (s: unknown) => void)(server);
  return mounted;
}

/** one request through a handler: resolves with the status and the JSON body of the answer */
function call(handler: Handler, method: string, url: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    const state = { status: 0, text: '' };
    const req = Object.assign(new EventEmitter(), {
      method, url, headers: { host: 'localhost:3004', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' }, destroy() {},
    });
    const res = {
      headersSent: false,
      writableEnded: false,
      writeHead(s: number) { state.status = s; },
      setHeader() {},
      flushHeaders() {},
      write(c: string) { state.text += c; return true; },
      end(c?: string) {
        if (c) state.text += c;
        res.writableEnded = true;
        resolve({ status: state.status, body: state.text ? JSON.parse(state.text) : null });
      },
    };
    handler(req, res);
    setTimeout(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    }, 20);
  });
}

describe('the routes refuse a model outside the list, and report their personas (no Claude call)', () => {
  let root: string;
  let routes: Record<string, Handler>;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    // a test key from the process environment and an empty folder: .env.local is never read, nothing is sent upstream
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-a-real-key';
    root = mkdtempSync(join(tmpdir(), 'mugi-route-'));
    routes = mountRoutes(root);
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    rmSync(root, { recursive: true, force: true });
  });

  it('GET /api/chat/status gives the default personality per role, not the whole system prompt', async () => {
    const r = await call(routes['/api/chat'], 'GET', '/status');
    expect(r.status).toBe(200);
    const j = r.body as { ok: boolean; model: string; personas: Record<string, string> };
    expect(j.ok).toBe(true);
    expect(j.personas).toEqual({ Mugi: defaultPersona('Mugi') });
    expect(JSON.stringify(j)).not.toContain('你同時是使用者的日語會話夥伴');
  });

  it('POST /api/chat with a model outside the list is a 400 before anything is sent', async () => {
    const r = await call(routes['/api/chat'], 'POST', '/', { ...base, model: 'gpt-4o' });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'bad_request', message: '不支援的模型' });
  });

  it('POST /api/chat with a persona that is too long is a 400', async () => {
    const r = await call(routes['/api/chat'], 'POST', '/', { ...base, persona: 'a'.repeat(PERSONA_MAX_CHARS + 1) });
    expect(r.status).toBe(400);
  });

  it('the helper routes (judge, fix-tip, lookup) refuse an unlisted model with 400', async () => {
    const judge = await call(routes['/api/chat'], 'POST', '/judge', { target: '学校に行きました', said: '学校へ行きました', model: 'nope' });
    expect(judge.status).toBe(400);
    expect(judge.body).toMatchObject({ message: '不支援的模型' });
    const fix = await call(routes['/api/chat'], 'POST', '/fix-tip', { tip: '<ja>行きましょう</ja>', model: 'nope' });
    expect(fix.status).toBe(400);
    const lookup = await call(routes['/api/lookup'], 'POST', '/', { q: '去學校', model: 'nope' });
    expect(lookup.status).toBe(400);
    expect(lookup.body).toMatchObject({ message: '不支援的模型' });
  });
});

// ---------------------------------------------------------------- the phone: settings and the request bodies

describe('the model and persona settings (phone)', () => {
  let ls: ReturnType<typeof memoryStorage>;
  beforeEach(() => {
    ls = memoryStorage();
    vi.stubGlobal('localStorage', ls);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('an older save with no model or persona gets the defaults', () => {
    expect(migrateTutor({ name: 'むぎ', sttLang: 'ja-JP' })).toEqual({
      characters: DEFAULT_TUTOR.characters, activeId: 'mugi', sttLang: 'ja-JP', chatModel: '', helperModel: 'claude-haiku-5-5',
      providers: ['anthropic'], openaiModel: '', background: 'classroom', customBackgrounds: [], backgroundOpts: {},
    });
    expect(DEFAULT_TUTOR.helperModel).toBe('claude-haiku-5-5');
  });
  it('a model not in the list falls back to the default, a listed one is kept', () => {
    expect(migrateTutor({ chatModel: 'gpt-4o', helperModel: 'claude-fable-5-1' })).toMatchObject({ chatModel: '', helperModel: 'claude-haiku-5-5' });
    expect(migrateTutor({ chatModel: 'claude-opus-5-5', helperModel: 'claude-sonnet-5-5' })).toMatchObject({
      chatModel: 'claude-opus-5-5', helperModel: 'claude-sonnet-5-5',
    });
  });
  it('a persona is cleaned and cut to the limit when it is kept', () => {
    expect(cleanPersonaSetting('\u0007 冷靜的老師 ')).toBe('冷靜的老師');
    expect(cleanPersonaSetting('a'.repeat(PERSONA_MAX_CHARS + 50))).toHaveLength(PERSONA_MAX_CHARS);
    expect(cleanPersonaSetting(42)).toBe('');
    expect(migrateTutor({ persona: '  ' }).characters[0].persona).toBe('');
  });
  it('a stored persona and models come back through loadTutor (an older save: the persona is character 1s)', () => {
    ls.setItem(TUTOR_KEY, JSON.stringify({ name: 'むぎ', sttLang: 'ja-JP', chatModel: 'claude-opus-5-5', helperModel: 'claude-sonnet-5-5', persona: '愛撒嬌' }));
    const s = loadTutor();
    expect(s).toMatchObject({ chatModel: 'claude-opus-5-5', helperModel: 'claude-sonnet-5-5', activeId: 'mugi' });
    expect(s.characters[0]).toMatchObject({ id: 'mugi', name: 'むぎ', persona: '愛撒嬌' });
    expect(s.characters).toHaveLength(3);
  });

  const sse = (text: string) => `data: ${JSON.stringify({ type: 'delta', text })}\n\n` + `data: ${JSON.stringify({ type: 'done', text })}\n\n`;
  const reply = '{"segments":[{"lang":"ja","text":"はい","gloss":"好"}],"tip":"","tone":"happy"}';
  const teacher = { history: [{ from: 'me' as const, text: '嗨', t: 1 }], role: 'Mugi' as const, mode: 'teacher' as const, context: {} };

  it('the chat sends no model or persona when none is set', async () => {
    const fetchMock = vi.fn(async () => new Response(sse(reply), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await askClaude(teacher);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('model');
    expect(body).not.toHaveProperty('persona');
  });

  it('the chat sends the chosen model and the persona when they are set', async () => {
    ls.setItem(TUTOR_KEY, JSON.stringify({ name: 'むぎ', sttLang: 'ja-JP', chatModel: 'claude-opus-5-5', persona: '冷靜的老師' }));
    const fetchMock = vi.fn(async () => new Response(sse(reply), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await askClaude(teacher);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.persona).toBe('冷靜的老師');
  });

  it('the 小提醒 rewrite, the judge and the 速查 send the helper model', async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(
      JSON.stringify(url.includes('fix-tip') ? { ok: true, tip: '要說 <ja>行きましょう</ja>' } : url.includes('judge') ? { ok: true, feedback: '好' } : { ok: true, answer: null, raw: '' }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    await reviseTip('<ja>行きましょう</ja>', 10_000, 'claude-sonnet-5-5');
    await judgeSaid('学校に行きました', '学校へ行きました', 'claude-opus-5-5');
    await askLookup('去學校', undefined, 'claude-sonnet-5-5');
    const sent = fetchMock.mock.calls.map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)) as { model?: string });
    expect(sent.map((b) => b.model)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
  });

  it('without a helper model the helper bodies carry none (the server default applies)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, feedback: '好' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await judgeSaid('学校に行きました', '学校へ行きました');
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('model');
  });

  it('the status read keeps the default personality text of each role', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, model: 'claude-haiku-5-5', personas: { Mugi: '元氣' } }), { status: 200 })));
    expect(await claudeStatus()).toEqual({ ok: true, model: 'claude-haiku-5-5', personas: { Mugi: '元氣' } });
  });
});

// These route tests do not test Windows DPAPI. Auth/credential suites cover it with their own fixtures.
vi.mock('../../../server/openai/credentials.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../server/openai/credentials.ts')>();
  return { ...actual, defaultProtector: () => null,
    openCredentialStore: () => ({ data: { v: 1, hostId: 'route-test-only', account: null }, save() {} }),
  };
});
