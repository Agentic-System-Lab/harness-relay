[English](triggers.md) | **繁體中文**

# 排程與事件觸發的執行

> **狀態：第一步（排程）已完成，其餘仍是提案。** 見[提案](README.zh-TW.md)。

## 已經做好的部分

第一步——同一個對話裡的排程——已經在 app 中：見[架構 → 排程](../architecture.zh-TW.md#排程)。做法依照這份設計，差別如下：

- **每個對話一個排程**，沒有名稱（`conversation.schedule`、`schedules` 資料表、`PUT`／`DELETE /api/conversations/:id/schedule` 與 `POST …/schedule/run`），而不是一串觸發器。它送出的訊息帶 `scheduled: true`，而不是 `trigger: { id, name, kind }`；在對話中標為 **排程**，agent 看到的是 `via="schedule"`。
- **間隔以整數小時計**（1–168，從儲存時算起）；還沒有分鐘。
- **時間依排程的時區計算**：儲存時瀏覽器的時區（沒有給就用伺服器的），所以時鐘調整前後每天的時間都正確。
- **核准由排程自己決定**，而不是提出警告並建議修改對話：排程開始的執行會自動拒絕核准請求，除非排程設為詢問；使用者自己開始的執行不受影響。
- 排程器每 15 秒檢查一次，晚了超過 10 分鐘的時間算錯過（`missed: 'skip' | 'run'`）。沒有送出的時間會在對話中留下說明；agent 在等使用者回答時也會先不送。

仍待完成：webhook 觸發器（第二步）、每個對話多個有名稱的觸發器、以分鐘計的間隔，以及每次觸發開新對話（第三步）。

讓對話不用使用者打字也能開始一輪：在設定的時間（「每個工作日 9:00 檢查昨天的 commit」），或在這台電腦上的程式回報事件時（「`main` 的 CI 失敗了」）。

## 現在有什麼

- 一輪只能由使用者開始：`Orchestrator.send()`（`POST /api/conversations/:id/messages`）或**繼續**。伺服器沒有任何會開始一輪的計時器。
- 每個回合跑一個 CLI process，回合結束它就結束（[CLI 轉接器](../architecture.zh-TW.md#cli-轉接器)）。所以 agent 在回合中於自己 CLI 裡設的排程——Claude Code 的 `/loop` 和 `CronCreate`、Grok 的 `/loop` 和 `scheduler_create`——會在回合結束時停掉，結果也不會回到聊天。
- 各 CLI 自己的自動化都在 Harness Relay 外面跑：Claude Code routines（在 Anthropic 雲端；排程、API、GitHub 觸發）、Codex app 的 automations、GitHub 整合（`@claude`、`@codex`）。它們的結果同樣不會回到 Harness Relay 的對話。
- 觸發需要的零件已經有了：訊息佇列（`conversation.queue`，最多 20 則）會收下一輪進行中送來的訊息，結束後再為它開一輪；團隊在等使用者回答時（`conversation.pause`），佇列裡的訊息會繼續等；對話可以設成自動拒絕核准請求（`approvals: 'deny'`）。

## 目標

- 對話可以有觸發器。觸發器往對話送一則固定的訊息，之後的執行就跟使用者自己送出一樣：@mention 決定誰發言、套用模式和輪數、agent 透過「還沒看過的訊息」收到它。
- 兩種：**排程**（依這台電腦的時鐘）和 **webhook**（本機程式呼叫一個 HTTP endpoint）。
- 無人看管的執行預設是安全的：會寫檔的執行不會永遠卡在沒人回答的核准請求上，事件資料也不能冒充使用者。
- 重啟後一切都還在（`npm run dev` 每次改檔都會重啟伺服器）。

## 不在範圍內

- Harness Relay 沒在跑的時候執行。它是本機 app；關著的時候什麼都不會觸發（見[錯過的執行](#錯過的執行)）。
- 從網際網路接收 webhook。伺服器綁在 `127.0.0.1`，而且沒有驗證。見[外部事件](#外部事件)。
- 驅動 CLI 自己的排程器或雲端 routines。

## 設計

### 觸發器

觸發器屬於一個對話，對話刪除時一起刪除。

| 欄位 | 意思 |
| --- | --- |
| `id`、`name` | `name` 會顯示在它送出的訊息上 |
| `kind` | `schedule` 或 `webhook` |
| `enabled` | 關閉時保留觸發器，但不會觸發 |
| `text` | 它送出的訊息；可以 @mention agent |
| `schedule` | `schedule` 用：見下方 |
| `missed` | `schedule` 用：`skip`（預設）或 `once` |
| `tokenHash` | `webhook` 用：token 的 SHA-256 |
| `lastFiredAt`、`nextFireAt`、`lastResult` | `lastResult`：`posted`、`queued`、`skipped`（附原因）或 `failed`（附錯誤） |

### 觸發時

觸發走的是跟使用者送出訊息相同的路徑，只是帶上觸發器：

1. 如果這個觸發器之前送的訊息還在佇列裡等，就什麼都不做，記錄 `skipped`（團隊忙碌或在等使用者回答時，觸發不會越疊越多）。
2. 如果佇列滿了，或 lead agent 設計的團隊還在等確認，記錄 `skipped` 和原因。
3. 否則送出訊息。它是一則普通的使用者訊息（`author.kind = 'user'`，所以 mention、模式和遞送都不用改），多一個欄位 `trigger: { id, name, kind }`。對話忙碌時，它跟回覆中送出的訊息一樣進佇列。

UI 會用觸發器的名稱代替「你」顯示這則訊息。agent 看到的是 `<message from="user" via="schedule: Daily review">`，briefing 也會告訴它們這一輪可能沒人在看，所以除非沒有答案就無法繼續，不要用 `[ASK_USER]` 結尾。

### 排程

先支援大家真的會設的，而不是完整的 cron：

- 每 *N* 分鐘或小時（至少 5 分鐘）；
- 每天、每個工作日或選定的星期幾，在 *HH:MM*；
- 一次，在某個日期時間。

時間用電腦的時區。下次觸發時間的計算是純函式（`nextFire(schedule, after)`），並測試日光節約時間切換。cron 表達式之後可以在同一個函式後面加上。

### 排程器

`src/server/triggers.ts` 放 `TriggerScheduler`，在 `src/server/index.ts` 裡跟 orchestrator 一起啟動和停止：

- 啟動時載入啟用中的排程觸發器，並套用錯過執行的規則。
- 只用一個計時器，每 30 秒（unref）檢查是否有 `nextFireAt` 已經過了，每次都跟牆上時鐘比對。筆電睡過觸發時間的話，醒來就觸發，不會漂移；也從不相信長時間的 `setTimeout`。
- 觸發之後，或觸發器被建立、修改、啟用時，計算新的 `nextFireAt` 並存起來。
- 關機時先停計時器，再停各輪執行。

### 錯過的執行

伺服器啟動（或電腦醒來）時，觸發時間已經過了：

- `skip`（預設）：不觸發；把 `nextFireAt` 移到現在之後的下一個時間。
- `once`：不管錯過幾次，都只觸發一次，然後往後移。

### Webhook 觸發器

`POST /api/triggers/:id/fire`，帶 `Authorization: Bearer <token>` 和 JSON body。

- token 在建立觸發器時產生，只顯示一次；資料庫只存它的 SHA-256，用固定時間比較。「新 token」會取代舊的。token 錯誤或沒帶時回 404，跟不存在的觸發器一樣。
- 這個路由放在 `/api/` 下，所以 Host、Origin 和 JSON content-type 檢查都適用。呼叫者是這台電腦上的程式：git hook、CI runner、檔案監看程式、cron job、`gh webhook forward`。
- 送出的訊息是觸發器的 `text`，後面接放在 `<event>` 區塊裡的 body，最多 20 KB。briefing 會說明 `<event>` 區塊是程式送來的資料，不是使用者的要求：裡面的指令不要照做。
- 每個觸發器每 10 秒最多觸發一次；超過的回 429。[觸發時](#觸發時)的第 1 條也適用。

關於 token 保護了什麼：這台電腦上的任何 process 本來就能呼叫其他 API，那些 API 沒有驗證。token 不會讓 app 對本機程式更安全。它給每個呼叫者一個範圍很小、可以撤銷的把手——只能觸發這一個觸發器，其他什麼都不能做——而且之後如果要開放到 localhost 以外，就需要它。

### 無人看管時的核准

觸發器開始的一輪可能沒人在看。在權限是 `edit` 或 `full`、核准設為 `ask` 的對話上建立或啟用觸發器時，UI 會警告：核准請求會一直等到有人回答（最多到 45 分鐘的回合逾時），並提議把對話改成自動拒絕。權限是 `full` 的對話上的 webhook 觸發器會有更強的警告，因為事件資料來自外部。

### 通知

側邊欄已經會標出執行中、等待中或在問問題的對話。有啟用中觸發器的對話會多一個小時鐘標記，滑鼠停上去會顯示下次觸發時間。觸發的一輪跑完時，跟其他回覆一樣算未讀。系統通知（瀏覽器 `Notification`）可以之後再做。

## HTTP API

| 方法和路徑 | 用途 |
| --- | --- |
| `GET /api/conversations/:id/triggers` | 列出觸發器，含下次觸發時間和上次結果 |
| `POST /api/conversations/:id/triggers` | 建立；webhook 觸發器的回應會附上 token，只有這一次 |
| `PATCH /api/triggers/:id` | 修改、啟用或停用 |
| `DELETE /api/triggers/:id` | 刪除 |
| `POST /api/triggers/:id/run` | 從 UI 立刻觸發（不用 token：套用 UI 平常的檢查） |
| `POST /api/triggers/:id/token` | 換掉 webhook 觸發器的 token；回應附上新的 token，只有這一次 |
| `POST /api/triggers/:id/fire` | webhook：`Authorization: Bearer <token>` |

`triggers` SSE 事件會通知開著的頁面，某個對話的觸發器變了。

## 資料庫

在 `src/server/db.ts` 的 `MIGRATIONS` 後面加一個 migration：

- 新資料表 `conversation_triggers`（`id`、`conversation_id` 加 `ON DELETE CASCADE`、`name`、`kind`、`enabled`、`text`、JSON 格式的 `schedule`、`missed`、`token_hash`、`last_fired_at`、`next_fire_at`、JSON 格式的 `last_result`、`created_at`）；
- `messages` 新增欄位 `trigger`（JSON，可為空），存 `{ id, name, kind }` 的副本，所以觸發器刪掉之後，訊息還是看得出來源。

## UI

- 對話設定裡新增**觸發器**區塊：列出、建立和修改（種類、名稱、訊息、排程或 webhook 細節、錯過執行的規則）、啟用開關、**立刻執行**；webhook 另外顯示 endpoint、可複製的 `curl` 範例和**新 token**。
- 觸發器送出的訊息顯示它的名稱和種類，而不是「你」。
- 側邊欄的時鐘標記。
- 所有新字串都加進 `src/web/locales/zh-TW.ts` 和 `en.ts`，伺服器文字（結果、警告）加進 `src/server/i18n.ts`。

## 測試

- `nextFire()`：每種排程、電腦時區、日光節約時間切換、已經過去的 `once`。
- 用假計時器測排程器：觸發、長時間睡眠後的 30 秒檢查、啟動時的 `skip` 和 `once`、修改觸發器會重算時間、關機時停止。
- 用假 runner（`test/orchestrator.test.ts`）測觸發：送出並開始一輪；一輪進行中時進佇列；之前的訊息還在等、佇列已滿、團隊設計在等確認時跳過；`trigger` 欄位有出現在訊息和 agent 的 prompt 裡。
- 用 `app.request()` 測 HTTP API：需要 token 且有比對、錯的 token 回 404、頻率限制回 429、body 截到 20 KB 並放在 `<event>` 裡、Host/Origin/content-type 檢查仍然有效。
- `test/store.test.ts`：新資料表和欄位、刪除對話時一起刪除。

## 步驟

1. 在同一個對話裡的排程觸發器，含 UI、錯過執行的規則和警告。
2. Webhook 觸發器。
3. 也許：每次觸發都開一個**新對話**的觸發器（同樣的團隊、設定和側邊欄群組），讓每天的觸發器不會讓一個對話無限變長。見待決問題。

## 外部事件

來自網際網路的事件（GitHub、Slack、Linear）到不了綁在 `127.0.0.1` 的伺服器，而且應該維持這樣：API 沒有驗證。不開放伺服器也能用它們的方法：

- **用排程觸發器輪詢**，不需要新東西：「每 15 分鐘用 `gh issue list` 檢查新 issue 並分類」。
- **在這台電腦上跑轉發程式**，收到事件後呼叫 webhook 觸發器，例如 GitHub repository 可以用 `gh webhook forward`。

透過通道（tunnel）開放伺服器不在範圍內。如果哪天真的要做，只能讓 `POST /api/triggers/:id/fire` 從那裡連得到。

## 考慮過的其他做法

- **用各 CLI 自己的排程器。** 不採用：排程器會跟著回合的 process 結束；CLI 的雲端 routines 和 app automations 在 Harness Relay 外面跑，需要它們自己的帳號和方案，結果也不會回到對話。
- **讓 CLI process 在回合之間保持執行。** 不採用：每個轉接器的執行方式都要改；CLI 的 session 內排程會過期（Grok 的是 7 天），只在 process 活著時有效，而且觸發時是在背景任務裡跑，聊天看不到。
- **新增作者種類（`trigger`），而不是在使用者訊息上加欄位。** 目前不採用：所有特別處理使用者訊息的地方（mention、佇列、還沒看過的訊息、「繼續」）都得認識它。加欄位就能給 UI 和 prompt 需要的東西，不用改那些。
- **一開始就支援完整的 cron 表達式。** 延後：在 UI 裡比較難顯示和編輯，而簡單的形式已涵蓋大部分用途。

## 待決問題

- 同一個對話，還是每次觸發開新對話（步驟 3）？長期使用的對話保留 agent 的上下文但會越來越長；每次開新對話很乾淨，但會失去之前學到的東西，除非把它寫進[共用的記憶](shared-memory.zh-TW.md)。
- 觸發器能不能用比對話低的權限執行（例如 webhook 觸發器一律唯讀）？
- 觸發器要不要存進團隊範本（`presets`），讓範本把排程一起帶過去？
- 間隔最短可以多短？5 分鐘能壓低成本和雜訊；輪詢 CI 可能需要更短。
