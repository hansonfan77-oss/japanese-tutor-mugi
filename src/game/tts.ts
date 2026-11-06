import { browserSpeechAllowed } from './browserRuntime';
// Her voice: text-to-speech on the browser's speechSynthesis, driven by the reply bus (game/replyBus.ts).
//
// Replies arrive as start / delta / done / error events. A reply is cut into sentences (。！？!? … and newlines), each
// sentence is one SpeechSynthesisUtterance, queued in order, so speech can start before the reply is finished. Lip-sync
// is published through voiceBus while anything is queued (a synthetic oscillating level, boosted on word boundaries).
//
// iOS: speechSynthesis only speaks after a user gesture has touched it once — unlockSpeech() runs on the first tap of the
// voice-chat button. Voices load asynchronously (voiceschanged), so the voice is picked at the moment of speaking.
import { getAudioSettings } from './audio';
import { stripRuby } from './furigana';
import { emitReply, nextReplyId, onReply, type ReplyEvent } from './replyBus';
import { setVoiceSource, type VoiceSource } from './voiceBus';
import { cloudDefaultVoice, cloudStatus, cloudVoiceList, createCloudIo, type CloudEngine } from './cloudTts';
import type { SpeakPlan } from './characterVoice';

export type Lang = 'zh' | 'ja';
/** the voice engine: the device's own speech, or a cloud service (its key lives on the PC, see server/tts.ts) */
export type TtsEngine = 'browser' | CloudEngine;
/**
 * One language's voice. engine, rate (語速) and pitch (音調) are its own. voices: the chosen voice per engine, a browser
 * voice's name or a cloud voice's id; a missing or '' entry means that engine's automatic / default voice.
 */
export type LangVoice = { engine: TtsEngine; rate: number; pitch: number; voices: Partial<Record<TtsEngine, string>> };
export type TtsSettings = { on: boolean; zh: LangVoice; ja: LangVoice };

/**
 * The engines each language's picker offers. VOICEVOX (a local engine on this PC) is offered for Japanese only; it is
 * greyed out while the engine is not running (the status says so). A further engine is one more entry here.
 */
export const ENGINE_CHOICES: Record<Lang, readonly { engine: TtsEngine; label: string }[]> = {
  zh: [{ engine: 'browser', label: 'iPhone 內建' }, { engine: 'azure', label: 'Azure' }, { engine: 'google', label: 'Google' }],
  ja: [{ engine: 'browser', label: 'iPhone 內建' }, { engine: 'azure', label: 'Azure' }, { engine: 'google', label: 'Google' }, { engine: 'voicevox', label: 'VOICEVOX' }],
};

const KEY = 'mugi.tts.v2';
/** the one-engine settings saved before the per-language ones (read once, then the v2 key takes over) */
const KEY_V1 = 'mugi.tts.v1';
const DEFAULT_RATE = 1.05;
const DEFAULT_PITCH = 1;
export const TTS_RATE_RANGE = { min: 0.8, max: 1.3 } as const;
export const TTS_PITCH_RANGE = { min: 0.8, max: 1.3 } as const;
/** both sliders move in 0.01 steps; saved values are rounded to the step */
export const TTS_STEP = 0.01;
const snap = (v: number) => Math.round(v / TTS_STEP) * TTS_STEP;

const clampRate = (r: number) => +snap(Math.min(TTS_RATE_RANGE.max, Math.max(TTS_RATE_RANGE.min, r))).toFixed(2);
const clampPitch = (p: number) => +snap(Math.min(TTS_PITCH_RANGE.max, Math.max(TTS_PITCH_RANGE.min, p))).toFixed(2);
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const ENGINES: readonly TtsEngine[] = ['browser', 'azure', 'google', 'voicevox'];
const engineOf = (v: unknown): TtsEngine => (ENGINES.includes(v as TtsEngine) ? (v as TtsEngine) : 'browser');

/**
 * one language's settings with the numbers clamped and the voice names as strings. VOICEVOX is Japanese only: a Chinese
 * line saved with it (not offered by the picker) becomes the device voice.
 */
