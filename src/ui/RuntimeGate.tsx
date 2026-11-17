import { useEffect, useState, type ReactNode } from 'react';
import { configureBrowserRuntime } from '../game/browserRuntime';
import { apiFetch } from '../game/apiFetch';

export function RuntimeGate({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<'loading' | 'error' | 'acceptance' | 'normal'>('loading');
  useEffect(() => {
    let live = true;
    configureBrowserRuntime('unknown');
    void apiFetch('/api/runtime').then(async r => {
      if (!r.ok) throw new Error('runtime');
      const data = await r.json();
      if (data.mode !== 'acceptance' && data.mode !== 'normal') throw new Error('mode');
      if (live) { configureBrowserRuntime(data.mode); setMode(data.mode); }
    }).catch(() => { if (live) setMode('error'); });
    return () => { live = false; configureBrowserRuntime('unknown'); };
  }, []);
  if (mode === 'loading') return <p role="status">正在確認伺服器驗收模式…</p>;
  if (mode === 'error') return <p role="alert">無法確認伺服器模式。語音與家教功能未啟動，請確認服務後重新載入。</p>;
  return <>{mode === 'acceptance' && <aside className="acceptance-banner" role="status">
    驗收模式：外部 AI／雲端語音已停用<br />語音輸入／朗讀亦停用；可驗收話題與人物設定。
  </aside>}{children}</>;
}
