// Usage tracking: how many paid speech characters and Claude tokens this PC's dev server has sent, per local calendar month.
// Stored as JSON at .usage/usage.json (gitignored), written debounced and atomically (temp file + rename).
//   GET /api/usage → { months: { 'YYYY-MM': { tts, claude } }, current: 'YYYY-MM', freeTier }   (read-only)
// Only requests that went through this server are counted: the official bills are the source of truth.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';
import { guardApi, guardOptionsFrom } from './apiGuard.ts';
import { getTtsCache } from './ttsCache.ts';
import type { TtsEngine } from './tts.ts';

export const USAGE_DIR = '.usage';
export const USAGE_FILE = 'usage.json';
/** writes are batched: a burst of requests is saved once, this long after the last change */
export const USAGE_DEBOUNCE_MS = 2000;
/** a steady stream of requests still saves at least this often */
export const USAGE_MAX_WAIT_MS = 10_000;

// ---------------------------------------------------------------- free tiers (characters per month)

/**
 * The monthly free allowances the client shows progress bars against. Google: Standard 4,000,000 / WaveNet 4,000,000 /
 * Neural2 1,000,000 (as set by the user; check the current Google Cloud TTS pricing page). Azure F0: 500,000 neural chars.
 * A tier not listed here has no free allowance shown.
 */
export const TTS_FREE_TIER = {
  google: { standard: 4_000_000, wavenet: 4_000_000, neural2: 1_000_000 } as Record<string, number>,
  azure: { neural: 500_000 } as Record<string, number>,
};

/** a free allowance counts as used up at this share: past it, the speech falls back (server/tts.ts planTts) */
export const TTS_FALLBACK_AT = 0.9;

/** the monthly free allowance of a tier, or undefined when the tier has none shown */
export function freeOf(engine: TtsEngine, tier: string): number | undefined {
  // VOICEVOX has no allowance (a local engine): no row in TTS_FREE_TIER, so no free tier and no fallback
  return (TTS_FREE_TIER as Record<string, Record<string, number> | undefined>)[engine]?.[tier];
}

/**
 * Would `add` more characters on top of `used` cross the fallback share of the allowance? Strictly above: 900 of 1,000 used
 * with 100 more is exactly 90% and stays on this tier; 101 more crosses. A tier without an allowance never crosses.
 */
export function crossesThreshold(used: number, add: number, free: number | undefined): boolean {
  if (free === undefined) return false;
  return used + add > free * TTS_FALLBACK_AT;
}

/**
 * The Google tiers a request falls back to, in order, when its own tier is past the threshold (same language only; the
 * voice is mapped in server/tts.ts). Azure is tried after these when it is configured.
 */
export const GOOGLE_FALLBACK_CHAIN: Record<string, string[]> = {
  neural2: ['wavenet', 'standard'],
  wavenet: ['standard'],
  standard: [],
};

// ---------------------------------------------------------------- TTS counting rules

/**
 * The Google tier from a voice id: `cmn-TW-Wavenet-A` → 'wavenet', `ja-JP-Neural2-B` → 'neural2', `…-Standard-A` → 'standard',
 * `en-US-Chirp3-HD-Aoede` → 'chirp3-hd'. Anything else → 'other' (counted, but no free allowance is shown for it).
 */
export function googleTier(voice: string): string {
  const m = /-(Chirp3-HD|Chirp|Standard|Wavenet|Neural2|Studio|News|Journey|Polyglot)(?=-|$)/i.exec(voice);
  return m ? m[1].toLowerCase() : 'other';
}

/**
 * Azure has one tier here: neural voices (F0 free allowance 500,000 chars/month). VOICEVOX is a local engine: one tier, no
 * allowance, nothing billed (its characters are only counted).
 */
export function ttsBucket(engine: TtsEngine, voice: string): { engine: TtsEngine; tier: string } {
  if (engine === 'voicevox') return { engine, tier: 'voicevox' };
  return engine === 'azure' ? { engine, tier: 'neural' } : { engine, tier: googleTier(voice) };
}

