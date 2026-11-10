// The ChatGPT sign-in, all offline: the OAuth requests (PKCE, the authorization URL, the id_token check with a local key set),
// the service over a fake store and a fake fetch (the whole sign-in, the status with and without the e-mail, the models, the
// Responses call's headers, sign-out), and the routes (local only, the callback's state rule).
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { AGENT_NAME, DYNAMIC_CLIENT, ISSUER, RESOURCE, SCOPES, createOAuth, createTransaction, verifyIdentity } from '../../../server/openai/oauth.ts';
import { describeOpenAIError } from '../../../server/llm/openaiProvider.ts';
import { PENDING_MAX, allowedModel, createChatGpt } from '../../../server/openai/service.ts';
import type { Account, CredentialsData, CredentialStore } from '../../../server/openai/credentials.ts';
import { LOCAL_ONLY_MESSAGE, handleAuthCallback, handleOpenAiApi, isLocalRequest, localPort, redirectUriFor } from '../../../server/openai/routes.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

const CALLBACK = 'http://127.0.0.1:3004/auth/callback';

// ---------------------------------------------------------------- helpers

/** a fake fetch: the discovery document, the token endpoint, revocation and the ChatGPT API (models, responses) */
function fakeFetch(opts: { tokens?: Record<string, unknown>; tokenStatus?: number; models?: unknown[]; responses?: (init: RequestInit) => Response } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        jwks_uri: `${ISSUER}/.well-known/jwks.json`,
        revocation_endpoint: `${ISSUER}/oauth/revoke`,
      });
    }
    if (url === `${ISSUER}/oauth/token`) {
      if (opts.tokenStatus && opts.tokenStatus !== 200) return Response.json({ error: 'invalid_grant' }, { status: opts.tokenStatus });
      return Response.json(opts.tokens ?? {});
    }
    if (url === `${ISSUER}/oauth/revoke`) return new Response('', { status: 200 });
    if (url === `${RESOURCE}/models`) return Response.json({ models: opts.models ?? [] });
    if (url === `${RESOURCE}/responses`) return opts.responses ? opts.responses(init ?? {}) : new Response('', { status: 500 });
    return new Response('not found', { status: 404 });
  });
  return { fn, calls };
}

/** a key set and a signer for id_tokens (RS256, kid k1) */
async function identityKeys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  return {
    keys: createLocalJWKSet({ keys: [jwk] }),
    sign: (claims: Record<string, unknown>, aud: string) => new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER).setAudience(aud).setSubject('user_1').setIssuedAt().setExpirationTime('5m')
      .sign(privateKey),
  };
}

/** an in-memory credential store with the same shape as the real one */
function memoryStore(account: Account | null = null): CredentialStore & { data: CredentialsData } {
  return { data: { v: 1, hostId: 'urn:uuid:test-host', account }, save: vi.fn() };
}

const PLAN_TOKENS = { access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600, scope: SCOPES };

/** the parameters of an authorization URL */
const paramsOf = (url: string) => new URL(url).searchParams;

/** a server-sent events response of the given JSON events */
function sseResponse(events: unknown[]): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** a fake ServerResponse that keeps what is written */
function fakeRes() {
  const out = { status: 0, headers: {} as Record<string, unknown>, body: '', ended: false, headersSent: false, writableEnded: false };
  const res = {
    get headersSent() { return out.headersSent; },
    get writableEnded() { return out.writableEnded; },
    writeHead(status: number, headers?: Record<string, unknown>) { out.status = status; out.headers = headers ?? {}; out.headersSent = true; return res; },
    end(body?: string) { out.body = body ?? ''; out.ended = true; out.writableEnded = true; return res; },
  };
  return { res: res as unknown as ServerResponse, out };
}

// the requests come over a loopback socket (this PC) unless a test gives another address (a LAN device)
const fakeReq = (url: string, method: string, headers: Record<string, string>, remote = '127.0.0.1'): IncomingMessage =>
  ({ url, method, headers, socket: { remoteAddress: remote } } as unknown as IncomingMessage);
