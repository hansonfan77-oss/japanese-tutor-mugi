# M2 分層角色動畫核心（初步交付）

這次完成可測試的 renderer-independent 核心，**尚未將新分層角色渲染器接入正式畫面**。現有單張圖片、嘴型圖片與人物切換原樣運作；不會假造正式動態美術。M1 涉及正式伺服器及 Windows 維運，故本階段採授權的「技術設計＋可測試核心」交付。

`CharacterAnimator.frame(now, signals)` 輸出 body/head/eyes/mouth 各層獨立姿勢，沿用 TutorFaceClock 的自然眨眼、AmplitudeMouth 與 VisemeCue 時序；不建立計時器、不改語音播放、不呼叫網路或 AI。

| 狀態 | 觸發 | 動作 |
| --- | --- | --- |
| Idle | 無其他訊號 | 4.2 秒輕微呼吸＋原有 3–6 秒眨眼 |
| Listening | 現有 mic.listening / voice.phase | 微側頭 |
| Thinking | pending reply/busy | 另一側微側頭 |
| Speaking | voicePlaying() | voiceViseme() 優先，否則 voiceLevel() 驅動嘴型 |
| Happy | UI 明確鼓勵事件 express() | 短暫輕微抬頭 |
| Confused | UI 明確引導事件 express() | 短暫輕微傾頭 |

優先序 Speaking > Listening > Thinking > 尚未過期情緒 > Idle。情緒即使被語音遮蔽仍按時過期，取消/錯誤由上層清除 thinking/listening；狀態沒有隱藏 API 邏輯。預設情緒 1.8 秒，上限 10 秒。

## 後續渲染接線契約

- 使用同一美術座標框，基底 body、頭部 head、眼睛 eyes、嘴部 mouth；各部位圖檔、錨點、pivot、z-index 在版本化 metadata 中描述。替換素材不改狀態機。mouth 與 head 放在同一座標父層，避免嘴型漂移。
- 現有 `tutor.json` 與 `CustomPortrait` 無分層 metadata 時保留原有 TutorPortrait；不得對整張照片套頭部形變或強行切圖。
- 上層從 TutorView 傳 listening/busy；語音來源仍是 voiceBus，不新增播放實例。Happy/Confused 只接確定的既有本機結果事件，無資料不猜測情緒。
- 未來以單一 requestAnimationFrame 更新 CSS transform/opacity，將姿勢轉為 translate(百分比)/rotate/scale，不每幀寫 React 全頁 state。不改既有縮放與拖曳父層 transform。
- Page Visibility 暫停隱藏畫面；恢復時最多補 100ms 的平滑進度；120–140ms 緩動避免瞬間切姿。reducedMotion 關閉位移、旋轉及縮放，嘴型仍保留；各層可各自停用。
- 測試已覆蓋六狀態競合、情緒過期、嘴型/眨眼重用、減少動態、部位開關、長時間幅度限制、背景恢復與返回物件不變性。尚未取得手機 FPS、電量或正式分層素材配準結果。