function normLang(v: unknown, lang: Lang, fallbackEngine: TtsEngine = 'browser'): LangVoice {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const vs = (o.voices && typeof o.voices === 'object' ? o.voices : {}) as Record<string, unknown>;
  const voices: Partial<Record<TtsEngine, string>> = {};
  for (const e of ENGINES) if (str(vs[e])) voices[e] = str(vs[e]);
  const engine = o.engine === undefined ? fallbackEngine : engineOf(o.engine);
  return {
    engine: lang === 'zh' && engine === 'voicevox' ? 'browser' : engine,
    rate: clampRate(num(o.rate, DEFAULT_RATE)),
    pitch: clampPitch(num(o.pitch, DEFAULT_PITCH)),
    voices,
  };
}

/**
 * Settings as saved. The per-language shape (zh / ja) is taken as it is. The older one-engine shape (one engine, rate
 * and pitch, and the voice names per language) applies the same engine, rate and pitch to both languages.
 */
export function migrateTtsSettings(raw: unknown): TtsSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const on = typeof s.on === 'boolean' ? s.on : true;
  if (s.zh && typeof s.zh === 'object' && s.ja && typeof s.ja === 'object') {
    return { on, zh: normLang(s.zh, 'zh'), ja: normLang(s.ja, 'ja') };
  }
  const engine = engineOf(s.engine);
  const one = (lang: Lang): LangVoice => normLang({
    engine,
    rate: s.rate,
    pitch: s.pitch,
    voices: lang === 'zh'
      ? { browser: s.zhVoice, azure: s.azureZh, google: s.googleZh }
      : { browser: s.jaVoice, azure: s.azureJa, google: s.googleJa },
  }, lang);
  return { on, zh: one('zh'), ja: one('ja') };
}

export const TTS_DEFAULTS: TtsSettings = migrateTtsSettings({});

function loadSettings(): TtsSettings {
  try {
    const v2 = localStorage.getItem(KEY);
    if (v2) return migrateTtsSettings(JSON.parse(v2));
    return migrateTtsSettings(JSON.parse(localStorage.getItem(KEY_V1) ?? 'null'));
  } catch {
    return migrateTtsSettings({});
  }
}
let settings: TtsSettings = loadSettings();
const settingsListeners = new Set<(s: TtsSettings) => void>();

export const getTtsSettings = (): TtsSettings => settings;
export const langSettings = (lang: Lang): LangVoice => settings[lang];
export function setTtsSettings(patch: Partial<TtsSettings>) {
  const before = `${settings.zh.engine}|${settings.ja.engine}`;
  settings = migrateTtsSettings({ ...settings, ...patch });
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode */ }
  // switching an engine mid-reply would mix two voices: the speech in progress is dropped
  if (`${settings.zh.engine}|${settings.ja.engine}` !== before) queue.stop();
  settingsListeners.forEach((l) => l(settings));
}
/** changes one language's settings (its engine, rate, pitch or voices) and keeps the other language as it is */
export function setLangSettings(lang: Lang, patch: Partial<LangVoice>) {
  setTtsSettings({ [lang]: { ...settings[lang], ...patch } } as Partial<TtsSettings>);
}
export function onTtsSettings(l: (s: TtsSettings) => void) {
  settingsListeners.add(l);
  return () => void settingsListeners.delete(l);
}

export const ttsSupported = (): boolean =>
  browserSpeechAllowed() && typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
/** cloud voices need fetch and the Web Audio API (the audio context itself may still be locked until a tap) */
const cloudSupported = (): boolean =>
  typeof window !== 'undefined' && typeof fetch === 'function' &&
  ('AudioContext' in window || 'webkitAudioContext' in window);
/** a language's chosen engine can speak here: the browser's speechSynthesis, or fetch + Web Audio for the cloud engines */
const langAvailable = (lang: Lang): boolean => (settings[lang].engine === 'browser' ? ttsSupported() : cloudSupported());
/** at least one language can be spoken */
export const ttsAvailable = (): boolean => langAvailable('zh') || langAvailable('ja');
/** replies are spoken: the setting is on and the chosen engine can speak */
export const ttsActive = (): boolean => browserSpeechAllowed() && settings.on && ttsAvailable();

// ---------- sentences ----------
const SENTENCE_END = /[^。！？!?…\n]*[。！？!?…\n]+/g;

