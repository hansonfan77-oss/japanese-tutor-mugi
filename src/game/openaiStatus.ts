import { apiFetch } from './apiFetch';
// ChatGPT on the phone and in the settings: the sign-in status (GET /api/openai/status). The sign-in and sign-out (POST
// /api/openai/login and /logout) are allowed on the PC only; the phone never calls them. The server never sends a token or a client
// id: the status is the signed-in flag, the plan flag, the e-mail (PC only) and the model list.
export type ChatGptModelChoice = { slug: string; label: string };

export type ChatGptStatus = {
  signedIn: boolean;
  /** the account has the ChatGPT plan permission (without it, the sign-in cannot serve requests) */
  planEnabled: boolean;
  /** shown only when the page is opened on the PC */
  email?: string;
  models: ChatGptModelChoice[];
  modelStatus?: 'ready' | 'empty' | 'incompatible' | 'error';
};

/** the status of a player who is not signed in */
export const SIGNED_OUT: ChatGptStatus = { signedIn: false, planEnabled: false, models: [] };

/** the last status read: the Claude brain's availability check uses it, so a reply costs no extra request */
let lastStatus: ChatGptStatus | null = null;

/** the status as the server sent it (defensive: anything unexpected is a signed-out player) */
function readStatus(j: unknown): ChatGptStatus {
  const o = (j && typeof j === 'object' ? j : {}) as Record<string, unknown>;
  const models = Array.isArray(o.models)
    ? (o.models as unknown[]).flatMap((m) => {
      const x = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
      return typeof x.slug === 'string' && x.slug ? [{ slug: x.slug, label: typeof x.label === 'string' && x.label ? x.label : x.slug }] : [];
    })
    : [];
  return {
    signedIn: o.signedIn === true,
    planEnabled: o.planEnabled === true,
    ...(typeof o.email === 'string' && o.email ? { email: o.email } : {}),
    models,
    ...(['ready', 'empty', 'incompatible', 'error'].includes(String(o.modelStatus))
      ? { modelStatus: o.modelStatus as ChatGptStatus['modelStatus'] } : {}),
  };
}

/** the status now; null when the server cannot be asked (the caller keeps what it has) */
export async function fetchChatGptStatus(): Promise<ChatGptStatus | null> {
  try {
    const r = await apiFetch('/api/openai/status');
    if (!r.ok) return null;
    lastStatus = readStatus(await r.json());
    return lastStatus;
  } catch {
    return null;
  }
}

/** whether ChatGPT can answer now (signed in with the plan); the status is read when none was read yet */
export async function chatGptReady(): Promise<boolean> {
  const s = lastStatus ?? (await fetchChatGptStatus());
  return !!s && s.signedIn && s.planEnabled;
}

/** the message of a failed answer from the server (its own message), or a generic one */
async function errorMessage(r: Response, fallback: string): Promise<string> {
  try {
    const j = (await r.json()) as { message?: unknown };
    if (typeof j.message === 'string' && j.message) return j.message;
  } catch { /* not JSON */ }
  return fallback;
}

/**
 * starts a sign-in on this PC: the consent page's URL, or the message to show (the server refused, OpenAI unreachable). The page is
 * sent to that URL; it comes back to this PC's 127.0.0.1 (takeChatGptReturn reads the home page's ?chatgpt=ok).
 */
export async function startChatGptLogin(): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  try {
    const r = await apiFetch('/api/openai/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) return { ok: false, message: await errorMessage(r, '無法開始 ChatGPT 登入，請稍後再試。') };
    const j = (await r.json()) as { url?: unknown };
    if (typeof j.url !== 'string' || !j.url) return { ok: false, message: '無法開始 ChatGPT 登入，請稍後再試。' };
    return { ok: true, url: j.url };
  } catch {
    return { ok: false, message: '連不上伺服器，請確認電腦上的 App 有在執行。' };
  }
}

/** signs out (the server revokes and deletes the tokens); the message to show, or '' when nothing needs saying */
export async function logoutChatGpt(): Promise<string> {
  try {
    const r = await apiFetch('/api/openai/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) return await errorMessage(r, '登出失敗，請稍後再試。');
    const j = (await r.json()) as { warning?: unknown };
    return typeof j.warning === 'string' ? j.warning : '';
  } catch {
    return '連不上伺服器，請確認電腦上的 App 有在執行。';
  }
}

/**
 * The sign-in returns to the home page as /?chatgpt=ok (see server/openai/routes.ts). Reads that and removes it from the address
 * bar, so a reload does not repeat it. Returns true when the sign-in just came back.
 */
export function takeChatGptReturn(): boolean {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get('chatgpt') !== 'ok') return false;
    url.searchParams.delete('chatgpt');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    return true;
  } catch {
    return false;
  }
}

/** tests only: forget the last status */
export function resetChatGptStatusForTest(): void {
  lastStatus = null;
}
