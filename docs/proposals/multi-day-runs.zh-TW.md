[English](multi-day-runs.md) | **繁體中文**

# 跨數天的任務

> **狀態：尚未開始；一份盤點（2026-11-24），以及建議的處理順序。** 見[提案](README.zh-TW.md)。

這份盤點回答一個問題：Harness Relay 現在能不能讓 agent 穩定地跨數天執行任務？還有哪些問題要處理？它只寫程式碼與文件現在的樣子，以及缺什麼，不含設計。盤點以 `main` 的 `278c4b62` 為準，文中的行號也以這個 commit 為準。

## 一、結論

**可以，但僅限一種形式，而且有前提。**

- **形式**：用「自動任務（schedule）＋追蹤目標（goal）」把多天的工作拆成多次 run。
  - 每次 run 由排程觸發。
  - agent 在回覆結尾用 `<progress status="working|done|blocked">` 回報進度。
  - `done` 會自動關掉排程；`blocked` 會通知使用者。
  - 這是產品為這件事設計的路徑，使用者指南也寫，自動任務會「跨執行、跨天地追蹤這件事」（`docs/user-guide.zh-TW.md:847`）。
- **不是**「一個 agent 連續跑好幾天」：
  - 單一 turn 預設最多 24 小時，這是防 CLI 掛住的安全網；可用 `RELAY_TURN_TIMEOUT_MIN` 拉長到 7 天（`src/server/config.ts:88`）。
  - turn 一結束，agent 的背景工作通常就跟著結束。例外有兩個：Claude Code 預設最多再等 10 分鐘（帳號開了 workflows 時，可以等到接近 turn 的逾時）；完全存取下 detach 出去的程序會繼續跑，但已經不在 Relay 的管理之下。
  - 依時間的排程最短間隔 1 小時；事件觸發每 2 分鐘檢查一次。
- **前提**（缺一個，任務就會停下來、悄悄漏掉一次 run，或品質退化）：
  1. **伺服器一直活著**：不睡眠；崩潰後要有外部機制重啟。
  2. **無人值守時不需要越權的動作**：這類動作會被自動拒絕，或交給 lead agent 審核。
  3. **在同一對話跑的排程裡，agent 不向使用者提問**：一旦提問，之後的排程時間都會被跳過，直到使用者回答。「每次開新對話」的排程不受影響。
  4. **CLI 方案額度沒用完、登入沒過期**：Relay 對這兩種失敗不會採取任何行動，只有部分 adapter 會把登入錯誤改寫成「請重新登入」。具體來說，Relay 不會等額度重置，不會換帳號，也不會另外提醒使用者。
  5. **對話沒有長到讓全新 session 補送的完整歷史超出 context**。
  6. **追蹤目標的 run 是排程器在排定時間送出的**：事件觸發、webhook 和「立即執行一次」啟動的 run 都不會重試，也不會在重啟後恢復。
  7. **如果自動任務設了「先跑固定指令」，工作目錄的程式碼或設定沒被改動**：改動後，之後每一次都會失敗，直到使用者核准。

第二節列出現有機制，第三節列出問題，第四節是建議的處理順序，第五節是現在就要跑多天任務時的做法，第六節是還沒決定的問題。

## 二、現有機制

