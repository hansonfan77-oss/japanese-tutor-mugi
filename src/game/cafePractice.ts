// Each reply sets up the learner's next turn. Only finished exchanges enter the receipt.
export const greeting = 'いらっしゃいませ。店内でお召し上がりですか？';
export const cafeOrder = [
  { goal: '告訴店員你要內用', learner: '店内でお願いします。', reply: 'かしこまりました。ご注文はお決まりですか？' },
  { goal: '點一杯拿鐵', learner: 'カフェラテを一つください。', reply: 'カフェラテですね。ホットとアイス、どちらになさいますか？' },
  { goal: '選擇冰拿鐵', learner: 'アイスでお願いします。', reply: 'アイスですね。サイズはいかがなさいますか？' },
  { goal: '選擇中杯', learner: 'Mサイズでお願いします。', reply: 'はい。ほかにご注文はございますか？' },
  { goal: '結束點餐並致謝', learner: '以上です。ありがとうございます。', reply: 'ありがとうございます。こちらの番号札をお持ちください。' },
] as const;

export type CafeEvent = 'partial' | 'recognized' | 'reply' | 'finished';

/** Browser-only stand-in for capture, recognition, reply and playback. No media or transport. */
export function simulateCafeTurn(emit: (event: CafeEvent) => void) {
  const timers = [
    window.setTimeout(() => emit('partial'), 700),
    window.setTimeout(() => emit('recognized'), 2200),
    window.setTimeout(() => emit('reply'), 3400),
    window.setTimeout(() => emit('finished'), 6800),
  ];
  return () => timers.forEach(timer => window.clearTimeout(timer));
}

type Phase = 'ready' | 'listening' | 'thinking' | 'playing' | 'paused' | 'cancelled' | 'complete' | 'expired';
export const initialPractice = {
  phase: 'ready' as Phase, turn: 0, attempt: 0, partial: false, interrupted: false,
  remaining: 300_000, deadline: null as number | null,
};
type Practice = typeof initialPractice;
type Action =
  | { type: 'start' | 'interrupt' | 'cancel' | 'pause' | 'tick'; now: number }
  | { type: 'event'; attempt: number; event: CafeEvent; now: number };

export function practiceReducer(state: Practice, action: Action): Practice {
  const remaining = state.deadline === null ? state.remaining : Math.max(0, state.deadline - action.now);
  if (remaining === 0) return { ...state, phase: 'expired', remaining, deadline: null };
  switch (action.type) {
    case 'tick':
      return { ...state, remaining };
    case 'pause':
      if (state.phase === 'complete' || state.phase === 'paused') return state;
      return { ...state, phase: 'paused', remaining, deadline: null, partial: false, interrupted: false };
    case 'interrupt':
    case 'start': {
      const interrupted = action.type === 'interrupt';
      if (interrupted ? state.phase !== 'playing' : !['ready', 'paused', 'cancelled'].includes(state.phase)) return state;
      return { ...state, phase: 'listening', partial: false, attempt: state.attempt + 1, interrupted,
        deadline: state.deadline ?? action.now + remaining };
    }
    case 'cancel':
      if (!['listening', 'thinking', 'playing'].includes(state.phase)) return state;
      return { ...state, phase: 'cancelled', partial: false, interrupted: false };
    case 'event':
      if (action.attempt !== state.attempt) return state;
      if (action.event === 'partial' && state.phase === 'listening') return { ...state, partial: true };
      if (action.event === 'recognized' && state.phase === 'listening') return { ...state, phase: 'thinking', interrupted: false };
      if (action.event === 'reply' && state.phase === 'thinking') return { ...state, phase: 'playing' };
      if (action.event === 'finished' && state.phase === 'playing') {
        const turn = state.turn + 1;
        const complete = turn === cafeOrder.length;
        return { ...state, turn, partial: false, phase: complete ? 'complete' : 'ready', remaining, deadline: complete ? null : state.deadline };
      }
      return state;
  }
}
