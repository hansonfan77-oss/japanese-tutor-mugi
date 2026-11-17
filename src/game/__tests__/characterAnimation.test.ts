import { describe, expect, it } from 'vitest';
import { CharacterAnimator, characterState, type CharacterSignals } from '../characterAnimation';
const idle: CharacterSignals = { speaking: false, cue: null, level: 0 };
describe('layered character animation core', () => {
  it('arbitrates six states deterministically, prioritizing audio and input', () => {
    expect(characterState(idle, null)).toBe('Idle');
    expect(characterState(idle, 'Happy')).toBe('Happy');
    expect(characterState(idle, 'Confused')).toBe('Confused');
    expect(characterState({ ...idle, thinking: true }, 'Happy')).toBe('Thinking');
    expect(characterState({ ...idle, listening: true, thinking: true }, null)).toBe('Listening');
    expect(characterState({ ...idle, speaking: true, listening: true, thinking: true }, null)).toBe('Speaking');
  });
  it('expires emotions even when speaking masks them; cancellation returns to idle', () => {
    const a = new CharacterAnimator(0);
    a.express('Happy', 0, 1000);
    expect(a.frame(100, idle).state).toBe('Happy');
    expect(a.frame(500, { ...idle, speaking: true }).state).toBe('Speaking');
    expect(a.frame(1100, idle).state).toBe('Idle');
    a.express('Confused', 1200, 0);
    expect(a.frame(1200, idle).state).toBe('Idle');
  });
  it('reuses viseme timeline and blink clock; closes mouth on stop', () => {
    const a = new CharacterAnimator(0, { rng: () => 0, takes: [1] });
    expect(a.frame(100, { ...idle, speaking: true, cue: { v: 'a', i: 1 } }).mouth).toEqual({ take: 1, viseme: 'a' });
    expect(a.frame(200, idle).mouth).toBeNull();
    expect(a.frame(3000, idle).eyes.closed).toBe(true);
    expect(a.frame(3121, idle).eyes.closed).toBe(false);
  });
  it('uses original amplitude mouth when no timeline exists', () => {
    const a = new CharacterAnimator(0);
    expect(a.frame(100, { ...idle, speaking: true, level: 0.9 }).mouth?.viseme).toBe('a');
  });
  it('smooths state transitions and bounds motion over a long mobile session', () => {
    const a = new CharacterAnimator(0);
    expect(Math.abs(a.frame(40, { ...idle, listening: true }).head.rotation)).toBeLessThan(1.5);
    for (let t = 80; t < 60_000; t += 40) {
      const p = a.frame(t, { ...idle, thinking: t % 1000 < 500, listening: t % 1000 >= 500 });
      expect(Math.abs(p.head.rotation)).toBeLessThanOrEqual(1.5);
      expect(Math.abs(p.body.y)).toBeLessThanOrEqual(0.25);
      expect(Math.abs(p.body.scale - 1)).toBeLessThanOrEqual(0.0021);
    }
  });
  it('honors reduced motion and independent layer disabling', () => {
    const a = new CharacterAnimator(0, { reducedMotion: true, parts: { eyes: false, mouth: false } });
    const p = a.frame(3000, { ...idle, speaking: true, level: 1 });
    expect(p.body).toEqual({ x: 0, y: 0, rotation: 0, scale: 1 });
    expect(p.head.rotation).toBe(0);
    expect(p.eyes.closed).toBe(false); expect(p.mouth).toBeNull();
  });
  it('handles suspended/backward clocks without jumping or mutating returned poses', () => {
    const a = new CharacterAnimator(0);
    const p = a.frame(100_000, { ...idle, listening: true });
    expect(Math.abs(p.head.rotation)).toBeLessThan(1.5);
    p.head.rotation = 999;
    expect(a.frame(10, idle).head.rotation).not.toBe(999);
  });
});
