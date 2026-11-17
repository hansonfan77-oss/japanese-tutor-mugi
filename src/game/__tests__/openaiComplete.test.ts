// Sign-in on this PC only (server/openai/routes.ts): POST /login and POST /logout answer 403 to a request from a phone (a Tailscale
// name, or any host that is not this PC's 127.0.0.1 / localhost); POST /complete-login is no longer a route; the callback
// (GET /auth/callback) runs the shared completion (completeSignIn → service.finishLogin) and is local only. All offline: a fake
// OAuth client and a memory store.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { SCOPES, type OAuth } from '../../../server/openai/oauth.ts';
import { createChatGpt, type ChatGptService } from '../../../server/openai/service.ts';
import type { CredentialStore, CredentialsData } from '../../../server/openai/credentials.ts';
import {
  LOCAL_ONLY_MESSAGE, callbackQuery, completeSignIn, handleAuthCallback, handleOpenAiApi,
} from '../../../server/openai/routes.ts';

function fakeReq(url: string, method: string, headers: Record<string, string>, body?: unknown): IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  Object.assign(req, { url, method, headers: { 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  return req;
}

function fakeRes() {
  const out = { status: 0, headers: {} as Record<string, string>, body: '' };
  const res = {
    writeHead(status: number, h?: Record<string, string>) { out.status = status; Object.assign(out.headers, h ?? {}); return res; },
    end(d?: string) { out.body = d ?? ''; return res; },
  };
  return { res: res as unknown as ServerResponse, out };
}

function memoryStore(): CredentialStore & { data: CredentialsData } {
  return { data: { v: 1, hostId: 'urn:uuid:test-host', account: null }, save: vi.fn() };
}

/** a fake OAuth client: the consent URL carries the state; the exchange and the identity are fixed */
function fakeOAuth(): OAuth {
  return {
    authorization: async (tx: { state: string; redirectUri: string }) => {
      const u = new URL('https://auth.example/authorize');
      u.searchParams.set('state', tx.state);
      u.searchParams.set('redirect_uri', tx.redirectUri);
      return u.toString();
    },
    exchange: async () => ({ access_token: 'AT-1', refresh_token: 'RT-1', id_token: 'IDT', expires_in: 3600, scope: SCOPES }),
    verify: async () => ({ sub: 'user_1', email: 'me@example.com' }),
    refresh: async () => ({}),
    revoke: async () => true,
  } as unknown as OAuth;
}

const stateOf = (url: string) => new URL(url).searchParams.get('state') ?? '';

describe('callbackQuery', () => {
  it('reads the four parameters the callback reads, and nothing else', () => {
    const q = callbackQuery(new URLSearchParams('state=a&code=b&client_id=c&error=d&extra=e'));
    expect(q).toEqual({ state: 'a', code: 'b', client_id: 'c', error: 'd' });
  });
});

describe('the callback and the shared completion', () => {
  it('the callback runs completeSignIn (service.finishLogin) with its query, and answers 303 home', async () => {
    const finishLogin = vi.fn(async () => {});
    const service = { finishLogin } as unknown as ChatGptService;
    await completeSignIn(service, { state: 's', code: 'c' });
    const cb = fakeRes();
    await handleAuthCallback(fakeReq('/auth/callback?state=s2&code=c2', 'GET', { host: '127.0.0.1:3004' }), cb.res, service);
    expect(finishLogin).toHaveBeenNthCalledWith(1, { state: 's', code: 'c' });
    expect(finishLogin).toHaveBeenNthCalledWith(2, { state: 's2', code: 'c2', client_id: undefined, error: undefined });
    expect(cb.out.status).toBe(303);
    expect(cb.out.headers.Location).toBe('/?chatgpt=ok');
  });

  it('a real sign-in finished by the callback on this PC signs the account in; the status seen from a phone hides the e-mail', async () => {
    const service = createChatGpt({ store: memoryStore(), oauth: fakeOAuth(), fetcher: async () => Response.json({ models: [] }), now: () => 1_000_000 });
    const url = await service.beginLogin('http://127.0.0.1:3004/auth/callback');
    const cb = fakeRes();
    await handleAuthCallback(fakeReq(`/auth/callback?state=${stateOf(url)}&code=OK&client_id=client_real`, 'GET', { host: '127.0.0.1:3004' }), cb.res, service);
    expect(cb.out.status).toBe(303);
    const remote = await service.status(false);
    expect(remote.signedIn).toBe(true);
    expect(JSON.stringify(remote)).not.toContain('me@example.com');
  });
});

describe('sign-in and sign-out are on the PC only', () => {
  it('login from the PC returns the consent URL with the redirect to this PC, and no paste flag', async () => {
    const service = createChatGpt({ store: memoryStore(), oauth: fakeOAuth() });
    const r = fakeRes();
    await handleOpenAiApi(fakeReq('/login', 'POST', { host: '127.0.0.1:3010' }, {}), r.res, service);
    expect(r.out.status).toBe(200);
    expect(JSON.parse(r.out.body)).not.toHaveProperty('paste');
    expect(new URL(JSON.parse(r.out.body).url).searchParams.get('redirect_uri')).toBe('http://127.0.0.1:3010/auth/callback');
  });

  it('login from a Tailscale name is refused (403) and no sign-in is started', async () => {
    const beginLogin = vi.fn(async () => 'https://auth.example/authorize');
    const r = fakeRes();
    const handled = await handleOpenAiApi(fakeReq('/login', 'POST', { host: 'mypc.tailnet.ts.net' }, {}), r.res, { beginLogin } as unknown as ChatGptService);
    expect(handled).toBe(true);
    expect(r.out.status).toBe(403);
    expect(JSON.parse(r.out.body)).toEqual({ error: 'forbidden', message: LOCAL_ONLY_MESSAGE });
    expect(beginLogin).not.toHaveBeenCalled();
  });

  it('sign-out from a Tailscale name is refused (403) and nothing is signed out', async () => {
    const logout = vi.fn(async () => ({ ok: true as const }));
    const r = fakeRes();
    await handleOpenAiApi(fakeReq('/logout', 'POST', { host: 'mypc.tailnet.ts.net' }, {}), r.res, { logout } as unknown as ChatGptService);
    expect(r.out.status).toBe(403);
    expect(JSON.parse(r.out.body)).toEqual({ error: 'forbidden', message: LOCAL_ONLY_MESSAGE });
    expect(logout).not.toHaveBeenCalled();
  });

  it('sign-out from the PC clears the account', async () => {
    const logout = vi.fn(async () => ({ ok: true as const }));
    const r = fakeRes();
    await handleOpenAiApi(fakeReq('/logout', 'POST', { host: 'localhost:3004' }, {}), r.res, { logout } as unknown as ChatGptService);
    expect(r.out.status).toBe(200);
    expect(logout).toHaveBeenCalled();
  });

  it('POST /complete-login is gone: not handled even from the PC, and nothing is completed', async () => {
    const finishLogin = vi.fn(async () => {});
    const r = fakeRes();
    const handled = await handleOpenAiApi(fakeReq('/complete-login', 'POST', { host: '127.0.0.1:3004' },
      { redirectUrl: 'http://127.0.0.1:3004/auth/callback?state=ST1&code=CODE1' }), r.res, { finishLogin } as unknown as ChatGptService);
    expect(handled).toBe(false);
    expect(r.out.status).toBe(0);
    expect(finishLogin).not.toHaveBeenCalled();
  });
});
