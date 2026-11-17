// 速查 (quick Japanese lookup): the player asks how to say something, or about a word or grammar point. Not the character
// chat: nothing here touches her chat history. Pure parsing and history helpers (no DOM at import time) so the dev server
// (server/claudeChat.ts) and the phone share them. The history lives in localStorage, per device; every access is guarded.
import { apiFetch } from './apiFetch.ts';
import type { AiServices } from './claudeProtocol.ts';

export const LOOKUP_MAX_CHARS = 200;
export const LOOKUP_HISTORY_MAX = 50;
export const LOOKUP_KEY = 'mugi.lookup.v1';
export const LOOKUP_LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1', '級外'] as const;
export type LookupLevel = (typeof LOOKUP_LEVELS)[number];

export type LookupItem = { ja: string; zh: string; level: LookupLevel; note?: string };
export type LookupGrammar = { point: string; level: LookupLevel; explain: string };
export type LookupExample = { ja: string; zh: string };
/** `ja` fields keep their <ja>…</ja> wrapper and readings (for display and speech); other fields are plain Chinese */
export type LookupAnswer = { message?: string; items: LookupItem[]; grammar: LookupGrammar[]; examples: LookupExample[] };

export type LookupEntry = { id: string; q: string; at: number; answer: LookupAnswer | null; raw?: string };

/** a level as the JLPT lists name it; anything else (口語, 俗語, 外來語, unknown) is 級外 */
export function normalizeLevel(v: unknown): LookupLevel {
  if (typeof v !== 'string') return '級外';
  const m = /^\s*n\s*([1-5])\s*$/i.exec(v);
  return m ? (`N${m[1]}` as LookupLevel) : '級外';
}

/** the badge text shown in the sheet: 「N4」 or 「級外」 */
export const levelBadge = (level: LookupLevel): string => `「${level}」`;

/** a field with the <ja> tags removed (for display of Chinese text, which must never show raw tags) */
export const stripJaTags = (s: string): string => s.replace(/<\/?ja>/g, '');

/** a Japanese field wrapped in <ja>…</ja> (the model sometimes leaves the tags off) */
function jaField(v: unknown): string {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  if (!t) return '';
  return /<ja>[\s\S]*<\/ja>/.test(t) ? t : `<ja>${stripJaTags(t)}</ja>`;
}

const textField = (v: unknown): string => (typeof v === 'string' ? stripJaTags(v).trim() : '');

/**
 * The model's reply as an answer. Code fences and text around the JSON are tolerated (the first { … } is taken).
 * Returns null when nothing usable can be read: the caller then shows the raw reply instead.
 */
export function parseLookupText(text: string): LookupAnswer | null {
  let t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let j: unknown;
  try { j = JSON.parse(t.slice(start, end + 1)); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);
  const items: LookupItem[] = arr(o.items).flatMap((x) => {
    const ja = jaField(x.ja);
    const zh = textField(x.zh);
    if (!ja && !zh) return [];
    const note = textField(x.note);
    return [{ ja, zh, level: normalizeLevel(x.level), ...(note ? { note } : {}) }];
  });
  const grammar: LookupGrammar[] = arr(o.grammar).flatMap((x) => {
    const point = jaField(x.point);
    const explain = textField(x.explain);
    return point || explain ? [{ point, level: normalizeLevel(x.level), explain }] : [];
  });
  const examples: LookupExample[] = arr(o.examples).flatMap((x) => {
    const ja = jaField(x.ja);
    const zh = textField(x.zh);
    return ja ? [{ ja, zh }] : [];
  });
  const message = textField(o.message);
  if (!items.length && !grammar.length && !examples.length && !message) return null;
  return { ...(message ? { message } : {}), items, grammar, examples };
}

/** the Japanese of a <ja> field for speech: no tags, no readings (readings are for display only) */
export const jaSpeakable = (s: string): string => s.replace(/<\/?ja>/g, '').replace(/\[[^[\]]*\]/g, '');
/** the Japanese of a <ja> field for display (rubyNodes reads the readings) */
export const jaDisplay = (s: string): string => s.replace(/<\/?ja>/g, '');

/** a new lookup goes first; the list is capped (oldest dropped) */
export function addLookup(list: LookupEntry[], entry: LookupEntry, max = LOOKUP_HISTORY_MAX): LookupEntry[] {
  return [entry, ...list].slice(0, max);
}

/** one lookup removed (the ✕ on its row); the others keep their order */
export function removeLookup(list: LookupEntry[], id: string): LookupEntry[] {
  return list.filter((e) => e.id !== id);
}

export function newLookupId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function isEntry(v: unknown): v is LookupEntry {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.q === 'string' && typeof o.at === 'number' && (o.answer === null || typeof o.answer === 'object');
}

/** in-memory copy: the source of truth whenever storage is missing or broken */
let memory: LookupEntry[] | null = null;

export function loadLookups(): LookupEntry[] {
  if (memory) return memory;
  let list: LookupEntry[] = [];
  try {
    const raw = localStorage.getItem(LOOKUP_KEY);
    const j = raw ? (JSON.parse(raw) as unknown) : [];
    if (Array.isArray(j)) list = (j as unknown[]).filter(isEntry).slice(0, LOOKUP_HISTORY_MAX);
  } catch { /* unreadable: start empty */ }
  memory = list;
  return list;
}

export function saveLookups(list: LookupEntry[]): LookupEntry[] {
  const capped = list.slice(0, LOOKUP_HISTORY_MAX);
  memory = capped;
  try { localStorage.setItem(LOOKUP_KEY, JSON.stringify(capped)); } catch { /* no storage: memory only */ }
  return capped;
}

export function clearLookups(): LookupEntry[] {
  memory = [];
  try { localStorage.removeItem(LOOKUP_KEY); } catch { /* ignore */ }
  return [];
}

export type LookupResult =
  | { ok: true; answer: LookupAnswer | null; raw: string }
  | { ok: false; message: string };

/**
 * POST /api/lookup. `model`: the 速查 model (the settings' 速查與小提醒 model); absent, the server's default. Never throws:
 * a failure comes back as { ok:false, message } for the sheet to show.
 */
export async function askLookup(q: string, signal?: AbortSignal, model?: string, services?: AiServices): Promise<LookupResult> {
  const text = q.trim();
  if (!text) return { ok: false, message: '請輸入要查的詞或句子' };
  try {
    const r = await apiFetch('/api/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, ...(model ? { model } : {}), ...(services ?? {}) }),
      signal,
    });
    const j = (await r.json().catch(() => null)) as { ok?: unknown; answer?: unknown; raw?: unknown; message?: unknown } | null;
    if (!r.ok || !j || j.ok !== true) return { ok: false, message: typeof j?.message === 'string' ? j.message : `查詢失敗（${r.status}）` };
    const answer = j.answer && typeof j.answer === 'object' ? (j.answer as LookupAnswer) : null;
    return { ok: true, answer, raw: typeof j.raw === 'string' ? j.raw : '' };
  } catch (e) {
    if (signal?.aborted) return { ok: false, message: '已取消' };
    return { ok: false, message: `連不上伺服器：${e instanceof Error ? e.message : '未知錯誤'}` };
  }
}

/** tests only: forget the in-memory copy so the next load reads storage again */
export function resetLookupCacheForTest(): void {
  memory = null;
}