const lp = (headers: Record<string, string>) => localPort({ headers, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage);
const isLocal = (headers: Record<string, string>) => isLocalRequest({ headers, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage);

// ---------------------------------------------------------------- PKCE and the authorization URL

describe('PKCE transaction', () => {
  it('the challenge is the S256 hash of the verifier; each sign-in has its own state and nonce; it expires after 10 minutes', () => {
    const tx = createTransaction(undefined, CALLBACK, 1000);
    expect(tx.challenge).toBe(createHash('sha256').update(tx.verifier).digest('base64url'));
    expect(tx.verifier.length).toBeGreaterThanOrEqual(43);
    expect(createTransaction(undefined, CALLBACK).state).not.toBe(tx.state);
    expect(tx.expiresAt).toBe(1000 + 600_000);
  });
});

describe('authorization URL', () => {
  it('a first sign-in registers through the dynamic client, with the agent name, resource, scopes and PKCE', async () => {
    const oauth = createOAuth(fakeFetch().fn);
    const tx = createTransaction(undefined, CALLBACK);
    const url = await oauth.authorization(tx, 'urn:uuid:host', null);
    const p = paramsOf(url);
    expect(url.startsWith(`${ISSUER}/oauth/authorize?`)).toBe(true);
    expect(p.get('client_id')).toBe(DYNAMIC_CLIENT);
    expect(p.get('agent_name_hint')).toBe(AGENT_NAME);
    expect(AGENT_NAME).toBe('Mugi Tutor Local');
    expect(p.get('resource')).toBe(RESOURCE);
    expect(p.get('scope')).toBe(SCOPES);
    expect(SCOPES.split(' ')).toContain('chatgpt.tokens.use.direct');
    expect(p.get('redirect_uri')).toBe(CALLBACK);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('state')).toBe(tx.state);
    expect(p.get('nonce')).toBe(tx.nonce);
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toBe(tx.challenge);
    expect(p.get('ext_agent_host_id')).toBe('urn:uuid:host');
  });

  it('a signed-in account: its client id, the id token as a hint and the e-mail as a login hint', async () => {
    const oauth = createOAuth(fakeFetch().fn);
    const tx = createTransaction('client_1', CALLBACK);
    const p = paramsOf(await oauth.authorization(tx, 'urn:uuid:host', { client_id: 'client_1', id_token: 'IDT', email: 'a@example.com' }));
    expect(p.get('client_id')).toBe('client_1');
    expect(p.get('id_token_hint')).toBe('IDT');
    expect(p.get('login_hint')).toBe('a@example.com');
    expect(p.has('agent_name_hint')).toBe(false);
  });

  it('discovery from a foreign issuer is refused', async () => {
    const bad = vi.fn(async () => Response.json({ issuer: 'https://evil.example', authorization_endpoint: `${ISSUER}/x`, token_endpoint: `${ISSUER}/y`, jwks_uri: `${ISSUER}/z` }));
    await expect(createOAuth(bad).authorization(createTransaction(undefined, CALLBACK), 'h', null)).rejects.toThrow('issuer 不符');
  });
});

// ---------------------------------------------------------------- the id_token

describe('verifyIdentity (the id_token)', () => {
  it('accepts a token with this client as audience and this sign-in\'s nonce', async () => {
    const k = await identityKeys();
    const token = await k.sign({ nonce: 'n-1', email: 'a@example.com' }, 'client_1');
    const payload = await verifyIdentity(token, 'client_1', 'n-1', k.keys);
    expect(payload.sub).toBe('user_1');
    expect(payload.email).toBe('a@example.com');
  });

  it('refuses a wrong nonce', async () => {
    const k = await identityKeys();
    const token = await k.sign({ nonce: 'other' }, 'client_1');
    await expect(verifyIdentity(token, 'client_1', 'n-1', k.keys)).rejects.toThrow('登入身分驗證失敗');
  });

  it('refuses a token for another client (wrong audience)', async () => {
    const k = await identityKeys();
    const token = await k.sign({ nonce: 'n-1' }, 'client_2');
    await expect(verifyIdentity(token, 'client_1', 'n-1', k.keys)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------- the service: sign-in, status, models, calls, sign-out

describe('ChatGPT service', () => {
  it('a whole sign-in: the callback saves the account, the status shows it, and the e-mail is only for the PC', async () => {
    const k = await identityKeys();
    const f = fakeFetch({ tokens: { ...PLAN_TOKENS, id_token: '' } });
    const store = memoryStore();
    const oauth = createOAuth(f.fn, { keys: k.keys });
    const service = createChatGpt({ store, oauth, fetcher: f.fn, now: () => 1_000_000 });

    const url = await service.beginLogin(CALLBACK);
    const p = paramsOf(url);
    expect(p.get('client_id')).toBe(DYNAMIC_CLIENT);
    // the token endpoint hands back an id_token for this sign-in's nonce, issued to the client the callback names
    f.fn.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const u = String(input);
      if (u === `${ISSUER}/oauth/token`) {
        const id_token = await k.sign({ nonce: p.get('nonce'), email: 'me@example.com', name: 'Me' }, 'client_real');
        return Response.json({ ...PLAN_TOKENS, id_token });
      }
      return fakeFetch().fn(input, init);
    });
    await service.finishLogin({ state: p.get('state') ?? undefined, code: 'auth-code', client_id: 'client_real' });

    expect(store.data.account).toMatchObject({ client_id: 'client_real', subject: 'user_1', email: 'me@example.com', access_token: 'AT-1', refresh_token: 'RT-1' });
    expect(store.data.account?.scopes).toContain('chatgpt.tokens.use.direct');
    expect(service.ready()).toBe(true);
    expect(store.save).toHaveBeenCalled();

    const pc = await service.status(true);
    expect(pc).toMatchObject({ signedIn: true, planEnabled: true, email: 'me@example.com' });
    const remote = await service.status(false);
    expect(remote).toEqual({ signedIn: true, planEnabled: true, models: [], modelStatus: 'empty' });
    expect(JSON.stringify(remote)).not.toContain('me@example.com');
    expect(JSON.stringify(remote)).not.toContain('client_real');

    // the state is single use
    await expect(service.finishLogin({ state: p.get('state') ?? undefined, code: 'x', client_id: 'client_real' })).rejects.toThrow('登入狀態不符');
  });

  it('the callback refuses an unknown state, a missing code and the dynamic client id', async () => {
    const f = fakeFetch();
    const service = createChatGpt({ store: memoryStore(), oauth: createOAuth(f.fn), fetcher: f.fn });
    await expect(service.finishLogin({ state: 'nope', code: 'c', client_id: 'x' })).rejects.toThrow('登入狀態不符');
    const p = paramsOf(await service.beginLogin(CALLBACK));
    await expect(service.finishLogin({ state: p.get('state') ?? undefined, code: 'c', client_id: DYNAMIC_CLIENT })).rejects.toThrow('client ID');
    const q = paramsOf(await service.beginLogin(CALLBACK));
    await expect(service.finishLogin({ state: q.get('state') ?? undefined, client_id: 'client_1' })).rejects.toThrow('缺少登入授權碼');
  });

  it('a sign-in that the player cancelled at OpenAI says so', async () => {
    const f = fakeFetch();
    const service = createChatGpt({ store: memoryStore(), oauth: createOAuth(f.fn), fetcher: f.fn });
    const p = paramsOf(await service.beginLogin(CALLBACK));
    await expect(service.finishLogin({ state: p.get('state') ?? undefined, error: 'access_denied' })).rejects.toThrow('已取消');
  });

  it('the pending sign-ins are capped', async () => {
    const f = fakeFetch();
    const service = createChatGpt({ store: memoryStore(), oauth: createOAuth(f.fn), fetcher: f.fn });
    const first = paramsOf(await service.beginLogin(CALLBACK)).get('state') ?? undefined;
    for (let i = 0; i < PENDING_MAX; i++) await service.beginLogin(CALLBACK);
    await expect(service.finishLogin({ state: first, code: 'c', client_id: 'client_1' })).rejects.toThrow('登入狀態不符');
  });

  it('the catalog preserves visible compatible models in server order without generation limits; it is cached', async () => {
    const models = [
      { slug: 'gpt-5.4', display_name: 'GPT 5.4', visibility: 'list' },
      { slug: 'gpt-5.5-sol', display_name: 'GPT 5.5 Sol', visibility: 'list' },
      { slug: 'gpt-6', display_name: 'GPT 6', visibility: 'list' },
      { slug: 'gpt-5-mini', display_name: 'hidden', visibility: 'hide' },
      { slug: 'o3', display_name: 'o3', visibility: 'list' },
    ];
    const f = fakeFetch({ models });
    const store = memoryStore({ client_id: 'c', subject: 's', email: '', name: '', access_token: 'AT', refresh_token: 'RT', scopes: [SCOPES.split(' ')].flat(), expiresAt: Date.now() + 3_600_000 });
    const service = createChatGpt({ store, oauth: createOAuth(f.fn), fetcher: f.fn });
    expect(await service.models()).toEqual([
      { slug: 'gpt-5.4', label: 'GPT 5.4' },
      { slug: 'gpt-5.5-sol', label: 'GPT 5.5 Sol' },
      { slug: 'gpt-6', label: 'GPT 6' },
      { slug: 'o3', label: 'o3' },
    ]);
    await service.models();
    expect(f.calls.filter((c) => c.url === `${RESOURCE}/models`)).toHaveLength(1);
    expect(allowedModel('gpt-5.4')).toBe(true);
    expect(allowedModel('gpt-6')).toBe(true);
    expect(allowedModel('o3')).toBe(true);
  });

  it('a Responses call carries the account token and goes to the plan endpoint', async () => {
    const f = fakeFetch({ responses: () => sseResponse([{ type: 'response.completed', response: { model: 'gpt-5.4', status: 'completed' } }]) });
    const store = memoryStore({ client_id: 'c', subject: 's', email: '', name: '', access_token: 'AT-SECRET', refresh_token: 'RT', scopes: [PLAN_SCOPE_FOR_TEST], expiresAt: Date.now() + 3_600_000 });
    const service = createChatGpt({ store, oauth: createOAuth(f.fn), fetcher: f.fn });
    const response = await service.provider().complete({ model: 'gpt-5.4', max_tokens: 10, system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(response.model).toBe('gpt-5.4');
    const wire = JSON.parse(String(f.calls.find((c) => c.url === `${RESOURCE}/responses`)?.init?.body));
    expect(wire).toEqual({ model: 'gpt-5.4', instructions: 's', input: [{ role: 'user', content: 'hi' }], store: false, stream: true });
    const call = f.calls.find((c) => c.url === `${RESOURCE}/responses`);
    expect((call?.init?.headers as Record<string, string>).Authorization).toBe('Bearer AT-SECRET');
  });

  it('an expired token is refreshed once, and the new one is saved', async () => {
    const f = fakeFetch({ tokens: { access_token: 'AT-NEW', expires_in: 3600, scope: SCOPES } });
    const store = memoryStore({ client_id: 'c', subject: 's', email: '', name: '', access_token: 'AT-OLD', refresh_token: 'RT', scopes: [PLAN_SCOPE_FOR_TEST], expiresAt: 0 });
    const service = createChatGpt({ store, oauth: createOAuth(f.fn), fetcher: f.fn });
    f.fn.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const u = String(input);
      if (u === `${RESOURCE}/models`) return Response.json({ models: [] });
      return fakeFetch({ tokens: { access_token: 'AT-NEW', expires_in: 3600, scope: SCOPES } }).fn(input, init);
    });
    await service.models();
    expect(store.data.account?.access_token).toBe('AT-NEW');
    expect(f.fn.mock.calls.filter(([u]) => String(u) === `${ISSUER}/oauth/token`)).toHaveLength(1);
  });

  it('sign-out revokes, then forgets the account and its tokens', async () => {
    const f = fakeFetch();
    const store = memoryStore({ client_id: 'c', subject: 's', email: 'a@b.c', name: '', access_token: 'AT', refresh_token: 'RT', scopes: [PLAN_SCOPE_FOR_TEST], expiresAt: 0 });
    const service = createChatGpt({ store, oauth: createOAuth(f.fn), fetcher: f.fn });
    expect(await service.logout()).toEqual({ ok: true });
    expect(store.data.account).toBeNull();
    expect(store.save).toHaveBeenCalled();
    expect(service.ready()).toBe(false);
    expect(f.calls.some((c) => c.url === `${ISSUER}/oauth/revoke`)).toBe(true);
  });

  it('the model list is kept out of the status when the plan permission is missing', async () => {
    const store = memoryStore({ client_id: 'c', subject: 's', email: '', name: '', access_token: 'AT', scopes: ['openid'], expiresAt: 0 });
    const f = fakeFetch();
    const service = createChatGpt({ store, oauth: createOAuth(f.fn), fetcher: f.fn });
    expect(await service.status(true)).toEqual({ signedIn: true, planEnabled: false, email: undefined, models: [] });
    expect(service.ready()).toBe(false);
  });
});

const PLAN_SCOPE_FOR_TEST = 'chatgpt.tokens.use.direct';

// ---------------------------------------------------------------- routes: local only

describe('local only', () => {
  it('a local Host (127.0.0.1 or localhost with a port) and no proxy header is local', () => {
    expect(lp({ host: '127.0.0.1:3004' })).toBe(3004);
    expect(lp({ host: 'localhost:3004' })).toBe(3004);
    expect(isLocal({ host: 'localhost:3004' })).toBe(true);
    expect(redirectUriFor(3004)).toBe(CALLBACK);
  });

  it('other hosts, a host without a port, and IPv6 are not local', () => {
    for (const host of ['example.com:3004', '127.0.0.1', '[::1]:3004', '192.168.1.5:3004', 'mypc.tailnet.ts.net:3004']) {
      expect(lp({ host })).toBeNull();
    }
    expect(lp({})).toBeNull();
  });

  it('a request through a proxy is not local, even with a local Host', () => {
    for (const h of ['tailscale-user-login', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']) {
      expect(lp({ host: '127.0.0.1:3004', [h]: 'x' })).toBeNull();
    }
  });

  it('the status hides the e-mail from a request that is not local (the service decides, the route passes the flag)', async () => {
    const store = memoryStore({ client_id: 'c', subject: 's', email: 'me@x.y', name: '', access_token: 'AT', scopes: [PLAN_SCOPE_FOR_TEST], expiresAt: 0 });
    const f = fakeFetch({ models: [] });
    const service = createChatGpt({ store, oauth: createOAuth(f.fn), fetcher: f.fn });
    const local = fakeRes();
    await handleOpenAiApi(fakeReq('/status', 'GET', { host: '127.0.0.1:3004' }), local.res, service);
    expect(JSON.parse(local.out.body)).toMatchObject({ signedIn: true, email: 'me@x.y' });
    const remote = fakeRes();
    await handleOpenAiApi(fakeReq('/status', 'GET', { host: '127.0.0.1:3004', 'x-forwarded-for': '100.1.1.1' }), remote.res, service);
    expect(JSON.parse(remote.out.body)).not.toHaveProperty('email');
  });

  it('a LAN device that sends Host 127.0.0.1 is not local: no e-mail in the status, and no login or logout', async () => {
    const store = memoryStore({ client_id: 'c', subject: 's', email: 'me@x.y', name: '', access_token: 'AT', refresh_token: 'RT', scopes: [PLAN_SCOPE_FOR_TEST], expiresAt: 0 });
    const f = fakeFetch({ models: [] });
    const service = createChatGpt({ store, oauth: createOAuth(f.fn), fetcher: f.fn });
    const lan = fakeRes();
    await handleOpenAiApi(fakeReq('/status', 'GET', { host: '127.0.0.1:3004' }, '192.168.1.50'), lan.res, service);
    expect(JSON.parse(lan.out.body)).not.toHaveProperty('email');
    for (const path of ['/login', '/logout']) {
      const r = fakeRes();
      expect(await handleOpenAiApi(fakeReq(path, 'POST', { host: '127.0.0.1:3004' }, '192.168.1.50'), r.res, service)).toBe(true);
      expect(r.out.status).toBe(403);
      expect(r.out.body).toContain(LOCAL_ONLY_MESSAGE);
    }
    expect(store.data.account).not.toBeNull();
    const cb = fakeRes();
    await handleAuthCallback(fakeReq('/?state=x&code=y', 'GET', { host: '127.0.0.1:3004' }, '192.168.1.50'), cb.res, service);
    expect(cb.out.status).toBe(403);
  });

  it('login and logout are refused from another host', async () => {
    const service = createChatGpt({ store: memoryStore(), oauth: createOAuth(fakeFetch().fn), fetcher: fakeFetch().fn });
    for (const path of ['/login', '/logout']) {
      const r = fakeRes();
      expect(await handleOpenAiApi(fakeReq(path, 'POST', { host: 'mypc.tailnet.ts.net:3004' }), r.res, service)).toBe(true);
      expect(r.out.status).toBe(403);
      expect(r.out.body).toContain(LOCAL_ONLY_MESSAGE);
    }
  });

  it('login from the PC returns the consent URL with the redirect to this PC; the body never names a token or the client', async () => {
    const service = createChatGpt({ store: memoryStore(), oauth: createOAuth(fakeFetch().fn), fetcher: fakeFetch().fn });
    const r = fakeRes();
    await handleOpenAiApi(fakeReq('/login', 'POST', { host: 'localhost:3010' }), r.res, service);
    expect(r.out.status).toBe(200);
    const url = (JSON.parse(r.out.body) as { url: string }).url;
    expect(paramsOf(url).get('redirect_uri')).toBe('http://127.0.0.1:3010/auth/callback');
  });

  it('the callback page refuses a request that is not local, and an unknown state, with a message and no token', async () => {
    const service = createChatGpt({ store: memoryStore(), oauth: createOAuth(fakeFetch().fn), fetcher: fakeFetch().fn });
    const remote = fakeRes();
    await handleAuthCallback(fakeReq('/?state=x&code=y', 'GET', { host: 'mypc.tailnet.ts.net:3004' }), remote.res, service);
    expect(remote.out.status).toBe(403);
    const bad = fakeRes();
    await handleAuthCallback(fakeReq('/?state=x&code=SECRETCODE', 'GET', { host: '127.0.0.1:3004' }), bad.res, service);
    expect(bad.out.status).toBe(400);
    expect(bad.out.body).toContain('登入狀態不符');
    expect(bad.out.body).not.toContain('SECRETCODE');
  });

  it('logout from the PC clears the account', async () => {
    const store = memoryStore({ client_id: 'c', subject: 's', email: '', name: '', access_token: 'AT', refresh_token: 'RT', scopes: [PLAN_SCOPE_FOR_TEST], expiresAt: 0 });
    const service = createChatGpt({ store, oauth: createOAuth(fakeFetch().fn), fetcher: fakeFetch().fn });
    const r = fakeRes();
    await handleOpenAiApi(fakeReq('/logout', 'POST', { host: '127.0.0.1:3004' }), r.res, service);
    expect(JSON.parse(r.out.body)).toMatchObject({ ok: true });
    expect(store.data.account).toBeNull();
  });
});

// Catalog failures remain distinguishable and never serialize upstream diagnostic text.
describe('T1 catalog and HTTP errors (fake fetch only)', () => {
  const account = (): Account => ({ client_id: 'CLIENT-SECRET', subject: 'SUBJECT-SECRET', email: 'private@example.invalid', name: '',
    access_token: 'AT-SECRET', refresh_token: 'RT-SECRET', id_token: 'ID-SECRET', scopes: [PLAN_SCOPE_FOR_TEST], expiresAt: Date.now() + 3_600_000 });

  it.each([
    [[], 'empty'],
    [[{ slug: 'gpt-image-1', visibility: 'list' }], 'incompatible'],
    [[{ slug: 'gpt-6.1-example', display_name: 'Visible model', visibility: 'list' }], 'ready'],
    [[{ slug: 'future-text-model', visibility: 'list' }], 'ready'],
  ] as const)('distinguishes catalog %j as %s', async (models, modelStatus) => {
    const f = fakeFetch({ models: [...models] });
    const service = createChatGpt({ store: memoryStore(account()), oauth: createOAuth(f.fn), fetcher: f.fn });
    const status = await service.status(false);
    expect(status.modelStatus).toBe(modelStatus);
    if (modelStatus === 'ready') expect(status.models).toHaveLength(1);
    else expect(status.models).toEqual([]);
  });

  it.each(['network', 'http', 'json', 'shape', 'entry'])('reports %s failure safely through the status endpoint and can recover', async (failure) => {
    const store = memoryStore(account());
    const fetcher = vi.fn(async () => {
      if (failure === 'network') throw new Error('中文秘密 AT-SECRET RT-SECRET');
      if (failure === 'http') return Response.json({ error: { code: 'AT-SECRET', message: 'RT-SECRET' } }, { status: 503 });
      if (failure === 'json') return new Response('invalid JSON AT-SECRET');
      if (failure === 'entry') return Response.json({ models: [null, { visibility: 'list' }] });
      return Response.json({ data: [] });
    });
    const service = createChatGpt({ store, oauth: createOAuth(fetcher), fetcher });
    const out = fakeRes();
    await handleOpenAiApi(fakeReq('/status', 'GET', { host: '127.0.0.1:3004', 'x-forwarded-for': '192.0.2.1' }), out.res, service);
    expect(out.out.status).toBe(200);
    expect(JSON.parse(out.out.body)).toEqual({ signedIn: true, planEnabled: true, models: [], modelStatus: 'error' });
    expect(out.out.body).not.toMatch(/SECRET|private@example/);
    expect(store.data.account).toMatchObject({ access_token: 'AT-SECRET', refresh_token: 'RT-SECRET' });
    expect(store.save).not.toHaveBeenCalled();
    fetcher.mockImplementation(async () => Response.json({ models: [] }));
    expect((await service.status(false)).modelStatus).toBe('empty');
  });

  it('does not request a catalog before sign-in or plan authorization', async () => {
    const fetcher = vi.fn(async () => { throw new Error('must not fetch'); });
    const store = memoryStore();
    const service = createChatGpt({ store, oauth: createOAuth(fetcher), fetcher });
    expect(await service.status(false)).toEqual({ signedIn: false, planEnabled: false, models: [] });
    store.data.account = { ...account(), scopes: ['openid'] };
    expect(await service.status(false)).toEqual({ signedIn: true, planEnabled: false, models: [] });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['subscription_sharing_usage_limit_exceeded', 429, '方案使用已達限制'],
    ['subscription_sharing_usage_unavailable', 503, '暫時無法確認'],
  ])('preserves credentials and maps HTTP %s distinctly', async (code, status, message) => {
    const f = fakeFetch({ responses: () => Response.json({ error: { code, message: 'upstream private text' } }, { status }) });
    const store = memoryStore(account());
    const before = structuredClone(store.data);
    const service = createChatGpt({ store, oauth: createOAuth(f.fn), fetcher: f.fn });
    const error = await service.provider().complete({ model: 'gpt-6.1-example', max_tokens: 10, system: '', messages: [] }).catch(e => e);
    expect(error).toMatchObject({ code, status });
    expect(describeOpenAIError(error)).toMatchObject({ status, message: expect.stringContaining(message) });
    expect(store.data).toEqual(before);
    expect(store.save).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(1);
  });
});


it.each([401, 403, 503])('direct-admission HTTP %s with a detail body preserves credentials', async (status) => {
  const f = fakeFetch({ responses: () => Response.json({ detail: 'PRIVATE DETAIL' }, { status }) });
  const store = memoryStore({ client_id: 'c', subject: 's', email: '', name: '', access_token: 'FAKE', refresh_token: 'FAKE-RT',
    scopes: [PLAN_SCOPE_FOR_TEST], expiresAt: Date.now() + 3_600_000 });
  const service = createChatGpt({ store, oauth: createOAuth(f.fn), fetcher: f.fn });
  const error = await service.provider().complete({ model: 'catalog-model', max_tokens: 10, system: '', messages: [] }).catch(e => e);
  expect(error).toMatchObject({ status, code: 'request_failed' });
  expect(describeOpenAIError(error).message).not.toContain('PRIVATE DETAIL');
  expect(store.data.account?.access_token).toBe('FAKE');
  expect(store.save).not.toHaveBeenCalled();
});

it('a temporary token refresh failure keeps the fake credentials and reports a catalog error', async () => {
  const store = memoryStore({ client_id: 'c', subject: 's', email: '', name: '', access_token: 'FAKE', refresh_token: 'FAKE-RT',
    scopes: [PLAN_SCOPE_FOR_TEST], expiresAt: 0 });
  const f = fakeFetch();
  const oauth = createOAuth(f.fn);
  oauth.refresh = vi.fn(async () => { throw Object.assign(new Error('temporary'), { code: 'subscription_sharing_usage_unavailable', status: 503 }); });
  const service = createChatGpt({ store, oauth, fetcher: f.fn });
  expect(await service.status(false)).toMatchObject({ signedIn: true, planEnabled: true, modelStatus: 'error' });
  expect(store.data.account?.refresh_token).toBe('FAKE-RT');
  expect(store.save).not.toHaveBeenCalled();
  expect(f.fn).not.toHaveBeenCalled();
});
