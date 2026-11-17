// Speech synthesis served by the Vite dev server (vite.config.ts → ttsPlugin): Azure Speech and Google Cloud Text-to-Speech
// (keys in .env.local on the PC, never sent to the phone), and VOICEVOX for Japanese (VOICEVOX_URL, default
// http://127.0.0.1:50021, no key). The phone only talks to /api/tts on the same origin.
//   GET  /api/tts/status → { azure, google, voicevox, voices }   azure / google / voicevox = usable now
//   POST /api/tts        → audio/mpeg (azure, google) or audio/wav (voicevox)   body { engine, voice, text, rate, pitch }
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadEnv, type Plugin } from 'vite';
import { billedChars, crossesThreshold, freeOf, GOOGLE_FALLBACK_CHAIN, getUsageStore, googleTier, ttsBucket, type UsageStore } from './usage.ts';
import { getTtsCache, type TtsAudioExt, type TtsCache } from './ttsCache.ts';
import { createVoicevoxProcess, defaultVoicevoxDeps, voicevoxRoute } from './voicevoxProcess.ts';
import { encodeVisemes, recalledVisemes, rememberVisemes, type Viseme } from './visemes.ts';
import { checkApiRequest, guardApi, guardOptionsFrom, type GuardOptions } from './apiGuard.ts';

export type TtsEngine = 'azure' | 'google' | 'voicevox';
/** lang is the locale (Azure style, cmn-TW is zh-TW): what the server picks the closest Google / Azure voice by */
export type TtsVoice = { id: string; label: string; lang: string; character?: string };
export type TtsVoiceSet = { zh: TtsVoice[]; ja: TtsVoice[] };
export type TtsBody = { engine: TtsEngine; voice: string; text: string; rate: number; pitch: number };
export type TtsConfig = { azureKey: string; azureRegion: string; googleKey: string };

/**
 * the voices the client may ask for (ids are what the client sends); the first of each list is that engine's default.
 * VOICEVOX has no fixed list: its styles come from the running engine (voicevoxStatus), so its lists here are empty.
 */
export const TTS_VOICES: Record<TtsEngine, TtsVoiceSet> = {
  voicevox: { zh: [], ja: [] },
  azure: {
    zh: [
      { id: 'zh-TW-HsiaoChenNeural', label: '曉臻・台灣女聲', lang: 'zh-TW' },
      { id: 'zh-TW-HsiaoYuNeural', label: '曉雨・台灣女聲', lang: 'zh-TW' },
      { id: 'zh-CN-XiaoxiaoNeural', label: '曉曉・大陸女聲', lang: 'zh-CN' },
      { id: 'zh-CN-XiaoyiNeural', label: '曉伊・大陸女聲', lang: 'zh-CN' },
    ],
    ja: [
      { id: 'ja-JP-NanamiNeural', label: '七海', lang: 'ja-JP' },
      { id: 'ja-JP-AoiNeural', label: '葵', lang: 'ja-JP' },
      { id: 'ja-JP-MayuNeural', label: '真由', lang: 'ja-JP' },
      { id: 'ja-JP-ShioriNeural', label: '栞', lang: 'ja-JP' },
      { id: 'ja-JP-KeitaNeural', label: '圭太（男聲）', lang: 'ja-JP' },
      { id: 'ja-JP-DaichiNeural', label: '大智（男聲）', lang: 'ja-JP' },
    ],
  },
  google: {
    zh: [
      { id: 'cmn-TW-Wavenet-A', label: '台灣女聲 WaveNet', lang: 'cmn-TW' },
      { id: 'cmn-TW-Standard-A', label: '台灣女聲 標準', lang: 'cmn-TW' },
      { id: 'cmn-CN-Wavenet-A', label: '大陸女聲 WaveNet', lang: 'cmn-CN' },
      { id: 'cmn-CN-Wavenet-D', label: '大陸女聲 WaveNet D', lang: 'cmn-CN' },
    ],
    ja: [
      { id: 'ja-JP-Neural2-B', label: '女聲 Neural2', lang: 'ja-JP' },
      { id: 'ja-JP-Wavenet-A', label: '女聲 WaveNet A', lang: 'ja-JP' },
      { id: 'ja-JP-Wavenet-B', label: '女聲 WaveNet B', lang: 'ja-JP' },
      { id: 'ja-JP-Neural2-C', label: '男聲 Neural2 C', lang: 'ja-JP' },
      { id: 'ja-JP-Neural2-D', label: '男聲 Neural2 D', lang: 'ja-JP' },
      { id: 'ja-JP-Wavenet-C', label: '男聲 WaveNet C', lang: 'ja-JP' },
    ],
  },
};

