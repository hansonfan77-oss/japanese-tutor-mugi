// The ChatGPT service: the signed-in account (credentials.ts), its tokens (refresh once at a time), the model list of the
// plan, the sign-in transactions (oauth.ts) and the transport of the Responses calls (server/llm/openaiProvider.ts).
// Nothing here is sent to the browser except the status (routes.ts): no token, no client id.
import { OPENAI_MODEL_MAX_CHARS } from '../../src/game/claudeProtocol.ts';
import { OpenAIError, openaiProvider, type OpenAITransport } from '../llm/openaiProvider.ts';
import type { LlmProvider } from '../llm/provider.ts';
import { DYNAMIC_CLIENT, PLAN_SCOPE, RESOURCE, createTransaction, type Fetcher, type OAuth, type TokenResponse, type Transaction } from './oauth.ts';
import type { Account, CredentialStore } from './credentials.ts';

/** the model list is kept this long (ms): one request to OpenAI per minute at most */
export const MODELS_CACHE_MS = 60_000;
/** sign-ins in progress at once (the oldest is dropped beyond this) */
export const PENDING_MAX = 20;

export type ChatGptModel = { slug: string; label: string };

/** Local text Responses compatibility: accept catalog slugs regardless of generation/family;
 * exclude known non-text endpoint families. Visibility is checked separately against the account catalog.
 * Unknown future text models remain eligible; upstream capability errors are surfaced, never substituted.
 */
export function allowedModel(slug: string): boolean {
  return slug.length <= OPENAI_MODEL_MAX_CHARS && /^[a-z0-9][a-z0-9._-]*$/i.test(slug)
    && !/(?:^|-)(?:image|audio|realtime|transcribe|tts|whisper|embedding|moderation|dall-e|sora)(?:-|$)/i.test(slug);
}

export type ModelStatus = 'ready' | 'empty' | 'incompatible' | 'error';
export type ChatGptStatus = { signedIn: boolean; planEnabled: boolean; email?: string; models: ChatGptModel[]; modelStatus?: ModelStatus };

export type ChatGptService = {
  /** signed in, with the plan scope: the account can serve requests */
  ready(): boolean;
  /** the status for the settings (email only when `local`); modelStatus distinguishes failed, empty and incompatible catalogs */
  status(local: boolean): Promise<ChatGptStatus>;
  /** the models of the plan (cached MODELS_CACHE_MS); throws when OpenAI cannot be asked */
  models(): Promise<ChatGptModel[]>;
  /** the provider for the chat seam (server/llm/openaiProvider.ts) */
  provider(): LlmProvider;
  /** a new sign-in: the URL to open. `redirectUri` is where OpenAI sends the browser back */
  beginLogin(redirectUri: string): Promise<string>;
  /** the callback: checks the state, exchanges the code, checks the identity and saves. Throws a Chinese message. */
  finishLogin(query: Record<string, string | undefined>): Promise<void>;
  /** revokes (best effort) and deletes the tokens and the account */
  logout(): Promise<{ ok: true; warning?: string }>;
};

export type ChatGptOptions = {
  store: CredentialStore;
  oauth: OAuth;
  /** the fetch used for the ChatGPT API (the tests fake it) */
  fetcher?: Fetcher;
  now?: () => number;
};

const TOKEN_MARGIN_MS = 30_000;