/** brackets / quote marks are read aloud literally by iOS voices (「右括弧」) — drop them before speaking */
const UNSPOKEN = /[()（）［］[\]{}｛｝【】〈〉《》「」『』"“”'‘’<>＜＞*＊_~～`|｜]/g;
/** at least one letter, digit, kana or CJK character */
const SPEAKABLE = /[\p{L}\p{N}]/u;

/**
 * Text as it should be spoken: no 漢字 readings (学校[がっこう] is said as 学校; the reading is dropped before the brackets
 * are), no bracket/quote marks; '' when nothing speakable is left (e.g. a lone 「）」).
 */
export function speakableText(text: string): string {
  const t = stripRuby(text).replace(/\[[^\]]*$/, '').replace(UNSPOKEN, ' ').replace(/\s+/g, ' ').trim();
  return SPEAKABLE.test(t) ? t : '';
}

/** the complete sentences of `buf` (terminators kept, blanks dropped) and the unfinished tail */
export function takeSentences(buf: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let last = 0;
  for (const m of buf.matchAll(SENTENCE_END)) {
    const s = m[0].trim();
    if (s) sentences.push(s);
    last = (m.index ?? 0) + m[0].length;
  }
  return { sentences, rest: buf.slice(last) };
}

/** kana → Japanese, otherwise Chinese (used when a chunk carries no explicit lang) */
export const detectLang = (s: string): Lang => (/[぀-ヿ]/.test(s) ? 'ja' : 'zh');

export type Seg = { text: string; lang: Lang };

/** streaming sentence cutter: a language switch flushes what is pending first, so one utterance is one language */
export class SentenceBuffer {
  private buf = '';
  private lang: Lang | undefined;
  push(text: string, lang?: Lang): Seg[] {
    const out: Seg[] = [];
    if (lang && this.lang && lang !== this.lang) out.push(...this.flush());
    if (lang) this.lang = lang;
    this.buf += text;
    const { sentences, rest } = takeSentences(this.buf);
    this.buf = rest;
    for (const s of sentences) out.push({ text: s, lang: lang ?? detectLang(s) });
    return out;
  }
  flush(): Seg[] {
    const t = this.buf.trim();
    const lang = this.lang;
    this.buf = '';
    this.lang = undefined;
    return t ? [{ text: t, lang: lang ?? detectLang(t) }] : [];
  }
}

// ---------- voices ----------
export type VoiceLike = { name: string; lang: string };
const norm = (l: string) => l.replace(/_/g, '-').toLowerCase();
const LANG_PREFS: Record<Lang, string[]> = { zh: ['zh-tw', 'zh-hk', 'zh-cn', 'zh'], ja: ['ja-jp', 'ja'] };
const FEMALE = /meijia|美佳|sin-?ji|ting-?ting|yating|hanhan|kyoko|o-?ren|nanami|xiaoxiao|xiaoyi|female|女/i;
/** high-quality (downloaded) iOS/Android voices: 「月（高音質）」「Enhanced」「Premium」 */
const QUALITY = /premium|enhanced|高音質|高品質|增強|增强|优化/i;

/**
 * The best voice for a language: region order (zh-TW, zh-HK, zh-CN, any zh; ja-JP, ja). Inside a region, high-quality
 * voices come first, then female names.
 */
export function pickVoice<V extends VoiceLike>(voices: readonly V[], lang: Lang): V | null {
  const prefs = LANG_PREFS[lang];
  let best: { v: V; key: number } | null = null;
  for (const v of voices) {
    const l = norm(v.lang);
    const rank = prefs.findIndex((p) => l === p || l.startsWith(p + '-'));
    if (rank < 0) continue;
    const key = rank * 4 + (QUALITY.test(v.name) ? 0 : 2) + (FEMALE.test(v.name) ? 0 : 1);
    if (!best || key < best.key) best = { v, key };
  }
  return best?.v ?? null;
}

/** the voice she speaks with: the one chosen in the settings (if installed), else pickVoice */
export function chosenVoice<V extends VoiceLike>(voices: readonly V[], lang: Lang): V | null {
  const want = settings[lang].voices.browser ?? '';
  if (want) {
    const v = voices.find((x) => x.name === want);
    if (v) return v;
  }
  return pickVoice(voices, lang);
}

/** every installed voice of a language (for the settings sheet), sorted by lang then name */
export function listVoices(lang: Lang): { name: string; lang: string }[] {
  if (!ttsSupported()) return [];
  return window.speechSynthesis.getVoices()
    .filter((v) => norm(v.lang).startsWith(lang))
    .map((v) => ({ name: v.name, lang: v.lang }))
    .sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
}

/** called when the browser's voice list changes (voices load asynchronously); returns the unsubscribe */
export function onVoicesChanged(l: () => void): () => void {
  if (!ttsSupported()) return () => {};
  const synth = window.speechSynthesis;
  synth.addEventListener('voiceschanged', l);
  return () => synth.removeEventListener('voiceschanged', l);
}

/** names of the voices she will speak with (for the settings sheet) */
export function voicePicks(): { zh: string | null; ja: string | null } {
  if (!ttsSupported()) return { zh: null, ja: null };
  const voices = window.speechSynthesis.getVoices();
  return { zh: chosenVoice(voices, 'zh')?.name ?? null, ja: chosenVoice(voices, 'ja')?.name ?? null };
}

// ---------- queue ----------
/** `speaker`: the character's own voice for this line (game/characterVoice), set when the line is queued; absent = the 設定 page's voice */
export type Utterance = { text: string; lang: Lang; rate: number; pitch: number; volume: number; speaker?: SpeakPlan; onBoundary: () => void; onDone: () => void };
/** the speech engine behind the queue (the browser in the app, a fake in tests) */
export interface SpeechIo {
  speak(u: Utterance): void;
  cancel(): void;
}
export interface QueueOptions {
  io: SpeechIo;
  /** 語速 and 音調 of a language (each language has its own) */
  rate: (lang: Lang) => number;
  volume: () => number;
  pitch?: (lang: Lang) => number;
  onBusy?: (busy: boolean) => void;
  onBoundary?: () => void;
  /** extra watchdog time per utterance (cloud voices wait for the network first) */
  extraWait?: (lang: Lang) => number;
}

/**
 * One utterance per sentence, handed to the engine in order. `onBusy(true)` when the first one starts, `onBusy(false)`
 * when the last one ends. An utterance that never reports its end (iOS sometimes drops onend) is ended by a watchdog,
 * so the queue cannot stay busy forever. stop() drops everything; late callbacks of dropped utterances are ignored.
 */
export function createSpeechQueue(o: QueueOptions) {
  let gen = 0;
  let pending = 0;
  const setPending = (n: number) => {
    const was = pending > 0;
    pending = n;
    if (was !== pending > 0) o.onBusy?.(pending > 0);
  };
  return {
    enqueue(text: string, lang: Lang, speaker?: SpeakPlan | null) {
      const t = speakableText(text);
      if (!t) return;
      const g = gen;
      const rate = o.rate(lang);
      const base = o.pitch ? o.pitch(lang) : settings[lang].pitch;
      // a character's own voice: the device voice of hers is pitched by her plan (a male one is lower); cloud plans carry their voice
      const sp = lang === 'ja' && speaker ? speaker : undefined;
      const pitch = sp?.kind === 'browser' ? +(base * sp.pitch).toFixed(2) : base;
      let ended = false;
      let wd: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (ended || g !== gen) return;
        ended = true;
        if (wd !== undefined) clearTimeout(wd);
        setPending(pending - 1);
      };
      setPending(pending + 1);
      wd = setTimeout(done, Math.max(6000, (t.length * 600) / rate) + (o.extraWait?.(lang) ?? 0));
      o.io.speak({
        text: t, lang, rate, pitch, volume: o.volume(), ...(sp ? { speaker: sp } : {}),
        onBoundary: () => { if (g === gen) o.onBoundary?.(); },
        onDone: done,
      });
    },
    stop() {
      gen++;
      const was = pending > 0;
      pending = 0;
      o.io.cancel();
      if (was) o.onBusy?.(false);
    },
    busy: () => pending > 0,
  };
}

