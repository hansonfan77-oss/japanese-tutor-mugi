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

## M1 部署前複審修訂

本節取代上文舊版「累計 5 次」與單純 PID 檔的說明。**不再使用 host.pid/server.pid 作為可殺程序的依據**。

- `Runtime.ps1` 以排他檔案鎖保護 Start/Install；Windows 在程序崩潰時自動釋放鎖，磁碟上的 owner.lock 本身不是殘留執行證據，毋須刪除。
- host.json/server.json 保存 PID、建立時間、執行檔、完整指令列、每次 supervisor 專屬識別。PID 被重用時不終止替代程序；無法查明身份時停止恢復並要求人工檢查。不要手動改寫這些記錄。
- 啟動時，已死的 supervisor 記錄可清理；已核實的孤兒 Node 會先停止再啟動新實例。相同 root 已有 supervisor 或 3004 已被佔用時拒絕啟動，絕不關閉佔埠的其他程式。
- Stop 先發出 supervisor 合作式停止要求，防止停止子程序後立刻被重啟。Node 收到專屬本機 stop 檔後停止接受新請求、最多等候 10 秒並透過原有 exit hook flush 用量記錄；15 秒無法退出才對已驗證身份的 Node force-stop。強制停止仍可能中斷在途音訊/對話，因此更新前先結束對話。
- 重啟計數改為**連續短期失敗**：連續健康至少 5 分鐘的執行會重置舊記錄。1000 次健康長期執行的模擬不會累積到停止；連續 5 次短期失敗仍斷路，避免配置錯誤無限重啟。每 10 秒健康檢查、連續 3 次失敗的策略保留。
- 舊版 PID 檔若對應程序已死則自動清理；若 PID 仍存活，由於沒有建立時間證據，**不會猜測或終止**。升版前先用舊版 Stop 或人工確認原程序完整路徑，停止後再安裝。無法讀取、損壞或身份不符的記錄不自動刪除。
- 安裝與啟動共用鎖，防止正在運行時覆寫依賴/build；Node 24+ 為安裝腳本的明確要求。維持 PowerShell 5.1 語法；7.4.6 的 Linux mock/parse 測試已通過，**不等於 Windows 5.1/7 CIM、ACL、Start-Process 或 Task Scheduler 實機驗收**。新增 Windows CI 會分別執行兩版檢查；CI 完成前不能視為通過。
- 正式伺服器只供應 manifest、離線頁、圖示、建置 assets、人物 metadata/圖片、背景及音訊；連解析 symlink/junction 後也驗證白名單。拒絕備份、來源碼 map、憑證、Windows ADS 與其他意外放進 dist 的檔案。新增公開格式需明確修改白名單及測試。正式 allowedHosts 只允許精確 DNS 名，不接受萬用或後綴。
- PWA 快取邊界未擴張；`.runtime` 也加入開發伺服器 fs.deny。金鑰設定檔路徑綁定實際傳入 checkout root，避免測試或多副本共用錯誤設定。

### 部署前精簡實測（不要直接使用正式資料）

1. 在獨立副本備份 `.env.local`、`.usage`、圖片/聊天匯出及登入資料。使用 Node 24，先執行 Install，再在 Windows PowerShell 5.1 與 PowerShell 7 各執行 `-NoProfile -File "完整路徑\scripts\windows\Test-Runtime.ps1"`（mock 檢查）。
2. 用各版本 PowerShell 的 `-NoProfile -File "完整路徑\scripts\windows\Start.ps1" -AllowedHost "精確主機名.ts.net"` 啟動；驗證本機 `/api/health`、頁面、內建話題、角色設定及 Mock 測試。不設定真實 AI 金鑰即可完成此步。
3. 第二視窗重複 Start/Install 應拒絕；另開與 Mugi 無關的 Node，執行 Stop 後確認它仍存活，Mugi 不再重啟且 `.runtime` 記錄完成清理。
4. 在測試副本模擬 supervisor 意外終止，確認孤兒 Node 仍能由新 Start/Stop 依身份恢復。模擬損壞記錄/活的舊 PID 檔必須拒絕猜測殺程序。不要對正式資料做故障注入。
5. 只啟用私人 Tailscale Serve，確認 ACL；Android/iOS 開 HTTPS、加入主畫面、打字/語音權限允許與拒絕、橫向/鍵盤/背景恢復、離線重連。DevTools 確認 Cache Storage 僅公開離線頁及圖示，手機不能寫金鑰/登入。
6. 需另外明確授權後才驗證真實 AI/OAuth/VOICEVOX；再測至少過夜運作、磁碟空間及日誌量。現有日誌限制檔數，**單一長期執行的日誌尚無檔案大小上限**，須監測；不將這點宣稱已完成長期壓力驗收。
