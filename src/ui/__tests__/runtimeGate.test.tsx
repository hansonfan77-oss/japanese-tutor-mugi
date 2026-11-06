// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeGate } from '../RuntimeGate';
import { configureBrowserRuntime, browserSpeechAllowed } from '../../game/browserRuntime';
import { speechCtor } from '../useSpeechInput';
import { previewVoice, unlockSpeech, ttsActive, setTtsSettings } from '../../game/tts';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.restoreAllMocks(); configureBrowserRuntime('normal'); });
describe('acceptance browser speech boundary', () => {
  it('blocks STT constructors, preview, speech unlock and stored voice enable settings', () => {
    configureBrowserRuntime('acceptance');
    const constructor = vi.fn(); const speak = vi.fn();
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak, getVoices: () => [] } });
    expect(speechCtor({ SpeechRecognition: constructor })).toBeNull();
    setTtsSettings({ on: true });
    previewVoice('ja'); unlockSpeech();
    expect(ttsActive()).toBe(false); expect(speak).not.toHaveBeenCalled(); expect(constructor).not.toHaveBeenCalled();
  });
  it('shows the server acceptance banner before mounting tutor content', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ mode: 'acceptance' })));
    const el = document.createElement('div'); const root = createRoot(el);
    await act(async () => { root.render(<RuntimeGate><p>人物設定</p></RuntimeGate>); });
    expect(el.textContent).toContain('驗收模式：外部 AI／雲端語音已停用');
    expect(el.textContent).toContain('人物設定'); expect(browserSpeechAllowed()).toBe(false);
    await act(async () => root.unmount());
  });
  it('fails closed when the server policy is missing or invalid', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ mode: 'typo' })));
    const el = document.createElement('div'); const root = createRoot(el);
    await act(async () => { root.render(<RuntimeGate><p>must not mount</p></RuntimeGate>); });
    expect(el.textContent).toContain('無法確認'); expect(el.textContent).not.toContain('must not mount');
    expect(browserSpeechAllowed()).toBe(false);
    await act(async () => root.unmount());
  });
});