/**
 * The reply bus → queue bridge. `start` cancels the speech of an earlier reply; `delta` queues the complete sentences
 * (lang from the chunk, else detected); `done` flushes the unfinished tail (or, when the reply never streamed, speaks
 * the whole text); `error` drops the tail.
 */
/**
 * Drops parenthesised asides — （中文翻譯）, (romaji), her （心裡話） — from the spoken text. Stateful, so an aside
 * split across streamed chunks is still skipped. Shown text is unaffected; this only filters what is voiced.
 */
export class AsideFilter {
  private depth = 0;
  push(text: string): string {
    let out = '';
    for (const ch of text) {
      if (ch === '（' || ch === '(') this.depth++;
      else if (ch === '）' || ch === ')') this.depth = Math.max(0, this.depth - 1);
      else if (this.depth === 0) out += ch;
    }
    return out;
  }
}

export function createReplyVoice(q: { enqueue(text: string, lang: Lang, speaker?: SpeakPlan | null): void; stop(): void }, enabled: () => boolean,
  speakerOf: () => SpeakPlan | null = () => null) {
  let buf = new SentenceBuffer();
  let aside = new AsideFilter();
  let streamed = false;
  const say = (segs: Seg[]) => { for (const s of segs) q.enqueue(s.text, s.lang, speakerOf()); };
  const reset = () => { buf = new SentenceBuffer(); aside = new AsideFilter(); streamed = false; };
  return (e: ReplyEvent) => {
    switch (e.type) {
      case 'start':
        q.stop();
        reset();
        return;
      case 'delta': {
        if (!enabled()) return;
        streamed = true;
        const t = aside.push(e.text);
        if (t) say(buf.push(t, e.lang));
        return;
      }
      case 'done': {
        if (enabled()) {
          if (streamed) say(buf.flush());
          else { const whole = new SentenceBuffer(); say([...whole.push(new AsideFilter().push(e.text)), ...whole.flush()]); }
        }
        reset();
        return;
      }
      case 'error':
        reset();
        return;
    }
  };
}