export const TTS_MAX_TEXT = 500;
const MAX_BODY_BYTES = 16 * 1024;
const AZURE_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const NO_KEY: Record<'azure' | 'google', string> = {
  azure: '尚未設定 Azure 語音金鑰：請在 .env.local 填入 AZURE_SPEECH_KEY 與 AZURE_SPEECH_REGION',
  google: '尚未設定 Google 語音金鑰：請在 .env.local 填入 GOOGLE_TTS_API_KEY',
};

/** the VOICEVOX engine's address: VOICEVOX_URL from the process environment (not .env.local), else the local default */
export function voicevoxUrl(env: NodeJS.ProcessEnv = process.env): string {
  const u = (env.VOICEVOX_URL ?? '').trim();
  return (u || 'http://127.0.0.1:50021').replace(/\/+$/, '');
}

/** an error that maps to an HTTP status and a short code for the client */
export class TtsError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Keys and region from .env.local (or the process environment). Read per request, so a new key needs no restart. */
export function readTtsConfig(root: string, mode: string): TtsConfig {
  const env = loadEnv(mode, root, '');
  return {
    azureKey: (env.AZURE_SPEECH_KEY ?? '').trim(),
    azureRegion: (env.AZURE_SPEECH_REGION ?? '').trim(),
    googleKey: (env.GOOGLE_TTS_API_KEY ?? '').trim(),
  };
}

/**
 * an engine is usable when its key is set (Azure also needs a region that is a plain DNS label). VOICEVOX needs no key:
 * whether it runs is checked by its status probe and by each synthesis (down → 503 voicevox_down).
 */
export function engineConfigured(c: TtsConfig, engine: TtsEngine): boolean {
  if (engine === 'voicevox') return true;
  if (engine === 'azure') return !!c.azureKey && /^[a-z0-9-]+$/i.test(c.azureRegion);
  return !!c.googleKey;
}

/** the VOICEVOX probe's answer: whether the engine answers, and its voices (styles) */
export type VoicevoxInfo = { up: boolean; voices: TtsVoice[] };

/**
 * the status: which engines are usable, and every voice list (VOICEVOX's from the running engine, empty when it is down)
 */
export function ttsStatus(c: TtsConfig, vv: VoicevoxInfo = { up: false, voices: [] }) {
  return {
    azure: engineConfigured(c, 'azure'),
    google: engineConfigured(c, 'google'),
    voicevox: vv.up,
    voices: {
      ...TTS_VOICES,
      voicevox: { zh: [], ja: vv.up ? vv.voices : [] },
    },
  };
}

export function findVoice(engine: TtsEngine, id: string): TtsVoice | undefined {
  const set = TTS_VOICES[engine];
  return [...set.zh, ...set.ja].find((v) => v.id === id);
}

/** a VOICEVOX voice id is a style id: a short number (the engine checks that it exists) */
export const isVoicevoxStyle = (voice: string): boolean => /^\d{1,6}$/.test(voice);

/** the file kind of a reply: the local engines return WAV, the cloud engines MP3 */
export const audioExtOf = (engine: TtsEngine): TtsAudioExt => (engine === 'voicevox' ? 'wav' : 'mp3');
/** the Content-Type a reply is served with */
export const audioTypeOf = (engine: TtsEngine): string => (engine === 'voicevox' ? 'audio/wav' : 'audio/mpeg');

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** a language as Azure names it: Google's cmn-TW is zh-TW */
export const azureLang = (lang: string): string => lang.replace(/^cmn-/, 'zh-');

/** the language (Azure style) of a voice id from either allowlist, or undefined for an unknown id */
function voiceLang(voice: string): string | undefined {
  const v = findVoice('google', voice) ?? findVoice('azure', voice);
  return v ? azureLang(v.lang) : undefined;
}

/**
 * The Google voice of `tier` closest to `voice`: the same language family, the same locale preferred, then the same
 * trailing letter (cmn-TW-Wavenet-A → cmn-TW-Standard-A). Undefined when the allowlist has no such voice (ja has no
 * Standard voice here, so a Japanese Neural2 request falls to WaveNet, then to Azure or the browser).
 */