/**
 * Billed characters of one synthesis. The rule: the number of Unicode characters (code points) of the text the user sent,
 * so a CJK character, a kana or an emoji is 1 and whitespace and punctuation count too. SSML markup is NOT counted: Azure
 * gets our <speak>/<prosody> wrapper (the markup), Google gets the plain text. Both providers bill the text content.
 * The count uses the text as sent (not trimmed); a cache hit is not billed, because nothing was sent upstream.
 */
export function billedChars(text: string, engine?: TtsEngine, tier?: string): number {
  // Google Neural2: the pricing page only promises "one multibyte character = one character" for Standard and WaveNet, so
  // Neural2 is counted conservatively as UTF-8 bytes (a CJK character or kana = 3): its 90% fallback then comes early, never late
  if (engine === 'google' && tier === 'neural2') return new TextEncoder().encode(text).length;
  return [...text].length;
}

// ---------------------------------------------------------------- Claude prices

/** One price band per model: USD per million tokens. `maxPromptTokens` picks the band by the whole prompt (input + cache). */
export type ClaudePriceBand = { maxPromptTokens?: number; inPerMTok: number; outPerMTok: number };

/** cache writes (5-minute cache, the only kind this server asks for) cost 1.25× the input price */
export const CACHE_WRITE_MULT = 1.25;
/** cache reads cost 0.1× the input price (the rule given for this project) */
export const CACHE_READ_MULT = 0.1;

/**
 * Price table, USD per million tokens. TODO(verify): taken from the bundled claude-api skill's reference
 * (shared/models.md, "Current Models", as bundled with Claude Code 2.1.295; the live source is platform.claude.com pricing).
 * Note: that reference lists cache reads for Claude Opus 5.5 as $0.20 (0.05× input) and for Claude Fable 5.1 as $0.25
 * (0.025× input); this table applies the project rule 0.1× to every model, so cache reads of those two are overstated.
 * Haiku 5.5 is two bands: $0.10/$0.50 for a prompt of 100K tokens or fewer, $0.50/$2.50 above.
 */
export const CLAUDE_PRICES: Record<string, ClaudePriceBand[]> = {
  'claude-opus-5-5': [{ inPerMTok: 4, outPerMTok: 20 }],
  'claude-sonnet-5-5': [{ inPerMTok: 2, outPerMTok: 10 }],
  'claude-haiku-5-5': [
    { maxPromptTokens: 100_000, inPerMTok: 0.1, outPerMTok: 0.5 },
    { inPerMTok: 0.5, outPerMTok: 2.5 },
  ],
  'claude-fable-5-1': [{ inPerMTok: 10, outPerMTok: 50 }],
};

/** a dated snapshot id (claude-opus-5-5-20261001) is priced as its alias */
export function normalizeModel(model: string): string {
  return model.replace(/-\d{8}$/, '');
}

export type ClaudeUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

/** USD for the tokens of one response at one price band */
function costAt(band: ClaudePriceBand, u: ClaudeUsage): number {
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const perTok = (usdPerMTok: number) => usdPerMTok / 1_000_000;
  return (
    input * perTok(band.inPerMTok) +
    write * CACHE_WRITE_MULT * perTok(band.inPerMTok) +
    read * CACHE_READ_MULT * perTok(band.inPerMTok) +
    output * perTok(band.outPerMTok)
  );
}

/** Estimated USD for one response, or null when the model has no price in CLAUDE_PRICES. */
export function claudeCostUsd(model: string, u: ClaudeUsage): number | null {
  const bands = CLAUDE_PRICES[normalizeModel(model)];
  if (!bands) return null;
  const prompt = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const band = bands.find((b) => b.maxPromptTokens === undefined || prompt <= b.maxPromptTokens) ?? bands[bands.length - 1];
  return costAt(band, u);
}

/**
 * The most expensive price in CLAUDE_PRICES, per token kind (input and output may come from different models). A model with
 * no price is charged at this, so the daily cap still applies to it; the estimate is high, never low.
 */
