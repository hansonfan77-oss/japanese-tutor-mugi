// @vitest-environment jsdom
// The AI service settings on the phone: the saved order and ChatGPT model (migrated from older saves), which services count as
// ready, and the status reader of the ChatGPT sign-in (no token, no client id is ever kept).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TUTOR, aiServicesOf, cleanOpenaiModel, migrateTutor, serviceReady } from '../tutor';
import { fetchChatGptStatus, resetChatGptStatusForTest, takeChatGptReturn } from '../openaiStatus';
import { OPENAI_MODEL_MAX_CHARS, parseProviderList } from '../claudeProtocol';

afterEach(() => {
  vi.unstubAllGlobals();
  resetChatGptStatusForTest();
});

describe('AI service settings', () => {
  it('the default is Claude alone, with no ChatGPT model chosen', () => {
    expect(DEFAULT_TUTOR.providers).toEqual(['anthropic']);
    expect(DEFAULT_TUTOR.openaiModel).toBe('');
  });

  it('an older save gets the defaults; a saved order and model are kept', () => {
    expect(migrateTutor({ name: 'x' })).toMatchObject({ providers: ['anthropic'], openaiModel: '' });
    expect(migrateTutor({ providers: ['openai', 'anthropic'], openaiModel: ' gpt-5.4 ' })).toMatchObject({ providers: ['openai', 'anthropic'], openaiModel: 'gpt-5.4' });
  });

  it('a broken list (unknown, repeated, too long, not a list) falls back to Claude alone', () => {
    for (const providers of ['openai', ['gemini'], ['openai', 'openai'], ['anthropic', 'openai', 'anthropic'], [], null]) {
      expect(migrateTutor({ providers })).toMatchObject({ providers: ['anthropic'] });
    }
    expect(parseProviderList(['anthropic', 'openai'])).toEqual(['anthropic', 'openai']);
  });

  it('the ChatGPT model is trimmed and capped; anything but text is empty', () => {
    expect(cleanOpenaiModel('  gpt-5.5-sol  ')).toBe('gpt-5.5-sol');
    expect(cleanOpenaiModel('x'.repeat(OPENAI_MODEL_MAX_CHARS + 5))).toHaveLength(OPENAI_MODEL_MAX_CHARS);
    expect(cleanOpenaiModel(3)).toBe('');
    expect(migrateTutor({ openaiModel: 42 }).openaiModel).toBe('');
  });

  it('the routing of a request is the order and the model', () => {
    expect(aiServicesOf({ ...DEFAULT_TUTOR, providers: ['openai', 'anthropic'], openaiModel: 'gpt-5.4' })).toEqual({
      providers: ['openai', 'anthropic'], openaiModel: 'gpt-5.4',
    });
    expect(aiServicesOf(DEFAULT_TUTOR)).toEqual({ providers: ['anthropic'] });
  });

  it('a service is ready when it has its key (Claude) or is signed in (ChatGPT); the list is ready when one of its services is', () => {
    expect(serviceReady(['anthropic'], { anthropic: false, openai: true })).toBe(false);
    expect(serviceReady(['openai'], { anthropic: true, openai: false })).toBe(false);
    expect(serviceReady(['openai', 'anthropic'], { anthropic: false, openai: true })).toBe(true);
    expect(serviceReady(['anthropic', 'openai'], { anthropic: true, openai: false })).toBe(true);
  });
});

describe('ChatGPT status on the phone', () => {
  it('keeps the signed-in flag, the plan flag, the e-mail and the models, and nothing else', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      signedIn: true, planEnabled: true, email: 'me@example.com', models: [{ slug: 'gpt-5.4', label: 'GPT 5.4' }], client_id: 'secret', access_token: 'secret',
    })));
    const s = await fetchChatGptStatus();
    expect(s).toEqual({ signedIn: true, planEnabled: true, email: 'me@example.com', models: [{ slug: 'gpt-5.4', label: 'GPT 5.4' }] });
    expect(JSON.stringify(s)).not.toContain('secret');
  });

  it('a status that cannot be read is null (the caller keeps what it had)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })));
    expect(await fetchChatGptStatus()).toBeNull();
  });

  it('the sign-in return marker is taken from the address bar', () => {
    window.history.replaceState(null, '', '/?chatgpt=ok&x=1');
    expect(takeChatGptReturn()).toBe(true);
    expect(window.location.search).toBe('?x=1');
    expect(takeChatGptReturn()).toBe(false);
    window.history.replaceState(null, '', '/');
  });
});


it.each(['ready', 'empty', 'incompatible', 'error'])('retains safe catalog state %s without upstream diagnostics', async (modelStatus) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ signedIn: true, planEnabled: true, models: [], modelStatus, error: 'SECRET' })));
  expect(await fetchChatGptStatus()).toEqual({ signedIn: true, planEnabled: true, models: [], modelStatus });
});
