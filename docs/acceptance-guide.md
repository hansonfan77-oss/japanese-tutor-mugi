# Mugi 獨立驗收指南（Windows PowerShell 5.1）

本指南取代舊文件中「不填金鑰即可驗收」的做法。驗收模式由伺服器強制執行，不是每日預算限制；預算 0 在原版代表不限額，**不能用來阻止支出**。

本輪只交付開發與 CI 證據。下列指令供使用者回到小 PC 後自行操作；本輪沒有連線小 PC、設定 Tailscale、開啟真實 AI/OAuth/語音或移動正式資料。

## 1. 取得乾淨的專用副本

不要在原有正式資料夾切換分支。選一個新的本機資料夾，例如 `C:\Mugi Acceptance`，由 Git 複製**已追蹤的程式**，不複製正式資料夾的 `.env`、帳號、用量、快取或圖片資料庫。

```powershell
git clone --branch feat/mugi-private-pwa-animation --single-branch https://github.com/hansonfan77-oss/japanese-tutor-mugi.git "C:\Mugi Acceptance"
Set-Location "C:\Mugi Acceptance"
git status --short
git rev-parse HEAD
git ls-remote origin refs/heads/feat/mugi-private-pwa-animation
```

預期：status 空白；本地完整 SHA 與遠端分支 SHA 相同。與 PR #1 的最新提交核對，**不要 reset 到舊審核版 95b92ac**。若已存在這個專用副本，先 Stop，再 `git pull --ff-only`；有自己的修改或無法 fast-forward 就停止，不覆寫。

## 2. 指定獨立 Node.js 24 ZIP

保留系統 Node.js 22.23.3 與 npm 10.9.9。將官方 Node 24 Windows x64 ZIP 完整解壓縮到例如 `C:\Tools\Node 24`（實際目錄可不同，也可有空白）。依官方 SHASUMS256 核對下載檔案。不要只複製 node.exe；該目錄也必須有 `node_modules\npm\bin\npm-cli.js`。

```powershell
$nodeZip = 'C:\Tools\Node 24'
& "$nodeZip\node.exe" --version
& "$nodeZip\node.exe" "$nodeZip\node_modules\npm\bin\npm-cli.js" --version
```

預期：第一行為 `v24.x.x`，第二行是該 ZIP 的 npm 版本。系統 `node --version` 仍可顯示 v22；不必修改全機 PATH、不必安裝 PowerShell 7。腳本每次要求 `-NodeHome`，不會悄悄回用系統 Node。npm、Build 的 Node 子程序及正式 server 都用同一 ZIP。腳本僅暫時調整自身與子程序的 PATH，npm 執行完會復原。

## 3. 安裝驗收副本

選一個**新的空資料目錄**，例如 `C:\Mugi Acceptance Data`。它必須位於 checkout 外，也不能是正式 `%LOCALAPPDATA%\MugiTutor`、其子目錄或父目錄。不可使用 junction/symlink。之後每次 Install/Start/Stop 要填同一個 AcceptanceRoot。

```powershell
$repo = 'C:\Mugi Acceptance'
$testData = 'C:\Mugi Acceptance Data'
powershell.exe -NoProfile -File "$repo\scripts\windows\Install.ps1" -NodeHome "$nodeZip" -Mode Acceptance -AcceptanceRoot "$testData"
```

預期：印出所選 Node 路徑與 v24，`npm ci` 和完整 Build 成功。未提供 Mode 也預設 Acceptance；明確寫出更易核對。若不填 AcceptanceRoot，預設是 `%LOCALAPPDATA%\MugiTutor-Acceptance\<checkout 路徑雜湊>`，同一副本固定使用相同目錄。

此流程使用 public npm registry，驗收專屬的空 user/global npm config 及 cache，不載入使用者正式 `.npmrc`。不會修改現有憑證或全機設定。npm 套件下載仍需要網路，這不是 AI 供應商呼叫。

若 PowerShell 執行政策阻擋腳本，先依主機政策確認檔案來源、簽章或解除該下載檔的封鎖；**不要將全機執行政策改成 Unrestricted/Bypass**，也不需預設使用管理員身份。

