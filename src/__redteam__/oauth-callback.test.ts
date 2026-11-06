// Red-team: the ChatGPT sign-in (server/openai/routes.ts, server/openai/service.ts). The OAuth provider and the store are fakes:
// no network, no real account file. A test named "[發現]" asserts the weakness as it is today.
import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { handleAuthCallback, handleOpenAiApi } from '../../server/openai/routes.ts';
import { createChatGpt, type ChatGptService } from '../../server/openai/service.ts';
import type { OAuth, Transaction } from '../../server/openai/oauth.ts';

// ---------------------------------------------------------------- fakes

type FakeAccount = { client_id: string; subject: string; email: string; name: string; scopes: string[]; expiresAt: number; [k: string]: unknown };
function fakeStore(account: FakeAccount | null = null) {
  return { data: { account, hostId: 'host-test' } as never, save() { /* memory only */ } };
}

/** a fake OAuth: records what the service asked, returns a fixed identity; tokens are test placeholders */
function fakeOAuth() {
  const seen: { exchanged: Array<{ code: string; clientId: string }>; verifiedAud: string[]; authorized: Transaction[] } = {
    exchanged: [], verifiedAud: [], authorized: [],
  };
  const oauth = {
    async authorization(tx: Transaction) { seen.authorized.push(tx); return `https://auth.example/authorize?state=${tx.state}`; },
    async exchange(code: string, clientId: string) {
      seen.exchanged.push({ code, clientId });
      return { access_token: 'test-access', refresh_token: 'test-refresh', id_token: 'test-id', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct' };
    },
    async verify(_idToken: string, clientId: string) { seen.verifiedAud.push(clientId); return { sub: 'user-1', email: 'u@example.test', name: 'U' }; },
    async revoke() { return true; },
    async refresh() { throw new Error('not used'); },
  } as unknown as OAuth;
  return { oauth, seen };
}

function service(opts: { account?: FakeAccount | null; now?: () => number } = {}) {
  const { oauth, seen } = fakeOAuth();
  const store = fakeStore(opts.account ?? null);
  const svc: ChatGptService = createChatGpt({ store: store as never, oauth, now: opts.now });
  return { svc, seen, store };
}

const stateOf = (seen: { authorized: Transaction[] }, i = seen.authorized.length - 1) => seen.authorized[i].state;

// ---------------------------------------------------------------- the state: single use, expiry, error, replay

describe('登入 state：一次性、會過期、錯誤也會用掉', () => {
  it('完整流程一次成功；同一個 state 第二次使用被拒絕（重放）', async () => {
    const { svc, seen } = service();
    await svc.beginLogin('http://127.0.0.1:3110/auth/callback');
    const state = stateOf(seen);
    await svc.finishLogin({ state, code: 'code-1', client_id: 'cid-1' });
    await expect(svc.finishLogin({ state, code: 'code-1', client_id: 'cid-1' })).rejects.toThrow('登入狀態不符');
    expect(seen.exchanged).toHaveLength(1);
  });

  it('缺少 state、未知 state、型別錯誤的 state 都拒絕，且不會呼叫 OAuth 交換', async () => {
    const { svc, seen } = service();
    await svc.beginLogin('http://127.0.0.1:3110/auth/callback');
    await expect(svc.finishLogin({ code: 'c' })).rejects.toThrow('登入狀態不符');
    await expect(svc.finishLogin({ state: 'nope', code: 'c' })).rejects.toThrow('登入狀態不符');
    await expect(svc.finishLogin({ state: '' as string, code: 'c' })).rejects.toThrow('登入狀態不符');
    expect(seen.exchanged).toHaveLength(0);
  });

  it('另一次登入的 state 不能拿來完成這一次（每次登入的 state 獨立）', async () => {
    const { svc, seen } = service();
    await svc.beginLogin('http://127.0.0.1:3110/auth/callback');
    await svc.beginLogin('http://127.0.0.1:3110/auth/callback');
    const first = stateOf(seen, 0);
    const second = stateOf(seen, 1);
    expect(first).not.toBe(second);
    await svc.finishLogin({ state: second, code: 'c2', client_id: 'cid-1' });
    await expect(svc.finishLogin({ state: first, code: 'c1', client_id: 'cid-1' })).resolves.toBeUndefined();
    expect(seen.exchanged.map((x) => x.code)).toEqual(['c2', 'c1']);
  });

  it('錯誤參數（error）也會用掉 state：之後再用同一個 state 也失敗', async () => {
    const { svc, seen } = service();
    await svc.beginLogin('http://127.0.0.1:3110/auth/callback');
    const state = stateOf(seen);
    await expect(svc.finishLogin({ state, error: 'access_denied' })).rejects.toThrow('已取消');
    await expect(svc.finishLogin({ state, code: 'c' })).rejects.toThrow('登入狀態不符');
  });

  it('逾時（超過 10 分鐘）的 state 被拒絕', async () => {
    let t = 1_000_000;
    const { svc, seen } = service({ now: () => t });
    await svc.beginLogin('http://127.0.0.1:3110/auth/callback');
    const state = stateOf(seen);
    t += 600_001;
    await expect(svc.finishLogin({ state, code: 'c' })).rejects.toThrow('登入逾時');
  });

  it('既有帳號時，回呼的 client_id 與登入時的不同：拒絕', async () => {
    const acct: FakeAccount = { client_id: 'real-client', subject: 'user-1', email: 'u@example.test', name: 'U', scopes: ['chatgpt.tokens.use.direct'], expiresAt: 0 };
    const { svc, seen } = service({ account: acct });
    await svc.beginLogin('http://127.0.0.1:3110/auth/callback');
    const state = stateOf(seen);
    await expect(svc.finishLogin({ state, code: 'c', client_id: 'other-client' })).rejects.toThrow('client ID');
    expect(seen.exchanged).toHaveLength(0);
  });

  it('[已修] 第一次登入（沒有既有帳號）：回呼的 client_id 只有在 id_token 的 aud 與它相符時才保存；aud 不符就不保存帳號', async () => {
    // the id_token names the client it was issued to (aud): the fake verifies that, as jose does in verifyIdentity
    const { oauth, seen } = fakeOAuth();
    const strict = {
      ...oauth,
      async verify(_idToken: string, clientId: string) {
        seen.verifiedAud.push(clientId);
        if (clientId !== 'aud-in-token') throw new Error('登入身分驗證失敗，請重新登入。');
        return { sub: 'user-1', email: 'u@example.test', name: 'U' };
      },
    } as unknown as OAuth;
    const store = fakeStore(null);
    const svc: ChatGptService = createChatGpt({ store: store as never, oauth: strict });
    await svc.beginLogin('http://127.0.0.1:3110/auth/callback');
    const bad = stateOf(seen);
    await expect(svc.finishLogin({ state: bad, code: 'c', client_id: 'client-from-the-url' })).rejects.toThrow();
    expect((store.data as { account: unknown }).account).toBeNull();
    await svc.beginLogin('http://127.0.0.1:3110/auth/callback');
    await svc.finishLogin({ state: stateOf(seen), code: 'c2', client_id: 'aud-in-token' });
    expect((store.data as { account: { client_id: string } }).account.client_id).toBe('aud-in-token');
  });
});

// ---------------------------------------------------------------- the callback page and the local-only routes

function fakeReq(url: string, method: string, headers: Record<string, string>): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage;
  Object.assign(req, { url, method, headers, socket: { remoteAddress: '127.0.0.1' } });
  return req;
}
function fakeRes() {
  const out = { status: 0, headers: {} as Record<string, string>, body: '' };
  const res = {
    writeHead(status: number, h?: Record<string, string>) { out.status = status; Object.assign(out.headers, h ?? {}); return res; },
    end(d?: string) { out.body = d ?? ''; return res; },
    get headersSent() { return false; },
  };
  return { res: res as unknown as ServerResponse, out };
}

