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
  shared/mentions.ts       伺服器與介面共用的 @ 規則（只看 Markdown 中的一般文字），以及沒有成員叫這個名字的 @
  shared/links.ts          沒包起來的網址在哪裡結束，後面直接接中文時也是（伺服器與介面共用）
  shared/search.ts         搜尋的詞、不分大小寫的比對、摘錄、標示關鍵字（伺服器與介面共用）
  shared/schedule.ts       排程下一次何時送出：時區中的牆上時間、時鐘調整（伺服器與介面共用）
  server/
    index.ts               組裝元件、靜態檔案、啟動與關閉
    web.ts                 提供建置好的介面：帶雜湊的檔案永久快取，index.html 每次都檢查
    app.ts                 createApp()：路由、安全性中介層、SSE（可用 app.request() 測試）
    orchestrator.ts        團隊回合：決定誰發言、交付 prompt、把串流寫進訊息；自動組隊、重新傳送
    planner.ts             自動組隊：首席 agent 的 prompt（問題、歷史、目前的團隊）、解析回覆、可執行的團隊、備援方案；
                           依使用者的要求修改團隊（修改用的 prompt、`decideRevision`）
    grouping.ts            側邊欄群組：首席 agent 依第一則訊息把新對話分到群組
    scheduler.ts           排程：在到期時送出各對話的排程訊息、錯過的時間、對話中的說明
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
    share.ts               分享對話：透過使用者的 gh 把頁面放成 secret gist（建立、刪除），以及 gistpreview 連結
    providers.ts           CLI 狀態、登入流程、登出、模型快取
    models.ts              各 CLI 的模型 / 推理強度探索
    db.ts                  開啟 SQLite、遷移、transaction()
    store.ts               對話、訊息、agent session、範本、側邊欄群組、搜尋、排程
    settings.ts            provider 設定、預設工作目錄、各 CLI 自己的家目錄、子程序環境變數
    agentsview.ts          AgentsView：每個對話送成一個 thread，成員的 session 連在底下
    secrets.ts             存放 API key 的作業系統金鑰儲存區（keyring）、可用性檢查
    tools.ts               工具庫：MCP 伺服器（機密值放在 keyring）、skill（SKILL.md 的 front matter）、記憶；每位成員拿到哪些
    files.ts               瀏覽對話的檔案：可瀏覽的資料夾、列表、預覽、路徑檢查、資料夾 zip 的內容
    zip.ts                 邊送邊寫的 ZIP 檔（deflate、data descriptor、UTF-8 檔名）
    native.ts              各 CLI 自己載入的內容（它的 skill、MCP 伺服器與它們的工具、內建工具、hook、subagent、plugin、指示與記憶檔），不送 prompt 查詢，以及 Harness Relay 執行時不載入哪些
    grokTrust.ts           在使用者確認後記錄 Grok 對資料夾的信任（和 grok --trust 相同）
    attachments.ts         訊息的附加檔案：儲存、安全檔名、交給 agent 的圖片
    presets.ts             內建團隊範本（兩種語言）
    validate.ts            agent、設定與排程的輸入驗證
    voice.ts               語音輸入：安裝 whisper.cpp 引擎與模型（固定版本、檢查 SHA-256）、引擎程序、語音轉文字
    workspace.ts           git：自動 init、快照、worktree、diff、套用
    errors.ts              HttpError（帶狀態碼、給使用者看的錯誤）
    hub.ts                 SSE 廣播
  web/
    main.tsx App.tsx api.ts util.ts copy.ts styles.css index.html
    public/                原封不動複製到建置結果：manifest.webmanifest 與主畫面圖示（npm run icons）
    chat.ts                ChatView 的純邏輯：串流是否重新連線、能否套用、團隊設定草稿與它編輯的團隊
    sidebar.ts             側邊欄的純邏輯：各群組的對話、還沒確認的移動、收合群組的狀態
    schedule.ts            排程視窗的純邏輯：表單、表單的問題、接下來的時間、用幾個字描述排程
    templates.ts           範本編輯器的純邏輯：範本有沒有被修改
    files.ts               檔案瀏覽的純邏輯：路徑導覽列、篩選、程式語言、行數、資料夾 zip 的選擇
    cwds.ts                工作目錄輸入框的純邏輯：使用中的工作目錄有哪些符合輸入的內容（`~` 代表家目錄，`/` 與 `\` 視為相同），以及清單如何回應按鍵與箭頭按鈕
    download.ts            在使用者點下前，先確認回覆連結的檔案能不能下載（連結出現一會兒後的 HEAD 請求），以及檔案不存在時點擊會做什麼
    share.ts               分享頁不需要 DOM 的部分：拿掉哪些內容、圖片的大小預算、頁面與它的 CSP、Harness Relay 的頁尾
    sharePage.tsx          從畫面上的聊天室做出分享頁（複製、拿掉不要的、樣式、圖片轉成 data URL 並控制在 1 MB 內）
    tools.ts               團隊編輯器的工具選擇：工具庫項目、依 CLI 的預設、成員的例外設定
    native.ts              NativeSetupPanel 的純邏輯：各 CLI 的分頁與數量、勾選個別項目、執行時不載入幾項、設定是否已變更
    route.ts               前端放在網址 hash 的路由，包括 #/schedule 與 #/settings/<區塊>
    voice.ts               語音輸入的純邏輯：WAV 編碼、靜音判斷、把辨識結果插入游標處、安裝進度
    recorder.ts            在瀏覽器錄音，解碼成 16 kHz 單聲道
    useVoice.ts            語音輸入狀態的 hook（安裝時輪詢）
    i18n.tsx               語言偵測、provider、useT()
    locales/               zh-TW.ts（訊息結構的來源）、en.ts
    components/            Sidebar、SidebarGroups（群組、拖放）、SidebarSearch、
                           NewChat、TemplateEditor（範本對話框）、TeamEditor、TeamReviser（團隊設定的
                           「請首席 agent 調整」）、ModelPicker、ChatView、
                           MessageItem（含 plan 卡片）、ChangesCard、Composer、Markdown、
                           SettingsPage、CopyButton、Logo、Onboarding（使用導覽）、
                           MemberDots、icons、VoiceInput（麥克風、安裝說明對話框、安裝進度）、
                           VoiceSettings（設定 → 語音輸入）、ToolsSettings（設定 → 工具庫）、
                           SessionsSettings（設定 → Agent 的 session）、
                           SharesSettings（設定 → 分享的對話）、ShareDialog（複製或分享對話）、
                           GhHelp（GitHub CLI 沒安裝或沒登入時該怎麼做）、
                           FileBrowser（「檔案」對話框）、NativeSetupPanel（CLI 自己載入的內容）、
                           GrokTrust（Grok 對資料夾的信任）、SectionTitle、
                           CwdInput（工作目錄輸入框，以及使用中工作目錄的清單）、
                           ScheduleDrawer（對話的排程）、ScheduleForm（共用的排程表單）、
                           NewSchedule（「新排程」頁面）、
                           useDialog（對話框的焦點處理）
test/                      Vitest 測試
.github/workflows/ci.yml   CI：pull request 與推送到 main 時執行型別檢查、測試與建置
.github/workflows/pages.yml  把 site/ 發佈到 GitHub Pages
scripts/preview-site.ts    npm run site:preview：在本機以 Pages 的方式提供 site/
scripts/app-icons.ts       npm run icons：畫出主畫面圖示，並寫出 web app manifest
scripts/demo/              npm run demo：重錄示範影片，並更新影片、截圖與章節列
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

web app manifest，以及手機放到主畫面（或瀏覽器為安裝的 App 顯示）的圖示，都在 `src/web/public/`。它們由 `npm run icons`（`scripts/app-icons.ts`）畫出，用的是跟 favicon 和 `Logo.tsx` 相同的三個圓，不需要影像處理函式庫；改了標誌、圖示尺寸或 manifest 之後，請重新執行並 commit 它寫出的檔案。

`npm run dev` 會在每次檔案變更時重啟伺服器。重啟會中止正在執行的 agent 回合（訊息會標為已中斷），所以長回合執行中請避免修改伺服器檔案。

### 環境變數

| 變數 | 預設值 | 用途 |
| --- | --- | --- |
| `PORT` | `8787` | API port（Vite 代理也會使用） |
| `HOST` | `127.0.0.1` | 綁定位址 |
| `RELAY_DATA_DIR` | `./data` | `relay.db` 的位置 |
| `RELAY_DEFAULT_CWD` | 程序的 cwd | 初始預設工作目錄（在設定頁修改前） |
| `RELAY_ALLOWED_HOSTS` | — | Host/Origin 檢查額外允許的主機名稱，以逗號分隔，例如這台電腦在 Tailscale 上的名稱（見[用手機連線](remote-access.zh-TW.md)） |
| `RELAY_KEYRING` | — | 設為 `off` 時 API key 存在資料庫而不是作業系統的金鑰儲存區（例如用完即丟的資料目錄） |

伺服器會把自己的環境變數傳給各 CLI，但移除 Claude Code 的巢狀執行變數，並加上已保存的 API key（`SettingsStore.env()`）。

## 請求流程

1. 前端送出 `POST /api/conversations/:id/messages` → `Orchestrator.send()` 準備工作區（可編輯 / 完全存取時：必要時 `git init`，非平行模式再取得目錄鎖），加入使用者訊息，並在背景啟動 `execute()`（請求立即回傳 `202`）。
2. 在自動組隊的對話中，為新問題開始的執行只會讓首席 agent 設計團隊（`designTeam()`，見[架構 → 自動組隊](architecture.zh-TW.md#自動組隊)）；設計確認後，團隊在另一次執行中回答。其他情況下，`execute()` 依模式決定發言者（平行模式會先建立每個 agent 的 worktree），對每位呼叫 `turn()`。
3. `turn()` 建立串流中的 agent 訊息，記下起始狀態（worktree 的 `HEAD` 或一份快照），計算該 agent 還沒看過的訊息，組出 prompt（`prompt.ts`），並在正確的目錄呼叫 `runners[provider].run()`；除非對話設定為自動拒絕，否則會一併傳入 `requestApproval`。
4. 轉接器啟動 CLI（`process.ts`），逐行解析 stdout 並送出 `AgentEvent`。
5. `turn()` 把事件套用到訊息上（文字、思考、計畫、工具列與輸出），透過 `Hub` 送出 SSE 事件，並透過 `Store` 保存。核准請求會新增一個 approval part，並等待 `POST …/approvals/:approvalId`。CLI 結束後，把修改的檔案（worktree 中的 commit，或第二份快照）記錄在訊息上。

## HTTP API

所有寫入請求都必須帶 `Content-Type: application/json`（CSRF 防護）。錯誤格式為 `{ "error": string }`，狀態碼 400/404/409/415/500。帶上 `X-Relay-Lang: zh-TW | en`，錯誤、系統訊息與內建範本就會使用該語言（網頁介面一律會帶）。

| 方法與路徑 | Body → 回應 |
| --- | --- |
| `GET /api/conversations` | → `ConversationSummary[]`（附側邊欄用的 `running`、`waiting`、`lastStatus`、`groupId` 與 `sorting`） |
| `GET /api/search?q=` | → `SearchResult[]`：標題或使用者／agent 訊息包含 `q` 每個詞（不分大小寫）的對話，標題符合的在前，其餘依最近時間；最多 50 筆 |
| `GET /api/cwds` | → `WorkingDirectories`：`{ home, dirs: [{ path, default? }] }`，工作目錄輸入框列出的工作目錄：預設工作目錄（`default: true`，`~` 依新對話的方式展開）在前，接著是各對話的工作目錄，最近用過的在前；每個資料夾只列一次（在 macOS 與 Windows 上不分大小寫），而且只列出仍然存在的資料夾。`home` 讓輸入的 `~` 也能比對 |
| `PUT /api/conversations/:id/group` | `{ groupId }` → `{ ok }`：把對話放進側邊欄群組（`null` 代表「其他」）；群組不存在時回 404。使用者移動過的對話不會再自動分類 |
| `GET /api/groups` | → `ConversationGroup[]`，依建立順序（預設群組「其他」不在清單中） |
| `POST /api/groups` | `{ name }` → `ConversationGroup`（名稱空白、太長或重複——包括「其他」／Other——或超過 50 個群組時回 400） |
| `PATCH /api/groups/:id` | `{ name }` → `ConversationGroup` |
| `DELETE /api/groups/:id` | 刪除群組；裡面的對話會移到「其他」 |
| `POST /api/conversations` | `{ title?, agents, settings, createCwd? }` → `Conversation`；`settings.autoTeam: true` 時會忽略 `agents`（為空），由首席 agent 為每個新問題設計團隊，`settings.autoConfirm: true` 則直接採用它的團隊、不必確認；`settings.cwd` 不存在時回 404 並帶 `code: "cwd-missing"`，除非帶 `createCwd: true`，此時會建立該目錄 |
| `GET /api/conversations/:id` | → `Conversation` |
| `PATCH /api/conversations/:id` | `{ title?, agents?, settings?, createCwd? }` → `Conversation`（執行中回 409；`agents` 與 `settings` 都不會開啟或關閉自動組隊，`settings.autoConfirm` 可以修改；設定 `agents` 會確認等待中的團隊設計，接著由這個團隊回答；`settings.cwd` 不存在時同 `POST`） |
| `DELETE /api/conversations/:id` | 停止執行並刪除 |
| `PUT /api/conversations/:id/schedule` | `{ text, repeat, timeZone?, enabled?, approvals?, missed?, newChat? }` → `ConversationSchedule`：設定對話的排程（每個對話一個；取代原本的排程，並保留上次的結果）。`repeat` 是 `{ kind: 'once', at }`、`{ kind: 'daily', time }`、`{ kind: 'weekly', time, days }`（0 = 星期日）或 `{ kind: 'interval', hours }`（1–168，從最後一次設定時間算起；只改訊息或其他選項時節奏不變）；`time` 是 `timeZone`（預設為伺服器的時區）中的 `HH:MM`。預設：啟用、`approvals: 'deny'`、`missed: 'skip'`、`newChat: false`（`true`：每次在新對話中送出，沿用同樣的團隊、設定與群組）。訊息是空的或太長、時間格式錯誤、沒選星期、一次性排程的時間已過（啟用時）或不認得的時區為 400；啟用時團隊還要設計或確認為 409 |
| `POST /api/schedules` | `{ title?, settings, createCwd?, schedule }` → `Conversation`：新排程（**新排程**），放在一個自己的、自動組隊的對話裡（`settings` 同 `POST /api/conversations`；`schedule` 同 `PUT …/schedule`，預設啟用；標題預設為訊息的第一行）。首席 agent 立刻為排程的訊息開始組隊（`designForSchedule`）；不會貼出任何訊息，團隊確認後也不會執行，要等排程送出訊息。會先檢查排程再建立工作目錄；永遠不會送出的排程為 400，工作目錄不存在且沒有 `createCwd` 為 404（`code: CWD_MISSING`） |
| `DELETE /api/conversations/:id/schedule` | → `{ ok }`：刪除排程 |
| `POST /api/conversations/:id/schedule/design` | → `202` `{ ok }`：請首席 agent 為排程的訊息組隊（再一次，例如組隊被停止之後），和 `POST /api/schedules` 一樣。沒有排程為 404；對話沒有自動組隊為 400；已經有團隊、執行中或有團隊設計在等確認時為 409 |
| `POST /api/conversations/:id/schedule/run` | → `202` `{ ok, queued, chatId? }`：現在就送出排程的訊息，和到期時一樣（團隊回覆中會放進佇列；`chatId`：設了 `newChat` 的排程開的新對話）；排程的時間不變。沒有排程為 404；先不送（團隊在等回答、還沒確認團隊，或先前的排程訊息還在等待）、對話正忙（設定變更、套用、另一個對話正在修改同一個資料夾）或無法開始時為 409，並附上原因 |
| `POST /api/conversations/:id/messages` | `{ text, attachments?, interrupt? }`（沒有文字也沒有檔案＝繼續）→ `202` `{ ok, queued }`。團隊回覆中（或團隊設計等待確認時）訊息會放進佇列（`queued: true`），在下一回合前送達；`interrupt: true` 會停止團隊並立刻送出。`attachments`：`[{ name, mimeType, data }]`，`data` 為 base64；最多 10 個檔案、每個 20 MB |
| `DELETE /api/conversations/:id/queue/:messageId` | → `ChatMessage`：撤回一則還在等待送出的訊息（送達後回傳 404） |
| `GET /api/conversations/:id/attachments/:attachmentId` | → 附加的檔案（圖片直接顯示，其他一律下載） |
| `GET /api/conversations/:id/messages/:messageId/media?path=` | → 回覆中嵌入的圖片或影片，來自工作目錄、該 agent 的 worktree 或附件（`nosniff`、沙箱化、位元組範圍、ETag；其他一律 404） |
| `GET /api/conversations/:id/messages/:messageId/download?path=` | → 回覆中連結的檔案，來自同樣的資料夾（絕不包含 `.git`），一律以下載提供（`application/octet-stream`、`attachment`、`nosniff`、沙箱化、支援 `If-Range` 的位元組範圍、ETag；HEAD 不送內容） |
| `PUT /api/conversations/:id/messages/:messageId` | `{ text }` → `202`：編輯使用者訊息——這則與之後的訊息都會刪除，每個 agent 開新 session，團隊重新回答（`Orchestrator.resend()`） |
| `POST /api/conversations/:id/messages/:messageId/retry` | → `202`：刪除某則 agent 回覆與之後的內容，讓該 agent（以及同一輪中排在它後面的成員）重新回答 |
| `POST /api/conversations/:id/approvals/:approvalId` | `{ allow, always?, note? }`：回應 agent 的核准請求（已回應或已過期時回 404） |
| `POST /api/conversations/:id/messages/:messageId/confirm-plan` | 確認首席 agent 等待中的團隊設計：它的團隊成為對話的團隊，接著回答它所針對的問題，連同等待中的訊息（有其他操作佔用對話時 409） |
| `POST /api/conversations/:id/messages/:messageId/decline-plan` | 不採用：保留目前的團隊，由它回答（第一個問題沒有團隊可以保留，400；409 同上） |
| `POST /api/conversations/:id/messages/:messageId/save-plan` | `{ name? }` → `TeamPreset`：把首席 agent 的自訂團隊設計存成範本 |
| `POST /api/conversations/:id/revise-team` | `{ request, agents, settings }`（`settings`：`mode`、`rounds`、`maxHops`，以及團隊設定裡的 `permission` 與 `cwd`，讓首席 agent 讀到）→ `TeamRevision`（`agents`、`settings`、`reason`、`meta`）：首席 agent 依要求修改送來的團隊（團隊設定裡的），唯讀；不會儲存任何東西（對話不存在時 404；要求是空的或太長、團隊無效時 400；首席 agent 的 CLI 失敗、回覆無法使用或伺服器正在關閉時 503；被停止時 409：請求關閉、有更新的要求，或對話被刪除） |
| `POST /api/conversations/:id/stop` | 中止執行 |
| `POST /api/conversations/:id/share` | `{ html, upTo? }` → `SharedPage`：用使用者的 `gh`（`gh gist create`）把介面做好的頁面（`sharePage.tsx`）放成 secret gist，在 `url`（gistpreview.github.io）閱讀，並留下紀錄；`upTo`：頁面結束的那則 agent 回覆。空的頁面回 400，超過 `SHARE_MAX_BYTES`（1 MB）回 413，沒有 `gh`、沒有登入或失敗時回 502 並說明原因（不留紀錄），前兩種另附 `code: gh-missing` 或 `gh-signed-out`（介面據此列出處理步驟） |
| `GET /api/shares` | → `SharedPage[]`，最新的在前；對話刪除後帶 `conversationGone` |
| `DELETE /api/shares/:id` | → `{ ok }`：刪除 gist（`gh gist delete --yes`；用 `gh api gists/:id` 也找不到的視為已刪除，屬於另一個帳號的則拒絕），再刪除紀錄。不存在的分享回 404，`gh` 失敗時回 502 並說明原因（與同樣的 code；保留紀錄） |
| `GET /api/conversations/:id/files?root=&path=` | → `FileListing`：可瀏覽的資料夾（`roots`：`cwd`，平行模式下再加上每位成員的 worktree），以及 `root` 裡 `path` 的項目（資料夾在前；`.git` 與指向外面的連結不列出；最多 2,000 項）。資料夾以外的路徑一律 404 |
| `GET /api/conversations/:id/files/preview?root=&path=` | → `FilePreview`：檔案的文字（前 512 KB），或標示它是圖片、影片或二進位檔 |
| `GET /api/conversations/:id/files/raw?root=&path=` | → 資料夾裡的圖片或影片，提供方式和媒體端點相同（其他檔案一律 404） |
| `GET /api/conversations/:id/files/download?root=&path=` | → 以下載提供資料夾裡的任何檔案，方式和訊息的下載端點相同（資料夾、資料夾外或 `.git` 裡的都是 404） |
| `GET /api/conversations/:id/files/zip/check?root=&path=` | → `ZipCheck` `{ all, unignored? }`：把資料夾（`path` 為 '' 時是最上層）下載成 ZIP 檔會包含多少，`{ files, bytes }`；檔案與資料夾超過 10,000 個或 1 GB 時為 null。`all` 為 null 時，`unignored` 是只包沒被 git 忽略的檔案時的同樣資訊（也太大，或資料夾不在 repository 裡時為 null）。不會讀取或壓縮任何檔案；404 的情況和列表相同 |
| `GET /api/conversations/:id/files/zip?root=&path=&unignored=` | → 資料夾的 ZIP 檔，邊送邊壓縮（`application/zip`、attachment、`nosniff`、sandbox），裡面的項目放在以資料夾命名的資料夾裡；內容和瀏覽時列出的相同（不含 `.git`、只跟隨指向裡面的連結、每個資料夾只放一次、保留空資料夾），保留權限，檔名對任何解壓縮工具都安全；成員 worktree 的最上層命名為 `<工作目錄>-<成員>`；`unignored=1`：只包沒被 git 忽略的檔案（包括裡面的其他 repository）。太大時為 413；404 的情況和列表相同；`HEAD` 只回傳標頭 |
| `GET /api/conversations/:id/messages/:messageId/diff` | → 該回合修改的 unified diff（純文字） |
| `GET /api/conversations/:id/agents/:agentId/diff` | → 某個 agent 整份 worktree 結果的 unified diff（純文字） |
| `POST /api/conversations/:id/agents/:agentId/apply` | 把 agent 的 worktree 結果套用到工作目錄 → `{ files }`（衝突時回 409） |
| `GET /api/conversations/:id/events` | `ServerEvent` 的 SSE 串流 |
| `GET /api/presets` · `POST /api/presets` · `DELETE /api/presets/:id` | 團隊範本（內建的在前）；`POST` 接受 `{ id?, name, description?, agents, settings }`，帶已儲存範本的 id（`user-…`）時會更新它 |
| `GET /api/settings` · `PUT /api/settings` | `{ defaultCwd?, createCwd?, lead?, agentHome?, agentsViewUrl?, agentsViewLink? }`（`lead`：`{ provider, model?, effort? }`，自動組隊的首席 agent；`defaultCwd` 不存在時回 404 並帶 `code: "cwd-missing"`，除非帶 `createCwd: true`，此時會建立該目錄；`agentHome`：各 CLI 自己家目錄所在的資料夾，必須是完整路徑或 `~` 開頭的路徑，不存在時建立，不可以是家目錄、根目錄，或在 Harness Relay 自己的資料夾、預設工作目錄裡面，`""` 為關閉，有對話正在執行、正在分群或首席 agent 正在修改團隊時回 409；`agentsViewUrl`：AgentsView 的網址，只接受 `localhost`、`127.0.0.1`、`[::1]` 的 `http(s)`，存成 origin，`""` 為關閉；`agentsViewLink`：介面上 **開啟 AgentsView** 改開的網址，任何 http(s) 網址，`""` 為開啟 `agentsViewUrl`）。對目前網址的上次更新失敗時，回應帶 `agentsViewError` |
| `PUT /api/settings/providers/:provider` | `{ bin?, defaultModel?, defaultEffort?, apiKey?, nativeOff?, nativeItems? }`（`apiKey: null` 代表移除；`nativeOff`：Harness Relay 執行這個 CLI 時整類不載入的它自己的項目，完整清單，可為 `skills`、`mcp`、`tools`、`instructions`、`memory`、`hooks`、`agents`、`plugins`；CLI 不能關掉的項目會被丟掉；`nativeItems`：逐項不載入的全部項目，`{ <種類>: [id…] }`，種類為 `skills`、`mcp`、`mcpTools`、`tools`、`instructions`、`hooks`、`agents`、`plugins`，id 來自 `NativeSetup`，每種最多 2,000 個；CLI 不能單獨略過的種類會被丟掉） |
| `GET /api/tools` | → `ToolLibraryView`：MCP 伺服器（變數與標頭的值已遮蔽）、skill（當下從 `SKILL.md` 讀取，無法使用時附 `problem`）、各範圍的記憶，以及機密值存放的位置 |
| `PUT /api/tools` | `{ skills?, memory? }` → `ToolLibraryView`。`skills` 會取代整個清單（`[{ path, providers? }]`；新的路徑可以是 skill 集合資料夾，且至少要有一個 skill）；`memory` 修改給定的部分（`all`、`claude`、`codex`、`grok`；每份最多 20,000 字） |
| `PUT /api/tools/mcp/:name` | `{ transport, command?, args?, url?, env?, headers?, providers?, previousName? }` → `ToolLibraryView`：新增伺服器，或帶 `previousName` 取代或改名。沒有 `value` 的變數或標頭保留原本的值。名稱已被使用時回 409 |
| `DELETE /api/tools/mcp/:name` | → `ToolLibraryView`（它的值會從金鑰儲存區刪除） |
| `GET /api/tools/skills/scan?path=` | → `{ path, skills: SkillCandidate[] }`：資料夾底下的 skill（資料夾本身，以及往下兩層內的 skill 資料夾，最多 300 個），已加入的會標示；不會儲存任何東西 |
| `GET /api/providers[?refresh=1]` | → `ProviderStatus[]` |
| `GET /api/models[?refresh=1]` | → `ProviderModels[]` |
| `POST /api/providers/:provider/native` | `{ refresh? }` → `NativeSetup`：這個 CLI 在預設工作目錄自己載入的 skill、MCP 伺服器（只有名稱、類型與狀態）與它們的工具、內建工具（Claude Code）、hook（不含指令）、subagent 與 plugin（CLI 有列出時）和指示與記憶檔，`errors` 列出它沒有回報的部分。CLI 能單獨略過的項目帶有用來不載入它的 `id`。有項目設為不載入時，會再依 Harness Relay 啟動它的方式問一次：`nativeOff`、`nativeItems` 與 `asRun` 會說明，那時不載入的項目帶有 `leftOut: true`。會在不送 prompt 的情況下短暫啟動 CLI（用 POST，所以其他網站無法觸發；Claude Code 會收到它自己回答的 `/usage` 回合）；每個 CLI、執行檔與資料夾的結果保留一分鐘，前提是不載入的設定沒有變（`refresh: true` 重新查詢） |
| `POST /api/providers/:provider/native/file` | `{ path }` → `FilePreview`：CLI 回報過的檔案之一（指示或記憶檔，或 skill 的 `SKILL.md`，路徑要完全相同），供介面閱讀；其他路徑一律 404。比對的是 CLI 最近一次的回答（不論多久以前），所以開啟檔案不會再啟動一次 CLI |
| `POST /api/providers/grok/folder-trust` | `{ cwd?, trust?, folder? }` → `GrokFolderTrust` `{ cwd, folder, above, trusted }`：Grok 是否信任 `cwd`（預設為預設工作目錄），取自 `grok inspect`。`folder` 是 Grok 用來決定信任的資料夾（儲存庫根目錄，解析連結後；不在儲存庫裡則是 `cwd` 的實際路徑）；`above` 表示它是 `cwd` 上層的儲存庫根目錄。帶 `trust: true`（只在使用者確認 `folder` 後送出）時，會再問一次 Grok，並用和 `grok --trust` 相同的方式替這個資料夾記錄在 `$GROK_HOME/trusted_folders.toml`；Grok 現在回報的資料夾和送來的 `folder` 不同，或記錄後仍回報未信任（檔案會還原成原本的內容）時回 409 |
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

- `buildBriefing()`：system 層級的簡報（角色、團隊、模式規則、工作目錄），每回合重新產生。`scheduleRules()` 說明排程送出的訊息（`via="schedule"`），`unattended`（這次執行會自動拒絕核准）時也會說明。
- `buildTurnPrompt()`：每回合的訊息，包含 `<chat>` 與最後的提示句。
- `forwardText()`：一則回覆如何呈現給其他 agent（文字 + `<actions>` 紀錄）。
- `parseMentions()`：@ 解析；名字後面可以直接接文字，行內程式碼與各種程式碼區塊（含未結束的）中的 @ 會被忽略。
- `buildPlannerPrompt()` / `PLANNER_BRIEFING`（`planner.ts`）：自動組隊模式中要問首席 agent 什麼，以及它必須回傳的 JSON。為排程訊息組隊時（`schedule`），會說明團隊會依排程、在可能沒人看著時收到它，並請首席 agent 依訊息 @ 的名字為成員命名。
- `buildRevisePrompt()` / `REVISER_BRIEFING`（`planner.ts`）：使用者想在團隊設定裡修改團隊時怎麼問首席 agent：要求、團隊、目前為止的對話、等待中的設計（針對問題或排程）、排程的訊息；它必須回傳整個團隊，改名或換 CLI 的成員要用 `was` 指出（新成員不可以），而且只為新成員或改寫的角色給出角色。排程關閉或已刪除時會說明，團隊設定指定別的資料夾時也會告訴首席 agent 它在哪個已儲存的資料夾執行。
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

- `test/store.test.ts`：SQLite store 與設定（存取往返、串流更新、當機復原、連帶刪除、檔案權限）、側邊欄群組（順序、重新命名、刪除群組時對話移到「其他」、自動分類只有一次，而且不會蓋過使用者的移動、不會分到已刪除的群組）、搜尋（每個詞都要符合、不分大小寫、標題符合的在前、中文、`%` 與 `_`、不含系統訊息、摘錄、仍在串流的回覆），以及搭配假的金鑰儲存區測試 API key：絕不寫進資料庫、舊的資料庫金鑰會被移出並從檔案中清除、儲存區拒絕寫入的情況。也測試各 CLI 執行時不載入的項目（會保存，且只保留那個 CLI 能關掉的，包括 hook、subagent 與 plugin），以及逐項不載入的項目（以 JSON 保存、只保留那個 CLI 能單獨略過的種類、回傳的是複本、其他更新不會清掉、空物件會清除）。另外也測試各 CLI 自己的家目錄：各 CLI 的家目錄變數指到資料夾內並取代繼承來的值、建立資料夾（無法建立時仍指過去並發出警告）、與 AgentsView 的網址一起保存，以及關閉後恢復繼承來的家目錄。也測試排程：隨對話保存（以及它送出的訊息）、列在側邊欄、到期的排程依最久過期排序，以及刪除排程或對話後就不見了。也測試保存自動組隊與 `autoConfirm`，以及 schema 第 13 版為在它之前儲存的對話開啟自動組隊；保存排程是否每次開新對話與上次開的對話，以及 schema 第 14 版讓之前的排程留在自己的對話；讀回對話所在的側邊欄群組（`groupOf`）；使用中的工作目錄，每個只列一次，最近用過的在前（`listCwds`）。也測試分享的對話：最新的在前並保存結束的那則回覆、對話已刪除的會標示，以及刪除紀錄（schema 第 15 版）。
- `test/workspace.test.ts`：用真實的暫存 repository 測試 git 操作（自動 init、不影響 repo 且排除其中各 CLI 自己家目錄的快照（透過連結指定也一樣）、worktree、套用、衝突、CRLF 與非 UTF-8 內容逐位元組套用、很長或特殊的檔案清單、保留的快照 ref、範圍太大的 repository）。
- `test/process.test.ts`：程序輔助函式：輸出逐位元組保存、停止不理會 SIGTERM 的子程序（包括 CLI 已結束後，以及關閉時）、工作目錄不存在、相對路徑的執行檔。
- `test/hub.test.ts`：瀏覽器重新連線時的 SSE 分送。
- `test/web.test.ts`：提供建置好的介面：帶雜湊的檔案永久快取、index.html（含前端路由）與 web app manifest（以 `application/manifest+json` 提供）每次都檢查、缺少的檔案回 404、不影響先前註冊的路由。
- `test/app-icons.test.ts`：主畫面圖示與 web app manifest：每個圖示的像素都跟 `npm run icons` 畫出的相同（不透明的 RGB、尺寸正確），manifest 就是它寫出的那份且可以安裝（192 與 512 px 圖示、maskable 圖示、`standalone`），maskable 圖示的標誌落在所有啟動器都會保留的圓內，`index.html` 也有連到 manifest 與 Apple touch icon。
- `test/demo.test.ts`：錄製示範影片的腳本：剪輯（沒有加速片段時照實際時間、agent 的工作加速到目標長度、加速片段不短於下限、略過的片段剪掉、沒錄完的錄影會被拒絕、給 FFmpeg 的畫面清單），章節列（每個章節依標記計時；團隊、首席 agent、請求核准的 agent、群組與搜尋詞依錄影填入；標記沒出現的章節會省略；兩種語言的用詞；頁面使用的標記且有跳脫），問題點名三個 CLI、設計準則裡的畫面時間，以及截圖（PNG 文字區塊只寫一次且 CRC 正確；社群預覽卡只替換原本顯示舊海報的螢幕像素）。
- `test/app.test.ts`：透過 `createApp()` 與 `app.request()` 測試 HTTP API：Host／Origin／Content-Type 檢查、回覆中刪除對話、團隊回覆中拒絕修改、設定驗證、團隊設計由按鈕或手動設定團隊確認（接著由那個團隊回答）或不採用（由目前的團隊回答）、團隊與設定變更時自動組隊維持開啟（並保存 `autoConfirm`）、首席 agent 依使用者的要求修改團隊（回傳團隊、不儲存任何東西；拒絕空的要求；請求關閉時停止；這段期間拒絕更換各 CLI 自己的資料夾；修改等待中的設計、儲存後由修改過的團隊回答）、只在要求時建立不存在的工作目錄（預設、新對話或編輯中的對話）、範本 id、側邊欄群組（名稱不能重複、在兩種語言中都不能叫「其他」、重新命名、刪除、移動對話、不存在的群組）與搜尋。也測試工具庫的路由（遮蔽的值、不合法的名稱、網址、CLI 與變數名稱、重複名稱、skill 與記憶、列出資料夾底下的 skill）、成員的工具例外設定、成員執行時拿到的項目，以及瀏覽檔案（列表、預覽、raw 只給圖片、下載任何檔案、資料夾外或 `.git` 的路徑、未知的資料夾）。也測試回覆中嵌入的圖片與影片和連結的檔案：`/media` 只給媒體類型，`/download` 把任何檔案（包含 HTML；分段、只對下載而不對影片的 `If-Range`、304、416，以及不開啟檔案的 HEAD：用 1 MiB 的檔案和開啟的檔案數確認）以沙箱化的 `octet-stream` 下載提供，隔離回合先找成員的 worktree，也能下載附件，都不會給工作目錄外或 `.git` 裡的檔案；透過 `RELAY_ALLOWED_HOSTS` 允許的主機名稱（例如 Tailscale 名稱）可以下載，其他名稱則不行。也用假的服務測試查詢 CLI 自己載入的內容（只用預設工作目錄、重新查詢、依請求語言的問題說明、未知的 CLI、不接受 GET 或表單 POST），只能讀回報過的檔案（不會再問一次 CLI），以及透過真正的查詢與一個依 grok 1.0.77 方式決定信任的替身 `grok` 測試 Grok 的資料夾信任（不在儲存庫裡的資料夾、儲存庫子資料夾改為信任儲存庫根目錄、經由連結進入的資料夾信任實際路徑、和確認時不同的資料夾、Grok 不接受紀錄時還原或移除檔案、不存在的資料夾、不接受表單 POST）。也測試更新 CLI 設定時不載入的項目（只接受已知項目的清單），以及逐項不載入的項目（依已知種類列出 id，有數量與長度上限；CLI 不能單獨略過的種類會丟掉）。另外也測試各 CLI 自己的資料夾（不存在時建立，不可以是家目錄、根目錄、檔案、相對路徑，或在 Harness Relay 自己的資料夾、預設工作目錄裡面；有對話執行時拒絕且不建立任何東西；更換時清掉登入狀態快取與進行中的登入，同一個資料夾換個寫法則不會）、AgentsView 網址（只接受這台電腦、存成 origin、重新命名的對話會送出、顯示上次的失敗且不套用到其他網址）與開啟用的網址（任何 http(s) 網址，不影響對話送到哪裡），以及 Windows 寫法的 `~\`，還有不論怎麼寫（結尾斜線、`..`、`~`、符號連結）都能認出同一個資料夾。也測試排程：儲存（下一次的時間、請求的語言、顯示在對話與列表中）、關閉與刪除、拒絕永遠不會送出或團隊還要設計或確認的排程（自動組隊的對話有了團隊之後則允許）、儲存時保留上次結果，以及時間不變時保留間隔的節奏，還有立即執行一次（送出、團隊回覆中放進佇列、接著先不送，排程的紀錄不變；關閉時也可以，對話正忙時說明原因）。也測試每次開新對話的排程：儲存，以及「立即執行一次」回傳它開的對話（每次都是另一個），上次開的對話在儲存後仍保留。也測試 `POST /api/schedules`：自動組隊的對話、排程（以訊息命名，或用給定的標題）與為它組隊的首席 agent，不會貼出訊息；第一次組隊停止後才能再請它組隊；永遠不會送出的排程什麼都不建立（連資料夾也不建立），缺少的資料夾只在要求時建立。也測試把資料夾或整個工作目錄下載成 ZIP 檔（標頭、`HEAD`、讀回的項目、404），以及太大而無法整個打包的資料夾（被忽略的 node_modules 裡超過 10,000 個檔案）：提供只包沒被 git 忽略的檔案，整個打包則為 413。也測試 `GET /api/cwds`：預設工作目錄在前，接著是使用中的工作目錄（包括名稱含空格的資料夾），最近用過的在前，不列出已經不存在的資料夾，預設工作目錄也一樣；預設工作目錄裡的 `~` 會展開，檔案系統不分大小寫時，大小寫不同的同一個資料夾只列一次。也測試分享：以對話標題放上網並留下紀錄（含結束的那則回覆，`upTo` 不是 agent 回覆時則沒有）；拒絕空的頁面、超過 1 MB 的頁面與不存在的對話；`gh` 出問題時說明原因（沒登入時附上 code）且不留紀錄；先刪 gist 再移除分享，gist 刪不掉時保留紀錄，不是 gist id 的一律不處理。
- `test/prompt.test.ts`：`@` 解析（名字後直接接文字、程式碼區塊）、`[PASS]`、失敗／停止／PASS 回覆的轉交、平行模式的簡報，以及簡報如何告訴 agent 顯示媒體、連結檔案讓使用者下載。也測試簡報中的記憶與 skill 區塊：只有在使用者沒有關掉 CLI 自己的 skill 時，才會說它們照常可用；沒有任何能讀檔工具的 Claude Code 成員不會列出 skill。也測試排程送出的訊息（`via="schedule"`），以及有排程的對話的簡報（只有沒有合理答案時才發問；除非排程設為詢問，否則自動拒絕核准），還有排程開的、自己沒有排程的對話的簡報（只在可能沒人看著的那一輪自動拒絕核准）；提問的 agent 會被告知新訊息中的排程訊息不是使用者的回答。
- `test/commands.test.ts`：解析 shell 指令：各種寫法的推送與發佈指令，以及不會讓夾帶指令通過的「本對話都允許」規則 key。
- `test/chat.test.ts`：ChatView 的邏輯：Enter 何時送出（手機和平板上不會）、何時重新連線事件串流、哪個 worktree 結果可以套用、團隊設定的草稿與它編輯的團隊（等待確認的設計，或目前的團隊）、團隊設定送給首席 agent 什麼（成員、輪流方式、權限與資料夾）、首席 agent 會改它的哪些部分（只有成員與輪流方式）、改了什麼（每一種；空的模型與角色前後的空白不算改變，這時團隊設定保留自己的成員），什麼時候不採用首席 agent 的回應（團隊重新載入，或無法儲存），按鈕在「請首席 agent 調整」與「停止」之間切換後會暫停一下（連點兩下或晚到的「停止」點擊都不會有作用），以及回應之後只有在焦點會遺失時才移到要求的輸入框、建立不存在的工作目錄前先詢問；訊息的工具呼叫與思考怎麼歸成一個動作列（什麼會分開兩列、數量、串流時不變的 key、一段思考的第一行與最新一行）。
- `test/markdown.test.ts`：@ 標示與伺服器規則一致，並略過程式碼與連結（沒包起來的網址後面直接接的中文也一致）；網址後面直接接中文時，連結在中文開始處結束；圖片以連結顯示；本機的圖片與影片透過 app 顯示；連到本機檔案的連結（包含 `file:` 網址、參照式連結與寫成圖片的檔案）會變成透過 app 下載（去掉行號或錨點，絕不連到其他電腦的共用資料夾），連到網站、錨點與資料夾的連結則保持原樣；參照式的本機媒體圖片會顯示；連結會先用 HEAD 確認（找得到、找不到，或伺服器無法回答時視為未知），找不到的檔案保留連結與文字，並在後面說明原因；確認會稍等一下，網址改變時就不再確認；點擊找不到的檔案會重新確認，找到後再替使用者點一次，不會無限循環；使用者自己的訊息保留換行；表格儲存格維持一行或以好讀的寬度換行，讓太寬的表格左右捲動。
- `test/orchestrator.test.ts`：把假的 runner 換進 `runners` 跑完整流程：平行模式的 worktree 隔離與套用、圓桌模式的修改紀錄、目錄鎖（含自動組隊）、執行準備期間或套用期間收到的請求、agent 向使用者提問（團隊停下；使用者回覆後由提問者先回答，涵蓋圓桌、平行與接力；「繼續」會略過它；回覆給別人或編輯訊息時重新開始；期間寫的訊息等回答時一起送出）、團隊回覆時送出的訊息（在下一個該收到它的 agent 發言前依序送達、沒有回合接到時再開一輪、停止後保留、被 interrupt／下一則訊息／繼續先送出、撤回、重新啟動後仍在）、執行中刪除對話、全新 session 也失敗時保留原 session，以及把失敗回合改過的檔案告訴隊友。也測試使用者關掉的 CLI 自己的項目（整類與個別項目）會傳給每個成員的執行，以及首席 agent 與群組分類的執行。另外也測試每個回合結束與執行結束時通知 AgentsView（且當時已知成員的 session）、連結首席 agent 與分群用的 session（分群在執行結束後才完成時再送一次）、回覆中被刪除的對話不再通知，以及通知失敗時執行仍然完整。也測試排程（用假時鐘的 `Scheduler`）：到期時送出訊息、標為排程訊息並讓 agent 知道、只送一次並算出下一次；排程開始的執行自動拒絕核准（顯示為已拒絕的卡片），對話中一律允許的動作除外，除非排程設為詢問；使用者在排程執行中寫訊息、或排程送出時一併送出使用者自己等待中的訊息時，又會照常詢問；團隊回覆中放進佇列，並在前一則還在等待或佇列已滿時先不送；停止後留在佇列的排程訊息在下一次時間送出，只送一次；沒有回合接走的排程訊息另開一次執行，仍然自動拒絕核准；團隊在等回答（先前的排程訊息也在等待時亦同）或還沒確認團隊時先不送，在自動組隊的對話中由目前的團隊接手、不重新設計，而且永遠不會被當成回答（回覆、繼續、排程訊息中的 @），回答之後仍留在佇列，直到它指定的 agent 發言（圓桌與接力），而排在它後面、使用者自己的訊息會和回答一起送出（打字回答、繼續、指定另一位 agent 的排程訊息）；錯過的時間略過（留下說明）或晚一點補送一次，重複的排程錯過多次也只補一次，一次性排程送出後關閉；設定變更占用對話或另一個對話正在修改同一個資料夾時再試（已經晚了也一樣，而且使用者這時送出的訊息不會留在佇列裡），超過重試時間後放棄；對話設為自動拒絕時直接拒絕、不顯示卡片；平行模式中使用者寫訊息後又會詢問；送出途中伺服器停止時不記錄；送出途中被換掉的排程保持原樣；讀不懂的已存排程被刪除；無法開始的執行；以及已刪除的對話不會送出。每次開新對話的排程：開一個團隊、設定、「本對話都允許」的動作與群組都相同的新對話（首席 agent 不會為它分類），以時間命名，裡面有說明與排程訊息，每次 agent 都開新的 session；那裡同樣自動拒絕核准（除非排程設為詢問），使用者寫訊息後改為詢問；不管排程所在的對話在做什麼（等回答、回覆中）都照送；排程所在或其他對話在同一個資料夾寫入時會等待；團隊還沒確認時不開對話，無法開始時不留下對話；「立即執行一次」會說它開了哪個對話；排程所在的對話還沒命名時，以訊息命名新對話；那個對話被刪除時忘掉連結；準備期間伺服器開始關閉時刪掉新對話；從「其他」裡的對話開的新對話不會被分類；平行模式有自己的 worktree。首席 agent 為排程組的團隊（`designForSchedule`）：為沒有人貼出的排程訊息組隊，並被告知這是排程（在這個對話或每次開新對話）；確認、直接採用（`autoConfirm`）或手動設定團隊後都不會執行，但會回答等待期間使用者寫的訊息；之後排程訊息交給這個團隊；團隊還在設計或等確認時到期的時間會再試（`busy`），確認後就送出；之後在那個對話提出的問題照常組隊；沒有排程、沒有自動組隊、已有設計在等確認，或已經有團隊時不組隊。
- `test/grok.test.ts`：Grok 的 ACP 轉接器：各權限的核准規則、session 更新轉成 `AgentEvent`、JSON-RPC 連線。也測試工具庫的 MCP 伺服器轉成 ACP 的格式。HTTP MCP 伺服器只傳給宣告支援的 Grok。也測試不載入 Grok 從 Claude Code、Cursor 載入的內容（skill、MCP 伺服器、hook）與它的記憶所用的環境變數，以及它們和使用者的環境變數、sandbox 並存。
- `test/claude.test.ts`：Claude 預先允許與移除的工具、它的參數（`--system-prompt-snapshot off`、舊版不接受的旗標），以及工具被拒絕時顯示的原因。也測試工具庫：`--mcp-config` 檔案與 skill 資料夾的 `Read` 規則（完整存取時不加）、Windows 路徑的 `Read` 規則，以及 `--mcp-config` 的內容。也測試不載入 Claude Code 自己的內容：skill 與 MCP 的旗標（工具庫的 `--mcp-config` 會保留）、指示檔與記憶的環境變數、用 `--settings` 關掉 hook 與每個已安裝的 plugin、讀取 `claude plugin list --json`，以及在送出 prompt 前拒絕它自己的 subagent（依名稱與說明，只拒絕非內建的；做不到，或 `initialize` 沒有列出 subagent 時，不送 prompt、直接失敗）。也測試用 `--settings` 不載入個別項目：skill（`skillOverrides`）、指示檔（`claudeMdExcludes`，路徑寫成只符合那個檔案，並用 picomatch 依 Claude Code 的比對方式驗證）、內建工具、MCP 伺服器與工具（依 Claude Code 的命名）與 subagent 的拒絕規則、依 id 關掉 plugin、整類不載入時不再加個別項目（subagent 與 plugin 除外）、工具庫給這次執行的伺服器不加規則，以及用 `--tools ""` 關掉所有內建工具。執行透過替身 `claude`（`test/fake-claude.ts`，依 Claude Code 2.1.319 的回答格式）測試：關掉 hook 與 plugin、用放在私有檔案（執行後刪除）的 `--settings` 不載入個別項目並立刻送出 prompt、送出 prompt 前拒絕 subagent（包括取代內建 subagent 的同名 subagent）、無法不載入 subagent 或 plugin 時清楚地失敗、等待中按下停止，以及舊版不接受某個旗標時不帶它重試。
- `test/templates.test.ts`：判斷範本編輯器有沒有修改範本（成員 id、前後空白與空的選填欄位不算；名稱、說明、成員、模式、輪數與交棒次數都算）。
- `test/copy.test.ts`：複製單則訊息或整段對話時產生的 Markdown（兩種語言）；說明首席 agent 選了哪個團隊的那一行（保留、備援、調整），以及註明未採用的設計；單則訊息照原文複製（網址、格式、CRLF 換行），沒有剪貼簿 API 時也一樣。也測試排程訊息 @ 了團隊沒有的名字時，排程表單、團隊編輯器與團隊卡片怎麼說（改由誰回答，兩種語言），以及卡片什麼時候檢查。也測試首席 agent 對團隊的每一種修改怎麼用文字說明（兩種語言）。
- `test/share.test.ts`：分享的對話放進的 gist：一個從 stdin 讀入 `index.html` 的 secret gist，以標題說明；github.com 的 gist 有 gistpreview 連結，其他主機則沒有；用假的 `gh` 測試：回傳的連結、沒安裝時說明怎麼安裝、沒登入時說明怎麼登入（各附錯誤代碼）、gh 自己的原因、逾時；不詢問就刪除 gist、GitHub 也找不到的視為已刪除（使用 gh 真正的「not found or not owned by you」訊息），屬於另一個帳號的則保留、gh 太舊不支援 `gist delete --yes`（2.66.0 之前）時說出需要的版本與目前安裝的版本、在 Homebrew 的資料夾找 gh，以及只有十六進位的 gist id 能進到它的命令列。
- `test/share-web.test.ts`：分享頁：全部訊息或到某則回覆為止（那則回覆不在時什麼都不給）、還在串流的回覆、拿掉哪些內容（工具呼叫、思考過程與 app 的控制項，依元件真正使用的 class 名稱）、保留哪些連結、把圖片放進 1 MB（從最大的開始不放，以及沒有圖片也太大的頁面）、UTF-8 大小、它的 `Content-Security-Policy`（不執行腳本、不載入任何東西）、跳脫的標題、只接受 data URL 的圖示，以及頁尾（Harness Relay 的名稱與 logo，以及分享時間右邊的連結圖示，兩者都連到它的網站，不顯示網址）；也測試設定裡每個分享的內容範圍（兩種語言）、分辨 GitHub CLI 沒安裝或沒登入與其他錯誤，以及說明裡的官方安裝指令與連結。
- `test/approvals.test.ts`：「本對話都允許」的規則 key 與比對（串接指令、shell 包裝）。
- `test/codex.test.ts`：Codex app-server 轉接器：thread 項目轉成 `AgentEvent`（文字、推理、計畫、指令輸出、用量），以及核准請求 / 回應。也測試工具庫的 MCP 伺服器放在一個 `mcp_servers` 表（完整存取下自行核准工具），以及 Codex 的 MCP 工具呼叫核准（codex-cli 0.167.0 送出的格式）和其他核准一樣顯示，其他 elicitation 則拒絕。也測試不載入 Codex 自己的內容：各項覆寫（包括 hook 與 plugin），以及改用 `-c` 參數傳入的同樣覆寫（inline table、key 加引號）；thread 開始後檢查設為不載入的 hook 與 plugin 確實關掉了（Codex 仍列出開著的或無法回答就失敗，沒有這個方法時照常執行），以及透過替身 `codex app-server` 的執行（開關也放在它的命令列、回合開始前檢查、Codex 忽略開關時失敗、檢查中按下停止就不開始回合）；在同一個表裡關掉它設定的每個 MCP 伺服器，不論名稱（工具庫取代的除外）；只在不載入 MCP 伺服器（全部、個別伺服器或它們的工具）時才用 `config/read` 詢問，問不到時以清楚的訊息讓執行失敗；個別的 skill（`skills.config`）、hook（`hooks.state`）與 plugin（`plugins`），寫成表與 `-c` 參數；只針對使用者設定裡的個別伺服器與工具（`disabled_tools` 保留使用者已關掉的）；檢查個別 skill、hook 與 plugin 確實關掉了；以及帶著這一切的 `thread/start` / `thread/resume` 請求。
- `test/schedule.test.ts`：排程何時送出：`HH:MM` 與時區、把牆上時間換成時刻（時鐘跳過的時間往後移、重複的時間取第一次）、每天（今天或明天，時鐘調整前後時間不變）、每週（只在選定的日子，必要時到下週）、每隔幾小時（從儲存時算起）與一次性排程，以及讀不懂的時間；時鐘往回撥的那一夜、午夜與半小時的調整（聖地牙哥、豪勳爵島）、時鐘調整前後的每週時間，以及依排程所在地的星期幾（東京）。也測試 `validateSchedule()`（預設值、星期去重並排序、永遠不會送出的設定、關閉時保留過去的一次性排程）與排程視窗的邏輯：新表單與讀回已儲存的排程、瀏覽器輸入的日期時間、表單顯示的問題（和伺服器一致）、接下來的時間、以排程自己的時區顯示時間、用幾個字描述排程（星期一在前）、何時需要注意，以及一次性排程何時算完成；是否每次開新對話（只有真正的 `true` 才算），在表單中與讀回時。
- `test/sidebar.test.ts`：側邊欄的對話狀態、各群組的對話（「其他」在最後、群組不存在的對話放在「其他」）、還沒確認的移動，以及收合群組顯示的狀態。
- `test/search.test.ts`：搜尋的詞、不分大小寫的比對（長的優先、重疊合併）、第一個符合處附近的摘錄、標示關鍵字。
- `test/grouping.test.ts`：請首席 agent 分類對話的 prompt，以及解讀它的回覆（編號或名稱；0 或 null 代表都不適合；其他都拒絕）。
- `test/mentions.test.ts`：訊息 @ 了但不在團隊裡的名字（`unknownMentions`）：不分大小寫、每個只列一次、已知名字後直接接中文、較長的單字、已知與未知的名字同時出現、套件 scope 與 decorator 當成程式碼、標題、強調與表格，以及只看一般文字（不含程式碼、連結與 email），沒包起來的網址後面直接接的中文算一般文字。
- `test/links.test.ts`：沒包起來的網址在哪裡結束（`src/shared/links.ts`）：在直接接在後面的中文前結束，那段文字中的下一個網址自成一個連結；在全形標點、彎引號與刪節號結束，並去掉結尾標點（`)` 對應到 `(` 時保留）；屬於網址的中文（路徑的一段、查詢參數的值、網域）保留；`<…>`、`[文字](…)` 與 email 連結不變；同一個網址處理兩次結果不變。
- `test/planner.test.ts`：首席 agent 的回覆：擷取 JSON、範本與自訂團隊、驗證、改用已登入的 CLI、備援方案，以及 prompt。也測試對話中的問題：prompt 中的歷史與目前的團隊、保留目前的團隊（id 也一樣）、備援方案保留它、留下來的成員保留 id，以及精簡過的對話（不含工具呼叫、系統訊息、plan 與 pass；過長的訊息與對話會縮短，保留最新的部分）。也測試排程訊息 @ 了但沒有成員叫這個名字的名字，首席 agent 會被要求用這些名字為成員命名（一般問題不會，套件 scope 與 decorator 也不算）。也測試依使用者的要求修改團隊：prompt（團隊、要求、對話、等待中的設計、排程的訊息）、留下來的成員保留 id、工具、模型、推理強度與 CLI，新成員改用已登入的 CLI，用 `""` 清除模型，名字沒變而換到另一個 CLI 的成員（沒有 `was`）保留 id，拒絕無法執行的團隊，以及讀取輪流方式時的預設值；用 `was` 改名或換 CLI 的成員保留 id 與工具（不帶舊 CLI 的模型），所有的 `was` 先於名字比對（和被改名的成員同名的新成員仍是新成員），首席 agent 的回覆省略沒有改的角色，排程關閉或已刪除時會說明，團隊設定指定別的資料夾時告訴首席 agent 它在哪個已儲存的資料夾執行，兩邊剛好各只剩一位、且沒有角色或角色相同時把沒有 `was` 的改名認出來，`null` 或空白的角色與 `null` 的模型或推理強度視為沒有給，誤用在以不變成員為範本的新成員上的 `was` 會被忽略（新成員從那位成員的角色開始，也不會被當成要移除的成員），互換名字與連續改名時保留每位成員，告訴首席 agent 它不能清除角色，首席 agent 去掉前後空白照抄的角色維持原樣，沒有成員的回覆保留原本的成員，拒絕重複的成員、超過 8 位時截斷，prompt 讀到團隊設定裡的權限與資料夾，以及針對排程的設計會說明它回答排程的訊息。
- `test/tour.test.ts`：使用導覽：每一步都有對應的目標、新版本會再顯示一次，以及步驟的 fingerprint（步驟改了卻沒有換新版本時會失敗）。
- `test/i18n.test.ts`：語言偵測（伺服器 header 與瀏覽器）、語言在非同步工作中的傳遞、雙語範本，以及兩份介面字典結構相同。
- `test/voice.test.ts`：用假的下載、程序與引擎測試語音輸入：固定版本的下載清單、背景安裝（引擎、模型、檢查），涵蓋 Linux 與 macOS 的 Homebrew、SHA-256 不符、取消、硬碟空間、自訂引擎路徑、引擎無法啟動、引擎只聽 127.0.0.1 並藏在隨機路徑後、語音轉文字與辨識語言、切換與刪除模型、設定，以及 HTTP 路由。
- `test/voice-web.test.ts`：瀏覽器端的語音輸入：WAV 編碼、靜音判斷、把辨識結果插入游標處，以及麥克風與設定頁顯示的狀態。
- `test/tools.test.ts`：工具庫：front matter、找出 skill（往下兩層、本身就是 skill 的資料夾、列出名稱並標示是否已加入）、用假的金鑰儲存區測試 MCP 機密值（遮蔽、沒送出時保留、改名時仍以伺服器 id 保存，包括在名稱不分大小寫的儲存區只改大小寫、從資料庫移出、儲存區失敗），依 CLI 的預設與成員的例外設定、被標示的 skill，以及還沒有 CLI 範圍時存下的舊資料。另外：伺服器或 skill 改名後成員的例外設定仍有效；沒能搬走的值留在資料庫；讀不到的值不會被覆蓋，金鑰儲存區打開後會再讀一次。
- `test/files.test.ts`：用真的暫存資料夾測試瀏覽檔案：資料夾外、經由符號連結或進入 `.git`（不分大小寫）的路徑、列表順序與項目上限、文字 / 圖片 / 二進位檔的預覽與長檔案截斷、raw 只給媒體檔、下載可以給資料夾以外的任何檔案，以及對話提供的資料夾。經由連結進入的資料夾保留當初要求的路徑，截斷的列表保留顯示順序的前面幾項。也測試資料夾 ZIP 檔的內容（`zipPlan`）：以資料夾命名、不含 `.git` 也不含指向外面的連結、每個資料夾只放一次（繞回去的連結會略過）、保留空資料夾、超過上限就放棄（資料夾也算在內，所以一堆空資料夾也會停下）、保留權限、最上層用指定的名稱、略過 `.git.`，以及要求時只包沒被 git 忽略的檔案（追蹤中與未追蹤的檔案，不含已刪除或被忽略的，也不含指向外面或 `.git` 的追蹤中連結；包括裡面其他 repository 沒忽略的檔案；不在 repository 裡時就是全部）。
- `test/media.test.ts`：回覆中哪些網址是這台電腦上的檔案（相對與絕對路徑、`file:` 網址、`檔案:行號`；其他 scheme、其他網站、錨點與資料夾都不是）、媒體類型、只在允許的資料夾裡解析媒體與下載的檔案（不跟隨指向外面的連結，也不包含任何大小寫的 `.git`；不會查詢資料夾外的路徑；接受經由連結寫出的資料夾絕對路徑）、回覆的檔案從哪些資料夾、依什麼順序取得、下載檔名標頭（RFC 5987 加上 ASCII 備用名稱）、位元組範圍。
- `test/zip.test.ts`：ZIP 寫入器，用解壓縮工具讀檔的方式讀回來（`test/zipReader.ts`）：UTF-8 檔名的資料夾與檔案、以 data descriptor 和 Unix 權限 deflate 壓縮、空檔案、空的壓縮檔、打不開的檔案會略過、讀取錯誤會讓壓縮檔以錯誤結束、下載中止時關閉開著的檔案（剛送出標頭時也是）；檔名處理成安全的形式（`\`、`..`、`:`、開頭的 `/`、控制字元）並保留權限；MS-DOS 時間。
- `test/files-web.test.ts`：檔案瀏覽的路徑導覽列、篩選、程式語言與行數。也測試把資料夾下載成 ZIP 檔時的選擇：全部、只包沒被 git 忽略的檔案，或太大。
- `test/tools-web.test.ts`：團隊編輯器的工具選擇：項目、各 CLI 的記憶、依 CLI 的預設，以及只記錄例外。
- `test/cwds-web.test.ts`：工作目錄輸入框的清單：剛打開或輸入框清空時列出全部、只留下包含輸入的每個詞的路徑（不分大小寫、保持原本順序）、名稱含空格的資料夾（不論輸入幾個空格）、把 `~` 當成家目錄，以及 Windows 路徑不論輸入哪種分隔符號都能比對、標示時依路徑原本的寫法。也測試清單如何回應：↑ ↓ 在清單中循環、重新取得清單時反白仍停在同一個資料夾、清單沒有顯示任何項目時 ↑ ↓ 會列出全部、Enter 只在有反白的資料夾時作用、Escape 只在清單顯示時作用（否則交給對話框），以及箭頭按鈕。
- `test/native-web.test.ts`：CLI 自己載入的內容那一區：查詢前各 CLI 的分頁與查詢後的數量（指示與記憶分開）、各 CLI 能整類或逐項不載入哪些、勾選與清除個別項目、執行時不載入幾項（MCP 伺服器連同它的工具只算一次）、查詢後不載入的設定是否已變更、查詢結果裡已經沒有的勾選項目與清除它們，以及保存的個別項目（`nativeItemsFor`）。
- `test/native.test.ts`：各 CLI 自己載入的內容：讀取 Claude Code、Codex、Grok 的回答（實測格式；MCP 設定與其中的 token 會被丟掉）、Claude Code 與 Codex 會讀的指示和記憶檔（真的暫存資料夾），無法啟動的 CLI、依執行檔與不載入設定分開的快取、不論多久以前的最近一次回答（開啟回報過的檔案時用）、依請求語言的問題說明，以及哪些檔案可以讀（只有回報過的）。也測試 hook（不含指令）、subagent 與 plugin；標示 Harness Relay 執行時不載入的項目（不含 CLI 自己就關掉的）；Claude Code 與 Codex 依環境變數與設定略過的檔案；以及透過替身 `claude`、`codex`、`grok` 執行檔，依 Harness Relay 啟動各 CLI 的方式再問一次（和執行時相同的旗標、覆寫設定與環境變數；失敗時不標示任何項目；第二次回答缺少的清單會在錯誤中列出；只有指示檔或記憶時不再啟動 Claude Code；取代內建 subagent 的同名 subagent 不算內建；無法列出 plugin 的情況）。也測試工具：從 Claude Code 的 `/usage` 回合讀出內建與 MCP 工具（MCP 工具依伺服器分組，只有那個回合列出的伺服器也算），只在 `/usage` 是它自己的指令時才送（有同名 skill 就不送）且不留下 session，它不接受 `--no-session-persistence` 時改成不送這個回合再問，skill 整類不載入（它不列任何指令）時再問也會送；從 `mcpServerStatus/list` 讀出 Codex 每個伺服器的 MCP 工具（照 Codex 列出的，不依它回報的設定過濾；啟動失敗的伺服器不列工具；關掉的伺服器第二次不再啟動；忽略 `disabled_tools` 的 Codex 會顯示工具仍會載入）。也測試勾選了但第二次回答仍載入的項目（`stillLoaded`，只限有給的清單），以及第二次回答逾時時保留已回答的部分。以及個別項目：Claude Code 的 skill、內建工具、MCP 工具、工具都被拿掉的整個 MCP 伺服器、subagent（內建的也可以）、plugin 與指示檔；Codex 的 skill、MCP 伺服器與工具、hook 與 plugin；都透過替身標示出來。另外也測試 CLI 的家目錄改變時會重新詢問（透過真的 `SettingsStore`）。
- `test/agentsview.test.ts`：用假的 `fetch` 測試把對話送到 AgentsView：thread 寫成 Claude Code 的 session 紀錄（使用者的訊息、以成員名稱和 CLI 開頭的回覆、註明失敗、附件以檔名表示、不含系統訊息與串流中的回覆、最後是標題）、AgentsView 的 session id、上傳（檔名、取自已知 agent session 或資料夾名稱的 project 與 machine、`allow_shorter`、`Origin` 標頭）與 parent 連結（包含首席 agent 與分群用的 session）、沒有網址或沒有訊息時不送、每個對話一次只跑一個更新且之後只再送一次最新狀態、沒事可做的更新結束後能立刻再開始、丟掉已刪除對話還在等待的更新、絕不跟隨重新導向、project 取自 AgentsView 第一個有回應的 agent session，以及依網址保留上次的失敗直到更新成功。
- `test/route.test.ts`：前端的 hash 路由（含「新排程」頁面），包括設定頁的區塊，以及正在看哪張設定卡片（在連結列標亮）；標亮的連結看得到時連結列不動，看不到時只捲動剛好需要的距離，也不會捲過兩端。
- `test/grok-trust.test.ts`：記錄 Grok 對資料夾的信任：和 `grok --trust` 相同的紀錄、取代標為不信任的紀錄並保留其他內容、Windows 路徑的 TOML 跳脫、寫在暫存 `GROK_HOME` 的檔案（只有擁有者能讀）、還原成原本的內容，從 `grok inspect` 讀出信任狀態與決定信任的資料夾（去掉結尾斜線的專案根目錄，是否在資料夾上層，否則就是資料夾本身），以及等待確認的團隊設計什麼情況會顯示它（有 Grok 成員與資料夾）。
- `test/util.test.ts`：把成員或首席 agent 切到另一個 CLI 再切回來，會還原每個 CLI 選過的模型與推理強度。
- `test/quickstart.test.ts`：使用者複製的指令在任何 shell 都能執行：npm scripts 不用 Unix 的方式設定環境變數（npm 在 Windows 上用 cmd.exe 執行），首頁、README 與使用指南不用 `&&` 串接指令（Windows PowerShell 5.1 不接受），README 的快速開始從 clone 開始，首頁、README 與使用指南安裝的都是建置好的 app（先 `npm run build` 再 `npm start`，網址 <http://127.0.0.1:8787>），首頁只在開發時提到 `npm run dev`。也測試中文文件裡沒有網址直接接著中文字，否則 GitHub 會把後面的字一起變成連結（請寫成 `<http://…>`）。

`test/orchestrator.test.ts` 也涵蓋用假 agent 測試核准（詢問並等待、「本對話都允許」、拒絕時的說明、停止時過期、自動拒絕）、重試回覆、編輯使用者訊息（`resend`：之後的訊息會被刪除，每個 agent 都開新的 session），以及用假的首席 agent 測試自動組隊（自訂設計等待確認，確認後團隊回答問題，並一併收到期間寫的訊息；手動設定團隊也算確認；存成範本；使用範本；備援方案，有團隊時保留目前的團隊；每個新問題都依到目前為止的對話與目前的團隊設計，留下來的成員保留 session；回答、@ 成員的訊息、「繼續」與重試都由目前的團隊接手；不必確認、立刻採用的團隊，以及它無法開始時（對話中說明原因，按「繼續」由團隊回答，不重新設計）；設計等待確認時保留目前的團隊（重試較早的回覆、不採用設計、第一個問題沒有團隊可保留）；對話被佔用時拒絕確認；沒有任何回合接手的插話與 @ 成員的編輯交給目前的團隊，而「停止並改問」會重新設計；設計被停止後按「繼續」重新設計；編輯問題後重新設計，並以之前的內容作為歷史；以及規劃時不上鎖）、首席 agent 依使用者的要求修改團隊（`reviseTeam`：回傳整個團隊，prompt 中有要求與對話，留下來的成員保留 id，對話本身不變，等待中的設計繼續等待；讀到團隊設定裡的權限與資料夾，但在已儲存的資料夾執行（同一個資料夾換個寫法不算別的資料夾）；只在排程開啟時提供排程訊息；針對排程的等待中設計（排程關閉時仍提供它的訊息）；用 `was` 改名的成員保留 id；婉拒時保留團隊；拒絕空的或無法使用的要求與回覆，以及團隊設定裡無效的名字；首席 agent 的 CLI 失敗；它的 session 在 AgentsView 中連到對話；請求關閉、有更新的要求或刪除對話時停止；被取代的要求在刪除對話時也會等到首席 agent 的程序結束；關閉伺服器時停止，並等到首席 agent 的程序結束，之後拒絕新的要求）、用假的首席 agent 測試把新對話分到群組（只看第一則訊息、與團隊同時進行、沒有群組時不詢問、不蓋過使用者的移動、刪除對話時停止），還有附加檔案（以安全檔名儲存、把圖片與路徑交給每個 agent、編輯訊息時保留、隨被刪除的訊息一起刪除、只傳檔案的訊息、錯誤的上傳）。

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

### 錄製示範影片

README 與網站首頁的示範影片（`docs/media/demo-*.mp4` 與 `.webp`）是實際執行的錄影，由 `npm run demo`（[`scripts/demo/`](../scripts/demo/)）錄製。影片經過的介面改變時，請重新錄製。需要：三個 CLI 都已安裝並登入、FFmpeg 與 libwebp（macOS：`brew install ffmpeg webp`），以及 `playwright-core` 驅動的 Chromium（執行一次 `npx playwright-core install chromium-headless-shell`，或用 `DEMO_CHROME` 指定 Chrome 或 Chromium 的執行檔）。

```bash
npm run demo                          # 錄製兩種語言，剪輯並發布
npm run demo -- record --dry          # 不跑 agent，只檢查到開啟對話為止的操作流程（不到一分鐘）
npm run demo -- record --lang en      # 只跑一個步驟、一種語言
npm run demo -- cut publish           # 重新剪輯並發布上次的錄影
```

1. **record**：建置 UI，在獨立的埠號（8791，第二種語言用 8792）啟動 Harness Relay，資料放在 `data/demo/<lang>/` 裡的空資料夾，不會動到你自己的對話與設定；對話的工作目錄是這個 repository（唯讀）。接著 headless 瀏覽器像人一樣操作（畫出游標）：新增群組、打開「三方辯論」範本、開新對話並提出點名三個 CLI 的問題、確認首席 agent 的團隊、等待回答（超出唯讀的請求會顯示後拒絕，agent 問的問題會略過）、問一個有自己團隊的新問題、在「檔案」裡打開 `orchestrator.ts` 中接力模式交棒的地方，最後搜尋。兩種語言同時錄，用真正的 CLI 約需半小時。每個步驟都會在 `marks.json` 留下標記。
2. **cut**：把 agent 工作的片段加速，讓影片長約兩分鐘（`--length`），寫出 `video.mp4`（1600×1000、24 fps）、`animation.webp`（880×550、8 fps）與 `timeline.json`。如果錄影時白等了一段，在 `marks.json` 加一對 `skip-start` / `skip-end` 再剪一次。
3. **publish**：把影片與動畫複製到 `docs/media/`，從第一個團隊卡片出現的畫面（`poster` 標記）重新擷取海報、截圖與社群預覽卡，重新計時 `site/index.html` 與 `site/zh-TW/index.html` 的章節列，以及 `site/DESIGN-GUIDELINES.md` 裡的畫面時間，並寫出 `data/demo/<lang>/review.md`：寫入的章節、團隊、核准請求、搜尋詞與每則回覆。

之後讀 `review.md` 並看過影片。章節的句子在 `scripts/demo/chapters.ts`；團隊、名字、輪數、群組與搜尋詞會依錄影填入，但如果 agent 做了句子沒描述到的事，請在那裡修改，再執行 `npm run demo -- publish`。也請檢查 README 的影片說明與章節列的註記，再把影音檔、`site/` 與腳本一起 commit。

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
