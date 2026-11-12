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
  shared/family.ts         一串分支對話：每個對話的上一層與頂端，頂端刪除後也一樣（伺服器與介面共用）
  shared/auth.ts           讓瀏覽器登入（伺服器與介面共用）：一次性代碼（Crockford base 32）、連結的 #code= 片段、瀏覽器的名稱、金鑰標頭
  shared/share.ts          分享頁上指向附檔的佔位連結（介面寫入，伺服器填上網址），以及依分享上限的算法顯示大小
  shared/schedule.ts       排程下一次何時送出：時區中的牆上時間、時鐘調整（伺服器與介面共用）
  server/
    index.ts               組裝元件、靜態檔案、啟動與關閉
    web.ts                 提供建置好的介面：帶雜湊的檔案永久快取，index.html 每次都檢查；介面放在哪裡（RELAY_WEB_DIR）
    parent.ts              啟動伺服器的桌面 app（如果有）：告訴它伺服器已開始接收連線（或無法接收），並接收它的關閉要求與它的更新狀態
    updates.ts             聊天介面顯示的桌面 app 更新：app 最後說的狀態，並把聊天介面的要求（立刻檢查、更新）轉給它
    app.ts                 createApp()：路由、安全性中介層（Host/Origin、JSON 寫入、登入）、SSE（可用 app.request() 測試）
    auth.ts                已登入的瀏覽器：一次性代碼、session（cookie 與金鑰，只存雜湊）、錯誤代碼的次數限制
    signin.ts              伺服器與 `npm run login` 印出的登入連結
    protect.ts             完全存取以外的 agent 碰不到的地方：瀏覽器的資料夾與資料庫（protectedReads）、可編輯模式下 Harness Relay 自己的資料夾
    orchestrator.ts        團隊回合：決定誰發言、交付 prompt、把串流寫進訊息；自動組隊、重新傳送
    planner.ts             自動組隊：首席 agent 的 prompt（問題、歷史、目前的團隊、各 CLI 的模型與工具、工具庫）、解析回覆、可執行的團隊、備援方案；
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
      cursor.ts            Cursor：ACP（`cursor-agent acp`），沒有作業系統沙箱；每次執行一個私用的設定資料夾（它的設定、拒絕規則、連到帳號 session 的連結）
      antigravity.ts       Antigravity：ACP（`agy acp`），沒有沙箱（完全存取以外每個指令都詢問；被拒絕就結束它這一輪）；每次執行有自己的設定（`--cli_dir_name`：只有帳號的模型與服務）、專案自己的 MCP 伺服器、hook 與 plugin 在它啟動前先詢問、它留著執行的指令在它結束後結束、帳號的家目錄（`--gemini-dir`），說明放進它的系統提示
      acp.ts               Codex、Grok、Cursor 與 Antigravity 轉接器及共用 ACP 回合使用的 JSON-RPC 對端，以及 Grok、Cursor 與 Antigravity 共用的 ACP 輔助函式（prompt 區塊、MCP 伺服器、核准回覆、內容文字）
      acpTurn.ts           開源 agent 共用的 ACP 回合：session update 轉成事件、權限詢問 → 判斷 → 核准、接續 session、模型 / 推理強度 / 模式、各 CLI 的 hook（`AcpAgentSpec`）
      open.ts              開源 agent 程序共用的部分：這次執行的模型來源、家目錄（狀態與設定路徑）、這次執行的暫存資料夾、Harness Relay 的沙箱（`startOpenProcess`）
      opencode.ts goose.ts cline.ts openhands.ts
                           使用 ACP 的 開源 agent，一個一個檔案：各自的 `AcpAgentSpec` 與 `OpenAgentDefinition`
      pi.ts                Pi：透過它的 JSONL RPC（`pi --mode rpc`）
      piGate.js            Pi 的 gate 擴充功能（完全存取以外由 Pi 載入）：透過 RPC 在每個工具呼叫前詢問
      index.ts             runner 註冊表，以及 `openAgents`
    process.ts             啟動/結束程序（process group、逐行串流、以位元組保存輸出、逾時），伺服器等它結束的簡短檢查用 runSync()
    winLaunch.ts           在 Windows 上，CLI 是 .cmd 時要啟動什麼（npm 的包裝檔、Cursor 的啟動檔）
    ports.ts               Harness Relay 的 port：8787（npm start、桌面 app）、8789 與 Vite 的 5173（npm run dev），PORT 優先
    config.ts              啟動時由環境變數設定的值：每個 CLI 的帳號數、隊伍人數、回合逾時、語音輸入的下載來源與它自己的資料夾（會檢查；有不合法的值時伺服器拒絕啟動）
    share.ts               分享對話：透過使用者的 gh 把頁面放成 secret gist（建立、刪除），以及 gistpreview 連結；回覆連結的檔案（照下載路由的方式找、不限種類、檔名不重複）用 git 推進另一個 secret gist（由 gh 幫 git 登入），gh 說不出是否建立了它時用代號再找出來
    about.ts               回報問題時附上的資訊：這是哪個版本的 Harness Relay、跑在什麼系統與 Node 上，不含任何指出使用者的內容
    screenshots.ts         回報問題的截圖：確認是 PNG、JPEG 或 WebP 圖片（不接受 GIF），依順序命名，拿掉中繼資料（照片的拍攝位置等），用使用者的 gh 上傳成一個 secret gist
    providers.ts           各帳號的 CLI 狀態、登入流程、登出，模型快取
    models.ts              各 CLI 的模型 / 推理強度探索
    db.ts                  開啟 SQLite、遷移、transaction()、資料夾的鎖（lockDataDir）
    store.ts               對話、訊息、agent session、範本、側邊欄群組、搜尋、排程
    settings.ts            provider 設定、各 CLI 的帳號、預設工作目錄、各 CLI 自己的家目錄、子程序環境變數
    agentsview.ts          AgentsView：每個對話送成一個 thread，成員的 session 連在底下（Cursor 與開源 agent 的是 Harness Relay 記下的）
    secrets.ts             存放 API key 的作業系統金鑰儲存區（keyring）、可用性檢查
    backends.ts            開源 agent 的模型來源：API key 與自訂端點（keyring、`model_backends`）與已刪除端點的 id（`deleted_endpoints`），以及一次執行用的 `backendRun()`；Claude Code、Codex 或 Grok 在端點上執行，或因端點已刪除而拒絕時用的 `endpointRunModel()`
    relaySandbox.ts        完全存取以外包住 開源 agent 的 Harness Relay 自己的沙箱（`sandboxCommand`，srt）
    relaySandboxHost.ts    每次在沙箱中的執行各有一個的 host 程序：只為那次執行跑一個 sandbox-runtime、它的 proxy 與控制通道（fd 3）
    sandboxProcs.ts        macOS 上依沙箱找出 Harness Relay 沙箱的執行留下的行程（sandbox_check）
    fsRemove.ts            不跟隨連結移除執行留下的東西；只有在清掃確定沒有殘留的啟動時，才恢復擁有者的權限
    tools.ts               工具庫：MCP 伺服器（機密值放在 keyring）、skill（SKILL.md 的 front matter）、記憶；每位成員拿到哪些
    files.ts               瀏覽對話的檔案：可瀏覽的資料夾、列表、預覽、路徑檢查、資料夾 zip 的內容
    zip.ts                 邊送邊寫的 ZIP 檔（deflate、data descriptor、UTF-8 檔名）
    folderPicker.ts        工作目錄輸入框用的系統選擇資料夾視窗（AppleScript、zenity／kdialog、Windows Forms）：用哪一個、它的指令、它的回答
    native.ts              各 CLI 自己載入的內容（它的 skill、MCP 伺服器與它們的工具、內建工具、hook、subagent、plugin、指示與記憶檔），不送 prompt 查詢（Cursor 的，以及 Antigravity 的 MCP 伺服器與指示檔，從它們會讀的檔案取得），以及 Harness Relay 執行時不載入哪些
    grokTrust.ts           在使用者確認後記錄 Grok 對資料夾的信任（和 grok --trust 相同）
    attachments.ts         訊息的附加檔案：儲存、安全檔名、交給 agent 的圖片
    presets.ts             內建團隊範本（兩種語言）
    validate.ts            agent、設定、排程與模型來源的輸入驗證
    voice.ts               語音輸入：安裝 whisper.cpp 引擎與模型（固定版本、檢查 SHA-256）、引擎程序、語音轉文字
    workspace.ts           git：自動 init、快照、worktree、diff、套用
    errors.ts              HttpError（帶狀態碼、給使用者看的錯誤）
    hub.ts                 SSE 廣播
  web/
    main.tsx App.tsx api.ts util.ts copy.ts styles.css index.html
    auth.ts                已登入瀏覽器送出的金鑰（localStorage，只有這個來源讀得到）；「已登出」的回應代表什麼（等這個分頁中正在進行的登入都完成後：只有金鑰仍是送出時那把才算登出，這把金鑰留在 storage 給其他分頁；金鑰被新的登入取代時改用新金鑰重送一次；其他情況不再處理）；別的分頁存入新金鑰（`keyArrived`）
    signin.ts              用連結登入（把代碼從網址拿掉、頁面開啟時的第一次檢查，開發時 App 的 effect 執行兩次也共用這一次檢查）與登入頁指向哪裡
    public/                原封不動複製到建置結果：manifest.webmanifest 與主畫面圖示（npm run icons）
    chat.ts                ChatView 的純邏輯：串流是否重新連線、能否套用、團隊設定草稿與它編輯的團隊、訊息何時跟著新內容捲動
    sidebar.ts             側邊欄的純邏輯：各群組的對話、每串分支排成樹狀、還沒確認的移動、收合群組或分支的狀態
    schedule.ts            排程視窗的純邏輯：表單、表單的問題、接下來的時間、用幾個字描述排程
    templates.ts           範本編輯器的純邏輯：範本有沒有被修改
    files.ts               檔案瀏覽的純邏輯：路徑導覽列、篩選、程式語言、行數、資料夾 zip 的選擇
    cwds.ts                工作目錄輸入框的純邏輯：使用中的工作目錄有哪些符合輸入的內容（`~` 代表家目錄，`/` 與 `\` 視為相同）、清單如何回應按鍵與箭頭按鈕，以及它的標籤（每個資料夾只加一次、Enter 與 Backspace、選擇資料夾視窗開在哪裡）
    download.ts            在使用者點下前，先確認回覆連結的檔案能不能下載（連結出現一會兒後的 HEAD 請求），以及檔案不存在時點擊會做什麼
    share.ts               分享頁不需要 DOM 的部分：拿掉哪些內容、圖片的大小預算、頁面與它的 CSP、Harness Relay 的頁尾；回覆連結的檔案（從下載連結讀回、每個連結會變成什麼、勾選哪些並在重新檢查時保留、哪些看起來像機密）
    update.ts              聊天介面裡的桌面 app 更新：每個版本只跳一次的對話框（只在 app 自己的視窗，且沒有其他對話框開著時）、設定的「版本」卡片、多久詢問一次；以及頁面對伺服器版本的監看，更新時開著的頁面會重新載入
    dialogs.ts             頁面上開著的對話框：只有最上層的處理按鍵（useDialog），以及開著幾個
    report.ts              用電子郵件回報問題：信件的主旨與內容、一起附上的資訊、截圖的連結、mailto 與 Gmail 連結（報告太長放不進連結時改用剪貼簿）
    sharePage.tsx          從畫面上的聊天室做出分享頁（複製、拿掉不要的、樣式、圖片轉成 data URL 並控制在 1 MB 內、附檔的佔位連結）；要分享的訊息裡的檔案連結
    tools.ts               團隊編輯器的工具選擇：工具庫項目、依 CLI 的預設、成員的例外設定
    backends.ts            設定 → 模型來源：端點表單的純邏輯（從名稱產生 id、輸入的模型、表單的問題）
    native.ts              NativeSetupPanel 的純邏輯：各 CLI 的分頁與數量、勾選個別項目、執行時不載入幾項、設定是否已變更
    route.ts               前端放在網址 hash 的路由：#/（首頁）、#/new（新對話）、#/schedule、#/c/<id> 與 #/settings/<區塊>
    voice.ts               語音輸入的純邏輯：WAV 編碼、靜音判斷、把辨識結果插入游標處、安裝進度
    recorder.ts            在瀏覽器錄音，解碼成 16 kHz 單聲道
    useVoice.ts            語音輸入狀態的 hook（安裝時輪詢）
    i18n.tsx               語言偵測、provider、useT()
    limits.ts              伺服器的上限（GET /api/limits：每個 CLI 的帳號數、隊伍人數、回合逾時），收到前用預設值；元件打開、對話的即時更新重新連上、側邊欄重新連到伺服器，或頁面再次顯示時會再問一次（只在有元件顯示它們時：登入頁絕不會問）
    refresh.ts             以伺服器最後一次檢查的結果為準的 CLI 狀態（newerStatuses），以及伺服器沒有標時間的資料（例如模型清單）依請求順序的載入（latestLoader）
    theme.ts               淺色或深色主題：跟隨系統，或在「設定 → 外觀」選的（data-theme，記在 localStorage）
    locales/               zh-TW.ts（訊息結構的來源）、en.ts
    components/            Sidebar、SidebarGroups（群組、拖放）、SidebarSearch、
                           Home（app 打開時有動畫的 logo 與標語）、NewChat、TemplateEditor（範本對話框）、TeamEditor、TeamReviser（團隊設定的
                           「請首席 agent 調整」）、ModelPicker、CliPicker（選 CLI：可水平捲動的一排）、ChatView、
                           MessageItem（含 plan 卡片）、ChangesCard、Composer、Markdown、
                           SettingsPage、CopyButton、Logo、Onboarding（使用導覽）、
                           MemberDots、icons、VoiceInput（麥克風、安裝說明對話框、安裝進度）、
                           VoiceSettings（設定 → 語音輸入）、ToolsSettings（設定 → 工具庫）、
                           BackendsSettings（設定 → 模型來源）、
                           SessionsSettings（設定 → Agent 的 session）、
                           SharesSettings（設定 → 分享的對話）、ShareDialog（複製或分享對話）、
                           SignIn（登入頁）、BrowsersSettings（設定 → 已登入的瀏覽器）、
                           GhHelp（GitHub CLI 沒安裝或沒登入時該怎麼做）、
                           FileBrowser（「檔案」對話框）、NativeSetupPanel（CLI 自己載入的內容）、
                           GrokTrust（Grok 對資料夾的信任）、SectionTitle、
                           CwdInput（工作目錄輸入框：每個資料夾一個標籤、輸入內容後的 Enter 鍵、資料夾按鈕，以及使用中工作目錄的清單）、
                           ScheduleDrawer（對話的排程）、ScheduleForm（共用的排程表單）、
                           NewSchedule（「新排程」頁面）、
                           ReportDialog（側邊欄的「回報問題」）、
                           VersionSettings（設定 → 版本）、UpdateDialog（新版本，只提示一次）、
                           useDialog（對話框的焦點處理）
test/                      Vitest 測試；fixtures/<agent>/ 放從開源 agent 與 Antigravity 真正的 CLI 錄下的訊息（fixtures/antigravity/cli/：agy 自己的清單），fake-*.ts 是重播它們的替身（fake-antigravity.ts 給 antigravity.test.ts 用）；setup.ts 與 timeouts.ts：測試等多久（Windows 上較長）；orchestrator-harness.ts：協調器測試共用的假 CLI
e2e/                       端對端測試（Playwright）：npm run test:e2e
  README.zh-TW.md          它們測到的情境，依 spec 列出（英文版是 README.md）
  fake-cli/fake-cli.cjs    假 CLI 的進入點：依程序執行時的名稱判斷它是十個中的哪一個
  fake-cli/agents/         每個 CLI 一個假 CLI（<provider>.cjs），說它自己的協定；opencode-goose.cjs 是這兩個共用的部分
  fake-cli/lib/            假 CLI 共用的部分：stdio 上的 ACP 與 JSON-RPC、一個回合的步驟（plan.cjs：e2e: 指令）、家目錄、檔案與紀錄
  fake-cli/fake-dialog.cjs 假的選擇資料夾視窗（zenity，Linux 用）
  support/                 每個測試的伺服器與它的假模型端點（relay.ts）、安裝假 CLI 並打包成一支腳本（fake-cli.ts）、UI 操作步驟（app.ts）、Harness Relay 自己的沙箱在這裡能不能運作（sandbox.ts）
  support/clis.ts          spec 眼中的各 CLI：eachCli()、兩個團隊（HALVES）、每個 CLI 在這裡以什麼權限執行、跳過的條件（needsBelowFull、needsRelaySandbox）、家目錄與 session
  support/clis/            給 spec 用的各 CLI 資料（<provider>.ts，和它的假 CLI 一起修改），all.ts 把它們集合起來
  fixtures.ts              relay 與 page fixture；global-setup.ts 建置 UI（以及它的開發版 build）並安裝假 CLI
  specs/                   測試本身
  live/                    實機測試：真正的 CLI 跑在真正的模型上（npm run test:e2e:live；CI 不執行）
playwright.config.ts       端對端測試的設定（E2E_BROWSERS）
playwright.live.config.ts  實機測試的設定
.gitattributes             所有文字檔都以 LF 換行取出，在 Windows 上也一樣
.github/workflows/ci.yml   CI：pull request 與推送到 main 時，在 Linux 與 Windows 上執行型別檢查、測試與建置；為 Linux 打包桌面 app 並檢查
.github/workflows/e2e.yml  在 Linux、macOS 與 Windows 上執行端對端測試
.github/workflows/pages.yml  把 site/ 發佈到 GitHub Pages
.github/ISSUE_TEMPLATE/    issue 表單（回報問題、功能建議；每份都有兩種語言）與旁邊的連結
.github/pull_request_template.md  pull request 說明要涵蓋的內容（兩種語言）
scripts/preview-site.ts    npm run site:preview：在本機以 Pages 的方式提供 site/
scripts/sandbox-check.ts   npx tsx scripts/sandbox-check.ts：在這台電腦上實際檢查 Harness Relay 自己的沙箱（不屬於 npm test）
scripts/app-icons.ts       npm run icons：畫出主畫面圖示，並寫出 web app manifest
scripts/release.ts         發佈版本的規則與說明的變更清單：npm run release:next、release:check、release:notes、發佈 workflow
.github/workflows/release.yml  發佈 workflow（手動執行）：檢查、五個安裝檔、一個 GitHub release（以及各一份給 app 更新用、放在專用 repository 的副本）
scripts/demo/              npm run demo：重錄示範影片，並更新影片、截圖與章節列
site/                      網站首頁（靜態 HTML，English + 繁體中文）；DESIGN-GUIDELINES.md 不會被發佈
docs/                      文件（English + 繁體中文）
data/                      執行時資料（relay.db），已列入 git ignore
desktop/                   桌面 app（Electron），是獨立的套件：npm install --prefix desktop
  README.zh-TW.md          寫給開發者的桌面 app 說明（英文版是 README.md）
  src/main.ts              app 本身：視窗、系統匣選單、啟動與停止伺服器、登入時自動啟動、分享到 tailnet、
                           更新，以及它自己的檢查（--smoke-test）；唯一會 import electron 的檔案
  src/supervisor.ts        啟動、監看與停止伺服器的程序（用假的程序測試）
  src/env.ts               登入 shell 的環境，以及伺服器的環境（資料夾、port、接受的主機名稱）
  src/tailscale.ts         找到 tailscale、讀取它的狀態與 serve 設定、tailscale serve --bg
  src/autostart.ts         Linux 上的登入時自動啟動（XDG autostart 項目）
  src/prefs.ts             app 自己的設定（desktop.json）
  src/i18n.ts              app 選單與對話框的兩種語言文字
  src/icons.ts             app 與系統匣圖示，建置時從標誌畫出
  src/manifest.ts          Electron 執行的 app 資料夾的 package.json
  src/lifecycle.ts         app 不需要 Electron 的判斷：再次打開、當機通知、對話的網址、登入項目、
                           視窗的連結去哪裡（guardContents）、頁面能使用什麼、tailnet 名稱
  src/profile.ts           視窗的瀏覽器資料夾（browser/），agent 讀不到；移除旁邊舊的登入資訊
  src/log.ts               伺服器的記錄檔，超過 5 MB 就重新開始（執行中也一樣）
  src/update.ts            更新到 GitHub 最新的版本（app 是候選版本時，候選版本也算）：查詢、下載與它的 SHA-256、等對話結束、換上新版
  src/traymenu.ts          開著的系統匣選單：就地修改項目，重新打開來顯示變化
  src/selftest.ts          app 透過 HTTP 需要伺服器做到的事，包括問假 CLI 一個問題（smoke.ts 與 app 的 --smoke-test）
  scripts/build.ts         把伺服器與 app 打包到 desktop/build/（發佈時以 RELAY_VERSION 為版本）
  scripts/smoke.ts         像 app 一樣執行打包好的伺服器並檢查（CI、發佈 workflow）
  scripts/dist.ts          npm run desktop:dist：以 ad hoc 簽章的安裝檔，並說出要雙擊什麼
  scripts/check-package.ts 檢查打包好的 app：fuses、resources，以及它自己的檢查（--smoke-test）
  scripts/packaged.ts      找出 electron-builder 放在安裝檔旁邊的打包好的 app
  entitlements.mac.plist   Mac app 的 entitlements（麥克風，用於語音輸入）
  macos/                   各語言的麥克風使用說明（InfoPlist.strings）
  scripts/parent-port.mjs  透過 Node 的 IPC 模擬 Electron 的 process.parentPort，給 smoke.ts 與測試使用
  electron-builder.yml     安裝檔（npm run desktop:dist），放在 desktop/release/
```

## 執行

```bash
npm install
npm run dev        # tsx watch（API :8789）+ vite（介面 :5173，把 /api/ 代理到 API）；印出 :5173 的登入連結
npm run typecheck
npm test
npm run test:e2e   # 在瀏覽器中以假 CLI 執行端對端測試（先執行一次 npm run test:e2e:install）
E2E_LIVE_OLLAMA=http://127.0.0.1:11434/v1 npm run test:e2e:live   # 同樣的測試，用真正的 CLI 與你自己的模型（見「實機測試」）
npm run build      # 介面 → dist/web
npm start          # 單一程序：API + 建置好的介面，port 8787；會印出登入連結
npm run login      # 另一個一次性登入連結（10 分鐘內有效）
npx tsx scripts/sandbox-check.ts   # 在這台電腦上實際執行 Harness Relay 自己的沙箱（macOS；Linux 需 bubblewrap、socat、ripgrep）
                                   # --only <文字>：只跑名稱包含它的檢查；--keep：保留它的暫存資料夾
                                   # 改過 relaySandbox.ts、relaySandboxHost.ts、sandboxProcs.ts 或轉接器的沙箱需求後執行

npm install --prefix desktop   # 只有桌面 app 需要，執行一次：Electron 與 electron-builder
npm run desktop                # 建置介面與桌面 app，並直接執行（不安裝）
npm run desktop:dist           # …再為目前的系統建置安裝檔，放在 desktop/release/
npm run desktop:dist -- --output <資料夾>   # …放到別處（`--` 讓選項交給腳本）
npx tsx desktop/scripts/check-package.ts    # 像檢查發佈一樣檢查打包好的 app
npm run desktop:typecheck
```

`npm run build` 會把頁面啟動時載入的函式庫放在各自的 chunk（`react`、`highlight`、`vendor`），讓瀏覽器在 app 更新後仍可沿用快取；Mermaid 仍是需要時才載入。啟動時載入的 chunk 超過 500 kB 時會發出警告（`vite.config.ts`）；Mermaid 延遲載入的 chunk 比這大，只在需要畫圖時才載入。

web app manifest，以及手機放到主畫面（或瀏覽器為安裝的 App 顯示）的圖示，都在 `src/web/public/`。它們由 `npm run icons`（`scripts/app-icons.ts`）畫出，用的是跟 favicon 和 `Logo.tsx` 相同的三個圓，不需要影像處理函式庫；改了標誌、圖示尺寸或 manifest 之後，請重新執行並 commit 它寫出的檔案。

`npm run dev` 會在每次檔案變更時重啟伺服器。重啟會中止正在執行的 agent 回合（訊息會標為已中斷），所以長回合執行中請避免修改伺服器檔案。

### 環境變數

| 變數 | 預設值 | 用途 |
| --- | --- | --- |
| `PORT` | `8787`（`npm run dev` 為 `8789`） | API port（Vite 代理也會使用）。`npm run dev` 有自己的 port，所以能和使用 8787 的桌面 app，或另一個 checkout 的 `npm start` 同時執行（`src/server/ports.ts`）；和同一個 checkout 的 `npm start` 一起時會拒絕啟動，因為兩者會共用它的資料夾 |
| `HOST` | `127.0.0.1` | 綁定位址 |
| `RELAY_DATA_DIR` | `./data` | `relay.db` 的位置。執行中的伺服器會鎖住它（`server.lock`）：用同一個資料夾的第二個伺服器會拒絕啟動。Harness Relay 的沙箱把它的 socket 放在這裡（`srt/`），所以開源 agent 要在完全存取以外執行，它的路徑在 macOS 上最多 70 個位元組，Linux 上最多 61 個（UTF-8：中文字每個佔 3 個） |
| `RELAY_DEFAULT_CWD` | 程序的 cwd | 初始預設工作目錄（在設定頁修改前） |
| `RELAY_ALLOWED_HOSTS` | — | Host/Origin 檢查額外允許的主機名稱，以逗號分隔，例如這台電腦在 Tailscale 上的名稱（見[用手機連線](remote-access.zh-TW.md)） |
| `RELAY_KEYRING` | — | 設為 `off` 時 API key 存在資料庫而不是作業系統的金鑰儲存區（例如用完即丟的資料目錄） |
| `RELAY_WEB_DIR` | `./dist/web` | 建置好的介面放在哪裡（桌面 app 會指向它自己的那一份） |
| `RELAY_KEYRING_SERVICE` | `harness-relay` | API key 存在金鑰儲存區時使用的名稱（桌面 app 自己的是 `harness-relay-desktop`） |
| `RELAY_APP_BROWSER_DIR` | — | 由桌面 app 設定：它的視窗的瀏覽器資料夾（cookie、localStorage：它的登入資訊），權限低於完全存取的 agent 讀不到（`protectedReads()`） |
| `RELAY_UPDATES` | — | 由桌面 app 讀取，不是伺服器：設為 `off` 時，app 不會向 GitHub 查詢新版本 |
| `RELAY_MAX_ACCOUNTS` | `10` | 每個 CLI 的帳號數，含預設帳號（1–100） |
| `RELAY_MAX_TEAM_AGENTS` | `8` | 一個隊伍最多幾位成員，不論是自己設定或由首席 agent 修改（1–32）。首席 agent 自己組新隊伍時最多 5 位，這個值更小時則以它為準 |
| `RELAY_TURN_TIMEOUT_MIN` | `45` | 每個 agent 回合的安全逾時（分鐘），等待使用者回答的時間也算在內（1–1440） |
| `RELAY_VOICE_MODEL_BASE_URL` | Hugging Face，固定在一個 commit | 語音輸入下載模型的 http(s) 資料夾（`<url>/ggml-<model>.bin`），例如鏡像站。每個檔案仍會比對固定的大小與 SHA-256 |
| `RELAY_VOICE_ENGINE_BASE_URL` | GitHub 上 whisper.cpp 的 release | 語音輸入在 Linux 與 Windows 上下載引擎的 http(s) 資料夾（`<url>/<壓縮檔>`，檔名見 `ENGINE_BUILDS`），同樣會檢查 |
| `RELAY_VOICE_DIR` | `<資料資料夾>/voice` | 語音輸入存放模型與引擎的地方：絕對路徑，或以 `~/` 開頭的路徑。不能在暫存資料夾裡（伺服器會拒絕啟動）；工作目錄包含它或在它裡面時，可編輯模式會被拒絕，因為那裡的引擎在沙箱外執行（預設的資料夾也一樣）。引擎提供靜態檔案的空資料夾仍放在資料資料夾裡（`voice-public`）。在這裡移除語音輸入時，會依檔名刪掉 Harness Relay 下載的檔案（模型、這個版本的引擎），以及它建立、已經變空的資料夾；其他的都不會動 |

伺服器會把自己的環境變數傳給各 CLI，但移除 Claude Code 的巢狀執行變數，並加上已保存的 API key（`SettingsStore.env()`）。Cursor 帶著金鑰執行、或以預設帳號以外的帳號執行時，還會拿到 `AGENT_CLI_CREDENTIAL_STORE=memory`（`CURSOR_SHARED_SIGN_IN`：它登入用的東西只留在那次執行，不會蓋掉電腦使用者唯一的 Cursor 登入）；每次 Cursor 執行也會拿到 `CURSOR_CONFIG_DIR`（它私用的設定資料夾）與 `NO_OPEN_BROWSER=1`。Antigravity 沒有指定家目錄的變數，所以帳號的家目錄用 Harness Relay 自己的變數（`HARNESS_RELAY_ANTIGRAVITY_HOME`，它的 `.gemini` 所在的資料夾，絕不傳給 agy）：`agy acp` 拿到 `--gemini-dir <家目錄>/.gemini`，只向它詢問事情的指令（`agy models`、`agy -p /skills`…、`agy acp --login`）則把那個資料夾當成 `HOME`（Windows 上是 `USERPROFILE`），並設定 `SSH_CONNECTION`，讓 agy 印出登入連結，而不是開瀏覽器（`antigravityProbeEnv()`）；agent 自己執行的指令仍用使用者的 `HOME`。預設帳號以外的 Antigravity 帳號拿不到伺服器環境變數裡的 `GEMINI_API_KEY` 與 `AGY_ADC_AUTH`（`CREDENTIAL_ENV`），只有它自己的金鑰，以及 `HARNESS_RELAY_ANTIGRAVITY_KEY_ONLY=1`（這個也不會傳給 agy），讓它的執行與詢問告訴 agy 使用這把金鑰（`modelProvider: "gemini"`），絕不退回預設帳號的 Google 登入。開源 agent 拿到的環境變數會去掉伺服器繼承來的模型金鑰與 base URL，以及 Cursor 的 `CURSOR_API_KEY` 與 `CURSOR_AUTH_TOKEN`、Antigravity 的 `AGY_ADC_AUTH`（`INHERITED_BACKEND_VARS`），改加上只屬於這次執行的模型來源的那一把金鑰與它的家目錄（`HARNESS_RELAY_AGENT_HOME`）；完全存取以外，它只在 Harness Relay 的沙箱裡拿到這些，沙箱會設定 proxy 變數與它自己的 `TMPDIR`。

### 桌面 app