describe('GET /auth/callback：只允許本機，錯誤頁面會跳脫 HTML', () => {
  it('不是本機的 Host、帶代理標頭：403（不進入登入流程）', async () => {
    const { svc, seen } = service();
    await svc.beginLogin('http://127.0.0.1:3110/auth/callback');
    const state = stateOf(seen);
    for (const headers of [{ host: 'evil.com' }, { host: '127.0.0.1:3110', 'x-forwarded-for': '1.2.3.4' }, { host: '127.0.0.1:3110', 'tailscale-user-login': 'me@x' }] as Record<string, string>[]) {
      const { res, out } = fakeRes();
      await handleAuthCallback(fakeReq(`/auth/callback?state=${state}&code=c`, 'GET', headers), res, svc);
      expect(out.status).toBe(403);
    }
    expect(seen.exchanged).toHaveLength(0);
  });

  it('本機的錯誤回呼：錯誤頁面只顯示我們的訊息；插入的 HTML 被跳脫', async () => {
    const fake = { finishLogin: async () => { throw new Error('登入失敗<img src=x onerror=alert(1)>'); } } as unknown as ChatGptService;
    const { res, out } = fakeRes();
    await handleAuthCallback(fakeReq('/auth/callback?error=%3Cscript%3E', 'GET', { host: '127.0.0.1:3110' }), res, fake);
    expect(out.status).toBe(400);
    expect(out.body).not.toContain('<img');
    expect(out.body).toContain('&lt;img');
  });

  it('非中文的錯誤訊息（例如 library 的英文訊息）會換成通用的中文', async () => {
    const fake = { finishLogin: async () => { throw new Error('<script>leak(token)</script>'); } } as unknown as ChatGptService;
    const { res, out } = fakeRes();
    await handleAuthCallback(fakeReq('/auth/callback?state=x', 'GET', { host: '127.0.0.1:3110' }), res, fake);
    expect(out.body).not.toContain('leak(token)');
    expect(out.body).toContain('登入驗證失敗');
  });

  it('成功：303 到 /?chatgpt=ok；沒有 token 出現在回應', async () => {
    const { svc, seen } = service();
    await svc.beginLogin('http://127.0.0.1:3110/auth/callback');
    const state = stateOf(seen);
    const { res, out } = fakeRes();
    await handleAuthCallback(fakeReq(`/auth/callback?state=${state}&code=c&client_id=cid-1`, 'GET', { host: '127.0.0.1:3110' }), res, svc);
    expect(out.status).toBe(303);
    expect(out.headers.Location).toBe('/?chatgpt=ok');
    expect(out.body).not.toContain('test-access');
  });
});

describe('POST /api/openai/complete-login 已移除：貼回網址不再是登入的一條路', () => {
  it('這個路徑不被 /api/openai 處理（回 false），且沒有進入 finishLogin', async () => {
    const { svc, seen } = service();
    await svc.beginLogin('http://127.0.0.1:3110/auth/callback');
    const state = stateOf(seen);
    const { res, out } = fakeRes();
    const req = Readable.from([Buffer.from(JSON.stringify({ redirectUrl: `http://127.0.0.1:3110/auth/callback?state=${state}&code=c` }))]) as unknown as IncomingMessage;
    Object.assign(req, { url: '/complete-login', method: 'POST', headers: { host: 'evil.com', 'content-type': 'application/json' } });
    const handled = await handleOpenAiApi(req, res, svc);
    expect(handled).toBe(false);
    expect(out.status).toBe(0);
    expect(seen.exchanged).toHaveLength(0);
  });
});