export function createChatGpt(opts: ChatGptOptions): ChatGptService {
  const { store, oauth } = opts;
  const fetcher: Fetcher = opts.fetcher ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? Date.now;
  const pending = new Map<string, Transaction & { epoch: number }>();
  const refreshing = new Map<string, Promise<void>>();
  let catalog: { clientId: string; until: number; models: ChatGptModel[]; status: ModelStatus } | null = null;
  let authEpoch = 0;
  let providerCache: LlmProvider | null = null;

  const account = (): Account | null => store.data.account;
  const planEnabled = (a: Account | null): boolean => !!a?.scopes?.includes(PLAN_SCOPE);

  /** stores a token response on the account (the whole response must be usable) */
  function saveTokens(a: Account, tokens: TokenResponse): void {
    if (typeof tokens.access_token !== 'string' || !Number.isFinite(tokens.expires_in) || (tokens.expires_in as number) <= 0) {
      throw new Error('OpenAI 回傳的憑證資料不完整，請重新登入。');
    }
    a.access_token = tokens.access_token;
    a.refresh_token = tokens.refresh_token || a.refresh_token;
    a.id_token = tokens.id_token || a.id_token;
    a.scopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : a.scopes ?? [];
    a.expiresAt = now() + (tokens.expires_in as number) * 1000;
    store.save();
  }

  /** the access token, refreshed when it is about to expire; one refresh at a time per account (rotating tokens) */
  async function ensureToken(a: Account): Promise<string> {
    if (a.access_token && a.expiresAt > now() + TOKEN_MARGIN_MS) return a.access_token;
    if (!a.refresh_token) throw new OpenAIError('登入已過期，請重新授權。', { status: 401 });
    if (!refreshing.has(a.client_id)) {
      const refresh = (async () => {
        try {
          saveTokens(a, await oauth.refresh({ ...a, refresh_token: a.refresh_token as string }));
        } catch (error) {
          if ((error as { code?: string }).code === 'invalid_grant') {
            delete a.access_token;
            delete a.refresh_token;
            delete a.id_token;
            store.save();
          }
          throw error;
        }
      })().finally(() => refreshing.delete(a.client_id));
      refreshing.set(a.client_id, refresh);
    }
    await refreshing.get(a.client_id);
    if (!a.access_token) throw new OpenAIError('登入已過期，請重新授權。', { status: 401 });
    return a.access_token;
  }

  /** a request to the ChatGPT API with the account's token; an HTTP error becomes an OpenAIError with its status and code */
  async function api(path: string, init: { method: 'GET' | 'POST'; body?: string; signal: AbortSignal; accept: string }): Promise<Response> {
    const a = account();
    if (!a?.access_token) throw new OpenAIError('請先登入 ChatGPT。', { status: 401 });
    if (!planEnabled(a)) throw new OpenAIError('已登入，但未授權 ChatGPT plan 使用權；請重新授權。', { status: 403 });
    const token = await ensureToken(a);
    if (!planEnabled(a)) throw new OpenAIError('尚未授權 ChatGPT 方案使用權，請重新授權。', { status: 403 });
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: init.accept };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetcher(`${RESOURCE}${path}`, { method: init.method, headers, body: init.body, signal: init.signal });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: { code?: string } };
      const code = body.error?.code || 'request_failed';
      throw new OpenAIError(`OpenAI 要求失敗（HTTP ${response.status}／${code}）。`, { status: response.status, code });
    }
    return response;
  }

  async function models(): Promise<ChatGptModel[]> {
    const a = account();
    if (catalog && a && catalog.clientId === a.client_id && catalog.until > now()) return catalog.models;
    const response = await api('/models', { method: 'GET', signal: AbortSignal.timeout(30000), accept: 'application/json' });
    const result = (await response.json()) as { models?: unknown };
    if (!result || !Array.isArray(result.models) || result.models.some((m) => !m || typeof m !== 'object'
      || (m.visibility === 'list' && typeof m.slug !== 'string'))) throw new Error('模型清單格式不符官方 OAuth 規格。');
    // Preserve the account's order; never infer availability from a hard-coded model generation.
    const visible = (result.models as unknown[]).filter((m): m is { slug: string; display_name?: unknown } =>
      !!m && typeof m === 'object' && (m as { visibility?: unknown }).visibility === 'list'
      && typeof (m as { slug?: unknown }).slug === 'string');
    const list = visible.filter((m) => allowedModel(m.slug))
      .map((m) => ({ slug: m.slug, label: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.slug }));
    if (a) catalog = { clientId: a.client_id, until: now() + MODELS_CACHE_MS, models: list,
      status: list.length ? 'ready' : visible.length ? 'incompatible' : 'empty' };
    return list;
  }

  // the Responses calls: the account as it is now (a sign-in or sign-out in between simply fails over)
  const transport: OpenAITransport = (path, init) => api(path, { method: 'POST', body: init.body, signal: init.signal, accept: 'text/event-stream' });

  const service: ChatGptService = {
    ready() {
      const a = account();
      return !!a?.access_token && planEnabled(a);
    },
    async status(local) {
      const a = account();
      const signedIn = !!a?.access_token;
      const plan = planEnabled(a);
      let list: ChatGptModel[] = [];
      let modelStatus: ModelStatus | undefined;
      if (signedIn && plan) {
        try {
          list = await models();
          modelStatus = catalog?.status ?? 'empty';
        } catch {
          // Never expose exception messages, upstream bodies, tokens or client IDs through status.
          modelStatus = 'error';
        }
      }
      return {
        signedIn: !!account()?.access_token,
        planEnabled: planEnabled(account()),
        ...(local && a?.email ? { email: a.email } : {}),
        models: list,
        ...(modelStatus ? { modelStatus } : {}),
      };
    },
    models,
    provider() {
      providerCache ??= openaiProvider(transport);
      return providerCache;
    },
    async beginLogin(redirectUri) {
      for (const [key, tx] of pending) if (tx.expiresAt < now()) pending.delete(key);
      while (pending.size >= PENDING_MAX) pending.delete(pending.keys().next().value as string);
      const a = account();
      const tx = createTransaction(a?.client_id, redirectUri, now());
      pending.set(tx.state, { ...tx, epoch: authEpoch });
      return oauth.authorization(tx, store.data.hostId, a);
    },
    async finishLogin(query) {
      const state = query.state;
      const tx = typeof state === 'string' ? pending.get(state) : undefined;
      // single use: the state is spent here, whatever happens next
      if (!tx || typeof state !== 'string') throw new Error('登入狀態不符，請從首頁重新登入。');
      pending.delete(state);
      if (tx.expiresAt < now()) throw new Error('登入逾時，請重新登入。');
      if (query.error) throw new Error('登入或授權已取消，請重試。');
      // The client id. A sign-in that already has an account must use that account's client id (tx.clientId). A first sign-in
      // registers as DYNAMIC_CLIENT (oauth.ts authorization), and the real client id comes back on the callback. That id is
      // bound here before anything is saved: the state matched this sign-in (above), the code is exchanged with it, and the
      // id_token must name it as its audience (oauth.verify throws otherwise), and only then is the account written.
      const clientId = query.client_id || tx.clientId;
      if (!clientId || clientId === DYNAMIC_CLIENT || (tx.clientId && tx.clientId !== clientId)) throw new Error('OpenAI 未回傳相符的 client ID。');
      if (!/^[A-Za-z0-9._-]{1,200}$/.test(clientId)) throw new Error('OpenAI 未回傳相符的 client ID。');
      if (typeof query.code !== 'string' || !query.code) throw new Error('缺少登入授權碼。');
      const tokens = await oauth.exchange(query.code, clientId, tx);
      if (typeof tokens.id_token !== 'string') throw new Error('授權資料不完整。');
      const identity = await oauth.verify(tokens.id_token, clientId, tx.nonce); // throws unless aud === clientId
      if (tx.epoch !== authEpoch) throw new Error('此登入已取消，請重新登入。');
      const existing = account();
      if (existing && (existing.subject !== identity.sub || existing.client_id !== clientId)) throw new Error('登入身分與保存的帳號不符。');
      if (tx.clientId && !existing) throw new Error('找不到原始帳號註冊。');
      if (!tokens.access_token || !tokens.expires_in || typeof tokens.scope !== 'string') throw new Error('授權資料不完整。');
      const next: Account = existing ?? { client_id: clientId, subject: identity.sub, email: '', name: '', scopes: [], expiresAt: 0 };
      next.email = identity.email || '';
      next.name = identity.name || '';
      store.data.account = next;
      saveTokens(next, tokens);
      catalog = null;
    },
    async logout() {
      authEpoch++;
      pending.clear();
      const a = account();
      if (!a) return { ok: true };
      await refreshing.get(a.client_id)?.catch(() => {});
      const revoked = await oauth.revoke(a).catch(() => false);
      store.data.account = null;
      store.save();
      catalog = null;
      return revoked ? { ok: true } : { ok: true, warning: '已在本機登出，但未確認遠端撤銷；可至 ChatGPT 設定中中斷此 App 的連線。' };
    },
  };
  return service;
}