`desktop/` 是桌面 app（[使用說明](user-guide.zh-TW.md#桌面-app)；它的檔案、指令與檢查的總覽見 [`desktop/README.zh-TW.md`](../desktop/README.zh-TW.md)）。它是獨立的套件，有自己的 `package.json` 與 lockfile，所以在根目錄執行 `npm install` 時，不會替使用 `npm start` 的人下載 Electron（約 100 MB）。用 `npm install --prefix desktop` 安裝一次即可；它使用根目錄的 `tsx` 與 `typescript`，所以請先安裝根目錄。它的程式碼是一般的 TypeScript，由 `npm run desktop:typecheck` 檢查。不依賴 Electron 的部分（`env.ts`、`supervisor.ts`、`tailscale.ts`、`autostart.ts`、`prefs.ts`、`profile.ts`、`log.ts`、`update.ts`、`traymenu.ts`、`selftest.ts`、`i18n.ts`、`icons.ts`、`manifest.ts`、`lifecycle.ts`，以及 `scripts/packaged.ts`）跟其他程式碼一樣，由根目錄的 `test/` 測試；只有 `main.ts` 會 import `electron`。

運作方式：

- **伺服器**就是 `src/server/index.ts`，由 esbuild 打包成單一 ES module（`desktop/build/server/server.mjs`）。它在 Electron 的 utility process 裡執行，用的是 Electron 自帶的 Node（Electron 45：Node 24，有 `node:sqlite`），所以 app 不需要安裝 Node.js（Harness Relay 自己的沙箱例外，見下方）。建置好的介面（`server/web`，以 `RELAY_WEB_DIR` 傳入）與 keyring 模組（`server/node_modules/@napi-rs/`；它是原生程式碼，所以是複製過去而不是打包進去）放在旁邊。安裝好的 app 裡，它們在 app 的 resources 中（macOS 是 `Resources/server`），不在 app 的封存檔裡，所以 `protect.ts` 的 `RELAY_ROOT` 就是 app 本身（macOS 是 `Harness Relay.app/Contents`，Windows 是安裝資料夾）。
- **訊息**（`src/shared/types.ts` 的 `DesktopToServer` 與 `ServerToDesktop`，透過 `process.parentPort`；見 `src/server/parent.ts`）。伺服器會告訴 app 它已開始接收連線，或為什麼無法接收。App 每次打開對話時都會要一個登入連結（新的一次性代碼，一分鐘內有效：`CODE_TTL_MS.desktop`），會詢問有幾個對話有 agent 在工作（`busy`：`Orchestrator.busy()`，計算執行中與正在準備的執行、正在修改對話（例如套用平行模式的回覆）、首席 agent 正在修改隊伍或把對話分組、以及正在建立的分支；更新會等到沒有為止），也會要求它關閉，這會執行跟 SIGTERM 一樣的關閉流程：先停止 agent，並結束它們的 process group。Windows 沒有 signal 可送，所以在 Windows 上就是這樣停止的。由 app 啟動的伺服器不會印出登入代碼：它的輸出會寫進 app 的記錄檔，而 agent 可能讀得到。它也會讓登入頁知道這件事（`createApp({ desktopApp })`：`GET /api/auth` 會加上 `desktop: true`，401 的訊息也會不同），登入頁就會指向 app 的選單，而不是終端機：在 app 的視窗裡指向 **打開 Harness Relay**（Electron 會在 user agent 寫出自己），在瀏覽器裡指向 **在瀏覽器打開**（`src/web/signin.ts`）。用 `npm start` 或 `npm run dev` 啟動時，伺服器沒有 parent，這些都不會發生。
- **環境變數。** 在 macOS 與 Linux 上，app 在啟動伺服器前會執行使用者的登入 shell（`$SHELL -i -l -c`，在兩個標記之間印出 `/usr/bin/env -0`），啟動時一次，**重新啟動伺服器…** 與 **啟動伺服器** 時再一次，把這個環境交給伺服器，就像在終端機裡一樣。在 Windows 上，app 啟動時用它自己的環境；重新啟動或啟動伺服器時，會用 PowerShell 重新讀取 PATH 與使用者變數（`windowsEnv()`、`mergeWindowsEnv()`）：PATH 照 Windows 為新程式組成的方式（系統的，再接使用者的），後面接 app 自己原本多出的項目；系統的其他變數不動（有些是工作階段會取代的預設值，例如 `USERNAME`）。如果失敗，則改為把常見的安裝資料夾加到 PATH（`withCommonPaths`）。接著 `serverEnv()` 會設定 `RELAY_DATA_DIR`（app 的資料夾，除非使用者自己設定了）、`RELAY_KEYRING_SERVICE`（使用 app 自己的資料夾時為 `harness-relay-desktop`）、`RELAY_DEFAULT_CWD`（家目錄，除非已設定）、`RELAY_WEB_DIR`、`RELAY_APP_BROWSER_DIR`（視窗的瀏覽器資料夾，見下方）、`PORT`（取自 `desktop.json`）、`HOST=127.0.0.1`，並把這台電腦的 tailnet 名稱加進 `RELAY_ALLOWED_HOSTS`：用 Tailscale 回報的名稱（它還沒連線但已知道名稱時也一樣），否則用上次看到的（`desktop.json` 的 `tailnetName`），所以在 Tailscale 連線前就於登入時啟動，手機也照樣能連。`ELECTRON_*` 變數會被移除。
- **Supervisor**（`supervisor.ts`）會先確認 port 沒被佔用，再啟動伺服器，等它開始接收連線（最多三分鐘：更新後 macOS 可能會先詢問鑰匙圈），並保留它最後的輸出，供錯誤對話框顯示。它向伺服器要登入連結，也詢問有幾個對話有 agent 在工作（各自依序；5 秒內沒回應就沒有答案）。停止時，它會要求伺服器關閉，如果 20 秒內還沒結束就強制結束。伺服器還在啟動時就要停止，則會立刻結束它：它還沒開始接收連線，所以沒有執行任何 agent，macOS 詢問鑰匙圈時結束 app 也不用等三分鐘。每個伺服器程序有自己的詢問佇列，所以很晚才結束的舊程序不會取消下一個伺服器的請求。伺服器執行之後、沒人要求的結束會被當成當機回報。
- **結束 app**（從選單、收到 SIGINT 或 SIGTERM，或 macOS 與 Linux 關機時）會等伺服器停止後才結束。
- **視窗**顯示對話：一個 `BrowserWindow`（sandbox、context isolation、沒有 Node），載入向伺服器拿的登入連結，所以一打開就已登入（它本身就是一個獨立的瀏覽器）。`guardContents()`（`lifecycle.ts`）讓它的頁面只停在伺服器上，新視窗、導覽與重新導向都一樣：`linkAction()` 把其他網頁與郵件交給預設瀏覽器，伺服器自己的頁面（需要視窗登入狀態的檔案與附件）在 app 的視窗裡打開，其他的（`file:`、`javascript:`）一律不開。`permissionAllowed()` 只讓伺服器的頁面使用麥克風（只有聲音，用於語音輸入）、寫入剪貼簿與全螢幕（影片本身的按鈕），其他都不允許；Electron 沒有指明種類的媒體權限檢查，當成麥克風處理（`permissionChecked()`）。視窗的瀏覽器資料（cookie、localStorage：它的登入資訊）放在使用者資料夾的 `browser/`（`profile.ts`，Electron 的 `sessionData`），以 `RELAY_APP_BROWSER_DIR` 告訴伺服器，`protectedReads()` 會把它加進權限低於完全存取的 agent 不能讀的路徑；使用者資料夾的其他部分放著資料夾（平行模式的 worktree 在裡面），所以無法整個擋住。舊版建置放在使用者資料夾本身的登入資訊，會在啟動時刪除。視窗顯示登入頁（有 `data-signin`）時選 **打開 Harness Relay**，會用新的連結重新載入。下載使用 Electron 的儲存對話框。視窗大小記在 `desktop.json`。關掉視窗後 app 會留在系統匣（有處理 `window-all-closed`）；在 macOS 上，視窗開著時才顯示 Dock 圖示（app 是 `LSUIElement`）。App 選單（編輯、顯示方式、視窗，使用者的語言）提供一般的快捷鍵，包括拷貝與貼上（macOS 只會透過選單傳遞它們）；在 Windows 與 Linux 上按 Alt 顯示。系統匣選單的 **在瀏覽器打開** 則在預設瀏覽器打開同樣的對話。
- **系統匣選單**在每次狀態改變時重建，項目永遠相同（依 id），只是顯示或隱藏。在 macOS 與 Windows 上，開著的選單會一直顯示它打開時的內容：修改項目或設定新的選單，在它再次打開前畫面都不會改變（在 macOS 上用 Electron 45 試過）。所以選單開著時（`menu-will-show` 到 `menu-will-close`，以及關閉後的一小段時間，因為點選項目的事件在選單關閉後才到），會就地修改它的項目（`traymenu.ts` 的 `patchMenu()`），不設定新的選單；當顯示的內容改變時（例如更新的進度），`LiveMenu` 會把它關掉再打開（`closeContextMenu()`、`popUpContextMenu()`；在 Windows 上打開在使用者原本打開的位置），最多每秒一次。關掉 50 毫秒後才再打開（`REOPEN_DELAY_MS`），在關閉中的選單自己的迴圈之外：如果在它裡面立刻打開，在 macOS 上每個選單都會在前一個裡面執行，幾次之後 app 結束要好幾秒，甚至結束不了。舊選單的關閉事件可能在新選單打開之前或之後才到，兩種都會處理。Linux 的選單（D-Bus）照舊每次設定新的。再次打開 app（Windows 與 Linux 是 `second-instance`，macOS 是 `activate`，或按 Dock 圖示）會顯示視窗（`reopenAction()`）。登入時自動啟動在 macOS 與 Windows 上用 Electron 的 login item，在 Linux 上用 XDG autostart 項目（`autostart.ts`），並帶上 `--hidden`（macOS 則改看 `wasOpenedAtLogin`），所以不會打開視窗。在 Linux 上，已開啟的 autostart 項目會在每次啟動時重寫，讓它啟動 app 目前執行的那個 AppImage。
- **分享到 tailnet** 會執行 `tailscale serve --bg`，用 HTTPS 443，除非那個 port 已被其他服務或 Funnel 使用（那就用 8443 或 10000：`sharePlan()`、`freeHttpsPort()`；把 Funnel 的 port 只分享給 tailnet 會關掉 Funnel）。讀不到 `tailscale serve status --json` 時，什麼都不分享。
- **記錄檔**（`log.ts`）是伺服器的輸出：超過 5 MB 就重新開始，前一份保留為 `.old`，啟動時與伺服器執行中都一樣。無法寫入的記錄檔會被安靜地放棄，絕不成為未處理的錯誤。
- **更新**（`update.ts`）。第一次啟動約 30 秒後，之後每小時（`CHECK_EVERY_MS`；聊天介面要求時最多每 5 分鐘一次，`mayAskGitHub()`），打包好的 app（除非 `RELAY_UPDATES=off`）是候選版本或自己建置的版本時會查詢 `GET /repos/…/releases?per_page=20`（`releases/latest` 會略過 pre-release），是正式版本時查詢 `GET /repos/…/releases/latest`（`LATEST_RELEASE_API`：不論之後出了多少候選版本都找得到）；`checkNow()` 決定這次要不要查詢，查詢 30 秒沒回應就放棄（`CHECK_TIMEOUT_MS`）。`parseRelease()` 接受不是草稿、tag 是我們版本的發佈，候選版本也算，各系統的安裝檔依 `site/assets/downloads.js` 的結尾（`INSTALLERS`、`isInstallerUrl()`）找出，從更新用的副本下載（`updateCopyUrl()`：副檔名前加 `-update`，`UPDATE_INSTALLERS`，以相同 tag 放在 repository `UPDATES_REPO`，讓 GitHub 的下載次數分得出已安裝 app 的更新與新安裝，release 頁面也只列出安裝檔；檔名仍照安裝檔的，AppImage 會用這個名字；安裝檔本身是它的 `fallback`）、單純的檔名與 GitHub 為安裝檔公布的 `digest`（SHA-256，副本是同一個檔案）找出；`newestRelease()` 依版本（`compareSemver()`）取最新的那一個，而不是依發佈時間；app 是正式版本時（`takesCandidates()`：semver 沒有 `-rc` 或 `-dev`）不取候選版本。它比較新（用 `compareSemver()` 對照 `app.getVersion()`）並有這個系統的安裝檔時，系統匣選單就會提供它，聊天介面也會：每次狀態改變，以及伺服器開始聆聽時，`main.ts` 會傳給伺服器一則 `update` 訊息（`DesktopUpdate`：較新的版本、進行中的更新、上次檢查；`Supervisor.tell()`），伺服器保存它（`src/server/updates.ts` 的 `Updates`）供 `GET /api/update` 使用，並把聊天介面的要求轉回去（帶編號的 `update-check`、`update-install`，supervisor 以 `request` 事件發出）；app 會在沒有檢查進行中時，用它告訴伺服器的第一個狀態依編號回答每次檢查（`answered`、`CheckAnswers`），所以已經在路上的狀態不會讓新的檢查提早結束。`installPlan()` 決定這一份 app 怎麼更新。`download()` 把安裝檔寫進 `.part`（GitHub 對副本回答 404 時改從它的 `fallback` 下載：副本搬家之前發佈的 release，或副本的 repository 不見了），並檢查它的 SHA-256；一分鐘都沒收到資料就放棄（`DOWNLOAD_STALL_MS`），以免斷掉的連線卡住更新與之後的每次檢查。它分段下載，同時最多用六條連線（`DOWNLOAD_CONNECTIONS`），因為在某些網路上，GitHub 的 CDN 每條連線只送得那麼快（從台灣約 200 KB/s），好幾條一起就快好幾倍：先問一次 GitHub 的網址轉到哪裡、不跟過去（`Locate`；`main.ts` 用 `redirect: 'manual'` 的 `net.request`，因為 `net.fetch` 不留下轉址的任何資訊），讓 GitHub 只算一次下載，再用 `Range` 從它給的簽名網址（最多一小時內有效）下載各段。`main.ts` 給每條連線一個自己的、只在記憶體裡的 session（`updateConnections()`）：Chromium 會把同一個 session 對同一台主機的請求都放進同一條 HTTP/2 連線，那樣不會比一個請求快。做完自己那一段的連線，會接手剩下最多的那一段的後半，只要那一段還剩至少兩倍的 `MIN_PART_BYTES`（1 MB）；失敗或一分鐘沒收到資料的那一段，會從停下的地方再要一次，簽名網址過期（403）時改用新的網址（不論幾段遇到，都只重新查一次），總共最多失敗三次（`PART_FAILURES`）。不到 2 MB 的檔案從 GitHub 的網址一次下載；對一段請求卻送來整個檔案的伺服器，也改成一次下載（從 GitHub 轉到的地方）。`updateSystem()` 決定用哪個安裝檔：macOS 是 Apple Silicon 版（Intel Mac 沒有），Windows 與 Linux 是正在執行的 app 所屬處理器的（`process.arch`：在 Windows on Arm 上透過模擬執行的 x64 app 維持 x64）。新版下載並檢查完後，`whenIdle()` 會等到伺服器說沒有對話有 agent 在工作（每 2 秒用 `Supervisor.busy()` 詢問；沒回應的會再問），選單這時顯示「更新已就緒，等回答結束後切換」；或等到使用者選 **立即切換到新版…**（會先跳出對話框）。`busyWithoutAsking()` 決定不用詢問就知道的情況：自己停掉的伺服器（當機）沒有在執行任何東西；正在啟動或停止的（例如從選單重新啟動）還沒有答案；app 結束時（包括系統關機）永遠沒有答案，所以結束 app 絕不會切換。在那之前，正在執行的 app 完全不會被改動：等待結束時如果 app 正在結束，就什麼都不放到位、保留目前的版本，下次啟動時再刪掉下載的檔案。在 macOS 上，`stageMacApp()` 在等待之前掛載 `.dmg`（`hdiutil`），把 app 複製到正在執行的 app 旁邊（`ditto`）並檢查（`codesign --verify --deep --strict`、bundle id 與版本）；等待之後，`swapMacApp()` 在伺服器還在執行時就把兩者改名對調，所以對調失敗時什麼都不會改變；用 `spawnDetached()`（`src/server/process.ts`）啟動的 shell 會等 app 結束，再 `open` 新的 app。它的腳本是固定的文字：app 的 pid 與新版本的路徑經由它的環境變數傳入（`HARNESS_RELAY_RELAUNCH_PID`、`HARNESS_RELAY_RELAUNCH_TARGET`，新版本啟動前會移除），絕不放進腳本文字或參數。在 Windows 上，app 結束後以 `--updated /S --force-run` 執行安裝檔。在 Linux 上，新的 AppImage 隱藏下載到正在執行的那一個旁邊（`appImageDownload()`；等待時結束 app 而留下的，會在啟動時刪除，`removeAppImageLeftovers()`），等待之後才被放到位（`appImageTarget()`、`placeAppImage()`），autostart 項目跟著改，app 結束後啟動它。無法自己更新的那一份（`not-packaged`、`no-installer`、`no-checksum`、`read-only`、`not-appimage`）會改為提供該版本的頁面。
- **它自己的檢查。** 用 `--smoke-test[=<報告>]` 啟動時，app 會檢查自己並以 0 或 1 結束；它不取得單一實例鎖，並使用暫時的使用者資料夾，所以能在使用中的 Harness Relay 旁邊執行：keyring 模組能載入、伺服器在 utility process 裡啟動（port 0、`RELAY_KEYRING=off`）並通過 `selftest.ts` 的檢查、說沒有對話有 agent 在工作、一個隱藏的 sandbox 視窗用登入連結登入並顯示對話，最後伺服器停止。加上 `--smoke-test-clis=<資料夾>` 時，那個資料夾裡端對端測試的假 CLI 會先回答一個問題（`checkTurn()`，見下方）：它們排在伺服器 PATH 的最前面，家目錄、CLI 的家目錄與工作目錄都是暫時資料夾裡自己的（`withFakeClis()`），所以絕不會啟動或讀取使用者自己的 CLI。`desktop/scripts/check-package.ts` 會執行它，而且一定會給假 CLI。

建置：`npm run desktop` 與 `npm run desktop:dist` 會先建置介面（`npm run build`），再執行 `desktop/scripts/build.ts`，寫出 `desktop/build/`：

- `app/` 是 Electron 執行的內容：`main.cjs`、它的 `package.json`（來自 `src/manifest.ts`；`productName` 讓使用者資料夾叫做 `Harness Relay`）與系統匣圖示，以及儲存庫裡的 `LICENSE`：那個 `package.json` 的 `license` 指的就是它的條款，而每一份副本都必須附上它（`electron-builder.yml` 也會把它放進 app 的 resources，讓人能打開來看）。
- `server/` 是伺服器、介面與 keyring 模組，以及在伺服器之外執行的東西：Harness Relay 自己沙箱的 host（`relaySandboxHost.mjs`，由 `src/server/relaySandboxHost.ts` 打包，沙箱 runtime 不打包進去）、Pi 的 gate 擴充功能（`piGate.js`，Pi 依路徑載入它），以及放在 `node_modules/` 的沙箱 runtime 套件（`@anthropic-ai/sandbox-runtime` 與它需要的套件；它在 Linux 上的 seccomp 輔助程式是原生程式）。
- `resources/icon.png` 是 app 圖示，給 electron-builder 使用。

`RELAY_VERSION`（由[發佈 workflow](#發佈) 設定）會把 app 建置成某個發佈的版本：`package.json` 裡是它的 semver（見 `scripts/release.ts` 的 `semverOf()`），選單、記錄檔與回報問題的信裡則是版本本身（伺服器的 bundle 也以 `__RELAY_VERSION__` 拿到它，由 `src/server/about.ts` 讀取）。沒有設定時，app 是台灣當天的建置，加上 `-dev` 與 commit（`devVersion()`）：`2026-11-10-dev (30f3d4f)`，semver 是 `2026.1110.0-dev`，排在當天所有正式版本與候選版本之前，所以當天或之後的版本都會被提供為更新。

`npm run desktop` 接著用 `build/app` 啟動 Electron。`npm run desktop:dist` 則執行 `desktop/scripts/dist.ts`：它執行 electron-builder（`desktop/electron-builder.yml`），最後說出要雙擊的安裝檔與 app：所在系統的安裝檔（`.dmg`、NSIS `.exe`、`.AppImage`）在 `desktop/release/`，app 本身就在旁邊（例如 `desktop/release/mac-arm64/Harness Relay.app`）。`npm run desktop:dist -- --output <資料夾>` 則放到別處，可以在不取代正在使用的 app 的情況下試建置。有 Harness Relay 正從輸出資料夾執行時，它會拒絕開始（macOS 與 Linux 用 `ps` 判斷；在 Windows 上，執行中的 app 本來就會鎖住它的檔案），最後也會在有其他地方的 Harness Relay 正在執行時提醒：這時打開新的建置，只會把正在執行的那一個帶到前面。還沒有設定為其他系統或處理器建置：請在各個系統上分別建置（發佈 workflow 在 GitHub 的 Arm runner 上建置 Arm64 安裝檔）。

`npx tsx desktop/scripts/smoke.ts` 會像 app 一樣執行打包好的伺服器，用一般的 Node 代替 Electron（`desktop/scripts/parent-port.mjs` 透過 Node 的 IPC 提供 `process.parentPort`）：keyring 模組必須能從伺服器旁邊載入，沙箱的 host 與 Pi 的 gate 必須在它旁邊、host 必須找得到沙箱 runtime，伺服器必須只聽 127.0.0.1、提供介面、瀏覽器登入前拒絕 API、給出代碼能用的登入連結、讓 claude、codex 與 grok 組成的團隊回答一個問題、不印出代碼、說沒有對話有 agent 在工作，並在被要求關閉時以代碼 0 結束。這個團隊是端對端測試的假 CLI（`e2e/fake-cli/`，由 `e2e/support/fake-cli.ts` 的 `installFakeClis()` 建置：macOS 與 Linux 上是指令碼，Windows 上是 Node 單一執行檔）：`selftest.ts` 的 `checkTurn()` 開一個三者的唯讀圓桌對話，送出一個問題並等這輪執行結束，每一個的回覆都必須完成並複述這個問題，這表示伺服器依名稱找到了每個 CLI、說了它的協定（stream-json、`codex app-server`、ACP），並把回覆串流進對話。它絕不會執行真正的 CLI。開發者自己的 `RELAY_*` 與 `E2E_*` 變數不會進入伺服器的環境（`selftest.ts` 的 `withoutOwnSettings()`，app 自己的 `--smoke-test` 與 `check-package.ts` 也用它），`withFakeClis()` 也不帶使用者的憑證（API key 與 token），所以萬一找到的是真正的 CLI，它也沒有憑證可用。CI 在建置桌面 app 後執行它，發佈 workflow 在每個系統上執行它，`test/parent.test.ts` 則對 `src/server/index.ts` 做同樣的檢查。

`npx tsx desktop/scripts/check-package.ts [--dir <資料夾>]` 會檢查 electron-builder 放在安裝檔旁邊的打包好的 app（預設是 `desktop/release/`：`mac-universal/` 或 `mac-arm64/`、`win-unpacked/` 或 `win-arm64-unpacked/`、`linux-unpacked/` 或 `linux-arm64-unpacked/`）：fuses 是否照 `electron-builder.yml` 設定（用 `@electron/fuses` 讀回來）、resources 裡有沒有伺服器、介面與 keyring 模組（通用版 Mac app 要有兩種處理器的原生部分）、沙箱的 host、Pi 的 gate 與沙箱 runtime（Linux 上它的 seccomp 輔助程式要能執行）、resources 與封存檔（`app.asar`，用 `@electron/asar` 讀取）裡的 `LICENSE` 是否和儲存庫裡的一樣，以及 app 自己的 `--smoke-test`，並用 `--smoke-test-clis` 給它假 CLI（像 `smoke.ts` 一樣先建置），所以打包好的 app 也會讓它的 agent 回答一個問題。app 拿到的是這個指令碼的環境，但不含 `RELAY_*` 與 `E2E_*`。在 Linux 上它需要顯示器（`xvfb-run`），並以 `--no-sandbox` 執行 app。發佈 workflow 在每個系統建置安裝檔後執行它，CI 則對 Linux 與 Windows 的打包結果（`electron-builder --linux dir`、`--win dir`）執行。

幾件要知道的事：

- **electron-builder 會略過複製的資料夾最上層的 `node_modules`**，不管 filter 怎麼寫。所以 keyring 模組在 `extraResources` 裡是單獨的一項。
- **Fuses。** 打包好的 app 會關閉 Electron 的 run-as-Node 模式，以及 `NODE_OPTIONS` 與 `--inspect`（`electronFuses`）。否則任何程式都能以這個 app 的身分執行程式碼，使用 macOS 給它的隱私權限。這也是讀取 shell 環境時用 `env -0`、而不是把 app 當成 Node 執行的原因；也因此 Harness Relay 自己沙箱的 host（每次開源 agent 在沙箱裡執行一輪時跑的 Node 程式）在 app 裡要用登入 shell 的 `PATH` 上找到的 Node.js 22.12 以上執行（`relaySandbox.ts` 的 `hostNode()`）：找不到時，開源 agent 在完全存取以外會被拒絕，並附上說明（`relaySandboxNoNode`），完全存取仍可使用。它只從自己的封存檔載入程式碼，並檢查封存檔（`enableEmbeddedAsarIntegrityValidation`，macOS 與 Windows），`file:` 頁面也不會得到額外權限（`grantFileProtocolExtraPrivileges: false`；視窗只顯示伺服器的頁面）。Cookie 加密維持關閉：視窗的登入資訊放在權限低於完全存取的 agent 讀不到的資料夾，它的 key 在 localStorage，本來就不會被加密，而且 ad hoc 簽章的 app 每次更新後 macOS 都會詢問鑰匙圈。`check-package.ts` 會把這些全部讀回來檢查。
- **簽章。** 在 macOS 上，app 一律以 ad hoc 方式簽章（`mac.identity: '-'`，`dist.ts` 也會關掉 electron-builder 對鑰匙圈的搜尋），在每台電腦上都一樣：絕不使用 electron-builder 原本會在鑰匙圈裡找到的憑證。它的 entitlements（`desktop/entitlements.mac.plist`）是 electron-builder 的預設值加上麥克風，否則 hardened runtime 會拒絕；Info.plist 說明為什麼要詢問（`NSMicrophoneUsageDescription`，翻譯在 `desktop/macos/*.lproj/InfoPlist.strings`）。Apple Silicon 不執行沒有簽章的程式碼，而 fuses 會在 Electron 執行檔連結之後修改它：沒有簽章的建置一啟動就會被結束（結束代碼 137）。Gatekeeper 不信任 ad hoc 簽章，所以下載的 app 需要按 **強制打開**，而且每次更新後 macOS 都會再詢問鑰匙圈。以 Developer ID 簽章與公證，以及 Windows 的簽章，都還沒設定。更新是 app 自己做的（`update.ts`），不是 electron-updater，依靠的是透過 HTTPS 取得的 GitHub 檢查碼。
- **發佈的 Mac app 只支援 Apple Silicon**（`--mac dmg --arm64`，macOS runner 自己的處理器）：Intel Mac 沒有 app，請在那裡從原始碼執行 Harness Relay。網站把 Mac 當成 Apple Silicon，除非 Chromium 的提示說是 Intel（Safari 與 Firefox 在每台 Mac 上都說是「Intel」）；在 Intel Mac 上 app 不會提供更新。2026-11-11 與它的候選版本的 Mac app 是通用版，找的是 `-mac-universal.dmg`，所以找不到之後的版本。`npm run desktop:dist` 則是為執行它的那台 Mac 建置。
- **Windows 與 Linux 每種處理器各有一個安裝檔**：x64（`win-x64.exe`、`linux-x86_64.AppImage`）與 Arm64（`win-arm64.exe`、`linux-arm64.AppImage`）。Arm64 的在 GitHub 的 Arm runner 上建置（`windows-11-arm`、`ubuntu-24.04-arm`，公開 repository 免費），不是交叉建置，這樣 npm 才會安裝 keyring 模組的 Arm 原生部分，打包好的 app 自己的檢查也能在那裡執行。Windows Arm64 的工作在它自己的 Dev Drive 上建置（checkout 的副本、npm 的快取與暫存資料夾）：那個 runner 只有一個磁碟，寫入小檔案比 Dev Drive 慢約 14 倍，讓 `npm ci` 在那裡要兩分鐘。
- **Linux 的 AppImage** 在限制非特權 user namespace 的系統（Ubuntu 24.04）上可能需要 `--no-sandbox`。electron-builder 的 `executableArgs` 只會寫進 `.desktop` 檔，直接啟動的 AppImage 拿不到；app 若是帶著這個參數啟動，會把它也寫進 autostart 項目。
- **要跟自己的資料分開試用**，就用獨立的使用者資料夾執行建置好的 app，並且不打開它的視窗；如果 8787 已經有 Harness Relay 在執行，在那個資料夾放一個設定其他 port 的 `desktop.json`：`desktop/node_modules/.bin/electron desktop/build/app --user-data-dir="$HOME/relay-desktop-try" --hidden`（不要放在 `/tmp` 底下：資料夾在暫存資料夾時伺服器會警告，因為沙箱讓 agent 能寫入那裡）。伺服器的記錄檔在 macOS 是 `~/Library/Logs/Harness Relay/server.log`，在 Windows 與 Linux 是使用者資料夾裡的 `logs/server.log`。

## 請求流程

1. 前端送出 `POST /api/conversations/:id/messages` → `Orchestrator.send()` 準備工作區（可編輯 / 完全存取時：必要時 `git init`，非平行模式再取得目錄鎖），加入使用者訊息，並在背景啟動 `execute()`（請求立即回傳 `202`）。
2. 在自動組隊的對話中，為新問題開始的執行只會讓首席 agent 設計團隊（`designTeam()`，見[架構 → 自動組隊](architecture.zh-TW.md#自動組隊)）；設計確認後，團隊在另一次執行中回答。其他情況下，`execute()` 依模式決定發言者（平行模式會先建立每個 agent 的 worktree），對每位呼叫 `turn()`。
3. `turn()` 建立串流中的 agent 訊息，記下起始狀態（worktree 的 `HEAD` 或一份快照），計算該 agent 還沒看過的訊息，組出 prompt（`prompt.ts`），並在正確的目錄呼叫 `runners[provider].run()`；除非對話設定為自動拒絕，否則會一併傳入 `requestApproval`。
4. 轉接器啟動 CLI（`process.ts`；開源 agent 透過 `startOpenProcess()`，完全存取以外在 Harness Relay 的沙箱中），逐行解析 stdout 並送出 `AgentEvent`。
5. `turn()` 把事件套用到訊息上（文字、思考、計畫、工具列與輸出），透過 `Hub` 送出 SSE 事件，並透過 `Store` 保存。核准請求會新增一個 approval part，並等待 `POST …/approvals/:approvalId`。CLI 結束後，把修改的檔案（worktree 中的 commit，或第二份快照）記錄在訊息上。

## HTTP API

所有寫入請求都必須帶 `Content-Type: application/json`（CSRF 防護）。錯誤格式為 `{ "error": string }`，狀態碼 400/404/409/415/500。帶上 `X-Relay-Lang: zh-TW | en`，錯誤、系統訊息與內建範本就會使用該語言（網頁介面一律會帶）。

除了 `GET /api/auth` 與 `POST /api/auth/login`，每個請求都必須來自已登入的瀏覽器（[架構 → 登入](architecture.zh-TW.md#登入)）：`relay_session` cookie 與 `X-Relay-Key` 標頭。瀏覽器自己載入的路由（`app.ts` 的 `BROWSER_LOADS`：回覆的媒體與下載、附件、`files/raw`、`files/download`、`files/zip`）只需要 cookie，`…/events` 則以 `?key=` 帶金鑰。否則回應 401，`code: "signed-out"`。與登入無關的測試會傳 `auth: null` 給 `createApp()`。

| 方法與路徑 | Body → 回應 |
| --- | --- |
| `GET /api/auth` | → `{ signedIn, desktop? }`：請求是否來自已登入的瀏覽器（不需要登入時一律為 true）；由桌面 app 啟動的伺服器會加上 `desktop: true`（登入頁就會指向它的選單） |
| `POST /api/auth/login` | `{ code }` → `{ key }`，並設定 `relay_session` cookie（取代已登入瀏覽器原本的 session）；代碼錯誤或過期時 400，一分鐘內錯了十次後 429 |
| `POST /api/auth/codes` | → `{ code, expiresAt }`：給另一個裝置的一次性代碼，10 分鐘內有效 |
| `GET /api/auth/sessions` | → `AuthSessionView[]`：已登入的瀏覽器，最近使用的在前，發出請求的那個標 `current` |
| `DELETE /api/auth/sessions/:id` | 登出那個瀏覽器（若是發出請求的這個，也清掉它的 cookie）；不存在時 404 |
| `GET /api/conversations` | → `ConversationSummary[]`（附側邊欄用的 `running`、`waiting`、`lastStatus`、`groupId`、`sorting`、`createdAt` 與 `branchFrom`） |
| `GET /api/search?q=` | → `SearchResult[]`：標題或使用者／agent 訊息包含 `q` 每個詞（不分大小寫）的對話，標題符合的在前，其餘依最近時間；最多 50 筆。分支的結果帶有 `branchFrom`，也就是它分支來源對話的標題 |
| `GET /api/cwds` | → `WorkingDirectories`：`{ home, dirs: [{ path, default? }] }`，工作目錄輸入框列出的工作目錄：預設的工作目錄（`default: true`，`~` 依新對話的方式展開）在前，接著是各對話的工作目錄（每個對話的全部），最近用過的在前；每個資料夾只列一次（在 macOS 與 Windows 上不分大小寫），而且只列出仍然存在的資料夾。`home` 讓輸入的 `~` 也能比對。瀏覽器能開啟選擇資料夾的視窗時有 `pick: true`：它以本機的名稱（`localhost`、`127.0.0.1`、`[::1]`，不經由 `tailscale serve`）連線，而且這台電腦有這個視窗 |
| `POST /api/cwds/pick` | `{ start? }` → `PickedFolders`：`{ paths }`，在這台電腦的系統選擇資料夾視窗中選的資料夾（macOS 與 zenity 可以選多個；kdialog 與 Windows 一次一個），取消時沒有。視窗開在 `start`（展開 `~`），或它上層最近一個存在的資料夾；`start` 是空的時開在預設工作目錄；視窗關閉時才回答（請求關閉時，或十分鐘後，視窗也會關閉）。不是以本機名稱連線時回 403，這台電腦沒有這個視窗時回 503（Linux 上沒有 zenity 或 kdialog，或不在圖形介面中），已經開著一個時回 409，無法開啟時回 502 |
| `PUT /api/conversations/:id/group` | `{ groupId }` → `{ ok }`：把對話放進側邊欄群組（`null` 代表「其他」），同一串分支的其他對話也一起移過去；群組不存在時回 404。使用者移動過的對話不會再自動分類 |
| `GET /api/groups` | → `ConversationGroup[]`，依建立順序（預設群組「其他」不在清單中） |
| `POST /api/groups` | `{ name }` → `ConversationGroup`（名稱空白、太長或重複——包括「其他」／Other——或超過 50 個群組時回 400） |
| `PATCH /api/groups/:id` | `{ name }` → `ConversationGroup` |
| `DELETE /api/groups/:id` | 刪除群組；裡面的對話會移到「其他」 |
| `POST /api/conversations` | `{ title?, agents, settings, createCwd? }` → `Conversation`；`settings.autoTeam: true` 時會忽略 `agents`（為空），由首席 agent 為每個新問題設計團隊，`settings.autoConfirm: true` 則直接採用它的團隊、不必確認；`settings.extraCwds`：`settings.cwd` 之後的工作目錄（全部最多八個，每個只能一次；沒有 `settings.cwd` 時用預設的）；有工作目錄不存在時回 404 並帶 `code: "cwd-missing"` 與 `paths`（不存在的那些），除非帶 `createCwd: true`，此時會全部建立 |
| `GET /api/conversations/:id` | → `Conversation` |
| `PATCH /api/conversations/:id` | `{ title?, agents?, settings?, createCwd? }` → `Conversation`（執行中回 409；`agents` 與 `settings` 都不會開啟或關閉自動組隊，`settings.autoConfirm` 可以修改；設定 `agents` 會確認等待中的團隊設計，接著由這個團隊回答；`settings` 沒有 `cwd` 時保留對話原本的工作目錄，有 `cwd` 而沒有 `extraCwds` 時它就是唯一的工作目錄；工作目錄不存在時同 `POST`） |
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
| `POST /api/conversations/:id/messages/:messageId/branch` | → 新的對話：到某則 agent 回覆為止的訊息副本，加上團隊、設定、「本對話都允許」的回答與側邊欄群組，從那裡各自往下走（`Orchestrator.branch()`；不是 agent 回覆的訊息回 400，之前還有訊息在串流時回 409） |
| `POST /api/conversations/:id/approvals/:approvalId` | `{ allow, always?, note? }`：回應 agent 的核准請求（已回應或已過期時回 404） |
| `POST /api/conversations/:id/messages/:messageId/confirm-plan` | 確認首席 agent 等待中的團隊設計：它的團隊成為對話的團隊，接著回答它所針對的問題，連同等待中的訊息（有其他操作佔用對話時 409） |
| `POST /api/conversations/:id/messages/:messageId/decline-plan` | 不採用：保留目前的團隊，由它回答（第一個問題沒有團隊可以保留，400；409 同上） |
| `POST /api/conversations/:id/messages/:messageId/save-plan` | `{ name? }` → `TeamPreset`：把首席 agent 的自訂團隊設計存成範本 |
| `POST /api/conversations/:id/revise-team` | `{ request, agents, settings }`（`settings`：`mode`、`rounds`、`maxHops`，以及團隊設定裡的 `permission` 與 `cwd`，讓首席 agent 讀到）→ `TeamRevision`（`agents`、`settings`、`reason`、`meta`）：首席 agent 依要求修改送來的團隊（團隊設定裡的），唯讀；不會儲存任何東西（對話不存在時 404；要求是空的或太長、團隊無效時 400；首席 agent 的 CLI 失敗、回覆無法使用或伺服器正在關閉時 503；被停止時 409：請求關閉、有更新的要求，或對話被刪除） |
| `POST /api/conversations/:id/stop` | 中止執行 |
| `POST /api/conversations/:id/share` | `{ html, upTo?, files? }` → `SharedPage`：用使用者的 `gh`（`gh gist create`）把介面做好的頁面（`sharePage.tsx`）放成 secret gist，在 `url`（gistpreview.github.io）閱讀，並留下紀錄；`upTo`：頁面結束的那則 agent 回覆。`files`：`ShareFileRef[]`（`{ messageId, path }`，最多 100 個），也就是頁面上佔位連結（`relay-share-file:<n>`）所指的連結：這些檔案照 `…/download` 的方式找，先放進另一個 secret gist（`gh api gists --method POST` 建立只有佔位檔的 gist，說明含這次分享的代號，並立刻記錄成沒有完成的分享；再用 git 把檔案推進去，由 `gh` 幫 git 登入，並用 `gh api gists/<id>` 讀回它們的 raw 網址），再建立頁面的 gist，每個佔位連結換成對應檔案的 raw 網址；回應的 `files` 與 `filesGist` 是附上的檔案數與它們的 gist。空的頁面、不是檔案清單的 `files`（或它沒涵蓋某個佔位連結）回 400，超過 `SHARE_MAX_BYTES`（1 MB，每個檔案連結另計 512 bytes）、超過 20 個或合計 100 MB 的檔案回 413，有檔案不能附上（任一種 `ShareFileProblem`）回 409 並附 `code: share-file-refused`，沒有 `gh`、沒有登入或失敗，或 git 推不上檔案時回 502 並說明原因（不留紀錄；只有頁面傳不上去、放附檔的 gist 也刪不掉時，以 `unfinished` 記錄那個 gist：`id` 與 `gistUrl` 是它的，`url` 是空的，也不附 gh 的 `code`），前兩種另附 `code: gh-missing` 或 `gh-signed-out`（介面據此列出處理步驟） |
| `POST /api/conversations/:id/share/files` | `{ files, upTo? }` → `{ files: ShareFileInfo[] }`：要分享的訊息（到 `upTo` 為止）裡這些連結指向的檔案，每個一次，附上指向它的連結（`refs`）、`size`，不能放進 gist 時附上 `problem`（`missing`、`outside`：不在對話的資料夾裡或在 `.git` 裡、`too-large`：超過 50 MB）；只照 `…/download` 的方式找、只量大小不讀內容，檔案內容完全不會傳出。不是檔案清單時回 400 |
| `GET /api/shares` | → `SharedPage[]`，最新的在前；對話刪除後帶 `conversationGone`，有附上檔案時帶 `files` 與 `filesGist`，只留下放附檔的 gist、沒有頁面的帶 `unfinished`（分享還在建立中時不列出） |
| `DELETE /api/shares/:id` | → `{ ok }`：刪除分享的 gist，先刪放附檔的、再刪頁面的（`gh gist delete --yes`；用 `gh api gists/:id` 也找不到的視為已刪除，屬於另一個帳號的則拒絕），兩個都刪掉之後才刪除紀錄。不存在的分享回 404，還在建立中的分享的放附檔 gist 回 409，任一個 `gh` 失敗時回 502 並說明原因（與同樣的 code；保留紀錄，可以再移除一次） |
| `GET /api/conversations/:id/files?root=&path=` | → `FileListing`：可瀏覽的資料夾（`roots`：`cwd`，其他工作目錄為 `cwd:1`…，平行模式下再加上每位成員在每個工作目錄的 worktree：`<agent>`、`<agent>:1`…），以及 `root` 裡 `path` 的項目（資料夾在前；`.git` 與指向外面的連結不列出；最多 2,000 項）。資料夾以外的路徑一律 404 |
| `GET /api/conversations/:id/files/preview?root=&path=` | → `FilePreview`：檔案的文字（前 512 KB），或標示它是圖片、影片或二進位檔 |
| `GET /api/conversations/:id/files/raw?root=&path=` | → 資料夾裡的圖片或影片，提供方式和媒體端點相同（其他檔案一律 404） |
| `GET /api/conversations/:id/files/download?root=&path=` | → 以下載提供資料夾裡的任何檔案，方式和訊息的下載端點相同（資料夾、資料夾外或 `.git` 裡的都是 404） |
| `GET /api/conversations/:id/files/zip/check?root=&path=` | → `ZipCheck` `{ all, unignored? }`：把資料夾（`path` 為 '' 時是最上層）下載成 ZIP 檔會包含多少，`{ files, bytes }`；檔案與資料夾超過 10,000 個或 1 GB 時為 null。`all` 為 null 時，`unignored` 是只包沒被 git 忽略的檔案時的同樣資訊（也太大，或資料夾不在 repository 裡時為 null）。不會讀取或壓縮任何檔案；404 的情況和列表相同 |
| `GET /api/conversations/:id/files/zip?root=&path=&unignored=` | → 資料夾的 ZIP 檔，邊送邊壓縮（`application/zip`、attachment、`nosniff`、sandbox），裡面的項目放在以資料夾命名的資料夾裡；內容和瀏覽時列出的相同（不含 `.git`、只跟隨指向裡面的連結、每個資料夾只放一次、保留空資料夾），保留權限，檔名對任何解壓縮工具都安全；成員 worktree 的最上層命名為 `<工作目錄>-<成員>`；`unignored=1`：只包沒被 git 忽略的檔案（包括裡面的其他 repository）。太大時為 413；404 的情況和列表相同；`HEAD` 只回傳標頭 |
| `GET /api/conversations/:id/messages/:messageId/diff` | → 該回合修改的 unified diff（純文字；改了多個 repository 時一個接一個，路徑以各自的資料夾名稱開頭） |
| `GET /api/conversations/:id/agents/:agentId/diff` | → 某個 agent 整份 worktree 結果的 unified diff（純文字；它所有的 worktree，同樣標出資料夾） |
| `POST /api/conversations/:id/agents/:agentId/apply` | 把 agent 的 worktree 結果套用到工作目錄 → `{ files }`（它所有的 worktree，先檢查每一份 patch：任何一份有衝突時回 409，什麼都不套用） |
| `GET /api/conversations/:id/events` | `ServerEvent` 的 SSE 串流 |
| `GET /api/presets` · `POST /api/presets` · `DELETE /api/presets/:id` | 團隊範本（內建的在前）；`POST` 接受 `{ id?, name, description?, agents, settings }`，帶已儲存範本的 id（`user-…`）時會更新它 |
| `GET /api/settings` · `PUT /api/settings` | `{ defaultCwd?, defaultExtraCwds?, createCwd?, lead?, agentHome?, agentsViewUrl?, agentsViewLink? }`（`lead`：`{ provider, model?, effort?, account? }`，自動組隊的首席 agent，`account` 是該 CLI 的一個帳號 id，省略表示預設帳號；`defaultExtraCwds`：`defaultCwd` 之後的預設工作目錄，和它一起給（省略表示沒有），全部最多八個，每個只能一次；有不存在的時回 404 並帶 `code: "cwd-missing"` 與 `paths`，除非帶 `createCwd: true`，此時會全部建立；`agentHome`：各 CLI 自己家目錄所在的資料夾，必須是完整路徑或 `~` 開頭的路徑，不存在時建立，不可以是家目錄、根目錄，或在 Harness Relay 自己的資料夾、任何一個預設工作目錄裡面，`""` 為關閉，有對話正在執行、正在分群或首席 agent 正在修改團隊時回 409；`agentsViewUrl`：AgentsView 的網址，只接受 `localhost`、`127.0.0.1`、`[::1]` 的 `http(s)`，存成 origin，`""` 為關閉；`agentsViewLink`：介面上 **開啟 AgentsView** 改開的網址，任何 http(s) 網址，`""` 為開啟 `agentsViewUrl`）。對目前網址的上次更新失敗時，回應帶 `agentsViewError` |
| `PUT /api/settings/providers/:provider` | `{ bin?, apiKey?, sandboxTerminal? }` → `SettingsView`：整個 CLI 共用的設定（執行檔），以及預設帳號的金鑰（`apiKey: null` 代表移除）。請求裡有 `defaultModel`、`defaultEffort`、`nativeOff` 或 `nativeItems` 時回 400：這些是每個帳號自己的（見下一列）。`sandboxTerminal`：macOS 上 OpenHands 的指令能不能在 Harness Relay 的沙箱裡使用終端機，其他 CLI 會忽略它（[開源 agent → OpenHands](open-agents.zh-TW.md#openhands)）；開源 agent 在這裡沒有金鑰，它們的金鑰是模型來源的 |
| `GET /api/backends` | → `ModelBackendsView`：開源 agent 的模型來源，`apis`（`openai`、`anthropic`、`xai`）與 `endpoints`，金鑰已遮蔽，附上各自存放的位置（`keyStorage`），啟動時金鑰儲存區讀不到的標示 `keyUnreadable`，以及 `deletedEndpoints`：已刪除、既沒有再新增也沒有被忘掉的端點 id |
| `PUT /api/backends/:id` | `{ apiKey }` → `ModelBackendsView`：把 API 來源的金鑰存進金鑰儲存區（`backend-<id>-api-key`）；`null` 或 `""` 移除。其他 id 回應 404 |
| `PUT /api/backends/endpoints/:id` | `{ name, baseUrl, models, apiKey? }` → `ModelBackendsView`：新增一個自訂的 OpenAI 相容端點，或取代這個 id 的端點（小寫 slug，不能是 `openai` / `anthropic` / `xai`，建立後不能改）。`baseUrl`：http(s)，不含帳號密碼、查詢字串或 #，不能是 Harness Relay 自己的位址；`models`：它提供的模型名稱，不含空白（最多 100 個）；沒有 `apiKey` 時保留原本的金鑰，`null` 移除（`endpoint-<id>-api-key`）。用已刪除的 id 新增時，會在同一次寫入中把這個 id 從 `deletedEndpoints` 拿掉。不符合或超過 20 個端點時回應 400 |
| `DELETE /api/backends/endpoints/:id` | → `ModelBackendsView`：刪除端點與它的金鑰，並記住它的 id（`deleted_endpoints`）：之後 Claude Code、Codex 或 Grok 的模型 `<id>/…` 這一輪會失敗，不會送到 CLI 自己的服務；未知的端點回應 404 |
| `DELETE /api/backends/deleted-endpoints/:id` | → `ModelBackendsView`：忘掉一個已刪除端點的 id，讓 `<id>/…` 的模型再照原樣交給它們的 CLI（例如使用者 Codex 設定裡剛好以這個名稱開頭的模型）；沒有記著這個 id 時回應 404，不是端點 id 時回應 400 |
| `POST /api/settings/providers/:provider/accounts` | `{ label }` → `{ id, settings: SettingsView }`：替 CLI 新增一個帳號，尚未登入也沒有金鑰（`label`：最多 40 個字、單行；可以是空的）；新的 Grok 帳號會複製一份預設帳號的資料夾信任。達到帳號上限（`RELAY_MAX_ACCOUNTS`，否則 10 個，含預設帳號）時回 409；開源 agent 沒有登入，也就沒有其他帳號，回 400 |
| `PUT /api/settings/providers/:provider/accounts/:account` | `{ label?, apiKey?, defaultModel?, defaultEffort?, nativeOff?, nativeItems? }` → `SettingsView`：重新命名帳號（`default` 表示預設帳號）、設定它的金鑰（`null` 表示移除；Codex 的金鑰會用 `codex login --with-api-key` 讓那個帳號登入，不會保存），或修改 Harness Relay 執行它的方式：預設模型與推理強度（空字串＝交給 CLI 在它家目錄裡的設定）；`nativeOff`：以這個帳號執行時整類不載入的 CLI 自己的項目，完整清單，可為 `skills`、`mcp`、`tools`、`instructions`、`memory`、`hooks`、`agents`、`plugins`（CLI 不能關掉的項目會被丟掉）；`nativeItems`：逐項不載入的全部項目，`{ <種類>: [id…] }`，種類為 `skills`、`mcp`、`mcpTools`、`tools`、`instructions`、`hooks`、`agents`、`plugins`，id 來自 `NativeSetup`，每種最多 2,000 個（CLI 不能單獨略過的種類會被丟掉）。`SettingsView.providers[].accounts` 的每個帳號都有這四項。CLI 沒有這個帳號時回 404 |
| `DELETE /api/settings/providers/:provider/accounts/:account` | → `SettingsView`：先忘掉帳號與它的金鑰（之後指定它的 agent 與首席 agent 都用預設帳號），再讓它登出（在 15 秒內盡量讓 CLI 登出）並刪除它的資料夾。`default` 回 400，有對話正在執行時回 409 |
| `GET /api/tools` | → `ToolLibraryView`：MCP 伺服器（變數與標頭的值已遮蔽）、skill（當下從 `SKILL.md` 讀取，無法使用時附 `problem`）、各範圍的記憶，以及機密值存放的位置 |
| `PUT /api/tools` | `{ skills?, memory? }` → `ToolLibraryView`。`skills` 會取代整個清單（`[{ path, providers? }]`；新的路徑可以是 skill 集合資料夾，且至少要有一個 skill）；`memory` 修改給定的部分（`all` 或某個 CLI 的 id：`claude`、`codex`、`grok`、`cursor`、`antigravity`、`opencode`、`goose`、`cline`、`openhands`、`pi`；每份最多 20,000 字） |
| `PUT /api/tools/mcp/:name` | `{ transport, command?, args?, url?, env?, headers?, providers?, previousName? }` → `ToolLibraryView`：新增伺服器，或帶 `previousName` 取代或改名。沒有 `value` 的變數或標頭保留原本的值。名稱已被使用時回 409 |
| `DELETE /api/tools/mcp/:name` | → `ToolLibraryView`（它的值會從金鑰儲存區刪除） |
| `GET /api/tools/skills/scan?path=` | → `{ path, skills: SkillCandidate[] }`：資料夾底下的 skill（資料夾本身，以及往下兩層內的 skill 資料夾，最多 300 個），已加入的會標示；不會儲存任何東西 |
| `GET /api/providers[?refresh=1]` | → `ProviderStatus[]`，每個都有 `accounts`：每個帳號的登入狀態，預設帳號在最前面；`checkedAt`：它的檢查何時開始（從快取拿的回答保留原本那次檢查的時間） |
| `GET /api/limits` | → `ServerLimits` `{ maxAccounts, maxTeamAgents, turnTimeoutMinutes }`：環境變數設定、UI 需要遵守或顯示的上限（`RELAY_MAX_ACCOUNTS`、`RELAY_MAX_TEAM_AGENTS`、`RELAY_TURN_TIMEOUT_MIN`） |
| `GET /api/about` | → `AboutInfo` `{ version, desktop, os, node }`：這是哪個 Harness Relay（桌面 app 建置時的版本，否則是 `source (<commit>)`）、跑在什麼系統上，給回報問題用；不含路徑與名稱 |
| `GET /api/update` | → `UpdateStatus` `{ current, updates, available?, progress?, checking?, checkedAt?, checkFailed? }`：這個版本，以及桌面 app 最後說的更新狀態（`npm start` 時是 `updates: false`，沒有其他欄位） |
| `POST /api/update/check` | 讓桌面 app 立刻查詢 GitHub（最多每 5 分鐘一次；否則給已知的狀態）→ app 依編號回答這次檢查後（或 35 秒後，比 app 等 GitHub 的時間長）的 `UpdateStatus` |
| `POST /api/update/install` | 讓桌面 app 像從選單一樣更新到較新的版本（它會先用自己的對話框詢問使用者）→ `{ ok: true }`；沒有新版或更新進行中時 409 |
| `POST /api/report/screenshots` | `{ files: [{ data }] }`（base64，最多 5 張，每張最多 10 MB；依內容判斷是 PNG、JPEG 或 WebP，不接受 GIF）→ `ReportScreenshots` `{ id, url }`：用使用者的 `gh` 把回報問題的截圖上傳成一個 secret gist，檔名是 `screenshot-1.png`…（不用原本的檔名），只保留顯示圖片必要的部分（`withoutMetadata()`：沒有拍攝位置、沒有 EXIF（旋轉方向除外）、XMP、IPTC、註解、縮圖、文字、內容憑證或影像之後的任何資料；影像資料開始後才中斷的 JPEG 或 PNG 會在中斷處補上結尾，不完整的 WebP 會被拒絕；讀不懂結構時 400），`url` 是它在 GitHub 上的頁面，放進信裡；沒有截圖或不是圖片時 400，太多或太大時 413，`gh` 出問題時 502（`code`：`gh-missing`、`gh-signed-out`） |
| `DELETE /api/report/screenshots/:id` | 再刪除那個 gist：只限伺服器這次啟動後上傳的（否則 404） |
| `GET /api/models[?refresh=1]` | → `ProviderModels[]`：每個 CLI 的每個帳號一份，在它的家目錄詢問（CLI 的預設值來自它自己的設定），`defaultModel` / `defaultEffort` 是它自己的預設值；每個 CLI 的預設帳號排在前面、沒有 `account`，其他帳號帶有自己的（由 `catalogFor()` 取出）。每個帳號保留十分鐘；修改帳號的預設值會立刻反映 |
| `POST /api/providers/:provider/native[?account=<id>]` | `{ refresh? }` → `NativeSetup`：這個 CLI 在預設帳號或 `account` 的家目錄（CLI 沒有這個帳號時回 404）、預設工作目錄下自己載入的 skill、MCP 伺服器（只有名稱、類型與狀態）與它們的工具、內建工具（Claude Code）、hook（不含指令）、subagent 與 plugin（CLI 有列出時）和指示與記憶檔，`errors` 列出它沒有回報的部分。CLI 能單獨略過的項目帶有用來不載入它的 `id`。這個帳號有項目設為不載入時，會再依 Harness Relay 以這個帳號啟動它的方式問一次：`nativeOff`、`nativeItems` 與 `asRun` 會說明，那時不載入的項目帶有 `leftOut: true`。會在不送 prompt 的情況下短暫啟動 CLI（用 POST，所以其他網站無法觸發；Claude Code 會收到它自己回答的 `/usage` 回合；Cursor 不會啟動，清單來自它會讀的檔案；Antigravity 回答 `agy -p /skills`、`/hooks`、`/agents` 與 `agy plugin list --json`，它的 MCP 伺服器與指示檔來自它會讀的檔案；開源 agent 透過它 adapter 自己的 probe 詢問，沒有 probe 的則回答 Harness Relay 還不能列出它載入的東西）；每個 CLI、執行檔、資料夾與帳號的結果保留一分鐘，前提是這個帳號不載入的設定沒有變（`refresh: true` 重新查詢） |
| `POST /api/providers/:provider/native/file[?account=<id>]` | `{ path }` → `FilePreview`：CLI 為這個帳號回報過的檔案之一（指示或記憶檔，或 skill 的 `SKILL.md`，路徑要完全相同），供介面閱讀；其他路徑一律 404。比對的是這個帳號最近一次的回答（不論多久以前），所以開啟檔案不會再啟動一次 CLI |
| `POST /api/providers/grok/folder-trust` | `{ cwd?, trust?, folder? }` → `GrokFolderTrust` `{ cwd, folder, above, trusted }`：Grok 是否信任 `cwd`（預設為預設工作目錄），取自 `grok inspect`。`folder` 是 Grok 用來決定信任的資料夾（儲存庫根目錄，解析連結後；不在儲存庫裡則是 `cwd` 的實際路徑）；`above` 表示它是 `cwd` 上層的儲存庫根目錄。帶 `trust: true`（只在使用者確認 `folder` 後送出）時，會再問一次 Grok，並用和 `grok --trust` 相同的方式替這個資料夾記錄在 `$GROK_HOME/trusted_folders.toml`（每個 Grok 帳號各記一份，全部都寫或全部都不寫）；Grok 現在回報的資料夾和送來的 `folder` 不同，或記錄後仍回報未信任（檔案會還原成原本的內容）時回 409 |
| `GET /api/providers/:provider/login-methods` | → `LoginMethod[]`（開源 agent 是空的） |
| `POST /api/providers/:provider/login[?account=]` | `{ method }` → `LoginSessionView`。這裡和接下來四個路由的 `account` 是 CLI 的一個帳號 id（省略或 `default` 表示預設帳號；CLI 沒有的帳號回 404），每個帳號各自登入。開源 agent 沒有登入，回 400；Cursor 或 Antigravity 預設帳號以外的帳號只用 API key 登入（`keyOnlyAccount()`），也回 400；在 Windows 上，CLI 是 Harness Relay 無法啟動的腳本時（`WindowsScriptError`）也回 400 |
| `GET /api/providers/:provider/login[?account=]` | → `LoginSessionView \| null`（執行中時輪詢） |
| `POST /api/providers/:provider/login/input[?account=]` | `{ text }` → 寫入登入程序的 stdin |
| `DELETE /api/providers/:provider/login[?account=]` | 取消登入 |
| `POST /api/providers/:provider/logout[?account=]` | 登出該帳號（開源 agent 回 400；Cursor 或 Antigravity 預設帳號以外的帳號沒有保留登入，所以什麼都不執行；Antigravity 的預設帳號用 agy 的 ACP `logout` 方法，在它的家目錄登出；Cursor 的預設帳號會不帶金鑰執行 `cursor-agent logout`（伺服器啟動時的 `AGENT_CLI_CREDENTIAL_STORE` 指定了儲存區時，就在那個儲存區），登出 Cursor 自己的登入） |
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

圍繞這些步驟的工作順序（把 CLI 分開安裝、先要弄清楚它的哪些事、錄製、在各系統上確認、文件）寫在[新增 coding agent 的流程](adding-a-coding-agent.zh-TW.md)。

有兩種做法。有自己登入的 CLI（像 Claude Code、Codex、Grok、Cursor 與 Antigravity）寫一個**原生轉接器**：完全存取以外，它在 CLI 自己的作業系統沙箱中執行，沒有沙箱的（像 Cursor 與 Antigravity）則每個指令都詢問（Cursor 團隊自己的自動執行允許清單除外，Harness Relay 無法清除它）。使用模型來源的開源 CLI 則寫成 **開源 agent** 轉接器，幾乎全部在它自己的檔案裡；它使用 ACP 時，就用共用的 ACP 回合。

### 原生轉接器

1. **型別**：在 `src/shared/types.ts` 的 `Provider`、`PROVIDERS`、`PROVIDER_LABEL`、`PROVIDER_INSTALL_URL` 加上新的 id，並寫上它的執行能不載入自己的哪些設定（`NATIVE_OFF_SUPPORT`、`NATIVE_ITEM_SUPPORT`；沒有開關就留空）。
2. **轉接器**：建立 `src/server/agents/<name>.ts`：
   - `create<Name>Parser(emit)`（或更新處理函式）：把 CLI 的輸出轉成 `AgentEvent`（`session`、`text`、`text_end`、`thinking`、`plan`、`tool_start`（CLI 說出呼叫做什麼、或轉接器分辨得出來時，帶上它的 `kind`），以及帶 `output` / `error` 的 `tool_end`；CLI 到呼叫結束才說明它做了什麼時，`tool_end` 也帶 `detail`），並記住最終結果或錯誤；
   - 一個 `AgentRunner`，其 `run()` 組出參數（prompt、system prompt、新建/接續 session、權限、模型、推理強度），呼叫 `runProcess()`，失敗時丟出 `AgentRunError`（被停止時 `aborted = true`）；
   - 核准：CLI 要求做權限沒涵蓋的事時，呼叫 `o.requestApproval({ kind, detail, reason, tool })`，再把結果回覆給 CLI（沒有 `requestApproval` 時就拒絕）。
   parser 請保持純函式，方便用錄下來的輸出測試。
3. 在 `src/server/agents/index.ts` **註冊**。
4. **設定**：在 `src/server/settings.ts` 的 `DEFAULT_BIN` 加預設執行檔名稱，在 `AGENT_HOME_ENV` 加移動它家目錄的變數，在 `CREDENTIAL_ENV` 加它讀取登入的變數；若 CLI 從環境變數讀 API key，也加到 `API_KEY_ENV`。
5. **狀態與登入**：`src/server/providers.ts` 的 `checkAuth()` 與 `LOGIN_METHODS`，以及 `logout()` 中的登出指令。
6. **模型**：在 `src/server/models.ts` 加探索函式（或固定清單）。
7. **自己載入的內容**：`src/server/native.ts` 的 `PROBES` 加一個 probe，`src/web/native.ts` 加它的分頁，兩個語系檔加上它為什麼不能不載入某一類（`native.offNotes`）。
8. **介面**：`styles.css` 的顏色變數（`--<name>`）、`src/web/util.ts` 的 `PROVIDER_COLOR` 與 `newAgent()`、`SettingsPage.tsx` 中金鑰的變數與提示文字（`KEY_ENV`、`KEY_PLACEHOLDER`）、兩個語系檔中的 API key 說明文字（`settings.apiKeyHelp`）。
9. **訊息**：`src/server/i18n.ts` 中登入方式的標籤（`login`），兩種語言都要加。
10. **回報問題表單**：在 `.github/ISSUE_TEMPLATE/bug_report.yml` 的 `agents` 選項加上這個 CLI 的名稱（`test/community.test.ts` 會和 `PROVIDER_LABEL` 比對）。

上面大多是 `Record<Provider, …>`，所以漏掉的 `npm run typecheck` 會指出來，其中包括 AgentsView 怎麼取得這個 CLI 的 session（`src/server/agentsview.ts` 的 `AGENTSVIEW_SESSIONS`：AgentsView 命名它們用的前綴，或在 AgentsView 讀不到 CLI 存放之處時填 `recorded`，改由 Harness Relay 送出它記下的每位成員的 session）。它指不出來的有幾處：首席 agent prompt 裡 `provider` 的選項（`src/server/planner.ts`）、`agentFolders()` 裡這個 CLI 自己的資料夾（`src/server/protect.ts`）、無法詢問它時，它的指示檔是不是文件說它會讀的那些（`src/server/native.ts` 裡 `failedProbe()` 的 `memoryFromFiles`）、預設帳號以外的帳號能不能保有自己的登入（`src/shared/types.ts` 的 `keyOnlyAccount()`）、開源 agent 不能繼承的它的登入變數（`src/server/backends.ts` 的 `INHERITED_BACKEND_VARS`），以及它載入 hook 或 MCP 伺服器的專案資料夾，Harness Relay 的沙箱在可編輯模式下讓它們維持唯讀（`src/server/relaySandbox.ts` 的 `PROJECT_AGENT_CONFIG`）。

Antigravity（`antigravity.ts`）是最新的完整範例：沒有沙箱的 ACP、每次執行寫入自己的設定、說明放進它的系統提示，以及透過替身（`test/fake-antigravity.ts`）重播從真正的 CLI 錄下的訊息（`test/fixtures/antigravity/`，已去除個人資訊）的測試。

### 開源 agent

**開源 agent** 使用模型來源、沒有登入，在 Harness Relay 自己的家目錄中執行，完全存取以外則在 Harness Relay 的沙箱中執行。請先讀[開源 agent](open-agents.zh-TW.md)：五個 agent 共用的部分，以及每個 agent 一節，各是一個完整的例子。

1. **型別**：在 `src/shared/types.ts` 的 `OpenProvider` / `OPEN_PROVIDERS` 與 `PROVIDER_LABEL` 加上它的 id，並在每個 `Record<Provider, …>` 加一項（型別檢查會列出來：`DEFAULT_BIN`、`PROVIDER_COLOR`、語系檔裡的說明、`NATIVE_OFF_SUPPORT` / `NATIVE_ITEM_SUPPORT`、自己載入內容面板的分頁…）。
2. **轉接器**：`src/server/agents/<name>.ts` 匯出一個 `OpenAgentDefinition`，註冊在 `index.ts` 的 `openAgents`。它的 `process`（`OpenAgentProcess`）宣告家目錄：`home(root, state)` 給出把 CLI 指向那裡的變數、放在共用家目錄的 `configPaths`，以及放在 `state`（對話成員自己的資料夾 `<home>/private/<key>`；否則沙箱中的執行不會開始）裡的 `statePaths`，也就是一次執行寫入的一切，會載入程式碼的快取則放在這次執行的暫存資料夾或關掉；`prepare`（每次執行前寫入 CLI 的設定：provider、模型、權限規則、角色說明；金鑰只放在變數，絕不寫進檔案）、`proxyEnv` 與 `emptyEnv`，以及它需要任何開口時的 `sandbox`（每個開口都寫在 `docs/open-agents.md` 它的那一節與 `docs/sandboxing.md`）。用真正的 CLI 驗證之前，維持 `implemented: false`：在那之前，它的執行會立刻失敗。
   - **ACP**：填寫 `AcpAgentSpec` 並使用 `acpRunner()`；和共用回合不同的每個地方都是它的一個 hook（模式、模型、推理強度、角色說明、`describeCall`、`rejection` / `afterRefusal`、`filterUpdate`…）。把 CLI 設定成會詢問，讓 `session/request_permission` 送到 Harness Relay 判斷。
   - **其他協定**：使用 `startOpenProcess()`（它讀取模型來源、建立家目錄與這次執行的暫存資料夾、執行 `prepare`，並把指令包進 Harness Relay 的沙箱），自己處理協定，並像 ACP agent 一樣，讓每個動作都經過 `acpPermissionDecision()` → `requestApproval`（見 `pi.ts`）。
3. **模型**：定義裡的 `efforts`，以及 CLI 有模型清單時的 `models`（只保留已設定的模型來源的模型，寫成 `<模型來源>/<模型>`；每個端點的模型會再加上去）。
4. **它自己載入的內容**：定義裡的 `native` hook，以及 `NATIVE_OFF_SUPPORT` / `NATIVE_ITEM_SUPPORT` 裡它能排除的項目。
5. **介面**：一個顏色（`styles.css` 的 `--<name>`、`PROVIDER_COLOR`），以及它在設定頁卡片上的說明（兩個語系檔的 `settings.open.notes`）。
6. **測試與文件**：`test/<name>.test.ts` 透過替身重播從真正的 CLI 錄下的訊息（`test/fixtures/<name>/`，清理過），並檢查設定後的權限；在 `docs/open-agents.md`（兩種語言）加上它的一節，寫明驗證過的版本。
7. **回報問題表單**：在 `.github/ISSUE_TEMPLATE/bug_report.yml` 的 `agents` 選項加上這個 CLI 的名稱（`test/community.test.ts` 會和 `PROVIDER_LABEL` 比對）。

## 資料庫變更

Schema 定義在 `src/server/db.ts` 的 `MIGRATIONS` 陣列；`PRAGMA user_version` 記錄已套用幾個。要修改 schema：

1. 在 `MIGRATIONS` **新增**一段 SQL（不要修改已發佈的段落）。
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

測試在 macOS、Linux 與 Windows 上都會跑（CI 在 Linux 與 Windows 上跑）。要讓測試在每個系統上都通過：

- 用 `join()` 與 `resolve()` 組路徑，不要寫成以 `/` 分隔的文字：在 Windows 上 `/repo` 會解析成 `C:\repo`，或是解析時所在資料夾的那個磁碟（GitHub 的 runner 把 repository 取出在 `D:`，家目錄在 `C:`，暫存資料夾也在 `C:`，只有 CI 的單元測試把它放在 `D:`）。接受 `platform` 參數的函式，不論在哪個系統上執行，都組出那個平台的路徑（用 `node:path` 的 `posix` 或 `win32`）。
- 用 `delimiter`（Windows 上是 `;`）切開 PATH；把路徑寫進 git 設定檔時用 `/`：設定檔會把 `\` 當成跳脫字元。
- 只有 macOS 或 Linux 才有的東西，用 `it.skipIf(process.platform === 'win32')`（或 `describe.skipIf`）跳過：權限位元、POSIX 訊號與 process group、`/bin/sh`，以及靠 `#!` 那一行執行、Windows 無法啟動的替身 CLI。
- 時間限制交給 `test/timeouts.ts` 與 `test/setup.ts`：測試沒指定時，`vi.waitFor` 最多等 5 秒（Vitest 預設的 1 秒，對所有測試檔同時在跑時、要用 git 記錄變更的執行來說太短）；Windows 啟動程序與執行 git 慢上好幾倍，所以那裡每個測試的時間限制與每次等待都是六倍長；自己設時間限制的測試用 `slow(ms)`。協調器的測試每個允許 20 秒（`test/orchestrator-harness.ts`）：每個測試都要跑好幾次 git，而且它們的檔案同時執行。
- 等測試需要的狀態出現（`vi.waitFor`），不要等固定的時間：Windows 的計時器每 15.6 毫秒才跳一次。
- Windows 的暫存資料夾可能是 8.3 短檔名（GitHub 的 runner 上是 `C:\Users\RUNNER~1\…`）：`realpathSync` 會保留它，git 與系統自己的實際路徑（`realpathSync.native`、`fs.promises.realpath`）則會展開成完整名稱。`test/setup.ts` 會把 `TEMP` 設成完整名稱，讓測試的資料夾和選擇資料夾視窗給的名稱一樣。

`test/setup.ts` 也會在測試檔載入它的模組之前，刪掉所有 `RELAY_*` 變數，所以你替自己的 Harness Relay 設的上限或語音資料夾不會影響測試；需要的測試會自己設定。端對端測試的伺服器也不會帶上它們（`e2e/support/relay.ts`），spec 需要時用 `serverEnv` 給。

目前的測試：

- `test/store.test.ts`：SQLite store 與設定（存取往返、保留工具呼叫的類型並丟掉這個伺服器不認得的類型、串流更新、當機復原（還在串流的回覆標為中斷、它們等待中的核准標為過期、執行中的工具呼叫標為結束）、連帶刪除、檔案權限）、側邊欄群組（順序、重新命名、刪除群組時對話移到「其他」、自動分類只有一次，而且不會蓋過使用者的移動、不會分到已刪除的群組；一串分支對話一起移動，頂端刪除後也一樣，新的分支放進它這串的群組，原本的對話被分類時分支也一起帶過去；一串分支中間的對話被刪除時，底下的對話會記住它（`via`，記憶體與資料庫中都是，讀不懂的會略過），讓這一串仍在一起；分支更前面那些複製的訊息是在哪裡寫的（`earlier`，讀回來、讀不懂的段落略過，寫出它們的對話刪除後加上 `via`），以及不載入對話就讀出它的標題（`titleOf`），已刪除的對話則是側邊欄顯示的標題；列表中每個對話的分支來源與建立時間）、搜尋（每個詞都要符合、不分大小寫、標題符合的在前、中文、`%` 與 `_`、不含系統訊息、摘錄、仍在串流的回覆、分支的來源），以及搭配假的金鑰儲存區測試 API key：絕不寫進資料庫、舊的資料庫金鑰會被移出並從檔案中清除、儲存區拒絕寫入的情況。也測試各 CLI 執行時不載入的項目（會保存，且只保留那個 CLI 能關掉的，包括 hook、subagent 與 plugin），以及逐項不載入的項目（以 JSON 保存、只保留那個 CLI 能單獨略過的種類、回傳的是複本、其他更新不會清掉、空物件會清除）。另外也測試各 CLI 自己的家目錄：各 CLI 的家目錄變數指到資料夾內並取代繼承來的值、建立資料夾（無法建立時仍指過去並發出警告）、與 AgentsView 的網址一起保存，以及關閉後恢復繼承來的家目錄。也測試排程：隨對話保存（以及它送出的訊息）、列在側邊欄、到期的排程依最久過期排序，以及刪除排程或對話後就不見了。也測試保存自動組隊與 `autoConfirm`，以及 schema 第 13 版為在它之前儲存的對話開啟自動組隊；保存排程是否每次開新對話與上次開的對話，以及 schema 第 14 版讓之前的排程留在自己的對話；讀回對話所在的側邊欄群組（`groupOf`）；使用中的工作目錄，每個只列一次，最近用過的在前（`listCwds`）。也測試分享的對話：最新的在前並保存結束的那則回覆、對話已刪除的會標示，以及刪除紀錄（schema 第 15 版）；保存附上了幾個檔案、它們的 gist 與沒有頁面的放附檔 gist，舊的分享讀回時沒有這些（schema 第 16 版）；分享一步換上它的放附檔 gist 的紀錄；分支和它一開始的訊息一步儲存（有一則寫不進去就什麼都不留），以及複製的訊息到哪則為止（schema 第 17 版；讀不懂的會略過）。也測試資料夾的鎖：一次只有一個持有者，關閉或它的程序被強制結束時就釋放，旁邊不留檔案；沒有任何東西參照它的 handle 時（像 index.ts），經過垃圾回收後鎖仍然持有。也測試開源 agent 的家目錄待過的資料夾（`openAgentRoots`）：換了 agent 家目錄的資料夾後仍記得，並交給它們的執行。也測試帳號：每個 CLI 的其他帳號連同名稱、家目錄（在各 CLI 自己的資料夾，否則在 Harness Relay 的資料夾）與金鑰（在金鑰儲存區，會從資料庫移過去；只用自己的：伺服器環境變數裡的憑證變數都不給，例如 Claude Code 的 OAuth 與 auth token）都會保存，不認得的帳號視為預設帳號，移除的帳號連同金鑰一起忘掉，首席 agent 改回預設帳號；每個帳號自己的預設模型與推理強度和它的執行不載入的項目（新帳號什麼都沒設、只留 CLI 能略過的、交出去的是副本、已不存在的帳號視為預設帳號），以及 schema 版本 20 之前就有的帳號沿用所屬 CLI 的值；成員、範本成員與 agent session 的帳號都會保存。也測試 Cursor 唯一的登入：預設帳號以外的帳號，以及帶金鑰的執行（帳號自己的，或伺服器自己的 `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`），都有 `AGENT_CLI_CREDENTIAL_STORE=memory`，沒有金鑰的預設帳號則沒有；伺服器自己的 Cursor 憑證只給預設帳號；其他 CLI 不受影響。也測試成員的 session 建立時所在的模型來源（schema 第 26 版），CLI 自己的服務則不記。多個工作目錄：對話的其他工作目錄（`extra_cwds`）、一輪在每個 repository 的修改（`more_changes`）、每位 agent 在每個 repository 的 worktree 與忘掉其中一個、使用中工作目錄的清單包含每個對話的全部、遷移版本 21 之前建立的 worktree，以及略過讀不懂的內容。也測試模型來源的 migration 以 21–25，或在帳號之前以 19–22 跑過的資料庫（未發布的版本）會改成現在的編號：對它補跑現在的 21（帳號之前的還有 19 與 20）、版本加上補跑的數目，保留裡面的資料；main 自己停在 21 的資料庫則維持原樣。
- `test/workspace.test.ts`：用真實的暫存 repository 測試 git 操作（自動 init、不影響 repo 且排除其中各 CLI 自己家目錄的快照（透過連結指定也一樣）、worktree、套用、衝突、CRLF 與非 UTF-8 內容逐位元組套用（使用者的 git 會轉換換行字元時也一樣，例如 Windows 版 Git 的 `core.autocrlf`）、很長或特殊的檔案清單、保留的快照 ref、範圍太大的 repository）。也測試 repository 自己的設定（它的 fsmonitor、filter、textconv，以及透過 include 加入的）在 Harness Relay 的 git 指令中什麼都不執行，submodule 所在 repository 的 driver 也不執行（真正的 submodule 仍會收進快照），不抓取 partial clone 缺少的物件，`core.worktree` 指向其他資料夾時拒絕，而使用者自己的 driver（git-lfs 的）不受影響。檢查 patch 而不改動任何東西、再套用它，以及 diff 的路徑以資料夾名稱開頭。
- `test/process.test.ts`：程序輔助函式：輸出逐位元組保存、停止不理會 SIGTERM 的子程序（包括 CLI 已結束後，以及關閉時）、工作目錄不存在、相對路徑的執行檔、在 Windows 上以 Node 啟動 npm 包裝檔的腳本，參數原樣傳入；固定的 shell 腳本（`runShellScript`）帶著它的旗標，並從環境變數讀取它要的值，執行太久的腳本，以及不存在的 shell；脫離的程式（`spawnDetached`）在呼叫結束後繼續執行，且不在 `killAll` 之內，以及不存在的程式。也測試 `runSync`：直接執行、帶著輸入的簡短檢查，逾時就結束，連不理會 SIGTERM 的也一樣，以及 `sleepSync`。
- `test/winLaunch.test.ts`：在 Windows 上要為 CLI 啟動什麼：照 shell 的方式找到它（PATH 上依 PATHEXT 的順序，`Path` 的大小寫不拘；`Path` 與 `PATH` 並存時用 Node 交給子程序的那個；PATHEXT 列的 `.JS` 會略過）；程式直接啟動；找不到的會說找不到，不會直接用名稱啟動；npm 包裝檔指名的程式，或用它旁邊的、PATH 上的或 Harness Relay 的 Node 執行它的腳本（npm 現在與較舊的包裝檔格式），桌面 app 不拿自己當 Node；包裝檔指名的腳本或程式不在時說明原因；使用者自己有一行像包裝檔的腳本、給其他直譯器的包裝檔、執行兩樣東西的腳本都不算包裝檔；Cursor 依日期與建置時間最新且完整的版本資料夾，帶著 `CURSOR_INVOKED_AS` 與編譯快取，這種資料夾旁的其他腳本不算它的啟動檔；讀不出執行哪個程式的腳本會被拒絕，並以兩種語言說明原因；不是 Windows 時不做這些。
- `test/hub.test.ts`：瀏覽器重新連線時的 SSE 分送。
- `test/web.test.ts`：提供建置好的介面：帶雜湊的檔案永久快取、index.html（含前端路由）與 web app manifest（以 `application/manifest+json` 提供）每次都檢查、缺少的檔案回 404、不影響先前註冊的路由。也測試介面放在哪裡：伺服器啟動所在資料夾的 `dist/web`，或 `RELAY_WEB_DIR`（絕對或相對路徑；空白視同未設定）。
- `test/parent.test.ts`：伺服器眼中的桌面 app（也包括收到 app 說的更新狀態，其他訊息不會被當成它）：沒有 Electron 的 `parentPort` 就不存在；伺服器開始接收連線時通知它；收到關閉要求，忽略其他訊息；每次要登入連結都給一個新的，每次問有幾個對話有 agent 在工作都照當時的數量回答。也像 app 一樣從原始碼執行伺服器（`desktop/scripts/smoke.ts`，用一個代替建置好介面的資料夾）：keyring 模組能從它旁邊載入、只聽 127.0.0.1、提供介面、瀏覽器登入前拒絕 API、給出自己網址的登入連結且代碼能讓瀏覽器登入、讓假的 claude、codex 與 grok（`installFakeClis()`，Windows 上會建置執行檔）組成的團隊在唯讀對話裡回答一個問題、不印出代碼、說沒有對話有 agent 在工作，並在被要求關閉時以代碼 0 結束。也實際在已被佔用的 port 上啟動伺服器（設定了 `HOST`，因為 shell 可能會匯出它）：它會說明原因（並建議換一個 `PORT`），以代碼 1 結束，不印出 stack trace；透過桌面 app 的 port（`parent-port.mjs`）也一樣：app 會收到 `EADDRINUSE`，絕不會收到開始接收連線的訊息，伺服器以代碼 1 結束。也測試桌面檢查的環境：`withoutOwnSettings()` 不帶 `RELAY_*` 與 `E2E_*`，`withFakeClis()` 給代替的 CLI 自己的家目錄與工作目錄、把它們放在 PATH 最前面，而且不帶使用者的憑證。
- `test/ports.test.ts`：Harness Relay 的 port（`src/server/ports.ts`）：`npm start` 用 8787，`npm run dev` 用 8789（依 `npm_lifecycle_event` 判斷），`PORT` 優先於兩者；桌面 app 預設的 port 與 `npm start` 相同，`npm run dev` 的 API 與 Vite 絕不使用它。
- `test/config.test.ts`：環境變數設定的值（`src/server/config.ts`）：沒設（或空白）時用預設值；上限與回合逾時是範圍內的整數；每個不合法的值都會回報，並保留預設值；語音輸入的下載資料夾（只接受 http 與 https、去掉結尾的斜線、不能含使用者名稱或密碼且訊息不會重複密碼、不能有 `?` 或 `#`；不是網址的值也不會重複），以及它的資料夾必須是絕對路徑或從 `~/` 開始（相對路徑會被拒絕）。
- `test/desktop-supervisor.test.ts`：桌面 app 的伺服器 supervisor，用假的伺服器程序：以它的環境啟動，開始接收連線後就是執行中；一次只有一個伺服器，停止期間也一樣；port 被佔用時不啟動，在檢查與開始接收之間被佔用也一樣回報；其他接收錯誤（`EACCES`）與開始接收前就結束，都附上最後的輸出回報；沒有及時開始接收的伺服器會被停止；停止時要求關閉並等待，沒有及時停止就強制結束，期間自己結束的伺服器不算當機；回報當機，之後能再啟動新的伺服器；啟動期間要求停止，會立刻結束還沒開始接收連線的伺服器（不等啟動的時限），在檢查 port 時要求停止就不會啟動伺服器，剛好在停止前開始接收的伺服器照一般方式停止，同時兩次停止（重新啟動後接著結束）只會停止一次。登入連結：每次都要一個新的；伺服器沒有及時回應時不給（晚到的回應仍屬於那個要求）、沒有執行或在回應前停止時也不給；很晚才結束的伺服器（停止時已放棄它）不會取消下一個伺服器的請求；連結不會被誤認為啟動完成。有幾個對話有 agent 在工作：每次都問，連結不會被當成答案、答案也不會被當成連結，伺服器沒有執行、沒有及時回應（晚到的回應仍屬於那個問題）或先停止時沒有數字。也用真的 socket 測試 port 檢查。也測試既沒有及時開始接收、被強制結束時也不結束的伺服器：會放棄它，結束 app 時也不會等它。也測試聊天介面對更新的要求只從執行中的伺服器轉給 app，並帶著要求的內容（檢查的編號），app 的更新狀態也只告訴執行中的伺服器。
- `test/desktop-env.test.ts`：桌面 app 給伺服器的環境：在標記之間讀取登入 shell 的變數（含換行的值、值裡的 `=`、前後的其他輸出），沒有標記或 PATH 時不採用；透過假的設定檔實際執行 shell（也從含空白與引號的路徑；shell 不存在；卡住的 shell 會及時放棄），不包含 shell 本身的變數與 app 為 shell 設定的變數；無法詢問 shell 時把常見的安裝資料夾加到 PATH；不管設定檔匯出什麼，都用 127.0.0.1 與 app 的 port，保留使用者的變數但不含 Electron 的，保留使用者選的資料夾與工作目錄；使用 app 自己的資料時 API key 存在 `harness-relay-desktop`，共用資料時用平常的名稱；tailnet 名稱只加進 `RELAY_ALLOWED_HOSTS` 一次；視窗的瀏覽器資料夾以 `RELAY_APP_BROWSER_DIR` 傳入。也測試重新啟動時重新讀取的 Windows 目前的環境：PowerShell 的回答（有沒有 byte order mark 都可以；其他內容不採用）、照 Windows 組成的 PATH（系統的、使用者的，再接 app 自己原本的其他項目，每個只出現一次，並沿用 app 環境裡的變數名稱）、採用使用者新加的變數，但不採用系統的預設值（`USERNAME`）。
- `test/desktop-tailscale.test.ts`：從桌面 app 分享到 tailnet：找到 `tailscale`（在 PATH 上、Mac App 自己的執行檔、Windows 的 `tailscale.exe`、找不到），它的狀態（執行中、去掉結尾句點的電腦名稱；已登出；不是 JSON），某個 port 分享在哪個網址（HTTPS 443 或其他 port、以 `localhost` 為目標、其他 port、沒有分享），在哪裡分享才不會搶走其他服務（443，否則 8443，再否則 10000；TCP 轉送或提供檔案的 `/` 算已佔用，其他路徑不算；全部被佔用），**分享到手機** 要做什麼（`sharePlan`：讀不到目前分享了什麼時什麼都不做，例如指令失敗或印出的不是它的 JSON；否則用第一個沒被佔用的 port、已經分享在哪裡，或全部被佔用），以及 `tailscale serve --bg` 的結果（網址、開啟 Serve 的頁面且必須是 Tailscale 的、Linux 上的 *Access denied*、其他失敗與逾時）。也透過假的 `tailscale` 執行指令：status 與 serve status、在 443 不加參數分享與在 8443 加 `--https` 分享、印出連結後等待的分享會及時停止，以及失敗或不存在的指令。公開到網際網路（Funnel）的 port 算已佔用。
- `test/desktop-app.test.ts`：桌面 app 的其他部分：Linux 的 autostart 項目（`Exec` 參數加引號，依 Desktop Entry Specification 處理 `%` 與反斜線，放在哪裡，開與關），它的設定（`desktop.json`：缺少或無效的值用預設值，透過暫存檔儲存），它的語言（任何中文 → 繁體中文，其他為英文）且兩種語言的訊息相同（無法更新的每個原因與更新失敗的每種情況，兩種語言都有），它的圖示（解碼檢查：app 圖示的白色圓角方塊與標誌、選單列圖示是透明背景上的黑色、`@2x` 是兩倍大小），app 資料夾的 `package.json`、視窗的瀏覽器資料夾（`profile.ts`：在伺服器啟動前建立，刪除旁邊舊的登入資訊，保留 app 的設定與伺服器的資料）、electron-builder 留下的打包好的 app（`scripts/packaged.ts`：Mac、Windows 與 Linux 的 app，通用版 Mac app 只取最後的結果），以及它的判斷（`lifecycle.ts`）：只用自己伺服器的登入連結打開對話、只為執行後自己停止的伺服器通知、各系統上再次打開 app 時做什麼、登入時的啟動、登入時啟動它的指令（AppImage 用它自己的檔案、未打包的 app 帶上它的資料夾），以及伺服器還不接受某個 tailnet 名稱時要重新啟動。也測試視窗的連結去哪裡（伺服器的頁面在 app 裡、其他網頁與郵件交給瀏覽器、這台電腦的其他 port 算其他網站、`file:`、`javascript:`、`data:` 一律不開），頁面能使用什麼（只有伺服器的頁面能用麥克風但不能用相機、寫入剪貼簿與全螢幕；沒有指明種類的媒體權限檢查當成麥克風，沒有伺服器時一律不允許），用假的視窗測試視窗的防護（`guardContents`：伺服器的頁面在 app 的視窗裡、其他的交給瀏覽器、剩下的一律不開；擋下離開的導覽與重新導向；頁面打開的視窗也一樣防護；伺服器沒有執行時什麼都不放行），再次打開 app（顯示視窗或啟動），`desktop.json` 記住的視窗大小與 tailnet 名稱（只接受主機名稱），以及 Tailscale 連線前使用的 tailnet 名稱。
- `test/desktop-update.test.ts`：桌面 app 的更新（`desktop/src/update.ts`）：各安裝檔都從副本 repository 裡相同 tag 的更新用副本（`-update`）下載，檔名仍照安裝檔的，用安裝檔的檢查碼檢查，並以安裝檔本身作為備用；不論順序，都不理會 release 本身裡的副本；正式版本只提供正式版本，候選版本或自己建置的版本也提供候選版本；每小時詢問 GitHub 一次，最多每 5 分鐘一次（聊天介面提早要求時也一樣，時鐘往回調也不會從此不問），只有會自己更新、而且沒有進行中的更新或檢查時才詢問（`checkNow`），卡住的請求會放棄；正式版本只查詢 GitHub 最新的正式版本（絕不會是候選版本）；一段時間沒收到資料的下載會放棄（完全沒有回應時也一樣），持續慢慢收到資料的則不會；告訴聊天介面的狀態（不會自己更新的只有這一項；較新的版本、以整數百分比表示的進度、檢查中、上次回答與失敗）；更新進行中再要求一次什麼都不做，失敗後可以再更新；讀取一個發佈，以及各系統的安裝檔與它的 SHA-256，候選版本或 pre-release 也可以，但絕不是草稿或不是版本的 tag；不論 GitHub 列出的順序，依版本取清單中最新的那一個（前一天的修正之後是候選版本，當天的候選版本之後是正式版本，再來是它的修正，修正版的候選版本排在它前一個版本與那個修正版之間；空清單或不是清單的回答就是沒有）；略過放在其他地方、檔名會離開資料夾，或檢查碼不是 SHA-256 的安裝檔，其他地方的頁面改用 Releases 頁面；比之前某天、較早的修正、當天的候選版本或自己建置的版本新，但不比自己或更新的版本新，候選版本比較早的候選版本新，但不比它是候選版本的那個版本新（修正版的候選版本比它前一個版本新）；向 GitHub 的版本清單查詢（還沒有版本就是沒有更新，其他失敗是錯誤）；每個系統一個安裝檔，Mac 只有 Apple Silicon 的，Windows 與 Linux 依正在執行的 app 的處理器（x64 或 Arm64；其他的沒有），並從版本讀出每種處理器的安裝檔與檢查碼。這一份 app 怎麼更新（`installPlan`）：能寫入所在資料夾時就地更新 Mac app，絕不從磁碟映像檔或被轉移的副本更新；Windows 用安裝檔；Linux 用 AppImage，其他 Linux 建置不行；從原始碼執行、沒有安裝檔或沒有檢查碼時改用版本頁面；Windows 安裝檔的參數。副本不存在（404）時改下載安裝檔本身，而且只有這時才會（其他失敗不會）；檢查碼相符才儲存下載，並回報進度；不相符、失敗或連不上時什麼都不留下。分段下載（對著接受 Range 的替身 CDN）：只問一次 GitHub 檔案在哪裡，再從那裡下載各段，每條連線一段（連線數不超過檔案能分成的最小段數，較小的檔案從 GitHub 的網址一次下載）；副本不存在時改下載安裝檔本身，其他回答或轉到 HTTPS 以外的地方時什麼都不留下；做完自己那一段的連線接手最慢那一段剩下的後半；連線中斷的那一段從停下的地方再要一次，中斷幾次之後放棄下載；簽名網址過期時改用新的網址，不論幾段遇到都只重新查一次，一直過期就放棄；CDN 對一段請求送來整個檔案時，從 GitHub 轉到的地方一次下載；沒收到資料的那一段再要一次，每一段都收不到、或 GitHub 一直不回答時放棄下載；合起來不符檢查碼的各段會刪除。換上新版：AppImage 用它自己的名稱（刪除舊的）或使用者取的名稱，並可執行；Mac app 與準備好的那一份對調，舊的留到下次啟動，沒有可對調的東西時什麼都不改；在 macOS 上，用 `hdiutil` 做出真的磁碟映像檔，內含 ad hoc 簽章的 app，複製出來並檢查（其他 app、其他版本，或不是磁碟映像檔的檔案都會被拒絕）。等對話結束（`whenIdle`、`busyWithoutAsking`）：伺服器在執行時詢問它，自己停掉時算是沒有，正在啟動或停止、或 app 正在結束時沒有答案（所以結束 app 絕不會切換）；答案一直未知時，不管多久都不切換；沒有 agent 在工作時立刻切換；在那之前一直再問，期間說出有幾個，伺服器沒回應時也再問；兩次詢問之間會等待；使用者選擇時立刻切換，不論是在等待還是正在詢問伺服器。更新留在 AppImage 旁的東西：下載檔隱藏在正在執行的那一個旁邊，啟動時連同 `.part` 一起刪除，其他都不動。啟動新版：macOS 用 `open`，Linux 帶參數執行 AppImage，pid 與路徑放在腳本的環境變數裡（絕不放進腳本文字或參數），不帶舊版的執行階段變數，而且只在 app 結束後才啟動（用真的程序測試）；路徑含空白、引號與 `$(…)` 時照原樣啟動，且不帶指向它的那些變數。
- `test/desktop-traymenu.test.ts`：開著的系統匣選單（`desktop/src/traymenu.ts`）：它顯示的內容化成文字（顯示中的項目的文字、能否點選、勾選；隱藏的不算）；就地逐一修改它的項目，只改不同的，少了某個項目時完全不改；只有顯示的內容改變、而且選單開著時才重新打開，最多每秒一次並顯示最新的變化（打開超過一秒後的變化會立刻顯示），從關閉到再打開之間仍算開著；是不是使用者打開的；舊選單的關閉事件在新選單打開之後才到時也能處理，之後使用者的關閉照常算數；使用者關掉後仍算開著一小段時間（點選的事件在之後才到），之後就不算，也絕不會自己再打開，這段時間內使用者再打開則照常；沒能及時再打開或再打開失敗時，算作已關閉。
- `test/signin.test.ts`：登入頁指向哪裡（`src/web/signin.ts`）：從 user agent 裡的 Electron 認出桌面 app 的視窗；在終端機啟動的伺服器，不管哪種瀏覽器都指向終端機；桌面 app 啟動的伺服器，視窗指向 **打開 Harness Relay**，瀏覽器指向 **在瀏覽器打開**；以及用連結登入：先把代碼從網址拿掉再使用它，代碼不能用時也一樣，沒有代碼的網址不動，不能用的代碼給出錯誤（除非瀏覽器已經登入：在代碼失敗後才判斷的已知狀態，或向伺服器詢問）；頁面開啟時的第一次檢查（只問伺服器一次，連結不能用時也一樣：它怎麼說、是不是桌面 app 啟動的，再用頁面開啟時帶的連結；伺服器無法回答時顯示登入頁）；以及 App 的 effect 每次執行共用這次檢查（React 立刻結束第一次執行再執行一次，就像開發時的 StrictMode，仍會顯示連結登入的結果；已結束的執行不顯示任何東西；顯示之後的執行會重新檢查；檢查進行中別的分頁登入時，因為檢查的結果已過時，會隨結果一起顯示 app，檢查之後則由頁面自己顯示 app）。
- `test/secrets.test.ts`：金鑰儲存區使用的名稱：`harness-relay`，或 `RELAY_KEYRING_SERVICE` 指定的名稱（桌面 app 的 `harness-relay-desktop`）；`RELAY_KEYRING=off` 時不使用。
- `test/release.test.ts`：發佈版本的規則（`scripts/release.ts`）：接受正式版本、候選版本與它們的修正，也接受修正版的候選版本與它自己的修正（`2026-11-10.1-rc`、`2026-11-10.1-rc.2`）；前後的空白可以，中間的不行；每種常見錯誤都有確切原因（`v`、`-RC`、`-rc1`、`-rc-1`、`.0`、`.01`、一位數的月或日），看起來像的字元也是（en 與 em dash、全形數字、不換行連字號）；日曆上沒有的日期（含閏年）；台灣的今天，也包括 UTC 已是另一天時；不是今天的日期會被拒絕，並說出今天該用的版本；已發佈過、修正早於它修正的版本、跳號；正式版本與候選版本分開計算，正式版本不需要先有候選版本，候選版本只能是當天下一個版本的：正式版本發佈後是它下一個修正版的，並計算它自己的修正（已發佈的版本的，或比下一個更後面的修正版的候選版本會被拒絕，錯誤訊息說出今天的下一個版本）；忽略其他日期的版本與其他 tag；只能從 main 發佈；一次回報所有問題。App 的 semver：合法、每個數字小於 Windows 的 65535、依發佈順序排列（用 `compareSemver` 排序）；semver 的先後（pre-release 在版本之前、數字依數值比較、識別碼少的在前、`dev` 在 `rc` 之前、忽略 build metadata）；以及不是發佈的建置（`devVersion`：日期加上 `-dev` 與 commit，排在當天任何正式版本之前）。發佈說明從哪裡算起（`previousVersion()`）：正式版本從前一個正式版本算起，略過它的候選版本（也包括隔了幾天、中間有從未成為正式版本的候選版本時）；候選版本從前一個版本算起，正式版本或候選版本都可以；依版本先後而不是 tag 的排列順序（`.10` 在 `.9` 之後、絕不是在它之後的版本、忽略不是版本的 tag）；第一個版本，或之前只有候選版本的正式版本，沒有起點；以及檢查通過的版本會附上它。說明列出什麼（`changesOf()`、`commitsSince()`、`pullMergedBy()`、`newContributors()`、`subjectMarkdown()`、`changesMarkdown()`、`mapLimit()`）：每一個 commit，由舊到新；合併了 pull request 的 commit（squash、rebase）以 pull request 的連結列出、拿掉 ` (#N)`、作者是開它的人，其他的以它自己的連結列出（標題中不是它的 pull request 的編號保留），commit 的 email 只跟著它自己的作者；用 merge commit 合併的 pull request 以它的標題與開它的人列出（GitHub 沒有記錄時用它分支的作者），分支之間的合併不列，GitHub 記錄為 pull request 的 merge commit 的合併則列出；沒有 GitHub 帳號的作者以 git 中的名字列出；讀完 GitHub 比較結果的每一頁，比 GitHub 算出的少就拒絕，沒有前一個版本時由舊到新列出整段歷史；commit 合併的 pull request 與開它的人，而不是開著的或它只是其中一部分的；新的貢獻者（在前一個版本之前，依帳號或依他在清單中的任何 email 都沒有 commit，bot 需要後者；每人一次，附上他的第一個 pull request，沒有就是第一個變更，依他第一次出現的順序；從第一個 commit 算起時每個人都是）；查詢一次八個，答案依原本的順序；標題維持一行文字（標題、引言或清單會被跳脫，程式碼與連結以外、GitHub 會當成提及的 `@名字`（在 `_` 或 `/` 之後也算）連同接在它後面的部分（`@scope/package@latest`）放進程式碼，作者在 git 中的名字也是，連結、email 與日期不動）；清單的寫法與 GitHub 的說明相同（bot 不加 `[bot]`；沒有變更時只有 Full Changelog 連結；沒有前一個版本時連到整段歷史），對 GitHub 來說太長的清單會截斷，說明還有多少變更並連到這個 tag 為止的歷史，放得下的清單絕不截斷；只有在 GitHub 不知道清單在哪裡結束時才提示 `--target`（`notFoundTarget()`）；以及這個指令碼能像桌面 app 那樣打包成 CommonJS（沒有 top-level await）；用錄下的 GitHub 回應（`test/fixtures/release/`）列出這個 repository 的 2026-11-12.1，包括它三個 pull request 之間直接 push 到 main 的兩個 commit；以及從 GitHub remote 讀出 `owner/name`。從 `git ls-remote` 讀取 tag。在有 origin 的真 repository 裡執行指令碼：預設用今天（台灣午夜那一刻，指令碼可能已經是隔天）、用本機的 tag 或加 `--remote` 用 origin 的、下一個版本（當天正式版本發佈後，是它的下一個修正版與它的候選版本）、接受修正版的候選版本、說明從哪裡算起（也包括還沒有正式版本時）、`notes` 拒絕不符合規則的版本、沒有給 commit 的 `--target` 與不在 GitHub 上的 origin、像 workflow 一樣用一般的 `node` 執行（Node 會移除型別時）、GitHub Actions 中的輸出與 `::error`、拒絕 main 以外的分支、格式錯誤的 `--today` 或缺少版本、`RELEASE_TIME_ZONE`。Workflow 檔：只能手動執行且要填版本、輸入的內容絕不放進指令列（只透過環境變數）、與規則相同的時區、先檢查版本並在發佈前再檢查一次、會跑測試、建置三個系統（Mac 只有 Apple Silicon，不加 keyring 模組的 Intel 部分；Windows 與 Linux 有 x64，也在 GitHub 的 Arm runner 上建置 Arm64）、在建置安裝檔前先試打包好的伺服器，並在上傳前檢查打包好的 app（`check-package.ts`，Linux 上在 `xvfb-run` 裡）、網站與 app 的更新所找的每個檔名結尾（`INSTALLERS`）正好各一個安裝檔且沒有其他檔案、五個都建置好才發佈且只有那個 job 能寫入、一次只發佈一個，候選版本以 pre-release 發佈在它建置的 commit 上，以及說明的變更清單由 `notes` 在最後那次檢查之後、發佈任何東西之前產生（到建置的 commit 為止的每一個 commit，用這個 job 自己的 token，它能讀取 pull request 但不能修改，不再用 GitHub 的 `--generate-notes`），再與安裝說明一起發佈（`--notes-file`）。也測試給 GitHub Actions 的訊息會跳脫（輸入裡的換行不會開始新的指令），以及 `--today` 只接受日曆上的日期（沒有給值、`2026-13-45`）。也測試每個安裝檔在檢查之後，會再複製一份到另一個資料夾給 app 更新用，副本在 release 之前發佈到它們的 repository（新建，或在失敗過的執行之後重新上傳覆蓋），release 本身只有安裝檔，副本的 token（`UPDATES_TOKEN`）只交給那一步，以及說明寫明候選版本只提供給候選版本、不提副本。
- `test/site-downloads.test.ts`：網站的下載按鈕（`site/assets/downloads.js`）：絕不提供給 app 更新用的安裝檔副本，它們的檔名（副檔名前加 `-update`，結尾和任何安裝檔都不同）、`updateCopyName()`，以及它們在哪裡（`UPDATES_REPO`、`updateCopyUrl()`：只給安裝檔，tag 與檔名都不會離開它們的位置）；訪客的系統（macOS，但 Chromium 的提示分辨出是 Intel Mac 時算其他系統；Windows、Linux；user agent、`navigator.platform` 或 Chromium 的高熵提示說是 64 位元 Arm 時是 Arm 上的 Windows 與 Linux，提示優先於 user agent，否則是 x64；手機或平板、自稱是 Mac 的 iPad、Android；ChromeOS、32 位元 ARM 上的 Linux 與無法辨識的都算其他系統），在 Chromium 的提示所屬的物件上詢問、其他瀏覽器或被拒絕時不用它，各系統的文字照頁面的 data 屬性命名，有安裝檔的最新版本（再新也不取候選版本：pre-release，或結尾是 `-rc` 但沒有標成 pre-release 的；依發佈時間，不含草稿與沒有安裝檔的版本；沒有版本，只有候選版本時也是），依檔名結尾找到各系統的安裝檔，只接受這個 repository 的 GitHub release 下載網址（而且要真的指向它所寫的地方：沒有 `..` 或 `%2e%2e`、查詢字串、片段、跳脫字元或多出的資料夾），不顯示大小（頁面、樣式與保留下來的 GitHub 回應裡都沒有），發佈 workflow 給安裝檔的名稱，以及兩個頁面的預設連結與文字（沒有候選版本的文字）。也用假的 document 測試頁面本身：按鈕指向最新的安裝檔、標出並寫出訪客的系統、保留十分鐘（期間不再詢問）之後再問，日期在未來的保留版本則立刻再問；再新也不指向候選版本（只有候選版本時是 Releases 頁面、沒有版本那一行），先前造訪保留下來的是候選版本時（之前的頁面保留的，不論有沒有記下是不是候選版本）不顯示它、再問一次 GitHub，GitHub 連不上時也不顯示；Chromium 的提示說是 Arm 時，Arm 上的 Windows 或 Linux 拿到自己的安裝檔，版本沒有它的安裝檔時則是 Releases 頁面（Windows 10 on Arm 無法執行 x64 app）；較新的版本沒有某個系統的安裝檔時，那個系統改回 Releases 頁面（而不是舊版本的安裝檔）；瀏覽器拒絕網站資料時（儲存區丟出錯誤，連讀取 `localStorage` 本身也是）按鈕仍會填好；手機導向快速開始並顯示說明、GitHub 連不上、沒有版本或給出其他網址時（包括保留下來的版本）維持 Releases 頁面，以及沒有下載按鈕的頁面。
- `test/site-theme.test.ts`：網站的淺色或深色主題（`site/assets/theme.js`）：讀取存下的選擇（其他值都算跟隨系統）、每種選擇與系統模式下顯示的主題、按下主題按鈕換成另一個主題，換成系統目前的那個時回到跟隨系統（移除 key）；淺色或深色時設定 `<html data-theme>`，跟隨系統時移除，瀏覽器的頂列顏色（`theme-color`）與按鈕的文字也跟著改；用假的頁面測試：按下按鈕前跟隨系統、選擇記在瀏覽器裡且系統改變時保留、所有顏色同時改變（關掉 transition 時繪製）、從存下的選擇開始、其他分頁的選擇（只看它的 key），以及瀏覽器拒絕網站資料時仍能使用。也檢查 `site.css` 裡兩份深色顏色（系統的深色模式與選了深色）相同、沒有其他地方只跟隨 `prefers-color-scheme`、按鈕依主題顯示的圖示、兩個頁面的頂列顏色等於頁面背景、各頁的 `<head>` 從同一個 key 設定主題且只設成淺色或深色（包在自己的 `try` 裡）並載入這個 module，以及按鈕在兩種語言都是頁首的最後一個、在 GitHub 之後，其他地方沒有。
- `test/app-icons.test.ts`：主畫面圖示與 web app manifest：每個圖示的像素都跟 `npm run icons` 畫出的相同（不透明的 RGB、尺寸正確），manifest 就是它寫出的那份且可以安裝（192 與 512 px 圖示、maskable 圖示、`standalone`），maskable 圖示的標誌落在所有啟動器都會保留的圓內，`index.html` 也有連到 manifest 與 Apple touch icon。
- `test/demo.test.ts`：錄製示範影片的腳本：剪輯（沒有加速片段時照實際時間、agent 的工作加速到目標長度、加速片段不短於下限、略過的片段剪掉、沒錄完的錄影會被拒絕、給 FFmpeg 的畫面清單），章節列（每個章節依標記計時；團隊、首席 agent、請求核准的 agent、群組與搜尋詞依錄影填入；標記沒出現的章節會省略；兩種語言的用詞；頁面使用的標記且有跳脫），問題點名三個 CLI（錄製時也只需要這三個，不需要 Cursor）、設計準則裡的畫面時間，以及截圖（PNG 文字區塊只寫一次且 CRC 正確；社群預覽卡只替換原本顯示舊海報的螢幕像素）。
- `test/providers.test.ts`：CLI 無法執行時的狀態：找不到指令時是「未安裝」，不附自己的訊息（由設定頁說一次，並附上 CLI 的安裝頁），檔案存在但無法執行時則保留原因；這時每個帳號都列為登入狀態未知。每個 CLI（Claude Code、Codex、Grok、Cursor，用它們未登入時印出的內容）未登入的帳號只說未登入，不帶 CLI 自己的字（`none`、「Not logged in」），設定頁的標籤後面因此不會多出字。也測試帳號：用一個把登入狀態存在家目錄的替身 `claude`，在各自的家目錄檢查每個帳號的狀態，各自登入、登出，移除的帳號忘掉它的登入。模型清單在每個帳號的家目錄各問一次（CLI 的預設值來自它自己的設定），每次請求時疊上那個帳號的預設值，列出每個帳號（每個 CLI 的預設帳號在前），並由 `catalogFor()` 取出其中一份；讓某個 CLI 的快取失效時，它的每個帳號都會重新詢問，其他 CLI 不受影響。也測試 Cursor 唯一的登入，用一個把登入存在設定資料夾以外的替身 `cursor-agent`：預設帳號的登入連結只印出、不開瀏覽器；其他帳號不能用瀏覽器登入，只用自己的金鑰登入，和預設帳號的登入分開，並顯示為以「API key」登入（替身的 `status` 和真正的一樣看不到金鑰）；登出那個帳號什麼都不執行；預設帳號登出 Cursor 自己的登入，不帶金鑰，即使它設了金鑰也一樣，伺服器啟動時指定了認證儲存區（`AGENT_CLI_CREDENTIAL_STORE`）時就在那裡登出。也測試帳號改變時（期間呼叫了 `invalidate()`）正在詢問的狀態：照樣回答，但不會留下，所以下一次就有那個帳號；從快取拿的回答保留原本那次檢查的 `checkedAt`，即使時鐘被調回，每次檢查的時間也都比前一次晚。也測試 Antigravity 的登入，用替身 `agy`：每個帳號的狀態來自在它自己的家目錄執行的 `agy models`（當成 `HOME`，因為只有 `agy acp` 接受 `--gemini-dir`），不開瀏覽器，也不傳 Harness Relay 自己的變數，它列出模型時就算已登入；預設帳號的 Google 登入印出連結，並接收頁面顯示的代碼；其他帳號不能用 Google 登入，只用自己的 Gemini API key 登入，並顯示為以「API key」登入，沒有金鑰時則不問 agy 就顯示為未登入，即使 agy 已登入也一樣；登出那個帳號什麼都不執行；預設帳號用 agy 的 ACP `logout` 在它的家目錄登出。
- `test/protect.test.ts`：agent 碰不到的地方：macOS 與 Linux 上瀏覽器的資料夾（Linux 上也看 `XDG_CONFIG_HOME`；Windows 上沒有）、只取實際存在的並連同真實路徑、桌面 app 自己的瀏覽器資料夾（`RELAY_APP_BROWSER_DIR`；沒有設定、相對路徑或不存在時沒有）、資料庫檔案與 Harness Relay 自己的暫存資料夾；工作目錄包含 Harness Relay 的資料夾或資料資料夾，或位於它的程式碼內時，只在可編輯模式下拒絕，資料資料夾內的 worktree 與其他資料夾不受影響，指向它的連結也會被發現，包括還要建立的資料夾路上的連結；家目錄與包含它的資料夾、CLI 自己的資料夾（也包括由環境變數移走的；Cursor 是它的設定資料夾（也包括 `XDG_CONFIG_HOME` 底下的）、`~/.cursor`，以及它在 Linux 上保存登入的 `~/.config/cursor` 三者；Antigravity 是它的 `.gemini` 資料夾，使用者自己的與帳號的都算）、Harness Relay 給各 CLI 的資料夾與程式所在的資料夾會被拒絕，家目錄內的專案不受影響；從 PATH 找到的指令，連同它的位置與真實路徑（Windows 上也依它的副檔名）；沙箱會當成樣式的路徑。另外在 `test/claude.test.ts`、`test/codex.test.ts` 與 `test/grok.test.ts` 中：各 CLI 的沙箱碰不到這些路徑（Claude Code 的 `denyRead`／`denyWrite` 與 `Read` 規則；Codex 的 `harness-relay-…` 權限設定檔，每次執行換一個名稱，Codex 沒有套用時拒絕執行，Windows 上用舊的沙箱；Grok 的 `harness-relay` 設定檔寫進 `sandbox.toml`，與使用者自己的並存，禁止它自己的程式（macOS；在 Linux 上 Grok 靠再次執行自己的程式來啟動沙箱，所以不禁止，而是在某一輪改了程式檔或它的連結時，用保留的副本放回去：有輪次在跑時，在另一輪啟動它之前放回，沒有輪次在跑時則照現狀接受），它的設定在被某一輪改動後改回原樣（連結當作連結、不跟著走，其中之一被改成資料夾時其他的仍會改回，`sandbox.toml` 只看 Harness Relay 區塊以外的部分，同時執行的各輪共用，Harness Relay 自己寫入的信任會保留，且以那些輪次開始時的設定為準）；Claude Code 的使用者設定與受管理設定開放受保護路徑時（相對路徑的項目從該設定檔所在的資料夾算起），以及會被當成樣式的路徑，都會拒絕）；在 `test/app.test.ts` 與 `test/orchestrator.test.ts` 中，Harness Relay 的資料夾拒絕可編輯模式。也測試其他帳號家目錄所在的資料夾，以及其中的專案，在可編輯模式下都會被拒絕。Cursor 沒有沙箱：`test/cursor.test.ts` 測試它自己的讀寫工具的拒絕規則（完全存取以外的受保護路徑、唯讀模式下的任何寫入），以及會被它的規則當成樣式的受保護路徑讓執行拒絕啟動。Antigravity 也沒有沙箱：`test/antigravity.test.ts` 測試完全存取以外，讀寫受保護的路徑會不詢問就拒絕。也測試 `data/tmp` 裡每一輪自己的暫存資料夾（`clearRunTmp()`）：伺服器在某一輪進行中停止時留下的會刪掉，其他的（分享的 clone、Grok 保留的程式）不動，資料夾裡的連結指向的東西也不動。也測試啟動時的清理遇到刪不掉的資料夾會繼續，並說出是哪一個。也測試語音輸入的資料夾（`RELAY_VOICE_DIR` 指定的位置與 `data/voice`）：包含它或在它裡面的工作目錄會被拒絕，並以兩種語言給出專屬的訊息，旁邊的資料夾可以；以及位於暫存資料夾的 `RELAY_VOICE_DIR` 在啟動時被拒絕（`voiceDirProblem`、`dirInTemp`）。
- `test/auth.test.ts`：登入：代碼（Crockford base 32、寬鬆讀取、取自連結片段）、伺服器位址或 Vite 的登入連結、瀏覽器的名稱；會過期的一次性代碼（桌面 app 的連結一分鐘後過期，且只能用一次），以各自有 salt 的 scrypt 存放（不是代碼的 SHA-256），最多最新的五個、需要 cookie 與金鑰（瀏覽器載入的檔案只需 cookie）且最多 400 天的 session、資料庫只存雜湊、列出與登出、錯誤代碼的次數限制；不是正確跳脫序列的片段；並透過 `app.request()` 測試：登入前每個請求都被拒絕（仍先檢查 Host／Origin）、cookie 的屬性、只有 cookie 或只有金鑰都被拒絕、只憑 cookie 載入檔案、即時更新以查詢字串帶金鑰、給另一個裝置的代碼、登出、同時送出且晚送內容的請求，錯誤代碼都會被計算，以及再次登入的瀏覽器取代自己的 session。也測試由桌面 app 啟動的伺服器：`GET /api/auth` 會說明（`desktop: true`），尚未登入的瀏覽器會被指向 app 的選單，而不是 `npm run login`。
- `test/auth-web.test.ts`：「已登出」的回應代表什麼（`src/web/auth.ts`）：金鑰仍是請求送出時那把就是已登出（金鑰留在 storage 給其他分頁），被新的登入取代就重送，金鑰已不在或已重送過就不再處理，所有正在進行的登入都會先等它們完成（包括等待中才開始的登入，以及較新的先完成時仍在進行的較舊登入）。透過 `api` 搭配替身 `fetch`：請求用的金鑰被回應已登出時讓頁面登出；回應在新的登入取代金鑰後才讀完，或在登入進行中回來的請求，改用新金鑰重送，頁面保持登入；登入失敗時仍會登出；沒有金鑰的頁面也會等待，寫入請求會帶著原本的內容重送；已取消的請求不重送；登入本身的請求不會等待自己；一直沒回應的登入在 `SIGN_IN_TIMEOUT_MS` 後放棄，顯示伺服器沒有回應，等待它的請求這時才判斷；回應中沒有金鑰時不存任何金鑰；讀取錯誤回應時時間到了，顯示伺服器沒有回應；回應恰好在時間到時抵達，就沿用伺服器自己的回應；讀取回應時被放棄的請求，以「已放棄」失敗；金鑰已不在時不重送，最多重送一次；文字回應（diff）也一樣。別的分頁存入新金鑰（`keyArrived`），以及 storage 的其他改動都不算。
- `test/app.test.ts`：透過 `createApp()` 與 `app.request()` 測試 HTTP API：Host／Origin／Content-Type 檢查、回覆中刪除對話、團隊回覆中拒絕修改、設定驗證、團隊設計由按鈕或手動設定團隊確認（接著由那個團隊回答）或不採用（由目前的團隊回答）、團隊與設定變更時自動組隊維持開啟（並保存 `autoConfirm`）、首席 agent 依使用者的要求修改團隊（回傳團隊、不儲存任何東西；拒絕空的要求；請求關閉時停止；這段期間拒絕更換各 CLI 自己的資料夾；修改等待中的設計、儲存後由修改過的團隊回答）、只在要求時建立不存在的工作目錄（預設、新對話或編輯中的對話）、選擇資料夾的視窗（只提供給這台電腦上、而且這台電腦有這個視窗的瀏覽器；開在哪裡：輸入框的路徑、最近一個存在的資料夾或預設工作目錄；一次只開一個；請求關閉時關閉；經由 tailnet 或沒有這個視窗時拒絕，以及說明無法開啟的原因）、範本 id、側邊欄群組（名稱不能重複、在兩種語言中都不能叫「其他」、重新命名、刪除、移動對話（同一串分支的對話一起移動）、不存在的群組；列表中每個對話的分支來源）與搜尋。也測試工具庫的路由（遮蔽的值、不合法的名稱、網址、CLI 與變數名稱、重複名稱、skill 與記憶、列出資料夾底下的 skill）、成員的工具例外設定、成員執行時拿到的項目，以及瀏覽檔案（列表、預覽、raw 只給圖片、下載任何檔案、資料夾外或 `.git` 的路徑、未知的資料夾）。也測試回覆中嵌入的圖片與影片和連結的檔案：`/media` 只給媒體類型，`/download` 把任何檔案（包含 HTML；分段、只對下載而不對影片的 `If-Range`、304、416，以及不開啟檔案的 HEAD：用 1 MiB 的檔案和開啟的檔案數確認）以沙箱化的 `octet-stream` 下載提供，隔離回合先找成員的 worktree，也能下載附件，都不會給工作目錄外或 `.git` 裡的檔案；透過 `RELAY_ALLOWED_HOSTS` 允許的主機名稱（例如 Tailscale 名稱）可以下載，其他名稱則不行。也用假的服務測試查詢 CLI 自己載入的內容（只用預設工作目錄、重新查詢、依請求語言的問題說明、未知的 CLI、不接受 GET 或表單 POST），只能讀回報過的檔案（不會再問一次 CLI），以及透過真正的查詢與一個依 grok 1.0.77 方式決定信任的替身 `grok` 測試 Grok 的資料夾信任（不在儲存庫裡的資料夾、儲存庫子資料夾改為信任儲存庫根目錄、經由連結進入的資料夾信任實際路徑、和確認時不同的資料夾、Grok 不接受紀錄時還原或移除檔案、不存在的資料夾、不接受表單 POST）。也測試更新 CLI 設定時不載入的項目（只接受已知項目的清單），以及逐項不載入的項目（依已知種類列出 id，有數量與長度上限；CLI 不能單獨略過的種類會丟掉）。另外也測試各 CLI 自己的資料夾（不存在時建立，不可以是家目錄、根目錄、檔案、相對路徑，或在 Harness Relay 自己的資料夾、預設工作目錄裡面；有對話執行時拒絕且不建立任何東西；更換時清掉登入狀態快取與進行中的登入，同一個資料夾換個寫法則不會）、AgentsView 網址（只接受這台電腦、存成 origin、重新命名的對話會送出、顯示上次的失敗且不套用到其他網址）與開啟用的網址（任何 http(s) 網址，不影響對話送到哪裡），以及 Windows 寫法的 `~\`，還有不論怎麼寫（結尾斜線、`..`、`~`、符號連結）都能認出同一個資料夾。也測試排程：儲存（下一次的時間、請求的語言、顯示在對話與列表中）、關閉與刪除、拒絕永遠不會送出或團隊還要設計或確認的排程（自動組隊的對話有了團隊之後則允許）、儲存時保留上次結果，以及時間不變時保留間隔的節奏，還有立即執行一次（送出、團隊回覆中放進佇列、接著先不送，排程的紀錄不變；關閉時也可以，對話正忙時說明原因）。也測試每次開新對話的排程：儲存，以及「立即執行一次」回傳它開的對話（每次都是另一個），上次開的對話在儲存後仍保留。也測試 `POST /api/schedules`：自動組隊的對話、排程（以訊息命名，或用給定的標題）與為它組隊的首席 agent，不會貼出訊息；第一次組隊停止後才能再請它組隊；永遠不會送出的排程什麼都不建立（連資料夾也不建立），缺少的資料夾只在要求時建立。也測試把資料夾或整個工作目錄下載成 ZIP 檔（標頭、`HEAD`、讀回的項目、404），以及太大而無法整個打包的資料夾（被忽略的 node_modules 裡的檔案超過上限，測試把上限調低成 1,000）：提供只包沒被 git 忽略的檔案，整個打包則為 413。也測試 `GET /api/cwds`：預設工作目錄在前，接著是使用中的工作目錄（包括名稱含空格的資料夾），最近用過的在前，不列出已經不存在的資料夾，預設工作目錄也一樣；預設工作目錄裡的 `~` 會展開，檔案系統不分大小寫時，大小寫不同的同一個資料夾只列一次。也測試分享：以對話標題放上網並留下紀錄（含結束的那則回覆，`upTo` 不是 agent 回覆時則沒有）；拒絕空的頁面、超過 1 MB 的頁面與不存在的對話；`gh` 出問題時說明原因（沒登入時附上 code）且不留紀錄；先刪 gist 再移除分享，gist 刪不掉時保留紀錄，不是 gist id 的一律不處理。也測試分享附上的檔案：`…/share/files` 每個檔案只列一次（兩種路徑寫法、兩則回覆、經由符號連結指向同一個檔案），附上大小（二進位檔、只有空白與空的檔案也一樣）與不能附上的原因（超過 50 MB、在 `.git` 裡、以相對或絕對路徑指到資料夾外、不存在、資料夾、分享範圍之後的回覆、不存在的回覆或另一個對話的回覆，以及分享結束的那則回覆不存在時全部），絕不傳出檔案內容，也拒絕不是清單的輸入；分享時把連結到的檔案各傳一次、內容原樣保留（PNG 的 NUL 位元組、空檔案）、檔名不重複（`report.md`、`report-2.md`）、頁面的佔位連結改成對應的編號並記錄檔案數與它們的 gist，沒被連結的檔案不傳（太大的連讀都不讀）；下載連結不會提供的、或不能附上的檔案在上傳任何東西之前就被拒絕（409 並附代碼），超過 20 個、超過 100 MB（量完大小就拒絕，一點都不讀：讀不了的檔案也是以合計太大被拒絕，而不是讀不了），以及會超過 1 MB 的頁面也一樣；分享進行中放附檔的 gist 記錄成沒有完成，但完成前既不列出也不能移除（409），重新啟動後會列出，頁面上傳後換成分享本身，gist 又被刪除時移除紀錄，留在 GitHub 上或分享意外中止時保留在列表上；有附檔的分享失敗而沒留下任何東西時不留紀錄；只留下放附檔的 gist、沒有頁面時列為沒有完成，移除時只刪它；移除分享時刪除兩個 gist（先刪附檔的），有一個刪不掉時保留在列表上，兩個都刪掉才移除；從回覆分支（新的對話；使用者的訊息、還在串流的回覆與伺服器關閉時會被拒絕）。也測試帳號：新增、重新命名（預設帳號也可以）、列出、每個 CLI 最多十個、名稱檢查；`GET /api/limits` 與它給的上限確實被遵守（帳號，以及隊伍與範本的成員數）；帳號的金鑰（Codex 的金鑰會讓那個帳號登入）；每個帳號各自登入、登出，CLI 沒有的帳號會被拒絕；Cursor 預設帳號以外的帳號不能用瀏覽器登入（400）；每個帳號的預設值與不載入的項目在帳號的路由上分開設定並驗證（CLI 的路由會拒絕這些欄位），不必再問 CLI；依 `?account=` 指定的帳號詢問 CLI 自己載入的內容、打開它回報的檔案；同一個請求裡的 Codex 金鑰與帳號預設值（登入失敗時什麼都不存）；`GET /api/models` 每個帳號一份（Cursor 也是）；移除帳號（先忘掉再登出，所以這段期間開始的回合用預設帳號；用它自己的環境變數登出、刪除資料夾、首席 agent 改回預設帳號；預設帳號不能移除，有對話正在執行時也不行）；成員與首席 agent 的帳號會保存，其他值會被丟掉；Grok 的資料夾信任記錄到每個 Grok 帳號，有一個寫不進去時全部不寫，不被接受時全部還原，之後新增的 Grok 帳號會複製一份。也測試 `GET /api/about`：版本、伺服器是不是桌面 app 啟動的、系統與 Node。也測試回報問題的截圖：依順序命名上傳，只能刪除這裡上傳的（而且只能刪一次），不是圖片的在上傳任何東西之前就被拒絕，`gh` 出問題時連同代碼說明原因。也測試 `/api/update`：桌面 app 說更多之前只有版本，檢查要求轉給 app、檢查完才回答，只在有新版可以更新時才轉送更新要求（否則 409，說明沒有新版或更新已在進行中）。多個工作目錄：每個只能一次、最多八個，不存在的列在 `paths` 中、要求時建立（`PATCH` 也一樣，沒有 `cwd` 時保留對話原本的其他工作目錄，只有 `cwd` 時它就是唯一的），在 Harness Relay 的資料夾中第一個之後也拒絕可編輯模式，以及多個預設工作目錄，新對話與清單都會得到。
- `test/prompt.test.ts`：`@` 解析（名字後直接接文字、程式碼區塊）、`[PASS]`、失敗／停止／PASS 回覆的轉交、隨回覆轉交的動作紀錄（包括 Codex 的檔案變更）、平行模式的簡報，以及簡報如何告訴 agent 顯示媒體、連結檔案讓使用者下載。也測試簡報中的記憶與 skill 區塊：只有在使用者沒有關掉 CLI 自己的 skill 時，才會說它們照常可用；沒有任何能讀檔工具的 Claude Code 成員不會列出 skill。也測試排程送出的訊息（`via="schedule"`），以及有排程的對話的簡報（只有沒有合理答案時才發問；除非排程設為詢問，否則自動拒絕核准），還有排程開的、自己沒有排程的對話的簡報（只在可能沒人看著的那一輪自動拒絕核准）；提問的 agent 會被告知新訊息中的排程訊息不是使用者的回答；分支裡的 agent 會被告知複製的訊息之後檔案可能改過。也測試每個成員都會被告知聊天室裡有 Claude Code、Codex、Grok、Cursor 與開源 agent。角色說明列出每個工作目錄（共用的，或各自在 worktree 中並附上快照，以及每位隊友在每個資料夾的快照），一輪修改的檔案依 repository 各成一個區塊，有多個時標出是哪一個。
- `test/community.test.ts`：回報問題表單裡 CLI、模式與權限的名稱和 app 一致（`PROVIDER_LABEL`、兩個語系檔的標籤），行為準則與安全性政策（兩種語言）列的信箱就是 app 寄送問題回報的地址（`REPORT_EMAIL`）。
- `test/commands.test.ts`：解析 shell 指令：各種寫法的推送與發佈指令、不會讓夾帶指令通過的「本對話都允許」規則 key，以及以參數清單給的指令讀成它執行的那一行（`commandLine`）。
- `test/chat.test.ts`：ChatView 的邏輯：Enter 何時送出（手機和平板上不會）、何時重新連線事件串流、哪個 worktree 結果可以套用、團隊設定的草稿與它編輯的團隊（等待確認的設計，或目前的團隊）、團隊設定送給首席 agent 什麼（成員、輪流方式、權限與資料夾）、首席 agent 會改它的哪些部分（只有成員與輪流方式）、改了什麼（每一種；空的模型與角色前後的空白不算改變，這時團隊設定保留自己的成員），什麼時候不採用首席 agent 的回應（團隊重新載入，或無法儲存），按鈕在「請首席 agent 調整」與「停止」之間切換後會暫停一下（連點兩下或晚到的「停止」點擊都不會有作用），以及回應之後只有在焦點會遺失時才移到要求的輸入框、建立不存在的工作目錄前先詢問；訊息的工具呼叫與思考怎麼歸成一個動作列（什麼會分開兩列、數量、串流時不變的 key、一段思考的第一行與最新一行，以及哪些說明是路徑，放不下時截掉開頭而保留檔名，包括伺服器截過的每個長路徑）；分支來自哪個對話（現在的標題，刪除後用當時的標題）；訊息何時跟著新內容捲動（讀者捲到底部時開始，容許不到一個像素的誤差，或在新內容進來時往下捲到接近底部；讀者往上捲就停止，即使離底部很近，往下捲但離底部還遠時也不會開始，上方內容變高、瀏覽器為了讓讀者停在原處而把畫面往下移時也不會（包括一個像素的進位誤差）；畫面沒動而下方多了內容，或訊息變短而停在新的底部時，維持原狀）。有多個工作目錄時，結果改到的每個 repository 都還是做出它的那個 worktree 時才能套用，這位 agent 任何一個 worktree 需要重設時就過期。
- `test/markdown.test.ts`：@ 標示與伺服器規則一致，並略過程式碼與連結（沒包起來的網址後面直接接的中文也一致）；網址後面直接接中文時，連結在中文開始處結束；圖片以連結顯示；本機的圖片與影片透過 app 顯示；連到本機檔案的連結（包含 `file:` 網址、參照式連結與寫成圖片的檔案）會變成透過 app 下載（去掉行號或錨點，絕不連到其他電腦的共用資料夾），連到網站、錨點與資料夾的連結則保持原樣；參照式的本機媒體圖片會顯示；連結會先用 HEAD 確認（找得到、找不到，或伺服器無法回答時視為未知），找不到的檔案保留連結與文字，並在後面說明原因；確認會稍等一下，網址改變時就不再確認；點擊找不到的檔案會重新確認，找到後再替使用者點一次，不會無限循環；使用者自己的訊息保留換行；表格儲存格維持一行或以好讀的寬度換行，讓太寬的表格左右捲動。
- `test/orchestrator-harness.ts`：不是測試檔，而是下面這些協調器測試共用的部分：換進 `runners` 的假 runner（成員、首席 agent 與群組分類共用的假 claude CLI，由 `fake` 控制）、每個測試之前重新建立的資料庫、store、協調器與專案資料夾，以及每個測試 20 秒的時間限制（`slow()`，所以 Windows 上更長），因為每個測試都要跑好幾次 git。這些測試依主題分成下面幾個檔案，讓 Vitest 同時執行（同一個檔案裡的測試是一個接一個跑的）。
- `test/orchestrator.test.ts`：用假的 runner 跑完整流程：執行準備期間或套用期間收到的請求、agent 向使用者提問（團隊停下；使用者回覆後由提問者先回答，涵蓋圓桌、平行與接力；「繼續」會略過它；回覆給別人或編輯訊息時重新開始；期間寫的訊息等回答時一起送出）、團隊回覆時送出的訊息（在下一個該收到它的 agent 發言前依序送達、沒有回合接到時再開一輪、停止後保留、被 interrupt／下一則訊息／繼續先送出、撤回、重新啟動後仍在）、執行中刪除對話、全新 session 也失敗時保留原 session，以及把失敗回合改過的檔案告訴隊友。有幾個對話有 agent 在工作（`busy()`，桌面 app 的更新等的就是它）：每個正在回覆的對話從準備執行時就算，在等使用者回答問題的不算；首席 agent 修改隊伍或把對話分組、正在修改對話，以及正在建立的分支。也測試使用者關掉的 CLI 自己的項目（整類與個別項目）會傳給每個成員的執行，以及首席 agent 與群組分類的執行。另外也測試每個回合結束與執行結束時通知 AgentsView（且當時已知成員的 session）、連結首席 agent 與分群用的 session（分群在執行結束後才完成時再送一次）、回覆中被刪除的對話不再通知，以及通知失敗時執行仍然完整。也測試帳號：每位成員在自己帳號的家目錄執行，換到另一個帳號的成員開始新的 session，之後被移除的帳號視為預設帳號（session 照常延續）；首席 agent 用自己的帳號執行，它設計的成員拿到已登入的帳號；每位成員用它帳號的預設模型與推理強度（自己指定的優先），並略過它帳號設為不載入的項目，首席 agent、群組分類與調整團隊則用首席 agent 帳號的設定。也涵蓋用假 agent 測試核准（詢問並等待、「本對話都允許」、拒絕時的說明、停止時過期、自動拒絕）、重試回覆、編輯使用者訊息（`resend`：之後的訊息會被刪除，每個 agent 都開新的 session）、附加檔案（以安全檔名儲存、把圖片與路徑交給每個 agent、編輯訊息時保留、隨被刪除的訊息一起刪除、只傳檔案的訊息、錯誤的上傳），以及工具列使用 CLI 到呼叫結束才給的說明。也測試在開源 agent 最近一次執行以外的家目錄執行時（換了 agent 家目錄的資料夾，或回到先前的），會重新開始並清空那裡的資料夾，以及刪除對話時從它待過的每個家目錄移除狀態。也測試成員的模型在 CLI 自己的服務與端點之間移動，或換到另一個端點時，會帶著完整歷史開新的 session，而同一個模型來源的其他模型會接續它（session 會記下它的模型來源）。也測試平行模式下，不論每位成員用哪個 CLI，回覆都依團隊的順序加入。也涵蓋每位成員的狀態 key（每一輪相同、另一個對話中不同、首席 agent 與分群各有自己的），權限提高時以完整歷史開新的 session，並由 orchestrator 清空開源 agent 的狀態資料夾（依 CLI 分別記在資料庫：回到上次以唯讀執行的 CLI 時會清空它的資料夾；資料夾無法清空時這一輪不執行，下一輪再清空；從未記錄的 session 視為唯讀；Claude Code 只開新的 session）、權限降低時接續、成員的狀態隨對話一起移除、這一輪結束後才來的詢問不顯示卡片也不取得目錄鎖就拒絕，以及沒有模型的開源 agent 用它選單的預設模型執行（先用「設定」的預設，成員自己的模型更優先）。
- `test/acp-turn.test.ts`：用假的 ACP agent（`test/fake-acp.ts`）測試共用的 ACP 回合：update 轉成 `AgentEvent`（文字、思考、計畫、工具呼叫與它的類型（ACP 的，或 spec 的 `toolKind`）和輸出、用量與成本）；模型透過 `session/set_model` 或設定選項、推理強度，只在不同時才送出，設定檔已設定時完全不送；依權限設定的 session 模式、被拒絕的值；模型來源的金鑰與家目錄傳到程序、session 的額外欄位；依宣告用 `session/resume` 或 `session/load`（重播的歷史不顯示），接續失敗或無法接續時在說出任何內容前就失敗；權限詢問的詢問、允許、帶留言拒絕並交給模型，或自動拒絕，可編輯模式只詢問推送，agent 不接受原因時由角色說明解釋拒絕，`describeCall` 看得到先前與最近的呼叫（不指明呼叫的詢問），回應之後的 `afterRefusal` 與 prompt 之前的 `afterSession`；檔案與終端機的請求絕不代為執行（拒絕，或依 spec 回應）；`filterUpdate`、`emptyEnv`、`exitGraceMs`；回合結束時收尾還開著的工具列；停止（`session/cancel`）、在 prompt 之前任何一步停止（沙箱檢查、`prepare`、`afterInitialize`、`session/new`、`afterSession`、模式、模型）時不送出 prompt 就結束、正在詢問使用者時被停止的詢問回答 `cancelled`、當掉、agent 自己結束這一輪、逾時；轉接器未完成或模型無法執行時，在任何東西啟動前就拒絕。也測試開源 agent 的程序：沙箱的規格（可寫的位置、唯讀的設定、受保護的路徑、模型來源的主機）、每次執行自己的暫存資料夾（執行後刪除）、proxy 變數只在沙箱中、沙箱無法啟動與原生 Windows 時不執行。以及各個部分：依種類與指令的權限判斷（參數清單讀成它的指令列）、核准卡片（唯讀仍是界線；什麼都沒說的詢問沒有「本對話都允許」）、選擇的選項（絕不選「always」，spec 指定時以 id 選擇）、ACP 格式的 MCP 伺服器、用量、prompt（角色說明、圖片、開頭的 `/`）、待辦工具的計畫。也測試模型拒絕回答的一輪會失敗，它留著沒關的列標為沒有完成。有其他工作目錄的執行會把它們交給沙箱（`extraCwds`）。
- `test/cline.test.ts`：Cline 轉接器：每種模型來源 × 權限的家目錄與這次執行專屬的 `CLINE_DIR`（角色說明的規則檔、全域、MCP 與 provider 設定、feature flag 快取），它的環境變數（本機 session 後端、關掉遙測與 feature flag、只有 `CLINE_API_KEY`、它自己的變數清空）與參數（`--auto-approve`、`--thinking`），沙箱的規格與額外選項；以替身（`test/fake-cline.ts`）重播從真實 `cline --acp` 錄下的訊息（`test/fixtures/cline/`）跑完整的一輪：文字、讀取、`apply_patch` 與 editor 編輯、指令、核准允許與拒絕、自動拒絕、回報為 `completed` 的失敗呼叫、網頁搜尋與擷取、思考、從設定檔載入的 MCP、完全存取、停止（也包括權限詢問等待中：答覆 `cancelled`）、`session/load`（略過歷史、從 session 紀錄讀用量）、接續失敗、錯誤的 key、模型或端點、當掉；它的工具呼叫、輸出與錯誤；從 `session/new` 取得的模型目錄，以及從 `cline config <種類> --json` 取得的自己載入的內容。
- `test/backends.test.ts`：模型來源：`<模型來源>/<模型>` 的 id；沒有金鑰儲存區、有金鑰儲存區（`backend-<id>-api-key`、`endpoint-<id>-api-key`，絕不存在資料庫）時的儲存，把資料庫中的金鑰搬進儲存區並清除，儲存區拒絕或讀不到時，端點數量上限；一次執行的模型來源（模型、只有它自己來源的金鑰、端點、主機），以及模型無法執行時的說明；開源 agent 的環境（用已設定的金鑰取代繼承來的、它自己在資料資料夾或 agent 資料夾中的家目錄）；遮蔽（長的金鑰只露出最後四個字元），以及不論怎麼寫都拒絕把 Harness Relay 自己的位址當成端點；HTTP API（遮蔽的金鑰、設定與移除、端點與會被拒絕的內容）；開源 agent 的狀態（已安裝、轉接器已完成、設定了模型來源；沒有登入）與模型（已設定模型來源的 CLI 清單模型、端點輸入的模型）；端點表單的邏輯。也測試部分失敗的變更（金鑰儲存區拒絕了金鑰，端點仍存下）之後，模型選單與 agent 狀態也會更新。也測試 Claude Code、Codex 與 Grok 在端點上執行：哪些模型在端點上執行（`endpointModel()`；它們自己的 id，帶 `/` 的也一樣，照原樣交給 CLI）、端點的金鑰放在它的變數（繼承來的會拿掉）、送到端點的推理強度、每個 CLI 選單在自己的模型後面列出端點的模型，以及「預設」實際用的推理強度，端點變動後會重新問 Claude Code 的選單；它們的執行拿到端點，絕不拿到 API 模型來源的金鑰。也測試在「設定」刪除的端點：重新啟動後仍記得，直到再新增同 id 的端點為止，會交給 Claude Code、Codex 與 Grok 的執行（不給 Cursor），其中某個端點的模型讓執行失敗（`endpointRunModel()`），其他模型（帶 `/` 的也一樣）照原樣交給 CLI；不包括 Cursor（選單沒有端點的模型、執行拿不到模型來源，端點變動時也保留它的選單，而 Claude Code、Codex 與 Grok 每個帳號的選單都會丟掉）；以及開源 agent 的環境沒有 `CURSOR_API_KEY`，Cursor 的環境則保留。也測試已刪除端點的 id 會列在 view 裡，要求時會被忘掉（路由也一樣：沒記著的回應 404，id 不對回應 400），讓開頭相同的 CLI 自己的模型再交給它；以及重新新增端點卻存不進去時，仍記著它已被刪除。這樣存不進去之後，端點也不會留在記憶體裡；之後再新增時，記憶體與磁碟上它的 id 都會清掉。新增或修改存不進去時，記憶體與金鑰儲存區都不保留任何改動：新增的端點的金鑰不會留下，修改的端點與金鑰維持原樣。也測試修改端點失敗、但已取代了啟動時金鑰儲存區給不出的金鑰時，端點顯示為沒有金鑰，而不是讀不到（儲存區連新金鑰也拿不掉時，警告會說儲存區仍留著那把金鑰，而不是金鑰已經不見）；沒動金鑰的修改則仍標示為讀不到。
- `test/openhands.test.ts`：OpenHands 轉接器：這次執行自己的家目錄與設定（每種模型來源 × 權限寫一整個 agent，檔案裡沒有金鑰，subagent 只在完全存取時才有，工具庫放在 `mcp.json`，終端機 shell 的 `.bashrc`，tmux 或一般的虛擬終端機，專案 `.env` 可能設定的變數），清掉它的 tmux 伺服器，它的核准（先宣告的呼叫、涵蓋好幾個呼叫的請求除非權限涵蓋全部否則會詢問、沒有先宣告呼叫的請求絕不自行允許、恢復前拒絕先前回合留下的動作、完全存取以外拒絕 subagent、它自己的選項 id），它的 update（列、清理過的思考與回覆、從 observation 取得的結果、用量扣掉 session 先前的累計），它的錯誤，從真正的 CLI 重播的回合（`test/fixtures/openhands/`），它的 LiteLLM 模型清單，以及它自己載入的內容。也測試只是看起來像它通知失敗的訊息會先暫存，等後面又有東西送來或 prompt 回覆時，在原本的位置顯示。也測試指令輸出裡終端機的控制序列（bracketed paste、顏色）會被拿掉。在 Windows 上它的家目錄也是它的 `USERPROFILE`。
- `test/relaySandbox.test.ts`：離線測試 Harness Relay 自己的沙箱：各權限能寫入哪裡、受保護的路徑與設定路徑、各個開口（虛擬終端機、只在 macOS 上的這次執行的 Unix socket 與 trustd、默默拒絕的主機、只連線的連接埠）、每次執行自己在私有根目錄裡的設定與 host 暫存資料夾讀得到、伺服器從不查詢主機名稱（名稱與其他主機一樣詢問、字面上的本機位址不詢問就拒絕）、失敗訊息只說一次（只在 Linux 上指名套件）、模型來源的主機（loopback 與本機的目的地、這台電腦上必須寫出埠號、絕不是 Harness Relay 的埠）、執行前的拒絕（會被當成樣式的路徑、Harness Relay 或家目錄裡的可編輯模式、包含決定 agent 怎麼執行的東西的可寫資料夾）、環境變數（只有 loopback 不經過 proxy，模型來源在 loopback 上時則只有 agent 自己的連接埠不經過，proxy 只在 macOS 上放行它們）、透過正確那次執行的核准詢問主機並讓兩次執行互不干擾、執行用的資料夾與它的標記檔、啟動時清掉被強制結束的伺服器留下還在跑的程序、agent 透過固定的啟動 script 執行而參數與變數放在環境變數（實際執行過）、host 程序與它的控制通道，執行 host 的 Node（伺服器自己的，或桌面 app 裡 `PATH` 上的那個），以及無法啟動就不執行（原生 Windows、缺少的程式、`PATH` 上沒有夠新 Node.js 的桌面 app、沒有 seccomp 輔助程式的處理器）。它從不啟動真正的沙箱：那是 `scripts/sandbox-check.ts` 做的事。也測試本機位址的其他寫法（`127.1`、`2130706433`、`0x7f.0.0.1`、`0177.0.0.1`、結尾的點、`0`、寫成數字的 metadata 位址）會讀成 proxy 實際連的位址，不詢問就拒絕，名稱不論大小寫只問一次；host 的暫存資料夾在資料夾的 `srt/` 裡，路徑太長放不下它的 socket 的資料夾會被拒絕（不放到系統的暫存資料夾）；清掃發現有留下的行程或無法判斷時，啟動時的清理保留一切、不恢復任何權限。也測試在 Linux 上，這次執行可以連的 loopback 埠會經代理轉接到沙箱自己的 loopback（固定的啟動腳本以環境變數中的埠、socat 的路徑與這次執行解碼過的代理憑證啟動 `socat`），以及這些埠取自這次執行的主機。也測試可編輯模式下，專案的 `.cursor` 資料夾和其他 agent 的設定一樣維持唯讀（`PROJECT_AGENT_CONFIG`）：沒有沙箱的 Cursor 會讀到放在那裡的規則、subagent、skill 或 MCP 設定；Antigravity 的 `.agents` 與它的其他寫法（`.agent`、`_agents`、`_agent`）也一樣，它會在沙箱外執行那裡的 hook 與 MCP 伺服器。也測試對話的其他工作目錄（`extraCwds`）：只在可編輯模式下和第一個一樣可寫，每一個的專案 agent 設定唯讀，第一個會被拒絕的情況，每一個也都會。也測試和語音輸入資料夾重疊、這次執行可寫入的資料夾會被拒絕，訊息說出那個資料夾。
- `test/sandboxProcs.test.ts`：在 macOS 上依沙箱找出 relay 沙箱某次執行的行程：從 `ps` 取得這個使用者的行程、透過系統的 Python 問核心這次執行自己的資料夾與外面那一層資料夾、不是 macOS 或沒有命令列工具時無從判斷（這時處理掉一次執行只剩標記檔清掃；伺服器啟動則保留被殺的執行留下的資料夾）、已消失的資料夾、分輪殺到一個都不剩（被殺時又 fork 的行程），以及 Apple silicon 上呼叫可變參數的 `sandbox_check` 的方式。
- `test/relaySandbox-queued-ask.test.ts`：回合結束後，relay 沙箱排在另一個詢問後面的網路詢問會被拒絕，不會拿去問使用者（搭配真的 orchestrator：沒有留下等待中的卡片，也沒有留下被拿走的目錄鎖）。
- `test/relaySandbox-leftovers.test.ts`：在 macOS 上，處理掉一次執行時會先清掉還握著它標記檔的程序再刪掉標記檔（host 可能在自己清掃前就被殺掉），啟動清掃也依標記檔找到它們；在 `sandboxCommand` 中失敗的執行不會留下標記檔。
- `test/opencode.test.ts`：OpenCode 轉接器：以真實 CLI 錄下的訊息重播回合（`test/fixtures/opencode/`，由 `test/fake-opencode.ts` 的假 `opencode` 播放：文字、思考、工具與它們的列、待辦清單轉成計畫、各權限的核准、`fs/write_text_file` 只回覆不照做、停止、接續與接續失敗、錯誤的 key 與模型、MCP 伺服器）；它的家目錄（變數、維持原樣的唯讀設定資料夾、從它的資料庫清掉 console 帳號、session 的權限規則與已儲存的權限）、各模型來源與權限的執行設定（跳脫 `{env:}` / `{file:}`）、專案的指示檔、模式／模型／推理強度的順序、透過它的伺服器傳回拒絕理由、這一輪在 session 花費中的部分、它的錯誤訊息、它的模型目錄與它自己載入的內容。也測試每次執行前從它的資料庫清掉 session 的權限規則與已儲存的權限，為了放回它們而植入的 trigger 與 view 會被移除（留住它們的 generated column 會讓它丟出錯誤），清不掉時這位成員的狀態會清空重來；續行與 `function NAME` 開頭照 OpenCode 的方式讀；以及 `relay-shell` 只在分得清單引號範圍時，才在單引號以外找會重新求值的寫法（`awk -F= '/^[A-Z_]+=/ {print $2}'` 可以執行；宣告指令或 `let` 有引號的參數、雙引號或註解裡的引號、沒有關上的引號仍會被擋；`let`，以及旁邊有含 `$` 的方括號時的 `$(( … ))`，算是會重新求值的寫法，旁邊只有引號裡的 `$` 時 `$(( … ))` 照常執行）。也測試在 Linux 上、完全存取以外，任何東西啟動前就被拒絕（在那裡無法監看它的伺服器）。在 Windows 上它保留自己的 shell（設定裡沒有 `relay-shell`）。
- `test/orchestrator-workspace.test.ts`：有編輯權限時的工作目錄：在 Harness Relay 自己的資料夾拒絕編輯模式的回合（加入這項檢查之前存的對話也一樣）、平行模式的 worktree 隔離與套用、圓桌模式的修改紀錄（agent 自己 commit 的回合也一樣）、目錄鎖（也包括一個 repository 和它裡面的另一個），以及保留的快照 ref 隨連到它們的訊息、隨對話一起刪除。
- `test/orchestrator-folders.test.ts`：多個工作目錄：每位 agent 都會拿到全部（`addDirs`），每一個都會變成 repository，一輪的修改在每一個都會記錄，diff 合成一份並標出資料夾；這段期間其他對話無法寫入其中任何一個；平行模式下每位 agent 在每一個都有 worktree，套用時全部套用，其中一個有衝突時都不套用；移除的資料夾，它的 worktree 會在下一次平行執行時移除。一個在另一個裡面的資料夾不論誰先，都成為同一個 repository；從清單移除的資料夾，它的 worktree 既不套用也不出現在 diff 中，資料夾不見了也一樣；第二個 repository 保留的快照會隨對話一起刪除。唯讀執行中允許的動作會鎖住全部，另一個對話寫入其中一個時會告訴排程，有一個無法拍快照時仍記錄其他的修改，在套用了一份 patch 之後另一份失敗時，worktree 會標記為需要重設。
- `test/orchestrator-team.test.ts`：首席 agent：用假的首席 agent 測試自動組隊（自訂設計等待確認，確認後團隊回答問題，並一併收到期間寫的訊息；手動設定團隊也算確認；存成範本；使用範本；備援方案，有團隊時保留目前的團隊；每個新問題都依到目前為止的對話與目前的團隊設計，留下來的成員保留 session；回答、@ 成員的訊息、「繼續」與重試都由目前的團隊接手；不必確認、立刻採用的團隊，以及它無法開始時（對話中說明原因，按「繼續」由團隊回答，不重新設計）；設計等待確認時保留目前的團隊（重試較早的回覆、不採用設計、第一個問題沒有團隊可保留）；對話被佔用時拒絕確認；沒有任何回合接手的插話與 @ 成員的編輯交給目前的團隊，而「停止並改問」會重新設計；設計被停止後按「繼續」重新設計；編輯問題後重新設計，並以之前的內容作為歷史；以及規劃時不上鎖），以及團隊確認後依它的模式上鎖。也測試首席 agent 設計團隊時，留任的成員保留使用者設定的工具與帳號，新成員不論首席 agent 指定什麼工具都用 CLI 的預設；以及首席 agent 的資料：設計團隊時為對話的資料夾收集，調整團隊時為抽屜裡的資料夾收集，prompt 裡有各 CLI 的工具。也測試首席 agent 依使用者的要求修改團隊（`reviseTeam`：回傳整個團隊，prompt 中有要求與對話，留下來的成員保留 id，對話本身不變，等待中的設計繼續等待；讀到團隊設定裡的權限與資料夾，但在已儲存的資料夾執行（同一個資料夾換個寫法不算別的資料夾）；只在排程開啟時提供排程訊息；針對排程的等待中設計（排程關閉時仍提供它的訊息）；用 `was` 改名的成員保留 id；婉拒時保留團隊；拒絕空的或無法使用的要求與回覆，以及團隊設定裡無效的名字；首席 agent 的 CLI 失敗；它的 session 在 AgentsView 中連到對話；請求關閉、有更新的要求或刪除對話時停止；被取代的要求在刪除對話時也會等到首席 agent 的程序結束；關閉伺服器時停止，並等到首席 agent 的程序結束，之後拒絕新的要求）。也測試上限調低之前存的隊伍仍可交給首席 agent 修改（回答會截到上限；比上限和已存隊伍都大的草稿會被拒絕）。也測試用假的首席 agent 測試把新對話分到群組（只看第一則訊息、與團隊同時進行、沒有群組時不詢問、不蓋過使用者的移動、刪除對話時停止）。
- `test/orchestrator-branch.test.ts`：分支對話（複製的訊息換上新 id，團隊、設定與群組一起複製，agent 開新 session 並收到複製的紀錄；團隊回覆中也能分支，但之前還有回覆在串流時不行；附加檔案的複製與保存的 diff 在原對話刪除後仍在；重試會把分支點移回，編輯到一則不剩時移除；那則回覆提的問題在分支裡仍然等待回答，在原對話答過也一樣，各模式皆然；平行模式同伴的回合還在記錄改動時不能分支；刪除原對話與關閉伺服器會等檔案複製完，不在的檔案略過，複本只有擁有者可讀；平行模式回覆的圖片來自做出它的 worktree；分支以在裡面寫的第一則訊息命名，在佇列裡等待的訊息也一樣，只在它還是建立時的名稱時，任一種語言皆可；編輯到複製的訊息都不剩時改以編輯後的訊息命名，除非使用者自己取過名稱；原本的對話還在分類時做出的分支，會一起被帶進它的群組；從分支複製過來的回覆（包括分支點那則與較早一段的最後一則）分支，做出的是寫出那則回覆的對話的分支，往上兩層也一樣，以它現在的標題命名並列在它底下，它之前的段落保留下來（`earlier`）；那個對話刪除後，用側邊欄顯示的標題並帶上它的 `via`，在分支複製檔案期間被刪除也一樣，讓這一串仍在一起；重試或編輯讓分支裡不剩它分支自的對話的訊息時，它成為更上層那個對話的分支，除非使用者自己取過名稱，否則改用那個對話現在的標題命名，複製的訊息一則都不剩時就不再是分支；單獨測試 `branchOrigin()` 與 `branchAfterCut()`，無法定位的段落會被略過）。
- `test/orchestrator-schedule.test.ts`：排程（用假時鐘的 `Scheduler`）：到期時送出訊息、標為排程訊息並讓 agent 知道、只送一次並算出下一次；排程開始的執行自動拒絕核准（顯示為已拒絕的卡片），對話中一律允許的動作除外，除非排程設為詢問；使用者在排程執行中寫訊息、或排程送出時一併送出使用者自己等待中的訊息時，又會照常詢問；團隊回覆中放進佇列，並在前一則還在等待或佇列已滿時先不送；停止後留在佇列的排程訊息在下一次時間送出，只送一次；沒有回合接走的排程訊息另開一次執行，仍然自動拒絕核准；團隊在等回答（先前的排程訊息也在等待時亦同）或還沒確認團隊時先不送，在自動組隊的對話中由目前的團隊接手、不重新設計，而且永遠不會被當成回答（回覆、繼續、排程訊息中的 @），回答之後仍留在佇列，直到它指定的 agent 發言（圓桌與接力），而排在它後面、使用者自己的訊息會和回答一起送出（打字回答、繼續、指定另一位 agent 的排程訊息）；錯過的時間略過（留下說明）或晚一點補送一次，重複的排程錯過多次也只補一次，一次性排程送出後關閉；設定變更占用對話或另一個對話正在修改同一個資料夾時再試（已經晚了也一樣，而且使用者這時送出的訊息不會留在佇列裡），超過重試時間後放棄；對話設為自動拒絕時直接拒絕、不顯示卡片；平行模式中使用者寫訊息後又會詢問；送出途中伺服器停止時不記錄；送出途中被換掉的排程保持原樣；讀不懂的已存排程被刪除；無法開始的執行；以及已刪除的對話不會送出。每次開新對話的排程：開一個團隊、設定、「本對話都允許」的動作與群組都相同的新對話（首席 agent 不會為它分類），以時間命名，裡面有說明與排程訊息，每次 agent 都開新的 session；那裡同樣自動拒絕核准（除非排程設為詢問），使用者寫訊息後改為詢問；不管排程所在的對話在做什麼（等回答、回覆中）都照送；排程所在或其他對話在同一個資料夾寫入時會等待；團隊還沒確認時不開對話，無法開始時不留下對話；「立即執行一次」會說它開了哪個對話；排程所在的對話還沒命名時，以訊息命名新對話；那個對話被刪除時忘掉連結；準備期間伺服器開始關閉時刪掉新對話；從「其他」裡的對話開的新對話不會被分類；平行模式有自己的 worktree。首席 agent 為排程組的團隊（`designForSchedule`）：為沒有人貼出的排程訊息組隊，並被告知這是排程（在這個對話或每次開新對話）；確認、直接採用（`autoConfirm`）或手動設定團隊後都不會執行，但會回答等待期間使用者寫的訊息；之後排程訊息交給這個團隊；團隊還在設計或等確認時到期的時間會再試（`busy`），確認後就送出；之後在那個對話提出的問題照常組隊；沒有排程、沒有自動組隊、已有設計在等確認，或已經有團隊時不組隊。
- `test/grok.test.ts`：Grok 的 ACP 轉接器：各權限的核准規則、session 更新轉成 `AgentEvent`（後端網路搜尋與 X 搜尋查了什麼，依 grok 1.0.77 送出的格式從結果取得：查詢、開啟的網頁或在網頁中找的文字；失敗的搜尋保留查詢與原因；`read_file` 讀的檔案與 `list_dir` 列出的資料夾）、JSON-RPC 連線。也測試工具庫的 MCP 伺服器轉成 ACP 的格式（`acp.ts` 的輔助函式，Cursor 也共用）。HTTP MCP 伺服器只傳給宣告支援的 Grok。也測試不載入 Grok 從 Claude Code、Cursor 載入的內容（skill、MCP 伺服器、hook）與它的記憶所用的環境變數，以及它們和使用者的環境變數、sandbox 並存（唯讀與可編輯模式為 `harness-relay`，Windows 上為 `workspace`，完全存取時不設定）。也測試在使用者自己的端點上執行：`config.toml` 裡模型的區塊（`grokModelsBlock()`：隱藏、金鑰從 `HARNESS_RELAY_ENDPOINT_API_KEY` 取；放在使用者的設定之後、原地取代、最後一個端點刪掉時拿掉），只在有回合用到時才寫入，保留檔案權限並跟著連結寫，變動時執行中的回合照寫入後的樣子接受，以及用替身 `grok agent stdio` 跑一次：用 Grok 給它的 id 選模型、不送推理強度、帶端點的金鑰。也測試為端點輸入、但不在它清單裡的模型，那次執行會有它自己的 table，以及已刪除端點的模型在 Grok 啟動前就失敗。也測試用到自訂模型的執行還在進行時，同一個家目錄裡每次重寫區塊都會保留它的 table，直到最後一個這樣的執行結束，而且只在那個家目錄。只對仍設定著的端點；以完全存取跑整個執行時，回合串流期間 table 都在，回合結束後才放掉。有其他工作目錄的執行會有依它們命名的專用設定檔（`read_write`），在 `sandbox.toml` 中主要設定檔旁邊，只保留最新的 32 個；一輪進行中寫入的另一個對話的設定檔不會被當成指令做的修改，而指令在任何區塊中的寫入仍然算。進行中的一輪正在用的設定檔絕不會被刪；`grokRunner.run` 會把執行專用的設定檔寫進 Grok 的家目錄，並以它啟動 Grok（替身 `grok`），結束後放開。較晚的回合在放回較早回合的指令對 `sandbox.toml` 的改動之後寫入的自己那幾個資料夾的設定檔，或寫到一半失敗時寫下的內容，都算 Harness Relay 自己的：不會被放回，也不會被說成改動，它的寫入把指向不存在檔案的 `config.toml` 連結換成檔案時也不會；但它寫入期間指令做的改動仍然會被說成改動。Grok 重寫設定時（丟掉標記）留在區塊外的模型表格會被拿掉，所以不會重複定義，沒有回合加入區塊時也一樣（區塊會重新寫成最新的）。
- `test/cursor.test.ts`：Cursor 的 ACP 轉接器，它沒有沙箱：各權限的核准規則（完全存取以外，每個指令與 MCP 工具呼叫都會詢問；網路擷取、網路搜尋（subagent 的也是）與讀檔照常執行；可編輯模式下只有工作目錄裡的刪除，指向外面的連結以它指向的地方為準，而 Cursor 詢問的每個寫入，包括工作目錄裡它受保護的檔案，都會詢問），Cursor 詢問的內容（指令取自它的工具呼叫，路徑取自輸入、diff 或標題），略過它自己的提問（agent 透過 Harness Relay 問使用者），以及 session 更新轉成 `AgentEvent`（文字、思考、計畫、帶輸出與結束代碼的指令、Cursor 說出是哪個檔案後的編輯檔案、以標題顯示的 MCP 工具、被拒絕的呼叫、唯讀模式下顯示為沒有做的寫入與刪除、不放進回覆的服務錯誤，包括「Add a payment method」與「Check your settings」）。也測試這次執行私用的設定（帳號自己的設定，沒有允許規則，加上使用者與 Harness Relay 的拒絕規則，以及核准模式）、各權限的拒絕規則、參數與環境變數、私用的設定資料夾（只有擁有者能存取、連到帳號 session 的連結、只移除它自己）、放在 prompt 最前面的說明（新的 session，之後只在變更時），以及 Cursor 的模型清單（推理強度取自各模型自己的選項，不是思考開關）。並用替身 `cursor-agent` 測試整個回合：新的 session 在它私用的資料夾、收到說明、詢問一個指令；接續的 session 不含它重播的歷史、不再送同樣的說明，並使用指定的模型與推理強度；略過模型沒有的推理強度，Cursor 拒絕的模型讓回合失敗；完全存取時帶 `--force`；有 API key 時不 `authenticate`；服務錯誤，以及無法載入的 session（因此會改用新的 session 重試），都讓回合失敗；未登入的 Cursor 的錯誤，不附它的登入連結；停止一個回合（取消 session、移除私用的資料夾）；無法建立的設定資料夾讓回合在開始前就失敗；透過 ACP 詢問 Cursor 的模型（不開 session 也不送 prompt、有金鑰時不 `authenticate`、找不到 CLI）；會被它的規則當成樣式的受保護路徑讓執行拒絕啟動。也測試 Cursor 詢問寫入時的卡片：在工作目錄外的會這麼說，工作目錄內的則說 Cursor 為什麼保護這類檔案。也測試家目錄裡的路徑（`~/…`、`~`）以家目錄為準：可編輯模式不核准刪除它，寫入它的卡片說它在工作目錄外。工作目錄在家目錄裡時，其中的 `~/…` 路徑仍算在工作目錄內；以 `~` 開頭但不是 `~/…` 的名稱（`~notes`），或路徑後段的 `~`（`a/~/b`），則照原樣看待。在對話的其他工作目錄（`addDirs`）裡，可編輯模式也核准刪除；Cursor 在那裡詢問的寫入交給使用者，卡片說它在另一個工作目錄。
- `test/antigravity.test.ts`：Antigravity 的 ACP 轉接器，它沒有 Harness Relay 能用的沙箱；用真正的 `agy acp` 1.5.6 送出的訊息（`test/fixtures/antigravity/`，已去除個人資訊；它的清單在 `cli/`），透過替身 `agy`（`test/fake-antigravity.ts`）重播：各權限的核准規則（唯讀時讀檔，不論在不在工作目錄裡，以及網路搜尋照常執行，寫入、指令與其他動作都詢問；完全存取以外，受保護的路徑不詢問就拒絕；可編輯模式下對話工作目錄裡的寫入照常執行，指向外面的連結以它指向的地方為準，寫到其他地方（包括 `~/…`），或寫到可能改變 agent 之後如何執行的地方（`.agents` 與它的其他寫法、`.gemini`、`.claude`、`.cursor` 與其他 agent 的資料夾、`.vscode`、`.mcp.json`、`.envrc`、`.git/hooks`、`.git/config` 與 submodule 的，不分大小寫，結尾多了點或空白也一樣）都會詢問，每個指令也都詢問；呼叫指名的每個路徑都納入判斷，看不出路徑的讀取會詢問；完全存取時全部核准）、核准卡片（指令一旦允許就在沙箱外執行；寫入會說明為什麼詢問），以及 session 更新轉成 `AgentEvent`（思考與回覆、每個呼叫只顯示一次、去掉 agy 放在前面那幾行的指令輸出、非零的結束代碼顯示為失敗、被拒絕的呼叫的原因、被停止的呼叫的列、結束後才回報的呼叫）。也測試這次執行自己的設定（只有帳號的模型與服務，加上 `toolPermission: "request-review"`、完全存取以外的 `allowNonWorkspaceAccess: false`、預設模式，有 Gemini API key 或帳號只用自己的金鑰時加上 `modelProvider: "gemini"`）放在帳號 CLI 資料夾裡、這次執行專屬且只有擁有者能存取的資料夾，結束後移除，帳號自己的檔案維持原樣；伺服器在某一輪進行中停止時留下的資料夾，超過一輪可能的最長時間後會被移除，但仍在使用中的絕不移除；專案讓 agy 自己執行的東西（從每個工作目錄往上到它的 repository 根目錄，客製化資料夾裡的 MCP 伺服器、hook 與 plugin，以及它們的指紋）；agy 留著執行的指令（讀取 `ps`、agy 的指令所在的 process group，以及其中在這一輪中啟動的行程）；參數（`--gemini-dir`、`--cli_dir_name`，完全存取時 `--dangerously-skip-permissions`），以及向它詢問事情的指令的環境變數（帳號的家目錄當成 `HOME`，Windows 上是 `USERPROFILE`，不開瀏覽器）；放進它系統提示的說明（新的 session；接續的 session 只在變更時；agy 不接受放進系統提示時放在 prompt 最前面；附上被拒絕會結束它這一輪、以及用 Harness Relay 的方式問使用者的提醒）；它的模型（每個基本 id 一個，推理強度取自 id 結尾的思考程度；帳號的預設模型；只設定 session 提供的思考程度）；它自己載入的內容（skill、不含指令的 hook、自訂 agent 與 plugin 取自它自己的回答；MCP 伺服器只取名稱、指示檔取自它會讀的檔案，專案的在前）。並用替身測試整個回合：新的 session 使用它自己的設定，設定模型與思考程度，說明放進系統提示，每個指令都詢問；接續的 session 只在說明變更時再送一次；唯讀模式下詢問寫入並被拒絕，顯示拒絕的留言，這一輪就此結束；對話設為自動拒絕時自行拒絕；受保護的路徑不詢問就拒絕；完全存取時什麼都不問；在 agy 啟動前詢問專案自己的 MCP 伺服器、hook 或 plugin，被拒絕（或自動拒絕）時這一輪不開始，完全存取時什麼都不問；預設帳號以外的帳號只用自己的金鑰；未登入的 agy 的錯誤會說要登入；agy 拒絕的模型、思考程度或預設模式、agy 自行取消的回合，以及沒有 id 的 session，都會清楚地失敗；處於其他模式的 session 改回預設模式，只在模型提供時才送出思考程度；送出其他工作目錄、MCP 伺服器與圖片，並忽略其他 session 送來的內容；停止一個回合（取消 session，這次執行以停止結束）；無法建立的設定資料夾讓回合在開始前就失敗；用 agy 的 ACP `logout` 在帳號的家目錄登出，以及登出失敗時說明出了什麼錯。
- `test/goose.test.ts`：Goose 轉接器，使用 Goose 1.58.1 錄下的訊息（`test/fixtures/goose/`）與重播它們的假 `goose acp`：它的家目錄（`GOOSE_PATH_ROOT` 與 `HOME`，關閉金鑰儲存區、遙測與 session 命名），以及各種模型來源與權限的環境變數（provider、模型、模式、擴充、plugin、指示檔；拿掉繼承來的）；執行前寫入的檔案（端點寫成 provider 檔、金鑰絕不寫入；空的 `permission.yaml`；讓指令拿回使用者 `HOME` 的 shell 包裝：固定的文字、值放在環境變數，實際執行過）；`session/load` 之後依序重新設定 provider、模型、推理強度與模式；以 `system-prompt/set` 傳角色說明；從 Goose 的工具名稱判斷種類（用於權限，以及 AgentsView 紀錄中每個呼叫做的事）、唯讀模式下只讀取的 shell 指令、各權限的判斷與核准卡片、只回答 `allow_once`／`reject_once`、以 `session/steer` 把拒絕的理由交給模型、subagent 的呼叫在上層 session 底下詢問；從錄下的訊息把 update 轉成事件（讀取、編輯、指令、思考、todo 筆記成為計畫、被取消的呼叫）；從 Goose 的 session 總和算出這一輪的費用；金鑰、模型或端點有誤時的清楚錯誤；接續失敗；取消；Harness Relay 沙箱的選項（只在 HTTPS 時開 `allowTlsTrustd`、靜默拒絕的主機、本機 MCP 連接埠）；模型目錄與它自己載入的項目。也測試接續的 session 自己的那一列：新 session 在 `session/new` 之後封存的擴充清單，會在接續前放回（植入的 stdio 擴充功能與執行不會拿到的平台擴充功能會被拿掉，其他資料保留），沒有封存時只留它的平台擴充功能，Harness Relay 從不設定的欄位會清掉，封存資料夾隨狀態資料夾清空，為了寫回清單、或在新 session 封存前改掉它那一列而植入的 trigger 會被移除，讀不了或改不回來（generated column）的那一列會讓這位成員的狀態清空重來，不接續那個 session。在 Windows 上它保留自己的 shell（沒有包裝，也沒有包裝的變數）。
- `test/pi.test.ts`：用假的 `pi --mode rpc`（`test/fake-pi.ts`）與錄下的 Pi 訊息（`test/fixtures/pi/`，已清理）測試 Pi 轉接器：家目錄（保留 session、每一輪全新的 agent 資料夾且每個設定檔唯讀、關閉會載入程式碼的快取）、各種模型來源的 models.json（端點的金鑰透過變數、Pi 目錄沒有的模型）、秘密值放在變數裡的 mcp.json、各模型來源與權限的參數（唯讀的工具、gate、角色說明、接續、不載入指示檔）；只以 LF 分隔的格式；gate 擴充功能本身（`src/server/agents/piGate.js`）：每個呼叫都詢問、依權限判斷、使用者的留言交給模型、遇到問題一律拒絕、沒有它就不執行、停止時讓等待中的核准過期；各模型來源錄下的執行轉成的事件（文字、思考、讀取、帶 diff 的修改、bash、各內建工具的類型、失敗、被拒絕的呼叫、MCP 工具）、用量與費用；以 session 檔案接續（不見了、換了資料夾、另一個 session）、重設模型、先確認推理強度；停止、模型來源的錯誤說明（金鑰、模型、端點）、Pi 無法啟動、沙箱的原因、逾時；它的模型目錄與指示檔。
- `test/claude.test.ts`：Claude 預先允許與移除的工具、它的參數（`--system-prompt-snapshot off`、舊版不接受的旗標），以及工具被拒絕時顯示的原因。也測試完全存取以外的沙箱（原生 Windows 除外）：`--settings` 中的 `sandbox` 與詢問規則，以及它們和這一輪不載入的內容並存；沙箱要連的主機以讀取網頁的形式詢問；哪些允許的指令會在沙箱外執行（沙箱無法寫入的路徑，或模型自己要求的；工作目錄中的檔案不會）；以及沙箱無法執行時的訊息。也測試工具庫：`--mcp-config` 檔案與 skill 資料夾的 `Read` 規則（完全存取時不加）、Windows 路徑的 `Read` 規則，以及 `--mcp-config` 的內容。也測試不載入 Claude Code 自己的內容：skill 與 MCP 的旗標（工具庫的 `--mcp-config` 會保留）、指示檔與記憶的環境變數、用 `--settings` 關掉 hook 與每個已安裝的 plugin、讀取 `claude plugin list --json`，以及在送出 prompt 前拒絕它自己的 subagent（依名稱與說明，只拒絕非內建的；做不到，或 `initialize` 沒有列出 subagent 時，不送 prompt、直接失敗）。也測試用 `--settings` 不載入個別項目：skill（`skillOverrides`）、指示檔（`claudeMdExcludes`，路徑寫成只符合那個檔案，並用 picomatch 依 Claude Code 的比對方式驗證）、內建工具、MCP 伺服器與工具（依 Claude Code 的命名）與 subagent 的拒絕規則、依 id 關掉 plugin、整類不載入時不再加個別項目（subagent 與 plugin 除外）、工具庫給這次執行的伺服器不加規則，以及用 `--tools ""` 關掉所有內建工具。執行透過替身 `claude`（`test/fake-claude.ts`，依 Claude Code 2.1.319 的回答格式）測試：關掉 hook 與 plugin、用放在私有檔案（在 Harness Relay 自己的暫存資料夾，不是系統的；執行後刪除）的 `--settings` 不載入個別項目並立刻送出 prompt、送出 prompt 前拒絕 subagent（包括取代內建 subagent 的同名 subagent）、無法不載入 subagent 或 plugin 時清楚地失敗、等待中按下停止、舊版不接受某個旗標時不帶它重試、完全存取以外開啟沙箱，以及沙箱無法執行的情況。也測試工具列超過 160 個字的說明：路徑（`file_path`、Grok 的 `target_file`、資料夾）保留結尾與檔名，其他的保留開頭；核准卡片顯示完整路徑。也測試在使用者自己的端點上執行：它拿到的變數（`claudeEndpointEnv()`：去掉 `/v1` 的網址、以 bearer token 傳的金鑰或 `no-key`、沒有 Anthropic 金鑰、登入 token 或雲端供應商、所有請求都用這個模型），放在這一輪的 `--settings` 與環境變數，以及用替身跑一次：模型本身的名稱、不送端點可能不接受的推理強度、不顯示費用。也測試已刪除端點的模型在 Claude Code 啟動前就失敗。其他工作目錄以 `--add-dir` 給它（也在沙箱可寫入的範圍內）。它的 PowerShell 工具（Windows）也和 Bash 一樣以指令詢問。
- `test/templates.test.ts`：判斷範本編輯器有沒有修改範本（成員 id、前後空白與空的選填欄位不算；名稱、說明、成員、模式、輪數與交棒次數都算）。
- `test/copy.test.ts`：複製單則訊息或整段對話時產生的 Markdown（兩種語言）；說明首席 agent 選了哪個團隊的那一行（保留、備援、調整），以及註明未採用的設計；單則訊息照原文複製（網址、格式、CRLF 換行），沒有剪貼簿 API 時也一樣。也測試排程訊息 @ 了團隊沒有的名字時，排程表單、團隊編輯器與團隊卡片怎麼說（改由誰回答，兩種語言），以及卡片什麼時候檢查。也測試首席 agent 對團隊的每一種修改怎麼用文字說明（兩種語言）。
- `test/report.test.ts`：用電子郵件回報問題：一起附上的資訊（版本與執行方式、系統、瀏覽器、各 CLI 的版本、語言；絕不含路徑或帳號），以及伺服器說不出時少了哪些；主旨（照輸入的，沒有就用內容的第一行，以完整字元截短）、內容、整份可複製的報告；mailto 連結（CRLF 換行）與 Gmail 連結，報告太長放不進時改放一句請使用者貼上的說明，連那句都放不下時把主旨縮短；有上傳截圖時放截圖的連結，取代「拖進信裡」的說明，以及哪些圖片可以加入（PNG、JPEG 或 WebP，最多 5 張，每張 10 MB；不接受 GIF，也依檔名不接受 `.jfif`）；伺服器說不出的資訊會在信裡註明；什麼情況算寄出（`countsAsSent`：透過郵件程式、Gmail、剪貼簿或「複製內容」，剪貼簿寫入失敗時不算），寄出後才上傳的截圖會被指出（`uploadUnlinked`），以及寄出後的說明什麼時候說信裡附上了截圖的連結（`sentLinks`：只限寄出的信連到的那次上傳，不含寄出後才上傳的，以及 `ShotUploads.linkedId`）；對話框允許的操作（`reportState`：寄出要等資訊載入、截圖上傳或移除、上傳或刪除結束）；截圖的上傳（`ShotUploads`）不論要求幾次都只上傳一次、報告寄出後才完成的上傳不屬於任何報告（它的 gist 會被刪除）、上一份報告的刪除不會影響下一份的上傳（也不會重複刪除同一個 gist）、報告結束時保留最後寄出的信（或複製成功、也算寄出的報告）連到的上傳，刪除沒有信連到的上傳、和對話框分開保存、失敗後可以再上傳、刪除後（包括伺服器已不認得它時）或報告寄出後就忘掉，刪除失敗時保留。
- `test/screenshots.test.ts`：回報問題的截圖：只依開頭的位元組認出圖片；上傳前只保留顯示必要的部分（JPEG 到結束標記為止的影格、表格與掃描，沒有 EXIF、XMP、IPTC、內容憑證、MPF、JFXX、註解或之後的動態照片；漸進式 JPEG 的各次掃描與之間的表格；只留旋轉方向，兩種位元組順序都可以，不論有幾個 EXIF 區段都只留一個，方向正常時不留；跳過區段之間的多餘位元組；PNG 到 IEND 為止的顯示用區塊，沒有 EXIF、文字、時間、內容憑證、私有區塊或之後的資料；WebP 在 RIFF 大小之內的影像與 ICC，並重設旗標與大小；JFIF 標頭不含縮圖；動畫 WebP 的影格只留影像需要的部分；PNG 的旋轉方向放進附 CRC 的最小 EXIF）；影像開始後才中斷的圖片會在中斷處補上結尾（在掃描中或之後中斷的 JPEG、在影像資料中中斷的 PNG），不完整的 WebP 會被拒絕，不接受 GIF；保留與丟棄交錯的構造檔案也很快處理完，依序寫進同一塊緩衝區（`Kept`，新產生的資料超過原圖大小時會擴充）；影像開始前就讀不懂結構的會被拒絕並說明是哪一張；不是它所說結構的 EXIF 讀不出旋轉方向；依順序與種類命名，不用原本的檔名；拒絕沒有、太多、不是 base64、不是圖片或太大的截圖，並說明是哪一張；用 git 推進一個 secret gist（假的 `gh` 與 `git`），不讀回檔案的 raw 網址，上傳失敗時再刪除並以截圖說明原因（刪不掉時附上 gist 的網址，無法確認是否建立時附上 token），不推到 github.com 以外的 gist。
- `test/about.test.ts`：伺服器為回報問題說明自己的資訊：桌面 app 建置時的版本，否則是它執行的 commit；系統與 Node，不含路徑。
- `test/share.test.ts`：分享的對話放進的 gist：一個從 stdin 讀入 `index.html` 的 secret gist，以標題說明；github.com 的 gist 有 gistpreview 連結，其他主機則沒有；用假的 `gh` 測試：回傳的連結、沒安裝時說明怎麼安裝、沒登入時說明怎麼登入（各附錯誤代碼）、gh 自己的原因、逾時；不詢問就刪除 gist、GitHub 也找不到的視為已刪除（使用 gh 真正的「not found or not owned by you」訊息），屬於另一個帳號的則保留、gh 太舊不支援 `gist delete --yes`（2.66.0 之前）時說出需要的版本與目前安裝的版本、在 Homebrew 的資料夾找 gh，以及只有十六進位的 gist id 能進到它的命令列。也測試附上檔案的分享：先透過 `gh api` 建立放檔案的 secret gist（JSON 從 stdin 傳入、只有佔位檔，說明含分享的代號，只印出 id 與 raw 網址），用 git 把檔案推進去（`--template=` 的 bare clone、每個檔案的位元組一個 blob、`mktree -z`、在佔位檔的 commit 上 `commit-tree`、`push --no-verify` 到 gist 的分支；只由 `gh auth git-credential` 登入、重設使用者的 credential helper、不跑 hook 也不簽章、`GIT_TERMINAL_PROMPT=0` 與空的 `GIT_ASKPASS`、不沿用伺服器環境的 `GIT_DIR`；sh 會拆開的 gh 路徑仍是一個字；刪掉暫存的 clone），用 `gh api` 讀回 raw 網址，再用和沒有附檔時相同的方式把頁面放進自己的 gist，連結指向檔案的 raw 網址（經過跳脫）；用真的 git 推進代替 gist 的本機 repository：每個檔案逐位元組相同（二進位、空檔案、使用者的 git 會轉換換行字元時的 CRLF、含引號或以 `-` 開頭的檔名）、佔位檔不見了、接在它的 commit 之後；clone 建立後設定被改掉（以 gist 本身網址或 `origin` 為名、會執行指令的 remote，或把 gist 的網址改寫成帶自己指令的 ssh）時什麼都不執行、什麼都不推，因為 git 只走 HTTPS 連到 remote；clone 放在 Harness Relay 自己的資料夾，絕不放在系統的暫存資料夾，伺服器停止時留下的會被清掉（其他東西不動）；只接受 `gistFileNames()` 產生的檔名，在執行任何指令、建立任何 gist 之前就檢查；放附檔的 gist 一建立（git 執行之前）就告知，沒建立時不告知；放檔案的 gist 建不起來（被拒絕、沒登入、沒有 gh）就不再做任何事；git 推不上檔案（GitHub 拒收、逾時、無法登入、git 印出的不是 object id 或分支、沒有 git）時再刪除放附檔的 gist 並說明原因，刪不掉就列出；GitHub 還沒列出所有檔案時隔一秒、兩秒再讀一次，最多三次；gh 逾時或沒印出可用的內容時用代號找出放附檔的 gist，找到就刪除，刪不掉就列出，連找都沒辦法時說出代號；頁面傳不上去（gh 失敗、沒有 gh，或沒印出網址）、GitHub 沒給某個檔案的 raw 網址、gh 讀不回 gist，或頁面會超過 1 MB 時，再刪除放附檔的 gist，連刪除也失敗（gh 失敗或沒有 gh）時說出留下的 gist（`leftover`，不附 gh 的代碼），不在 github.com 上的也記下 GitHub 給的網址（也不推任何東西過去）；只接受 `gist.githubusercontent.com` 的 raw 網址，含空格的會整理成合法網址；量檔案大小時不讀內容，讀取的量不超過分享需要的，量過大小之後才變大的檔案也一樣（分段讀取，比一段還大的檔案也完整讀到），合計也不超過分享需要的（放不下的那個不讀，太大的那個之後的也不讀）；絕不經由被換上的符號連結讀取（在 Windows 這種開檔時無法指定不跟隨連結的系統上也一樣），也不讀具名管道（不會卡住）；檔案在 gist 裡的名稱（不分大小寫不重複、絕不是 `index.html` 或 `gistfile1.txt`、絕不是放附檔的 gist 的佔位檔名稱、絕不是 git 保留給自己的名稱，像以 git 會檢查的寫法（包括 Windows 的短檔名）寫成的 `.gitmodules`、`.gitignore`、沒有資料夾與控制字元、加上後綴也不會太長）；以及請求裡的連結清單。
- `test/share-web.test.ts`：分享頁：全部訊息或到某則回覆為止（那則回覆不在時什麼都不給）、還在串流的回覆、拿掉哪些內容（工具呼叫、思考過程與 app 的控制項，依元件真正使用的 class 名稱）、保留哪些連結、把圖片放進 1 MB（從最大的開始不放，以及沒有圖片也太大的頁面）、UTF-8 大小、它的 `Content-Security-Policy`（不執行腳本、不載入任何東西）、跳脫的標題、只接受 data URL 的圖示、團隊設計的角色（每個都完整顯示；在任何螢幕上都太長的，或無法量測時畫面上有 **顯示更多** 的，按鈕換成不需要腳本的 `<details>`，不論按鈕在角色裡的哪裡，折疊或展開和畫面上一樣，經過跳脫）、每個頁面都帶的 `SHARE_CSS`（和 app 一樣折疊角色、只在切換鈕收起時折疊、兩個文字只顯示一個、沒有三角形，而且只在 `@supports` 裡用到 `:has()`，不支援時角色完整顯示），量測角色用的視窗寬度（`SHARE_WIDEST`：比 `styles.css` 的每個斷點與聊天欄位都寬，斷點都以 px 表示，也沒有依高度的），以及它依賴的 RoleText class 名稱，以及頁尾（Harness Relay 的名稱與 logo，以及分享時間右邊的連結圖示，兩者都連到它的網站，不顯示網址）；也測試設定裡每個分享的內容範圍（兩種語言）、分辨 GitHub CLI 沒安裝或沒登入與其他錯誤，以及說明裡的官方安裝指令與連結。也測試分享頁連結的檔案：從下載連結讀回回覆與路徑（只接受這個對話的 `…/download` 連結）、每個連結一次且最多 100 個、頁面略去的部分以外的 FileLink 連結、每個連結會變成什麼（勾選的檔案變成沒有 `download` 的佔位連結，沒勾選的、另一個對話的或連回 app 的變成純文字，網址與郵件地址保留，略去的部分裡的什麼都不留）以及佔位連結需要的空間、一開始勾選哪些檔案（能附上的，在 20 個與 100 MB 之內，但不含看起來像機密的：點開頭的檔案、金鑰、檔名含 secret、credential、password、token 或 API key）、重新檢查時保留使用者的選擇（依路徑；原本不能附上的檔案能附上後視為新的）、勾選的合計、要送出的連結、依上限的算法顯示大小、放附檔的 gist 的網址，以及佔位連結（`src/shared/share.ts`）的找出、計數與替換（經過跳脫），絕不會認到只是看起來像佔位連結的聊天文字（含數字也一樣）；分支的那條線不算一則訊息，也不會出現。
- `test/approvals.test.ts`：「本對話都允許」的規則 key 與比對（串接指令、shell 包裝；讀網頁依主機與埠號）。
- `test/codex.test.ts`：Codex app-server 轉接器：thread 項目轉成 `AgentEvent`（文字、推理、計畫、指令輸出、用量，只有 `item/completed` 才帶的網路搜尋查詢，只改一個檔案時以變更種類（Edit、Create、Delete）為名稱、路徑為說明，改多個檔案時先寫出共同資料夾的最後兩層名稱，再以相對路徑列出），以及核准請求 / 回應。也測試工具庫的 MCP 伺服器放在一個 `mcp_servers` 表（完全存取下自行核准工具），以及 Codex 的 MCP 工具呼叫核准（codex-cli 0.167.0 送出的格式）和其他核准一樣顯示，其他 elicitation 則拒絕。也測試不載入 Codex 自己的內容：各項覆寫（包括 hook 與 plugin），以及改用 `-c` 參數傳入的同樣覆寫（inline table、key 加引號）；thread 開始後檢查設為不載入的 hook 與 plugin 確實關掉了（Codex 仍列出開著的或無法回答就失敗，沒有這個方法時照常執行），以及透過替身 `codex app-server` 的執行（開關也放在它的命令列、回合開始前檢查、Codex 忽略開關時失敗、檢查中按下停止就不開始回合；有要保護的路徑時，使用實驗性 API 與它自己的權限設定檔，Codex 沒有套用時失敗，並回答它詢問的時間）；在同一個表裡關掉它設定的每個 MCP 伺服器，不論名稱（工具庫取代的除外）；只在不載入 MCP 伺服器（全部、個別伺服器或它們的工具）時才用 `config/read` 詢問，問不到時以清楚的訊息讓執行失敗；個別的 skill（`skills.config`）、hook（`hooks.state`）與 plugin（`plugins`），寫成表與 `-c` 參數；只針對使用者設定裡的個別伺服器與工具（`disabled_tools` 保留使用者已關掉的）；檢查個別 skill、hook 與 plugin 確實關掉了；以及帶著這一切的 `thread/start` / `thread/resume` 請求。也測試在使用者自己的端點上執行：thread 的 model provider（`model_providers.harness-relay-<id>`、Responses API，有金鑰時才有 `env_key`）與送出的推理強度（`codexEndpointEffort()`：端點接受時用成員的，否則使用者的 Codex 設定有設的值改成 `medium`，用 `config/read` 問，沒設定時不送），也用替身 app-server 測。也測試已刪除端點的模型在 Codex 啟動前就失敗。可編輯模式下，其他工作目錄成為權限設定檔的 `write` 項目，或舊版沙箱的 `writable_roots`。
- `test/schedule.test.ts`：排程何時送出：`HH:MM` 與時區、把牆上時間換成時刻（時鐘跳過的時間往後移、重複的時間取第一次）、每天（今天或明天，時鐘調整前後時間不變）、每週（只在選定的日子，必要時到下週）、每隔幾小時（從儲存時算起）與一次性排程，以及讀不懂的時間；時鐘往回撥的那一夜、午夜與半小時的調整（聖地牙哥、豪勳爵島）、時鐘調整前後的每週時間，以及依排程所在地的星期幾（東京）。也測試 `validateSchedule()`（預設值、星期去重並排序、永遠不會送出的設定、關閉時保留過去的一次性排程）與排程視窗的邏輯：新表單與讀回已儲存的排程、瀏覽器輸入的日期時間、表單顯示的問題（和伺服器一致）、接下來的時間、以排程自己的時區顯示時間、用幾個字描述排程（星期一在前）、何時需要注意，以及一次性排程何時算完成；是否每次開新對話（只有真正的 `true` 才算），在表單中與讀回時。
- `test/sidebar.test.ts`：側邊欄的對話狀態、各群組的對話（「其他」在最後、群組不存在的對話放在「其他」）、還沒確認的移動，以及收合群組顯示的狀態。也包括一串分支對話（`src/shared/family.ts`）：每個對話列在它分支出來的對話底下，先建立的在上面，放在最早建立的對話所在的群組，依最近的動態排序；從已刪除的對話分支出來的對話，一起留在它當時的標題底下；伺服器還沒回應時整串一起移動；有幾個對話是從某個對話分支出來的，以及收合的一串顯示的狀態；一串分支中間已刪除的對話以它的標題留在原位，上面已刪除的頂端也一樣；開啟被收合擋住的對話時展開擋住它的分支，不在側邊欄的節點的收合狀態會被忘掉；從任何一個對話移動整串，以及復原這次移動；遇到循環會切斷，不會一直繞下去。也測試底部的 CLI 狀態：有幾個可用，以及這個瀏覽器是否顯示它們的名稱（安全地存下，沒有儲存空間也可以）。
- `test/search.test.ts`：搜尋的詞、不分大小寫的比對（長的優先、重疊合併）、第一個符合處附近的摘錄、標示關鍵字。
- `test/grouping.test.ts`：請首席 agent 分類對話的 prompt，以及解讀它的回覆（編號或名稱；0 或 null 代表都不適合；其他都拒絕）。
- `test/mentions.test.ts`：訊息 @ 了但不在團隊裡的名字（`unknownMentions`）：不分大小寫、每個只列一次、已知名字後直接接中文、較長的單字、已知與未知的名字同時出現、套件 scope 與 decorator 當成程式碼、標題、強調與表格，以及只看一般文字（不含程式碼、連結與 email），沒包起來的網址後面直接接的中文算一般文字。
- `test/links.test.ts`：沒包起來的網址在哪裡結束（`src/shared/links.ts`）：在直接接在後面的中文前結束，那段文字中的下一個網址自成一個連結；在全形標點、彎引號與刪節號結束，並去掉結尾標點（`)` 對應到 `(` 時保留）；屬於網址的中文（路徑的一段、查詢參數的值、網域）保留；`<…>`、`[文字](…)` 與 email 連結不變；同一個網址處理兩次結果不變。
- `test/planner.test.ts`：首席 agent 的回覆：擷取 JSON、範本與自訂團隊、驗證、改用已登入的 CLI、備援方案，以及 prompt。也測試對話中的問題：prompt 中的歷史與目前的團隊、保留目前的團隊（id 也一樣）、備援方案保留它、留下來的成員保留 id，以及精簡過的對話（不含工具呼叫、系統訊息、plan 與 pass；過長的訊息與對話會縮短，保留最新的部分）。也測試排程訊息 @ 了但沒有成員叫這個名字的名字，首席 agent 會被要求用這些名字為成員命名（一般問題不會，套件 scope 與 decorator 也不算）。也測試依使用者的要求修改團隊：prompt（團隊、要求、對話、等待中的設計、排程的訊息）、留下來的成員保留 id、工具、模型、推理強度與 CLI，新成員改用已登入的 CLI，用 `""` 清除模型，名字沒變而換到另一個 CLI 的成員（沒有 `was`）保留 id，拒絕無法執行的團隊，以及讀取輪流方式時的預設值；用 `was` 改名或換 CLI 的成員保留 id 與工具（不帶舊 CLI 的模型），所有的 `was` 先於名字比對（和被改名的成員同名的新成員仍是新成員），首席 agent 的回覆省略沒有改的角色，排程關閉或已刪除時會說明，團隊設定指定別的資料夾時告訴首席 agent 它在哪個已儲存的資料夾執行，兩邊剛好各只剩一位、且沒有角色或角色相同時把沒有 `was` 的改名認出來，`null` 或空白的角色與 `null` 的模型或推理強度視為沒有給，誤用在以不變成員為範本的新成員上的 `was` 會被忽略（新成員從那位成員的角色開始，也不會被當成要移除的成員），互換名字與連續改名時保留每位成員，告訴首席 agent 它不能清除角色，首席 agent 去掉前後空白照抄的角色維持原樣，沒有成員的回覆保留原本的成員，拒絕重複的成員、超過 8 位時截斷，prompt 讀到團隊設定裡的權限與資料夾，以及針對排程的設計會說明它回答排程的訊息。也測試帳號與工具：留任的成員保留使用者設定的帳號與工具（不論新團隊怎麼寫），依範本調整的團隊中是範本成員的成員保留那位成員的工具與帳號，帳號不可用的成員改用該 CLI 第一個可用的帳號（被改到別的 CLI 時丟掉原本的帳號），帳號狀態未知時保持原樣；成員的模型與推理強度依它自己帳號的模型清單檢查（留任的成員依它保留的帳號），prompt 裡的模型與預設值是新成員會用的帳號的；調整團隊時，成員在同一個 CLI 保留帳號（帳號未登入、模型改了也一樣），換 CLI 則丟掉，而且首席 agent 看不到帳號 id。也測試首席 agent 對每個 coding agent 的了解：每個模型及其推理強度與預設推理強度；各 CLI 自己的內建工具、skill、MCP 伺服器與它們的工具、subagent 與 plugin（執行時不載入的項目和停用的伺服器不列入；可能不完整，或標為未知並註明原因）；工具庫的 MCP 伺服器、可用的 skill 與記憶，以及預設給哪些 CLI 的成員；目前團隊每位成員實際拿到的工具庫項目，以及怎麼依這些分配成員；首席 agent 回覆裡的「tools」會被忽略（設計出的成員用 CLI 的預設，調整團隊時成員的工具維持原樣，換 CLI 也一樣）；為資料夾收集的資料（在有可用帳號的 CLI 新成員會用的家目錄裡詢問；拒絕某個問題或逾時的 CLI 保留已回答的部分，清單都回答為空但只是某部分沒回答或某個問題被拒絕時也一樣；什麼都沒回答或沒及時回答的標為未知；沒有資料夾時不詢問）。也測試首席 agent 的簡報把開源 agent 和登入式的 CLI 一起列出。抽屜中的其他工作目錄，以及提示中列出全部。也測試較低的隊伍上限（`maxTeamAgents`）：新隊伍截到上限、提示中的「At most」（一位成員，或上限較高時五位）、超過上限的範本不提供也不採用（仍被點名時以專屬的原因拒絕）、備案改用上限內的範本或截短的通用範本，以及修改隊伍時截到上限。
- `test/tour.test.ts`：使用導覽：每一步都有對應的目標，而且是介面裡真的有的元素（`src/web/` 裡的 `data-tour` 屬性）、新版本會再顯示一次，以及步驟的 fingerprint（步驟改了卻沒有換新版本時會失敗）。
- `test/i18n.test.ts`：語言偵測（伺服器 header 與瀏覽器）、語言在非同步工作中的傳遞、雙語範本、兩份介面字典結構相同，以及各 CLI 的安裝頁（`PROVIDER_INSTALL_URL`，找不到 CLI 時設定頁會連過去）與兩種語言的連結文字。
- `test/voice.test.ts`：用假的下載、程序與引擎測試語音輸入：固定版本的下載清單、背景安裝（引擎、模型、檢查），涵蓋 Linux 與 macOS 的 Homebrew、SHA-256 不符、取消、硬碟空間、自訂引擎路徑、引擎無法啟動、引擎只聽 127.0.0.1 並藏在隨機路徑後、語音轉文字與辨識語言、切換與刪除模型、設定，以及 HTTP 路由。也測試從 `RELAY_VOICE_MODEL_BASE_URL` 與 `RELAY_VOICE_ENGINE_BASE_URL` 指定的資料夾下載（鏡像給的內容不同時會被 SHA-256 擋下），以及 `RELAY_VOICE_DIR` 指定的資料夾：引擎提供的是 Harness Relay 自己的空資料夾（絕不是使用者自己的 `public`），在那裡移除語音輸入只刪 Harness Relay 的檔案，資料夾變空才一起刪掉。
- `test/voice-web.test.ts`：瀏覽器端的語音輸入：WAV 編碼、靜音判斷、把辨識結果插入游標處，以及麥克風與設定頁顯示的狀態。
- `test/tools.test.ts`：工具庫：front matter、找出 skill（往下兩層、本身就是 skill 的資料夾、列出名稱並標示是否已加入）、用假的金鑰儲存區測試 MCP 機密值（遮蔽、沒送出時保留、改名時仍以伺服器 id 保存，包括在名稱不分大小寫的儲存區只改大小寫、從資料庫移出、儲存區失敗），依 CLI 的預設與成員的例外設定、被標示的 skill，以及還沒有 CLI 範圍時存下的舊資料。另外：伺服器或 skill 改名後成員的例外設定仍有效；沒能搬走的值留在資料庫；讀不到的值不會被覆蓋，金鑰儲存區打開後會再讀一次。
- `test/files.test.ts`：用真的暫存資料夾測試瀏覽檔案：資料夾外、經由符號連結或進入 `.git`（不分大小寫）的路徑、列表順序與項目上限、文字 / 圖片 / 二進位檔的預覽與長檔案截斷、raw 只給媒體檔、下載可以給資料夾以外的任何檔案，以及對話提供的資料夾。經由連結進入的資料夾保留當初要求的路徑，截斷的列表保留顯示順序的前面幾項。也測試資料夾 ZIP 檔的內容（`zipPlan`）：以資料夾命名、不含 `.git` 也不含指向外面的連結、每個資料夾只放一次（繞回去的連結會略過）、保留空資料夾、超過上限就放棄（資料夾也算在內，所以一堆空資料夾也會停下）、保留權限、最上層用指定的名稱、略過 `.git.`，以及要求時只包沒被 git 忽略的檔案（追蹤中與未追蹤的檔案，不含已刪除或被忽略的，也不含指向外面或 `.git` 的追蹤中連結；包括裡面其他 repository 沒忽略的檔案；不在 repository 裡時就是全部）。每個工作目錄，以及每位 agent 在每一個的 worktree（資料夾在另一個 repository 裡面時，取最內層的）。用不同大小寫指定資料夾時，內容也一樣（macOS、Windows）。
- `test/media.test.ts`：回覆中哪些網址是這台電腦上的檔案（相對與絕對路徑、`file:` 網址、`檔案:行號`；其他 scheme、其他網站、錨點與資料夾都不是）、媒體類型、只在允許的資料夾裡解析媒體與下載的檔案（不跟隨指向外面的連結，也不包含任何大小寫的 `.git`；不會查詢資料夾外的路徑；接受經由連結寫出的資料夾絕對路徑）、回覆的檔案從哪些資料夾、依什麼順序取得、檔案為什麼不能下載（不存在或是資料夾，或在資料夾外、在 `.git` 裡，經由連結也一樣）、下載檔名標頭（RFC 5987 加上 ASCII 備用名稱）、位元組範圍；複製到分支的平行模式回覆，從它分支出來的對話找到 worktree（分支的分支再往上找，或經由 `earlier` 的段落找，絕不用分支自己的）。有多個工作目錄時，在每一個中尋找，也在它所在 repository 的每個 worktree 中尋找。
- `test/zip.test.ts`：ZIP 寫入器，用解壓縮工具讀檔的方式讀回來（`test/zipReader.ts`）：UTF-8 檔名的資料夾與檔案、以 data descriptor 和 Unix 權限 deflate 壓縮、空檔案、空的壓縮檔、打不開的檔案會略過、讀取錯誤會讓壓縮檔以錯誤結束、下載中止時關閉開著的檔案（剛送出標頭時也是）；檔名處理成安全的形式（`\`、`..`、`:`、開頭的 `/`、控制字元）並保留權限；MS-DOS 時間。
- `test/files-web.test.ts`：檔案瀏覽的路徑導覽列、篩選、程式語言與行數。也測試把資料夾下載成 ZIP 檔時的選擇：全部、只包沒被 git 忽略的檔案，或太大。
- `test/tools-web.test.ts`：團隊編輯器的工具選擇：項目、各 CLI 的記憶、依 CLI 的預設，以及只記錄例外。
- `test/cwds-web.test.ts`：工作目錄輸入框的清單：剛打開或輸入框清空時列出全部、只留下包含輸入的每個詞的路徑（不分大小寫、保持原本順序）、名稱含空格的資料夾（不論輸入幾個空格）、把 `~` 當成家目錄，以及 Windows 路徑不論輸入哪種分隔符號都能比對、標示時依路徑原本的寫法。也測試清單如何回應：↑ ↓ 在清單中循環、重新取得清單時反白仍停在同一個資料夾、清單沒有顯示任何項目時 ↑ ↓ 會列出全部、Enter 只在有反白的資料夾時作用、Escape 只在清單顯示時作用（否則交給對話框），以及箭頭按鈕。它的標籤：每個資料夾只加一次（結尾多一個分隔符號不算另一個）、Enter 加入輸入的內容、在空白輸入框按 Backspace 移除最後一個、選擇資料夾視窗開在輸入的路徑或最後一個資料夾，以及從清單得到對話的 `cwd` 與 `extraCwds`。不超過八個。
- `test/folder-picker.test.ts`：選擇資料夾的視窗：每個系統用哪一個（AppleScript、Windows PowerShell、圖形介面中的 zenity 或 kdialog，經由 ssh 時沒有），它的指令（AppleScript 的標題與資料夾在固定的腳本之後當作參數，PowerShell 是固定的腳本、標題與資料夾放在環境變數，zenity 開在資料夾裡面），它的回答（去掉 AppleScript 結尾的 `/`，根目錄除外；名稱結尾的空格；BOM；取消、逾時或被訊號停止時為 `null`；失敗時附上程式的訊息），開在哪個資料夾（最近一個存在的），以及執行時帶著請求的 signal 與時間上限。一次選多個資料夾（AppleScript 的 `with multiple selections allowed`、zenity 的 `--multiple`），每行一個，以及不用 `activate`。沒有 UTF-8 字元集時給 zenity 與 kdialog 一個（沒有的話 zenity 會拒絕中文標題），以及以完整路徑啟動 Windows PowerShell。
- `test/native-web.test.ts`：CLI 自己載入的內容那一區：查詢前各 CLI 的分頁與查詢後的數量（指示與記憶分開）、各 CLI 能整類或逐項不載入哪些、勾選與清除個別項目、執行時不載入幾項（MCP 伺服器連同它的工具只算一次）、查詢後不載入的設定是否已變更、查詢結果裡已經沒有的勾選項目與清除它們，以及保存的個別項目（`nativeItemsFor`）。
- `test/native.test.ts`：各 CLI 自己載入的內容：讀取 Claude Code、Codex、Grok 的回答（實測格式；MCP 設定與其中的 token 會被丟掉）、Claude Code 與 Codex 會讀的指示和記憶檔（真的暫存資料夾），無法啟動的 CLI、依執行檔與不載入設定分開的快取、不論多久以前的最近一次回答（開啟回報過的檔案時用）、依請求語言的問題說明，以及哪些檔案可以讀（只有回報過的）。也測試 hook（不含指令）、subagent 與 plugin；標示 Harness Relay 執行時不載入的項目（不含 CLI 自己就關掉的）；Claude Code 與 Codex 依環境變數與設定略過的檔案；以及透過替身 `claude`、`codex`、`grok` 執行檔，依 Harness Relay 啟動各 CLI 的方式再問一次（和執行時相同的旗標、覆寫設定與環境變數；失敗時不標示任何項目；第二次回答缺少的清單會在錯誤中列出；只有指示檔或記憶時不再啟動 Claude Code；取代內建 subagent 的同名 subagent 不算內建；無法列出 plugin 的情況）。也測試工具：從 Claude Code 的 `/usage` 回合讀出內建與 MCP 工具（MCP 工具依伺服器分組，只有那個回合列出的伺服器也算），只在 `/usage` 是它自己的指令時才送（有同名 skill 就不送）且不留下 session，它不接受 `--no-session-persistence` 時改成不送這個回合再問，skill 整類不載入（它不列任何指令）時再問也會送；從 `mcpServerStatus/list` 讀出 Codex 每個伺服器的 MCP 工具（照 Codex 列出的，不依它回報的設定過濾；啟動失敗的伺服器不列工具；關掉的伺服器第二次不再啟動；忽略 `disabled_tools` 的 Codex 會顯示工具仍會載入）。也測試勾選了但第二次回答仍載入的項目（`stillLoaded`，只限有給的清單），以及第二次回答逾時時保留已回答的部分。以及個別項目：Claude Code 的 skill、內建工具、MCP 工具、工具都被拿掉的整個 MCP 伺服器、subagent（內建的也可以）、plugin 與指示檔；Codex 的 skill、MCP 伺服器與工具、hook 與 plugin；都透過替身標示出來。另外也測試 CLI 的家目錄改變時會重新詢問（透過真的 `SettingsStore`）。也測試 probe 拿到多少（`probeCompleteness`：完整、不完整，或因逾時或失敗而什麼都沒有；清單都為空但只是某個問題被拒絕或某部分沒回答，不算什麼都沒有），以及給首席 agent 的答案（`recent`）：直接給上次的答案，過舊時在背景重新詢問，沒有答案或不載入的項目改變時才等待，每個帳號在自己的家目錄、依那個帳號不載入的項目。也測試 Cursor，不啟動它、從它的檔案回答：從它讀的每個資料夾找 skill（同名只取第一個）、MCP 伺服器只取名稱（專案的標示需要核准）、hook 依事件列出且不含指令（包括 `~/.claude/settings.json` 裡 Claude Code 的）、它的 subagent 與指示檔，以及沒有能不載入的項目。也測試無法詢問的 CLI（`failedProbe()`）：Claude Code、Codex、Cursor 與 Antigravity 的指示檔就是文件說它們會讀的那些，和它們的 probe 一樣。Claude Code 被詢問時會帶上其他工作目錄（`--add-dir`），兩次詢問都是，答案依資料夾分開保存。
- `test/agentsview.test.ts`：用假的 `fetch` 測試把對話送到 AgentsView：thread 寫成 Claude Code 的 session 紀錄（使用者的訊息、以成員名稱和 CLI 開頭的回覆、註明失敗、附件以檔名表示、不含系統訊息與串流中的回覆、最後是標題）、AgentsView 的 session id（Antigravity 的是 `antigravity-cli:<id>`；Cursor 與開源 agent 的沒有，用它們的首席 agent 或分群也沒有；每個 CLI 不是有命名就是記下；這個版本不認得的 CLI 沒有 id，也不會拋出錯誤）、成員記下的 session（Cursor 與開源 agent 的：每則回覆前大家說的話，寫法和 thread 一樣、不含其他 agent 的思考與工具輸出，思考、工具呼叫與結果（每種呼叫寫成 Claude Code 對應的工具，細節放在那個工具的欄位並保留 CLI 自己的名稱，網路搜尋寫成 `WebSearch`，其他呼叫用 CLI 的名稱）、工具結果之後的內容、還在執行或沒說原因就失敗的呼叫、各種核准、附件與計畫寫成文字、略過空白的文字與思考、沒有內容可顯示的回覆之前聽到的話延到下一則、`[PASS]` 與失敗、每則回覆的 token 放在最後一則 assistant 訊息、自己的且不變的 id、成員的模型或否則用 CLI（成員離開團隊或換了 CLI 時也是）、`cost-state` 依模型的總計，精確到百萬分之一美元（沒有 token 的回覆也算），註明成本不明，沒有回報成本時不聲稱有成本、名稱（對話沒有標題時不含標題）；只有在這種 CLI 上的回覆、每位成員一個 session、在 thread 之後上傳到同一處並連在它底下、只在改變後、換網址、project 或 machine 後，或失敗後才再送，連結失敗後再連結一次但不重送，某一個失敗時不影響其他的上傳與連結，而 thread 送不出去時就停止這次更新，AgentsView 以 409 拒絕（已刪除）的不連結、在改變前不再送、也不算失敗，更新途中對話被刪除時不再送出、連結或保留任何東西；thread 放在 Antigravity 成員的 session 所在之處）、上傳（檔名、取自已知 agent session 或資料夾名稱的 project 與 machine、`allow_shorter`、`Origin` 標頭）與 parent 連結（包含首席 agent 與分群用的 session）、沒有網址或沒有訊息時不送、每個對話一次只跑一個更新且之後只再送一次最新狀態、沒事可做的更新結束後能立刻再開始、丟掉已刪除對話還在等待的更新、絕不跟隨重新導向、project 取自 AgentsView 第一個有回應的 agent session，以及依網址保留上次的失敗直到更新成功。
- `test/limits-web.test.ts`：UI 中伺服器的上限（`src/web/limits.ts`）：伺服器回答之前用預設值，之後用它的上限；只有改變時才通知（否則是同一份 snapshot）；失敗時保留原值，下一次再試；每個新的 listener 都會再問一次，但同時只問一次；頁面事件只在有元件聆聽時才會再問。
- `test/refresh-web.test.ts`：回答的順序錯亂時，聊天介面顯示的 CLI 狀態與模型清單（`src/web/refresh.ts`）：每個 CLI 都以最後一次檢查的狀態為準，不論回答到達的順序（時間相同，或顯示中的沒有時間時採用新的；顯示中的有時間而新的沒有時，保留顯示中的）；模型清單則是比較晚到的舊回答被丟掉、較新的請求失敗時保留較舊的回答，以及強制載入進行中時的一般載入等它完成後才送出（期間的多個一般載入只送出一次，強制載入的回答無法顯示時也一樣會送出）。
- `test/theme.test.ts`：淺色或深色主題（`src/web/theme.ts`）：讀取存下的選擇（其他值都算跟隨系統）、每種選擇與系統模式下顯示的主題、淺色或深色時設定 `<html data-theme>`，跟隨系統時移除，瀏覽器的頂列顏色（`theme-color`）也跟著改；記在瀏覽器裡，儲存區丟出錯誤時跟隨系統；在頁面裡（替換掉全域物件）：從存下的選擇開始，接著跟隨系統模式、其他分頁的選擇（只看它的 key）與使用者的選擇。也檢查 `styles.css` 裡兩份深色顏色（系統的深色模式與選了深色）相同、沒有其他地方只跟隨 `prefers-color-scheme`、頂列顏色等於頁面背景、`index.html` 在 app 的 module 之前、從同一個 key 設定主題且只設成淺色或深色（包在 `try` 裡），以及每個選擇在兩種語言都有名稱。
- `test/updates.test.ts`：聊天介面裡的桌面 app 更新：不是桌面 app 啟動的伺服器只有版本；app 最後說的狀態加上這個版本；向 app 要求檢查，檢查完才回答（太久沒回應就給已知的狀態；不會向不更新的 app 要求）；同時要求的檢查在 app 依編號回答後都會得到回答，已經在路上的狀態不算，逾時的不再等待；app 欠聊天介面的回答在沒有檢查進行中時才給（`CheckAnswers`）；伺服器等待的時間比 app 等 GitHub 的長；只在有較新的版本且沒有更新進行中時才要求 app 更新（並說明是哪一種情況）。分辨 app 自己的視窗與其他瀏覽器（手機）；只在那裡為每個版本跳出一次對話框，更新進行中時不跳，只在沒有其他對話框或導覽開著、使用者沒在文字欄位打字、也沒有東西擋住對話框（錄音）時才跳出，跳出後在仍可更新時保留，沒按「稍後再說」就關掉的下次會再提示；檢查、下載或安裝進行中，以及按下「更新」後一段時間內較常詢問（等對話結束時不會）；頁面上的對話框只有最上層的處理按鍵，錄音時擋住會自己跳出的對話框（只釋放一次）；以及設定的「版本」卡片說什麼（先說進行中的更新，接著是檢查中、有新版本、檢查失敗、還沒檢查、已是最新並附上時間）。頁面對伺服器版本的監看：伺服器回答另一個版本時重新載入，定時詢問、視窗回到前景時也詢問，伺服器沒有回應不算改變，重新載入後就不再詢問。
- `test/route.test.ts`：前端的 hash 路由（`#/` 的首頁，不認得的路由也是；`#/new` 的新對話，以及「新排程」頁面），包括設定頁的區塊（「版本」在最前面），以及正在看哪張設定卡片（在連結列標亮）；標亮的連結看得到時連結列不動，看不到時只捲動剛好需要的距離，也不會捲過兩端。模型來源排在外觀之後、所有 CLI 之前。
- `test/grok-trust.test.ts`：記錄 Grok 對資料夾的信任：和 `grok --trust` 相同的紀錄、取代標為不信任的紀錄並保留其他內容、Windows 路徑的 TOML 跳脫、寫在暫存 `GROK_HOME` 的檔案（只有擁有者能讀）、還原成原本的內容，從 `grok inspect` 讀出信任狀態與決定信任的資料夾（去掉結尾斜線的專案根目錄，是否在資料夾上層，否則就是資料夾本身），以及等待確認的團隊設計什麼情況會顯示它（有 Grok 成員與資料夾）。
- `test/util.test.ts`：把成員或首席 agent 切到另一個 CLI 再切回來，會還原每個 CLI 選過的模型、推理強度與帳號；模型選單的「預設」寫出成員接著用哪個模型執行（沒有預設的開源 agent 需要選一個）。agent 的帳號：CLI 還有它時就是它指定的帳號，否則是預設帳號；能不能執行（已登入、無法判斷，或有金鑰）；新成員拿到的帳號（預設帳號可用時用它，否則用第一個可用的）；它在介面上的名稱。逾時訊號會在時間到時中止，和 `AbortSignal.timeout()` 一樣，清除後就不會中止。
- `test/open-state.test.ts`：每個開源 agent 自己的狀態：兩個對話的執行，彼此都不能讀寫對方的狀態資料夾（Harness Relay 沙箱的規格與它的檔案規則）、key 的資料夾從一輪留到下一輪並在 `freshState` 時清空、沒有 key 的執行用執行後就刪除的資料夾、完全存取以外拒絕在成員資料夾之外的狀態路徑、key 作為資料夾名稱（不尋常的用雜湊）、每個開源 agent 的 private 資料夾不能讀取；五個轉接器各自的配置（一次執行寫入的一切都在狀態資料夾，CLI 也指向那裡）；執行的環境中只有它自己模型來源的金鑰，沒有其他模型供應商繼承來的金鑰，不屬於模型來源的仍會傳入（`allBackendKeys` 時全部）；不論執行對狀態資料夾做了什麼（以 `chmod 000` 鎖住的資料夾、唯讀的檔案）都能清空，且不跟隨連結到資料夾外；刪除的對話的狀態從每個開源 agent 的家目錄移除，啟動時清掉停下的伺服器的執行留下的東西（包括移到一旁的資料夾）；驗證會保留成員對開源 agent 記憶的例外；MCP 工具的核准卡片（它的輸入，唯讀仍是界線）。也測試家目錄先前所在資料夾裡的 private 資料夾，執行讀不到（從它的環境變數得知），那裡也不會建立任何資料夾；以及停下的執行留下的東西可能還在執行時，啟動時的清理不恢復權限。
- `test/e2e-fakes.test.ts`：端對端測試的假 CLI（`e2e/fake-cli/`），照 `e2e/support/fake-cli.ts` 的方式打包，並依檔名以每個 CLI 的身分執行：十個 CLI 各有一個模組，名稱、標籤與版本和 Harness Relay 及 spec 的資料（`e2e/support/clis/`）一致，也會回答 `--version`；拒絕以不是 CLI 的名稱執行；每次啟動都以 provider id 記下，並附上家目錄；假首席 agent 為每個 CLI 取的成員名稱和測試用的一樣；不能寫紀錄檔的地方（像在 Harness Relay 自己的沙箱裡），改把紀錄送到假端點（`E2E_FAKE_LOG_URL`）；`e2e/specs/windows.spec.ts` 的 Windows 啟動器照 `src/server/winLaunch.ts` 的方式啟動（Cursor 的是它的 Node 與腳本，Cline 與 Pi 給 Node 腳本的 npm shim 是 PATH 上的 Node 加上它的腳本，OpenCode 的是它指向的程式）；以及測試伺服器的資料資料夾短到放得下沙箱的 socket，照伺服器的算法（`DATA_DIR_MAX` 對照 `hostTmpRefusal()`）。
- `test/quickstart.test.ts`：使用者複製的指令在任何 shell 都能執行：npm scripts 不用 Unix 的方式設定環境變數（npm 在 Windows 上用 cmd.exe 執行），首頁、README 與使用指南不用 `&&` 串接指令（Windows PowerShell 5.1 不接受），README 的快速開始從 clone 開始並執行建置好的 app（先 `npm run build` 再 `npm start`，登入連結在 <http://127.0.0.1:8787>）。首頁安裝的是桌面 app：各系統的下載按鈕，沒有指令區塊也沒有 `git clone`，`npm run dev` 與 `npm start` 各出現一次，並連到 README 的快速開始。也測試中文文件裡沒有網址直接接著中文字，否則 GitHub 會把後面的字一起變成連結（請寫成 `<http://…>`）。

接下來適合補上的：

- **轉接器 parser**：把真實 CLI 輸出錄成 fixture 檔，驗證送出的 `AgentEvent`。錄製方式：

  ```bash
  echo "hello" | claude -p --output-format stream-json --verbose --include-partial-messages > claude.jsonl
  # Codex、Grok、Cursor 與 Antigravity 使用 JSON-RPC；可以在 JsonRpcConnection.handleLine 加 console.log
  # 記下轉接器收到的內容，或從 Grok 為每個 session 保存的更新紀錄複製：
  # ~/.grok/sessions/<URL 編碼的 cwd>/<session-id>/updates.jsonl
  ```

- **prompt 輔助函式**：`buildTurnPrompt`。
- **更多協調器排程**：接力交棒、`[PASS]` 提前結束，用協調器測試同一個假 runner（`test/orchestrator-harness.ts`）。

在測試中跑真正的 agent 會花錢且需要登入，所以自動化測試請保持離線。測試也不會碰到真正的金鑰儲存區：`SettingsStore` 由建構子參數取得它，只有 `src/server/index.ts` 會傳入 `openSystemKeyring()`。

## 端對端測試

```bash
npm run test:e2e:install                  # 一次即可：Playwright 驅動的 Chromium（Linux：npx playwright install --with-deps chromium）
npm run test:e2e                          # e2e/specs/ 裡的所有測試，在 Chromium 中執行
npx playwright test e2e/specs/chat.spec.ts
npx playwright test -g approvals          # 依標題挑選
npx playwright test --ui                  # 在 Playwright 的視窗中挑選並觀看測試
npx playwright show-report                # 上一次執行的報告，附失敗測試的 trace
E2E_BROWSERS=chromium,firefox,webkit npm run test:e2e   # 先執行 npx playwright install firefox webkit
```

它們在真正的瀏覽器中操作 UI（[Playwright](https://playwright.dev)、[`playwright.config.ts`](../playwright.config.ts)），面對的是真正的伺服器：`src/server/index.ts` 加上建置好的 UI。因此路由、登入、SSE、協調器、轉接器與工作目錄的 git 會像使用者實際操作時一樣一起被測到。agent 是假的 CLI，所以測試保持離線、不花錢，並且在 macOS、Linux 與 Windows 上的跑法相同。[`e2e/README.zh-TW.md`](../e2e/README.zh-TW.md) 依功能分區列出它們測到的每個情境、各自檢查的內容、用到哪些 CLI，以及還沒測到的部分；每次新增、修改或刪除端對端測試時，請一起修改它（兩種語言）。

- **每個測試有自己的伺服器**（`e2e/support/relay.ts`，即 [`e2e/fixtures.ts`](../e2e/fixtures.ts) 的 `relay` fixture）：使用空閒的 port（`PORT=0`），並在一個暫存資料夾中放它的資料（`RELAY_DATA_DIR`）、家目錄（`HOME`、`USERPROFILE`，以及其中的 XDG 資料夾，所以 Cursor 的家目錄是它的 `.config/cursor`）、各 CLI 的家目錄（`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`GROK_HOME`，以及那個家目錄裡 Antigravity 的 `.gemini`；開源 agent 的則在資料資料夾的 `agent-homes/<cli>`）與預設工作目錄（一個小專案，`seedProject()`），且 `RELAY_KEYRING=off`：不會讀取或更動你自己的 Harness Relay、CLI 或鑰匙圈。在 macOS 與 Linux 上，那個資料夾放在 `/tmp`（`E2E_TMP_DIR` 可指定別的），因為 Harness Relay 自己的沙箱需要短的資料資料夾來放它的 socket，而 macOS 的暫存資料夾太深；資料資料夾會太長的地方，測試的伺服器會拒絕啟動。你的憑證也不會留在它的環境變數裡（`ANTHROPIC_*`、`OPENAI_*`、`XAI_*`、`GROK_*`、`CODEX_*`、`GH_*`、`GITHUB_TOKEN`，以及任何 `*_API_KEY` 或 `*_TOKEN`），Cursor 與 Antigravity 自己的也一樣（`CURSOR_API_KEY`、`CURSOR_AUTH_TOKEN`、`CURSOR_CONFIG_DIR`、`CURSOR_INVOKED_AS`、`AGENT_CLI_CREDENTIAL_STORE`、`NO_OPEN_BROWSER`、`GEMINI_API_KEY`、`AGY_ADC_AUTH`、`GOOGLE_APPLICATION_CREDENTIALS`、`GOOGLE_CLOUD_PROJECT`、`ANTIGRAVITY_*`），還有你自己的 XDG 資料夾，以及測試執行器與你的 Harness Relay 的變數（`PLAYWRIGHT_*`、`E2E_*`、`RELAY_*`、Claude Code 的巢狀執行變數），所以萬一找到的是真正的 CLI 或 `gh`，它也沒有東西可以連上服務。git 找 repository 時不會超出測試的資料夾（`GIT_CEILING_DIRECTORIES`），所以外層的 repository（例如用 git 管理的家目錄）不會被當成工作目錄的。頁面開啟前會透過 API 把測試不要的 CLI（`missingClis`，預設是假 CLI 還沒寫好的那些：現在沒有）設成一個不存在的執行檔，讓它們在那裡顯示未安裝；接著把測試的假模型端點（見下方）設成模型來源、它的第一個模型設成開源 agent 的預設模型，並打開 OpenHands 的終端機開關。測試結束時會停止伺服器並刪除它的資料夾。刪不掉時（Harness Relay 會把其中一些資料夾設成唯讀，例如 OpenCode 家目錄裡的設定），會把底下每個資料夾的寫入權限還給擁有者，不跟隨連結，再刪一次；仍刪不掉的資料夾只會回報（`[e2e] could not remove …`），不會讓測試失敗。fixture 會讀取伺服器印出的登入連結。`page` fixture 會開啟一組新代碼的連結，所以一開始就已登入，導覽已完成，介面為英文；`test.use()` 可以改變這些（`lang: 'zh-TW'`、`signIn: false`、`tour: true`）、給伺服器更多環境變數（`serverEnv`）、讓某些 CLI 未安裝（`missingClis`）、不把假端點設成模型來源而讓開源 agent 已安裝但還不能用（`openBackend: false`），或關掉 OpenHands 的終端機開關（`sandboxTerminal: false`）；`live: true` 則改用真正的 CLI（[實機測試](#實機測試)）。`relay.api()` 以已登入瀏覽器的身分呼叫 API，用來準備狀態或檢查存下的內容；`relay.fakeLog()` 回傳假 CLI 啟動時的參數與收到的內容。失敗的測試除了 trace、截圖與影片，還會附上伺服器的輸出與假 CLI 的紀錄。
- **假的 CLI**（[`e2e/fake-cli/`](../e2e/fake-cli/)，只用 Node 內建模組的 CommonJS）代替全部十個 CLI，照轉接器驅動的方式說各 CLI 的協定：Claude Code 的 stream-json（含 control request 與 `can_use_tool`）、`codex app-server`、Grok、Cursor（`cursor-agent acp`）、Antigravity（`agy acp`）、OpenCode、Goose、Cline 與 OpenHands 的 ACP，以及 Pi 的 JSONL RPC（`pi --mode rpc`，像 Pi 那樣載入 Harness Relay 真正的 gate 擴充功能 `piGate.js`）；也回答伺服器執行的各種探詢（`--version`、登入狀態、模型、`grok inspect --json`、各 CLI 自己載入的內容），其他指令一律立刻帶著錯誤結束。每個 CLI 的假 CLI 是一個自己的模組（`agents/<provider>.cjs`，含檔名、標籤、版本、家目錄與 API key 的檢查），旁邊是共用的部分（`lib/`：stdio 上的 JSON-RPC 與 ACP、一個回合的步驟、家目錄、檔案與紀錄），`fake-cli.cjs` 依程序執行時的名稱挑選模組（`cursor-agent` 是 Cursor，`agy` 是 Antigravity）。`e2e/support/fake-cli.ts` 安裝時會把這些模組打包成一支腳本（`bundleFakeCli()`，自己的一個小模組載入器）：Node single executable 的 `require` 只載入 Node 內建模組，而以腳本執行時，假 CLI 是從快取資料夾執行，模組不在那裡。spec 需要知道的各 CLI 與它的假 CLI 的事（工具的名稱、會詢問什麼、被拒絕時怎麼做、家目錄在哪裡）寫在 `e2e/support/clis/<provider>.ts`，和假 CLI 一起修改，`e2e/support/clis.ts` 再用它們回答 spec 的問題（`eachCli()`、`HALVES` 的兩個團隊、`basePermission()`、`needsBelowFull()`、`defaultHome()`、`sessionFile()`）。伺服器會在 PATH 最前面依名稱找到它們，和找真正的 CLI 一樣。在 macOS 與 Linux 上，每一個都是打包好的腳本加上指向執行測試的 Node 的 `#!` 行（OpenHands 的放在它自己的 Python 虛擬環境裡，照 `uv tool install` 的配置，伺服器從那裡的 LiteLLM 清單讀它的模型）。Windows 不透過 shell 時只能啟動真正的程式（`.exe`），所以在那裡 `e2e/support/fake-cli.ts` 會把腳本做成 Node 的 single executable application（`node --experimental-sea-config`，再用 `postject`），以十個名稱與 `gh`（見下方）連結到同一份。這需要幾秒鐘與約 100 MB，所以會存在 `node_modules/.cache/harness-relay-e2e/`，直到某個模組或 Node 改變為止（改變之後，最後一次有伺服器用它啟動起一小時內仍會保留，因為另一次執行可能還在用它；少了任何一個假程式時，伺服器會拒絕啟動，而不是找到真正的 CLI）。設定 `E2E_FAKE_SEA=1` 也會在 macOS 與 Linux 上這樣建置。在 Windows 上 postject 會警告 `The signature seems corrupted!`：注入腳本會破壞 `node.exe` 的 Authenticode 簽章，而這份副本不需要它。為了 `e2e/specs/windows.spec.ts`，`installFakeLaunchers()` 也會照部分 Windows 使用者安裝後的樣子做出假 CLI：Cursor 自己的啟動器（`cursor-agent.cmd`，執行 Node 與 Cursor 的一支腳本），以及 npm 的 `.cmd` shim，給 Node 腳本的（Cline、Pi）與給程式的（OpenCode）。[`test/e2e-fakes.test.ts`](../test/e2e-fakes.test.ts) 會在 `npm test` 中打包並執行假 CLI，所以載入不了的模組在端對端測試之前就會發現。
- **假 CLI 的回答**取決於 prompt，就像模型一樣。首席 agent 的 prompt 會得到一個團隊（`e2e:team=claude,cursor,pi`，用 provider id，`e2e:mode=relay`、`e2e:rounds=2`、`e2e:name=Some_name`、`e2e:template=<id>`，以及回答不是 JSON 的 `e2e:badplan`；預設是一位 Claude 成員）、一個群組（第一則訊息裡提到的第一個群組），以及調整後的團隊（`e2e:add=<cli>` 加入一位成員）。一般的回合會得到 `Hello from <名稱> (<CLI>). You said: “<使用者最新的訊息>”.`，並附上這一回合收到的圖片與工具庫的 MCP 伺服器，分段串流，並依該訊息中的指令改變：`e2e:think`、`e2e:tool`（用 CLI 自己的工具列出工作目錄）、`e2e:todo`、`e2e:approve`（需要核准的指令；`e2e:approve=publish` 是 `npm publish e2e-approval`，在編輯模式下也會詢問，給 Pi 用）、`e2e:fetch=<網址>`（連到那個網址：這次執行不經詢問就不能連的主機）、`e2e:write=<路徑>` 與 `e2e:writeother=<路徑>`（寫在 CLI 拿到的第一個其他工作目錄）、`e2e:ask`、`e2e:handoff=<名稱>`、`e2e:slow`、`e2e:fail`（帶著錯誤結束）、`e2e:error`（在協定之內失敗）、`e2e:flaky`（失敗一次，重試時回答；Cursor 要是對話的第一則訊息）、`e2e:markdown`、`e2e:memory`（說出簡報給它的工具庫記憶）與 `e2e:skills`（在 CLI 可以讀取的地方讀簡報列出的每個工具庫 skill，並說出它的第一行）（見 `e2e/fake-cli/lib/plan.cjs` 中的 `DIRECTIVES`），以及只給 Cursor 的 `e2e:delete=<路徑>`（刪除檔案，Cursor 一定會先詢問）。在指令後加上 `@<cli>` 就只對那個 CLI 有效，用 provider id：`e2e:write=a.txt@cursor`。之後的回合若使用者沒有新的訊息，回答 `[PASS]`。假 CLI 就像不理會簡報的模型，總是會嘗試指令要求的事，而成不成功只取決於 Harness Relay 給了 CLI 什麼：Claude Code 的 `--permission-mode`、`--disallowedTools` 與 `--add-dir` 資料夾，Codex 的沙箱或權限設定檔（含 `write` 項目；`writable_roots`）與核准政策，Grok 的 yolo 模式與沙箱設定檔的 `read_write` 資料夾（沒有沙箱時，也就是 yolo 模式與 Windows 上，是簡報中列出的其他工作目錄），Cursor 的 `--force`、核准模式與它設定資料夾中的允許與拒絕規則，Antigravity 的設定、模式與參數，每個開源 agent 的設定、環境變數與轉接器寫的檔案，以及各自核准請求得到的回答（拒絕時的附註會轉交給接受附註的 CLI）。Cursor 與 Antigravity 沒有沙箱，所以它們的假 CLI 像真正的一樣先詢問；開源 agent 的假 CLI 會真的寫檔、真的連到網址，所以在完全存取以外，不屬於它們的事由 Harness Relay 自己的沙箱本身拒絕，它們再像自己的 CLI 那樣回報。所以在唯讀對話或另一個資料夾寫檔的測試，能看出轉接器有沒有把 CLI 設定對。假 CLI 會把 session 存在自己的家目錄（開源 agent 的存在它成員的狀態資料夾），並拒絕接續從沒開始過的 session，和真正的 CLI 一樣。它們會在真正的 CLI 找 skill 的地方找到自己的 skill（Claude Code：家目錄的 `skills/` 與每個工作目錄的 `.claude/skills/`；Codex：家目錄的 `skills/`；Grok：專案的 `.claude/skills/`，只在它信任的資料夾），並遵守 Harness Relay 設定的不載入項目（`skillOverrides`、`skills.config`、`GROK_CLAUDE_SKILLS_ENABLED`）。它們一直處於登入狀態，直到在自己的家目錄執行自己的登出（`auth logout`、`logout`，Antigravity 是透過 ACP）；`claude auth login` 會印出一個連結並等待代碼（Cursor 的 `login` 在 `E2E_FAKE_CURSOR_LOGIN_MS` 之後，或 stdin 收到一行時完成；Cursor 的登入和真正的一樣，每個電腦使用者只有一個，而 key 本身就能讓一次執行登入）。`relay.fakeLog()` 也記下每次啟動的家目錄，以及它有沒有拿到 API key、是不是測試預期的那個（`E2E_EXPECTED_API_KEY`；從不記下 key 本身）、每個回合的模型、推理強度與 skill（以及 Grok 的信任），還有工具庫的 MCP 伺服器拿到的值。`E2E_FAKE_SIGNED_OUT=codex,cursor`（透過 `serverEnv`，用 provider id）會讓那些 CLI 處於未登入狀態（`gh` 也可以）。`E2E_FAKE_CURSOR_TEAM_ALLOW` 給假的 Cursor 一份團隊的自動執行允許清單（指令開頭，符合的就不詢問直接執行）。
- **假模型端點**（`e2e/support/relay.ts` 的 `FakeEndpoint`）：每個測試的伺服器旁邊都有自己的一個小 HTTP 伺服器，設成模型來源 `e2e`（`http://127.0.0.1:<port>/v1`，模型是 `e2e-model` 與 `e2e-model-mini`），每個開源 agent 的預設模型是 `e2e/e2e-model`，所以每個測試中開源 agent 都已安裝且可使用。那裡沒有模型會回答：它列出自己的模型（`GET /v1/models`），並收下在 Harness Relay 自己的沙箱裡執行的假 CLI 送來的紀錄（`POST /e2e-log`，`E2E_FAKE_LOG_URL`），因為它們在那裡不能寫紀錄檔（`E2E_FAKE_LOG`）：這次執行的模型來源是沙箱唯一讓執行連到的主機，`relay.ts` 會把這些紀錄加到同一個檔案，比回答晚一點（等回合 `settled()` 之後再讀，或用 `e2e/support/clis.ts` 的 `logged()`）。開源 agent 在 macOS 上，以及裝了 bubblewrap、socat 與 ripgrep 的 Linux 上，以完全存取以外的權限在真正的沙箱裡執行：`e2e/global-setup.ts` 會判斷一次沙箱在這裡能不能運作（`E2E_RELAY_SANDBOX`：`ok`，或不能的原因；`e2e/support/sandbox.ts`），需要沙箱的測試在不能運作的地方會跳過並說明原因，設定 `E2E_REQUIRE_RELAY_SANDBOX=1`（像 CI 那樣）時則改為失敗。某個 CLI 只能以完全存取執行的地方（Windows 上的開源 agent、Linux 上的 OpenCode），與權限有關的測試會跳過它（`needsBelowFull()`），其他測試則以完全存取執行它（`basePermission()`）；測試每個 CLI 的測試會分成兩個團隊執行，有登入的五個與五個開源 agent，因為一個團隊最多八位成員。
- **假的選擇資料夾視窗**（[`e2e/fake-cli/fake-dialog.cjs`](../e2e/fake-cli/fake-dialog.cjs)）會在 macOS 與 Linux 上和假 CLI 一起安裝成 `zenity`。Linux 在圖形環境中會從 PATH 找選擇資料夾視窗，所以設定了 `DISPLAY`（透過 `serverEnv`）的測試，輸入框會出現選擇資料夾按鈕，而假視窗會回答 `E2E_FAKE_PICK` 列出的資料夾（JSON，每個都從視窗開啟的資料夾解析），沒有列出任何資料夾時就當作取消。它的參數與字元集會記到 `relay.fakeLog()`（`cli: 'zenity'`）。macOS 與 Windows 會以完整路徑開啟自己的視窗，所以這些測試只在 Linux 上執行。
- **假的 GitHub CLI**（[`e2e/fake-cli/fake-gh.cjs`](../e2e/fake-cli/fake-gh.cjs)）會在每個系統上和假 CLI 一起安裝成 `gh`（在 Windows 上是假 CLI 的同一個執行檔換成這個名稱：以 `gh` 啟動時它執行假的 GitHub CLI，所以全部十一個名稱只需建置一次）。它回答分享與問題回報的截圖向 `gh` 要求的事（`--version`、`gist create`、`gist delete`、`api gists/<id>`），把 gist 存在測試的資料夾（`fake-github/`），記下它的參數（`cli: 'gh'`），其他指令一律拒絕，所以不會連到 GitHub。AgentsView 不需要假程式：`e2e/specs/sessions.spec.ts` 會在 127.0.0.1 上為它啟動一個小 HTTP 伺服器。
- **測試開始前**，[`e2e/global-setup.ts`](../e2e/global-setup.ts) 會在 UI 的來源檔比 build 新時建置 UI，兩份都會：`npm run build` 的那份（`dist/web`），以及開發版 build（`dist/web-dev`，`NODE_ENV=development`：React 的 StrictMode 會把每個 effect 執行兩次，就像 `npm run dev`），給需要它的測試使用（把 `RELAY_WEB_DIR` 設成 `e2e/support/paths.ts` 的 `DEV_WEB_DIR`）。`E2E_BUILD=always` 每次都建置兩份，`E2E_BUILD=never` 從不建置（CI 在自己的步驟中用同樣的方式建置）。接著安裝假 CLI，並判斷一次 Harness Relay 自己的沙箱在這台電腦上能不能運作（`E2E_RELAY_SANDBOX`，交給各個 worker）。
- **撰寫測試**：在 `e2e/specs/<範圍>.spec.ts` 中，從 `../fixtures` 匯入 `test` 與 `expect`，並從 [`e2e/support/app.ts`](../e2e/support/app.ts) 匯入操作步驟（`startChat`、`send`、`confirmTeam`、`finishedReply`，以及透過 API 建立自訂團隊對話的 `openTeamChat` 等）。測試每個 CLI 時，用 [`e2e/support/clis.ts`](../e2e/support/clis.ts) 的輔助函式（`eachCli(CLIS, …)`、`chatWith()`、`HALVES` 與 `teamOf()`、`needsBelowFull()`），CLI 之間不同的地方從它的資料（`e2e/support/clis/<provider>.ts`）取得，而不是看它的名稱。登入後的頁面從首頁開始（`homePage`）；`openNewChat` 從側邊欄打開新對話頁。在 UI 有提供時，依角色與看得到的文字找元素（除非測試改了語言，否則是英文），否則才用 CSS class。要讓 agent 做新的事，就在假 CLI 中加一個新指令（`e2e/fake-cli/lib/plan.cjs` 的 `DIRECTIVES`），再由每個 CLI 的模組以自己的協定做出來。

目前的測試（每個情境見 [`e2e/README.zh-TW.md`](../e2e/README.zh-TW.md)）：

- `e2e/specs/home.spec.ts` — app 打開時的首頁、側邊欄的 logo 與名稱回到首頁，以及 logo 的動畫：只播一次、只動 `transform` 與 `opacity`、減少動態效果時不播放。
- `e2e/specs/chat.spec.ts` — 新對話：首席 agent 的團隊卡片、確認後的回答；不詢問直接使用團隊；所有 CLI 組成的團隊依序回答（有登入的五個，以及五個開源 agent）；追問時另組團隊。
- `e2e/specs/activity.spec.ts` — 各 CLI 的思考、工具呼叫（它自己列出目錄的工具，含輸出）與待辦清單（Cline 與 Pi 沒有）；Markdown 回答（標題、清單、表格、程式碼）。
- `e2e/specs/approvals.spec.ts` — 各 CLI 執行指令前的詢問（Pi 在編輯模式下，針對 `npm publish`）：允許（會執行）、附註後拒絕（附註顯示在卡片上；轉交給 Claude Code、Grok、OpenCode、Goose 與 Pi，Codex、Cursor、Cline 與 OpenHands 則丟掉它，Antigravity 結束它的回合）；「一律允許」讓下一次同樣的請求自動通過；請求等待時停止；各 CLI 在完整權限下不詢問就執行指令並寫到任何地方；自動拒絕的對話。
- `e2e/specs/files.spec.ts` — 編輯模式：寫入檔案、`git init`、變更卡片與這一回合的差異；各 CLI 在唯讀對話中都不寫入任何檔案（Claude Code 與 Pi 沒有檔案工具，Cursor 被它自己的規則拒絕，其他的詢問後被拒絕），以及自動拒絕時 Grok 顯示的原因；各 CLI 的回合各自記下變更，分成兩個團隊；平行模式的 worktree 與套用其中一份結果；檔案瀏覽器與檔案預覽；把資料夾下載成 ZIP（它的檔案，沒有 `.git`），以及太大的資料夾改為提供不含 git 忽略的檔案。
- `e2e/specs/folders.spec.ts` — 編輯模式下，自動拒絕時對話沒有的資料夾各 CLI 都碰不到（開源 agent 的寫入由 Harness Relay 自己的沙箱拒絕），而使用者允許後 Claude Code、Codex、Cursor 與 Antigravity 能寫到那裡；多個工作目錄：在輸入框中加入與移除資料夾、各 CLI 在每個資料夾寫檔且變更卡片依資料夾列出（Windows 上的 Grok 只從簡報得知它們，Cursor 寫入第二個前會詢問）、檔案瀏覽器的資料夾、平行模式中每個資料夾的 worktree 一起套用，以及設定中的預設工作目錄。在 Linux 上測試選擇資料夾視窗（假的 zenity）：在視窗中選的資料夾加進輸入框、對話在這些資料夾中開始、視窗開在最後一個資料夾裡並允許多選，以及在沒有 UTF-8 locale 的伺服器上用中文時，視窗標題是中文並帶 `LC_CTYPE=C.UTF-8`，按取消則不加入任何資料夾。
- `e2e/specs/turns.spec.ts` — 向使用者提問並取得回答、略過問題、接力交棒、只有被 @ 的成員回答、之後的回合 PASS、各 CLI 的回答被停止、它的錯誤（結束程式與協定之內的錯誤）與重試、下一回合接續自己的 session、CLI 遺失 session 的成員帶著到目前為止的對話重新開始、回答途中送出的訊息交給下一位成員。
- `e2e/specs/history.spec.ts` — 編輯訊息後重新送出（取代它之後的內容）、對已完成的回答重試、從某則回答分支出新對話。
- `e2e/specs/team.spec.ts` — 在團隊設定中請首席 agent 加入成員，儲存後新成員回答；首席 agent 的回答無法解讀時改用範本；拒絕為新問題提議的團隊，由目前的團隊回答。
- `e2e/specs/inputs.spec.ts` — 除了 prompt 之外交給各 CLI 的東西：工具庫的 MCP 伺服器（其秘密不會出現在命令列上）、透過 HTTP 的 MCP 伺服器（其秘密標頭也一樣；Antigravity 除外，它的轉接器不給它）與附加的圖片（Cline 除外，它不接受圖片）。
- `e2e/specs/sandbox.spec.ts` — 包住開源 agent 的 Harness Relay 自己的沙箱：唯讀對話中使用者允許的寫入仍被拒絕，這次執行不能連的主機會先詢問、拒絕後就不連；在只能以完全存取執行的地方（Windows；Linux 上的 OpenCode），權限低於完全存取的開源 agent 不會啟動，並說明原因；macOS 上沒有終端機開關的 OpenHands；Antigravity 在 agy 啟動前先詢問專案自己的設定，被拒絕時就不啟動。
- `e2e/specs/sidebar.spec.ts` — 群組與首席 agent 把新對話分進群組、重新命名與刪除（刪除開著的對話後改為顯示首頁）、依 agent 寫的內容搜尋、一開始就給的標題；把對話拖進與拖出群組，以及分支對話的家族一起移動；每個 CLI 的狀態點與可用數量排在一行，箭頭尖端對齊回報問題圖示的右緣。
- `e2e/specs/models.spec.ts` — 成員的模型與推理強度交給各 CLI（Claude Code 的參數、Codex 的 thread、Grok 的 session 選項，其他則照各自轉接器交給它們的方式；開源 agent 的模型來自假端點），以及設定中的預設模型與推理強度用於保留「預設」的成員。
- `e2e/specs/tools.spec.ts` — 工具庫的頁面，每個 CLI 各一位成員，分成兩個團隊：MCP 伺服器（秘密遮蔽顯示且不在命令列上）、從資料夾挑選並由各 CLI 讀取的 skill、給所有成員與給某個 CLI 的記憶，以及各自對某個 CLI 或在成員的工具中關掉；給 MCP 伺服器新的值後移除它，以及移除 skill 與記憶筆記。
- `e2e/specs/share.spec.ts` — 複製回答的 Markdown 與整段對話（Chromium）；透過假的 `gh` 分享成 secret gist，在設定中列出並移除；`gh` 未登入與不存在（Windows 上跳過）。
- `e2e/specs/accounts.spec.ts` — 對每個有登入的 CLI：新增帳號自己的家目錄（Cursor 與 Antigravity 的用 API key 登入）、每個帳號各自登入與登出（Claude Code 的登入流程；Codex 與 Grok 各自登出）、金鑰儲存區關閉時帳號的 API key（Claude Code、Grok、Cursor 與 Antigravity：遮蔽顯示，只交給它的 CLI；Codex：在它的資料夾執行 `codex login --with-api-key`）、伺服器自己的 key 只給預設帳號、移除帳號（登出、刪除它的資料夾、它的成員與首席 agent 改用預設帳號），以及對話執行中不能移除；還有在較舊的狀態回答仍在路上時新增帳號，頁面保留較新回答的狀態（用 `page.route` 把那個回答擋下），以及在 Harness Relay 以外登出的 CLI，在伺服器的快取時間內重新打開設定時會顯示為未登入（app 拿到的快取回答被擋到設定自己的回答之後）。
- `e2e/specs/native.spec.ts` — 各 CLI 自己載入的內容：列出它自己的 skill，並在下一次執行時不載入（Claude Code、Codex），以及 Grok 對資料夾的信任（從 Grok 卡片，以及從新對話的團隊卡片信任或拒絕）。
- `e2e/specs/sessions.spec.ts` — 各 CLI 自己的資料夾，分成兩個團隊：session 存在那裡、改變後開始新的 session、被拒絕的資料夾、對話執行中不能改；AgentsView（代替的伺服器）：送出對話與成員的 session、Cursor 成員記下的 session 在 thread 之後送出並連在它底下、拒絕其他位置的網址、在設定中顯示更新失敗。
- `e2e/specs/report.spec.ts` — 問題回報：郵件的 `mailto:` 與 Gmail 連結帶著資訊、保留草稿、太長而放不進連結的回報、要先上傳的截圖，以及無法上傳的截圖（`gh` 未登入）。
- `e2e/specs/appearance.spec.ts` — 使用導覽（一步步走完、跳過、從設定重新觀看）與主題（保留深色或淺色、跟隨系統）。
- `e2e/specs/templates.spec.ts` — 內建範本與其成員、首席 agent 直接使用範本、把設計好的團隊存成範本。
- `e2e/specs/limits.spec.ts` — 用 `RELAY_MAX_TEAM_AGENTS`、`RELAY_MAX_ACCOUNTS` 與 `RELAY_TURN_TIMEOUT_MIN` 啟動的伺服器：`GET /api/limits`、團隊編輯器不再能新增成員（人數更多的範本也被拒絕）、設定不再能新增帳號、內建範本（三位成員）說明它為何不能用，且首席 agent 改用截成兩位的通用範本，以及排程的說明顯示設定的逾時。
- `e2e/specs/schedule.spec.ts` — 儲存對話的排程並立即執行一次。
- `e2e/specs/settings.spec.ts` — 側邊欄底部排成一行的狀態圓點（可用的數目、顯示名稱並在重新載入後保留）；各 CLI 的版本與登入（開源 agent 在假端點上顯示「可使用」）、執行檔路徑（錯誤的路徑顯示找不到 CLI）、重新載入後保留的語言、選另一個 CLI 擔任首席 agent；每個有登入的 CLI 未登入時（設定、側邊欄，以及它回答中的錯誤）；未安裝的 Cursor 與 Antigravity（`missingClis`）；沒有模型來源而還不能用的開源 agent，以及它回合的錯誤（`openBackend: false`）。
- `e2e/specs/windows.spec.ts` — 只在 Windows 上：透過 CLI 在那裡安裝後的啟動器（Cursor 自己的 `cursor-agent.cmd`、npm 給 Node 腳本與給程式的 shim）啟動 CLI，在設定中把它們設成執行檔路徑：每個都找得到版本，並且會回答。
- `e2e/specs/signin.spec.ts` — 登入頁、錯誤的代碼、用代碼登入、一次性的登入連結（用過的連結顯示錯誤）、在已顯示登入頁的分頁打開連結、用代碼登入後又被登出時不再顯示連結的錯誤、在已登入的分頁打開連結時，帶舊金鑰還在路上的請求不會讓它被登出（這些請求的「已登出」回應與登入的回應同時到達頁面；頁面一次也不會登出）、顯示登入頁的分頁跟著同一個瀏覽器的另一個分頁登入、在另一個分頁打開連結時，即使第一個分頁有請求還在路上，所有分頁都保持登入、還在做第一次檢查的分頁跟著別的分頁登入（它的第一個回答那時已過時）、登入沒有回應時 30 秒後放棄並顯示訊息（用頁面的時鐘）、在設定中登出；在介面的開發版 build（React 的 StrictMode）中，連結第一次載入就進入 app（只問一次是否已登入）、錯誤的連結顯示錯誤，在已登入的分頁打開連結，以及在另一個分頁打開連結。
- `e2e/specs/voice.spec.ts` — 設定中的語音輸入安裝（GET /api/voice 的狀態加上一個安裝，因為真正的安裝要下載）：步驟排成一列、給螢幕閱讀器的步驟狀態（目前的步驟有 `aria-current`）、下載百分比與進度條的填色；安裝失敗時停下的步驟。
- `e2e/specs/i18n.spec.ts` — 繁體中文的介面（包括首頁的標語）與首席 agent 卡片，而 prompt 仍是英文；登入頁與伺服器自己的訊息為中文。
- `e2e/specs/mobile.spec.ts` — 手機畫面：從選單開啟側邊欄、以觸控送出、標題列的動作收在 ⋯ 之下、頁面不會左右捲動；首頁的標語變小且每行不換行，點 logo 會收起側邊欄。

假 CLI 檢查的是 Harness Relay 這一側的協定，不是 CLI 本身：CLI 若改變輸出，會由轉接器測試中錄下的訊息，以及執行真正 CLI 的[實機測試](#實機測試)發現。它們也不執行 CLI 自己的沙箱：Claude Code、Codex 與 Grok 的假 CLI 推算它們的沙箱會允許什麼，而開源 agent 的假 CLI 是真的在 Harness Relay 自己的沙箱中執行；真正的 CLI 在完全存取以外不會寫到對話的資料夾之外，由實機測試（`e2e/live/sandbox.spec.ts`）檢查。

## 實機測試

```bash
E2E_LIVE_OLLAMA=http://127.0.0.1:11434/v1 npm run test:e2e:live
E2E_LIVE_OLLAMA=http://127.0.0.1:11434/v1 E2E_LIVE_OLLAMA_TYPED=gemma4:26b E2E_LIVE_CLOUD=1 npm run test:e2e:live
E2E_LIVE_VLLM=http://127.0.0.1:8000/v1 E2E_LIVE_VLLM_MODEL=<它提供的模型名稱> E2E_LIVE_VLLM_KEY=<它的金鑰> npm run test:e2e:live
E2E_LIVE_OLLAMA=… E2E_LIVE_CLIS=opencode,claude npx playwright test -c playwright.live.config.ts -g "Team settings"
E2E_LIVE_CLOUD=1 E2E_LIVE_CLIS=antigravity E2E_LIVE_MODEL_ANTIGRAVITY=gemini-3.8-flash npm run test:e2e:live
npx playwright show-report playwright-report-live
```

同樣的伺服器與介面，但用真正的 CLI，以你自己的登入，跑在真正的模型上：你自己的 Ollama 或 vLLM 伺服器（任何 OpenAI 相容端點），以及設定 `E2E_LIVE_CLOUD=1` 時各 CLI 自己的雲端模型（由你的登入付費）。CI 從不執行它們：環境沒有提供某個測試需要的東西時，那個測試就會跳過。修改轉接器、沙箱或模型來源時，請盡量在各個系統上執行；它們能找到假 CLI 找不到的問題（某個 CLI 在某個系統上只能以完全存取執行，或在某處寫入不會詢問）。一次只跑一個測試（[`playwright.live.config.ts`](../playwright.live.config.ts)：一個 worker，每個測試最多 20 分鐘，報告在 `playwright-report-live/`），因為真正模型上的一個回合很慢，而且這些 CLI 共用你自己的資料夾。

- **執行環境**（`startRelay({ live: true })`，透過 `test.use({ live: true })`）：每個測試仍有自己的伺服器，有自己的資料資料夾、工作目錄與 `RELAY_KEYRING=off`（端點的金鑰留在那個測試的資料庫），但 `HOME` 與各 CLI 自己的資料夾是你的，所以 CLI 以你的登入執行，它們的 session 也會存進你的資料夾；`PATH` 最前面沒有假 CLI，也不會把任何 CLI 設成未安裝。不在 `PATH` 上的 CLI 用 `E2E_LIVE_BIN_<PROVIDER>` 指定（`E2E_LIVE_BIN_OPENHANDS=~/.local/bin/openhands`）。在 macOS 與 Linux 上，伺服器的資料夾放在 `/tmp`：Harness Relay 自己的沙箱需要短的路徑來放它的 socket，而 macOS 的暫存資料夾太深。由於 CLI 是以你的身分執行，核准只會給測試要求的事（`liveAllows()`：把 `hi` 寫進檔案的指令，以及寫入對話自己的資料夾）；其他一律拒絕。Harness Relay 的任何一次執行在 CLI 自己資料夾留下的東西都會留著：Grok `config.toml` 裡端點模型的區塊、CLI 的 session，以及 CLI 替專案資料夾記下的信任（這裡是暫存資料夾）。
- **環境變數**：`E2E_LIVE_OLLAMA`（以 `/v1` 結尾的 base URL）與 `E2E_LIVE_OLLAMA_MODEL`（預設 `gemma4:e4b`）、`E2E_LIVE_OLLAMA_TYPED`（那台伺服器上的另一個模型，用來測為端點輸入的模型）、`E2E_LIVE_VLLM`、`E2E_LIVE_VLLM_MODEL` 與 `E2E_LIVE_VLLM_KEY`、`E2E_LIVE_CLIS`（要試的 CLI，以逗號分隔；預設全部十個）、`E2E_LIVE_CLOUD=1`（也試各 CLI 自己的雲端模型：Claude Code、Codex、Grok、Cursor 與 Antigravity 的，即 `live.ts` 的 `CLOUD_CLIS`），以及 `E2E_LIVE_MODEL_<CLI>`（那個 CLI 自己清單裡的一個模型，雲端測試時在「團隊設定」中選它，例如 `E2E_LIVE_MODEL_ANTIGRAVITY=gemini-3.8-flash`；沒設定時用它的預設模型）。每個測試都在自己伺服器的「設定」中設好端點，並讓 OpenHands 能在沙箱中使用終端機（它在完全存取以外需要這個）。Antigravity 沒有自訂端點，所以只在 `E2E_LIVE_CLOUD=1` 時執行，用 agy 自己保存的登入（用 Google 登入，存在你的 `~/.gemini` 與系統鑰匙圈），或你環境中的 `GEMINI_API_KEY`（實機測試會保留它）。
- **檢查的內容**（[`e2e/live/`](../e2e/live/)，共用的部分在 `live.ts`）：
  - `models.spec.ts` — 每個能在端點上執行的 CLI（Claude Code、Codex、Grok 與五個開源 agent），在每個提供的端點上：在「團隊設定」的模型選單中（選單列出了它）選好它的模型、儲存，並回答一個問題（17 + 25），而且 Claude Code、Codex 與 Grok 的 session 記錄在那個端點上（`agent_sessions.backend`，從測試的資料庫讀取：不是它們自己的服務）；同樣這三個，在「設定」的卡片上從「你自己的端點」選端點的模型當作預設模型，沒有指定模型的成員就跑在它上面；設定 `E2E_LIVE_CLOUD=1` 時，`CLOUD_CLIS` 的每一個用它自己的預設模型，設定了 `E2E_LIVE_MODEL_<CLI>` 時也用在「團隊設定」中選的那個模型（Claude Code、Codex 與 Grok 的 session 記錄在它們自己的服務上）；成員的模型屬於已刪除的端點時，它的回合會失敗並說明原因（`E2E_LIVE_CLIS` 中 Claude Code、Codex 與 Grok 的第一個：端點已刪除，這一輪沒有執行；第一個開源 agent：沒有這個端點）；Grok 用為端點輸入、端點清單裡沒有的模型（`E2E_LIVE_OLLAMA_TYPED`）；在 Windows 上，開源 agent 在完全存取以外不會執行，並說明原因。
  - `teams.spec.ts` — 一個團隊裡，最多三個 CLI 用自己的模型（Claude Code 優先）、兩個用端點上的模型，各自回答自己的問題（`E2E_LIVE_CLOUD=1`）；每個 CLI 在可編輯模式下用它的 shell，在兩個工作目錄中各寫一個檔案，用第一個端點的模型，設定 `E2E_LIVE_CLOUD=1` 時 `CLOUD_CLIS` 的每一個也用它自己的模型（Claude Code、Codex 與 Grok 在它們自己的沙箱中，Cursor 與 Antigravity 在每個指令前詢問；開源 agent 在 Windows 上、OpenCode 在 Linux 上以完全存取執行，那是它們在那裡唯一能用的權限）；Cursor 用自己的檔案工具寫入第二個工作目錄，卡片說明檔案在對話的另一個工作目錄中（資料夾放在你的家目錄下，測完刪除，因為 Cursor 在暫存資料夾中寫入不會詢問）；設定 `E2E_LIVE_CLOUD=1` 時，Antigravity 在指令被拒絕時結束它的回合（`liveAllows()` 會拒絕 `echo no >`：沒有檔案，被拒絕的呼叫寫著 Antigravity 被拒絕後會結束回合，之後也沒有任何東西），以及在 agy 啟動前先詢問專案自己的 MCP 伺服器（`.agents/mcp_config.json`）：被拒絕後回合不會開始，伺服器也從沒執行。
  - `sandbox.spec.ts` — 假 CLI 證明不了的事：在這裡能以完全存取以外執行的每個 CLI，在編輯模式下被要求寫一個對話資料夾之外的檔案（`echo hi >` 寫進你家目錄下的資料夾，而不是暫存資料夾），由對話自動拒絕（`approvals: 'deny'`），都不會寫到那裡：Claude Code、Codex 與 Grok 靠它們自己的沙箱，開源 agent 靠 Harness Relay 的，沒有沙箱的 Cursor 與 Antigravity 靠先詢問。用端點的模型，或設定 `E2E_LIVE_CLOUD=1` 時用 CLI 自己的模型；模型連試都沒試時跳過。
- 小模型不一定照要求做（呼叫它的 shell 工具、只回答數字），所以檢查失敗時會說明那個回合做了什麼：它的錯誤，以及它呼叫了哪些工具。可用 `E2E_LIVE_OLLAMA_MODEL` 換一個更強的模型。

## 持續整合（CI）

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) 會在每個 pull request 與每次推送到 `main` 時執行：`npm ci`、`npm run typecheck`、`npm test` 與 `npm run build`，在 Ubuntu 上以 Node 22（支援的最低版本）與 Node 24 各跑一次，也在 Windows（`windows-latest`）上以 Node 24 跑一次，那裡測試的暫存資料夾放在與取出的程式碼同一個磁碟 `D:`（`runner.temp`），而不是 `C:`。在 Ubuntu 上它也會安裝桌面 app 的工具（不下載 Electron 執行檔）、型別檢查並建置桌面 app（`desktop/scripts/build.ts`），並像 app 一樣執行打包好的伺服器（`desktop/scripts/smoke.ts`）。第二個 job（`desktop-package`）會打包桌面 app（不建置安裝檔）：Linux（`electron-builder --linux dir`，x64 一份，也像發佈一樣在 GitHub 的 Arm runner 上打包 Arm64）與 Windows x64（`--win dir`；Windows on Arm 由發佈 workflow 檢查），並像檢查發佈一樣檢查它（`desktop/scripts/check-package.ts`：Linux 上在虛擬顯示器上，runner 缺 Electron 需要的函式庫時會先安裝），所以每個 pull request 都會在 Linux 與 Windows 上讓打包好的 app 的假 CLI 團隊回答一個問題。發佈有自己的 workflow：見[發佈](#發佈)。對同一個 pull request 再次推送時會取消前一次的執行。推送前請先在本機跑過同樣的指令。

[`.github/workflows/e2e.yml`](../.github/workflows/e2e.yml) 會在每個 pull request 與每次推送到 `main` 時，以 Node 24 於 Ubuntu、macOS 與 Windows 上，並以 Node 22 於 Ubuntu 上，執行[端對端測試](#端對端測試)（`npm run test:e2e`，Chromium；每次最多 45 分鐘）；手動執行（**Actions → End-to-end tests → Run workflow**）可以選擇其他瀏覽器。測試之前，它會設好開源 agent 的假 CLI 在完全存取以外執行時所在的 Harness Relay 自己的沙箱：在 Ubuntu 上，runner 沒有 bubblewrap、socat 與 ripgrep 時安裝它們，Ubuntu 限制非特權 user namespace 時再加上讓 `/usr/bin/bwrap` 能建立它們的 AppArmor 設定檔；接著在 Ubuntu 上執行沙箱自己的檢查（`npx tsx scripts/sandbox-check.ts`；macOS 上不執行：那裡 runner 的 curl 在 macOS 26.7 的沙箱裡無法驗證憑證，連到 example.com 的檢查會失敗），並在 Ubuntu 與 macOS 上以 `E2E_REQUIRE_RELAY_SANDBOX=1` 執行測試，讓需要沙箱的測試在那裡失敗而不是跳過。每次執行都會上傳 HTML 報告，並附上每個失敗測試的 trace、截圖、影片與紀錄（`e2e-report-<os>-node<版本>`）。

若要在檢查通過前禁止合併，請在 repository 設定中替 `main` 加上 branch protection rule（或 ruleset），並把 `Typecheck, test, build` 檢查設為必要（若也想要，可加上 `End-to-end` 檢查）。

### 網站

https://agentic-system-lab.github.io/harness-relay/zh-TW/ 的網站首頁是 [`site/`](../site/) 裡的純 HTML、CSS 與 JavaScript：`index.html`（English）、`zh-TW/index.html`（繁體中文）與共用的 `assets/`，不需要建置。[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) 會在推送到 `main` 且改到 `site/`、`docs/media/` 或這個 workflow 時執行：把 `site/` 與 `docs/media/` 的示範影片複製到同一個資料夾、排除 Markdown 檔，再部署到 GitHub Pages（repository 設定 → Pages → Source：GitHub Actions）。用 `npm run site:preview`（[`scripts/preview-site.ts`](../scripts/preview-site.ts)）在本機預覽：它會在 http://127.0.0.1:4180 提供 `site/`（可用 `SITE_PORT` 換埠號），影片直接從 `docs/media/` 讀取，和 Pages 上的樣子相同。修改頁面前請先讀 [`site/DESIGN-GUIDELINES.md`](../site/DESIGN-GUIDELINES.md)，裡面也說明重錄示範影片後要更新哪些地方。

### 錄製示範影片

README 與網站首頁的示範影片（`docs/media/demo-*.mp4` 與 `.webp`）是實際執行的錄影，由 `npm run demo`（[`scripts/demo/`](../scripts/demo/)）錄製。影片經過的介面改變時，請重新錄製。需要：三個 CLI 都已安裝並登入、FFmpeg 與 libwebp（macOS：`brew install ffmpeg webp`），以及 `playwright-core` 驅動的 Chromium（執行一次 `npx playwright-core install chromium-headless-shell`，或用 `DEMO_CHROME` 指定 Chrome 或 Chromium 的執行檔）。

```bash
npm run demo                          # 錄製兩種語言，剪輯並發佈
npm run demo -- record --dry          # 不跑 agent，只檢查到開啟對話為止的操作流程（不到一分鐘）
npm run demo -- record --lang en      # 只跑一個步驟、一種語言
npm run demo -- cut publish           # 重新剪輯並發佈上次的錄影
```

1. **record**：建置 UI，在獨立的埠號（8791，第二種語言用 8792）啟動 Harness Relay，資料放在 `data/demo/<lang>/` 裡的空資料夾，不會動到你自己的對話與設定；對話的工作目錄是這個 repository（唯讀）。接著 headless 瀏覽器像人一樣操作（畫出游標）：新增群組、打開「三方辯論」範本、開新對話並提出點名三個 CLI 的問題、確認首席 agent 的團隊、等待回答（超出唯讀的請求會顯示後拒絕，agent 問的問題會略過）、問一個有自己團隊的新問題、在「檔案」裡打開 `orchestrator.ts` 中接力模式交棒的地方，最後搜尋。兩種語言同時錄，用真正的 CLI 約需半小時。每個步驟都會在 `marks.json` 留下標記。
2. **cut**：把 agent 工作的片段加速，讓影片長約兩分鐘（`--length`），寫出 `video.mp4`（1600×1000、24 fps）、`animation.webp`（880×550、8 fps）與 `timeline.json`。如果錄影時白等了一段，在 `marks.json` 加一對 `skip-start` / `skip-end` 再剪一次。
3. **publish**：把影片與動畫複製到 `docs/media/`，從第一個團隊卡片出現的畫面（`poster` 標記）重新擷取海報、截圖與社群預覽卡，重新計時 `site/index.html` 與 `site/zh-TW/index.html` 的章節列，以及 `site/DESIGN-GUIDELINES.md` 裡的畫面時間，並寫出 `data/demo/<lang>/review.md`：寫入的章節、團隊、核准請求、搜尋詞與每則回覆。

之後讀 `review.md` 並看過影片。章節的句子在 `scripts/demo/chapters.ts`；團隊、名字、輪數、群組與搜尋詞會依錄影填入，但如果 agent 做了句子沒描述到的事，請在那裡修改，再執行 `npm run demo -- publish`。也請檢查 README 的影片說明與章節列的註記，再把影音檔、`site/` 與腳本一起 commit。

## 發佈

一次發佈就是桌面 app 在 macOS（Apple Silicon 的 `.dmg`）、Windows（x64 與 Arm64 `.exe`）與 Linux（x64 與 Arm64 `.AppImage`）的安裝檔，由發佈 workflow（[`.github/workflows/release.yml`](../.github/workflows/release.yml)）一起發佈成一個 GitHub release。它要手動執行；沒有其他方式會建立 release 或 tag。

**版本**是發佈當天在台灣的日期（`RELEASE_TIME_ZONE`，Asia/Taipei），git tag 就是版本本身：

| 版本 | 代表 |
| --- | --- |
| `YYYY-MM-DD-rc` | 當天正式版本的候選版本，發佈成 pre-release |
| `YYYY-MM-DD-rc.1`、`.2`… | 它當天的修正 |
| `YYYY-MM-DD` | 正式版本 |
| `YYYY-MM-DD.1`、`.2`… | 它當天的修正 |
| `YYYY-MM-DD.1-rc`、`YYYY-MM-DD.2-rc`… | 那個修正版的候選版本，發佈成 pre-release |
| `YYYY-MM-DD.1-rc.1`、`.2`… | 它當天的修正 |

之後某天的修正就是那天的版本，不是修正編號。候選版本可有可無，而且一定是當天下一個版本的候選版本：正式版本發佈之前是正式版本的，之後是它下一個修正版的（`npm run release:next` 兩個都會列出）。已發佈的版本的候選版本會被拒絕：它會排在那個版本之前（`2026.1110.0-rc.2` < `2026.1110.0`），而依發佈時間提供最新版本的下載頁會改顯示它（依版本比較的 app 則絕不會提供它）。修正版的候選版本排在它前一個版本與那個修正版之間（`2026.1110.0` < `2026.1110.1-rc` < `2026.1110.1-rc.1` < `2026.1110.1`），所以兩者找到的最新版本相同。

**發佈步驟：**

1. 在 `main` 上查看今天的下一個版本：`npm run release:next`（它會讀 GitHub 上的 tag）。
2. 在 GitHub 打開 **Actions → Release → Run workflow**，**Use workflow from** 保持 main，填入版本後執行。

`npm run release:check -- <版本>` 會在本機用同樣的方式檢查版本（對照本機的 tag；`npm run release:check -- <版本> --remote` 則對照 GitHub 上的：少了 `--`，npm 會把 `--remote` 留給自己），並說出它的說明會從哪個版本算起。`npm run release:notes -- <版本> --remote` 會依這些規則印出它的說明列出的變更（還沒發佈的版本用 `--target <commit>`：SHA、tag 或 GitHub 上的分支，用 `main` 而不是 `origin/main`），透過你的 `gh` 從 GitHub 讀取。

**說明列出什麼。** 從較早的一個版本以來、到發佈所在的 commit 為止，每一個進到 `main` 的 commit，不論是直接 push 到 `main` 還是從 pull request 合併進來的（`scripts/release.ts notes`、`releaseChanges()`）：也就是 GitHub 比較這兩者時列出的 commit（`git log <較早的版本>..<commit>`，合併帶進來的 commit 也在內），由舊到新，各列出它的標題。合併了某個 pull request 的 commit（squash、rebase 或 fast-forward，依 GitHub 記錄的那個 pull request 的 merge commit）連到那個 pull request，拿掉 squash 加在標題結尾的 ` (#N)`，作者是開那個 pull request 的人；其他 commit 連到它自己，作者是它的作者。用 git 的措辭寫的 merge commit（「Merge pull request …」、「Merge branch …」、「Merge main into …」）本身沒有說明什麼：合併了 pull request 的，以那個 pull request 的標題列出；其他的不列，因為它帶進來的 commit 都已列出。標題維持一行文字：開頭的 `#`、`>`、`-`、`+`、`*` 或 `1.` 會被跳脫，其中（程式碼與連結以外，連同接在後面的部分，以及沒有帳號的作者在 git 中的名字）的 `@名字` 會放進程式碼，讓說明不會通知只是被提到的人。接著是在說明起點版本之前沒有 commit 的作者（依帳號，或依他在清單中的 email；GitHub 只能依 email 找到 bot 的 commit），列為 New Contributors，各附上他在清單中的第一個 pull request（沒有就是第一個變更），以及這次比較的連結（Full Changelog），與 GitHub 自己的說明相同（bot 寫成 `@名字`，不加 `[bot]`）。向 GitHub 的查詢一次八個，每個 commit 查一次它的 pull request。清單超過 100,000 個字元時（GitHub 的版本說明上限是 125,000，包括安裝說明），結尾會說還有多少變更，並連到這個 tag 為止的歷史（GitHub 的比較頁面最多只顯示 250 個 commit）。GitHub 自己產生的說明（`--generate-notes`）只列 pull request，直接 push 到 `main` 的變更都會漏掉。

**說明從哪裡算起**（`scripts/release.ts` 的 `previousVersion()`）：

- 正式版本從它前一個正式版本算起，所以說明包含那之後的所有變更，它的候選版本的也在內（`2026-11-12` 從 `2026-11-11.1` 算起，而不是從 `2026-11-12-rc.1`）；
- 候選版本從它前一個版本算起，正式版本或候選版本都可以（`2026-11-12-rc` 從 `2026-11-11.1` 算起，`2026-11-12-rc.1` 從 `2026-11-12-rc` 算起）。

「前一個」依版本（semver）的先後，而不是 tag 建立的時間。沒有這樣的版本時，說明列出從 repository 第一個 commit 到這個版本的每一個 commit。

**Workflow 在建置之前會檢查**（`scripts/release.ts`，由 `test/release.test.ts` 測試）：

- 版本符合規則；不符合時會說出確切原因：前面多了 `v`、`-RC` 用了大寫、`-rc1` 少了點、`.0`、`.01`、月或日只有一位數、日曆上沒有的日期（`2026-02-30`）、空白，或只是看起來像的字元（全形數字、en dash、不換行連字號）；
- 日期是台灣的今天，不是昨天或明天（也包括 UTC 與台灣日期不同的午夜前後）；
- 它是下一個版本：還沒發佈過、修正不會早於它修正的版本、編號不會跳號、候選版本只能是當天下一個版本的（不能是已發佈的版本的，也不能是比下一個更後面的修正版的）。錯誤訊息會說出今天該用哪些版本；
- 在 `main` 上執行。

接著它會執行型別檢查與測試，平行建置五個安裝檔，Arm64 的在 GitHub 的 Arm runner 上（每個都先對打包好的伺服器執行 `desktop/scripts/smoke.ts`，之後再對打包好的 app 執行 `desktop/scripts/check-package.ts`：fuses、resources 與 app 自己的 `--smoke-test`（包括問假 CLI 一個問題），Linux 上在 `xvfb-run` 裡），再對照當下的 tag 檢查一次版本（午夜前開始的執行維持它開始那天），確認 `INSTALLERS`（`site/assets/downloads.js`，網站與 app 的更新都依它找安裝檔）的每個檔名結尾正好各有一個安裝檔、沒有其他檔案，把每個安裝檔再複製一份給 app 更新用（`updateCopyName()`：`…-mac-arm64-update.dmg` 等，app 改下載這些，讓下載次數分得出更新與新安裝；網站不會提供它們。2026-11-12-rc 之前發佈的 app 仍會下載安裝檔，2026-11-12-rc 則在 release 本身裡找副本，所以在它們的使用者更新過一次之前，這些更新都算成新安裝），先把副本以相同 tag 發佈到公開 repository [`Agentic-System-Lab/harness-relay-updates`](https://github.com/Agentic-System-Lab/harness-relay-updates)（`UPDATES_REPO`），讓 app 不會在副本還沒上去前就看到新版本，然後在它建置的 commit 上發佈 release：安裝檔命名為 `Harness-Relay-<版本>-<系統>-<架構>.<副檔名>`，說明列出從起點版本以來進到 `main` 的每一個 commit（見上文；依最後那次檢查時的 tag，並在發佈任何東西之前列出，所以這一步失敗時什麼都不會發佈），並附上安裝說明（各安裝檔需要的系統、各系統第一次開啟時的警告、Ubuntu 24.04 的 `--no-sandbox`，以及誰會收到它：已安裝的 Harness Relay 會在選單與聊天介面提供，候選版本只提供給候選版本與自己建置的版本）。一次只會有一個發佈在執行，也只有發佈的 job 能寫入 repository；它用自己的 token 寫入副本的 repository，這個 token 只交給那一步。版本只透過環境變數交給指令碼，絕不放進指令列。

**副本的 token。** workflow 自己的 token 只能寫入這個 repository，所以副本用 `UPDATES_TOKEN` secret 上傳：一個 fine-grained personal access token，resource owner 是 Agentic-System-Lab，只給 repository `harness-relay-updates`，權限 **Contents: Read and write**。用 `gh secret set UPDATES_TOKEN --repo Agentic-System-Lab/harness-relay` 設定（它會詢問值）。沒有設定或過期時，發佈會在發佈任何東西之前停下，錯誤訊息寫出 secret 的名稱：建一個新的 token 再設定一次。

**下載次數。** GitHub 會記錄每個安裝檔的下載次數（不是安裝次數，重複下載也會再算）：新安裝記在這個 repository 的 release，已安裝 app 的更新記在副本的 repository：

```bash
gh api repos/Agentic-System-Lab/harness-relay/releases --paginate --jq '.[] | .tag_name as $t | .assets[] | "\($t)\t\(.name)\t\(.download_count)"'
gh api repos/Agentic-System-Lab/harness-relay-updates/releases --paginate --jq '.[] | .tag_name as $t | .assets[] | "\($t)\t\(.name)\t\(.download_count)"'
```

## 除錯技巧

- **伺服器 log**：`npm run dev` 輸出中的 `[server]` 行；轉接器失敗時，訊息的錯誤內容會附上 CLI stderr 的最後一段。
- **SSE**：`npm run dev` 時用 `curl -N -b 'relay_session=<cookie>' 'http://127.0.0.1:8789/api/conversations/<id>/events?key=<key>'` 可以看到原始事件串流（`npm start` 時是 8787）。`relay_session` cookie 與金鑰（localStorage 的 `relay:key`）從已登入瀏覽器的開發者工具取得。
- **語言**：在 `curl` 指令加上 `-H 'X-Relay-Lang: en'`，就能看到英文的錯誤與範本。
- **自動組隊**：首席 agent 的執行就是對話工作目錄中一個普通的 CLI session；它的回覆與費用記在 plan 訊息上（`messages.plan`、`cost_usd`）。
- **重現 CLI 呼叫**：`src/server/agents/*.ts` 中的參數可以手動執行；加上 `--debug`（Claude、Grok）可看到更多資訊。
- **worktree**：`git -C <工作目錄> worktree list` 與 `git branch --list 'relay/*'` 可以看到平行對話建立了哪些 worktree；實際檔案在 `data/worktrees/<對話>/`。
- **語音輸入**：`GET /api/voice` 會列出安裝了什麼，以及最近一次安裝的紀錄；引擎以 `whisper-server` 程序執行（可用 `ps` 查看），閒置 10 分鐘後停止。下載的檔案放在 `data/voice/`（`models/`，以及 Linux 與 Windows 上的 `engine/`），或 `RELAY_VOICE_DIR` 指定的資料夾；紀錄中會列出每個下載的網址。
- **session 卡住**：先停止伺服器，再刪除 `agent_sessions` 中該 agent 的那一列，就會強制開新 session 並提供完整紀錄（使用中的對話快取在記憶體裡，所以只在伺服器停止時修改資料庫）。

## 慣例

- 使用 strict TypeScript；共用型別只放在 `src/shared/types.ts`。
- 絕不把機密傳給前端（`SettingsView` 只回傳遮罩過的金鑰）。
- 新增的寫入端點會自動經過 `/api/*` 中介層的 JSON content-type 與 Host/Origin 檢查，請維持這個做法。
- 啟動程序一律透過 `process.ts`，這樣才會被追蹤並在關閉時結束。
