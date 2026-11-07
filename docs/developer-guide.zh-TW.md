[English](developer-guide.md) | **繁體中文**

# 開發者說明

說明程式碼的組織方式、如何執行與測試，以及如何擴充。建議先讀[架構](architecture.zh-TW.md)了解全貌。

## 技術棧

| 層級 | 技術 |
| --- | --- |
| 語言 | TypeScript（strict）、ES modules |
| 伺服器 | Node.js ≥ 22.13、[Hono](https://hono.dev)（`@hono/node-server`），以 `tsx` 執行（不需建置） |
| 資料庫 | 透過內建的 `node:sqlite`（`DatabaseSync`）使用 SQLite |
| 前端 | React 19、Vite、`react-markdown` + `remark-gfm` + `rehype-highlight` |
| 測試 | Vitest |

## 專案結構

```text
src/
  shared/types.ts          伺服器與前端共用的型別（以及 PROVIDERS、effortsFor…）
  server/
    index.ts               路由、安全性中介層、SSE、靜態檔案、啟動
    orchestrator.ts        團隊回合：排程、交付 prompt、把串流寫進訊息
    prompt.ts              角色簡報、回合 prompt、@ 解析、[PASS]
    agents/
      types.ts             AgentRunner 介面、AgentEvent、輔助函式
      claude.ts codex.ts grok.ts   每個 CLI 一個轉接器（parser + run）
      index.ts             runner 註冊表
    process.ts             啟動/結束程序（process group、逐行串流、逾時）
    providers.ts           CLI 狀態、登入流程、登出、模型快取
    models.ts              各 CLI 的模型 / 推理強度探索
    db.ts                  開啟 SQLite、遷移、transaction()
    store.ts               對話、訊息、agent session、範本
    settings.ts            provider 設定、預設工作目錄、子程序環境變數
    presets.ts             內建團隊範本
    validate.ts            agent 與設定的輸入驗證
    workspace.ts           git：自動 init、快照、worktree、diff、套用
    errors.ts              HttpError（帶狀態碼、給使用者看的錯誤）
    hub.ts                 SSE 廣播
  web/
    main.tsx App.tsx api.ts util.ts styles.css index.html
    components/            Sidebar、NewChat、TeamEditor、ModelPicker、ChatView、
                           MessageItem、ChangesCard、Composer、Markdown、SettingsPage
test/                      Vitest 測試
docs/                      文件（English + 繁體中文）
data/                      執行時資料（relay.db），已列入 git ignore
```

## 執行

```bash
npm install
npm run dev        # tsx watch（API :8787）+ vite（介面 :5173，把 /api/ 代理到 API）
npm run typecheck
npm test
npm run build      # 介面 → dist/web
npm start          # 單一程序：API + 建置好的介面，port 8787
```

`npm run dev` 會在每次檔案變更時重啟伺服器。重啟會中止正在執行的 agent 回合（訊息會標為已中斷），所以長回合執行中請避免修改伺服器檔案。

### 環境變數

| 變數 | 預設值 | 用途 |
| --- | --- | --- |
| `PORT` | `8787` | API port（Vite 代理也會使用） |
| `HOST` | `127.0.0.1` | 綁定位址 |
| `RELAY_DATA_DIR` | `./data` | `relay.db` 的位置 |
| `RELAY_DEFAULT_CWD` | 程序的 cwd | 初始預設工作目錄（在設定頁修改前） |
| `RELAY_ALLOWED_HOSTS` | — | Host/Origin 檢查額外允許的主機名稱，以逗號分隔 |

伺服器會把自己的環境變數傳給各 CLI，但移除 Claude Code 的巢狀執行變數，並加上已保存的 API key（`SettingsStore.env()`）。

## 請求流程

1. 前端送出 `POST /api/conversations/:id/messages` → `Orchestrator.send()` 準備工作區（可編輯 / 完全存取時：必要時 `git init`，非平行模式再取得目錄鎖），加入使用者訊息，並在背景啟動 `execute()`（請求立即回傳 `202`）。
2. `execute()` 依模式決定發言者（平行模式會先建立每個 agent 的 worktree），對每位呼叫 `turn()`。
3. `turn()` 建立串流中的 agent 訊息，記下起始狀態（worktree 的 `HEAD` 或一份快照），計算該 agent 還沒看過的訊息，組出 prompt（`prompt.ts`），並在正確的目錄呼叫 `runners[provider].run()`。
4. 轉接器啟動 CLI（`process.ts`），逐行解析 stdout 並送出 `AgentEvent`。
5. `turn()` 把事件套用到訊息上，透過 `Hub` 送出 SSE 事件，並透過 `Store` 保存。CLI 結束後，把修改的檔案（worktree 中的 commit，或第二份快照）記錄在訊息上。

## HTTP API

所有寫入請求都必須帶 `Content-Type: application/json`（CSRF 防護）。錯誤格式為 `{ "error": string }`，狀態碼 400/404/409/415/500。

| 方法與路徑 | Body → 回應 |
| --- | --- |
| `GET /api/conversations` | → `ConversationSummary[]` |
| `POST /api/conversations` | `{ title?, agents, settings }` → `Conversation` |
| `GET /api/conversations/:id` | → `Conversation` |
| `PATCH /api/conversations/:id` | `{ title?, agents?, settings? }` → `Conversation`（執行中回 409） |
| `DELETE /api/conversations/:id` | 停止執行並刪除 |
| `POST /api/conversations/:id/messages` | `{ text }`（空字串＝繼續）→ `202` |
| `PUT /api/conversations/:id/messages/:messageId` | `{ text }` → `202`：編輯使用者訊息——這則與之後的訊息都會刪除，每個 agent 開新 session，團隊重新回答（`Orchestrator.resend()`） |
| `POST /api/conversations/:id/stop` | 中止執行 |
| `GET /api/conversations/:id/messages/:messageId/diff` | → 該回合修改的 unified diff（純文字） |
| `GET /api/conversations/:id/agents/:agentId/diff` | → 某個 agent 整份 worktree 結果的 unified diff（純文字） |
| `POST /api/conversations/:id/agents/:agentId/apply` | 把 agent 的 worktree 結果套用到工作目錄 → `{ files }`（衝突時回 409） |
| `GET /api/conversations/:id/events` | `ServerEvent` 的 SSE 串流 |
| `GET /api/presets` · `POST /api/presets` · `DELETE /api/presets/:id` | 團隊範本 |
| `GET /api/settings` · `PUT /api/settings` | `{ defaultCwd? }` |
| `PUT /api/settings/providers/:provider` | `{ bin?, defaultModel?, defaultEffort?, apiKey? }`（`apiKey: null` 代表移除） |
| `GET /api/providers[?refresh=1]` | → `ProviderStatus[]` |
| `GET /api/models[?refresh=1]` | → `ProviderModels[]` |
| `GET /api/providers/:provider/login-methods` | → `LoginMethod[]` |
| `POST /api/providers/:provider/login` | `{ method }` → `LoginSessionView` |
| `GET /api/providers/:provider/login` | → `LoginSessionView \| null`（執行中時輪詢） |
| `POST /api/providers/:provider/login/input` | `{ text }` → 寫入登入程序的 stdin |
| `DELETE /api/providers/:provider/login` | 取消登入 |
| `POST /api/providers/:provider/logout` | 登出該 CLI |

型別定義在 `src/shared/types.ts`。

## 新增一個 agent CLI

1. **型別**：在 `src/shared/types.ts` 的 `Provider`、`PROVIDERS`、`PROVIDER_LABEL` 加上新的 id。
2. **轉接器**：建立 `src/server/agents/<name>.ts`：
   - `create<Name>Parser(emit)`：把一行 stdout 轉成 `AgentEvent`（`session`、`text`、`text_end`、`tool_start`、`tool_end`），並記住最終結果或錯誤；
   - 一個 `AgentRunner`，其 `run()` 組出參數（prompt、system prompt、新建/接續 session、權限、模型、推理強度），呼叫 `runProcess()`，失敗時丟出 `AgentRunError`（被停止時 `aborted = true`）。
   parser 請保持純函式，方便用錄下來的輸出測試。
3. 在 `src/server/agents/index.ts` **註冊**。
4. **設定**：在 `src/server/settings.ts` 的 `DEFAULT_BIN` 加預設執行檔名稱；若 CLI 從環境變數讀 API key，也加到 `API_KEY_ENV`。
5. **狀態與登入**：`src/server/providers.ts` 的 `checkAuth()` 與 `LOGIN_METHODS`，以及 `logout()` 中的登出指令。
6. **模型**：在 `src/server/models.ts` 加探索函式（或固定清單）。
7. **介面**：`styles.css` 的顏色變數（`--<name>`）、`src/web/util.ts` 的 `PROVIDER_COLOR` 與 `newAgent()`、`SettingsPage.tsx` 的 API key 說明文字。

## 資料庫變更

Schema 定義在 `src/server/db.ts` 的 `MIGRATIONS` 陣列；`PRAGMA user_version` 記錄已套用幾個。要修改 schema：

1. 在 `MIGRATIONS` **新增**一段 SQL（不要修改已發布的段落）。
2. 更新 `store.ts` / `settings.ts` 中的資料列型別與查詢。
3. 新增或更新 `test/store.test.ts` 的測試。

每個遷移在啟動時各自於一個交易中執行。node:sqlite 無法綁定 `undefined`；選填值請用 `nul()`，多個寫入敘述請用 `transaction(db, fn)`（不支援巢狀）。

檢查資料：

```bash
sqlite3 data/relay.db '.tables'
sqlite3 data/relay.db 'select seq, author_kind, agent_name, status from messages order by conversation_id, seq'
```

## 修改 prompt

- `buildBriefing()`：system 層級的簡報（角色、團隊、模式規則、工作目錄），每回合重新產生。
- `buildTurnPrompt()`：每回合的訊息，包含 `<chat>` 與最後的提示句。
- `forwardText()`：一則回覆如何呈現給其他 agent（文字 + `<actions>` 紀錄）。
- `parseMentions()`：@ 解析；行內程式碼與程式碼區塊中的 @ 會被忽略。

prompt 刻意使用英文（agent 會用使用者的語言回覆）；介面文字則是繁體中文。

## 測試

```bash
npm test               # 全部測試
npx vitest test/store.test.ts
```

目前的測試：

- `test/store.test.ts`：SQLite store 與設定（存取往返、串流更新、當機復原、連帶刪除、檔案權限）。
- `test/workspace.test.ts`：用真實的暫存 repository 測試 git 操作（自動 init、不影響 repo 的快照、worktree、套用、衝突）。
- `test/orchestrator.test.ts`：把假的 runner 換進 `runners` 跑完整流程：平行模式的 worktree 隔離與套用、圓桌模式的修改紀錄、目錄鎖。
- `test/grok.test.ts`：Grok 的 ACP 轉接器：各權限的核准規則、session 更新轉成 `AgentEvent`、JSON-RPC 連線。
- `test/claude.test.ts`：Claude 預先允許的工具，以及工具被拒絕時顯示的原因。
- `test/copy.test.ts`：複製單則訊息或整段對話時產生的 Markdown。

`test/orchestrator.test.ts` 也涵蓋編輯使用者訊息（`resend`）：之後的訊息會被刪除，每個 agent 都開新的 session。

接下來適合補上的：

- **轉接器 parser**：把真實 CLI 輸出錄成 fixture 檔，驗證送出的 `AgentEvent`。錄製方式：

  ```bash
  echo "hello" | claude -p --output-format stream-json --verbose --include-partial-messages > claude.jsonl
  echo "hello" | codex exec --json --skip-git-repo-check - > codex.jsonl
  # Grok 走 ACP；fixture 可以從它為每個 session 保存的更新紀錄複製：
  # ~/.grok/sessions/<URL 編碼的 cwd>/<session-id>/updates.jsonl
  ```

- **prompt 輔助函式**：`parseMentions`、`isPass`、`buildTurnPrompt`。
- **更多協調器排程**：接力交棒、`[PASS]` 提前結束、接續失敗後重試，做法同 `test/orchestrator.test.ts` 的假 runner。

在測試中跑真正的 agent 會花錢且需要登入，所以自動化測試請保持離線。

## 除錯技巧

- **伺服器 log**：`npm run dev` 輸出中的 `[server]` 行；轉接器失敗時，訊息的錯誤內容會附上 CLI stderr 的最後一段。
- **SSE**：`curl -N http://localhost:8787/api/conversations/<id>/events` 可以看到原始事件串流。
- **重現 CLI 呼叫**：`src/server/agents/*.ts` 中的參數可以手動執行；加上 `--debug`（Claude、Grok）可看到更多資訊。
- **worktree**：`git -C <工作目錄> worktree list` 與 `git branch --list 'relay/*'` 可以看到平行對話建立了哪些 worktree；實際檔案在 `data/worktrees/<對話>/`。
- **session 卡住**：先停止伺服器，再刪除 `agent_sessions` 中該 agent 的那一列，就會強制開新 session 並提供完整紀錄（使用中的對話快取在記憶體裡，所以只在伺服器停止時修改資料庫）。

## 慣例

- 使用 strict TypeScript；共用型別只放在 `src/shared/types.ts`。
- 絕不把機密傳給前端（`SettingsView` 只回傳遮罩過的金鑰）。
- 新增的寫入端點會自動經過 `/api/*` 中介層的 JSON content-type 與 Host/Origin 檢查，請維持這個做法。
- 啟動程序一律透過 `process.ts`，這樣才會被追蹤並在關閉時結束。