| 機制 | 內容 | 證據 |
| --- | --- | --- |
| 自動任務的觸發時間 | 可以是一次、每天、每週、每 1–168 小時、事件（郵件、行事曆、GitHub、檔案）、webhook，或手動按「立即執行一次」。scheduler 每 15 秒看一次，電腦醒來後會處理到期的時間。超過排定時間 10 分鐘以上算錯過，預設跳過，也可設成補發一次。對話暫時忙碌時（例如正在變更設定或套用結果），會在 30 分鐘內反覆重試，之後跳過。 | `src/server/scheduler.ts:67,75,78`；`docs/architecture.md:276-317` |
| 追蹤目標 | 目標最多 2,000 字。每個 turn 的 briefing 會帶入目標、目前狀態和最近 12 則進度筆記（保留 30 則，每則最多 1,000 字）。`done` 會關掉排程；`blocked` 會標成需要使用者處理，並發出通知。 | `src/shared/tracking.ts`；`src/shared/types.ts:3124,3147-3154`；`src/server/prompt.ts:536-560` |
| 失敗重試 | 一次 run 的回覆**全部**失敗時，在 5、30、120 分鐘後各重試一次，三次後等下一個排定時間；run 啟動不了也一樣重試。限制有三個：<br>• 只有排程器在排定時間送出的 run 會重試；事件觸發、webhook、「立即執行一次」都不會。<br>• 下一個排定時間若比重試早到，就由那一次取代重試。<br>• 等待時間從失敗的 run 結束時算起。 | `src/server/orchestrator.ts:2789-2791,3116-3170`；`src/server/scheduler.ts:382,488` |
| 重啟恢復 | 伺服器停止（結束、重啟、App 更新、崩潰）時還在執行的追蹤目標 run，下次啟動會立刻重試。限制有三個：<br>• 只限標成 in flight 的 run，也就是需要 `retries`，同樣限於排程器排定的時間。<br>• 停機若超過下一個排定時間再加 10 分鐘，下一個排定時間會被當成錯過而跳過，不會留下「被打斷」的筆記。<br>• 每次重啟都會用掉一次重試。 | `src/server/scheduler.ts:434-445,458,464-465`；`src/server/orchestrator.ts:3065-3067,3160-3163` |
| session 延續 | 同一對話裡，每個 agent 續用自己的 CLI session，每個 turn 只送新訊息。壓縮（compaction）交給 CLI 自己處理；Claude Code 的 `compact_boundary` 和 Codex 的 `contextCompaction` 會以通知顯示。 | `docs/architecture.md:117-150`；`src/server/agents/claude.ts:1401`；`src/server/agents/codex.ts:854` |
| 無人值守的權限 | 排程啟動的 run 會自動拒絕 approval，但對話設成「一律允許」的規則照常放行。另外三種情況：<br>• 排程設成 `approvals: ask`：照常詢問使用者。<br>• 選了「替我核准」：由 lead agent 審核；它沒放行或審核失敗，就拒絕。<br>• 完全存取：什麼都不問。 | `src/server/prompt.ts:451-459`；`src/server/orchestrator.ts:6527-6532,6564`；`docs/architecture.md:301` |
| 通知 | 通知匣保留最新 200 則，存在伺服器上，所有瀏覽器共用。支援 Web Push；需要使用者處理的推播，TTL 至少 24 小時。`blocked` 有專屬的「目標卡住了」提醒。 | `src/server/inbox.ts`；`src/server/alerts.ts:35-36`；`docs/user-guide.md:995,1023` |
| 常駐部署 | 文件有 systemd user service 範例（`Restart=on-failure`，也提到 `loginctl enable-linger`）。桌面 App 有「執行時不讓電腦睡著」選項，也會等到沒有 agent 在工作時才更新。 | `docs/remote-access.md:181-205,219`；`desktop/src/main.ts:1065-1071`；`desktop/src/update.ts:1170-1206` |
| 長期記憶 | 屬於實驗功能（設定 → 實驗室），預設關閉。 | `docs/user-guide.md:364` |
| 避免與 CLI 自己的長期目標衝突 | Relay 關掉 Codex 的 `features.goals` 和 Grok 的 `/goal`，改由自己追蹤目標。 | `src/server/agents/codex.ts:147-154`；`src/server/agents/grok.ts:1301` |

## 三、問題盤點

嚴重度：**高**＝會讓多天任務停住、中斷，或悄悄漏掉 run；**中**＝任務還在跑，但結果或品質會隨時間劣化；**中低**＝資源隨時間累積，短期無害，跑久了會拖慢伺服器或佔滿磁碟；**低**＝維運上的小麻煩。

### A. 會讓任務停住、中斷或漏掉 run（高）

**A1. 額度用完、429、登入失效都不分類，也不據以行動**
- **錯誤沒有分類**：所有失敗都變成 `AgentRunError(message, aborted?, usage?)`，沒有分類欄位（`src/server/agents/types.ts:333-341`）。
  - Claude Code 的錯誤文字原樣轉出，只有 `error_max_budget_usd` 另外處理（`src/server/agents/claude.ts:1943-1948`）。
  - Codex 用 `turn.error.message`、`additionalDetails` 和 `error` 通知的文字（`src/server/agents/codex.ts:1073-1074,1186-1189`）。
  - 會辨識 429 的只有 OpenHands，而且只是改寫訊息（`src/server/agents/openhands.ts:1256-1257`）。
  - 登入錯誤由部分 adapter 改寫（見 A6）。
