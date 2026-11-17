import { useEffect, useReducer, useRef, useState } from 'react';
import { cafeOrder, greeting, initialPractice, practiceReducer, simulateCafeTurn } from '../game/cafePractice';
import { BUILTIN_CHARACTERS } from '../game/tutorCharacters';
import type { TutorArt, TutorFaceInput } from '../game/tutorFace';
import { DEFAULT_SCENE } from '../game/tutorScene';
import { ZOOM_IDENTITY } from '../game/tutorZoom';
import { VISEME_CODES } from '../game/visemes';
import { TutorPortrait } from './TutorPortrait';
import './cafePractice.css';

const labels = {
  ready: '輪到你了', listening: '聆聽中', thinking: 'Mugi 思考中', playing: 'Mugi 播放中',
  paused: '練習已暫停', cancelled: '已取消這一輪', complete: '點餐完成', expired: '五分鐘練習結束',
};
const quiet = (): TutorFaceInput => ({ speaking: false, cue: null, level: 0 });
const playback = (now: number): TutorFaceInput => {
  const i = Math.floor(now / 180);
  return { speaking: true, cue: { v: VISEME_CODES[i % VISEME_CODES.length], i }, level: 0 };
};

export function CafePractice({ art, onExit }: { art: TutorArt | null; onExit: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, dispatch] = useReducer(practiceReducer, initialPractice);
  const [zoom, setZoom] = useState({ on: false, dragging: false, view: ZOOM_IDENTITY });
  const { phase, turn, attempt, deadline } = state;
  const active = phase === 'listening' || phase === 'thinking' || phase === 'playing';
  const ended = phase === 'complete' || phase === 'expired';
  const line = cafeOrder[turn];

  useEffect(() => {
    const el = dialog.current!;
    el.showModal();
    const pause = () => dispatch({ type: 'pause', now: performance.now() });
    const visibility = () => { if (document.hidden) pause(); };
    visibility();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pause);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', pause);
      el.close();
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    return simulateCafeTurn(event => {
      if (!document.hidden) dispatch({ type: 'event', attempt, event, now: performance.now() });
    });
  }, [active, attempt]);
  useEffect(() => {
    if (deadline === null) return;
    const id = window.setInterval(() => dispatch({ type: 'tick', now: performance.now() }), 250);
    return () => window.clearInterval(id);
  }, [deadline]);

  const seconds = Math.ceil(state.remaining / 1000);
  const status = state.interrupted && phase === 'listening' ? '已打斷播放，重新聆聽中' : labels[phase];
  const learner = phase === 'listening' ? (state.partial ? line.learner.slice(0, 3) + '…' : '') : active ? line.learner : '';
  const prompt = turn === 0 ? greeting : cafeOrder[turn - 1].reply;
  const act = (type: 'start' | 'interrupt' | 'cancel') => dispatch({ type, now: performance.now() });
  return (
    <dialog className="cafe-practice" ref={dialog} aria-labelledby="cafe-heading" onCancel={e => { e.preventDefault(); onExit(); }}>
      <header className="cafe-header">
        <div><small>五分鐘日語練習</small><h1 id="cafe-heading">咖啡店點餐</h1></div>
        <button onClick={onExit}>離開練習</button>
      </header>
      <div className="cafe-scene" style={{ backgroundImage: `url("${import.meta.env.BASE_URL}${DEFAULT_SCENE.file}")` }}>
        <TutorPortrait art={art} artDir={BUILTIN_CHARACTERS.mugi.artDir} label="Mugi"
          zoom={{ state: zoom, set: setZoom }} faceInput={phase === 'playing' ? playback : quiet} />
        <span className="cafe-state" data-phase={phase} role="status">{status}</span>
      </div>
      <section className="cafe-counter">
        <div className="cafe-meta"><b>語音模擬 · 無收音與聲音</b><time aria-label="剩餘時間">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</time></div>
        {ended ? <h2>{phase === 'complete' ? '點餐完成，おつかれさま！' : '時間到了，休息一下吧。'}</h2> : <>
          <p className="cafe-step">第 {turn + 1} / {cafeOrder.length} 輪</p>
          <h2>{line.goal}</h2>
          <div className="cafe-dialogue" aria-live="polite">
            <p><b>Mugi</b><span lang="ja">{phase === 'playing' ? line.reply : prompt}</span></p>
            <p><b>{active ? '你' : '試著說'}</b><span lang="ja">{active ? learner || '…' : line.learner}</span></p>
          </div>
          <div className="cafe-actions">
            {!active && <button className="cafe-primary" onClick={() => act('start')}>
              {phase === 'paused' ? '繼續練習' : phase === 'cancelled' ? '重試這一輪' : '模擬說這句'}
            </button>}
            {phase === 'playing' && <button className="cafe-primary" onClick={() => act('interrupt')}>打斷並重說</button>}
            {active && <button onClick={() => act('cancel')}>取消這一輪</button>}
          </div>
        </>}
        {turn > 0 && <details className="cafe-receipt" key={ended ? 'summary' : 'progress'} open={ended || undefined}>
          <summary>已完成的對話（{turn}）</summary>
          <ol>{cafeOrder.slice(0, turn).map(exchange => <li key={exchange.goal}>
            <p><b>你</b> <span lang="ja">{exchange.learner}</span></p>
            <p><b>Mugi</b> <span lang="ja">{exchange.reply}</span></p>
          </li>)}</ol>
        </details>}
      </section>
    </dialog>
  );
}