export function googleVoiceFor(voice: string, tier: string): TtsVoice | undefined {
  const lang = voiceLang(voice);
  if (!lang) return undefined;
  const family = lang.split('-')[0];
  const fromGoogle = !!findVoice('google', voice);
  const letter = voice.slice(-1);
  let best: TtsVoice | undefined;
  let bestScore = -1;
  for (const v of [...TTS_VOICES.google.zh, ...TTS_VOICES.google.ja]) {
    if (googleTier(v.id) !== tier || azureLang(v.lang).split('-')[0] !== family) continue;
    const score = (azureLang(v.lang) === lang ? 2 : 0) + (fromGoogle && v.id.slice(-1) === letter ? 1 : 0);
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The Azure voice closest to `voice`: the same locale, else the first voice of the same language family.
 */
export function azureVoiceFor(voice: string): TtsVoice | undefined {
  const lang = voiceLang(voice);
  if (!lang) return undefined;
  const family = lang.split('-')[0];
  const list = [...TTS_VOICES.azure.zh, ...TTS_VOICES.azure.ja];
  return list.find((v) => v.lang === lang) ?? list.find((v) => v.lang.split('-')[0] === family);
}

export type TtsPlan =
  | { kind: 'use'; engine: TtsEngine; voice: string; requestedTier: string; fallback: boolean }
  | { kind: 'browser'; requestedTier: string };

/**
 * What speaks one utterance under the free-tier rule (usage.ts crossesThreshold). The request's own engine and tier are used
 * while they stay within the threshold with this text added. Otherwise, in order: (1) for a Google request, the lower Google
 * tiers of GOOGLE_FALLBACK_CHAIN, each with its closest voice, (2) Azure when it is configured and under the threshold
 * (Google requests only), (3) the browser. An Azure request that is past its allowance goes straight to the browser.
 * `usedOf` gives the characters billed this month for an engine and tier.
 */
export function planTts(body: TtsBody, chars: number | ((engine: TtsEngine, tier: string) => number), usedOf: (engine: TtsEngine, tier: string) => number, azureConfigured: boolean): TtsPlan {
  const requestedTier = ttsBucket(body.engine, body.voice).tier;
  // the billed size can differ per tier (billedChars: Neural2 counts bytes), so each option is checked with its own count
  const charsOf = (engine: TtsEngine, tier: string) => (typeof chars === 'number' ? chars : chars(engine, tier));
  if (!crossesThreshold(usedOf(body.engine, requestedTier), charsOf(body.engine, requestedTier), freeOf(body.engine, requestedTier))) {
    return { kind: 'use', engine: body.engine, voice: body.voice, requestedTier, fallback: false };
  }
  const options: { engine: TtsEngine; voice: string; tier: string }[] = [];
  if (body.engine === 'google') {
    for (const t of GOOGLE_FALLBACK_CHAIN[requestedTier] ?? []) {
      const v = googleVoiceFor(body.voice, t);
      if (v) options.push({ engine: 'google', voice: v.id, tier: t });
    }
    const az = azureConfigured ? azureVoiceFor(body.voice) : undefined;
    if (az) options.push({ engine: 'azure', voice: az.id, tier: 'neural' });
  }
  for (const o of options) {
    if (!crossesThreshold(usedOf(o.engine, o.tier), charsOf(o.engine, o.tier), freeOf(o.engine, o.tier))) {
      return { kind: 'use', engine: o.engine, voice: o.voice, requestedTier, fallback: true };
    }
  }
  return { kind: 'browser', requestedTier };
}

/** the answer for an utterance the browser must speak (the free tier is used up): 429 with the browser fallback marked */
export function browserFallback(requestedTier: string): { status: number; body: unknown; headers: Record<string, string> } {
  return {
    status: 429,
    body: { error: 'free_tier', fallback: 'browser', reason: 'free-tier', message: '本月免費額度快用完了，這句改用瀏覽器語音' },
    headers: { 'X-TTS-Fallback': 'browser', 'X-TTS-Requested-Tier': requestedTier },
  };
}

/** a validated POST body; throws TtsError(400) on anything malformed */
export function parseTtsBody(raw: string): TtsBody {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { throw new TtsError(400, 'bad_request', '請求不是合法的 JSON'); }
  if (!j || typeof j !== 'object') throw new TtsError(400, 'bad_request', '請求內容錯誤');
  const b = j as Record<string, unknown>;
  if (b.engine !== 'azure' && b.engine !== 'google' && b.engine !== 'voicevox') throw new TtsError(400, 'bad_request', 'engine 只能是 azure、google 或 voicevox');
  const engine: TtsEngine = b.engine;
  const knownVoice = engine === 'voicevox'
    ? typeof b.voice === 'string' && isVoicevoxStyle(b.voice)
    : typeof b.voice === 'string' && !!findVoice(engine, b.voice);
  if (typeof b.voice !== 'string' || !knownVoice) throw new TtsError(400, 'bad_request', '不支援的聲音');
  if (typeof b.text !== 'string' || !b.text.trim()) throw new TtsError(400, 'bad_request', 'text 不可為空');
  if (b.text.length > TTS_MAX_TEXT) throw new TtsError(400, 'bad_request', `每次最多 ${TTS_MAX_TEXT} 字`);
  return {
    engine,
    voice: b.voice,
    text: b.text,
    rate: clamp(num(b.rate, 1), 0.5, 2),
    pitch: clamp(num(b.pitch, 1), 0.5, 2),
  };
}

/** a percent change for SSML prosody: 0.05 → "+5%", -0.1 → "-10%" */
export const pct = (x: number): string => {
  const n = Math.round(x * 100);
  return `${n >= 0 ? '+' : ''}${n}%`;
};

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** the Azure REST request for one sentence (pure: no network) */
export function azureRequest(region: string, key: string, voice: string, text: string, rate: number, pitch: number): { url: string; init: RequestInit } {
  const v = findVoice('azure', voice);
  if (!v) throw new Error('voice not in the allowlist');
  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${v.lang}">` +
    `<voice name="${v.id}"><prosody rate="${pct(rate - 1)}" pitch="${pct((pitch - 1) * 0.5)}">${escapeXml(text)}</prosody></voice>` +
    `</speak>`;
  return {
    url: `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    init: {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': AZURE_FORMAT,
        'User-Agent': 'mugi-tutor',
      },
      body: ssml,
    },
  };
}

/** pitch for Google: semitones, one decimal, -20..20 (the client's 0.5..2 maps to -10..+20) */
export const googlePitch = (pitch: number): number => clamp(Math.round((pitch - 1) * 20 * 10) / 10, -20, 20);

/** the Google Cloud TTS request for one sentence (pure: no network); the key goes in a header, never the URL */
export function googleRequest(key: string, voice: string, text: string, rate: number, pitch: number): { url: string; init: RequestInit } {
  const v = findVoice('google', voice);
  if (!v) throw new Error('voice not in the allowlist');
  const body = {
    input: { text },
    voice: { languageCode: v.lang, name: v.id },
    audioConfig: { audioEncoding: 'MP3', speakingRate: rate, pitch: googlePitch(pitch) },
  };
  return {
    url: 'https://texttospeech.googleapis.com/v1/text:synthesize',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
      body: JSON.stringify(body),
    },
  };
}

/** the cache key of a request (the file name on disk is its sha256, see ttsCache.ts); the first four fields never contain '|' */
export const cacheKey = (b: TtsBody): string => [b.engine, b.voice, b.rate, b.pitch, b.text].join('|');

export type TtsDeps = {
  cache: Pick<TtsCache, 'peek' | 'lookup' | 'fetchOnce'>;
  usage: Pick<UsageStore, 'ttsUsed' | 'recordTts' | 'recordTtsCacheHit' | 'recordTtsFallback'>;
  /** the provider call (no cache, no usage) */
  synth: (use: TtsBody) => Promise<Buffer>;
  azureConfigured: boolean;
};

export type TtsAnswer =
  | { kind: 'browser'; requestedTier: string }
  | { kind: 'audio'; buf: Buffer; use: TtsBody; bucket: { engine: TtsEngine; tier: string }; hit: boolean; fellBack: boolean; requestedTier: string };

/** The copy of a key in the order memory → disk cache (.tts-cache). */
async function readCopy(cache: TtsDeps['cache'], key: string, ext: TtsAudioExt): Promise<Buffer | undefined> {
  const mem = cache.peek(key, ext);
  if (mem) return mem;
  return cache.lookup(key, ext);
}

/**
 * One request under the cache and the free-tier rule. A reply cached under the request itself (memory or disk) is served as it
 * is, whatever the usage. Otherwise planTts picks the engine and voice; the reply is then cached, or synthesized once for all
 * concurrent requests with the same key. A cache hit (memory, disk, or a synthesis another request is running) bills nothing
 * and counts as a cache hit; only the request that reaches the provider bills its characters.
 */
export async function answerTts(body: TtsBody, deps: TtsDeps): Promise<TtsAnswer> {
  const { cache, usage } = deps;
  const charsFor = (engine: TtsEngine, tier: string) => billedChars(body.text, engine, tier);
  let use: TtsBody = body;
  let requestedTier = ttsBucket(body.engine, body.voice).tier;
  let buf = await readCopy(cache, cacheKey(body), audioExtOf(body.engine));
  if (!buf && body.engine !== 'voicevox') {
    // VOICEVOX has no allowance, so it never plans a fallback: it is synthesized as asked (or refused when down)
    const plan = planTts(body, charsFor, (e, t) => usage.ttsUsed(e, t), deps.azureConfigured);
    requestedTier = plan.requestedTier;
    if (plan.kind === 'browser') {
      usage.recordTtsFallback({ engine: body.engine, tier: requestedTier });
      return { kind: 'browser', requestedTier };
    }
    use = plan.fallback ? { ...body, engine: plan.engine, voice: plan.voice } : body;
    // the fallback voice may already be cached
    if (use !== body) buf = await readCopy(cache, cacheKey(use), audioExtOf(use.engine));
  }
  const bucket = ttsBucket(use.engine, use.voice);
  const fellBack = use !== body;
  if (fellBack) usage.recordTtsFallback({ engine: body.engine, tier: requestedTier });
  const chars = charsFor(bucket.engine, bucket.tier);
  let hit = buf !== undefined;
  if (!buf) {
    const got = await cache.fetchOnce(cacheKey(use), async () => {
      // usage: a synthesis that reached the provider counts its characters (the text as sent); a failure counts a request and a failure
      let b: Buffer;
      try {
        b = await deps.synth(use);
      } catch (e) {
        usage.recordTts(bucket, { ok: false, chars: 0 });
        throw e;
      }
      usage.recordTts(bucket, { ok: true, chars });
      return b;
    }, audioExtOf(use.engine));
    buf = got.buf;
    hit = got.hit;
  }
  if (hit) usage.recordTtsCacheHit(bucket);
  return { kind: 'audio', buf, use, bucket, hit, fellBack, requestedTier };
}

/**
 * Same-origin check for the routes that act on this PC (VOICEVOX on/off, cache clear). The rule itself is in apiGuard.ts
 * (checkApiRequest); this is that check for a GET, so the socket (must be loopback, or the pairing code), the Host, and the
 * Origin and Sec-Fetch-Site rules apply. `socket` is the request's socket (req.socket): a LAN connection is refused here too.
 */
export function sameOriginRequest(
  headers: { origin?: string; host?: string; 'sec-fetch-site'?: string; socket?: { remoteAddress?: string | undefined } | null },
  opts: GuardOptions = {},
): boolean {
  return checkApiRequest({
    method: 'GET',
    socket: headers.socket,
    headers: { origin: headers.origin, host: headers.host, 'sec-fetch-site': headers['sec-fetch-site'] },
  }, opts).ok;
}

/** a VOICEVOX call gives up after this long (a long line on a slow PC takes seconds, not minutes) */
const VOICEVOX_CALL_MS = 30_000;
/** the status probe: a stopped engine refuses at once; a busy one gets a few seconds (speakers is a large list) */
const VOICEVOX_PROBE_MS = 1500;
/** the status answer is kept this long (the UI asks often; the engine rarely starts or stops) */
export const VOICEVOX_STATUS_TTL_MS = 10_000;

/** the engine could not be reached (not running, or not answering): the client speaks the line with the browser */
const voicevoxDown = (why: string) => new TtsError(503, 'voicevox_down', `VOICEVOX 沒有回應（${why}）`);

/** one request to the engine; a refused connection or a timeout is "down", any other failure is an upstream error */
async function voicevoxCall(f: typeof fetch, base: string, path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let r: Response;
  try {
    r = await f(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw voicevoxDown(e instanceof Error ? e.name : 'unreachable');
  }
  if (!r.ok) {
    console.warn('[tts] voicevox', path.split('?')[0], r.status);
    throw new TtsError(502, 'upstream', `VOICEVOX 錯誤（${r.status}）`);
  }
  return r;
}

/** the speakers of the engine as voices: "<character>・<style>", id = the style id (a string) */
export function voicevoxVoices(speakers: unknown): TtsVoice[] {
  const out: TtsVoice[] = [];
  if (!Array.isArray(speakers)) return out;
  for (const sp of speakers as { name?: unknown; styles?: unknown }[]) {
    if (typeof sp?.name !== 'string' || !Array.isArray(sp.styles)) continue;
    for (const st of sp.styles as { id?: unknown; name?: unknown }[]) {
      if (typeof st?.id !== 'number' || typeof st.name !== 'string') continue;
      out.push({ id: String(st.id), label: `${sp.name}・${st.name}`, lang: 'ja-JP', character: sp.name });
    }
  }
  return out;
}

/**
 * The status probe for VOICEVOX: GET /version and GET /speakers. Up only when both answer. The result is kept for
 * VOICEVOX_STATUS_TTL_MS; the URL, fetch and clock are injectable for the tests.
 */
export function createVoicevoxStatus(opts: { base: () => string; fetch: typeof fetch; now: () => number; ttlMs?: number }) {
  let cached: { at: number; info: VoicevoxInfo } | undefined;
  let probing: Promise<VoicevoxInfo> | undefined;
  const probe = async (): Promise<VoicevoxInfo> => {
    const base = opts.base();
    const get = (path: string, ms: number) => opts.fetch(`${base}${path}`, { signal: AbortSignal.timeout(ms) });
    try {
      const v = await get('/version', VOICEVOX_PROBE_MS);
      if (!v.ok) return { up: false, voices: [] };
      const s = await get('/speakers', 5000);
      if (!s.ok) return { up: false, voices: [] };
      const voices = voicevoxVoices(await s.json());
      return { up: true, voices };
    } catch {
      return { up: false, voices: [] };
    }
  };
  return {
    async info(): Promise<VoicevoxInfo> {
      const t = opts.now();
      if (cached && t - cached.at < (opts.ttlMs ?? VOICEVOX_STATUS_TTL_MS)) return cached.info;
      // one probe at a time: concurrent status calls share it
      probing ??= probe().then((info) => {
        cached = { at: opts.now(), info };
        probing = undefined;
        return info;
      });
      return probing;
    },
  };
}

/** the status probe of this server process (the dev server's /api/tts/status uses it) */
export const voicevoxStatus = createVoicevoxStatus({ base: () => voicevoxUrl(), fetch: (u, i) => fetch(u, i), now: () => Date.now() });

/** the speech a VOICEVOX style makes of a text: audio_query, then synthesis at neutral settings (speed 1, pitch 0; the client shapes them) */
export async function voicevoxSynthesize(base: string, style: string, text: string, f: typeof fetch = fetch): Promise<Buffer> {
  const q = await voicevoxCall(f, base, `/audio_query?speaker=${encodeURIComponent(style)}&text=${encodeURIComponent(text)}`, { method: 'POST' }, VOICEVOX_CALL_MS);
  const query = (await q.json().catch(() => null)) as Record<string, unknown> | null;
  if (!query || typeof query !== 'object') throw new TtsError(502, 'upstream', 'VOICEVOX 回應錯誤');
  rememberVisemes(style, text, query); // the mouth timing of this sentence (server/visemes.ts), sent with the audio
  query.speedScale = 1;
  query.pitchScale = 0;
  const s = await voicevoxCall(f, base, `/synthesis?speaker=${encodeURIComponent(style)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
  }, VOICEVOX_CALL_MS);
  return Buffer.from(await s.arrayBuffer());
}

/** audio_query only (no synthesis): the mouth timing of a sentence not synthesized by this process (a cache hit after a restart) */
async function voicevoxQueryVisemes(style: string, text: string, f: typeof fetch = fetch): Promise<Viseme[]> {
  try {
    const q = await voicevoxCall(f, voicevoxUrl(), `/audio_query?speaker=${encodeURIComponent(style)}&text=${encodeURIComponent(text)}`, { method: 'POST' }, VOICEVOX_CALL_MS);
    const query = (await q.json().catch(() => null)) as unknown;
    return query && typeof query === 'object' ? rememberVisemes(style, text, query) : [];
  } catch {
    return [];
  }
}

/** the most VOICEVOX syntheses that may wait (the running one included); a request beyond that is refused with 429 */
export const VOICEVOX_QUEUE_MAX = 8;
let voicevoxChain: Promise<unknown> = Promise.resolve();
let voicevoxPending = 0;

/**
 * calls run one after another: one local engine does one synthesis at a time, a burst of lines waits its turn (up to
 * VOICEVOX_QUEUE_MAX). Every call to the engine goes through here: syntheses and the mouth-timing queries alike.
 */
export function voicevoxQueued<T>(job: () => Promise<T>): Promise<T> {
  if (voicevoxPending >= VOICEVOX_QUEUE_MAX) {
    return Promise.reject(new TtsError(429, 'busy', 'VOICEVOX 忙碌中（排隊已滿），請稍後再試'));
  }
  voicevoxPending++;
  const run: Promise<T> = voicevoxChain.then(job, job);
  voicevoxChain = run.catch(() => undefined);
  return run.finally(() => {
    voicevoxPending--;
  });
}

/** a cloud synthesis (Azure, Google) gives up after this long; a timeout is a failed request like any other upstream error */
export const CLOUD_TTS_CALL_MS = 20_000;

/** one cloud synthesis request, with a time limit covering the response and its body */
export async function cloudSynthesize(
  c: TtsConfig,
  b: Pick<TtsBody, 'engine' | 'voice' | 'text' | 'rate' | 'pitch'>,
  f: typeof fetch = fetch,
  timeoutMs: number = CLOUD_TTS_CALL_MS,
): Promise<Buffer> {
  const req = b.engine === 'azure'
    ? azureRequest(c.azureRegion, c.azureKey, b.voice, b.text, b.rate, b.pitch)
    : googleRequest(c.googleKey, b.voice, b.text, b.rate, b.pitch);
  let r: Response;
  try {
    r = await f(req.url, { ...req.init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new TtsError(502, 'upstream', '連不上語音服務');
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    console.warn('[tts]', b.engine, r.status, text.slice(0, 200));
    throw new TtsError(502, 'upstream', `語音服務錯誤（${r.status}）`);
  }
  // the body can also run out of time after the headers came in: that is the same failed request
  let body: Buffer | undefined;
  try {
    if (b.engine === 'azure') body = Buffer.from(await r.arrayBuffer());
    else {
      const j = (await r.json().catch(() => null)) as { audioContent?: unknown } | null;
      if (typeof j?.audioContent !== 'string') throw new TtsError(502, 'upstream', '語音服務回應錯誤');
      body = Buffer.from(j.audioContent, 'base64');
    }
  } catch (e) {
    if (e instanceof TtsError) throw e;
    throw new TtsError(502, 'upstream', '連不上語音服務');
  }
  return body;
}

async function synthesize(c: TtsConfig, b: TtsBody): Promise<Buffer> {
  if (b.engine === 'voicevox') {
    return voicevoxQueued(() => voicevoxSynthesize(voicevoxUrl(), b.voice, b.text));
  }
  return cloudSynthesize(c, b);
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new TtsError(413, 'bad_request', '請求太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function fail(res: ServerResponse, e: unknown) {
  // VOICEVOX is down: the client speaks this line with the browser voice (no error is shown)
  if (e instanceof TtsError && e.code === 'voicevox_down') return json(res, 503, { error: e.code, message: e.message, fallback: 'browser' });
  if (e instanceof TtsError) return json(res, e.status, { error: e.code, message: e.message });
  console.warn('[tts]', e instanceof Error ? e.message : e);
  return json(res, 500, { error: 'server', message: '伺服器錯誤' });
}

async function handleTts(req: IncomingMessage, res: ServerResponse, root: string, mode: string, guard: GuardOptions) {
  const url = (req.url ?? '/').split('?')[0];
  const cfg = readTtsConfig(root, mode);
  if (req.method === 'GET' && url.replace(/\/$/, '') === '/status') return json(res, 200, ttsStatus(cfg, await voicevoxStatus.info()));
  if (req.method === 'POST' && url.replace(/\/$/, '') === '/cache/clear') return clearCache(req, res, root, guard);
  if (req.method !== 'POST' || (url !== '/' && url !== '')) return json(res, 404, { error: 'not_found', message: '沒有這個 API' });

  let body: TtsBody;
  try {
    body = parseTtsBody(await readBody(req));
  } catch (e) {
    return fail(res, e);
  }
  if ((body.engine === 'azure' || body.engine === 'google') && !engineConfigured(cfg, body.engine)) return json(res, 503, { error: 'no_key', message: NO_KEY[body.engine] });

  let a: TtsAnswer;
  try {
    a = await answerTts(body, {
      cache: getTtsCache(root),
      usage: getUsageStore(root),
      synth: (use) => synthesize(cfg, use),
      azureConfigured: engineConfigured(cfg, 'azure'),
    });
  } catch (e) {
    return fail(res, e);
  }
  if (a.kind === 'browser') {
    console.log(`[tts] ${body.engine} ${a.requestedTier} past 90% of the free tier: browser fallback`);
    const fb = browserFallback(a.requestedTier);
    return json(res, fb.status, fb.body, fb.headers);
  }
  console.log(`[tts] ${a.use.engine} ${a.use.voice} ${billedChars(body.text, a.bucket.engine, a.bucket.tier)} chars ${a.hit ? 'cache' : 'synth'}${a.fellBack ? ` (fallback from ${a.requestedTier})` : ''}`);
  const headers: Record<string, string | number> = {
    'Content-Type': audioTypeOf(a.use.engine), 'Content-Length': a.buf.length, 'Cache-Control': 'no-store',
    'X-TTS-Engine': a.use.engine, 'X-TTS-Voice': a.use.voice, 'X-TTS-Tier': a.bucket.tier,
  };
  if (a.fellBack) {
    headers['X-TTS-Fallback'] = 'free-tier';
    headers['X-TTS-Requested-Tier'] = a.requestedTier;
  }
  if (a.use.engine === 'voicevox') {
    // mouth timing for the tutor's lip-sync: remembered when synthesized here, else asked from the engine (audio_query only;
    // best effort: a missing timing just means the amplitude fallback on the phone)
    // the query goes through the same queue as the syntheses (one engine call at a time); a refusal or failure means no timing
    const vis = recalledVisemes(a.use.voice, body.text)
      ?? (await voicevoxQueued(() => voicevoxQueryVisemes(a.use.voice, body.text)).catch(() => [] as Viseme[]));
    if (vis.length) headers['X-TTS-Visemes'] = encodeVisemes(vis);
  }
  res.writeHead(200, headers);
  res.end(a.buf);
}

/** POST /api/tts/cache/clear: empties the speech cache (same origin only) */
async function clearCache(req: IncomingMessage, res: ServerResponse, root: string, guard: GuardOptions) {
  if (!sameOriginRequest({ origin: req.headers.origin, host: req.headers.host, 'sec-fetch-site': req.headers['sec-fetch-site'], socket: req.socket }, guard)) {
    return json(res, 403, { error: 'forbidden', message: '只能從這個伺服器的頁面清除' });
  }
  const r = await getTtsCache(root).clear();
  console.log(`[tts-cache] cleared ${r.files} file(s), ${(r.bytes / 1024 / 1024).toFixed(1)} MB`);
  return json(res, 200, { removed: r.files, freedBytes: r.bytes });
}

/** Vite plugin: mounts the speech endpoint on the dev server. */
export function ttsPlugin(): Plugin {
  let root = process.cwd();
  let mode = 'development';
  return {
    name: 'mugi-tts',
    apply: 'serve',
    configResolved(cfg) {
      root = cfg.root;
      mode = cfg.mode;
    },
    configureServer(server) {
      mountTts(server.middlewares, root, mode, guardOptionsFrom(server));
    },
  };
}

/** Shared route registration for development and the private production server. */
export function mountTts(middlewares: import("connect").Server, root: string, mode: string, guard: import("./apiGuard.ts").GuardOptions) {
  // the disk cache is scanned and trimmed to its cap once, here at startup
  getTtsCache(root);

  const sameOrigin = (h: Parameters<typeof sameOriginRequest>[0]) => sameOriginRequest(h, guard);
  // VOICEVOX on/off (server/voicevoxProcess.ts): the same-origin guard of the cache clear route
  const vvRoute = voicevoxRoute(createVoicevoxProcess(defaultVoicevoxDeps(sameOrigin)), { sameOrigin });
  middlewares.use('/api/voicevox', guardApi((req, res) => {
    vvRoute(req, res).catch((e: unknown) => {
      console.warn('[voicevox]', e instanceof Error ? e.message : e);
      if (!res.headersSent) json(res, 500, { error: 'server', message: '伺服器錯誤' });
    });
  }, guard));
  middlewares.use('/api/tts', guardApi((req, res) => {
    handleTts(req, res, root, mode, guard).catch((e: unknown) => {
      console.warn('[tts]', e instanceof Error ? e.message : e);
      if (!res.headersSent) json(res, 500, { error: 'server', message: '伺服器錯誤' });
      else if (!res.writableEnded) res.end();
    });
  }, guard));
}