export function priciestBand(): ClaudePriceBand {
  let inPerMTok = 0;
  let outPerMTok = 0;
  for (const bands of Object.values(CLAUDE_PRICES)) {
    for (const b of bands) {
      inPerMTok = Math.max(inPerMTok, b.inPerMTok);
      outPerMTok = Math.max(outPerMTok, b.outPerMTok);
    }
  }
  return { inPerMTok, outPerMTok };
}

/** Estimated USD for one response of a model that has no price: at the priciest band (see priciestBand). Never null. */
export function claudeCostEstimateUsd(u: ClaudeUsage): number {
  return costAt(priciestBand(), u);
}

// ---------------------------------------------------------------- stored shape

export type TtsCounter = {
  requests: number;
  failures: number;
  chars: number;
  cacheHits: number;
  /** utterances of this tier that were diverted (to another tier, Azure or the browser) because it was past the threshold */
  fallbacks: number;
};
export type ClaudeCounter = {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** estimated USD, summed per response at the price of the model that served it (a model with no price: at the priciest, see priciestBand) */
  costUsd: number;
  /** responses whose model has no entry in CLAUDE_PRICES: their cost in costUsd is an estimate at the priciest price */
  unpriced: number;
  /** responses whose token counts were estimated (the stream ended before the upstream reported usage): from the text lengths */
  estimated: number;
};
export type MonthUsage = {
  /** voicevox is created on its first use (a month with no VOICEVOX speech has no such key) */
  tts: { google: Record<string, TtsCounter>; azure: Record<string, TtsCounter>; voicevox?: Record<string, TtsCounter> };
  claude: Record<string, ClaudeCounter>;
};
/**
 * the file: months (monthly counters); days (estimated Claude USD per local day, 'YYYY-MM-DD'; absent in files written before
 * this field); estimatedDays (the part of each day's USD that is an estimate: a model with no price, or estimated token counts)
 */
type UsageFile = {
  version: 1;
  months: Record<string, MonthUsage>;
  days?: Record<string, number>;
  estimatedDays?: Record<string, number>;
};

/** the numeric entries of a per-day map read from the file (anything else is dropped) */
function dayMap(v: unknown): Record<string, number> {
  return v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'number' && Number.isFinite(x))) : {};
}

export type UsageSnapshot = {
  months: Record<string, MonthUsage>;
  current: string;
  freeTier: typeof TTS_FREE_TIER;
};

const emptyTts = (): TtsCounter => ({ requests: 0, failures: 0, chars: 0, cacheHits: 0, fallbacks: 0 });
const emptyClaude = (): ClaudeCounter => ({
  requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: 0, unpriced: 0, estimated: 0,
});
export const emptyMonth = (): MonthUsage => ({ tts: { google: {}, azure: {} }, claude: {} });

