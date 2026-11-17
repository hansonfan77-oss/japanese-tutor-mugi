/** Renderer-independent layered animation. No timers, network, audio ownership or AI calls. */
import { TutorFaceClock, type TutorFaceInput, type TutorFaceOptions, type TutorFrame } from './tutorFace';

export type CharacterState = 'Idle' | 'Listening' | 'Thinking' | 'Speaking' | 'Happy' | 'Confused';
export type CharacterSignals = TutorFaceInput & { listening?: boolean; thinking?: boolean };
export type PartTransform = { x: number; y: number; rotation: number; scale: number };
export type CharacterPose = {
  state: CharacterState;
  /** Transforms use art-relative percent units and degrees; each part may be disabled independently. */
  body: PartTransform;
  head: PartTransform;
  eyes: { closed: boolean };
  mouth: TutorFrame['mouth'];
};
export type AnimationOptions = TutorFaceOptions & {
  reducedMotion?: boolean;
  parts?: Partial<Record<'body' | 'head' | 'eyes' | 'mouth', boolean>>;
};
const neutral = (): PartTransform => ({ x: 0, y: 0, rotation: 0, scale: 1 });

/** Voice takes precedence over microphone, pending reply, then transient emotion. */
export function characterState(signals: CharacterSignals, emotion: 'Happy' | 'Confused' | null): CharacterState {
  if (signals.speaking) return 'Speaking';
  if (signals.listening) return 'Listening';
  if (signals.thinking) return 'Thinking';
  return emotion ?? 'Idle';
}

export class CharacterAnimator {
  private readonly face: TutorFaceClock;
  private readonly options: AnimationOptions;
  private last: number;
  private emotion: { state: 'Happy' | 'Confused'; until: number } | null = null;
  private body = neutral();
  private head = neutral();

  constructor(now: number, options: AnimationOptions = {}) {
    this.face = new TutorFaceClock(now, options);
    this.last = now;
    this.options = options;
  }

  /** Explicit local UI intent, never an additional model request. Default emotion lasts 1.8 seconds. */
  express(state: 'Happy' | 'Confused', now: number, durationMs = 1800) {
    this.emotion = { state, until: now + Math.max(0, Math.min(10_000, durationMs)) };
  }

  frame(now: number, signals: CharacterSignals): CharacterPose {
    // Clamp suspended-tab catch-up; reject backward time without destabilizing the pose.
    now = Math.max(this.last, now);
    const dt = Math.min(100, now - this.last);
    this.last = now;
    if (this.emotion && now >= this.emotion.until) this.emotion = null;
    const state = characterState(signals, this.emotion?.state ?? null);
    const face = this.face.frame(now, signals);
    const targetBody = neutral();
    const targetHead = neutral();
    if (!this.options.reducedMotion) {
      // Slow, bounded movement; no layout changes and no full-sprite mouth warping.
      const breath = Math.sin(now * Math.PI * 2 / 4200);
      targetBody.y = breath * 0.25;
      targetBody.scale = 1 + breath * 0.002;
      if (state === 'Listening') targetHead.rotation = -1.5;
      if (state === 'Thinking') targetHead.rotation = 1.5;
      if (state === 'Happy') targetHead.y = -0.4;
      if (state === 'Confused') targetHead.rotation = -2.5;
      if (state === 'Speaking') targetHead.y = -0.2 * Math.min(1, Math.max(0, signals.level));
    }
    const alpha = 1 - Math.exp(-dt / 140);
    const approach = (from: PartTransform, to: PartTransform): PartTransform => ({
      x: from.x + (to.x - from.x) * alpha,
      y: from.y + (to.y - from.y) * alpha,
      rotation: from.rotation + (to.rotation - from.rotation) * alpha,
      scale: from.scale + (to.scale - from.scale) * alpha,
    });
    this.body = approach(this.body, targetBody);
    this.head = approach(this.head, targetHead);
    return {
      state,
      body: this.options.parts?.body === false ? neutral() : { ...this.body },
      head: this.options.parts?.head === false ? neutral() : { ...this.head },
      eyes: { closed: this.options.parts?.eyes !== false && face.closed },
      mouth: this.options.parts?.mouth === false ? null : face.mouth,
    };
  }
}
