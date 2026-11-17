// @vitest-environment jsdom
// Settings › AI 服務 (SettingsSections AiServiceSection): the rows in the player's order, 上移／下移, the switches (the last one
// on cannot be turned off), the ChatGPT sign-in (only on the PC), the model choice, and the sign-in's failure message.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { AiServiceSection } from '../SettingsSections';
import type { ChatGptStatus } from '../../game/openaiStatus';

function render(node: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

const SIGNED_IN: ChatGptStatus = {
  signedIn: true, planEnabled: true, email: 'me@example.com',
  models: [{ slug: 'gpt-5.5-sol', label: 'GPT 5.5 Sol' }, { slug: 'gpt-5.4', label: 'GPT 5.4' }],
};
const SIGNED_OUT: ChatGptStatus = { signedIn: false, planEnabled: false, models: [] };

const button = (host: HTMLElement, label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;
const switchOf = (host: HTMLElement, label: string) => host.querySelector(`input[aria-label="${label} 使用"]`) as HTMLInputElement;
const rowLabels = (host: HTMLElement) => [...host.querySelectorAll('.as-ai-item > .as-row > span:first-child')].map((s) => s.childNodes[0]?.textContent);

afterEach(() => {
  document.body.innerHTML = '';
});

describe('AiServiceSection', () => {
  it('lists the services in the order the player keeps them; a service that is off comes after', () => {
    const r = render(<AiServiceSection providers={['openai', 'anthropic']} openaiModel="" claudeOk chatgpt={SIGNED_IN} onChange={() => {}} onRefresh={() => {}} localPc />);
    expect(r.host.querySelector('h3')?.textContent).toBe('AI 服務');
    expect(rowLabels(r.host)).toEqual(['ChatGPT', 'Claude']);
    r.unmount();
    const off = render(<AiServiceSection providers={['anthropic']} openaiModel="" claudeOk chatgpt={SIGNED_OUT} onChange={() => {}} onRefresh={() => {}} localPc />);
    expect(rowLabels(off.host)).toEqual(['Claude', 'ChatGPT']);
    off.unmount();
  });

  it('上移 swaps the row with the one above and saves the new order', () => {
    const onChange = vi.fn();
    const r = render(<AiServiceSection providers={['anthropic', 'openai']} openaiModel="" claudeOk chatgpt={SIGNED_IN} onChange={onChange} onRefresh={() => {}} localPc />);
    const up = r.host.querySelector('button[aria-label="ChatGPT 上移"]') as HTMLButtonElement;
    expect(up.disabled).toBe(false);
    act(() => up.click());
    expect(onChange).toHaveBeenCalledWith({ providers: ['openai', 'anthropic'] });
    expect((r.host.querySelector('button[aria-label="Claude 上移"]') as HTMLButtonElement).disabled).toBe(true);
    r.unmount();
  });

  it('the last service that is on cannot be switched off; turning a service on adds it to the end', () => {
    const onChange = vi.fn();
    const r = render(<AiServiceSection providers={['anthropic']} openaiModel="" claudeOk chatgpt={SIGNED_IN} onChange={onChange} onRefresh={() => {}} localPc />);
    expect(switchOf(r.host, 'Claude').checked).toBe(true);
    expect(switchOf(r.host, 'Claude').disabled).toBe(true);
    act(() => switchOf(r.host, 'ChatGPT').click());
    expect(onChange).toHaveBeenCalledWith({ providers: ['anthropic', 'openai'] });
    r.unmount();
  });

  it('with both on, switching one off keeps the other', () => {
    const onChange = vi.fn();
    const r = render(<AiServiceSection providers={['openai', 'anthropic']} openaiModel="" claudeOk chatgpt={SIGNED_IN} onChange={onChange} onRefresh={() => {}} localPc />);
    act(() => switchOf(r.host, 'ChatGPT').click());
    expect(onChange).toHaveBeenCalledWith({ providers: ['anthropic'] });
    r.unmount();
  });

  it('the Claude row says whether its key is set', () => {
    const r = render(<AiServiceSection providers={['anthropic']} openaiModel="" claudeOk={false} chatgpt={SIGNED_OUT} onChange={() => {}} onRefresh={() => {}} localPc />);
    expect(r.host.textContent).toContain('未設定金鑰（在電腦的 .env.local 填 ANTHROPIC_API_KEY）');
    r.unmount();
  });

  it('from a phone there is no sign-in button and no paste field: the note says ChatGPT signs in and out only on the PC', () => {
    const r = render(<AiServiceSection providers={['anthropic']} openaiModel="" claudeOk chatgpt={SIGNED_OUT} onChange={() => {}} onRefresh={() => {}} localPc={false} />);
    expect(button(r.host, '用 ChatGPT 登入')).toBeUndefined();
    expect(r.host.querySelector('input[aria-label="登入後的網址"]')).toBeNull();
    expect(r.host.textContent).toContain('ChatGPT 只能在電腦上登入或登出');
    r.unmount();
  });

  it('from a phone, signed in: no 登出 button, but the model select still works', () => {
    const onChange = vi.fn();
    const r = render(<AiServiceSection providers={['openai']} openaiModel="gpt-5.4" claudeOk chatgpt={SIGNED_IN} onChange={onChange} onRefresh={() => {}} localPc={false} />);
    expect(r.host.textContent).toContain('已登入（me@example.com）');
    expect(button(r.host, '登出')).toBeUndefined();
    const select = r.host.querySelector('select[aria-label="ChatGPT 模型"]') as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    act(() => {
      select.value = 'gpt-5.5-sol';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({ openaiModel: 'gpt-5.5-sol' });
    r.unmount();
  });

  it('from a phone the Claude key is a status line only: no key box and no save button', () => {
    const r = render(<AiServiceSection providers={['anthropic']} openaiModel="" claudeOk chatgpt={SIGNED_OUT} onChange={() => {}} onRefresh={() => {}} localPc={false} />);
    expect(r.host.querySelector('input[aria-label="Claude 金鑰"]')).toBeNull();
    expect(r.host.textContent).toContain('金鑰只能在電腦上設定');
    r.unmount();
  });

  it('signed in: the status shows the account, 登出 is there, and a model select lists the plan’s models', () => {
    const onChange = vi.fn();
    const r = render(<AiServiceSection providers={['openai']} openaiModel="gpt-5.4" claudeOk chatgpt={SIGNED_IN} onChange={onChange} onRefresh={() => {}} localPc />);
    expect(r.host.textContent).toContain('已登入（me@example.com）');
    expect(button(r.host, '用 ChatGPT 登入')).toBeUndefined();
    expect(button(r.host, '登出')).toBeDefined();
    const select = r.host.querySelector('select[aria-label="ChatGPT 模型"]') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['gpt-5.5-sol', 'gpt-5.4']);
    expect(select.value).toBe('gpt-5.4');
    act(() => {
      select.value = 'gpt-5.5-sol';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({ openaiModel: 'gpt-5.5-sol' });
    r.unmount();
  });

  it('a model that is not listed stays selected with a warning', () => {
    const r = render(<AiServiceSection providers={['openai']} openaiModel="gone" claudeOk chatgpt={SIGNED_IN} onChange={() => {}} onRefresh={() => {}} localPc />);
    expect((r.host.querySelector('select[aria-label="ChatGPT 模型"]') as HTMLSelectElement).value).toBe('gone');
    expect(r.host.textContent).toContain('不會自動替換');
    r.unmount();
  });

  it('a note says the ChatGPT sign-in uses the plan and is not shared', () => {
    const r = render(<AiServiceSection providers={['anthropic']} openaiModel="" claudeOk chatgpt={SIGNED_OUT} onChange={() => {}} onRefresh={() => {}} localPc />);
    expect(r.host.textContent).toContain('不需要 OpenAI API 金鑰');
    r.unmount();
  });
});


describe('T1 model catalog messages', () => {
  it.each([
    ['error', '模型目錄取得失敗'], ['empty', '此帳號目前沒有可見模型'], ['incompatible', '帳號可見模型目前均不相容'],
  ] as const)('%s has its own Chinese message and preserves the saved model', (modelStatus, message) => {
    const onChange = vi.fn();
    const onRefresh = vi.fn();
    const r = render(<AiServiceSection providers={['openai']} openaiModel="saved-model" claudeOk={false}
      chatgpt={{ ...SIGNED_IN, models: [], modelStatus }} onChange={onChange} onRefresh={onRefresh} localPc />);
    expect(r.host.textContent).toContain(message);
    expect((r.host.querySelector('select') as HTMLSelectElement).value).toBe('saved-model');
    expect(onChange).not.toHaveBeenCalled();
    act(() => button(r.host, '重新整理模型').click());
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(switchOf(r.host, 'Claude').checked).toBe(false);
    r.unmount();
  });

  it('keeps sign-in separate from plan consent and offers reauthorization on the PC', () => {
    const r = render(<AiServiceSection providers={['openai']} openaiModel="" claudeOk={false}
      chatgpt={{ ...SIGNED_IN, planEnabled: false, models: [] }} onChange={() => {}} onRefresh={() => {}} localPc />);
    expect(r.host.textContent).toContain('尚未授權 ChatGPT 方案使用權');
    expect(button(r.host, '用 ChatGPT 登入')).toBeDefined();
    r.unmount();
  });
});