- **不等額度重置，也不換帳號**：
  - `usage.ts` 讀得到每個帳號的 `resetsAt`，但只用在畫面顯示，以及 lead agent 設計團隊時，用來避開額度用完的模型、規劃 fallback（`src/server/planner.ts:255,1260`）。`orchestrator.ts` 和 `scheduler.ts` 都沒用到。
  - 排程永遠沿用原團隊（`keepTeam: true`，`src/server/orchestrator.ts:2880`），所以排程的 run 從不檢查額度。run 進行中也不會改用別的帳號或 CLI。
- **自動重試都不看錯誤類型**：
  - 唯一會立刻重試的機制：每個 agent 的 turn 一次，手動開始的 run 也算。條件是 agent 已經有 session，而且失敗時還沒說任何話；這時會立刻改用全新 session 再試一次，並送出完整歷史（`src/server/orchestrator.ts:6856-6876`）。
  - 追蹤目標的 5、30、120 分鐘重試同樣不看錯誤類型（`src/server/orchestrator.ts:3132-3134`）。
- **影響依排程頻率而不同**：
  - 每天或每週一次的排程：三次重試在約 2.5 小時加上每次 run 的時間內就用完。如果撞上 Claude 的 5 小時窗口或週額度，任務會一路等到下一個排定時間。
  - 間隔短於約 2.5 小時的排程：下一個排定時間會搶先取代後面的重試，嘗試次數歸零。結果是重試不會用完，而是每次都再撞上同一個額度。
  - 沒有目標的排程：完全不重試。

**A2. 無人值守時，越權動作會被拒絕**
- 排程 run 預設自動拒絕 approval，例如沙箱外的指令、需要網路的安裝（`Run.refuseApprovals`，`docs/architecture.md:301`；`src/server/orchestrator.ts:6527-6532`）。
- 改成 `approvals: ask` 的話，approval 會一直等使用者，等待時間算進 turn 逾時（`src/server/agents/types.ts:343-348`）。
- 「替我核准」並不會讓 run 完全不被拒絕：
  - lead agent 永遠不會放行推送、發布、要求這個 turn 更多存取權，以及沒說清楚要做什麼的請求。
  - 它沒放行或審核失敗時，就拒絕（`src/server/orchestrator.ts:6564`）。
  - 需要審核的請求會各跑一次 lead agent，用的是 lead 自己的額度。同一個 run 裡已經核准過的相同請求，以及永遠不審的請求，都不會跑 lead agent（`src/server/orchestrator.ts:2411-2416`）。
- 完全存取什麼都不問，風險自負。

**A3. 同一對話的排程，在等待使用者時會跳過之後的排程時間**
- 什麼情況會讓 run 暫停等使用者：agent 用 `[ASK_USER]` 提問、出步驟卡、密鑰卡，或提出固定指令（`src/server/orchestrator.ts:6883-6889`）。
- 暫停期間，排程訊息一律 `skipped`，否則會被當成使用者的回答（`src/server/orchestrator.ts:2735`）。連續跳過的時間會併成一則筆記。
- 任務會停到使用者回答為止。有推播提醒，但沒有逾時或預設答案的機制。
- 「每次開新對話」的排程不受影響（`if (s.newChat) return undefined;`，`src/server/orchestrator.ts:2733`；`docs/user-guide.md:839`）。

**A4. 手動開始的 run 被重啟或崩潰打斷後，不會自動續跑，也沒有提醒**
- 啟動時，所有 `streaming` 中的回覆會標成 `aborted`，還在等的 approval 和瀏覽器交接會標成 `expired`（`src/server/store.ts:918-946`）。
- 會自動恢復的只有追蹤目標的 run（`Scheduler.recover()`，`src/server/scheduler.ts:434-445`）。啟動時也不會重新送出佇列裡的訊息。
- 使用者自己開始的多步工作，要手動按「重試」或「繼續」。
- `aborted` 不會觸發提醒，只有 `done` 和 `error` 會（`src/shared/notify.ts:72-76`），所以使用者不會知道 run 被打斷了。

