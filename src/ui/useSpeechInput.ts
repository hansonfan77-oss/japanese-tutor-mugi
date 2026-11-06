import { browserSpeechAllowed } from '../game/browserRuntime';
import { useCallback, useEffect, useRef, useState } from 'react';

// Web Speech API (Chrome / Edge / Safari; Safari exposes it as webkitSpeechRecognition). Only the members used here are
// typed: lib.dom's speech typings are partial and differ by version, so they are not relied on.
export interface SpeechAlternative { readonly transcript: string; readonly confidence: number }
export interface SpeechResult { readonly isFinal: boolean; readonly length: number; readonly [i: number]: SpeechAlternative }
export interface SpeechResultEvent { readonly results: { readonly length: number; readonly [i: number]: SpeechResult } }
export interface SpeechErrorEvent { readonly error: string }
export interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onaudiostart?: (() => void) | null;
  onsoundstart?: (() => void) | null;
  onspeechstart?: (() => void) | null;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: ((e: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export type SpeechCtor = new () => SpeechRecognitionLike;

export interface SpeechHandlers {
  /** interim text while she is hearing you (the whole utterance so far) */
  onPartial?: (text: string) => void;
  /** the recognised utterance, trimmed and never empty */
  onFinal?: (text: string) => void;
  /** listening began (dictation: once, at the beginning, not per session) */
  onStart?: () => void;
  /** every result of a recognition event as the browser lists them (the session's results, from its first one), before
   *  the handlers above; a caller that takes the results itself (the speaking module) uses this and not onPartial/onFinal */
  onResults?: (results: readonly { transcript: string; isFinal: boolean }[]) => void;
  /** one recognition session is over (in dictation the next session starts after this, from result 0 again) */
  onSessionEnd?: () => void;
  /** listening is over; `gotFinal` tells whether a non-empty final text was delivered (dictation: during the whole dictation) */
  onEnd?: (gotFinal: boolean) => void;
  /** error code from the browser (not-allowed, no-speech, network, aborted, service-not-allowed, unsupported, start-failed …)
   *  or from a watchdog (no-start: never started; no-speech: no result after the silence timeout) */
  onError?: (error: string) => void;
}

export interface SpeechOptions {
  /** BCP-47 language of the recognizer, e.g. 'zh-TW' (default) or 'ja-JP' */
  lang?: string;
  /**
   * dictation: keep listening across pauses. A session that ends (onend, a watchdog, a silence) is followed by a new one
   * in the same language, quietly; only stop(), a fatal error or DICTATION_IDLE_MS without any result ends it.
   * Every final text is reported via onFinal, the interim via onPartial; the caller accumulates. Default false.
   */
  dictation?: boolean;
  /**
   * one long session for a caller that records while it listens (the speaking module): the session is not cut by the
   * 15 s limit or by the 1.2 s pause after a final text, since every cut starts a new session that misses the speech
   * said while it starts. It still ends by the browser's end, an error, the silence / idle limits, or stop(). Default false.
   */
  holdSession?: boolean;
}

/** watchdog timings in ms (see useSpeechInput) */
export const SPEECH_TIMING = { start: 2000, silence: 7000, max: 15000, end: 1500, final: 1200 } as const;
/** dictation: no result for this long ends it */
export const DICTATION_IDLE_MS = 60000;
/** dictation: after an error (not a clean end) the next session starts after this delay */
export const DICTATION_RESTART_AFTER_ERROR_MS = 300;
/** dictation: these browser errors end the dictation; any other ends one session and a new one starts */
export const DICTATION_FATAL_ERRORS: readonly string[] = ['not-allowed', 'service-not-allowed', 'unsupported', 'start-failed', 'audio-capture'];

// the last events of speech sessions, for diagnosing a session that got stuck (seconds since page load)
const traceBuf: string[] = [];
function trace(ev: string) {
  traceBuf.push(`${(performance.now() / 1000).toFixed(2)}s ${ev}`);
  if (traceBuf.length > 40) traceBuf.shift();
}
/** the recent speech events (onstart, onresult, watchdog fired …), oldest first */
export function speechTrace(): string[] { return traceBuf.slice(); }

/** the recognition constructor of this browser, or null when there is none (iOS Home Screen apps may lack it) */
export function speechCtor(w: unknown = typeof window === 'undefined' ? undefined : window): SpeechCtor | null {
  if (!browserSpeechAllowed()) return null;
  const ww = w as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor } | undefined;
  return ww?.SpeechRecognition ?? ww?.webkitSpeechRecognition ?? null;
}

/** all results of the utterance joined (continuous is off, so there is normally one), and whether the last one is final */
export function readTranscript(e: SpeechResultEvent): { text: string; isFinal: boolean } {
  let text = '';
  let isFinal = false;
  for (let i = 0; i < e.results.length; i++) {
    const r = e.results[i];
    text += r[0]?.transcript ?? '';
    isFinal = r.isFinal;
  }
  return { text: text.trim(), isFinal };
}

/** the results of a recognition event as plain objects, in the order the browser lists them (see SpeechHandlers.onResults) */
export function resultsOf(e: SpeechResultEvent): { transcript: string; isFinal: boolean }[] {
  const out: { transcript: string; isFinal: boolean }[] = [];
  for (let i = 0; i < e.results.length; i++) {
    const r = e.results[i];
    out.push({ transcript: r[0]?.transcript ?? '', isFinal: r.isFinal });
  }
  return out;
}

type Wd = 'start' | 'silence' | 'max' | 'end' | 'final';
type Ctl = { stop: () => void; dispose: () => void };
interface Dictation {
  stopReq: boolean; // stop() was called (or the idle limit ran out): no new session
  gotFinal: boolean; // a non-empty final text was delivered during this dictation
  notified: boolean; // onStart has fired
  noStart: number; // sessions in a row that never started
  idle?: ReturnType<typeof setTimeout>;
  restart?: ReturnType<typeof setTimeout>;
}

/**
 * Voice input: start() listens in `opts.lang` (default zh-TW; read at each start(), so a change applies to the next
 * session) and reports interim / final text; stop() ends the utterance (the final text still arrives). Pure logic, no UI.
 * A second start() while one is running is ignored; unmount aborts it silently.
 *
 * Watchdogs (iOS Home Screen web apps sometimes never fire onstart / onresult / onend):
 *  - start:   no onstart/onaudiostart within 2 s            -> abort, onError('no-start')
 *  - silence: no onresult within 7 s of start               -> stop (abort if no onend in 1.5 s), onError('no-speech')
 *  - max:     15 s in total                                  -> stop (abort if no onend in 1.5 s), no error
 *  - end:     after stop() / a browser error, no onend 1.5 s -> abort, end silently
 *  - final:   a final text arrived and nothing more for 1.2 s -> abort, end (the text was already delivered)
 * Every session end runs the same cleanup: timers cleared, listening false, onEnd(gotFinal) called once.
 *
 * Dictation (opts.dictation): the same sessions, but a session end starts the next one (see SpeechOptions.dictation);
 * the silence watchdog only restarts quietly; onStart / onEnd fire once for the whole dictation.
 */
export function useSpeechInput(handlers: SpeechHandlers, opts: SpeechOptions = {}) {
  const [supported] = useState(() => speechCtor() !== null);
  const [listening, setListening] = useState(false);
  const hRef = useRef(handlers);
  hRef.current = handlers;
  const langRef = useRef(opts.lang ?? 'zh-TW');
  langRef.current = opts.lang ?? 'zh-TW';
  const dictationRef = useRef(false);
  dictationRef.current = opts.dictation === true;
  const holdRef = useRef(false);
  holdRef.current = opts.holdSession === true;
  const rec = useRef<SpeechRecognitionLike | null>(null); // the session that may still report (stale ones are ignored)
  const ctl = useRef<Ctl | null>(null); // the current session's stop / dispose
  const dict = useRef<Dictation | null>(null); // the dictation in progress (null when none)

  // the dictation is over: timers cleared, listening false, onError (if any), onEnd once
  const endDictation = useCallback((code: string) => {
    const d = dict.current;
    if (!d) return;
    clearTimeout(d.idle);
    clearTimeout(d.restart);
    dict.current = null;
    setListening(false);
    if (code) hRef.current.onError?.(code);
    hRef.current.onEnd?.(d.gotFinal);
  }, []);

  // the idle limit: no result for DICTATION_IDLE_MS -> the dictation stops (its current session is asked to finish)
  const armIdle = useCallback((d: Dictation) => {
    clearTimeout(d.idle);
    d.idle = setTimeout(() => {
      trace('dictation idle limit');
      d.stopReq = true;
      if (ctl.current) ctl.current.stop();
      else endDictation('');
    }, DICTATION_IDLE_MS);
  }, [endDictation]);

  // one recognition session (in dictation: also the follow-up sessions, started from the previous one's end)
  const launchRef = useRef<() => void>(() => {}); // the session itself calls the next one through this
  const launch = useCallback(() => {
    if (rec.current) return; // already listening (or ending)
    const Ctor = speechCtor();
    // a failure before a session exists: the dictation ends with it, otherwise it is just reported
    const failStart = (code: string) => { if (dict.current) endDictation(code); else hRef.current.onError?.(code); };
    if (!Ctor) { failStart('unsupported'); return; }
    let r: SpeechRecognitionLike;
    try {
      r = new Ctor();
      r.lang = langRef.current;
      r.interimResults = true;
      r.continuous = false;
      r.maxAlternatives = 1;
    } catch {
      failStart('start-failed');
      return;
    }
    trace('start');
    const mine = () => rec.current === r;
    let gotFinal = false;
    let pendingPartial = ''; // the last interim text of this session, not yet final (dictation delivers it when the session ends)
    let done = false; // this session is over: every late event and timer is ignored
    let pending = ''; // error code to report when the session ends (the silence watchdog)
    const timers: Partial<Record<Wd, ReturnType<typeof setTimeout>>> = {};
    const cancel = (k: Wd) => {
      const id = timers[k];
      if (id !== undefined) clearTimeout(id);
      delete timers[k];
    };
    const later = (k: Wd, ms: number, fn: () => void) => {
      cancel(k);
      timers[k] = setTimeout(() => {
        delete timers[k];
        if (done) return;
        trace(`watchdog ${k}`);
        fn();
      }, ms);
    };
    // drop the session: no timers, no current session (used by every way out)
    const drop = () => {
      done = true;
      (Object.keys(timers) as Wd[]).forEach(cancel);
      if (rec.current === r) rec.current = null;
      if (ctl.current === me) ctl.current = null;
    };
    // the session is over. Plain listening: clean up, report (code first, then onEnd), let the caller stop listening.
    // Dictation: keep the text, then a new session, or the end of the dictation (stopped / fatal error / no-start twice)
    const finish = (code: string) => {
      if (done) return;
      drop();
      hRef.current.onSessionEnd?.();
      const d = dict.current;
      if (d) {
        if (pendingPartial) { gotFinal = true; d.gotFinal = true; hRef.current.onFinal?.(pendingPartial); }
        if (d.stopReq) { endDictation(code === 'no-speech' || code === 'aborted' ? '' : code); return; }
        if (DICTATION_FATAL_ERRORS.includes(code)) { endDictation(code); return; }
        if (code === 'no-start' && ++d.noStart >= 2) { endDictation(code); return; }
        if (code && code !== 'no-speech' && code !== 'aborted') {
          d.restart = setTimeout(() => {
            d.restart = undefined;
            if (dict.current === d && !d.stopReq) launchRef.current();
          }, DICTATION_RESTART_AFTER_ERROR_MS);
        } else launchRef.current();
        return;
      }
      setListening(false);
      if (code) hRef.current.onError?.(code);
      hRef.current.onEnd?.(gotFinal);
    };
    // ask it to finish; if onend does not come soon after, abort it and finish anyway
    const stopAndWait = (code: string) => {
      if (done) return;
      if (code) pending = code;
      trace('stop');
      try { r.stop(); } catch { /* already ended */ }
      later('end', SPEECH_TIMING.end, () => {
        try { r.abort(); } catch { /* ignore */ }
        finish(pending);
      });
    };
    const me: Ctl = {
      stop: () => stopAndWait(''),
      dispose: () => {
        if (done) return;
        drop();
        try { r.abort(); } catch { /* ignore */ }
      },
    };

    r.onstart = () => {
      trace('onstart');
      if (!mine()) return;
      cancel('start');
      const d = dict.current;
      if (d) {
        d.noStart = 0;
        if (d.notified) return;
        d.notified = true;
      }
      hRef.current.onStart?.();
    };
    r.onaudiostart = () => { trace('onaudiostart'); if (mine()) cancel('start'); };
    r.onsoundstart = () => trace('onsoundstart');
    r.onspeechstart = () => trace('onspeechstart');
    r.onresult = (e) => {
      trace('onresult');
      if (!mine()) return;
      cancel('start');
      cancel('silence');
      const d = dict.current;
      if (d) armIdle(d);
      hRef.current.onResults?.(resultsOf(e));
      const { text, isFinal } = readTranscript(e);
      if (isFinal) {
        pendingPartial = '';
        if (text) { gotFinal = true; if (d) d.gotFinal = true; hRef.current.onFinal?.(text); }
      } else {
        pendingPartial = text;
        hRef.current.onPartial?.(text);
      }
      // a final text but no onend: end it ourselves once nothing more comes
      if (gotFinal && !holdRef.current) later('final', SPEECH_TIMING.final, () => {
        try { r.abort(); } catch { /* ignore */ }
        finish('');
      });
    };
    r.onerror = (e) => {
      trace(`onerror ${e.error}`);
      if (!mine()) return;
      // dictation: the end of the session decides (fatal -> the dictation ends with it, otherwise a new session)
      if (dict.current) pending = e.error;
      else hRef.current.onError?.(e.error);
      // the browser normally follows an error with onend; if not, end the session
      later('end', SPEECH_TIMING.end, () => {
        try { r.abort(); } catch { /* ignore */ }
        finish(dict.current ? pending : '');
      });
    };
    r.onend = () => {
      trace('onend');
      if (mine()) finish(pending);
    };

    rec.current = r;
    setListening(true);
    try {
      r.start();
    } catch {
      rec.current = null;
      if (dict.current) endDictation('start-failed');
      else {
        setListening(false);
        hRef.current.onError?.('start-failed');
      }
      return;
    }
    ctl.current = me;
    later('start', SPEECH_TIMING.start, () => {
      try { r.abort(); } catch { /* ignore */ }
      finish('no-start');
    });
    later('silence', SPEECH_TIMING.silence, () => stopAndWait('no-speech'));
    if (!holdRef.current) later('max', SPEECH_TIMING.max, () => stopAndWait(''));
  }, [endDictation, armIdle]);
  launchRef.current = launch;

  const start = useCallback(() => {
    if (rec.current || dict.current) return; // already listening (or ending, or a dictation waits for its next session)
    if (dictationRef.current) {
      if (!speechCtor()) { hRef.current.onError?.('unsupported'); return; }
      const d: Dictation = { stopReq: false, gotFinal: false, notified: false, noStart: 0 };
      dict.current = d;
      armIdle(d);
      setListening(true);
    }
    launch();
  }, [launch, armIdle]);

  const stop = useCallback(() => {
    const d = dict.current;
    if (d) {
      d.stopReq = true;
      clearTimeout(d.restart);
      if (ctl.current) ctl.current.stop(); // its final text still arrives, then onEnd
      else endDictation('');
      return;
    }
    ctl.current?.stop();
  }, [endDictation]);

  // unmount: drop the session so no late callback or timer touches the (gone) component
  useEffect(() => () => {
    ctl.current?.dispose();
    const d = dict.current;
    if (d) {
      clearTimeout(d.idle);
      clearTimeout(d.restart);
      dict.current = null;
    }
  }, []);

  return { supported, listening, start, stop };
}

export const SPEECH_UNSUPPORTED_TEXT = '此瀏覽器不支援語音辨識，請用鍵盤上的麥克風（聽寫）輸入';

/** short Chinese line for a recognition error; '' = nothing to say (the user stopped it themselves) */
export function speechErrorText(code: string): string {
  switch (code) {
    case 'not-allowed': return '需要允許麥克風權限';
    case 'no-speech': return '沒有聽到聲音，再試一次？';
    case 'no-start': return '語音辨識沒有啟動，請改用鍵盤上的麥克風（聽寫）';
    case 'aborted': return '';
    case 'unsupported': return SPEECH_UNSUPPORTED_TEXT;
    default: return '語音辨識無法使用，請改用鍵盤聽寫'; // network, service-not-allowed, start-failed …
  }
}

/** the mic note: the message, plus the stage code for the start / silence watchdogs so a screenshot shows where it stopped */
export function speechNoteText(code: string): string {
  const base = speechErrorText(code);
  return base && (code === 'no-start' || code === 'no-speech') ? `${base}（${code}）` : base;
}
