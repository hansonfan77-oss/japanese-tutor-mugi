# 獨立驗收模式與 Windows 部署準備

## 本輪範圍

延續 `feat/mugi-private-pwa-animation`、Draft PR #1，不回退舊版、不合併 main。新增伺服器強制驗收模式、完整資料根隔離、明確 Node ZIP 選擇及相應測試。沒有連線私人小 PC、修改正式資料/憑證/Tailscale，也沒有真實 AI/OAuth/付費語音呼叫；M2/UI 素材及 M3 不在此輪施工。

## 實作摘要

- `server/runtimePolicy.ts`：模式驗證與不可變啟動政策，預設 acceptance；缺少資料根/模式錯誤/髒 checkout/所有權不符/資料 junction 都拒絕啟動。不讀取 `.env` 或登入內容以決定模式。
- `server/appRuntime.ts`、`server/production.ts`：驗收時不掛載 chat/tts/OAuth/VOICEVOX handlers、不初始化 credentials/client/engine；只有本機安全狀態與隔離用量可以讀取。所有其他 API/auth 操作（含未知圖片生成入口）423 拒絕。原有 normal 路由、guard 與停止機制保留。`/api/runtime` 顯示政策，health 另帶 runMode。
- `vite.config.ts`：開發伺服器與正式 bundle 使用同一政策；驗收 Build 禁用 dotenv 的 envDir。測試 runner 不再自動初始化整個 app runtime，而是由測試明確選擇 normal/acceptance。
- `src/ui/RuntimeGate.tsx`、`src/game/browserRuntime.ts`、App/tts/useSpeechInput/TutorView：先核對伺服器模式才掛載家教；模式未知時 fail closed。驗收顯示明確橫幅，停用 STT、瀏覽器朗讀、試聽及語音 fallback，不引導使用者填真實金鑰。
- `scripts/windows/Tools.ps1`、Install/Start/Stop：完整 ZIP NodeHome 驗證；明確 v24，npm CLI、Build 子程序及 server 同源；僅程序 PATH 暫存更動，不改全機設定。驗收使用 3006、專屬標記根及乾淨 checkout；normal 顯式選擇，維持 3004 與原路徑。原有鎖、owner、建立時間與 PID 重用防護保留。
- 驗收 config/API 寫入被拒，OAuth 根不讀；`.usage`、`.tts-cache`、npm config/cache、日誌/控制/停止檔均映射到專屬根。細項及 origin 隔離見 [驗收指南](../acceptance-guide.md)。瀏覽器 localStorage/IndexedDB 不會因伺服器目錄改變而自動隔離或清除。
- 單元測試中與模型路由無關的 Windows 登入儲存改成明確 mock，避免 DPAPI 初始化成為路由測試的逾時來源；原路由斷言保留，真實程序測試另行執行。

## 開發環境證據

- 完整 Vitest：95 檔、**1435 通過、1 跳過、0 失敗**；跳過既有未啟動真實 VOICEVOX 引擎的測試。
- 完整 TypeScript + 前端 + 正式 Node bundle Build 成功。
- 正式 bundle smoke：**3 通過**，包含 normal 健康/公開檔/拒絕私有路徑、埠衝突不殺佔埠者、合作式停止，以及 acceptance 假金鑰/假登入路徑/fallback/未來 API 拒絕。
- acceptance smoke 注入 HTTP(S)/fetch/engine 的禁止探針與正式資料 read/write 哨兵，沒有觸發；假正式資料保持不變。不是只測「沒有金鑰」。
- acceptance route 測試確認 SDK constructor、OAuth/credentials/engine/env reader 及供應商 fetch 沒有呼叫；設定 POST 或變更 process.env 無法解鎖已啟動 server。
- 前端測試確認橫幅、未知政策 fail closed，以及啟用本機語音設定也不能啟動 STT/朗讀。
- PowerShell 7/Linux runtime mock/parser：26 assertions 通過；隔離 npm helper 也在 Linux 以明確 Node/npm 路徑執行成功。Windows ZIP/CIM/Start-Process 的結果不能由此推論。

## Windows CI 與實機界線

CI 新增在 Windows PowerShell 5.1、PowerShell 7 各執行 `Test-Tools.ps1`：真正複製 Node/npm 到含空白路徑，檢查 npm 子程序的 process.execPath/npm_execpath、資料版圖，再啟動專用 fixture 的實際 supervisor/bundle，以 CIM 核對 Node 路徑；合作式 Stop 後確認無關 Node 存活、記錄清理。fixture 只用隨機暫存目錄；沒有使用私人憑證或登入。

最終 CI 結果及完整 SHA 以本輪回報與 PR Checks 為準。若 CI 失敗會先修復，不將新增工作流程本身當作成功證據。**使用者 Windows 小 PC、手機 PWA/版面、Tailscale、麥克風及真實語音仍待實機驗收；驗收模式這一輪刻意不開啟語音。**

## 最短下一步

依 [逐步指南](../acceptance-guide.md) 在小 PC 另 clone 新副本，核對最新 PR SHA；指定完整 Node 24 ZIP，使用新的 AcceptanceRoot 執行 Install/Start。確認 3006 的 runtime=acceptance、外部與瀏覽器語音 false、聊天 POST=423；以新瀏覽器設定檔查看人物/話題，完成後 Stop。先不要接 Tailscale、填金鑰或切 Normal。