**A5. 伺服器必須一直活著，但沒有內建的自我照護**
- 排程只在 Relay 執行中才會觸發，背後沒有系統排程器（`docs/architecture.md:1161`）。
- `npm start` 只是單一 `tsx` 程序，沒有 supervisor。
- 桌面 App 偵測到伺服器崩潰時，只跳一則通知，不會自動重啟（`desktop/src/supervisor.ts:164-169`；`desktop/src/main.ts:370-371`）。
- 「執行時不讓電腦睡著」預設關閉（`desktop/src/prefs.ts:29`），而且用的是 Electron 的 `prevent-app-suspension`。
  - 文件說用 `caffeinate -i` 時，MacBook 闔上螢幕還是會睡眠，除非接著電源和外接螢幕（`docs/remote-access.md:179`）。
  - 「執行時不讓電腦睡著」推測也是一樣，**未實測**。
- Codespaces 預設閒置 30 分鐘就停止，可以調長（`docs/codespaces.md:13`）。
- 目前最穩的做法是文件裡的 systemd 範例，加上一台不睡眠的機器（`docs/remote-access.md:181-205`）。

**A6. 登入過期的提醒不夠明確，有時任務還會悄悄繼續**
- **CLI 登入過期**：
  - Copilot、Cursor、Muse、Antigravity 和開源 agent 會改寫成「請重新登入」；Claude Code、Codex、Grok 則是一般錯誤。
  - Relay 沒有在背景檢查登入狀態。
  - 只有當失敗的回覆剛好是對話的最後一則時，才會發出 `error` 提醒（`src/shared/notify.ts:72-76`）。
- **OAuth 帳號的 refresh token 失效**（`invalid_grant`）：
  - 帳號會標成 `reauth`（`src/server/oauth/broker.ts:241,449-452`）。
  - 但 turn 裡的工具只回 `… failed: …` 給 agent，turn 照常進行（`src/server/gateway.ts:1064-1066`）。
  - 結果 agent 可能照樣回報 `working`，使用者也收不到任何登入相關的提醒。
- **事件觸發的檢查失敗**（例如郵件登入失效）：
  - 只在排程上記下 `error` 和 `failures`，然後延後重查（`src/server/scheduler.ts:328-340`）。
  - 側邊欄的時鐘會變琥珀色，抽屜裡有一行說明（`docs/architecture.md:315`），但聊天裡沒有筆記，也沒有推播。
- **Google OAuth app 停在 Testing 狀態**：refresh token 7 天就過期（`docs/architecture.md:1168`），會直接卡住依賴 Gmail 或 Calendar 的多天任務。
- **MCP 伺服器的 access token**：turn 中途過期後，伺服器會拒絕請求，直到下一個 turn（`docs/architecture.md:1169`）。

**A7. 重試和恢復的範圍有缺口，會悄悄漏掉 run**
- **事件觸發、webhook、「立即執行一次」啟動的追蹤目標 run**：失敗不會重試，重啟後也不會恢復（`retries: Boolean(opts.retries) && opts.event === undefined`，`src/server/orchestrator.ts:2790`；`src/server/scheduler.ts:382`）。
- **事件觸發的 run 啟動後失敗**：這個事件已經被檢查記為看過，下一次檢查不會再送出。只有 `busy` 或 `skipped` 的事件會保留到下次檢查（`src/server/scheduler.ts:381-392,403-417`）。
- **停機超過下一個排定時間再加 10 分鐘**：被打斷的 run 不會恢復。`retryTracked()` 遇到下一次時間比較早時，直接返回（`src/server/orchestrator.ts:3160-3163`）；接著 `fire()` 把那個時間當成錯過，預設跳過（`src/server/scheduler.ts:458,464-465`）。

**A8. 有「先跑固定指令」的自動任務，在 agent 改過程式碼後會一直失敗**
- 工作目錄中被 pin 涵蓋的程式碼或設定一旦改動，之後每一次都會失敗，直到使用者核准。這正是 agent 平常會改的檔案。核准的提示只會留一則（`changedNote()`，`src/server/orchestrator.ts:2900-2908`；`docs/user-guide.md:841`）。
- 這種失敗算作 `failed`，會把追蹤目標的重試次數用光（`src/server/scheduler.ts:488`）。
- `command-changed` 不在提醒的種類裡（`ALERT_KINDS`，`src/shared/types.ts:1494`），所以不會推播。

### B. 任務還在跑，但會隨時間劣化（中）