// ---------- lip-sync ----------
const lip = { boost: 0, t: 0, jit: 0.5 };
let busy = false;
let keepAlive: ReturnType<typeof setInterval> | undefined;
const lipSource: VoiceSource = {
  playing: () => busy,
  level() {
    const t = performance.now() / 1000;
    const dt = lip.t ? Math.min(0.1, t - lip.t) : 0;
    lip.t = t;
    lip.jit = Math.min(1, Math.max(0, lip.jit + (Math.random() - 0.5) * 0.35));
    lip.boost *= Math.exp(-dt * 14);
    const wave = 0.5 + 0.5 * Math.sin(2 * Math.PI * 8 * t); // ~8 Hz mouth movement
    const base = 0.25 + 0.55 * wave;
    return Math.min(1, base * (0.85 + 0.3 * lip.jit) + lip.boost);
  },
};

const speakListeners = new Set<(busy: boolean) => void>();
/** whether she is voicing a reply right now (the queue is not empty) */
export const speakingNow = (): boolean => busy;
export function onSpeaking(l: (busy: boolean) => void) {
  speakListeners.add(l);
  return () => void speakListeners.delete(l);
}

// ---------- the browser engine ----------
const live = new Set<SpeechSynthesisUtterance>(); // keeps utterances alive until they end (iOS drops callbacks otherwise)
const browserIo: SpeechIo = {
  speak(u) {
    if (!browserSpeechAllowed()) return;
    const synth = window.speechSynthesis;
    const ut = new SpeechSynthesisUtterance(u.text);
    ut.lang = u.lang === 'ja' ? 'ja-JP' : 'zh-TW';
    const v = chosenVoice(synth.getVoices(), u.lang);
    if (v) { ut.voice = v as SpeechSynthesisVoice; ut.lang = v.lang; }
    ut.rate = u.rate;
    ut.pitch = u.pitch;
    ut.volume = u.volume;
    const end = () => { live.delete(ut); u.onDone(); };
    ut.onboundary = () => u.onBoundary();
    ut.onend = end;
    ut.onerror = end;
    live.add(ut);
    synth.speak(ut);
  },
  cancel() {
    live.clear();
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
  },
};

const voiceVolume = () => {
  const a = getAudioSettings();
  return a.muted ? 0 : Math.min(1, Math.max(0, a.master * a.voice));
};

// ---------- the cloud engines ----------
/** the clip currently playing from a cloud engine (its real loudness), null between clips */
let cloudLevel: VoiceSource | null = null;

/** the voice id for a language and a cloud engine: the saved choice when the server offers it, else the engine's default */
function cloudVoice(lang: Lang, engine: CloudEngine): string {
  const saved = settings[lang].voices[engine] ?? '';
  const offered = cloudVoiceList(engine, lang);
  if (saved && (!cloudStatus() || offered.some((v) => v.id === saved))) return saved;
  return cloudDefaultVoice(engine, lang);
}

/** the cloud engine a language uses, null when the device's voice speaks it */
const cloudEngineOf = (lang: Lang): CloudEngine | null => (settings[lang].engine === 'browser' ? null : settings[lang].engine);

/**
 * One ordered speech path for both languages: a sentence whose language uses a cloud engine is fetched (and played in
 * call order); a sentence whose language uses the device's voice waits its turn and is spoken by the browser. So a mixed
 * reply keeps its order whatever the engines are.
 */
