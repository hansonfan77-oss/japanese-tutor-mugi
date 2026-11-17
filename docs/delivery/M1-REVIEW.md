# M1 正式部署前複審

本文件記錄前一輪複審。最新獨立驗收與 Node ZIP 流程見 [驗收指南](../acceptance-guide.md) 及 [本輪交付](ACCEPTANCE.md)；不要只依本文件的舊啟動參數操作。

## 修復與原因

1. **長期重啟計數**：原版 lifetime count 在多次健康長期執行後仍會累積到 5 而停止。現在只累計連續短期失敗，至少 5 分鐘連續健康的執行重置歷史，仍保留 5 次短期失敗斷路。
2. **重複啟動、殘留及 PID 重用**：排他檔案鎖跨 Start/Install 生效；owner 記錄包含建立時間、執行檔、完整指令與每次 supervisor UUID。可證明 PID 重用時不停止替代程序；資訊不明時 fail closed；新 Start/Stop 能清理已死記錄與停止核實的孤兒 Node。活的舊 PID 記錄沒有完整證據，保留人工處理。
3. **停止競態與資料寫入**：Stop 合作式通知 supervisor，Node 專屬 stop 檔觸發 HTTP drain 與 exit flush；最長 10 秒等待請求、15 秒後才可對核實 Node 強制結束。埠衝突不關閉佔埠程式。每輪釋放舊 Process 控制代碼，避免長期重啟漏 handle。
4. **靜態檔案防護**：公開資源白名單在原始路徑及 realpath/junction 解析後兩次執行，拒絕 credentials、key、source map、備份、未知檔、Windows ADS/尾點空白別名。保留實際公開圖片/人物 metadata/音訊/manifest/資產。
5. **精確 Host 與副本資料隔離**：production 不接受萬用或後綴 Host；設定路徑改綁傳入 checkout root，避免多副本使用錯誤檔案。開發伺服器也拒絕 `.runtime`。現有 Origin/同源、loopback/代理金鑰寫入與 OAuth 限制保留。
6. **CI**：新增 Linux/Windows Node 24 測試、Build、實際 bundle smoke；Windows 分別執行 PowerShell 5.1/7 runtime mock 與 parser 檢查。首次 CI 的 runner.temp 表達式層級錯誤已修正，後續狀態以 GitHub Checks 為準。

## 實際變更檔案

- `scripts/windows/Install.ps1`、`Start.ps1`、`Stop.ps1`：運行與恢復流程。
- `scripts/windows/Runtime.ps1`：共用 lock/identity/restart/stop 邏輯。
- `scripts/windows/Test-Runtime.ps1`：安全的 fake process 測試，不會 kill 真實程序。
- `server/production.ts`：白名單、Host、合作式停止及埠衝突退出。
- `server/claudeChat.ts`：設定檔 root 綁定；共用原有教學路由不變。
- `server/fsDeny.ts`：阻擋開發模式 runtime metadata。
- `src/game/__tests__/production.test.ts`：Host/代理/私有檔案/副本隔離測試。
- `scripts/test-production.mjs`：獨立資料目錄啟動真實 bundle，驗證停止/埠衝突/PWA/API。
- `.github/workflows/validate.yml`：跨平台 CI。
- `docs/private-host.md`、本報告：修訂說明與實機程序。

## 本次實際驗證