**B1. 卡住的 turn 只能等總逾時**
- turn 逾時預設 24 小時（`src/shared/types.ts:3739`），是總時長的上限。
- 沒有「多久沒有輸出就停止」的 inactivity watchdog：搜尋 `idle|inactiv|watchdog|heartbeat`，只找到瀏覽器、語音和 IMAP 的用法。
- CLI 掛住時，最多會佔住對話一整個逾時：
  - 在同一對話跑的排程：第一次排程訊息會排進佇列，之後的都被跳過。
  - 「每次開新對話」的排程：會繼續開新對話。資料夾被佔住時，每個新對話的 team 都改在自己的 worktree 工作。

**B2. 背景工作隨 turn 結束而消失**
- **Claude Code**：`-p` 回答完後，會等背景工作（背景 subagent、workflow、背景指令）結束。預設最多 10 分鐘；帳號開了 workflows 時，最多到 turn 的逾時減去一點緩衝（`src/server/agents/claude.ts:618-629`）。
- **Antigravity、Grok、Muse**：開著 subagent 時，briefing 會要求 agent 在結束回覆前等所有背景工作完成，否則「還在跑的東西都會遺失」（`SUBAGENT_WAIT_RULE`，`src/server/prompt.ts:515-521`）。
- **Muse**：`cron_create` 和 `monitor` 會跟著 turn 一起結束（`docs/architecture.md:1137`）。
- **Antigravity**：背景指令會跟著 turn 一起結束（`docs/architecture.md:1131`）。
- **開源 agent**：沙箱會清掉留下來的程序。
- **完全存取**：detach 出去的程序會跑出 turn 的程序樹，不再受 Relay 管理（`docs/architecture.md:1162`）。
- 結論：要跑好幾天的工作（訓練、長時間爬取、長 build）沒辦法交給 Relay 跨 turn 照看。[只有使用者能做的步驟](user-handoffs.zh-TW.md)這份提案，把「要一直執行的程式」列為還沒做。

**B3. 全新 session 會一次送出完整歷史，沒有上限**
- 同一對話裡，靠 CLI 自己壓縮 context。
- 一旦開了全新 session，就會一次送出整段聊天（`Here is the group chat so far:`，`src/server/prompt.ts:874-876`）。
  - 篩選條件沒有長度上限（`src/server/orchestrator.ts:6685-6687`），adapter 也沒有。
  - `docs/architecture.md:1147` 也寫明這一點。
- 會開全新 session 的情況：
  - agent 已經有 session，卻在說任何話之前就失敗（不限 resume 失敗；自動 fallback，`src/server/orchestrator.ts:6856-6876`）；
  - 重試、編輯訊息、分支（`docs/architecture.md:1153`）；
  - 提高權限；
  - 換 provider，或模型換到別的 backend；
  - Muse 在伺服器每次重啟後（`docs/architecture.md:1137`）。
- 一個跑了好幾天的對話，這個 prompt 可能超過模型的 context window 而失敗；失敗後的 fallback 一樣會送出完整歷史。
- 另外：Cline 透過 ACP 不會壓縮；Grok 和 Copilot 用自訂端點的模型時拿不到 context window（`docs/architecture.md:1166`）。

**B4. 「每次開新對話」模式下，跨 run 的記憶很薄**
- 帶進 prompt 的只有最近 12 則進度筆記，每則最多 1,000 字（`src/shared/types.ts:3147-3151`；`src/server/prompt.ts:538`）。
- 其他內容要靠 agent 自己寫進檔案（`docs/architecture.md:1161`）；長期記憶預設關閉（`docs/user-guide.md:364`）。

**B5. 完成和進度都只看 agent 自己怎麼說**
- **`done` 不驗證**：「Harness Relay does not check that it is really reached」（`docs/architecture.md:1161`）。
- **漏寫不偵測**：回覆漏了 `<progress>` 區塊不會被發現：搜尋 `no progress` 和 `noProgress`，沒有結果。
- **只有全部失敗才重試**：每一則回覆都失敗，才算這次 run 失敗（`src/server/orchestrator.ts:3132-3134`）。下面幾種情況都不會重試：
  - 只有部分回覆失敗；
  - 有一則 `[PASS]`；
  - 有一則被中止。