## 4. 啟動並確認硬性阻擋

```powershell
powershell.exe -NoProfile -File "$repo\scripts\windows\Start.ps1" -NodeHome "$nodeZip" -Mode Acceptance -AcceptanceRoot "$testData"
```

保持該視窗開啟。預期印出 Acceptance、loopback port **3006** 及專屬 runtime 路徑。這不是一般模式使用的 3004。

在另一個 PowerShell 視窗：

```powershell
Invoke-RestMethod 'http://127.0.0.1:3006/api/health'
Invoke-RestMethod 'http://127.0.0.1:3006/api/runtime'
try {
  Invoke-RestMethod 'http://127.0.0.1:3006/api/chat' -Method Post -ContentType 'application/json' -Body '{"providers":["openai","anthropic"],"text":"驗收"}'
} catch {
  $_.Exception.Response.StatusCode.value__
  $_.ErrorDetails.Message
}
```

預期：health 的 runMode 為 `acceptance`；runtime 顯示 `mode=acceptance`、`externalServices=False`、`browserSpeech=False`；聊天操作回 **423** 與 `acceptance_mode` 訊息，這是**被拒絕，不是成功對話**。

用一個新的瀏覽器設定檔，在小 PC 開啟 `http://127.0.0.1:3006`。應看到：

> 驗收模式：外部 AI／雲端語音已停用

瀏覽器語音輸入及朗讀也停用，因為它們未必完全在本機執行。可測試內建「換她開話題」、人物名字/人設/圖片/背景、版面、設定視窗與歷史顯示。AI 發送、速查、判斷/改寫、雲端語音、VOICEVOX 啟停、OAuth 與金鑰/預算寫入均不在本輪執行。沒有新增假 AI 對話，內建話題不是模型生成。完整自動化測試預設也不探測真實 VOICEVOX；該選用整合測試需另行授權後明確設定 MUGI_TEST_VOICEVOX=1 才會執行。

即使繼承了有效供應商環境變數或 MUGI_DATA_DIR 指向正式登入資料，驗收模式也**不掛載、不初始化**供應商、OAuth 或引擎服務，不讀取登入檔，不刷新 token；未知未來 API（例如圖片生成路徑）同樣拒絕。一般模式設定、HTTP body、前端開關或 `.env` 都不能解鎖。拼錯/空白的 MUGI_RUN_MODE 會啟動失敗，不會降級成一般模式。模式無法讀取時，前端不啟動家教與語音。

## 5. 停止與恢復

```powershell
powershell.exe -NoProfile -File "$repo\scripts\windows\Stop.ps1" -Mode Acceptance -AcceptanceRoot "$testData"
```

預期 supervisor 與它核實的 Node 子程序退出，host.json/server.json 清理，其他 Node 程序不受影響；Tailscale 設定不變。Stop 不需 NodeHome，也不需清空或刪除任何正式資料。

重複 Start/Install 會被同一資料根的檔案鎖拒絕。崩潰釋放鎖後，可恢復相同副本的已核實孤兒程序；PID 被重用或身份查不明時不亂殺。不同 checkout 不能共用同一 AcceptanceRoot。資料內 junction/symlink、損壞記錄或其他副本標記都會拒絕恢復，不應盲目刪檔繞過檢查。

## 6. 資料位置與瀏覽器隔離

| 類別 | 驗收模式 | 一般模式（未自動搬移） |
| --- | --- | --- |
| `.env*`/供應商設定 | 不讀取；乾淨副本只允許 `.env.example`；設定寫入回 423；Vite 驗收 Build 禁用 envDir 載入 | 一般 checkout 原有 `.env*` 與程序環境 |
| OAuth/登入 | 不初始化、不讀取；腳本預留 `<AcceptanceRoot>\state\oauth`，不使用正式帳號 | 原有 `%LOCALAPPDATA%\MugiTutor` |
| 用量 | `<AcceptanceRoot>\state\.usage`（沒有供應商操作，不增加真實用量） | 一般 checkout 的 `.usage` |
| 語音快取/記憶體快取 | 專屬程序及 `<AcceptanceRoot>\state\.tts-cache`，不合成語音 | 一般 checkout 的 `.tts-cache` |
| `.tts-keep`/引擎 | 不讀取、不啟動；副本不得含原引擎或保留音訊 | 原有位置，另行驗收 |
| 日誌、鎖、程序身份、停止檔 | `<AcceptanceRoot>\runtime`；owner 標記在 AcceptanceRoot | 一般 checkout 的 `.runtime` |
| npm config/cache | `<AcceptanceRoot>\state` 的獨立空 config 與 npm-cache | 原 npm 行為 |
| Build/依賴 | 乾淨專用 checkout 的 node_modules、dist、dist-server；另有 `.mugi-acceptance` 標記 | 一般 checkout 自己的檔案 |

