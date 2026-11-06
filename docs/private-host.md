# 私人 Windows 主機與手機 PWA（M1）

## 狀態與成本

雲端已驗證依賴、完整測試、前後端正式建置、正式 HTTP 伺服器與 PWA 快取策略。
Windows PowerShell、Tailscale、Android/iOS 安裝、麥克風、鍵盤與背景恢復 **尚未實機驗收**。
不租主機、不安裝付費服務，也不會自動登入或呼叫真實 AI。原有 Claude API 若自行設定仍會產生原供應商費用；本次不開通。不假設 ChatGPT OAuth 可用；第三方授權相容性、帳號條款及登入回呼必須另行確認。沒有供應商時可操作介面、人物設定、內建話題；對話流程以既有 mock 測試驗證。

## 安裝與正式啟動

使用原有 checkout；Node.js 24 LTS、npm、Windows PowerShell 5.1+ 或 PowerShell 7。
請先保存個人 .env.local、.usage、.tts-cache 與 MugiTutor 登入資料，測試版勿直接覆蓋正式環境。

```powershell
# 在工作分支的 repo 根目錄，首次安裝或更新（先停止伺服器）
powershell.exe -NoProfile -File .\scripts\windows\Install.ps1
# 前景監督程序；請以同一 Windows 帳號執行，完整路徑方便 Stop 安全辨識
powershell.exe -NoProfile -File "C:\path\japanese-tutor-mugi\scripts\windows\Start.ps1" -AllowedHost "your-pc.your-tailnet.ts.net"
# 另一個視窗，停止本專案記錄且可驗證身份的進程
powershell.exe -NoProfile -File .\scripts\windows\Stop.ps1
```

腳本不修改 PowerShell 全機執行原則。若系統禁止腳本，先由主機管理員檢查並選擇適當的本機政策。
Install 使用 npm ci 與完整 build。Start 只執行 `node dist-server/production.js`，**不是 Vite dev 或 preview**。
伺服器僅監聽 127.0.0.1:3004，保留既有 API guards、SSE、漢字讀音、語音、糾錯、自訂角色；Vite 僅做建置和既有 loadEnv 工具，不建立 Vite 開發伺服器。
`npm run dev` 是獨立開發流程；勿與正式伺服器搶占相同埠。

Start 每 10 秒檢查 `/api/health`，連續 3 次失敗停止子進程；退出後等 10 秒重啟，最多累計 5 次，避免錯誤迴圈。健康檢查只代表 HTTP 服務健康，**不代表 AI、VOICEVOX 或手機功能可用**。
日誌在忽略的 `.runtime`，以帳號 SID 限制 ACL，最多保留 5 組 stdout/stderr；不記錄請求或標頭。底層既有程式仍可能輸出供應商錯誤，分享前須去識別。
PID 檔已有時拒絕重複啟動；停止腳本先驗證完整指令路徑與程式名稱，身份不明時拒絕操作，不依 image name 全域關閉 Node。
異常關機留下 PID 檔：確認其中進程已不存在且沒有 Mugi 服務後才手動移除；不得盲目刪除仍在使用的 PID 檔。

可在「工作排程器」建立 **目前使用者** 的登入觸發工作：程式 `powershell.exe`，引數 `-NoProfile -File "完整路徑\scripts\windows\Start.ps1" -AllowedHost "精確的.ts.net主機名"`，起始位置為 repo；不需最高權限，設定「已執行則不啟動新執行個體」。建議先人工測試重啟與停止，再啟用開機維運。登出/無登入時執行需另驗證帳號、檔案權限與 Tailscale 服務；此處不代替安裝 Windows Service。

## Tailscale 私人 HTTPS

在 Windows 主機與手機使用已授權的同一 tailnet，啟用 Tailscale DNS/HTTPS（依目前方案條款，勿購買額外方案）。確認 ACL 僅允許自己的使用端。Start 的 AllowedHost 填精確完整主機名，不要 `.ts.net` 全域後綴。

```powershell
tailscale serve --bg http://127.0.0.1:3004
tailscale serve status
```

在手機打開 status 顯示的私人 HTTPS 主機名稱。**禁止 Funnel、公網轉發、路由器開埠**。
不要執行全域 serve reset，避免影響既有其他服務；移除對應 HTTPS 服務前先查目前 `tailscale serve --help`/status。
只設定 HTTPS Serve，無需把 MUGI_LAN 設成 1。金鑰寫入/ChatGPT 登入仍只接受主機上的真正本機請求；手機不能設定機密或登入。請在主機用本機瀏覽器操作。不要因手機被拒就放寬 guards。

## PWA 與資料保護

原有 manifest 和圖示補上正式模式 Service Worker。Android 可從瀏覽器安裝；iOS Safari 使用「分享 → 加入主畫面」。移除強制禁止縮放的 viewport，保留安全邊界、既有鍵盤處理與 44px 觸控區，補強窄螢幕表單及鍵盤焦點。手機語音輸入仍使用原有瀏覽器 SpeechRecognition；不支援時保留文字輸入。需要 HTTPS、使用者手勢及麥克風權限，iOS 背景/鎖屏中斷不能保證恢復。

Service Worker 只預存離線提示頁及兩張公開圖示，不儲存應用 HTML、JS、API、OAuth、語音或角色上傳資料。一般頁面使用網路，斷線只顯示重新連線提示。API/auth 連攔截都不做；正式伺服器預設 no-store，僅雜湊靜態 assets immutable。SW 不 skipWaiting，避免在對話中強制換版本；關閉所有分頁後重新開啟更新。
聊天/自訂人物仍沿用 localStorage/IndexedDB；這些不是 SW 快取。共用手機須自行清除網站資料；移除 PWA 不一定清掉所有瀏覽器資料。
`.env.local`、登入資料、日誌不提交 Git。Windows 登入資料存 LOCALAPPDATA/MugiTutor；登入資料保護沿用原版 DPAPI。Linux 開發仍依原版使用權限受限檔案，沒有 Windows DPAPI。

## 實機驗收清單

- Windows 安裝、正式啟停、資料目錄/ACL、停止拒絕外來 PID、埠衝突、重啟上限與斷電後恢復。
- 用不含正式資料的副本檢查 SSE、漢字讀音、糾錯、語音、角色自訂與原有功能。
- Android Chrome / iOS Safari：主畫面安裝、窄螢幕/橫向/瀏海、輸入鍵盤、放大、文字輸入；麥克風允許/拒絕、切換背景與恢復。
- 無網路只出現公開離線提示；DevTools Cache Storage 不得包含 API、code/token、聊天或聲音。
- Tailscale ACL、HTTPS 同源、非授權裝置拒絕、機密設定端點由手機拒絕。
- 選擇明確授權的供應商後才做真實 AI/OAuth/VOICEVOX 驗收；本次沒有執行。