- **沒有停滯偵測**：連續好幾次 run 都回報 `working` 卻沒有進展，也不會被發現。
- **沒有目標的排程**：完全不重試。

**B6. 推進節奏受限**
- 依時間的排程，間隔最短 1 小時，而且只能是整數小時（`src/server/validate.ts:862`）。
- 沒有「上一次 run 結束就馬上接下一次」的模式。
- run 比間隔還長時，下一個排程時間會排進佇列，再之後的被跳過。
- 每個對話只能有一個排程。

**B7. 多天之間，CLI 版本可能漂移**
- **有關掉自動更新的**：只有 OpenCode 和 Cline（`src/server/agents/opencode.ts:158,437`；`src/server/agents/cline.ts:154,175`）。
- **Copilot**：只有讀取用量時會關掉更新（`--no-auto-update`，`src/server/usage.ts:575-577`）；一般 turn 沿用帳號自己的 `autoUpdate`。文件寫它「may update itself under Harness Relay」（`docs/architecture.md:1135`）。
- **沒找到任何更新相關設定的**：Claude Code、Codex、Grok、Muse、Antigravity、Cursor、Goose、OpenHands、Pi。它們在非互動執行時會不會自我更新，**未驗證**。
- 風險：一旦更新到 `src/shared/cliVersions.ts` 沒檢查過的版本，adapter 可能在任務進行中壞掉。

**B8. 平行模式和自有 worktree 的結果要人工套用**
- **平行模式**：結果要使用者選了才會套用（`docs/user-guide.md:711`）。
- **自有 worktree**：另一個對話正在寫入同一資料夾時，team 會改在自己的 worktree 工作，結果要套用後才會進到資料夾（`docs/architecture.md:1126`）。
  - 一旦搬進自己的 worktree，就會一直留在那裡，直到使用者套用（`teamWorkPending()`，`src/server/orchestrator.ts:3590,4074`）。
- 所以無人值守時，這兩種情況的進度不會累積到工作目錄。

**B9. 跨 run 沒有花費上限**
- 成員的限制都只針對單一 turn 或單一 session：Claude Code 的 `--max-budget-usd`、Copilot 的 `--max-ai-credits`、Goose 和 OpenCode 的步數（`src/shared/types.ts:203-214`）。
- 用按量計費的 API key 或端點跑多天任務時，所有 run 和重試加起來的花費，沒有任何機制會擋下。

### C. 資源隨時間累積（中低）

**C1. 對話不會自動清理**
- 找不到任何自動封存或刪除；對話只在使用者刪除時才移除（`src/server/orchestrator.ts:1183-1229`）。
- 每小時一次、每次開新對話的排程，一天會多出 24 個對話。它們都留在記憶體、資料庫和磁碟上，連同 worktree、ref 和狀態資料夾。

**C2. 伺服器記憶體只增不減**
- `Store.cache` 存的是完整對話（含所有訊息），讀取時會放進去，只有刪除對話時才移除；重啟才會清空（`src/server/store.ts:910,1078-1083,1263,1324`）。`savedSeen` 也一樣。
- 開了 AgentsView 的話，每個對話會多一筆記錄（`src/server/agentsview.ts:482,488`）。
- 一個長期使用的排程對話本身也會無限長大（`docs/architecture.md:1161`）。

**C3. 輪詢成本隨歷史線性增加**
- `Store.list()` 每次都查詢所有對話，其中有一個用不到索引的 `LIKE` 全表掃描（`src/server/store.ts:1008-1021`）。
- 輪詢頻率：
  - 有 agent 在工作時，`AlertWatcher` 和 `Inbox` 各每 1.5 秒查一次（`src/server/alerts.ts:22`；`src/server/inbox.ts:21`）；`AlertWatcher` 只在有瀏覽器訂閱推播時才查。
  - 每個開著的分頁每 3 秒查一次（`src/web/App.tsx:428`）。
- 列表沒有分頁。