/** 'YYYY-MM' in local time (the calendar month of this PC) */
export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' in local time (the day of this PC: the daily spending cap resets at local midnight) */
export function dayKey(d: Date): string {
  return `${monthKey(d)}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Has today's Claude spending reached the cap? A cap of 0 (or less) means no limit. The comparison is at or above the cap:
 * once the estimate equals the cap, no more Claude calls are made that day.
 */
export function dailyLimitHit(spentUsd: number, capUsd: number): boolean {
  return capUsd > 0 && spentUsd >= capUsd;
}

// ---------------------------------------------------------------- the store

export type UsageStoreOptions = { file: string; now?: () => Date; debounceMs?: number };

export class UsageStore {
  readonly file: string;
  private readonly now: () => Date;
  private readonly debounceMs: number;
  private months: Record<string, MonthUsage> = {};
  /** estimated Claude USD per local day (dayKey); the daily spending cap reads today's entry */
  private days: Record<string, number> = {};
  /** the part of each day's USD that is an estimate (see UsageFile) */
  private estimatedDays: Record<string, number> = {};
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private firstDirtyAt: number | undefined;
  /** how many times the file was written (tests check the debounce with this) */
  writes = 0;

  constructor(opts: UsageStoreOptions) {
    this.file = opts.file;
    this.now = opts.now ?? (() => new Date());
    this.debounceMs = opts.debounceMs ?? USAGE_DEBOUNCE_MS;
    this.load();
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<UsageFile>;
      if (!j || typeof j.months !== 'object' || j.months === null) throw new Error('no months');
      this.months = j.months;
      // older files have no days: today's spending then starts at zero (it cannot be rebuilt from the monthly totals)
      this.days = dayMap(j.days);
      this.estimatedDays = dayMap(j.estimatedDays);
    } catch (e) {
      // keep the unreadable file aside rather than overwrite it, then start fresh
      const aside = `${this.file}.bad-${Date.now()}`;
      try { renameSync(this.file, aside); } catch { /* nothing more to do */ }
      console.warn(`[usage] ${this.file} unreadable (${e instanceof Error ? e.message : e}); moved to ${aside}`);
      this.months = {};
      this.days = {};
      this.estimatedDays = {};
    }
  }

  /** the current month's record, created on first use (so a new month starts at zero on its first request) */
  private month(): MonthUsage {
    const k = monthKey(this.now());
    if (!this.months[k]) this.months[k] = emptyMonth();
    return this.months[k];
  }

  /** trailing debounce: the save runs debounceMs after the last change (at most USAGE_MAX_WAIT_MS after the first) */
  private touch() {
    this.dirty = true;
    const now = Date.now();
    this.firstDirtyAt ??= now;
    if (now - this.firstDirtyAt >= USAGE_MAX_WAIT_MS) return this.flush();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  private ttsCounter(b: { engine: TtsEngine; tier: string }): TtsCounter {
    const bucket = (this.month().tts[b.engine] ??= {});
    if (!bucket[b.tier]) bucket[b.tier] = emptyTts();
    return bucket[b.tier];
  }

  /** one upstream synthesis attempt: ok → its billed characters count, otherwise it is a failure */
  recordTts(b: { engine: TtsEngine; tier: string }, r: { ok: boolean; chars: number }) {
    const c = this.ttsCounter(b);
    c.requests++;
    if (r.ok) c.chars += r.chars;
    else c.failures++;
    this.touch();
  }

  /** characters billed so far this month for a tier (0 when none) */
  ttsUsed(engine: TtsEngine, tier: string): number {
    return this.month().tts[engine]?.[tier]?.chars ?? 0;
  }

  /** an utterance of this tier was diverted because the tier is past the threshold */
  recordTtsFallback(b: { engine: TtsEngine; tier: string }) {
    this.ttsCounter(b).fallbacks++;
    this.touch();
  }

  /** a reply served from the in-memory cache: nothing is sent upstream, so nothing is billed */
  recordTtsCacheHit(b: { engine: TtsEngine; tier: string }) {
    this.ttsCounter(b).cacheHits++;
    this.touch();
  }

  /**
   * One Claude response, or a chat stream that ended early (usage so far). Omit `usage` for a call that gave none.
   * `error`: the call failed after it was sent (counted in errors too). `estimated`: the token counts are estimates.
   * A model with no price is charged at the priciest price in CLAUDE_PRICES, and that part counts as an estimate.
   */
  recordClaude(model: string, usage?: ClaudeUsage | null, opts: { error?: boolean; estimated?: boolean } = {}) {
    const key = normalizeModel(model);
    const months = this.month().claude;
    if (!months[key]) months[key] = emptyClaude();
    const c = months[key];
    c.requests++;
    if (opts.error) c.errors++;
    if (usage) {
      c.inputTokens += usage.input_tokens ?? 0;
      c.outputTokens += usage.output_tokens ?? 0;
      c.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
      c.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
      let cost = claudeCostUsd(model, usage);
      let estimate = !!opts.estimated;
      if (cost === null) {
        cost = claudeCostEstimateUsd(usage);
        c.unpriced++;
        estimate = true;
      }
      if (opts.estimated) c.estimated++;
      c.costUsd += cost;
      const day = dayKey(this.now());
      this.days[day] = (this.days[day] ?? 0) + cost;
      if (estimate) this.estimatedDays[day] = (this.estimatedDays[day] ?? 0) + cost;
    }
    this.touch();
  }

  /** the part of today's estimated USD that is an estimate (an unpriced model, or estimated token counts) */
  estimatedDailyCostUsd(): number {
    return this.estimatedDays[dayKey(this.now())] ?? 0;
  }

  /** the estimated Claude USD spent today (local day), the figure the daily cap (MUGI_DAILY_USD) is checked against */
  dailyCostUsd(): number {
    return this.days[dayKey(this.now())] ?? 0;
  }

  /** a Claude call that failed (no usage to count; the request is still counted) */
  recordClaudeError(model: string) {
    const key = normalizeModel(model);
    const months = this.month().claude;
    if (!months[key]) months[key] = emptyClaude();
    months[key].requests++;
    months[key].errors++;
    this.touch();
  }

  /** what GET /api/usage returns: every stored month, plus the current one (empty until its first request) */
  snapshot(): UsageSnapshot {
    const current = monthKey(this.now());
    const all: Record<string, MonthUsage> = { ...this.months };
    if (!all[current]) all[current] = emptyMonth();
    const months: Record<string, MonthUsage> = {};
    for (const k of Object.keys(all).sort().reverse()) months[k] = all[k];
    return { months, current, freeTier: TTS_FREE_TIER };
  }

  /** writes the file now if anything changed: temp file, then rename over the old one */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.dirty) return;
    const body: UsageFile = { version: 1, months: this.months, days: this.days, estimatedDays: this.estimatedDays };
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8');
      try {
        renameSync(tmp, this.file);
      } catch {
        // Windows will not replace a file that is open elsewhere: remove the old one and rename again
        try { unlinkSync(this.file); } catch { /* not there */ }
        renameSync(tmp, this.file);
      }
      this.dirty = false;
      this.firstDirtyAt = undefined;
      this.writes++;
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* no temp file */ }
      console.warn('[usage] save failed:', e instanceof Error ? e.message : e);
    }
  }
}

const stores = new Map<string, UsageStore>();

/** the one store for the project root, shared by the TTS, Claude and /api/usage handlers */
export function getUsageStore(root: string): UsageStore {
  const file = join(root, USAGE_DIR, USAGE_FILE);
  let s = stores.get(file);
  if (!s) {
    s = new UsageStore({ file });
    stores.set(file, s);
    // a pending debounced save is written when the process exits normally
    process.once('exit', () => s?.flush());
  }
  return s;
}

// ---------------------------------------------------------------- GET /api/usage

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

/**
 * the read-only usage route; anything but GET / is a 404 (there is no reset endpoint). With `speechCache` it adds
 * `ttsCache: { files, bytes }`, the size of the speech disk cache (server/ttsCache.ts).
 */
export function usageRoute(store: UsageStore, req: Pick<IncomingMessage, 'method' | 'url'>, res: ServerResponse, speechCache?: { stats(): { files: number; bytes: number } }) {
  const url = (req.url ?? '/').split('?')[0];
  if (req.method !== 'GET' || (url !== '/' && url !== '')) return json(res, 404, { error: 'not_found', message: '沒有這個 API' });
  const snap = store.snapshot();
  return json(res, 200, speechCache ? { ...snap, ttsCache: speechCache.stats() } : snap);
}

/** Vite plugin: mounts GET /api/usage on the dev server. */
export function usagePlugin(): Plugin {
  let root = process.cwd();
  return {
    name: 'mugi-usage',
    apply: 'serve',
    configResolved(cfg) {
      root = cfg.root;
    },
    configureServer(server) {
      mountUsage(server.middlewares, root, guardOptionsFrom(server));
    },
  };
}

/** Shared route registration for development and the private production server. */
export function mountUsage(middlewares: import("connect").Server, root: string, guard: import("./apiGuard.ts").GuardOptions) {
  const store = getUsageStore(root);
  const speechCache = getTtsCache(root);
  middlewares.use('/api/usage', guardApi((req, res) => {
    try {
      usageRoute(store, req, res, speechCache);
    } catch (e) {
      console.warn('[usage]', e instanceof Error ? e.message : e);
      if (!res.headersSent) json(res, 500, { error: 'server', message: '伺服器錯誤' });
    }
  }, guard));
}
