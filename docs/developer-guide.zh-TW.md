[English](developer-guide.md) | **繁體中文**

# 開發者說明

說明程式碼的組織方式、如何執行與測試，以及如何擴充。建議先讀[架構](architecture.zh-TW.md)了解全貌。

## 技術棧

| 層級 | 技術 |
| --- | --- |
| 語言 | TypeScript（strict）、ES modules |
| 伺服器 | Node.js ≥ 22.13、[Hono](https://hono.dev)（`@hono/node-server`），以 `tsx` 執行（不需建置） |
| 資料庫 | 透過內建的 `node:sqlite`（`DatabaseSync`）使用 SQLite |
| API key | 透過 [`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node) 使用作業系統的金鑰儲存區（預先編譯好的原生模組，不需編譯器） |
| 前端 | React 19、Vite、`react-markdown` + `remark-gfm` + `rehype-highlight` |
| 測試 | Vitest |

## 專案結構

```text
src/
  shared/types.ts          伺服器與前端共用的型別（以及 PROVIDERS、effortsFor…）
  shared/mentions.ts       伺服器與介面共用的 @ 規則（只看 Markdown 中的一般文字）
  shared/search.ts         搜尋的詞、不分大小寫的比對、摘錄、標示關鍵字（伺服器與介面共用）
  server/
    index.ts               組裝元件、靜態檔案、啟動與關閉
    web.ts                 提供建置好的介面：帶雜湊的檔案永久快取，index.html 每次都檢查
    app.ts                 createApp()：路由、安全性中介層、SSE（可用 app.request() 測試）
    orchestrator.ts        團隊回合：排程、交付 prompt、把串流寫進訊息；自動組隊、重新傳送
    planner.ts             自動組隊：首席 agent 的 prompt、解析回覆、可執行的團隊、備援方案
    grouping.ts            側邊欄群組：首席 agent 依第一則訊息把新對話分到群組
    prompt.ts              角色簡報、回合 prompt、@ 解析、[PASS]
    approvals.ts           「本對話都允許」的規則 key（這行指令執行的每個指令各一個）
    commands.ts            解析 shell 指令：拆出各個指令、sh -c、包裝程式、推送／發佈判斷
    i18n.ts                伺服器訊息（zh-TW / en）、每個請求與執行的語言
    agents/
      types.ts             AgentRunner 介面、AgentEvent、輔助函式
      claude.ts            Claude Code：雙向 stream-json、can_use_tool 控制請求
      codex.ts             Codex：`codex app-server`（thread / turn / 核准請求）
      grok.ts              Grok：ACP（`grok agent stdio`）
      acp.ts               Codex 與 Grok 轉接器共用的 JSON-RPC 對端
      index.ts             runner 註冊表
    process.ts             啟動/結束程序（process group、逐行串流、以位元組保存輸出、逾時）
    providers.ts           CLI 狀態、登入流程、登出、模型快取
    models.ts              各 CLI 的模型 / 推理強度探索
    db.ts                  開啟 SQLite、遷移、transaction()
    store.ts               對話、訊息、agent session、範本、側邊欄群組、搜尋
    settings.ts            provider 設定、預設工作目錄、子程序環境變數
    secrets.ts             存放 API key 的作業系統金鑰儲存區（keyring）、可用性檢查
    tools.ts               工具庫：MCP 伺服器（機密值放在 keyring）、skill（SKILL.md 的 front matter）、記憶；每位成員拿到哪些
    files.ts               瀏覽對話的檔案：可瀏覽的資料夾、列表、預覽、路徑檢查
    native.ts              各 CLI 自己載入的內容（它的 skill、MCP 伺服器、記憶檔），不送 prompt 查詢
    grokTrust.ts           在使用者確認後記錄 Grok 對資料夾的信任（和 grok --trust 相同）
    attachments.ts         訊息的附加檔案：儲存、安全檔名、交給 agent 的圖片
    presets.ts             內建團隊範本（兩種語言）
    validate.ts            agent 與設定的輸入驗證
    voice.ts               語音輸入：安裝 whisper.cpp 引擎與模型（固定版本、檢查 SHA-256）、引擎程序、語音轉文字
    workspace.ts           git：自動 init、快照、worktree、diff、套用
    errors.ts              HttpError（帶狀態碼、給使用者看的錯誤）
    hub.ts                 SSE 廣播
  web/
    main.tsx App.tsx api.ts util.ts copy.ts styles.css index.html
    chat.ts                ChatView 的純邏輯：串流是否重新連線、能否套用、團隊設定草稿
    sidebar.ts             側邊欄的純邏輯：各群組的對話、還沒確認的移動、收合群組的狀態
    files.ts               檔案瀏覽的純邏輯：路徑導覽列、篩選、程式語言、行數
    tools.ts               團隊編輯器的工具選擇：工具庫項目、依 CLI 的預設、成員的例外設定
    route.ts               前端放在網址 hash 的路由，包括 #/settings/<區塊>
    voice.ts               語音輸入的純邏輯：WAV 編碼、靜音判斷、把辨識結果插入游標處、安裝進度
    recorder.ts            在瀏覽器錄音，解碼成 16 kHz 單聲道
    useVoice.ts            語音輸入狀態的 hook（安裝時輪詢）
    i18n.tsx               語言偵測、provider、useT()
    locales/               zh-TW.ts（訊息結構的來源）、en.ts
    components/            Sidebar、SidebarGroups（群組、拖放）、SidebarSearch、
                           NewChat、TeamEditor、ModelPicker、ChatView、
                           MessageItem（含 plan 卡片）、ChangesCard、Composer、Markdown、
                           SettingsPage、CopyButton、Logo、Onboarding（使用導覽）、
                           MemberDots、icons、VoiceInput（麥克風、安裝說明對話框、安裝進度）、
                           VoiceSettings（設定 → 語音輸入）、ToolsSettings（設定 → 工具庫）、
                           FileBrowser（「檔案」對話框）、NativeSetupPanel（CLI 自己載入的內容）、
                           GrokTrust（Grok 對資料夾的信任）、SectionTitle、
                           useDialog（對話框的焦點處理）
test/                      Vitest 測試
.github/workflows/ci.yml   CI：pull request 與推送到 main 時執行型別檢查、測試與建置
.github/workflows/pages.yml  把 site/ 發佈到 GitHub Pages
scripts/preview-site.ts    npm run site:preview：在本機以 Pages 的方式提供 site/
site/                      網站首頁（靜態 HTML，English + 繁體中文）；DESIGN-GUIDELINES.md 不會被發佈
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

`npm run build` 會把頁面啟動時載入的函式庫放在各自的 chunk（`react`、`highlight`、`vendor`），讓瀏覽器在 app 更新後仍可沿用快取；Mermaid 仍是需要時才載入。啟動時載入的 chunk 超過 500 kB 時會發出警告（`vite.config.ts`）；Mermaid 延遲載入的 chunk 比這大，只在需要畫圖時才載入。

`npm run dev` 會在每次檔案變更時重啟伺服器。重啟會中止正在執行的 agent 回合（訊息會標為已中斷），所以長回合執行中請避免修改伺服器檔案。

### 環境變數

| 變數 | 預設值 | 用途 |
| --- | --- | --- |
| `PORT` | `8787` | API port（Vite 代理也會使用） |
| `HOST` | `127.0.0.1` | 綁定位址 |
| `RELAY_DATA_DIR` | `./data` | `relay.db` 的位置 |
| `RELAY_DEFAULT_CWD` | 程序的 cwd | 初始預設工作目錄（在設定頁修改前） |
| `RELAY_ALLOWED_HOSTS` | — | Host/Origin 檢查額外允許的主機名稱，以逗號分隔 |
| `RELAY_KEYRING` | — | 設為 `off` 時 API key 存在資料庫而不是作業系統的金鑰儲存區（例如用完即丟的資料目錄） |

伺服器會把自己的環境變數傳給各 CLI，但移除 Claude Code 的巢狀執行變數，並加上已保存的 API key（`SettingsStore.env()`）。

## 請求流程

1. 前端送出 `POST /api/conversations/:id/messages` → `Orchestrator.send()` 準備工作區（可編輯 / 完全存取時：必要時 `git init`，非平行模式再取得目錄鎖），加入使用者訊息，並在背景啟動 `execute()`（請求立即回傳 `202`）。
2. 對話為自動組隊模式時，`execute()` 會先讓首席 agent 設計團隊（`designTeam()`，見[架構 → 自動組隊](architecture.zh-TW.md#自動組隊)），再依模式決定發言者（平行模式會先建立每個 agent 的 worktree），對每位呼叫 `turn()`。
3. `turn()` 建立串流中的 agent 訊息，記下起始狀態（worktree 的 `HEAD` 或一份快照），計算該 agent 還沒看過的訊息，組出 prompt（`prompt.ts`），並在正確的目錄呼叫 `runners[provider].run()`；除非對話設定為自動拒絕，否則會一併傳入 `requestApproval`。
4. 轉接器啟動 CLI（`process.ts`），逐行解析 stdout 並送出 `AgentEvent`。
5. `turn()` 把事件套用到訊息上（文字、思考、計畫、工具列與輸出），透過 `Hub` 送出 SSE 事件，並透過 `Store` 保存。核准請求會新增一個 approval part，並等待 `POST …/approvals/:approvalId`。CLI 結束後，把修改的檔案（worktree 中的 commit，或第二份快照）記錄在訊息上。

## HTTP API

所有寫入請求都必須帶 `Content-Type: application/json`（CSRF 防護）。錯誤格式為 `{ "error": string }`，狀態碼 400/404/409/415/500。帶上 `X-Relay-Lang: zh-TW | en`，錯誤、系統訊息與內建範本就會使用該語言（網頁介面一律會帶）。

| 方法與路徑 | Body → 回應 |
| --- | --- |
| `GET /api/conversations` | → `ConversationSummary[]`（附側邊欄用的 `running`、`waiting`、`lastStatus`、`groupId` 與 `sorting`） |
| `GET /api/search?q=` | → `SearchResult[]`：標題或使用者／agent 訊息包含 `q` 每個詞（不分大小寫）的對話，標題符合的在前，其餘依最近時間；最多 50 筆 |
| `PUT /api/conversations/:id/group` | `{ groupId }` → `{ ok }`：把對話放進側邊欄群組（`null` 代表「其他」）；群組不存在時回 404。使用者移動過的對話不會再自動分類 |
| `GET /api/groups` | → `ConversationGroup[]`，依建立順序（預設群組「其他」不在清單中） |
| `POST /api/groups` | `{ name }` → `ConversationGroup`（名稱空白、太長或重複——包括「其他」／Other——或超過 50 個群組時回 400） |
| `PATCH /api/groups/:id` | `{ name }` → `ConversationGroup` |
| `DELETE /api/groups/:id` | 刪除群組；裡面的對話會移到「其他」 |
| `POST /api/conversations` | `{ title?, agents, settings, createCwd? }` → `Conversation`；`settings.autoTeam: true` 時 `agents` 可以是空的，由首席 agent 在第一則訊息時設計團隊；`settings.cwd` 不存在時回 404 並帶 `code: "cwd-missing"`，除非帶 `createCwd: true`，此時會建立該目錄 |
| `GET /api/conversations/:id` | → `Conversation` |
| `PATCH /api/conversations/:id` | `{ title?, agents?, settings?, createCwd? }` → `Conversation`（執行中回 409；設定 `agents` 會關閉自動組隊；`settings.cwd` 不存在時同 `POST`） |
| `DELETE /api/conversations/:id` | 停止執行並刪除 |
| `POST /api/conversations/:id/messages` | `{ text, attachments?, interrupt? }`（沒有文字也沒有檔案＝繼續）→ `202` `{ ok, queued }`。團隊回覆中（或團隊設計等待確認時）訊息會放進佇列（`queued: true`），在下一回合前送達；`interrupt: true` 會停止團隊並立刻送出。`attachments`：`[{ name, mimeType, data }]`，`data` 為 base64；最多 10 個檔案、每個 20 MB |
| `DELETE /api/conversations/:id/queue/:messageId` | → `ChatMessage`：撤回一則還在等待送出的訊息（送達後回傳 404） |
| `GET /api/conversations/:id/attachments/:attachmentId` | → 附加的檔案（圖片直接顯示，其他一律下載） |
| `PUT /api/conversations/:id/messages/:messageId` | `{ text }` → `202`：編輯使用者訊息——這則與之後的訊息都會刪除，每個 agent 開新 session，團隊重新回答（`Orchestrator.resend()`） |
| `POST /api/conversations/:id/messages/:messageId/retry` | → `202`：刪除某則 agent 回覆與之後的內容，讓該 agent（以及同一輪中排在它後面的成員）重新回答 |
| `POST /api/conversations/:id/approvals/:approvalId` | `{ allow, always?, note? }`：回應 agent 的核准請求（已回應或已過期時回 404） |
| `POST /api/conversations/:id/messages/:messageId/save-plan` | `{ name? }` → `TeamPreset`：把首席 agent 的自訂團隊設計存成範本 |
| `POST /api/conversations/:id/stop` | 中止執行 |
| `GET /api/conversations/:id/files?root=&path=` | → `FileListing`：可瀏覽的資料夾（`roots`：`cwd`，平行模式下再加上每位成員的 worktree），以及 `root` 裡 `path` 的項目（資料夾在前；`.git` 與指向外面的連結不列出；最多 2,000 項）。資料夾以外的路徑一律 404 |
| `GET /api/conversations/:id/files/preview?root=&path=` | → `FilePreview`：檔案的文字（前 512 KB），或標示它是圖片、影片或二進位檔 |
| `GET /api/conversations/:id/files/raw?root=&path=` | → 資料夾裡的圖片或影片，提供方式和媒體端點相同（其他檔案一律 404） |
| `GET /api/conversations/:id/messages/:messageId/diff` | → 該回合修改的 unified diff（純文字） |
| `GET /api/conversations/:id/agents/:agentId/diff` | → 某個 agent 整份 worktree 結果的 unified diff（純文字） |
| `POST /api/conversations/:id/agents/:agentId/apply` | 把 agent 的 worktree 結果套用到工作目錄 → `{ files }`（衝突時回 409） |
| `GET /api/conversations/:id/events` | `ServerEvent` 的 SSE 串流 |
| `GET /api/presets` · `POST /api/presets` · `DELETE /api/presets/:id` | 團隊範本 |
| `GET /api/settings` · `PUT /api/settings` | `{ defaultCwd?, createCwd?, lead? }`（`lead`：`{ provider, model?, effort? }`，自動組隊的首席 agent；`defaultCwd` 不存在時回 404 並帶 `code: "cwd-missing"`，除非帶 `createCwd: true`，此時會建立該目錄） |
| `PUT /api/settings/providers/:provider` | `{ bin?, defaultModel?, defaultEffort?, apiKey? }`（`apiKey: null` 代表移除） |
| `GET /api/tools` | → `ToolLibraryView`：MCP 伺服器（變數與標頭的值已遮蔽）、skill（當下從 `SKILL.md` 讀取，無法使用時附 `problem`）、各範圍的記憶，以及機密值存放的位置 |
| `PUT /api/tools` | `{ skills?, memory? }` → `ToolLibraryView`。`skills` 會取代整個清單（`[{ path, providers? }]`；新的路徑可以是 skill 集合資料夾，且至少要有一個 skill）；`memory` 修改給定的部分（`all`、`claude`、`codex`、`grok`；每份最多 20,000 字） |
| `PUT /api/tools/mcp/:name` | `{ transport, command?, args?, url?, env?, headers?, providers?, previousName? }` → `ToolLibraryView`：新增伺服器，或帶 `previousName` 取代或改名。沒有 `value` 的變數或標頭保留原本的值。名稱已被使用時回 409 |
| `DELETE /api/tools/mcp/:name` | → `ToolLibraryView`（它的值會從金鑰儲存區刪除） |
| `GET /api/tools/skills/scan?path=` | → `{ path, skills: SkillCandidate[] }`：資料夾底下的 skill（資料夾本身，以及往下兩層內的 skill 資料夾，最多 300 個），已加入的會標示；不會儲存任何東西 |
| `GET /api/providers[?refresh=1]` | → `ProviderStatus[]` |
| `GET /api/models[?refresh=1]` | → `ProviderModels[]` |
| `POST /api/providers/:provider/native` | `{ refresh? }` → `NativeSetup`：這個 CLI 在預設工作目錄自己載入的 skill、MCP 伺服器（只有名稱、類型與狀態）和記憶檔，`errors` 列出它沒有回報的部分。會在不送 prompt 的情況下短暫啟動 CLI（用 POST，所以其他網站無法觸發）；每個 CLI、執行檔與資料夾的結果保留一分鐘（`refresh: true` 重新查詢） |
| `POST /api/providers/:provider/native/file` | `{ path }` → `FilePreview`：CLI 回報過的檔案之一（指示或記憶檔，或 skill 的 `SKILL.md`，路徑要完全相同），供介面閱讀；其他路徑一律 404 |
| `POST /api/providers/grok/folder-trust` | `{ cwd?, trust? }` → `GrokFolderTrust` `{ cwd, trusted }`：Grok 是否信任 `cwd`（預設為預設工作目錄），取自 `grok inspect`。帶 `trust: true`（只在使用者確認後送出）時，會先用和 `grok --trust` 相同的方式記錄在 `$GROK_HOME/trusted_folders.toml`；Grok 仍回報未信任時回 409 |
| `GET /api/providers/:provider/login-methods` | → `LoginMethod[]` |
| `POST /api/providers/:provider/login` | `{ method }` → `LoginSessionView` |
| `GET /api/providers/:provider/login` | → `LoginSessionView \| null`（執行中時輪詢） |
| `POST /api/providers/:provider/login/input` | `{ text }` → 寫入登入程序的 stdin |
| `DELETE /api/providers/:provider/login` | 取消登入 |
| `POST /api/providers/:provider/logout` | 登出該 CLI |
| `GET /api/voice` | → `VoiceStatus`：引擎、模型、選用的模型與語言、進行中或最近一次的安裝（`job`）、引擎程序（`job.state` 為 `running` 時輪詢） |
| `PUT /api/voice/settings` | `{ model?, language?, bin? }` → `VoiceStatus`（`bin`：`whisper-server` 的路徑，留空代表自動尋找） |
| `POST /api/voice/install` | `{ model? }` → `VoiceStatus`：在背景安裝缺少的部分（引擎、模型），完成後改用該模型（已有安裝在進行時 409；這台電腦無法自動安裝或硬碟空間不足時 400） |
| `DELETE /api/voice/install` | 取消安裝 |
| `DELETE /api/voice/models/:model` | 刪除下載的模型 |
| `DELETE /api/voice` | 刪除下載的模型與引擎（Homebrew 安裝的會保留） |
| `POST /api/voice/prepare` | 先啟動引擎，準備語音轉文字（開始錄音時送出） |
| `POST /api/voice/transcribe` | `{ audio }`（base64 的 16 kHz 單聲道 16-bit WAV，最長 120 秒）→ `{ text }`（尚未設定語音輸入時 409） |

型別定義在 `src/shared/types.ts`。

## 新增一個 agent CLI

1. **型別**：在 `src/shared/types.ts` 的 `Provider`、`PROVIDERS`、`PROVIDER_LABEL` 加上新的 id。
2. **轉接器**：建立 `src/server/agents/<name>.ts`：
   - `create<Name>Parser(emit)`（或更新處理函式）：把 CLI 的輸出轉成 `AgentEvent`（`session`、`text`、`text_end`、`thinking`、`plan`、`tool_start`，以及帶 `output` / `error` 的 `tool_end`），並記住最終結果或錯誤；
   - 一個 `AgentRunner`，其 `run()` 組出參數（prompt、system prompt、新建/接續 session、權限、模型、推理強度），呼叫 `runProcess()`，失敗時丟出 `AgentRunError`（被停止時 `aborted = true`）；
   - 核准：CLI 要求做權限沒涵蓋的事時，呼叫 `o.requestApproval({ kind, detail, reason, tool })`，再把結果回覆給 CLI（沒有 `requestApproval` 時就拒絕）。
   parser 請保持純函式，方便用錄下來的輸出測試。
3. 在 `src/server/agents/index.ts` **註冊**。
4. **設定**：在 `src/server/settings.ts` 的 `DEFAULT_BIN` 加預設執行檔名稱；若 CLI 從環境變數讀 API key，也加到 `API_KEY_ENV`。
5. **狀態與登入**：`src/server/providers.ts` 的 `checkAuth()` 與 `LOGIN_METHODS`，以及 `logout()` 中的登出指令。
6. **模型**：在 `src/server/models.ts` 加探索函式（或固定清單）。
7. **介面**：`styles.css` 的顏色變數（`--<name>`）、`src/web/util.ts` 的 `PROVIDER_COLOR` 與 `newAgent()`、兩個語系檔中的 API key 說明文字（`settings.apiKeyHelp`）。
8. **訊息**：`src/server/i18n.ts` 中登入方式的標籤（`login`），兩種語言都要加。

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
- `parseMentions()`：@ 解析；名字後面可以直接接文字，行內程式碼與各種程式碼區塊（含未結束的）中的 @ 會被忽略。
- `buildPlannerPrompt()` / `PLANNER_BRIEFING`（`planner.ts`）：自動組隊模式中要問首席 agent 什麼，以及它必須回傳的 JSON。
- `buildGroupPrompt()` / `GROUPER_BRIEFING`（`grouping.ts`）：怎麼請首席 agent 把新對話分到使用者的群組。

prompt 刻意使用英文（agent 會用使用者的語言回覆）。給使用者看的文字則有翻譯，見[翻譯](#翻譯)。

## 翻譯

介面與伺服器中給使用者看的文字，提供繁體中文（`zh-TW`）與英文（`en`）兩種版本。

- **介面文字**：先在 `src/web/locales/zh-TW.ts` 加上 key：它的結構就是 `Messages` 型別。`en.ts` 的型別是 `Messages`，所以英文漏掉或型別不對時 TypeScript 會報錯；帶有值的文字寫成函式（`(n: number) => …`）。在元件中使用 `const t = useT()`（需要目前語言與 `setLang` 時用 `useI18n()`）。React 以外的程式碼則把訊息當成參數傳入（`relativeTime(ts, t)`、`conversationMarkdown(conv, t)`）。
- **伺服器文字**：`src/server/i18n.ts` 包含兩種語言的字典；在產生文字的地方呼叫 `t()`。語言來自請求（`X-Relay-Lang`），透過 AsyncLocalStorage 傳遞，並跟著該請求啟動的執行走，所以不要把翻譯好的文字快取在長期存在的物件中。
- **內建範本**：`src/server/presets.ts` 保存兩種語言的名稱、說明與角色。
- **新增其他語言**：加到 `src/shared/types.ts` 的 `Lang` / `LANGS`，新增語系檔與伺服器字典、範本文字，並在 `browserLang()` 加上它的偵測規則。

`test/i18n.test.ts` 會檢查兩份介面字典的結構相同（包括型別檢查不到的清單長度）。

使用導覽的步驟是語系檔中的 `tour.steps`；每一步指向的元素（它的 `data-tour` 屬性）是 `src/web/components/Onboarding.tsx` 的 `TOUR_TARGETS`，依步驟順序排列。新增、刪除或調整步驟順序時，兩份語系檔和 `TOUR_TARGETS` 要一起改。步驟內容有值得再看一次的調整時，把同一個檔案的 `TOUR_VERSION` 加一：瀏覽器會記住看完的是哪個版本（`localStorage` 的 `relay:onboarded`），看過舊版的人下次開啟會再看到一次導覽。`test/tour.test.ts` 會檢查目標數量，並在步驟改變時失敗提醒你：更新版本號和它印出的 fingerprint（只修錯字時只更新 fingerprint）。

## 測試

```bash
npm test               # 全部測試
npx vitest test/store.test.ts
```

目前的測試：

- `test/store.test.ts`：SQLite store 與設定（存取往返、串流更新、當機復原、連帶刪除、檔案權限）、側邊欄群組（順序、重新命名、刪除群組時對話移到「其他」、自動分類只有一次，而且不會蓋過使用者的移動、不會分到已刪除的群組）、搜尋（每個詞都要符合、不分大小寫、標題符合的在前、中文、`%` 與 `_`、不含系統訊息、摘錄、仍在串流的回覆），以及搭配假的金鑰儲存區測試 API key：絕不寫進資料庫、舊的資料庫金鑰會被移出並從檔案中清除、儲存區拒絕寫入的情況。
- `test/workspace.test.ts`：用真實的暫存 repository 測試 git 操作（自動 init、不影響 repo 的快照、worktree、套用、衝突、CRLF 與非 UTF-8 內容逐位元組套用、很長或特殊的檔案清單、保留的快照 ref、範圍太大的 repository）。
- `test/process.test.ts`：程序輔助函式：輸出逐位元組保存、停止不理會 SIGTERM 的子程序（包括 CLI 已結束後，以及關閉時）、工作目錄不存在、相對路徑的執行檔。
- `test/hub.test.ts`：瀏覽器重新連線時的 SSE 分送。
- `test/web.test.ts`：提供建置好的介面：帶雜湊的檔案永久快取、index.html（含前端路由）每次都檢查、缺少的檔案回 404、不影響先前註冊的路由。
- `test/app.test.ts`：透過 `createApp()` 與 `app.request()` 測試 HTTP API：Host／Origin／Content-Type 檢查、回覆中刪除對話、團隊回覆中拒絕修改、設定驗證、只在要求時建立不存在的工作目錄（預設、新對話或編輯中的對話）、範本 id、側邊欄群組（名稱不能重複、在兩種語言中都不能叫「其他」、重新命名、刪除、移動對話、不存在的群組）與搜尋。也測試工具庫的路由（遮蔽的值、不合法的名稱、網址、CLI 與變數名稱、重複名稱、skill 與記憶、列出資料夾底下的 skill）、成員的工具例外設定、成員執行時拿到的項目，以及瀏覽檔案（列表、預覽、raw 只給圖片、資料夾外或 `.git` 的路徑、未知的資料夾）。也用假的服務測試查詢 CLI 自己載入的內容（只用預設工作目錄、重新查詢、依請求語言的問題說明、未知的 CLI、不接受 GET 或表單 POST），只能讀回報過的檔案，以及 Grok 的資料夾信任（狀態、確認後信任、不存在的資料夾、不接受表單 POST）。
- `test/prompt.test.ts`：`@` 解析（名字後直接接文字、程式碼區塊）、`[PASS]`、失敗／停止／PASS 回覆的轉交、平行模式的簡報。也測試簡報中的記憶與 skill 區塊。
- `test/commands.test.ts`：解析 shell 指令：各種寫法的推送與發佈指令，以及不會讓夾帶指令通過的「本對話都允許」規則 key。
- `test/chat.test.ts`：ChatView 的邏輯：Enter 何時送出（手機和平板上不會）、何時重新連線事件串流、哪個 worktree 結果可以套用、團隊設定的草稿、建立不存在的工作目錄前先詢問。
- `test/markdown.test.ts`：@ 標示與伺服器規則一致，並略過程式碼與連結；圖片以連結顯示；使用者自己的訊息保留換行；表格儲存格維持一行或以好讀的寬度換行，讓太寬的表格左右捲動。
- `test/orchestrator.test.ts`：把假的 runner 換進 `runners` 跑完整流程：平行模式的 worktree 隔離與套用、圓桌模式的修改紀錄、目錄鎖（含自動組隊）、執行準備期間或套用期間收到的請求、agent 向使用者提問（團隊停下；使用者回覆後由提問者先回答，涵蓋圓桌、平行與接力；「繼續」會略過它；回覆給別人或編輯訊息時重新開始；期間寫的訊息等回答時一起送出）、團隊回覆時送出的訊息（在下一個該收到它的 agent 發言前依序送達、沒有回合接到時再開一輪、停止後保留、被 interrupt／下一則訊息／繼續先送出、撤回、重新啟動後仍在）、執行中刪除對話、全新 session 也失敗時保留原 session，以及把失敗回合改過的檔案告訴隊友。
- `test/grok.test.ts`：Grok 的 ACP 轉接器：各權限的核准規則、session 更新轉成 `AgentEvent`、JSON-RPC 連線。也測試工具庫的 MCP 伺服器轉成 ACP 的格式。HTTP MCP 伺服器只傳給宣告支援的 Grok。
- `test/claude.test.ts`：Claude 預先允許與移除的工具、它的參數（`--system-prompt-snapshot off`、舊版不接受的旗標），以及工具被拒絕時顯示的原因。也測試工具庫：`--mcp-config` 檔案與 skill 資料夾的 `Read` 規則（完整存取時不加）、Windows 路徑的 `Read` 規則，以及 `--mcp-config` 的內容。
- `test/copy.test.ts`：複製單則訊息或整段對話時產生的 Markdown（兩種語言）；單則訊息照原文複製（網址、格式、CRLF 換行），沒有剪貼簿 API 時也一樣。
- `test/approvals.test.ts`：「本對話都允許」的規則 key 與比對（串接指令、shell 包裝）。
- `test/codex.test.ts`：Codex app-server 轉接器：thread 項目轉成 `AgentEvent`（文字、推理、計畫、指令輸出、用量），以及核准請求 / 回應。也測試工具庫的 MCP 伺服器各自成為一個 `mcp_servers.<name>` 覆寫。
- `test/sidebar.test.ts`：側邊欄的對話狀態、各群組的對話（「其他」在最後、群組不存在的對話放在「其他」）、還沒確認的移動，以及收合群組顯示的狀態。
- `test/search.test.ts`：搜尋的詞、不分大小寫的比對（長的優先、重疊合併）、第一個符合處附近的摘錄、標示關鍵字。
- `test/grouping.test.ts`：請首席 agent 分類對話的 prompt，以及解讀它的回覆（編號或名稱；0 或 null 代表都不適合；其他都拒絕）。
- `test/planner.test.ts`：首席 agent 的回覆：擷取 JSON、範本與自訂團隊、驗證、改用已登入的 CLI、備援方案，以及 prompt。
- `test/tour.test.ts`：使用導覽：每一步都有對應的目標、新版本會再顯示一次，以及步驟的 fingerprint（步驟改了卻沒有換新版本時會失敗）。
- `test/i18n.test.ts`：語言偵測（伺服器 header 與瀏覽器）、語言在非同步工作中的傳遞、雙語範本，以及兩份介面字典結構相同。
- `test/voice.test.ts`：用假的下載、程序與引擎測試語音輸入：固定版本的下載清單、背景安裝（引擎、模型、檢查），涵蓋 Linux 與 macOS 的 Homebrew、SHA-256 不符、取消、硬碟空間、自訂引擎路徑、引擎無法啟動、引擎只聽 127.0.0.1 並藏在隨機路徑後、語音轉文字與辨識語言、切換與刪除模型、設定，以及 HTTP 路由。
- `test/voice-web.test.ts`：瀏覽器端的語音輸入：WAV 編碼、靜音判斷、把辨識結果插入游標處，以及麥克風與設定頁顯示的狀態。
- `test/tools.test.ts`：工具庫：front matter、找出 skill（往下兩層、本身就是 skill 的資料夾、列出名稱並標示是否已加入）、用假的金鑰儲存區測試 MCP 機密值（遮蔽、沒送出時保留、改名時帶過去、從資料庫移出、儲存區失敗），依 CLI 的預設與成員的例外設定、被標示的 skill，以及還沒有 CLI 範圍時存下的舊資料。另外：伺服器或 skill 改名後成員的例外設定仍有效；沒能搬走的值留在資料庫；讀不到的值不會被覆蓋，金鑰儲存區打開後會再讀一次。
- `test/files.test.ts`：用真的暫存資料夾測試瀏覽檔案：資料夾外、經由符號連結或進入 `.git` 的路徑、列表順序與項目上限、文字 / 圖片 / 二進位檔的預覽與長檔案截斷、raw 只給媒體檔，以及對話提供的資料夾。經由連結進入的資料夾保留當初要求的路徑，截斷的列表保留顯示順序的前面幾項。
- `test/files-web.test.ts`：檔案瀏覽的路徑導覽列、篩選、程式語言與行數。
- `test/tools-web.test.ts`：團隊編輯器的工具選擇：項目、各 CLI 的記憶、依 CLI 的預設，以及只記錄例外。
- `test/native.test.ts`：各 CLI 自己載入的內容：讀取 Claude Code、Codex、Grok 的回答（實測格式；MCP 設定與其中的 token 會被丟掉）、Claude Code 與 Codex 會讀的指示和記憶檔（真的暫存資料夾），無法啟動的 CLI、依執行檔分開的快取、依請求語言的問題說明，以及哪些檔案可以讀（只有回報過的）。
- `test/route.test.ts`：前端的 hash 路由，包括設定頁的區塊，以及正在看哪張設定卡片（在連結列標亮）。
- `test/grok-trust.test.ts`：記錄 Grok 對資料夾的信任：和 `grok --trust` 相同的紀錄、取代標為不信任的紀錄並保留其他內容、Windows 路徑的 TOML 跳脫、寫在暫存 `GROK_HOME` 的檔案（只有擁有者能讀），以及從 `grok inspect` 讀出信任狀態。
- `test/quickstart.test.ts`：使用者複製的指令在任何 shell 都能執行：npm scripts 不用 Unix 的方式設定環境變數（npm 在 Windows 上用 cmd.exe 執行），首頁、README 與使用指南不用 `&&` 串接指令（Windows PowerShell 5.1 不接受），README 的快速開始從 clone 開始，首頁、README 與使用指南安裝的都是建置好的 app（先 `npm run build` 再 `npm start`，網址 http://127.0.0.1:8787），首頁只在開發時提到 `npm run dev`。

`test/orchestrator.test.ts` 也涵蓋用假 agent 測試核准（詢問並等待、「本對話都允許」、拒絕時的說明、停止時過期、自動拒絕）、重試回覆、編輯使用者訊息（`resend`：之後的訊息會被刪除，每個 agent 都開新的 session），以及用假的首席 agent 測試自動組隊（自訂設計要等確認後團隊才回答、手動設定團隊也算確認、存成範本、使用範本、備援方案、編輯需求描述後重新設計，以及規劃時不上鎖）、用假的首席 agent 測試把新對話分到群組（只看第一則訊息、與團隊同時進行、沒有群組時不詢問、不蓋過使用者的移動、刪除對話時停止），還有附加檔案（以安全檔名儲存、把圖片與路徑交給每個 agent、編輯訊息時保留、隨被刪除的訊息一起刪除、只傳檔案的訊息、錯誤的上傳）。

接下來適合補上的：

- **轉接器 parser**：把真實 CLI 輸出錄成 fixture 檔，驗證送出的 `AgentEvent`。錄製方式：

  ```bash
  echo "hello" | claude -p --output-format stream-json --verbose --include-partial-messages > claude.jsonl
  # Codex 與 Grok 使用 JSON-RPC；可以在 JsonRpcConnection.handleLine 加 console.log
  # 記下轉接器收到的內容，或從 Grok 為每個 session 保存的更新紀錄複製：
  # ~/.grok/sessions/<URL 編碼的 cwd>/<session-id>/updates.jsonl
  ```

- **prompt 輔助函式**：`buildTurnPrompt`。
- **更多協調器排程**：接力交棒、`[PASS]` 提前結束，做法同 `test/orchestrator.test.ts` 的假 runner。

在測試中跑真正的 agent 會花錢且需要登入，所以自動化測試請保持離線。測試也不會碰到真正的金鑰儲存區：`SettingsStore` 由建構子參數取得它，只有 `src/server/index.ts` 會傳入 `openSystemKeyring()`。

## 持續整合（CI）

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) 會在每個 pull request 與每次推送到 `main` 時執行：`npm ci`、`npm run typecheck`、`npm test` 與 `npm run build`，在 Ubuntu 上以 Node 22（支援的最低版本）與 Node 24 各跑一次。對同一個 pull request 再次推送時會取消前一次的執行。推送前請先在本機跑過同樣的指令。

若要在檢查通過前禁止合併，請在 repository 設定中替 `main` 加上 branch protection rule（或 ruleset），並把 `Typecheck, test, build` 檢查設為必要。

### 網站

https://agentic-system-lab.github.io/harness-relay/zh-TW/ 的網站首頁是 [`site/`](../site/) 裡的純 HTML、CSS 與 JavaScript：`index.html`（English）、`zh-TW/index.html`（繁體中文）與共用的 `assets/`，不需要建置。[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) 會在推送到 `main` 且改到 `site/`、`docs/media/` 或這個 workflow 時執行：把 `site/` 與 `docs/media/` 的示範影片複製到同一個資料夾、排除 Markdown 檔，再部署到 GitHub Pages（repository 設定 → Pages → Source：GitHub Actions）。用 `npm run site:preview`（[`scripts/preview-site.ts`](../scripts/preview-site.ts)）在本機預覽：它會在 http://127.0.0.1:4180 提供 `site/`（可用 `SITE_PORT` 換埠號），影片直接從 `docs/media/` 讀取，和 Pages 上的樣子相同。修改頁面前請先讀 [`site/DESIGN-GUIDELINES.md`](../site/DESIGN-GUIDELINES.md)，裡面也說明重錄示範影片後要更新哪些地方。

## 除錯技巧

- **伺服器 log**：`npm run dev` 輸出中的 `[server]` 行；轉接器失敗時，訊息的錯誤內容會附上 CLI stderr 的最後一段。
- **SSE**：`curl -N http://localhost:8787/api/conversations/<id>/events` 可以看到原始事件串流。
- **語言**：在 `curl` 指令加上 `-H 'X-Relay-Lang: en'`，就能看到英文的錯誤與範本。
- **自動組隊**：首席 agent 的執行就是對話工作目錄中一個普通的 CLI session；它的回覆與費用記在 plan 訊息上（`messages.plan`、`cost_usd`）。
- **重現 CLI 呼叫**：`src/server/agents/*.ts` 中的參數可以手動執行；加上 `--debug`（Claude、Grok）可看到更多資訊。
- **worktree**：`git -C <工作目錄> worktree list` 與 `git branch --list 'relay/*'` 可以看到平行對話建立了哪些 worktree；實際檔案在 `data/worktrees/<對話>/`。
- **語音輸入**：`GET /api/voice` 會列出安裝了什麼，以及最近一次安裝的紀錄；引擎以 `whisper-server` 程序執行（可用 `ps` 查看），閒置 10 分鐘後停止。下載的檔案放在 `data/voice/`（`models/`，以及 Linux 與 Windows 上的 `engine/`）。
- **session 卡住**：先停止伺服器，再刪除 `agent_sessions` 中該 agent 的那一列，就會強制開新 session 並提供完整紀錄（使用中的對話快取在記憶體裡，所以只在伺服器停止時修改資料庫）。

## 慣例

- 使用 strict TypeScript；共用型別只放在 `src/shared/types.ts`。
- 絕不把機密傳給前端（`SettingsView` 只回傳遮罩過的金鑰）。
- 新增的寫入端點會自動經過 `/api/*` 中介層的 JSON content-type 與 Host/Origin 檢查，請維持這個做法。
- 啟動程序一律透過 `process.ts`，這樣才會被追蹤並在關閉時結束。