**C4. 磁碟只增不減**
- **快照 ref**：每個有改動的 turn，最多新增 2 個 `refs/harness-relay/…`。只有編輯、重試或刪除對話時才會移除（`src/server/workspace.ts:173`；`src/server/orchestrator.ts:7041-7047`）。Relay 從不主動跑 `git gc`；git 自己的自動 gc 刪不掉 ref 還指著的物件。
- **快照內容**：快照用 `git add -A` 收進所有未被忽略的檔案，未追蹤的也算（`src/server/workspace.ts:318`；`docs/architecture.md:763`）。長任務寫進工作目錄的大檔案（資料、log、checkpoint），會在每個有改動的 turn 被收進 `.git`；因為有 ref 指著，會一直留著，而且每個 turn 都要重新雜湊。
- **worktree**：平行模式和自有 worktree 會留到對話刪除為止；啟動時也不會清掉孤兒 worktree。
- **附件**：每一則排程訊息都會複製一份排程的附件，不論是不是每次開新對話（`src/server/orchestrator.ts:2968,3211`）。
- **瀏覽器 profile**：只在刪除對話時移除（`src/server/browser/session.ts:856-858,1845`）。
- **開源 agent 的狀態資料夾**：每個對話的每個成員各一個。
- **CLI 的 session 歷史**：留在各帳號的 home。刪除對話只會清開源 agent 的狀態（`src/server/orchestrator.ts:1209-1213`）；只有移除帳號時，才會連同那個 home 一起刪掉（`docs/architecture.md:1155`）。

**C5. SQLite 只會長大**
- 用 WAL，但沒有 `VACUUM`、`auto_vacuum` 或 `journal_size_limit`（`src/server/db.ts:897`）。刪除資料不會讓檔案變小。
- `agent_seen` 的列數是「訊息數 × 成員數」。

**C6. log 輪替要看部署方式**
- **桌面 App**：單檔 5 MB，另外保留一份 `.old`（`desktop/src/log.ts:11,64-73`）。
- **`npm start`**：只寫到 stdout 和 stderr，大小由接手的程式決定。systemd 用 journal 接收的話可以接受。

**C7. 沙箱殘留程序要等下次啟動才清**
- 每個 run 結束時會清一次。沒清掉的程序要等到下次伺服器啟動才處理，主要發生在 macOS（`src/server/relaySandbox.ts:1306-1309`）。

**C8. 通知容易被洗掉（低）**
- 每次失敗的嘗試都會發出一則 `error` 提醒（`src/shared/notify.ts:72-76`）。每小時的排程，每個時間最多會有 3 則。
- 通知匣只保留最新 200 則（`docs/architecture.md:1159`）。

### D. 盤點時發現的文件與程式碼不一致

**D1. 排入佇列的排程訊息會不會被追蹤和重試：要看它走哪條路**
- 文件的說法：`docs/architecture.md:307` 寫，在佇列中等待的排程訊息「is not followed: it is not retried if all its replies fail」。
- **路徑一：在 run 進行中被送進去**（在下一個 turn 前由 `deliverQueued()` 送出，`src/server/orchestrator.ts:6157`）：
  - run 的追蹤狀態不變，訊息上的 `tracked` 被忽略。
  - 不追蹤，也不重試；文件的說法正確。
- **路徑二：自己啟動新的 run**（經由 `startQueued()`；發生在 run 結束前沒有 turn 接手，或 lead agent 正在審查時）：
  - `carriedTracking()` 原樣帶上 `tracked`，`retries` 也在內（`src/server/orchestrator.ts:3056-3057`），接著標成 in flight（`src/server/orchestrator.ts:3670`），再由 `trackedRunEnded()` 重試（`src/server/orchestrator.ts:3134`）。
  - 會追蹤、會重試，重啟後也會恢復；文件的說法錯誤。
- 測試只涵蓋目標走到路徑二（`test/orchestrator-tracking.test.ts:120`），沒有斷言重試。
- 修正時兩條路徑都要顧到。

**D2. 沒用到的字串**
- i18n 的 `trackingRunFailed` 有定義，但沒有任何地方使用（`src/server/i18n.ts:1074,2551`）。

## 四、建議的處理順序

依「對多天任務穩定度的影響」排序。每一項都需要先寫提案，再動手。

1. **依失敗類型採取行動**（A1、A6）
   - `AgentRunError` 加上分類：額度、驗證、網路、其他。
   - 額度用完：依 `resetsAt` 安排下一次重試，或改用同一個 CLI 的另一個帳號。不要用固定的 5、30、120 分鐘；這對每天、每週一次的排程最有用。
   - 登入失效、OAuth 變成 `reauth`：發出專屬的提醒。