const cloudIo = createCloudIo({
  engine: cloudEngineOf,
  voice: (lang, engine) => cloudVoice(lang, engine),
  fallback: browserIo,
  onLevelSource: (src) => { cloudLevel = src; },
});

/** the engine the queue hands each sentence to */
const dispatchIo: SpeechIo = {
  speak: (u) => cloudIo.speak(u),
  cancel: () => { browserIo.cancel(); cloudIo.cancel(); },
};

/**
 * What the mouth follows while busy. A clip from a cloud engine: its real loudness. A sentence spoken by the browser
 * (a device-voice language, or a failed clip): the synthetic level. Between clips (waiting for the network) the mouth rests.
 */
const voiceLevelSource: VoiceSource = {
  playing: () => busy,
  level() {
    if (cloudLevel?.playing()) return cloudLevel.level();
    return cloudIo.fallbackActive() ? lipSource.level() : 0;
  },
  // a VOICEVOX clip's own mouth timing (none for the device voice or a fallback: the loudness drives the mouth)
  visemeAt: () => (cloudLevel?.playing() && cloudLevel.visemeAt ? cloudLevel.visemeAt() : null),
};

const queue = createSpeechQueue({
  io: dispatchIo,
  rate: (lang) => settings[lang].rate,
  pitch: (lang) => settings[lang].pitch,
  volume: voiceVolume,
  extraWait: (lang) => (cloudEngineOf(lang) ? 15000 : 0),
  onBusy: (b) => {
    busy = b;
    setVoiceSource(b ? voiceLevelSource : null);
    // Chrome pauses long utterances after ~15 s: a periodic resume keeps them going
    clearInterval(keepAlive);
    if (b) keepAlive = setInterval(() => { try { window.speechSynthesis.resume(); } catch { /* ignore */ } }, 10_000);
    speakListeners.forEach((l) => l(b));
  },
  onBoundary: () => { lip.boost = Math.min(1, lip.boost + 0.5); },
});

/** the voice of the character on screen (game/characterVoice speakPlanFor); null = the 設定 page's voice. Set by the tutor screen. */
let speakerNow: SpeakPlan | null = null;
export function setSpeakerVoice(plan: SpeakPlan | null) {
  speakerNow = plan;
}

const replyVoice = createReplyVoice(queue, ttsActive, () => speakerNow);

/** speak a whole reply that is already known (typed chat, tap lines): emitted on the reply bus like a streamed one. `lang`:
 *  the language when it is known (速查, 小提醒: Japanese of kanji only, like 勉強, would read as Chinese); else per sentence */
export function speakReply(text: string, lang?: Lang) {
  const id = nextReplyId();
  emitReply({ type: 'start', id });
  emitReply({ type: 'delta', id, text, ...(lang ? { lang } : {}) });
  emitReply({ type: 'done', id, text });
}

/** subscribe the reply bus to the speech queue; returns the unsubscribe */
export function startSpeakingReplies(): () => void {
  if (typeof window !== 'undefined' && ttsSupported()) {
    try {
      // voices may arrive late: tell the settings sheet to show the picked names again
      window.speechSynthesis.addEventListener?.('voiceschanged', () => settingsListeners.forEach((l) => l(settings)));
    } catch { /* ignore */ }
  }
  return onReply(replyVoice);
}

/** cancel whatever she is saying now */
export function stopSpeaking() {
  queue.stop();
}

const SAMPLE: Record<Lang, string> = { zh: '你好，我是你的日語家教，今天想聊什麼呢？', ja: 'こんにちは、今日は何を話しましょうか。' };
/** speak a sample line with the chosen voice, rate and pitch (the settings sheet's 試聽 button) */
export function previewVoice(lang: Lang) {
  if (!browserSpeechAllowed()) return;
  if (settings[lang].engine === 'browser' && !ttsSupported()) return;
  queue.stop();
  queue.enqueue(SAMPLE[lang], lang);
}

/**
 * Call inside a user gesture (the voice-chat button): iOS only lets speechSynthesis speak after one. A silent
 * utterance does the unlock; the real replies come later from timers.
 */
export function unlockSpeech() {
  if (!ttsSupported()) return;
  try {
    const u = new SpeechSynthesisUtterance('。');
    u.volume = 0;
    u.lang = 'zh-TW';
    window.speechSynthesis.speak(u);
    window.speechSynthesis.resume();
  } catch { /* ignore */ }
}

