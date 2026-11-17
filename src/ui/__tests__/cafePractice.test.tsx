// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import App from '../../App';
import * as cafe from '../../game/cafePractice';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

it('rejects already queued capture, reply and playback events across retries, hiding and re-entry from the tutor', async () => {
  // Keep callbacks after cancellation, like events already enqueued by a transport.
  const attempts: { emit: (event: cafe.CafeEvent) => void; stop: ReturnType<typeof vi.fn> }[] = [];
  vi.spyOn(cafe, 'simulateCafeTurn').mockImplementation(emit => {
    const stop = vi.fn();
    attempts.push({ emit, stop });
    return stop;
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => new Response(JSON.stringify(
    url === '/api/runtime' ? { mode: 'acceptance' } : {},
  )));
  // jsdom does not implement the native modal lifecycle; Chromium exercises it below in CI.
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) { this.open = true; },
    close(this: HTMLDialogElement) { this.open = false; },
  });
  const el = document.body.appendChild(document.createElement('div'));
  const root = createRoot(el);
  const click = async (label: string) => {
    const button = [...el.querySelectorAll('button')].find(b => b.textContent === label);
    expect(button, label).toBeDefined();
    await act(() => button!.click());
  };
  const event = (n: number, type: cafe.CafeEvent) => act(() => attempts[n].emit(type));
  const status = () => el.querySelector('dialog [role=status]')?.textContent;
  const turn = () => el.querySelector('.cafe-step')?.textContent;
  try {
    await act(async () => root.render(<App />));
    await click('咖啡店語音練習');
    await click('模擬說這句');
    await event(0, 'partial');
    expect(el.querySelector('.cafe-dialogue')?.textContent).toContain('店内で…');
    await click('取消這一輪');
    expect(attempts[0].stop).toHaveBeenCalledOnce();
    await click('重試這一輪');
    await event(0, 'partial');
    await event(0, 'recognized');
    expect(el.querySelector('.cafe-dialogue')?.textContent).not.toContain('店内で…');
    expect(status()).toBe('聆聽中');
    await event(1, 'recognized');
    await event(0, 'reply');
    expect(status()).toBe('Mugi 思考中');
    await event(1, 'reply');
    await click('打斷並重說');
    expect(attempts[1].stop).toHaveBeenCalledOnce();
    expect(status()).toBe('已打斷播放，重新聆聽中');
    await event(2, 'recognized');
    await event(2, 'reply');
    await event(1, 'finished');
    expect(status()).toBe('Mugi 播放中');
    expect(turn()).toContain('1 / 5');
    await event(2, 'finished');
    expect(turn()).toContain('2 / 5');
    await click('模擬說這句');
    await event(3, 'recognized');
    await act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(attempts[3].stop).toHaveBeenCalledOnce();
    await event(3, 'reply');
    expect(status()).toBe('練習已暫停');
    await click('繼續練習');
    expect(turn()).toContain('2 / 5');
    await click('離開練習');
    expect(attempts[4].stop).toHaveBeenCalledOnce();
    await click('咖啡店語音練習');
    await click('模擬說這句');
    await event(4, 'recognized');
    expect(status()).toBe('聆聽中');
    expect(turn()).toContain('1 / 5');
  } finally {
    await act(() => root.unmount());
    el.remove();
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
    vi.restoreAllMocks();
  }
});
