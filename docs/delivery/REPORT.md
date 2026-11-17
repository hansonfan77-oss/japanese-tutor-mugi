# Mugi 無人值守開發交付

## 交付範圍

- **M0 完成**：嚴格 TypeScript build 修復、Linux/Windows VOICEVOX 測試 fixture 修復；保留測試斷言和原功能。
- **M1 雲端程式部分完成**：正式 Node/Connect HTTP host、共用 API 註冊、PWA Service Worker/離線頁、手機可及性與窄螢幕改善、Windows 維運腳本、Tailscale 私人連線與實機驗收文件。未部署 Windows 或公開網路。
- **M2 基礎完成**：六狀態、獨立分層姿勢、平滑/小幅呼吸/自然眨眼/嘴型重用、情緒時效、reduced-motion、測試與素材接線設計。新分層 renderer 尚未接入 UI；既有單圖與嘴型模式保留。
- 後續需求只有規格，沒有擴充學習系統、Ollama、背景生成或正式美術。

## 變更檔案

| 功能 | 檔案 |
| --- | --- |
| M0 | src/game/lookup.ts、src/game/__tests__/voicevoxProcess.test.ts、src/__redteam__/{env-file-write,oauth-callback,prompt-tts-image-limits}.test.ts |
| 正式伺服器 | server/production.ts；server/{claudeChat,tts,usage}.ts 提取共用 API mount；package.json、package-lock.json；.gitignore |
| PWA/手機 | public/{manifest.webmanifest,sw.js,offline.html}；src/pwa.ts、src/main.tsx、index.html、src/ui/tutor.css |
| Windows | scripts/windows/{Install,Start,Stop}.ps1 |
| M2 | src/game/characterAnimation.ts、src/game/__tests__/characterAnimation.test.ts |
| 新測試 | src/game/__tests__/{production,pwa}.test.ts |
| 文件 | docs/private-host.md、docs/animation-design.md、docs/future-spec.md、docs/delivery/{M0,REPORT}.md、docs/delivery/PR.md |

## 驗證證據

- 完整測試：93 檔、1422 passed、1 skipped、0 failed。跳過原有未啟動真實 VOICEVOX 引擎的音訊整合測試。未削弱測試、跳過新失敗或關閉安全檢查。
- `npm run build`：TypeScript、Vite 前端與 SSR/Node 正式 bundle 成功。
- 實際啟動建置後正式伺服器，以 HTTP 驗證首頁、manifest、SW、離線頁、chat/tts status、usage、health；API 為 no-store，來源碼、.env 與不存在 API 為 404。
- 自動化驗證未知 Host/cross-origin 拒絕、私有檔案隔離、HEAD、靜態 cache headers、SW 不攔截 API/OAuth/POST、公開離線 fallback，以及動畫狀態/時鐘/幅度。
- AI 流程沿用專案 mocks；沒有真實 AI 呼叫、登入或開通付費 API。
- PowerShell、Tailscale、手機 PWA/麥克風/FPS 未實機測試，不能宣稱已驗收。
- 額外單跑既有 VOICEVOX suite（26 通過、1 跳過）曾在暫存目錄清理後輸出非致命 tts-cache ENOENT 警告；完整 suite 未出現。屬既有測試非同步清理觀察，不代表真實引擎驗收。

## 分支、提交與恢復

工作分支 `feat/mugi-private-pwa-animation` 已推送 origin，未修改或合併 main。

- `ac6c3ee` M0 strict build / portable tests
- `2bfeebe` M1 private production / PWA / Windows
- `9fc3a63` M2 animation core / future specification
- 後續收尾提交包含本報告、PR 說明、Windows 相容性及跨磁碟靜態路徑防護；以 `git log` 查看完整 SHA。

Git HTTPS push 成功。`gh pr create --draft` 的 GitHub GraphQL 請求回覆 Forbidden，因此 **未建立 Draft PR**。GitHub API 能力與 Git push 權限不同；沒有讀取或抽取代理持有的憑證。PR 內容保存在 docs/delivery/PR.md，可於有權限的環境執行：

```bash
git fetch origin
git switch --track origin/feat/mugi-private-pwa-animation
# 若本機已有分支，直接 git switch feat/mugi-private-pwa-animation
# 擁有 GitHub API 權限後：
gh pr create --repo hansonfan77-oss/japanese-tutor-mugi --base main --head feat/mugi-private-pwa-animation --draft --title "Prepare private PWA hosting, repair builds, and add animation core" --body-file docs/delivery/PR.md
```

## 目前可檢查的手機功能

建置版含主畫面 manifest/圖示、正式模式 SW、離線重連提示、可縮放 viewport、窄螢幕表單與 focus 樣式。保留人物自訂/圖像/背景、原有話題/聊天/語音/讀音/小提醒介面。雲端只做 HTTP/單元及 mock 驗證，沒有提供公網或 localhost 預覽連結；要在手機使用須先完成私人 Windows/Tailscale 設定。

## 尚待驗收及風險

1. Windows：依 docs/private-host.md 測安裝、啟停、DPAPI/ACL、PID 重用防護、日誌、3 次健康失敗/5 次重啟上限、異常斷電後操作。腳本尚未由 PowerShell 執行。
2. Android/iOS：PWA 安裝、橫向/鍵盤/安全邊界/放大、STT 權限與背景恢復；原生 SpeechRecognition 支援仍取決於瀏覽器與系統。
3. 供應商：ChatGPT OAuth 不保證環境相容；VOICEVOX/真實 AI 未驗證。不開通付費服務；有金鑰時原有 Claude 與雲端語音仍按供應商收費。
4. 伺服器只綁 loopback，但 tailnet 裝置仍可能消耗既有 AI 額度；須限制 Tailscale ACL，不開 Funnel/公網代理。手機機密修改限制不放寬。
5. SW 不快取敏感資料；原有 localStorage/IndexedDB 仍保存使用者聊天與圖片，移除 PWA 未必清除網站資料。日誌可能含原有供應商錯誤，分享前檢查。
6. M2 未有正式分層素材、手機 FPS/耗電與配準數據，先完成 renderer 接線與效能基準再擴大。

下一階段：Windows/手機 M1 實機驗收 → M2 分層 renderer 接線 → 本機學習進度及固定題練習。其他需求詳見 docs/future-spec.md。