- Vitest：93 檔，**1425 通過、1 跳過、0 失敗**；跳過原有真實 VOICEVOX 引擎整合測試。
- `npm run build`：嚴格 TypeScript + 前端 + 正式 Node bundle 通過。
- `npm audit --omit=dev`：本次查詢 production dependency advisory 為 0；不代表不存在未知漏洞。
- `node --test scripts/test-production.mjs`：**2 通過**。真正啟動 bundle，獨立暫存資料，不呼叫 AI；健康、chat/openai/tts status、usage、PWA/離線資源成功；私有檔不公開；錯誤 owner 無法停止、正確 owner 正常退出；佔埠程序存活。
- PowerShell 7.4.6/Linux：使用官方 SHA256 驗證過的 portable 工具，**24 個 runtime assertions 通過**（包括所有 ps1 parser）。涵蓋 1000 次健康長期重啟、5 次短期失敗、PID 重用、指令不符、無法讀取、孤兒、舊 PID、排他鎖、記錄損壞與合作式停止邏輯。
- **未執行 Windows 5.1/7 實機的 CIM、ACL、Start-Process、Task Scheduler、斷電恢復。** Linux 假程序與 parser 不替代這些驗收。Windows CI 亦不等於使用者私人小 PC 的部署驗收。
- Manifest/離線頁/SW 快取與路由邊界已自動化驗證；本次沒有 Android/iOS 瀏覽器實測。SW 仍只快取公開離線頁及圖示，API/auth 不攔截、不快取；原有使用者聊天/圖片仍在 localStorage/IndexedDB。
- 原版教學的共用路由與既有 Mock tests 保留：漢字讀音、糾錯、聊天/SSE、語音、人物自訂未改寫。真實 AI、ChatGPT OAuth、VOICEVOX、手機 STT 未驗收、未呼叫付費 API。

## GitHub

PR #1： https://github.com/hansonfan77-oss/japanese-tutor-mugi/pull/1
工作分支 `feat/mugi-private-pwa-animation`。修正會直接更新同一 PR，不另建 PR，不合併 main。
GitHub GraphQL API 回覆 Forbidden；可透過公開 PR/Actions 頁面確認 Draft 與 CI 狀態。Git fetch/push 已可用；本機 `git merge-tree --write-tree origin/main HEAD` 成功，代表目前 fetched main 可無衝突合併，不代表已獲得審核或所有 branch protection 已滿足。

## Windows／手機部署前最短程序

1. 使用獨立測試副本與 Node 24，備份正式資料；各 PowerShell 執行 `Test-Runtime.ps1`，再 Install。用完整路徑 `-NoProfile -File` 啟動 Start，AllowedHost 填精確 `.ts.net` 主機名稱。
2. 本機驗證 `/api/health` 與 UI；重複 Start/Install 必須拒絕；Stop 後 Mugi 不重啟，與 Mugi 無關的 Node 仍存活。只在測試副本注入 supervisor crash、PID 殘留/重用、損壞記錄與埠衝突。
3. 啟用私人 Tailscale Serve、確認 ACL，不開 Funnel 或路由器埠。手機 HTTPS 加入主畫面，檢查打字、麥克風權限允許/拒絕、橫向/鍵盤/背景恢復與離線重連。確認手機不能寫入金鑰/登入，Cache Storage 只有公開檔案。
4. 明確授權後才進行真實 AI/OAuth/VOICEVOX，最後至少過夜運行。監測記憶體、磁碟及日誌；目前限制日誌檔數，單一長期執行的日誌大小仍須監測。強制停止/斷電仍可能中斷在途對話與最近未寫入資料。

本次不部署、不修改私人主機或正式資料，不進入 M3；完成後等待審核。

### 已觀察到的 GitHub CI 證據

程式修正版本 `e4578c2` 的 PR CI 已成功：
https://github.com/hansonfan77-oss/japanese-tutor-mugi/actions/runs/42304320207

Ubuntu/Windows 兩個 job 成功，Windows 包含 PowerShell 5.1 與 7 執行相同 runtime mock/parser suite。因此已具備 Windows runner 的跨版本邏輯與語法證據；仍沒有執行私人主機上的真實 supervisor/CIM/ACL/工作排程故障注入。Actions v4 的 Node 20 runtime 升級提醒與 ubuntu-latest 映像遷移是非阻塞 notice/warning。文件後續提交的最新狀態應在 PR Checks 查看，不把舊版成功當作未執行提交的結果。