專用 checkout 是隔離的一部分，不能直接在既有正式 checkout 上試跑。安裝/啟動會檢查檔名，發現 `.env*`、`.npmrc`、`.usage`、`.tts-cache`、`.tts-keep`、`.runtime` 或引擎就拒絕；不讀取內容、不複製、不覆寫。專屬根目錄只能是空目錄，或已標記屬於同一 checkout 的目錄。

**手機/瀏覽器的聊天、人物設定與圖片仍依 origin 隔離。** 改變伺服器資料目錄不會換掉 localStorage/IndexedDB。`127.0.0.1:3006` 與 `127.0.0.1:3004` 是不同 origin，但若日後共用同一 Tailscale HTTPS 主機名稱，瀏覽器資料可能共用。先用新的瀏覽器設定檔或專用測試瀏覽器；手機先確認該 origin 沒有要保留的正式資料。不自動清除、不匯入原資料。不要對仍需保留的網站資料按「清除」。

## 7. 常見錯誤與預期行為

| 訊息/現象 | 處理 |
| --- | --- |
| NodeHome 缺檔/不是 v24 | 指向完整 ZIP 的那一層，不是上一層或 node.exe 檔案本身；系統 v22 保留 |
| 需要乾淨專用 checkout | 重新 clone 到新路徑，不要刪除正式 `.env` 或資料以通過檢查 |
| AcceptanceRoot 非空/屬於其他副本 | 使用新的空目錄；確認 Start/Stop 使用同一路徑 |
| Port 3006 被佔用 | 先確認是否自己的驗收服務；腳本不會關閉佔埠程式 |
| 聊天/速查/登入回 423 | 正常的驗收模式拒絕；不是網路錯誤，不要填真實金鑰繞過 |
| 畫面「無法確認伺服器模式」 | 查伺服器日誌和 `/api/runtime`；確認跑正式 Node bundle，不是 Vite preview；重新載入 |
| 看不到新畫面 | 確認 SHA、完成 Build、正確的 3006 origin；關閉該測試 origin 的所有分頁再開啟，不清除其他正式資料 |
| 機密設定/Origin/Host 被拒 | 保留拒絕；不要放寬 guard 或把主機名改成萬用後綴 |

## 8. 接 Tailscale 前與之後

本輪不執行 Serve 指令。先完成本機驗收、確認 mode=acceptance、設定正確資料根與 Stop、檢查 tailnet ACL 與現有 Serve 路由。之後由使用者另行決定是否將**私人** HTTPS 指向 127.0.0.1:3006，Start 加上精確的 `-AllowedHost '主機名.tailnet.ts.net'`；不開 Funnel、不改路由器埠，不覆蓋既有路由。接手機後再驗收 PWA 安裝、鍵盤/橫向/背景恢復與 origin 資料隔離；本輪仍停用所有語音。

## 9. 後續一般模式（本輪不執行）

只有明確 `-Mode Normal`／`MUGI_RUN_MODE=normal` 才會掛載原供應商。驗收 checkout 已被標記，**不能原地變成一般模式**；請在另一個一般 checkout 準備 Node 24，以 `-Mode Normal -NodeHome ...` 安裝與啟動。仍使用原有 3004、資料與安全 guard，不自動匯入或搬移驗收資料。恢復真實 AI/OAuth/VOICEVOX/瀏覽器語音前，須另行明確授權與驗收。