2. **補齊重試和恢復的範圍**（A7、A8）
   - 事件觸發和 webhook 的追蹤目標 run 也要能重試；失敗的事件不要丟掉。
   - 停機很久之後，被打斷的 run 也要能恢復，或至少留下筆記。
   - 固定指令被改動時要推播，而且這種失敗不該用掉重試次數。
3. **turn 的 inactivity watchdog**（B1）：太久沒有任何事件時，就停掉這個 turn，交給重試處理。
4. **全新 session 的歷史設上限**（B3）：例如送出摘要加上最近 N 則，避免長對話一換 session 就超出 context。
5. **手動 run 的重啟恢復**（A4）：至少在重啟後提示「繼續」並發出提醒；也可以比照追蹤目標，自動接著做。
6. **伺服器自我照護**（A5）：伺服器崩潰時，桌面 App 自動重啟它；有排程開著時，預設不讓電腦睡著。
7. **停滯、漏報與花費**（B5、B9）
   - 回覆漏了 `<progress>`，或連續 N 次 run 都沒有進展：標成需要使用者處理。
   - 加上跨 run 的花費上限。
8. **保留政策**（C1–C5）
   - 自動封存或刪除舊的排程對話，清理快照 ref。
   - 讓 `Store.cache` 能淘汰舊資料，列表加上分頁。
   - 檢查快照收進的大型未追蹤檔案。
   - 資料庫定期 `VACUUM`，或設 `journal_size_limit`。

## 五、今天就要跑多天任務的話

1. **機器**：用一台不睡眠的機器，照 `docs/remote-access.md` 的 systemd 範例常駐。Codespaces 不適合，就算拉長閒置逾時也一樣；闔上螢幕的 MacBook 也不行。
2. **排程**：用「自動任務」加上「追蹤目標」，觸發方式選**排定時間**；事件觸發和 webhook 的 run 不會重試，也不會在重啟後恢復。
   - 間隔不要比單次 run 短，否則之後的時間會被跳過。
   - 要撐過額度窗口，間隔至少要跟窗口一樣長（例如 Claude 的 5 小時窗口，就設 5–6 小時）。
   - 不要以為間隔越長越好：每天一次的排程，重試約 2.5 小時就用完，額度重置後還要再等將近一天。
3. **權限**：讓任務能在權限範圍內做完。
   - 「替我核准」能放行一部分請求，但推送、發布、要求這個 turn 更多存取權，以及沒說清楚要做什麼的請求，一律會被拒絕；需要審核的請求，每個都要花一次 lead agent 的額度。
   - 完全存取什麼都不問，風險自負。
4. **通知**：打開推播，手機上才看得到 `blocked`、提問和錯誤。下列情況不會推播，要自己回來看：
   - 固定指令被改動；
   - 事件檢查失敗；
   - OAuth 需要重新登入；
   - 三次重試後放棄。每次失敗本身都會有 `error` 提醒，但放棄的那則筆記沒有；
   - 自己開始、被重啟或崩潰打斷的 run（`aborted` 沒有提醒）。
5. **模式和記憶**：
   - 用圓桌或接力模式，不要用平行模式。
   - 需要跨 run 記住的東西，請 agent 寫進工作目錄的檔案；必要時打開長期記憶。
   - 大型輸出放在 `.gitignore` 涵蓋的資料夾，避免被快照收進去。
   - 同一對話跑的排程，agent 不要向使用者提問；必要時改成每次開新對話。
6. **事前確認**：方案額度要夠用；Google OAuth app 不要停在 Testing 狀態；如果自動任務會先跑固定指令，agent 就不要改到它 pin 住的檔案。

## 六、待決問題

- 桌面 App 的「執行時不讓電腦睡著」（Electron 的 `prevent-app-suspension`）在 MacBook 闔上螢幕時能不能防止睡眠（A5）：沒實測。
- Claude Code、Codex、Grok、Muse、Antigravity、Cursor、Goose、OpenHands、Pi 在沒有終端機的執行裡會不會自己更新（B7）：沒驗證。
- 各 CLI 碰到方案額度、429、登入失效時，實際印出的文字能不能可靠地分辨（第四節第 1 項的前提）：要看執行時的 CLI，盤點時沒辦法確定。
- 排入佇列的排程訊息該不該被追蹤和重試（D1）：兩條路徑現在行為不同，要先決定哪一種才是想要的。
