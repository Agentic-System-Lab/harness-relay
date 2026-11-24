[English](README.md) | **繁體中文**

# 端對端測試的情境

端對端測試（`npm run test:e2e`）目前測到的情境，依功能分區列出。它們在真正的瀏覽器中（[Playwright](https://playwright.dev)）操作建置好的 UI，面對真正的伺服器，十二個 agent CLI 則各有一個假的代替（Claude Code、Codex、Grok、Cursor、Antigravity、Copilot、Muse Code，以及五個開源 agent：OpenCode、Goose、Cline、OpenHands 與 Pi），所以不連網路、不花費用，在 macOS、Linux 與 Windows 上的執行方式也一樣，只差在各系統的沙箱允許什麼（見[平台與瀏覽器](#平台與瀏覽器)）。

它們如何運作、怎麼執行單一測試、怎麼撰寫新測試，見開發者說明的[端對端測試](../docs/developer-guide.zh-TW.md#端對端測試)。這一頁是情境清單：新增、修改或刪除端對端測試時，請在同一個 commit 裡一起修改這一頁與[英文版](README.md)（見 [AGENTS.md](../AGENTS.md) 的「Documentation」）。

目前共有 55 個 spec 檔、657 個測試，在每個執行的瀏覽器中各跑一次（預設是 Chromium）。有些只在某些系統上執行，或只在 Harness Relay 自己的沙箱能運作的地方執行：見[平台與瀏覽器](#平台與瀏覽器)。

## 執行

```bash
npm run test:e2e:install                      # 一次即可：Playwright 驅動的 Chromium
npm run test:e2e                              # 所有 spec，在 Chromium 中執行（UI 過期時會先建置）
npx playwright test e2e/specs/approvals.spec.ts
npx playwright test -g "relay mode"           # 依標題
npx playwright test --ui                      # 在 Playwright 的視窗中挑選並觀看測試
```

其他瀏覽器、報告與測試會讀的環境變數，見開發者說明。

## 每個測試一開始有什麼

- **自己的伺服器**：使用空閒的 port，資料、家目錄與各 CLI 的家目錄（那個家目錄裡的 `.claude`、`.codex`、`.grok`、`.gemini`、`.copilot`、`.config/cursor`，以及 Muse Code 的 `.config/muse` 與 `.local/share/muse`，開源 agent 的則在資料資料夾裡）都在暫存資料夾裡，並關閉作業系統的鑰匙圈：不會讀取或更動你自己的 Harness Relay、CLI 或鑰匙圈，你的憑證（Cursor、Antigravity 與 Google 的也一樣）不會留在它的環境變數裡（Antigravity 的預設帳號改拿測試自己的替身 Gemini API key，放在 `GEMINI_API_KEY`，這是它在 Harness Relay 唯一的登入方式），git 找 repository 時也不會超出測試的資料夾（[`support/relay.ts`](support/relay.ts)）。在 macOS 與 Linux 上，它的資料夾放在 `/tmp`（或 `E2E_TMP_DIR`），路徑短到放得下 Harness Relay 自己的沙箱的 socket。
- **自己的假模型端點**：一個小 HTTP 伺服器，設成模型來源 `e2e`（**設定 → 模型連線**），有 `e2e-model` 與 `e2e-model-mini` 兩個模型，每個開源 agent 的預設模型都設成 `e2e/e2e-model`，所以測試安裝的開源 agent 都可使用（OpenHands 的終端機開關也已打開）。伺服器列出這兩個模型，另外提供只能按 ID 查到的 `unlisted-model`，並收下在沙箱裡執行的假 CLI 送來的紀錄。測試可以不要它（`openBackend: false`）、關掉 OpenHands 的開關（`sandboxTerminal: false`），或讓某些 CLI 未安裝（`missingClis`）。
- **一個工作目錄**，裡面是一個小專案：`README.md`、`src/hello.ts` 與 `src/lib/math.ts`（`seedProject()`）。需要其他資料夾的測試會在它旁邊新增（`relay.addProject()`）。
- **已登入的瀏覽器頁面**：用一組新的一次性代碼登入，使用導覽已完成，沙箱元件的詢問已回答過（所以不論這台電腦缺什麼，新對話都不會詢問），「CLI 拿不到的金鑰」提示已看過（所以 spec 的 `serverEnv` 裡有金鑰時，新對話也不會提），介面為英文（[`fixtures.ts`](fixtures.ts)）。測試可用 `test.use()` 改變這些：`lang: 'zh-TW'`、`signIn: false`、`tour: true`、`sandboxAsk: true`、`envNotice: true`，或給伺服器更多環境變數（`serverEnv`）。
- **假的 CLI**（[`fake-cli/`](fake-cli/)），十二個 CLI 各一個。測試的伺服器裝了 Claude Code、Codex 與 Grok，以及測試要用的 CLI（每個 CLI 各一的測試裝它自己，兩個團隊的測試裝它那一隊的，其他的用 [`support/clis.ts`](support/clis.ts) 的 `withClis()`）：其餘的在那裡都未安裝，因為每次開啟頁面時，伺服器會向每個已安裝的 CLI 詢問版本、登入、模型與它自己會載入的東西，每個大約啟動六次。它們說各 CLI 的協定，回答 `Hello from <名稱> (<CLI>). You said: “<使用者最新的訊息>”.`。測試用訊息中的 `e2e:` 指令操控它們（`e2e:write=notes.md`、`e2e:approve`、`e2e:slow`…）。假 CLI 總是會嘗試指令要求的事，成不成功只取決於 Harness Relay 給了 CLI 什麼（權限、參數與設定、沙箱、資料夾，以及它的核准請求得到的回答），所以在不該寫的地方寫檔的測試，能看出轉接器有沒有把 CLI 設定對。Claude Code、Codex、Grok、Copilot 與 Muse Code 的假 CLI 自己推算它們 CLI 的沙箱會允許什麼；沒有沙箱的 Cursor 與 Antigravity，假 CLI 像真正的一樣先詢問；開源 agent 的假 CLI 則真的寫檔、真的連線，所以在完全存取以外，不屬於它們的事由 Harness Relay 自己的沙箱本身拒絕（在 macOS 與 Linux 上）。在沙箱裡的假 CLI 無法寫入假 CLI 的紀錄檔，所以把紀錄送到假模型端點。
- **假的 `gh`**（[`fake-cli/fake-gh.cjs`](fake-cli/fake-gh.cjs)），用於分享、問題回報的截圖，以及等 GitHub 的自動任務：它把 gist 存在測試自己的資料夾（`fake-github/`），從不送到 GitHub，並列出測試寫在那裡的 pull request 與執行（`fake-github/repos/<owner>/<name>/pulls.json`、`runs.json`）；`E2E_FAKE_SIGNED_OUT=gh` 會讓它處於未登入狀態，直到測試核准它自己的登入（`auth login --web`）。Linux 上還有假的選擇資料夾視窗（`zenity`）。AgentsView 則是 [`specs/sessions.spec.ts`](specs/sessions.spec.ts) 裡的一個小 HTTP 伺服器，因為 Harness Relay 只會送請求給它。
- **假的 PowerShell**（[`fake-cli/fake-pwsh.cjs`](fake-cli/fake-pwsh.cjs)）在每個 Teams 測試自己的程序和資料夾內模擬 Graph 裝置登入、讀取頻道與發文。

下面的表格中，CLI 欄寫出測試用哪些 CLI 執行：「**各一**」表示十二個 CLI 各跑一次；「**有登入的各一**」表示 Claude Code、Codex、Grok、Cursor、Antigravity（它在 Harness Relay 唯一的登入方式是 Gemini API key）、Copilot 與 Muse Code 各跑一次；「**開源 agent 各一**」表示 OpenCode、Goose、Cline、OpenHands 與 Pi 各跑一次；「**兩個團隊**」表示測試跑兩次，一次是有登入的七個組成的團隊，一次是五個開源 agent 組成的團隊（這時標題以 `open agents:` 開頭）。某個 CLI 只能以完全存取執行的地方（Windows 上的開源 agent、Linux 上的 OpenCode），與權限有關的測試會跳過它並說明原因，其他測試則以完全存取執行它。在 CI 上，某個 CLI 自己的測試（各一的，以及它在兩個團隊中的位置）在 macOS 與 Windows 上只跑 Harness Relay 在那裡的執行方式和 Linux 不同的 CLI：見[平台與瀏覽器](#平台與瀏覽器)。

## 分區

| 分區 | Spec | 測試數 | 相關文件 |
| --- | --- | --- | --- |
| [文件目錄](#文件目錄) | [`docs-navigation.spec.ts`](specs/docs-navigation.spec.ts) | 7 | [工具文件](../site/zh-TW/docs/tools/index.html) |
| [登入](#登入) | [`signin.spec.ts`](specs/signin.spec.ts) | 14 | [架構 → 登入](../docs/architecture.zh-TW.md#登入) |
| [首頁](#首頁) | [`home.spec.ts`](specs/home.spec.ts) | 10 | [使用者說明 → 開始對話](../docs/user-guide.zh-TW.md#對話規則) |
| [新對話與首席 agent 的團隊](#新對話與首席-agent-的團隊) | [`chat.spec.ts`](specs/chat.spec.ts) | 12 | [使用者說明 → 自動組隊](../docs/user-guide.zh-TW.md#自動組隊)、[架構 → 自動組隊](../docs/architecture.zh-TW.md#自動組隊) |
| [範本](#範本) | [`templates.spec.ts`](specs/templates.spec.ts) | 7 | [使用者說明 → 範本](../docs/user-guide.zh-TW.md#範本) |
| [修改對話的團隊](#修改對話的團隊) | [`team.spec.ts`](specs/team.spec.ts) | 5 | [使用者說明 → 對話中修改團隊](../docs/user-guide.zh-TW.md#對話中修改團隊) |
| [首席 agent 的審閱](#首席-agent-的審閱) | [`review.spec.ts`](specs/review.spec.ts) | 13 | [使用者說明 → 首席 agent 審閱](../docs/user-guide.zh-TW.md#首席-agent-審閱)、[架構 → 首席 agent 審閱](../docs/architecture.zh-TW.md#首席-agent-審閱) |
| [團隊檢查](#團隊檢查) | [`checks.spec.ts`](specs/checks.spec.ts) | 13 | [使用者說明 → 團隊檢查](../docs/user-guide.zh-TW.md#團隊檢查)、[架構 → 團隊檢查](../docs/architecture.zh-TW.md#團隊檢查) |
| [成員的模型與推理強度](#成員的模型與推理強度) | [`models.spec.ts`](specs/models.spec.ts) | 13 | [使用者說明 → 預設模型與推理強度](../docs/user-guide.zh-TW.md#預設模型與推理強度)、[團隊成員](../docs/user-guide.zh-TW.md#團隊成員) |
| [成員如何輪流發言](#成員如何輪流發言) | [`turns.spec.ts`](specs/turns.spec.ts) | 55 | [架構 → 發言排程](../docs/architecture.zh-TW.md#發言排程模式)、[agent 之間如何共享上下文](../docs/architecture.zh-TW.md#agent-之間如何共享上下文) |
| [直接送進進行中的回合](#直接送進進行中的回合) | [`steer.spec.ts`](specs/steer.spec.ts) | 4 | [使用說明 → 對話](../docs/user-guide.zh-TW.md#4-對話)、[架構 → 發言排程](../docs/architecture.zh-TW.md#發言排程模式) |
| [要使用者做的步驟](#要使用者做的步驟) | [`steps.spec.ts`](specs/steps.spec.ts) | 5 | [使用者說明 → 對話](../docs/user-guide.zh-TW.md#4-對話)、[架構 → 發言排程](../docs/architecture.zh-TW.md#發言排程模式) |
| [agent 回答前做了什麼](#agent-回答前做了什麼) | [`activity.spec.ts`](specs/activity.spec.ts) | 15 | [架構 → agent 活動](../docs/architecture.zh-TW.md#agent-活動) |
| [捲動對話](#捲動對話) | [`scroll.spec.ts`](specs/scroll.spec.ts) | 3 | [使用手冊 → 對話](../docs/user-guide.zh-TW.md#4-對話) |
| [核准](#核准) | [`approvals.spec.ts`](specs/approvals.spec.ts) | 44 | [使用者說明 → 核准](../docs/user-guide.zh-TW.md#核准)、[架構 → 核准](../docs/architecture.zh-TW.md#核准)、[權限對應](../docs/architecture.zh-TW.md#權限對應) |
| [使用者自己執行的指令](#使用者自己執行的指令) | [`interactive.spec.ts`](specs/interactive.spec.ts) | 3 | [使用者說明 → 你自己執行的指令](../docs/user-guide.zh-TW.md#你自己執行的指令)、[架構 → 互動指令](../docs/architecture.zh-TW.md#互動指令) |
| [檔案與修改](#檔案與修改) | [`files.spec.ts`](specs/files.spec.ts) | 26 | [使用者說明 → 檢視與套用修改](../docs/user-guide.zh-TW.md#檢視與套用修改)、[瀏覽檔案](../docs/user-guide.zh-TW.md#瀏覽檔案)、[架構 → 修改檔案](../docs/architecture.zh-TW.md#修改檔案)、[架構 → 工作區與檔案修改](../docs/architecture.zh-TW.md#工作區與檔案修改) |
| [應用程式預覽](#應用程式預覽) | [`app-preview.spec.ts`](specs/app-preview.spec.ts)、[`app-preview-docker.spec.ts`](specs/app-preview-docker.spec.ts) | 22 | [使用者說明 → 預覽應用程式](../docs/user-guide.zh-TW.md#預覽應用程式) |
| [發布應用程式](#發布應用程式) | [`app-publish.spec.ts`](specs/app-publish.spec.ts) | 2 | [使用者說明 → 發布應用程式](../docs/user-guide.zh-TW.md#發布應用程式)、[架構 → 發布應用程式](../docs/architecture.zh-TW.md#發布應用程式) |
| [工作目錄與其他資料夾](#工作目錄與其他資料夾) | [`folders.spec.ts`](specs/folders.spec.ts) | 34 | [架構 → 多個工作目錄](../docs/architecture.zh-TW.md#多個工作目錄)、[各平台的作業系統沙箱](../docs/sandboxing.zh-TW.md) |
| [Harness Relay 自己的沙箱](#harness-relay-自己的沙箱) | [`sandbox.spec.ts`](specs/sandbox.spec.ts) | 17 | [各平台的作業系統沙箱 → Harness Relay 自己的沙箱](../docs/sandboxing.zh-TW.md#harness-relay-自己的沙箱)、[開源 agent → Harness Relay 的沙箱](../docs/open-agents.zh-TW.md#harness-relay-的沙箱) |
| [除了 prompt 之外交給各 CLI 的東西](#除了-prompt-之外交給各-cli-的東西) | [`inputs.spec.ts`](specs/inputs.spec.ts) | 34 | [架構 → 工具庫](../docs/architecture.zh-TW.md#工具庫) |
| [工具庫](#工具庫) | [`tools.spec.ts`](specs/tools.spec.ts) | 22 | [使用者說明 → 工具庫](../docs/user-guide.zh-TW.md#工具庫mcp-伺服器skill-與記憶)、[架構 → 工具庫](../docs/architecture.zh-TW.md#工具庫) |
| [密鑰與固定指令](#密鑰與固定指令) | [`handoffs.spec.ts`](specs/handoffs.spec.ts) | 4 | [使用者說明 → 密鑰與固定指令](../docs/user-guide.zh-TW.md#密鑰與固定指令)、[架構 → 密鑰與固定指令](../docs/architecture.zh-TW.md#密鑰與固定指令) |
| [長期記憶](#長期記憶) | [`memory.spec.ts`](specs/memory.spec.ts) | 4 | [使用指南 → 長期記憶](../docs/user-guide.zh-TW.md#長期記憶)、[架構 → 長期記憶](../docs/architecture.zh-TW.md#長期記憶) |
| [草稿中可用的 App](#草稿中可用的-app) | [`draft-apps.spec.ts`](specs/draft-apps.spec.ts) | 8 | [使用者說明 → 常用 App](../docs/user-guide.zh-TW.md#常用-app) |
| [App 設定與確認](#app-設定與確認) | [`app-confirmation.spec.ts`](specs/app-confirmation.spec.ts) | 12 | [使用者說明 → 常用 App](../docs/user-guide.zh-TW.md#常用-app) |
| [聊天中的 App 存取權](#聊天中的-app-存取權) | [`app-lifecycle.spec.ts`](specs/app-lifecycle.spec.ts) | 7 | [使用者說明 → 常用 App](../docs/user-guide.zh-TW.md#常用-app) |
| [接手瀏覽器](#接手瀏覽器) | [`handover.spec.ts`](specs/handover.spec.ts) | 4 | [使用者說明 → Harness Relay 的工具](../docs/user-guide.zh-TW.md#harness-relay-的工具瀏覽器郵件與行事曆)、[架構 → Harness Relay 自己的工具](../docs/architecture.zh-TW.md#工具庫) |
| [用 OAuth 登入的帳號](#用-oauth-登入的帳號) | [`oauth.spec.ts`](specs/oauth.spec.ts) | 13 | [使用者說明 → Harness Relay 的工具](../docs/user-guide.zh-TW.md#harness-relay-的工具瀏覽器郵件與行事曆)、[提案 → OAuth](../docs/proposals/oauth.zh-TW.md) |
| [直接連結 Microsoft Teams](#直接連結-microsoft-teams) | [`teams.spec.ts`](specs/teams.spec.ts) | 3 | [使用者說明 → 連結 Microsoft Teams](../docs/user-guide.zh-TW.md#連結-microsoft-teams-並發送訊息) |
| [需要登入的 MCP 伺服器](#需要登入的-mcp-伺服器) | [`mcp-oauth.spec.ts`](specs/mcp-oauth.spec.ts) | 5 | [使用者說明 → 工具庫](../docs/user-guide.zh-TW.md#工具庫mcp-伺服器skill-與記憶)、[架構 → 自己登入的 MCP 伺服器](../docs/architecture.zh-TW.md#自己登入的-mcp-伺服器) |
| [修改對話的歷史](#修改對話的歷史) | [`history.spec.ts`](specs/history.spec.ts) | 3 | [使用者說明 → 複製、編輯與重試](../docs/user-guide.zh-TW.md#複製編輯與重試)、[分支對話](../docs/user-guide.zh-TW.md#分支對話) |
| [複製與分享](#複製與分享) | [`share.spec.ts`](specs/share.spec.ts) | 15 | [使用者說明 → 分享對話](../docs/user-guide.zh-TW.md#分享對話)、[架構 → 分享對話](../docs/architecture.zh-TW.md#分享對話) |
| [側邊欄](#側邊欄) | [`sidebar.spec.ts`](specs/sidebar.spec.ts) | 12 | [使用者說明 → 群組](../docs/user-guide.zh-TW.md#群組)、[釘選的對話](../docs/user-guide.zh-TW.md#釘選的對話)、[搜尋](../docs/user-guide.zh-TW.md#搜尋)、[在 GitHub 給 Harness Relay 一顆星星](../docs/user-guide.zh-TW.md#在-github-給-harness-relay-一顆星星) |
| [首席 agent 在團隊之外的協助](#首席-agent-在團隊之外的協助) | [`lead-drafts.spec.ts`](specs/lead-drafts.spec.ts) | 8 | [使用者說明 → 範本](../docs/user-guide.zh-TW.md#範本)、[團隊檢查](../docs/user-guide.zh-TW.md#團隊檢查)、[自動任務](../docs/user-guide.zh-TW.md#自動任務)、[群組](../docs/user-guide.zh-TW.md#群組)、[架構 → 自動組隊](../docs/architecture.zh-TW.md#自動組隊) |
| [自動任務](#自動任務) | [`schedule.spec.ts`](specs/schedule.spec.ts) | 12 | [使用者說明 → 自動任務](../docs/user-guide.zh-TW.md#自動任務)、[架構 → 排程](../docs/architecture.zh-TW.md#排程) |
| [設定](#設定) | [`settings.spec.ts`](specs/settings.spec.ts) | 27 | [使用者說明 → 登入](../docs/user-guide.zh-TW.md#登入)、[實驗室](../docs/user-guide.zh-TW.md#實驗室)、[首席 agent](../docs/user-guide.zh-TW.md#首席助理)、[開源 agent → 模型來源](../docs/open-agents.zh-TW.md#模型來源) |
| [安裝 CLI](#安裝-cli) | [`install.spec.ts`](specs/install.spec.ts) | 3 | [使用者說明 → 從設定頁安裝 CLI](../docs/user-guide.zh-TW.md#從設定頁安裝-cli)、[架構 → 從設定頁安裝 CLI](../docs/architecture.zh-TW.md#從設定頁安裝-cli) |
| [安裝 Git](#安裝-git) | [`git-install.spec.ts`](specs/git-install.spec.ts) | 3 | [使用者說明 → 對話設定](../docs/user-guide.zh-TW.md#對話規則) |
| [沙箱需要的元件](#沙箱需要的元件) | [`sandbox-setup.spec.ts`](specs/sandbox-setup.spec.ts) | 6 | [使用者說明 → 安裝沙箱需要的元件](../docs/user-guide.zh-TW.md#安裝沙箱需要的元件)、[各平台的 OS 沙箱 → 由 Harness Relay 安裝它們需要的東西](../docs/sandboxing.zh-TW.md#由-harness-relay-安裝它們需要的東西) |
| [在 Windows 上是腳本的 CLI](#在-windows-上是腳本的-cli) | [`windows.spec.ts`](specs/windows.spec.ts) | 5 | [架構 → CLI 轉接器](../docs/architecture.zh-TW.md#cli-轉接器) |
| [帳號](#帳號) | [`accounts.spec.ts`](specs/accounts.spec.ts) | 35 | [使用者說明 → 多個帳號](../docs/user-guide.zh-TW.md#多個帳號)、[API key](../docs/user-guide.zh-TW.md#api-key選用)、[架構 → 帳號](../docs/architecture.zh-TW.md#帳號) |
| [伺服器環境變數裡的金鑰](#伺服器環境變數裡的金鑰) | [`agent-env.spec.ts`](specs/agent-env.spec.ts) | 2 | [使用者說明 → 環境變數](../docs/user-guide.zh-TW.md#環境變數)、[架構 → 安全性](../docs/architecture.zh-TW.md#安全性) |
| [方案用量](#方案用量) | [`usage.spec.ts`](specs/usage.spec.ts) | 9 | [使用者說明 → 方案用量](../docs/user-guide.zh-TW.md#方案用量)、[架構 → Provider](../docs/architecture.zh-TW.md#provider狀態登入與模型) |
| [各 CLI 自己載入的內容，以及 Grok 的信任](#各-cli-自己載入的內容以及-grok-的信任) | [`native.spec.ts`](specs/native.spec.ts) | 6 | [使用者說明 → 各 CLI 自己載入的內容](../docs/user-guide.zh-TW.md#各-cli-自己載入的內容)、[Subagent 與 workflow](../docs/user-guide.zh-TW.md#subagent-與-workflow)、[架構 → 各 CLI 自己載入的內容](../docs/architecture.zh-TW.md#各-cli-自己載入的內容) |
| [Agent 的 session 與 AgentsView](#agent-的-session-與-agentsview) | [`sessions.spec.ts`](specs/sessions.spec.ts) | 10 | [使用者說明 → Agent 的 session](../docs/user-guide.zh-TW.md#agent-的-session各-cli-自己的資料夾與-agentsview)、[架構 → Agent 的家目錄與 AgentsView](../docs/architecture.zh-TW.md#agent-的家目錄與-agentsview) |
| [語音輸入的安裝](#語音輸入的安裝) | [`voice.spec.ts`](specs/voice.spec.ts) | 5 | [使用者說明 → 語音輸入](../docs/user-guide.zh-TW.md#語音輸入)、[架構 → 語音輸入](../docs/architecture.zh-TW.md#語音輸入) |
| [回報問題](#回報問題) | [`report.spec.ts`](specs/report.spec.ts) | 7 | [使用者說明 → 回報問題](../docs/user-guide.zh-TW.md#回報問題)、[架構 → 回報問題](../docs/architecture.zh-TW.md#回報問題) |
| [使用導覽與主題](#使用導覽與主題) | [`appearance.spec.ts`](specs/appearance.spec.ts) | 13 | [使用者說明 → 介面語言與使用導覽](../docs/user-guide.zh-TW.md#介面語言與使用導覽) |
| [通知與提示音](#通知與提示音) | [`notifications.spec.ts`](specs/notifications.spec.ts) | 6 | [使用者說明 → 通知與提示音](../docs/user-guide.zh-TW.md#通知與提示音)、[通知收件匣](../docs/user-guide.zh-TW.md#通知收件匣)、[架構 → 通知](../docs/architecture.zh-TW.md#通知) |
| [環境變數設定的上限](#環境變數設定的上限) | [`limits.spec.ts`](specs/limits.spec.ts) | 4 | [開發者說明 → 環境變數](../docs/developer-guide.zh-TW.md#環境變數) |
| [語言](#語言) | [`i18n.spec.ts`](specs/i18n.spec.ts) | 7 | [架構 → 語言](../docs/architecture.zh-TW.md#語言) |
| [在手機上](#在手機上) | [`mobile.spec.ts`](specs/mobile.spec.ts) | 19 | [用手機連線](../docs/remote-access.zh-TW.md) |

測試以英文介面執行，所以下面括號裡附上測試實際操作的英文標籤。

## 文件目錄

以本機網站檔案驗證繁中工具頁的深層連結、手機鍵盤展開與返回、英文手機指南捲動時的小節標示，以及停用 JavaScript 後仍能展開目錄並開啟 Google 設定步驟。捲動時，原先自動展開的分支會收起，手機上的閱讀位置會保持穩定。手動展開的分支和仍有鍵盤焦點的分支會保持開啟。手機與平板會檢查固定的單行目錄、跳到章節後的鍵盤焦點、長目錄內捲、切換搜尋及文件頁面，以及調整到桌面寬度。測試也會延後版面切換事件，確認只有即將隱藏的目錄控制項會移交焦點；搜尋與正文則維持原焦點。在 390、1024 和 1366 CSS 像素寬度，實際檢查文件選單從上排下緣展開，整列接收點擊，且鍵盤無法聚焦被蓋住的「本頁內容」。

[收合的本頁內容](../docs/media/docs-contents-phone-zh-TW.webp) · [展開的本頁內容](../docs/media/docs-contents-open-phone-zh-TW.webp) · [文件選單蓋住本頁內容](../docs/media/docs-pages-over-contents-phone-zh-TW.webp)

## 登入

[`signin.spec.ts`](specs/signin.spec.ts)：還沒登入的瀏覽器（`signIn: false`）。最後四個也在介面的開發版 build 中執行（React 的 StrictMode 會把每個 effect 跑兩次），由 `global-setup.ts` 在一般的 build 旁邊建置。

| 情境 | 檢查的內容 |
| --- | --- |
| 還沒登入的瀏覽器看到登入頁，輸入代碼後登入 | 顯示登入頁，API 回應 401；錯誤的代碼會顯示代碼錯誤或已過期；新的代碼會打開 app 的首頁，重新載入後仍保持登入。 |
| 登入連結只能用一次 | `/#code=…` 會登入，代碼也會從網址列消失；另一個頁面開同一個連結時顯示它的錯誤。 |
| 在已顯示登入頁的分頁打開連結就會登入 | 分頁從登入頁進入 app。 |
| 用代碼登入後又被登出時，不再顯示連結的錯誤 | 再次登出後，登入頁沒有過時的錯誤。 |
| 在已登入的分頁打開登入連結，帶舊金鑰還在路上的請求不會讓它登出 | 這些請求的「已登出」回應與登入的回應同時到達，頁面一次也不會登出。 |
| 顯示登入頁的分頁跟著同一個瀏覽器的另一個分頁登入 | 不需要自己的代碼就進入 app。 |
| 在另一個分頁打開登入連結，所有分頁都保持登入 | 第一個分頁即使有請求還在路上，也留在 app 裡。 |
| 還在做第一次檢查的分頁跟著別的分頁登入 | 它的第一個回答那時已過時，仍會登入。 |
| 登入沒有回應時，30 秒後放棄並顯示訊息 | 把頁面的時鐘往前調，登入頁會說明原因。 |
| 瀏覽器在設定中自己登出 | **設定 → 已登入的瀏覽器**列出「this browser」；按**登出**（Sign out）後回到登入頁。 |
| 開發版 build：登入連結第一次載入就進入 app，只問一次是否已登入 | StrictMode 第二次執行 effect 時不會再問，也不會弄丟代碼。 |
| 開發版 build：在已登入的分頁或另一個分頁打開連結 | 同上，在 StrictMode 下。 |
| 開發版 build：無效的連結在第一次載入時顯示錯誤 | 錯誤顯示在登入頁上。 |

## 首頁

[`home.spec.ts`](specs/home.spec.ts)

| 情境 | 檢查的內容 |
| --- | --- |
| 新對話與新自動任務的固定操作區（兩個案例） | 長說明在文字框內捲動。內容少時外框隨內容縮短，送出按鈕固定在框內底部。有無捲動箭頭時，按鈕列的上下留白都相等。組隊選項與首席審閱隨表單捲動，點箭頭會往下捲。最後一個欄位完全可見時箭頭隱藏，包含下方只剩留白的情況，偏好減少動態效果時箭頭靜止，並在圓框內水平垂直置中。 |
| 從收合側欄的首頁提出第一個問題 | 問題尚未填寫、只有空白或清除後，即使有附檔也不能送出。瀏覽器裡第一次的新對話會直接開始回答。在手機版可從問題欄位用 Tab 移到下方第一個按鈕「常用 App」，按 Enter 展開選擇器。勾選與取消勾選會更新隨提問送出的 App 名單，從管理連線返回後，問題、附件與 App 選項仍在，也尚未建立對話或變更任何助理權限。前往首席 agent 設定也會保留標題、資料夾、權限與組隊確認方式。問題和附件一起送出一次，首頁能回到待確認團隊，下一個對話反映記住的確認偏好。 |
| 新對話與新自動任務的建立請求較慢時（各測一次） | 從設定返回後，失敗訊息、草稿與表單上的審閱選擇都保留。重試成功時仍停留在設定，在手機寬度也能從該頁直接開啟剛建立的對話或自動任務、取得一次性 webhook 權杖。 |
| app 打開時是首頁，點 logo 與名稱會回到首頁 | 首頁顯示 logo 與下面的標語；從新對話頁和對話中點側邊欄的 logo 與 **Harness Relay**（在首頁時標為目前的頁面），都會回到首頁（`#/`）。 |
| logo 每次進入首頁播放一次動畫，只動 transform 與 opacity，減少動態效果時不播放 | logo 的圓點、轉圈與標語都有一段播放時間（而不是像沒寫名稱的 `animation` 簡寫被壓縮成 `none` 那樣完全不播），只播一次，只改變 `transform` 與 `opacity`；播完會自己結束，再次打開首頁時會重播；開啟減少動態效果時完全沒有動畫。 |
| 載入不了的頁面部分：頁面為它重新載入一次，之後說明原因；說明可以關閉，「重新載入」會把它找回來 | 回報對話框的檔案不見時（404，就像頁面在更新前就開著），點 **回報問題** 會讓頁面重新載入一次；一分鐘內再點一次，會顯示說明而不是一片空白：按 **關閉** 會關掉它，按 **重新載入** 會重新載入頁面，之後對話框就能打開。每個頁面在開始時就計數，不會漏算。 |
| 載入了卻畫不出來的頁面部分會這樣說明，而不是說無法載入，頁面也不會重新載入 | 回報對話框在繪製時拋出錯誤時，點 **回報問題** 會顯示它出了問題的說明（而不是無法載入），頁面不會重新載入，按 **關閉** 會關掉說明。 |
| 載入不了的圖會顯示原始碼，頁面不會為它重新載入 | Mermaid 的檔案不見時，有圖的回覆（`e2e:mermaid`）會顯示圖的原始碼並說無法畫出；頁面不會像上面那些部分一樣重新載入。 |

## 新對話與首席 agent 的團隊

[`chat.spec.ts`](specs/chat.spec.ts)：從新對話頁開始的對話，首席 agent 會為每個問題組隊。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 首席 agent 提議團隊，確認後團隊回答 | Claude Code | 從新對話送出問題會直接看到團隊卡片，列出團隊、理由與成員；按**確認團隊**（Confirm team）後，回答帶著它的 CLI 標籤；對話以第一個問題列在側邊欄，回答存成已完成。 |
| 首席 agent 組隊時，卡片顯示首頁的 logo，轉一圈後停半秒再轉下一圈，不停地轉；減少動態效果時則靜止不動 | Claude Code | 首席 agent 慢慢組隊時（`e2e:slowplan`），寫著它正在組隊的卡片會顯示首頁的 logo：三個圓點先旋轉著聚合一次（`logo-join-*`、`logo-orbit`），之後不停地轉（`logo-turn`，執行中）：每 1.9 秒轉 1.4 秒，從第一圈轉完半秒後開始，全部只改變 `transform` 與 `opacity`，而且沒有任何元素同時有兩個 `transform` 動畫（那樣 Chrome 兩個都不會交給 compositor）。把它的動畫暫停並跳到各個時間點，logo 在 0.3、2.2、4.1 秒時正在轉，在 1.5、1.8、3.4、3.7 秒時靜止；靜止時大小是 18px，也就是設計完成後卡片上 Logo 的大小，每個圓點都在 Logo 畫它那個圓的位置。按 **■ 停止**後，卡片顯示已中斷，logo 不見了，也沒有任何動畫，✦ 佔著 logo 原本的位置（文字不會移動），已展開的進度也維持展開；減少動態效果並使用強制色彩時，下一次組隊的卡片顯示靜止的 logo，三個圓點保持各自的顏色。 |
| 不詢問直接採用首席 agent 組的團隊 | Claude Code | 卡片寫著**已直接採用**（Used without asking），團隊不必等待就回答。 |
| 所有 CLI 組成的團隊依序回答 | 兩個團隊 | 每位成員帶著自己 CLI 的標籤回答，依圓桌順序：Claude Code、Codex、Grok、Cursor；Antigravity、Copilot、Muse Code；以及 OpenCode、Goose、Cline、OpenHands、Pi（團隊裡有在這裡只能以完全存取執行的 CLI 時，對話以完全存取執行）。首席 agent 為新問題組的團隊最多五位成員，所以有登入的七個分成四人與三人的兩個團隊，各在自己的對話中回答。 |
| 追問時再組一次團隊 | Claude Code、Codex | 第二個問題有自己的團隊，只有那位成員回答。 |
| 下一次設計重新查詢額度 | Claude Code、Codex | Claude Code 回答第一個問題。它的額度用完後，第二次組隊不提供它作為候選，首席 agent 仍選到它時也會用 Codex 取代。 |
| 指定的首席 agent 無法使用 | Claude Code | 卡片先列出這次採用的預設團隊，再說明首席 agent 的五小時額度已用盡，並顯示回報的重設時間。重新載入後仍看得到。 |
| 沒有可用的模型 | Claude Code、Codex、Grok | 三個 CLI 的額度都用完時，失敗卡片標明無法使用的首席 agent，並說明直接採用為何無法啟動團隊。 |
| 可展開的團隊設計進度 | Claude Code | 在設計卡片裡展開進度，模型實測完成後仍在同一卡片內維持展開。團隊回答前，模型只收到固定測試提示。 |
| 完全存取團隊確認後才實測 | Claude Code | 等待確認時沒有用完全存取實測。確認後才實測並啟動團隊。 |
| 模型實測全數失敗 | Claude Code | 直接採用會顯示實測失敗，且不會啟動團隊。 |

## 範本

[`templates.spec.ts`](specs/templates.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 在新自動任務另存範本後，可在新對話找到它 | — | 兩個表單都把範本放在「本次組隊後」上方，展開時卡片與分隔線之間留有間距。另存後返回自動任務，任務內容、目標和每週排程都還在。 |
| 列出內建範本，打開其中一個可看到成員 | — | 「三方辯論」（Three-way debate）標為內建，對話框列出 Proposer、Pragmatist 與 Skeptic。 |
| 新範本只放這裡已安裝 CLI 的成員，在各 CLI 狀態還沒到時打開也一樣 | — | 重新載入後擋住 `/api/providers`，**＋ 新增範本**打開時沒有成員；狀態到了之後，Claude Code、Codex 與 Grok（測試伺服器的）各一位，關閉時不會詢問。 |
| 範本裡用了這裡沒安裝的 CLI 的成員改用已安裝的，會說明，也能照這樣儲存 | — | 沒有安裝 Grok 時：新範本只有 Claude Code 與 Codex；打開「三方辯論」時 Skeptic 改用 Claude Code（另外兩個 CLI 都已用到），對話框列出 Skeptic 被改過，雖然沒有其他修改，**另存成我的範本**（Save as my template）也可以按。 |
| 範本編輯視窗有三欄時，新增成員卡自己一列就列出所有 CLI，在成員旁邊就和成員一樣高 | — | 1280px 下編輯視窗的格線有三欄：內建接力範本的三位成員填滿第一列，新增成員卡自己一列，全部列出、不用捲動；加入第四位、以及移除兩位後在第一列兩位成員旁邊時，清單可以捲動，那些成員保有自己的高度（隱藏新增成員卡再量一次比對：同一列的卡片本來就一樣高，互相比較證明不了什麼）。 |
| 首席 agent 直接使用範本 | Claude Code、Codex、Grok | 卡片寫著使用「三方辯論」；兩輪中每位成員先以自己的 CLI 回答，再 PASS（共六則回答）。 |
| 把首席 agent 設計的團隊存成範本 | Claude Code、Grok | **存成範本**（Save as template）預設帶入團隊的名稱，卡片顯示已儲存，新對話頁也出現這個範本。 |

## 修改對話的團隊

[`team.spec.ts`](specs/team.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 請首席 agent 調整團隊，儲存後新成員回答 | Claude Code、Grok | 已有成員的空白對話會顯示團隊介紹。在**團隊設定 → 請首席 agent 調整**（Team settings → Ask the lead agent）中，要求會交給首席 agent；它工作時（`e2e:slowrevise=2`），app 的載入標示排在它說的話前面，在同一行裡：14px，在文字之前並對齊文字的中線；之後抽屜顯示它加入的成員，按**儲存**後兩位成員都回答。 |
| 首席 agent 的回答無法解讀時，改用範本 | Claude Code | 卡片顯示改用的預設團隊，原始回應收在「技術細節」。確認到完成期間會顯示任務狀態，提出新問題後，舊卡片的即時狀態會消失。 |
| 拒絕為新問題提議的團隊 | Claude Code、Codex | 按**不採用，沿用目前的團隊**（No, keep the current team）：卡片顯示沒有採用，由目前的團隊回答，提議的成員不回答。 |
| agent 工作時（團隊回答中、首席 agent 審閱中）團隊設計卡片的「調整團隊」不能按，調整團隊後卡片顯示調整後的團隊 | Claude Code | 回覆緩慢串流時，卡片的**調整團隊**（Adjust team）是停用的，提示說明原因，審閱很慢時也一樣；按 **■ 停止**停止審閱後可以按。在它開啟的抽屜中為成員改名並儲存：卡片列出 **@Ada** 而不是 **@Claude**，寫著*你調整過這個團隊*（You adjusted this team），伺服器保存的設計（`adjustedAt`）與重新載入後的卡片也是。 |
| 新增成員卡和旁邊的成員一樣高，下面還有 CLI 時底部有陰影，自己一列時列出所有 CLI，一張卡變高只撐高自己那一列 | — | 在**團隊設定**中（1280px 下兩欄），清單是名為**新增成員**（Add member）的群組：在一位成員旁邊時，那位成員保有自己的高度（隱藏新增成員卡再量一次比對），十二個 CLI 的清單可以捲動。瀏覽器支援捲動驅動動畫時，清單底部邊緣有陰影（那一條的截圖和拿掉陰影時不同），減少動態效果時也有，取得焦點的每個按鈕都停在它上方，捲到底後陰影消失。兩位成員時它自己一列，全部列出、不用捲動，也沒有陰影；硬讓它取用沒有給它的高度時（欄數算錯時就會這樣），它至少有 280px 高並可以捲動，不會變成空框。在第三位旁邊時那一位保有自己的高度，而第一列的角色框拉高後，第二列的卡片高度不變。 |

## 首席 agent 的審閱

[`review.spec.ts`](specs/review.spec.ts)：**團隊回答後，請首席 agent 審閱回覆**（Have the lead agent review the team's replies）。假首席 agent 會把它讀到的第一則回覆開頭的幾個字標成風險，並建議一個給使用者、一個給團隊的下一步（`e2e:badreview`、`e2e:slowreview` 與 `e2e:reviewkind` 會改變這些）。新對話頁面每個新對話都不勾選這個勾選框，`startChat()` 只在測試要求時（`leadReview: true`）才勾選，其他 spec 就不會出現審閱。`startChat()` 也一定會選好團隊怎麼開始：除非測試要求（`autoConfirm: true`），都是等待確認，而瀏覽器裡第一次的新對話則會直接開始回答；自己在這個頁面開始對話的測試（`folders.spec.ts`、`i18n.spec.ts` 與 `schedule.spec.ts` 裡的）也會自己選。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 首席 agent 審閱團隊的回覆，把它引用的文字標在回覆中，給團隊的下一步可以放進輸入框 | Claude Code | 勾選後開始的新對話，回覆之後出現**首席 agent 的審閱**（Lead agent's review）卡片：摘要、一個**風險**（Risk）及回覆的原文與說明，以及下一步（**你**，與附上**交給團隊**的**團隊**）。引用的文字標在回覆中（`CSS.highlights` 的 `review-risk` 裡有一個範圍），回覆標頭顯示 **⚑ 1 處注意**（1 to note）：點它跳到卡片（卡片會閃一下），點卡片上的 **@Claude** 跳到引用的那段話，那段話會在標記上短暫加強顯示（`review-focus`），焦點移到那則回覆。**交給團隊**（Ask the team）會把那一步的訊息放進輸入框；送出後團隊回答並再次被審閱，每則回覆各有一個標記範圍（第一則回覆不會重複標記）。首席 agent 拿到了編號的回覆；設定有保存，以勾選開始一個對話之後，新對話頁面又會是未勾選的。 |
| 對話沒要求就不審閱；在團隊設定開啟後，讀的是最新一個問題的回覆 | Claude Code | 透過 API 建立、沒開啟的對話沒有卡片；在**團隊設定**勾選並儲存後，下一次回答的卡片只讀了那次的回答（**讀了 1 則回覆**，Read 1 reply），第一個問題則作為背景放在首席 agent 的 prompt 中。 |
| 「停止」會停止它，讀不懂首席 agent 的回答時也會說明 | Claude Code | 審閱很慢時，卡片顯示首席 agent 正在審閱，並有團隊設計卡片那個旋轉中的標誌（`.plan-logo.turning`），輸入框也這樣說明；**■ 停止**讓卡片顯示已中斷，標誌消失，原處換成 ✦。下一次回答的審閱會再讀那些回覆（prompt 中有被停止的那次審閱的問題，並編了兩則回覆），回答不是 JSON 時卡片會說明無法審閱，以及原因。 |
| 審閱期間送出的訊息會停止審閱並立刻送出，下一次審閱從被停止的那次開始讀的地方讀起，團隊設定也能在審閱途中關閉它 | Claude Code | 審閱很慢時，輸入框的提示說明按 Enter 會停止審閱並立刻送出（Enter to stop the review and send it now），提示文字也說明送出訊息會停止審閱。這時按 Enter 送出的訊息讓卡片顯示已中斷，並立刻送出：佇列區從頭到尾都不會出現。它的回答有第二次審閱，同樣很慢，因為它從被停止的那次開始讀的地方讀起（prompt 中有第一個問題和新的訊息）。這段期間 **團隊設定** 會說明只改首席 agent 審閱或插話方式的話現在就能儲存（lead review and steering alone can be saved now）：**儲存**（Save）在取消勾選之前是停用的，之後就能儲存，那次審閱也隨之停止。之後兩張被停止的卡片都說明 *審閱已中斷。首席 agent 審閱目前已關閉…*（The review was stopped. Lead review is off now…），對話的審閱是關閉的、沒有等待中的訊息，也沒有多出 *已停止*（Stopped.）的說明。 |
| 審閱期間到期的排程訊息會在佇列區等審閱，「略過審閱並立即送出」會立刻送出它 | Claude Code | 對話裡有排程（透過 API 設定），審閱很慢時執行排程（`POST …/schedule/run`，和到期時一樣）：佇列區顯示 **1 則等待送出**（1 waiting）與 *首席 agent 審閱完回覆後送出*（Sent once the lead agent has reviewed the replies）。**略過審閱並立即送出**（Skip the review and send now）讓卡片顯示已中斷，佇列區消失，由團隊回答排程訊息。 |
| 團隊設計卡片上有勾選框，首席 agent 不會去動它：在卡片上勾選後，正在回答的問題與之後的問題都會被審閱 | Claude Code | 在以未勾選開始的新對話中，設計卡片顯示未勾選的勾選框與說明，首席 agent 組隊的 prompt 完全不提它。在卡片上勾選後對話就開啟審閱；確認團隊後，回答會被審閱。下一個問題的設計卡片上勾選框仍是勾選的（第一張卡片已經沒有勾選框），它的回答也會被審閱；在最新的卡片上取消勾選後，下一個回答就不審閱。 |
| 新自動任務頁的勾選框一開始是未勾選的，排程的對話照那裡的設定 | — | 在**新自動任務**，勾選框一開始是未勾選的。勾選它並勾選**每次開新對話**（Start a new chat each time；它開的新對話會像複製其他設定一樣複製這個設定）後，**建立自動任務**（Create schedule）開的對話有開啟審閱，它的**團隊設定**中勾選框是勾選的；再建立一次、讓（一開始又是未勾選的）勾選框保持未勾選，對話就是關閉的。 |
| 重點上的 @名稱 把它引用的文字帶到對話中間，即使在比視窗還高的回覆開頭 | Claude Code | 用 `e2e:long`（回覆多了四十段），卡片引用回覆開頭的幾個字，在畫面中的卡片上方很遠處；按它的 **@Claude** 會捲動對話，直到那段標記離中間不到 30px，並在標記上加強顯示（`review-focus`），對話停在那裡。 |
| 分享的對話保留審閱與它的標記，每個重點的 @名稱 連到它引用的文字，但不含 app 的按鈕與設計卡片的勾選框 | Claude Code | 分享頁面（假 `gh` 的 gist）有審閱的摘要、那一點與下一步；引用的文字在回覆中是 `<mark class="review-quote-mark risk">`，那一點的 **@Claude** 變成連結（`#quote-…`），指向它的 id。在 Harness Relay 的分享頁開啟（離線攔截），在它不執行腳本的框架裡捲到底後，點連結會把標記帶進畫面，成為框架的 `:target`（`about:srcdoc#quote-…`）並加上底線，分享頁本身的網址不變。沒有設計卡片的勾選框、**交給團隊**（Ask the team）、回覆的標籤，也沒有任何按鈕。 |
| 標出回覆中跨越清單項目的引用，用它類型的顏色 | Claude Code | 用 `e2e:markdown`、`e2e:reviewquote=list` 與 `e2e:reviewkind=decision`，卡片以**待你決定**（Your call）引用「first point second point」，`CSS.highlights` 中（`review-decision`）有一個範圍從第一個項目延伸到第二個（聊天畫面在區塊之間視為有空白）。在分享頁上它們是兩個標記，每個項目各一個、項目之間沒有，那一點的 **@Claude** 連到第一個。 |
| 針對回覆但沒有引用文字的重點會跳到回覆，在分享頁上它的 @名稱 連到回覆 | Claude Code | 用 `e2e:reviewquote=none`，那一點不引用任何文字：它的 **@Claude** 讓回覆閃一下並取得焦點，不加強顯示任何文字；在分享頁上它連到回覆（`#msg-…`），也沒有任何標記。 |
| 伺服器拒絕變更時，設計卡片的勾選框會恢復原狀並說明原因 | Claude Code | 變更被拒絕時（以替代的回應模擬），勾選框恢復為未勾選，錯誤列說明原因。 |
| 中文、窄手機上的審閱卡片 | Claude Code | 在 320px、中文介面下，卡片有標題、類型（風險）、下一步、讀了幾則回覆與 **交給團隊**，頁面不會左右捲動。 |

## 團隊檢查

[`checks.spec.ts`](specs/checks.spec.ts)：**團隊檢查**（Team checks），團隊回答後由 Harness Relay 自己檢查，以及它的 hook，由 Harness Relay 在成員的呼叫前後執行。假 CLI 會寫入對話保護的檔案（`e2e:write=…`）；假 Claude Code 會像真的一樣，在它的指令（`e2e:approve`）和 Write 前後呼叫 `initialize` 註冊的 hook。

| 情境 | CLI | 檢查什麼 |
| --- | --- | --- |
| 團隊寫入受保護檔案時檢查未通過，擋住使用者這段時間寫的訊息，略過後才送出 | Claude Code | 在保護 `secret.txt`（透過 API 設定）的編輯對話裡，一則很慢的回覆寫入它，同時使用者再送出一則訊息。回覆後，**Team checks** 卡片顯示 **Failed**、**Protected paths**、「secret.txt added · in @Claude's turn」，以及不會撤銷任何修改；佇列說等待的訊息還沒送出，並提供 **Send anyway**。按 **Skip**（確認）後卡片標為已略過，佇列消失、訊息送出；卡片仍顯示 **Failed**，也不再有 **Skip**。 |
| 在團隊設定設定；檔案移除後重新檢查會通過，也能請成員修正 | Claude Code | 在**團隊設定**底部展開**進階設定**，每條規則的名稱都在輸入框上方，`../outside` 會被拒絕並說明原因，接著存下 `*.key`（對話設定裡有它）。寫入 `deploy.key` 的回覆未通過；**Ask @Claude to fix it** 會把使用者的訊息傳給 @Claude，卡片顯示已請 @Claude 修正。把檔案移走後，**Check again** 會貼出第二張顯示 **Passed** 和 **Checked again** 的卡片。 |
| 團隊做的應用程式必須能在預覽中開啟，沒通過時自動交回團隊 | Claude Code | 在**團隊設定**的**進階設定**勾選**團隊做的應用程式必須能在預覽中開啟**和**沒通過時自動交回團隊修正**（對話的清單兩個都有）。假 CLI 寫出 `snake/main.py`：卡片上 **應用程式預覽** 未通過，指出 `snake` 和缺少的 Dockerfile，Relay 自動送出的訊息（「sent by Relay automatically, attempt 1 of 3」，標著 **Relay's fix 1/3**）讓 Claude 再發言一次；卡片說明已自動交回。那一輪沒改任何東西，所以不會再有新卡片。 |
| 團隊設定重新載入後保留新版規則 | — | 另一個工作階段更新受保護路徑。抽屜重新載入後，修改 commit 格式並儲存會保留新版路徑。 |
| 記憶下方的 Hooks 與團隊檢查預設分別驗證、儲存 | — | 在**設定 → App 與工具 → 工具庫**中，**Hooks** 緊接在**記憶**之後（長期記憶在實驗室）；展開 **Hooks** 與**團隊檢查預設**才會顯示各自的編輯欄位。兩區各自驗證資料夾與時限。收合團隊檢查並儲存 hook 後，再展開團隊檢查時，草稿指令及無效的資料夾仍在。儲存團隊檢查也會保留 hook 的草稿。重新載入可看到已儲存的值。在桌面與 320 px 寬的畫面上，移除按鈕都在 hook 卡片右上角。移除最後一個 hook 也會保留已儲存的指令。 |
| 團隊設定要求有效的 hook 資料夾和時限 | — | 資料夾或時限無效時不可儲存。修正後，儲存按鈕重新啟用。 |
| 在團隊設定設的 hook 在成員的呼叫前後執行：「執行前」的 hook 拒絕指令，「執行後」的 hook 沒通過時交回給它 | Claude Code | 在完整權限的對話裡，**Team settings** 加上兩個 hook：**Before**、**Commands**，印出指令後失敗；**After**、**File changes**，印出檔名後失敗（對話設定裡兩個都有）。執行 `echo e2e-approval` 的回覆說團隊的 hook 拒絕了它，附上 hook 的話，回覆裡的註記說 hook 拒絕了 `` `echo e2e-approval` ``；寫入 `notes.txt` 的回覆說出「執行後」hook 的話（`lint: notes.txt has 1 problem`），註記說它沒有通過，檔案也寫入了（「執行後」的 hook 不會撤銷任何事）。Windows 上略過（那裡還不能執行 hook）。 |
| 唯讀對話不檢查 | Claude Code | 唯讀對話設了同樣的清單，想寫入的回覆不會有卡片。 |
| 未通過的指令顯示它怎麼結束和它的輸出；團隊設定可以試跑指令 | Claude Code | 在完整權限的對話裡，指令在 `broken.txt` 存在時會失敗；寫入它的回覆後，卡片顯示 **Failed**、指令列、「exit 3」、沒有在沙箱裡執行，以及 **Output (the end)** 裡它印出的內容。在 **Team settings** 按 **Add a command**、再按 **Try it**，顯示 **Passed**；存檔後對話有兩條指令。Windows 上略過（那裡還不能執行指令）。 |
| 低於完整權限時，指令在 Harness Relay 自己的沙箱裡執行，不能寫到工作目錄以外 | Claude Code | 在編輯對話裡，寫入工作目錄的指令通過，並說明它自己改了 `inside.txt`；寫到家目錄的指令無法執行（被沙箱擋下），整份結果也是無法執行，絕不是 **Failed**。Harness Relay 自己的沙箱不能用的地方略過。 |
| 平行模式下，沒通過檢查的結果不會套用，直到使用者仍要套用 | Claude Code | 在保護 `secret.txt` 的平行編輯對話裡，回覆在它的 worktree 裡寫入它，回覆後的卡片在那裡找到它。按 **Apply to working directory** 會貼出套用前檢查的卡片（目前的工作目錄加上 @Claude 的結果），顯示 **Failed** 和沒有套用（不說是事後檢查），工作目錄裡也沒有這個檔案；按 **Apply anyway**（確認）會套用它，按鈕也隨之消失。 |
| 平行模式下，結果的指令在 Harness Relay 自己的沙箱裡、在加上結果的工作目錄上執行 | Claude Code | 在平行編輯對話裡，指令需要 `result.txt`；套用回覆的結果時，會在真正的沙箱裡、在檢查樹上檢查它：卡片顯示 **Passed** 和已套用，檔案進了工作目錄，指令寫出的檔案則沒有。Harness Relay 自己的沙箱不能用的地方略過。 |
| 設定裡的預設讓每個新對話和新自動任務一開始就帶著，可以修改或拿掉 | — | 在 **設定 → App 與工具 → 工具庫 → 團隊檢查預設** 存下 `.env` 和 `*.pem`（伺服器的設定裡有它們）。**新對話**和**新自動任務**的**工作目錄與對話設定 → 進階設定**一開始就帶著這些路徑，開出來的對話也有，並標記為預設。在自動任務中清除路徑後，它的對話是空清單。之後再存另一份預設（`*.key`），兩個之前建立的對話都不受影響。 |

## 成員的模型與推理強度

[`models.spec.ts`](specs/models.spec.ts)：在**團隊設定**中選擇並儲存。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 為成員選的模型與推理強度以 `--model` 與 `--effort` 交給 Claude Code | Claude Code | `opus` 與 High 存在成員上，它的回合拿到 `--model opus --effort high`。 |
| 為成員選的模型與推理強度會交給它的 CLI | Claude Code 以外各一 | CLI 自己清單裡的模型（`codex debug models`、`grok models`、Cursor、Antigravity 與 Copilot 列出的那些，以及 Muse Code 固定的那份；開源 agent 的則來自它的模型來源：假端點的 `e2e/e2e-model-mini`）與它為這個模型提供的推理強度存在成員上，假 CLI 記下回合以它們執行，依轉接器交給它的方式（Codex 的 `thread/start` 參數、Grok 在 prompt 之前的 `session/set_config_option`、Copilot 的 `--model` 與 `--reasoning-effort`、Muse Code 的 `--model` 與 `-c reasoning_effort=…`…），以及 CLI 自己的名稱（OpenCode 與 Pi 的 `relay-e2e/e2e-model-mini`、OpenHands 的 `openai/e2e-model-mini`）。OpenCode 對這個模型不提供推理強度，所以不會存下；Goose 用於端點的 provider 只提供 `off`，它的回合就以 `off` 執行。 |
| 設定中的預設模型與推理強度，就是保留「預設」的成員執行時用的 | Claude Code | 把 sonnet 與 Low 存成預設後，抽屜顯示「Default: sonnet」，成員仍是預設，它的回合拿到 `--model sonnet --effort low`。 |

## 成員如何輪流發言

[`turns.spec.ts`](specs/turns.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| agent 向使用者提問，等回答之後再用它來回答 | Claude Code | 問題顯示時沒有 `[ASK_USER]`，並有等待回答的卡片；輸入框提示回答 @Claude，側邊欄顯示**等你回答**（Answer needed）；回答會交給 agent。 |
| 略過問題，團隊其他人繼續 | Claude Code、Grok | 按**略過，讓團隊繼續**（Skip, let the team go on），下一位成員回答。 |
| 接力模式：成員把發言權交給它 @ 的隊友 | Claude Code、Codex | 第一位成員先回答並 @ 第二位，第二位接著回答；之後發言權交還給使用者（共兩則回答）。 |
| @ 某位成員的訊息只由那位成員回答 | Claude Code、Codex、Grok | 只有 @Grok 回答。 |
| 之後的回合沒有補充的成員 PASS，提前結束 | Claude Code、Codex | 設定三輪：兩人都回答、兩人都 PASS，沒有第三輪。 |
| 回答可以停止 | 各一 | 回答串流時按**停止**（Stop），回答以「(stopped)」結束，即時標籤與停止按鈕都消失。 |
| CLI 協定之內的錯誤顯示在回答上 | 各一 | 各 CLI 以自己的方式回報的錯誤都顯示在回答上：Claude 的錯誤結果、失敗的 Codex 回合、ACP agent 的 JSON-RPC 錯誤（Cursor 則像它實際那樣，把錯誤文字放在回答裡）、Pi 失敗的訊息。 |
| 成員的下一回合接續自己的 session | 各一 | 第二回合接續第一回合開始的 session（假 CLI 和真正的 CLI 一樣，拒絕接續從沒開始過的 session），它的回覆顯示這一輪自己的費用與 token，和第一回合的相同（Cursor、Muse Code、OpenCode 與 Goose 沒有用量，見[沒有測到的部分](#沒有測到的部分)）；假 CLI 像真正的 CLI 一樣回報整個 session 的累計時也是如此（Claude Code 的從它檔案最後一筆 `cost-state` 紀錄接著算，並像 2.1.323 一樣附上這次執行自己的用量；Cline 的；OpenHands 的）。 |
| CLI 遺失 session 的成員，帶著到目前為止的對話重新開始 | Claude Code | 刪掉 CLI 的 session 後，下一個 prompt 帶著整段對話，連第一則訊息也在。 |
| 失敗的回答顯示 CLI 的錯誤，重試後再回答 | 各一 | CLI 帶著錯誤結束：錯誤顯示在回答上，按**重試**（Retry）後回答。 |
| 團隊回答途中送出的訊息先等待，再交給下一位成員 | Claude Code、Grok | 第一位成員慢慢回答時，訊息在等待送出的區塊裡，下一位成員會回答它。 |

## 直接送進進行中的回合

[`steer.spec.ts`](specs/steer.spec.ts)：團隊設定的 **團隊工作時，把訊息直接送進進行中的回合**。Claude Code 的假 CLI（在輸入寫一則使用者訊息，用 `command_lifecycle` 回報）與 Codex 的假 CLI（`turn/steer`）能把訊息收進進行中的回合；它們的 `e2e:steer` 步驟（`=<秒數>`）在回答之後等一則訊息，再說它聽到了什麼（` I also heard: “…”.`）。其他的假 CLI 會直接回答；各 CLI 自己的方式在離線測試裡（`test/steer.test.ts`）。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 開啟後，成員工作時送出的訊息直接送進它進行中的回合 | Claude Code、Codex | 成員回答完、它的回合在等待時（`e2e:steer=20`：它的 CLI 回合正在進行，所以能接收訊息），輸入框寫著 **（可以的話直接送進進行中的回合）**（goes into the running turn when it can）；送出的訊息立刻出現在對話中，標上 **已送進 @<名稱> 的回合**（Sent into @<name>'s turn），沒有等待區；回答說它聽到了，也沒有另一次執行回答它（只有一則回答；訊息的 `steered` 是那位成員）。 |
| 關閉時（預設），訊息照常排隊，由下一回合回答 | Claude Code | 輸入框寫著 **（下一位發言前送達）**（delivered before the next turn）；訊息在等待區，第一則回答沒有它，第二次執行回答它，並標上 **插話**（Added mid-reply）。 |
| 團隊回覆中，在團隊設定開啟這個設定 | Claude Code | 回合進行中，勾選 **團隊設定** 裡的勾選框（它的說明講訊息會送到哪裡），單獨儲存；下一則訊息就送進進行中的回合。 |

## 要使用者做的步驟

[`steps.spec.ts`](specs/steps.spec.ts)：成員把要在 Harness Relay 之外做的步驟交給使用者。假 CLI 用 `e2e:steps` 在回覆最後加上一個 `<steps>` 區塊，三個步驟，第一步附連結（這裡用 `@claude`，讓排在它後面的 Grok 等待）。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 使用者做一步勾一步，重新載入與另一個分頁都保留，按「完成」後由那位成員先繼續 | Claude Code、Grok | 回覆顯示 **@Claude 給你的步驟**（Steps from @Claude）卡片而不是區塊（**完成 0 / 3**，每一步有一個以編號與文字命名的方框，連結到 `https://example.com/console` 並在新分頁開啟），沒有提問卡片；Grok 還沒發言；橫幅寫著 **@Claude 給了你要做的步驟**（Steps waiting for you: @Claude），側邊欄 **等你回答**，輸入框 **回答 @Claude…**。用鍵盤（空白鍵）勾的方框會存到伺服器，重新載入後仍是勾選的；在另一個分頁勾的，第一個分頁也看得到。附上備註後，**送出（完成 2 / 3）**（提示說沒勾的步驟會說成未完成）送出使用者的回答，逐步標示並附上備註；Claude 先再回答一次，接著是讀到這個回答的 Grok；卡片顯示 **已回覆**，不再有方框或按鈕，兩步完成並顯示備註。 |
| 「我卡住了」指出卡在哪一步，並附上備註 | Claude Code、Grok | 勾了第 1 步後，**我卡住了** 讓焦點移到 **卡在**，預設是第一個沒勾的步驟；選了第 3 步、寫下原因，**送出** 送出「I'm stuck at step 3 of the 3 steps @Claude gave me (1 done).」，那一步標成 **stuck here**；Claude 的下一則回覆有那個原因；卡片顯示 **卡在第 3 步** 並標出那一步。 |
| 改在輸入框用文字回覆時，卡片保持原樣，不再被等待 | Claude Code、Grok | 勾了第 2 步後，在輸入框打的回答照一般的回答繼續；之後卡片說團隊已不再等這些步驟，第 2 步仍是勾選的，也不再有方框。 |
| 另一位成員也在等時，卡片只回答它自己的成員，另一個問題繼續等 | Claude Code、Grok | 平行模式中，Claude 給步驟、Grok 提問（`e2e:ask@grok`）；卡片寫著 **Also waiting for you: @Grok. An answer here goes to @Claude alone; they keep waiting.**（也在等你的：@Grok。在這裡回覆只會交給 @Claude，其他的仍會等你。）**送出（完成 0 / 3）**：Claude 帶著回答再回覆一次；Grok 沒有，它的問題仍在等（它的卡片、橫幅 **@Grok 在等你回答**（Waiting for your answer: @Grok）、輸入框 **回答 @Grok 的問題…**（Answer @Grok…））；之後使用者在輸入框的回答交給 Grok，它帶著回答回覆。 |
| 在手機上卡片不超出螢幕，用觸控勾選並回覆 | Claude Code、Grok | 在 Pixel 7 的螢幕上，卡片與頁面都不比螢幕寬，每個方框至少 40 px 可以點，三個都點成勾選，**完成**（全部完成）送出「I did all 3 steps @Claude gave me.」。 |

## agent 回答前做了什麼

[`activity.spec.ts`](specs/activity.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 思考、工具呼叫與待辦清單和回答一起顯示 | 各一 | 這些步驟收合成列；展開後可看到思考、CLI 自己列出工作目錄的工具已完成與它的輸出（Claude 的 `Bash`、Codex 的 `Shell`、Grok 的 `list_dir`、Cursor、Antigravity 與 Copilot 的 `Read`、Muse Code 的 `Search`、OpenCode 的 `glob`、Goose 的 `tree`、Cline 的 `read_files`、OpenHands 的 `file_editor`、Pi 的 `List`，完全存取時是 `Bash`），以及三項中完成一項、進行中一項的待辦清單（Cursor 的來自它的 `cursor/update_todos` 請求，Pi 的來自 Harness Relay 的 gate 給它的計畫工具；Cline 沒有待辦清單可顯示）。 |
| 進行中的步驟在它的列中顯示 app 的載入標示（旋轉的標誌），完成後換回步驟的圖示 | Codex | Codex 在詢問之前就先回報它的指令，所以批准卡片等待時，它的步驟（`Shell`）正在執行：列中顯示標誌的三個圓點（`.logo-spinner`），14px，只有一個動畫：團隊設計卡片的旋轉（`logo-turn`，1.9 秒，一次又一次），從一開始就在軌道上轉，圓點本身沒有動畫（沒有旋入，否則步驟開始、結束時會閃動）。允許後，步驟在回覆仍在串流時完成（`e2e:slow=4`）：載入標示消失，原處換成 ⚙（載入標示代表步驟正在做事，不代表回覆），列中的文字沒有移動；回覆完成後仍是 ⚙。 |
| subagent 的呼叫摺進啟動它的那次呼叫，subagent 裡再有 subagent，執行中顯示它正在做的步驟 | Claude Code | `e2e:subagent=4`：假 CLI 把四處看看的工作交給在 haiku 上的 `Explore` subagent，它的呼叫帶著 `Agent` 呼叫的 id（`parent_tool_use_id`），和 Claude Code 2.1.330 送出的一樣。讀檔時（四秒），摺疊列顯示 **Explore › Read** 與 README 的路徑。完成後，區塊把 subagent 算成 **1 個動作**，只列出它一項，附上名稱、模型（**haiku**）與 **3 個動作**；展開後是它自己的步驟（**Bash**、**Read**，以及它自己的 `general-purpose` subagent，其中的 **Grep** 再往內一層），左側以一條線連到它，最後是它回報的結果，去掉 Claude Code 為呼叫它的 agent 加上的那一行；Claude Code 的壓縮（`compact_boundary`）在回覆中顯示為 Harness Relay 的附註。 |
| Markdown 回答會轉成格式 | Claude Code | 標題、清單、表格與上色的程式碼。 |

## 捲動對話

[`scroll.spec.ts`](specs/scroll.spec.ts)：訊息會跟著新的輸出，直到讀者往上捲；這時訊息框上方中間有個圓形箭頭，按下去就回到最後，並再次跟著新的輸出。多了四十段的回覆（`e2e:long`）比視窗還高。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 往上捲之後，訊息框上方中間的箭頭把對話帶回最後，用鍵盤也可以 | Claude Code | 在最後時沒有箭頭。訊息打了一半時用滑鼠滾輪往上 600px，出現**捲到最新的訊息**（Scroll to the latest message，title 也一樣）：與訊息框置中對齊，誤差在一個像素內，在訊息框上方、離訊息區底部不超過 24px，圖示在正中央，沒有東西蓋住它。按一下對話就回到最後，箭頭消失，訊息框保有焦點與打到一半的文字。在它上面按 Enter 也一樣，焦點接著移到訊息框。自己捲回最後也會讓它消失。減少動態效果時，按一下對話立刻就在最後，原本沒有焦點的訊息框也不會取得焦點。 |
| 箭頭在等待送出的訊息上方，@ 成員清單打開時隱藏 | Claude Code | 慢慢串流的長回覆進行中，送出的訊息停在等待區；往上捲後，箭頭在等待區上方，仍與訊息框置中對齊。輸入 `@` 打開成員清單時箭頭隱藏，清單關閉後再出現。 |
| 回覆串流時，往上捲的讀者停在原處並看到箭頭，按下去就跟著回覆直到最後 | Claude Code | 一則慢慢串流的長回覆（`e2e:long e2e:slow=15`，一段接一段出現）：跟著它時沒有箭頭。往上 300px 後出現箭頭，下方又多了超過 100px 時，對話仍停在讀者的位置（誤差一個像素內）。回覆還在串流時按一下，對話回到最後，並一直停在最後、沒有箭頭，直到回覆結束。 |

## 核准

[`approvals.spec.ts`](specs/approvals.spec.ts)：在會詢問使用者的對話中，agent 想執行指令（`echo e2e-approval`）。除了 Pi 與 Copilot 之外都是唯讀對話：Pi 在唯讀時沒有執行指令的工具，Copilot 不詢問就執行 `echo`（它把它當成唯讀指令），所以它們在編輯模式下，針對那裡唯一會詢問的那種指令詢問（`npm publish e2e-approval`，用 `e2e:approve=publish`）。Goose 要求執行的是 `env echo e2e-approval`，因為在唯讀時 Harness Relay 讓它不詢問就執行 `echo` 這類單純讀取的指令。回答會交給各 CLI 自己的請求：Claude Code 的 `can_use_tool`、Codex 的核准請求、ACP agent 的 `session/request_permission`（Grok、Cursor、Antigravity、Copilot、Muse Code、OpenCode、Goose、Cline、OpenHands），以及 Pi 的 gate 擴充功能的對話框。選 **替我核准** 時，假的首席 agent 會核准它審查的每個請求，除非使用者最新的訊息寫了 `e2e:flag`（`e2e:slowapprove=<秒數>` 讓它審查那麼久）。加上 `e2e:withdraw=<秒數>` 時，假的 Claude Code 在那段時間後就不再等回答（`control_cancel_request`），照樣執行指令，就像它自己的規則或 hook 先做了決定；加上 `e2e:bgask` 時，它的背景子代理會在這一輪回答時要求執行 `echo e2e-approval`，再用它自己的一輪說明有沒有執行（輸入先結束的話，請求會被拒絕，和 Claude Code 一樣）。`e2e:approve=long` 要求執行一段六行、179 個字元的 Python heredoc，回答之後會摺起來。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 使用者允許的指令會執行 | 各一 | 卡片顯示指令，側邊欄顯示**等你核准**（Needs you）；按**允許**（Allow）後指令執行，卡片顯示已允許。CLI 只能以完全存取執行的地方跳過。 |
| 使用者拒絕的指令不會執行，附註會一起交給它 | 各一 | 卡片顯示「Declined: Not now」。Claude Code、Grok、OpenCode、Goose 與 Pi 拒絕時會收到附註；Codex 的回答沒有附註的位置，Cursor、Muse Code、Cline 與 OpenHands 則丟掉附註（回答只說指令被拒絕）；Antigravity 與 Copilot 一被拒絕就結束它們的回合，回答只說明這一點，不再多說。CLI 只能以完全存取執行的地方跳過。 |
| 「本對話都允許」讓下一次同樣的請求自動通過 | Claude Code | 第二次請求自動允許，沒有卡片。 |
| 請求等待時停止團隊，指令不會執行 | Claude Code | 回答以「(stopped)」結束，請求被拒絕或沒有回答。 |
| 完全存取時，指令直接執行，也能不詢問就寫到任何地方 | 各一 | 標題列警告**完全存取**（Full access）；指令執行，檔案寫到另一個資料夾，沒有卡片（在每個系統上都一樣：完全存取的 CLI 外面沒有沙箱）。 |
| 很長的指令回答後只顯示第一行、後面還有幾行與回答，點開可看完整指令 | Claude Code | 等待時卡片顯示完整指令（`e2e:approve=long`）。附上很長的說明拒絕之後，那一行顯示 `python3 - <<'EOF'`、**+5 lines** 和含說明的「Declined: …」；指令本身在點那一行之前是隱藏的，點開後保留換行，在那一行按 Enter 會再收起來。 |
| 自動拒絕的對話不詢問就拒絕 | Claude Code | 指令被拒絕，沒有卡片。 |
| 在團隊設定選「替我核准」：首席 agent 放行一個指令，把它標記的那個留給使用者 | Claude Code | 在可編輯的對話中，於團隊設定選 **替我核准**：顯示它的說明，權限範圍以外的動作那個選項消失，標頭的標籤顯示 **替我核准**，對話存成可編輯加上 `approvals: "auto"`。假的首席 agent 核准第一個指令：它直接執行，沒有等待的卡片，那一行顯示 **首席 agent 已替你核准** 與理由。被要求標記第二個（`e2e:flag`）時，它把指令留給使用者：卡片附上首席 agent 的理由等待，不提供 **本對話都允許**，並說明只能允許這一次，側邊欄顯示 **等你核准**，按 **允許** 後執行。 |
| 「替我核准」：首席 agent 審查時不等任何人，使用者可以先回答；推送一律不送審 | Claude Code | 假的首席 agent 慢慢審查時（`e2e:slowapprove`），卡片顯示 **首席 agent 審查中…**，說明接下來會怎樣、也可以現在就決定，而且看起來不像等使用者的卡片（logo 轉動、按鈕是次要樣式、沒有留言欄），沒有提示列，也沒有 **等你核准**；按 **不等審查，直接允許** 後指令執行，那一行顯示 **已允許**（使用者的回答）。`npm publish`（`e2e:approve=publish`）立即等使用者決定，卡片說明推送與發佈一律由使用者決定，並出現提示列；按 **拒絕** 後被拒絕。 |
| 背景子代理在這一輪回答時提出的請求，回覆出來之後仍然可以回答 | Claude Code | 在唯讀對話中，假的 Claude Code 開了一個背景子代理，它在這一輪回答時要求執行 `echo e2e-approval`（`e2e:bgask`）。回覆出來、又過了一下之後，卡片仍顯示 **等你決定**；按 **允許** 後回答送到子代理，它執行了指令，Claude Code 之後自己的一輪（「The background job's command ran: e2e-approval.」）也接在同一則回覆裡，那一行顯示 **已允許**。 |
| 首席 agent 審查期間 CLI 就不再等待的請求會立即標明，回覆照樣繼續 | Claude Code | 在 **替我核准** 的對話中，假的首席 agent 還在審查（`e2e:slowapprove`）時，假的 Claude Code 撤回了它的請求（`e2e:withdraw=2`）：卡片立即消失，那一行顯示 **已撤回**（它的 CLI 不再等使用者回答）和它自己的標記，絕不顯示 **首席 agent 已替你核准**，對話也不會顯示 **等你核准**，回覆照樣繼續（指令執行了）。 |

## 使用者自己執行的指令

[`interactive.spec.ts`](specs/interactive.spec.ts)：agent 請使用者從卡片自己執行的指令（假 CLI 回覆結尾的 `<interactive>` 區塊，`e2e:interactive`）。在 macOS 與 Linux 上會真的執行（`/bin/sh`）：假 CLI 的指令會印出一個連結和一組代碼、要求輸入密碼，再印出它讀到的內容；用 `e2e:interactive=askpass` 時，改為透過密碼小幫手詢問（`$SUDO_ASKPASS`，和 `sudo -A` 執行它的方式一樣）。

| 情境 | CLI | 檢查什麼 |
| --- | --- | --- |
| 使用者啟動 agent 請他執行的指令，隱藏輸入內容，再把遮蔽後的輸出送給團隊 | Claude Code | 回覆的文字裡沒有 `<interactive>` 標籤；卡片說明原因，也說明它在所有 agent 的沙箱之外執行，預設在它自己的空資料夾裡。按**啟動**後執行：從它的輸出挑出連結和代碼（`ABCD-1234`），到了要密碼的提示時，「隱藏我輸入的內容」會自動勾選（欄位是密碼欄位）。輸入的那一行由程式印出，但已遮蔽（`Got ••••`）；卡片顯示它以結束碼 0 結束，從不顯示那個值。**把輸出送給團隊**會把它當成使用者的回答貼出，假 CLI 接著道謝；對話裡保存的是遮蔽後的輸出，從不含那個值。Windows 上略過。 |
| 它的密碼小幫手像 `sudo -A` 的那樣，在卡片上要一行隱藏的內容 | Claude Code | 小幫手的問題連同一個隱藏欄位出現在卡片上；**回答**把那一行交給程式，程式印出時已遮蔽（`helper got ••••`）。**再執行一次**會重新啟動，**取消執行**會停止它（卡片會說明）；沒有送出時，agent 拿不到任何內容，對話裡也從不含那個值。Windows 上略過。 |
| 在原生 Windows 上，卡片說明那裡不能執行 | Claude Code | 卡片說明原生 Windows 上還不能從卡片執行指令，也沒有**啟動**。只在 Windows 上執行。 |

## 檔案與修改

[`files.spec.ts`](specs/files.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 編輯模式下 agent 修改檔案，聊天中顯示改了什麼 | Claude Code | 檔案在工作目錄裡，工作目錄也變成 git repository；變更卡片列出它，並能打開這一回合的 diff：檔案一個區塊，預設收合（顯示狀態、路徑與 `+1`，看不到它的行；只有一個檔案時沒有「Expand all」），點一下展開顯示新增的那一行，再點一下收合。 |
| 唯讀對話中不會寫入任何檔案 | 各一 | Claude Code、Muse Code 與 Pi 執行時沒有檔案工具，Cursor 的寫入被它自己的規則拒絕，Copilot 的被它的沙箱拒絕（唯讀對話中每個工作目錄在那裡都是唯讀），都沒有卡片；其他的會詢問，然後被拒絕（Antigravity 接著結束它的回合）；沒有寫入檔案，也沒有變更卡片。CLI 只能以完全存取執行的地方跳過。（使用者允許的寫入仍然寫不進資料夾：見 [Harness Relay 自己的沙箱](#harness-relay-自己的沙箱)。） |
| 自動拒絕的唯讀對話中，Grok 說明原因 | Grok | 工具的錯誤寫著唯讀模式下不允許。 |
| 每個 CLI 都能在編輯模式寫檔，每一回合各自記下變更 | 兩個團隊 | 每位成員寫自己的檔案（`<cli>.txt`），每則回答的變更卡片都列出它。在這裡只能以完全存取執行的 CLI，在自己的對話中以完全存取執行。 |
| 平行模式中每位成員在自己的 worktree 工作，可以套用其中一份結果 | Claude Code、Codex | 兩張變更卡片都寫著「in worktree」，工作目錄裡什麼都沒有，直到按**套用到工作目錄**（Apply to working directory）帶進 Codex 的檔案。 |
| 這段期間在同一個資料夾寫入的第二個對話在自己的 worktree 裡工作，按「套用」帶進它的修改 | Claude Code、Codex | Claude Code 的對話正在資料夾裡寫入時（很慢的回覆，`e2e:slow`），送到那裡的 Codex 對話不會被拒絕：一則說明指出是哪個對話正在修改資料夾，它的卡片寫著「in this chat's worktree」，資料夾裡什麼都沒有，**檔案**（Files）列出 **This chat's worktree**。第一個對話寫入期間**套用**會被拒絕並說明原因；停止它之後，套用就帶進 Codex 的檔案，有一則說明，卡片上也不再有套用。 |
| 檔案瀏覽器顯示工作目錄並預覽檔案 | Claude Code | **檔案**（Files）列出專案；`src/hello.ts` 打開後顯示程式碼，並以 TypeScript 上色（關鍵字與型別各有自己的 class）；按 Escape 關閉。 |
| 資料夾可下載成 ZIP 檔，裡面沒有 .git | Claude Code | 工作目錄的 ZIP（`work.zip`）剛好包含它的檔案與內容，沒有 `.git`；某個資料夾自己的 ZIP（`src.zip`）只有那個資料夾。 |
| 太大而無法整個壓縮的資料夾，改為提供不含 git 忽略的檔案 | Claude Code | 一個長度設為超過 1 GiB、但沒有真的寫入的被忽略檔案（Windows 上仍會佔用磁碟空間）讓資料夾太大：拒絕時不下載任何東西，接受時得到不含被忽略資料夾的 ZIP。 |
| 在「檔案」中編輯並儲存文字檔，儲存時檔案已有較新版本會提議重新載入 | Claude Code | 在唯讀對話中，`queue.csv`（CRLF 換行）用**編輯**（Edit）打開，文字框取得焦點，有修改之前**儲存**（Save）不能按，修改後顯示**尚未儲存**（Not saved）；存檔後檔案多了新的一列且保留 CRLF 換行，預覽也顯示出來。編輯期間磁碟上的檔案被改過時，Ctrl+S（⌘S）會被拒絕並說明檔案已改變，檔案維持另一方寫入的內容；**重新載入**（Reload）把新版本放進文字框，再存一次就會保留。有未儲存的修改時按 Escape 會先詢問，拒絕就保留修改；確認後按**取消**（Cancel），檔案維持原樣。 |
| 新檔案與上傳的檔案放進目前所在的資料夾，同名檔案確認後才取代 | Claude Code | 在 `src` 裡：**新增檔案**（New file）拒絕 `a/b.md` 並說明原因，接著建立 `notes.md` 並在編輯器中打開，存入它的內容。選了兩個檔案，其中一個是 `hello.ts`：拒絕取代時只上傳 `photo.png`（**Uploaded 1 file.**），`hello.ts` 維持原樣；再選一次並同意，就會取代它。拖放到列表上的檔案（`dragenter` 顯示放置區域）會放進 `src`。 |
| 有任務在資料夾寫入時，儲存要等它結束 | Claude Code | 在可編輯模式的對話中，緩慢的回覆（`e2e:slow`）執行期間儲存會被拒絕，說明有任務正在改動資料夾裡的檔案，文字留在文字框裡；停止任務後，同樣的儲存就會成功。 |
| 在「檔案」中確認後刪除檔案與資料夾，預覽中的檔案跟著關閉 | Claude Code | **刪除 scratch.txt** 會先詢問（「刪除後無法復原」）：拒絕時檔案留著；同意後它從列表和磁碟上消失，並有狀態訊息說明。預覽中開著 `drafts/b.md` 時，**刪除 drafts** 會詢問是否刪除資料夾和裡面的所有東西，整個刪除，預覽回到 **選一個檔案預覽內容。** |
| 附加到訊息的資料夾以路徑交給 agent，不含 .git 與 node_modules，並可下載成 ZIP 檔 | Claude Code | 迴紋針的選單提供 **檔案…** 和 **資料夾…**（焦點在第一個，方向鍵在兩者間移動，Escape 關閉選單並把焦點放回迴紋針；在迴紋針上按向下鍵會打開選單，點選單外面會關閉）。透過 **資料夾…** 選取空資料夾時，會說明裡面沒有可以附加的檔案（WebKit 除外，Playwright 在那裡無法給資料夾選擇器空資料夾）。透過 **資料夾…** 選取一個含有 `.git` 與 `node_modules` 的資料夾，會顯示成一個寫著 2 個檔案的標籤，它的提示文字列出略過的項目；agent 的提示詞把它列成 `site/`（2 個檔案的資料夾）並附上路徑，檔案都在那裡，`.git` 不在；送出的訊息標籤寫著 2 個檔案，下載的 `site.zip` 裡有資料夾的兩個檔案。 |

## 應用程式預覽

| 情境 | CLI | 驗證內容 |
| --- | --- | --- |
| 從「檔案」試用靜態網站 | Claude Code | 資料夾會直接開啟並載入 JavaScript 模組，全程不需設定 Docker。修改原始檔後重建可以看見新頁面。錯誤與原本的草稿一起保留，手機上可以回到仍在執行的預覽。停止後 frame 移除。 |
| 桌面 app 視窗裡的「新分頁」 | Claude Code | user agent 帶著 Electron 的名稱，`window.open()` 也像 app 的視窗那樣回傳 null（它的防護會拒絕空白頁，並把不是伺服器的網頁交給預設瀏覽器開啟）：**New tab** 的提示說明會在預設瀏覽器開啟，頁面不先開空白分頁，而是直接開啟預覽的一次性網址（`_blank`、`noopener,noreferrer`），也不說彈出式視窗被擋下；另一個沒有登入 Relay 的瀏覽器，用這個網址就能打開網頁。 |
| 大到無法整個複製的工作目錄最上層的網頁 | Claude Code | 旁邊的資料夾有 4,097 個檔案時，在工作目錄最上層按 **Preview this folder**，會開啟它的 `index.html` 並帶著它引用的樣式表（標題是紅色），面板說明只帶了網頁和它引用的檔案。 |
| 平行成員回覆中的同名檔案 | Claude Code、Codex | 手機上，團隊寫出的網頁不會自動打開，改由卡片提供。每個連結可繼續下載，預覽則開啟該成員自己的版本。手機寬度下可操作整個面板。 |
| 團隊做出的應用程式自動打開 | Claude Code | 還沒有應用程式時，頂端的 **預覽** 停用並說明原因。假 CLI 在編輯模式寫出 `site/index.html`：這一輪結束後面板自動打開並開始預覽，訊息框保留焦點，**預覽** 呈按下狀態。來源與按鈕收成一列，顯示資料夾與 agent，可展開與收起。回覆後的卡片提供這個應用程式。**新分頁**（提示說明是瀏覽器的，不是桌面 app 的）在按下的當下、伺服器給出網址之前先開一個空白分頁，再在裡面開啟網頁，與 Relay 的頁面切斷關係，可以自己重新整理。**預覽** 會隱藏面板，再按一次顯示同一次執行；關閉後可從卡片重新開始。重新載入後不會自動打開，按 **預覽** 才開啟；下一個問題送出後卡片收起。 |
| 應用程式只自動打開一次，也不會蓋過其他預覽 | Claude Code | 從「檔案」開著預覽時，團隊寫出的網頁只出現在卡片裡，面板保留使用者的網頁。另一個應用程式會自動打開；關閉後，下一輪修改同一個資料夾時不會再打開，改由卡片提供。 |
| 團隊做出的 Dockerfile 在完全存取以外會等待 | Claude Code | 假 CLI 在編輯模式寫出 `api/Dockerfile`：面板打開並顯示資料夾與 **開始預覽**，說明建置可以連上網路，不會詢問 Docker 也不會開始預覽。 |
| 團隊做出的應用程式無法在預覽中執行 | Claude Code | 假 CLI 寫出 `snake/main.py`，沒有能執行它的東西：面板不會打開，頂端的 **預覽** 維持停用；卡片寫著「The app in snake cannot be previewed yet」和原因，按 **Ask @Claude to fix it** 會把請求放進訊息框。送出後卡片就消失。 |
| 聊天與面板之間的分隔線 | Claude Code | 在網頁的 frame 上拖曳時，面板縮小相同的寬度，聊天跟著調整；向左方向鍵會加寬；聊天至少保留 360 像素；寬度在重新載入後保留，按兩下恢復預設寬度。 |
| 從回覆開啟 npm 專案 | Claude Code | 自動啟動後端。Relay 在檢查 Docker 前就會指出缺少的 lockfile，可將錯誤放入草稿並標註該成員。關閉正在啟動的預覽會清除遲到的結果。 |
| 建置時缺少 Docker | Claude Code | 取消設定後預覽仍為停止狀態。選擇安裝 Docker 才會啟動安裝。模擬的引擎就緒後，預覽只會啟動一次建置。 |
| 團隊做出的 npm 專案，缺少 Docker | Claude Code | 假 CLI 在有建置指令的專案底下寫出 `web/public/index.html`：面板開啟這個專案（`web`），提供 **設定 Docker**，在使用者要求前不打開它的對話框，也不開始任何東西。 |
| 已安裝的引擎尚未就緒 | Claude Code | 可重新檢查已停止的引擎。引擎就緒後，同時有兩種 npm 指令的專案只會啟動後端一次。 |
| 從登入後的面板建置前端與執行 SQLite 後端 | Claude Code | 啟用 `E2E_PREVIEW_DOCKER=1` 且本機有能執行 Linux 容器的 Docker 時，從兩個專案連結直接預覽，先檢查前端建置的 HTML，再用另一個專案的後端 API 儲存資料。重新整理後資料仍在，重建後變回空白，停止後關閉 frame。 |
| Dockerfile 的容器預覽（模擬） | Claude Code | 用模擬的引擎與終端機串流：面板說明應用程式沒有網路，應用程式提供網頁時開啟網頁，且不會傳訊息給還沒載入網頁的 frame（透過 CDP 讀取 Chromium 自己的記錄），終端機顯示建置與應用程式的輸出，提供正在執行的指令，送出按鍵（手機上面板是對話框時，Escape 與 Tab 也一樣），並能原樣、用修改後的指令列，以及以 shell 再執行一次。 |
| 容器建置失敗（模擬） | Claude Code | 從「檔案」開啟 compose 檔：建置失敗時說明，不提供再執行一次，終端機最後幾行（去掉顏色）連同原本的草稿放進回報。 |
| 終端機重新連線時預覽已不在（模擬） | Claude Code | 串流結束，重新連線找不到預覽：面板不再提供再執行一次，也不再顯示重新連線。 |
| 沒有執行方式的資料夾 | Claude Code | 沒有 Dockerfile 的 Go 資料夾：面板提到 Dockerfile，**請 agent 加上 Dockerfile** 會在輸入框放一份給團隊的草稿。 |
| 透過 Docker 執行的 WebSocket 應用程式 | Claude Code | 啟用 `E2E_PREVIEW_DOCKER=1`：沒有任何函式庫的 Node WebSocket 伺服器，它的網頁經由預覽自己的 origin 連到 `/live`，送出 ping 後顯示伺服器的回答，瀏覽器的 Cookie 不會到達應用程式。 |
| 透過 Docker 執行 Python 的 Dockerfile 應用程式 | Claude Code | 啟用 `E2E_PREVIEW_DOCKER=1`：面板先顯示終端機，再顯示網頁；網頁沒有網路，由映像檔 `EXPOSE` 的 port 提供；終端機有伺服器的輸出。 |
| 透過 Docker 執行終端機程式 | Claude Code | 啟用 `E2E_PREVIEW_DOCKER=1`，從「檔案」開啟：出現提示，輸入得到回應，顯示結束代碼；修改後的指令會帶參數再執行，以錯誤結束時放進回報，**開啟 shell** 得到設有 `PORT` 的 shell。 |
| 透過 Docker 執行有 Redis 的 compose 應用程式 | Claude Code | 啟用 `E2E_PREVIEW_DOCKER=1`：從專案建置的網頁服務在 Redis 健康後用服務名稱連到它，讀到掛載進來的專案檔案，套用變數的預設值，且連不到外部，也沒有通往這台電腦的閘道。停止後，帶它標籤的東西都不會留下：容器、網路、映像檔，以及 Redis 的匿名 volume。 |

## 發布應用程式

對這台電腦上 Render 與 Neon API 的替身（`support/cloud.ts`，伺服器透過 `RELAY_RENDER_API_URL` 與 `RELAY_NEON_API_URL` 連到它）和假的 `gh` 測試；假的 `gh` 會在伺服器的 git 推送的資料夾裡（`RELAY_PUBLISH_GIT_DIR`）把每個私人儲存庫建成 bare 儲存庫。用的是靜態網站，所以不需要 Docker。

| 情境 | CLI | 檢查什麼 |
| --- | --- | --- |
| 設定、一鍵發布、更新與取消發布 | Claude Code | 在 **設定 → 發布到雲端** 裡，錯的 Render 金鑰被拒絕，對的金鑰保存後只顯示遮蔽的結尾與它的工作區，選了區域，Neon 的金鑰保存後顯示組織，任何金鑰都不顯示；每一區都連到網站上它的設定說明（網址正確、在新分頁開啟）。從「檔案」預覽靜態網站：**發布…** 顯示計畫（私人儲存庫 `relay-test/site`、免費靜態網站、名稱），確認公開後才能按 **發布**，接著顯示各個步驟直到上線（進行中的步驟會轉動 app 的標誌，上線後沒有步驟再轉），附上網址與儲存庫的連結。Render 從只含預覽頁面的儲存庫建立靜態網站，沒有建立 Neon 專案。**發布更新** 推送第二個 commit，並在同一個網站上部署。設定列出這個應用程式與它的網址，**取消發布** 會移除它的服務並保留儲存庫。 |
| 缺少設定與改變的檔案 | Claude Code | 沒有設定時，對話框列出 Render 的金鑰並連到設定，即使確認了公開，**發布** 仍無法按。預覽的頁面改變後，對話框說明預覽之後檔案已改變、要重建預覽；Render 與 Neon 都沒有收到任何請求。 |

## 工作目錄與其他資料夾

[`folders.spec.ts`](specs/folders.spec.ts)：假 CLI 只會寫在真正的 CLI 能寫的地方，所以這些測試能看出對話的資料夾有沒有傳到各 CLI。開源 agent 的假 CLI 會真的寫檔，不屬於它們的地方由 Harness Relay 自己的沙箱拒絕。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 編輯模式下，對話沒有的資料夾碰不到 | 各一（Grok 不在 Windows 上） | 自動拒絕時，隔壁的資料夾不會寫入任何東西：Copilot 與 Muse Code 以外有登入的 CLI 會詢問，然後被拒絕（Antigravity 接著結束它的回合）；Copilot 的寫入由它自己的沙箱不詢問就拒絕，它的回合繼續；Muse Code 的檔案工具不詢問就拒絕，接著試的寫入指令在編輯模式下由轉接器允許，再被它的沙箱拒絕；開源 agent 不詢問就寫，由 Harness Relay 自己的沙箱拒絕。CLI 只能以完全存取執行的地方跳過；Grok 在原生 Windows 上沒有沙箱，所以那裡也跳過。 |
| 寫到對話沒有的資料夾前先詢問，使用者允許後才寫 | Claude Code、Codex、Cursor、Antigravity | 在「想修改檔案」卡片按**允許**，檔案就寫在那裡。Grok 不在其中，因為它的沙箱照樣會拒絕；Copilot 也不在其中，因為它的沙箱不詢問就拒絕；Muse Code 也不在其中，因為它在那裡什麼都不詢問（它的檔案工具拒絕，它的沙箱拒絕它接著試的指令）；開源 agent 也不在其中，因為沒有任何回答能放寬它們的沙箱。 |
| 在輸入框加入與移除資料夾，對話在所有資料夾中工作 | Claude Code | 在**工作目錄**（Working directories）輸入的資料夾變成標籤，也能移除；對話存下留下的資料夾，agent 在第一個與第二個寫檔，被移除的沒有。 |
| 各 CLI 在每個資料夾寫檔，變更卡片依資料夾列出 | 各一 | 兩個資料夾各一個檔案：卡片寫著「Changed 2 files」，每個資料夾一組，diff 每個檔案一個收合的區塊，前面是資料夾名稱，「Expand all」全部展開（各自新增的那一行），「Collapse all」全部收合。Cursor 寫入第二個資料夾前會詢問，並得到允許。 |
| 檔案瀏覽器列出每個工作目錄 | Claude Code | **檔案**有**資料夾**（Folder）選單，列出兩個資料夾；第二個顯示它自己的檔案。 |
| 平行模式中每位成員在每個資料夾都有 worktree，套用時全部一起套用 | Claude Code、Codex | 兩則回答在每個資料夾都有 worktree 的變更；**套用**會把 Codex 的檔案寫進兩個資料夾。 |
| 新對話從設定中的預設工作目錄開始 | — | 在**設定 → 預設工作目錄**存下的資料夾，出現在下一個新對話的輸入框裡。 |
| 選擇資料夾視窗加入在其中選的資料夾，對話在所有資料夾中開始 | 只在 Linux | **選擇資料夾…**（Choose folders…，假的 `zenity`）加入兩個資料夾；視窗開在最後一個資料夾裡，允許多選，標題是英文；新對話有這三個資料夾。 |
| 在沒有 UTF-8 locale 的伺服器上，以中文開啟選擇資料夾視窗 | 只在 Linux | 視窗標題是中文，並帶 `LC_CTYPE=C.UTF-8`；按取消不會加入任何資料夾。 |

## Harness Relay 自己的沙箱

[`sandbox.spec.ts`](specs/sandbox.spec.ts)：開源 agent 在完全存取以外執行時所在的沙箱（[各平台的作業系統沙箱](../docs/sandboxing.zh-TW.md#harness-relay-自己的沙箱)），以及沒有沙箱、或 CLI 會自己執行專案設定的地方 Harness Relay 怎麼做。開源 agent 的假 CLI 會真的寫檔、真的連到主機，所以它們不能做的事是由真正的沙箱拒絕，而不是假 CLI 自己。需要沙箱的測試只在沙箱能運作的地方執行（macOS，以及裝了 bubblewrap、socat 與 ripgrep 的 Linux），其他地方會跳過並說明原因；設定 `E2E_REQUIRE_RELAY_SANDBOX=1` 要求沙箱一定要能運作時（CI），則改為失敗。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 唯讀對話中，使用者允許的寫入仍然寫不進工作目錄 | Pi 以外的開源 agent 各一 | 在「想修改檔案」卡片按**允許**：假 CLI 寫檔，沙箱拒絕（資料夾在那裡是唯讀的），回答寫著「I may not write out.txt here.」；沒有檔案，也沒有變更卡片。Pi 在唯讀對話中沒有寫檔的工具。 |
| 這次執行不能連的主機會先詢問，拒絕後就不連 | 開源 agent 各一 | `e2e:fetch=http://e2e.example.invalid/`：沙箱的 proxy 在連線前先詢問（所以不需要能解析任何名稱），「想讀取網頁」卡片寫出主機，按**拒絕**後就不連。OpenHands 與 Pi 在編輯模式下詢問，那是它們有工具能連到網址的最低權限。 |
| 在這裡只能以完全存取執行的開源 agent，在完全存取以外不會執行，並說明原因 | 開源 agent 各一 | 在 Windows 上（五個都是）與 Linux 上（OpenCode）：回答的錯誤說它只能以完全存取執行，它的 CLI 也從沒收到 prompt。能在完全存取以外執行的地方跳過。 |
| OpenHands 在完全存取以外需要它的終端機開關 | OpenHands | 開關關掉時（`sandboxTerminal: false`），回答的錯誤說 OpenHands 在完全存取以外只能在沙箱裡有終端機時執行。只在 macOS：Linux 會給沙箱自己的終端機，Windows 則只以完全存取執行它。 |
| agy 啟動前會先詢問專案自己的設定，拒絕後就不會啟動 | Antigravity | 工作目錄裡有 `.agents/mcp_config.json` 時，「想使用工具」卡片寫出它；拒絕後回合不會開始（錯誤說明原因），agy 也從沒收到 prompt。在每個系統上都執行：Antigravity 沒有沙箱。 |
| Copilot 啟動前會先詢問專案的 hook，拒絕後就不會啟動，允許後這一輪就會執行 | Copilot | 工作目錄裡有 `.github/hooks/audit.json` 時，「想使用工具」卡片寫出它；拒絕後回合不會開始（錯誤說明原因），Copilot 也從沒收到 prompt；下一則訊息按**允許**後這一輪就會執行，假 CLI 也找到了它開啟 session 時會執行的 hook。在每個系統上都執行：不管沙箱（以及它的 `disableAllHooks`）如何，Copilot 都會自己執行專案的 hook。 |

## 除了 prompt 之外交給各 CLI 的東西

[`inputs.spec.ts`](specs/inputs.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 工具庫的 MCP 伺服器，其秘密不會出現在命令列上 | 各一 | 成員說出它拿到的伺服器，而秘密的值不在 CLI 啟動的任何參數裡。 |
| 工具庫的 HTTP MCP 伺服器，其秘密標頭不會出現在命令列上 | Antigravity 以外各一 | CLI 以 HTTP 伺服器的形式拿到它的網址、`Authorization` 標頭與它的值，而值不在 CLI 啟動的任何參數裡。Antigravity 的轉接器不給它 HTTP 伺服器，因為 agy 透過 ACP 表示它不接受。 |
| 附加的圖片 | Cline 以外各一 | 圖片附加在輸入框中，回答說收到一張圖片，prompt 也寫出檔案名稱，讓 agent 能用自己的工具讀取。Cline 透過 ACP 不接受圖片（它的模型只在 prompt 的文字裡拿到圖片的路徑）。 |

## 工具庫

[`tools.spec.ts`](specs/tools.spec.ts)：**設定 → App 與工具 → 工具庫**。工具庫是空的時候成員的「工具」怎麼說，只檢查一次；其他每個測試都跑兩次：一次在有登入的七個 CLI 各一位成員的對話中，一次在五個開源 agent 各一位成員的對話中（`open agents: …`）。對某個 CLI 關掉項目、或對某位成員打開或關掉項目的測試，用的是團隊的第二與第三位成員（Codex 與 Grok；Goose 與 Cline）。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 工具庫是空的、或沒有給它的 CLI 的項目時，每位成員的「工具」說明它自己的 CLI 會自己載入什麼 | Claude Code、Goose | 在**團隊設定**中，工具庫還在載入時，卡片對它什麼都不說（只有**工具**）；之後 Claude Code 的卡片說它也會載入自己的設定，Goose 的說它用的是 Harness Relay 自己的設定資料夾，各是自己 CLI 的文字（`emptyLibraryText()`），並附上前往工具庫的連結。工具庫只有給 Codex 的記憶時，兩張卡片都不說工具庫是空的，而是說還沒有給這個 CLI 的項目（`noneForCliText()`）。 |
| 在頁面上新增的 MCP 伺服器會交給每個 CLI，其秘密遮蔽顯示，也不在命令列上 | 兩個團隊 | 列上顯示給所有成員；編輯時值是空的，提示文字是遮蔽後的值；頁面與 `GET /api/tools` 都沒有秘密；每位成員都說出這個伺服器並拿到它的值，而值不在任何參數裡；回合結束後 Claude Code 的 `--mcp-config` 檔已經刪除。 |
| 對某個 CLI 或在成員的工具中關掉的 MCP 伺服器不會給出去 | 兩個團隊 | 在「預設提供給」中關掉第二個 CLI（Codex；Goose），它就拿不到；在它的成員的**工具**中勾選、在第三位（Grok；Cline）的取消勾選後，第二位拿到它（保留存下的值），第三位則沒有。第二位成員的**工具**在項目上方說明它自己的 CLI 會自己載入什麼（`toolsHintText()`）。 |
| 從資料夾挑選的 skill 出現在每個 CLI 的簡報中，每個 CLI 都讀了它的 SKILL.md | 兩個團隊 | 有兩個 skill 的資料夾中，加入的那個列在每份簡報中，每個 CLI 都讀出它的第一行；另一個從沒出現。Claude Code 只能透過轉接器加上的 `Read(…)` 規則讀取它（沒有這條規則時假 CLI 會拒絕）。 |
| 對某個 CLI 或在成員的工具中關掉的 skill 不會給出去 | 兩個團隊 | 對第三個 CLI（Grok；Cline）關掉、在第一位（Claude；OpenCode）的**工具**中取消勾選後，兩者都拿不到，Claude Code 的參數裡也沒有它。 |
| 給所有成員與給某個 CLI 的記憶會進入各自的簡報，成員的工具可以不帶 | 兩個團隊 | 第二個 CLI（Codex；Goose）依序拿到共享記憶與它自己的筆記，其他人只有共享記憶；在第三位（Grok；Cline）的**工具**中取消勾選**共享記憶**後，它一則都沒有。 |
| 在頁面上給 MCP 伺服器新的值，下一回合就拿到它；移除後不再給出去 | 兩個團隊 | 修改後頁面顯示新的遮蔽值，每個 CLI 的下一回合只拿到新的值，而且不在任何參數裡；移除後下一回合既沒有它的名稱也沒有它的值。另一個伺服器全程保留，所以「什麼都沒給」不會因為某個回合完全沒拿到工具庫而通過。 |
| 在頁面上移除的 skill 與記憶筆記不再給出去 | 兩個團隊 | 移除兩個 skill 之一與共享記憶後，下一份簡報與回答都沒有它們，另一個 skill 與每個 CLI 自己的筆記仍然送到。 |
| 成員透過 MCP gateway 使用 Harness Relay 自己的工具，它寄出的郵件會在待送出匣等到使用者按送出 | Claude Code | 用 API 設定一個郵件帳號（SMTP 是這台電腦上的替身，因為是本機伺服器所以可以不加密），並把 **郵件** 給 Claude Code；假 CLI 啟動它拿到的 `relay` MCP server（伺服器寫出的真程式），呼叫 `mail_send`（`e2e:mcp`）：回覆說郵件還沒寄出，正在待送出匣等待；回覆中的卡片顯示收件人與內文、**等你決定**（Waiting for you），對話標為 **等你核准**（Needs you）；SMTP 伺服器沒有收到任何東西。按 **送出**（Send）只寄一次（卡片顯示 **已送出**（Sent），對話中有說明，替身收到寄給收件人、帶著主旨的郵件）。第二封郵件按 **捨棄**（Discard）：卡片顯示 **已捨棄**（Discarded），不再有送出按鈕，對話中有說明，伺服器沒有再收到任何東西。 |
| 在設定中指定要啟動的瀏覽器：沒有檔案的路徑會被拒絕並說明原因，是檔案的會保存並使用，清空後重新自己找 | — | 工具庫的五列一開始都收合，MCP 伺服器那一列有螢幕閱讀器可讀的說明。在**常用 App** 用 Enter 展開**瀏覽器**。**選擇助理以啟用工具**正在儲存選擇時，會暫停其他助理的按鈕。只開放給 Codex 的設定在重新整理後保留。**要啟動的瀏覽器**會拒絕不存在的路徑，允許使用測試自己的 Node.js 執行檔，重新整理仍顯示儲存的路徑。清空後，標題就不再顯示路徑。 |
| 完全存取時，開源 agent（OpenCode）也能使用 Harness Relay 自己的工具，它的郵件在待送出匣等待 | OpenCode | 完全存取時，透過 API 設定一個郵件帳號（這裡不會真的連線），並把**郵件**給 OpenCode：假 OpenCode 照它 session 拿到的 MCP server（ACP 的 `mcpServers`）連到 gateway 的本機 HTTP 端點，header 中帶著這一回合的權杖，並呼叫 `mail_send`，回覆說郵件在待送出匣等待，卡片寫出收件人並等使用者處理。完全存取以下 Goose、Cline、OpenHands 與 Pi 拿不到這些工具（單元測試 `test/orchestrator-gateway.test.ts`）。 |
| 完全存取以下，在 Harness Relay 自己的沙箱中，OpenCode 連到 gateway 的本機連接埠（只對它開放），它對工具的詢問由 Harness Relay 代為回答，它的郵件在待送出匣等待 | OpenCode | 在唯讀模式下做同樣的事，經過 Harness Relay 自己的沙箱，沙箱只對 OpenCode 開放 gateway 的連接埠（`connectPorts`）；OpenCode 會用它的名稱（`relay_mail_send`）詢問這次 MCP 呼叫，由 Harness Relay 代為回答：沒有卡片。只在 OpenCode 能在完全存取以下執行的地方：macOS。 |
| 完全存取以下，Codex 透過本機 HTTP 使用 Harness Relay 自己的工具，不啟動任何程式，它的郵件在待送出匣等待 | Codex | 在可編輯模式下，把**郵件**給 Codex：假 Codex 在 thread 設定中拿到 gateway，是 `127.0.0.1` 上的 HTTP server，這一回合的權杖放在 `http_headers`；它像 Codex 一樣詢問 `relay:mail_send`（由 Harness Relay 代為回答：沒有卡片），再連過去呼叫，回覆說郵件在待送出匣等待，並有它的卡片。權杖不在 Codex 啟動時的任何參數中。 |
| 完全存取以下，Copilot 透過本機 HTTP 使用 Harness Relay 自己的工具，權杖只在 header 裡，它的郵件在待送出匣等待 | Copilot | 在可編輯模式下，把**郵件**給 Copilot：假 Copilot（和真的一樣只接受 HTTP 與 SSE 的 MCP server）在 `session/new` 拿到 gateway，是 `127.0.0.1` 上的 HTTP server，這一回合的權杖放在 `Authorization` header；它在那裡呼叫 `mail_send`，沒有卡片：回覆說郵件在待送出匣等待，並附上它的卡片。啟動 Copilot 的參數中都沒有這個權杖。 |
| 完全存取以下，CLI 自己對 Harness Relay 工具的詢問由 Harness Relay 代為回答，gateway 則對 act 呼叫說明它會做什麼並詢問 | Claude Code | 在可編輯模式下，這台電腦上有一個行事曆（收下放進來的活動的替身），並把 **行事曆** 給 Claude Code，假 CLI 呼叫 `calendar_create`：它自己對 `mcp__relay__calendar_create` 的詢問沒有卡片；gateway 的卡片（"wants to use a tool relay:calendar_create"）寫出要加的活動、時間與加進哪個行事曆，按 **允許**（Allow）之前什麼都不會加入；允許後替身收到活動，回覆說已經加入。 |

## 密鑰與固定指令

[`handoffs.spec.ts`](specs/handoffs.spec.ts)：只有使用者能交給 agent 的東西，以及 Harness Relay 帶著它執行的腳本。Claude Code 的 fake 在回覆最後加上 `<secret>` 區塊（`e2e:secret`）、提議 `e2e-check` 的 `<command>` 區塊，它會印出自己的密鑰檔和讀到的輸入（`e2e:command`），或是帶一行輸入、執行它一次的 `<command-run>` 區塊（`e2e:commandrun`）；`e2e:publishes` 把指令標成執行時會發布東西，`e2e:propose=command` 在回覆最後加上每小時只執行 `e2e-check` 的 `<schedule>` 區塊。

| 情境 | CLI | 檢查什麼 |
| --- | --- | --- |
| 回覆要的密鑰在卡片上提供，之後不再顯示，並在設定頁依名稱列出 | Claude Code | 回覆裡沒有 `<secret` 標籤，而是一張 **Secrets @Claude asks for** 卡片，列出 `E2E_TOKEN` 和 agent 的理由，以及 agent 指出的網頁（`e2e:secreturl`），在 **Where to get it (open it in your own browser):** 之下以連結顯示，會在新分頁開啟；按 **Show** 之前輸入框都是密碼欄位；**Save** 後標成 **Saved**，並把「I gave E2E_TOKEN…」當作使用者的回答送出；值不在頁面上，也不在伺服器送出的對話裡，`GET /api/handoffs` 只列出名稱，**設定 → 密鑰與固定指令**也列出它，按 **Remove** 就刪除。 |
| 提議的固定指令儲存、帶著輸入試跑且密鑰已遮蔽、分享結果，並從待送出匣執行一次 | Claude Code | 提供密鑰後，**Fixed command "e2e-check"** 卡片顯示 **No network**；按 **Show the code it runs** 一個檔案一列地列出程式碼（資料夾的 `helper.py` 以目前的內容、預設打開）；程式碼打開時 `helper.py` 改了，**Save** 被拒絕（*Its code changed after it was read*），內容換成現在的樣子；再按 **Hide the code**，然後在程式碼收起時按 **Save**（鎖定當時的程式碼；卡片接著提供 **Tell the team it is saved**），**Input for this run** 一開始是 agent 建議的內容（`hello from the agent`），改打一行後再按 **Try it**：在 Harness Relay 自己的沙箱裡執行，結束時是 **Done**，輸出顯示 `E2E_TOKEN=••••` 而不是值，也顯示它從標準輸入讀到的那一行；卡片這時只提供 **Send the result to the team**，按下就把那段輸出送出；之後回覆裡的待送出匣卡片 **Run the fixed command "e2e-check" once** 顯示它的輸入，按 **Send** 就執行（*done (exit code 0)*），聊天裡的說明是 *Ran the fixed command "e2e-check" once: done (exit code 0).*，附上輸出，密鑰已遮蔽；`helper.py` 再改一次，裡面有一行 `### other.py (as it is now)`，**Try it** 顯示 *Its code changed*，**Show the changes** 一個檔案一列地列出 `helper.py`，那一行在它裡面（沒有 `other.py` 這一列），按 **Approve the changes** 不會執行（卡片不再顯示 *Its code changed*），再按 **Try it** 結束時是 **Done**；`helper.py` 又改一次，再把一次執行放進待送出匣（*Post again*）：它的卡片說程式碼在儲存或核准之後改過了，並列出 `helper.py`，按 **Send** 被拒絕（*look at the changes on this card and approve them*），項目仍是 **Waiting for you**，**Show the changes** 顯示新的那一行，**Approve the changes** 之後警告消失，再按 **Send** 就執行（*done (exit code 0)*）。Harness Relay 自己的沙箱不能執行的地方（Windows）會略過。 |
| 執行時會發布東西的指令試跑前先確認，和它一起提議的自動任務在它儲存後只執行它、不必按送出 | Claude Code | 同一則回覆提議指令（`e2e:command e2e:publishes`）和只執行它的 **Proposed automation**（`e2e:propose=command`）：自動任務卡片指名 `e2e-check`，*runs alone each time, never the team*，並說它還沒儲存；指令卡片說它會發布、貼文或寄出東西，按 **Save** 後自動任務卡片會再讀一次指令（不再顯示還沒儲存），並提醒建立後到時間就會直接執行、不再詢問，而且會發布；按 **Try it** 會先詢問（*Trying it really publishes, posts or sends*），**Cancel** 不執行，**Yes, try it once** 才執行（**Done**）；按 **Create automation** 後顯示 **Automation created**，對話的排程保存指令的 id 和 `commandOnly`；之後資料夾裡多了一個腳本，**Run now** 不會執行它，聊天的說明會這樣寫，並列出檔案、**Show the changes** 和 **Approve the changes**，核准後顯示 *Approved: it runs at its next time*。Harness Relay 自己的沙箱不能執行的地方（Windows）會略過。 |
| 執行中的指令顯示何時會停止和目前為止的輸出（收起來，點開才展開），卡片上的 Stop 能結束它，以 0 結束的執行被擋下的主機會寫出來 | Claude Code | 指令儲存後，在 **Added for this run** 填 `&& sleep 120`，讓它印完之後繼續執行；按 **Try it**：卡片的結果顯示 **Running** 和 *If it is still running at …*，**Try it** 不見了，收起來的 **Output so far (N lines, secrets masked)** 點開前什麼都不顯示，點開後是 `E2E_TOKEN=••••` 和它讀到的那一行，從不顯示值；這段期間聊天也提供自己的 **Stop**，而且什麼都不送（placeholder 寫著 *Send once the fixed command ends, or Stop it*，**Send** 停用，按 Enter 草稿還在，這時輸入框下面那一行會說明原因，沒有錯誤），卡片也不提供 **Tell the team it is saved**；卡片上的 **Stop** 結束它（**Stopped**，不是 *Could not run*，保留輸出，不再有收起來的輸出），**Try it** 回來了，聊天的 **Stop** 也不見了，草稿還在，可以送出；再試跑一次，聊天的 **Stop** 一出現就按（可能在沙箱啟動指令之前），結果一樣是 **Stopped**，不會是沙箱的失敗；再用 `; curl … https://refused.example.com/ ; true` 試跑一次，結果是 **Done**（結束碼 0），卡片寫著 *The sandbox refused the hosts it tried to reach: refused.example.com*（沙箱的 proxy 擋下它：沒有任何東西離開這台電腦）。Harness Relay 自己的沙箱不能執行的地方（Windows）會略過。 |

## 長期記憶

[`memory.spec.ts`](specs/memory.spec.ts)：成員跨對話保留的記憶，這是**設定 → 實驗室**裡的實驗功能，要使用者開啟才會使用（用到它的測試會先透過 API 開啟）。假 CLI 用 `e2e:remember` 把使用者說的話記成一則記憶（回覆最後的 `<remember>` 區塊），用 `e2e:recall` 說出這個回合拿到哪些記憶（簡報 `<memory_notes>` 裡的與 prompt `<recalled_memory>` 裡的）。假首席 agent 整理時，會釘選第一則還沒釘選、由 agent 寫的記憶（`fake-cli/lib/plan.cjs` 的 `tidyReply`）。

| 情境 | CLI | 檢查內容 |
| --- | --- | --- |
| 每個 CLI 記下的記憶從回覆文字中取出成卡片，之後對話的成員會拿到它 | 兩組團隊 | 每位成員的回覆有使用者說的話、沒有 `<remember>` 標籤，並有一張顯示這則記憶與**使用中**的**長期記憶**卡片；這則記憶只保留一則，記為使用者說的（`basis: user`），由 agent 寫下；在新對話中，相關的問題（`Which script do I deploy with?`）讓每位成員在它的回合拿到這則記憶。 |
| 從卡片擱置再還原一則記憶、在設定中釘選，並由首席 agent 整理 | Claude Code | 先透過 API 加入一則使用者的記憶；卡片的**擱置**與**還原**會改變它顯示的狀態；**設定 → 實驗室 → 長期記憶**顯示每則記憶怎麼知道的與作者；在使用者的記憶按**釘選**後變成**取消釘選**；**立即整理**顯示假首席 agent 的摘要，以及它釘選了 agent 的記憶（檢視中：一則由使用者釘選、一則由首席 agent 釘選、一項變更）；之後新對話的回合不論問什麼，都拿到這兩則釘選的記憶。 |
| 在實驗室開啟之前都是關閉的：不記下記憶、沒有卡片，實驗室只顯示開關 | Claude Code | 記憶維持一開始的關閉狀態，假 CLI 沒有拿到任何記憶，回覆沒有卡片；寫了一則記憶的回覆（`e2e:remember`）也沒有卡片，什麼都沒保留。工具庫沒有**長期記憶**類別；在**設定 → 實驗室**中，**長期記憶**顯示關閉的開關，沒有**新增記憶**和**立即整理**；開啟後才顯示它們，重新載入後仍是開啟。 |

## 草稿中可用的 App

[`draft-apps.spec.ts`](specs/draft-apps.spec.ts)

| 情境 | 檢查的內容 |
| --- | --- |
| 登入後在背景檢查 | 首頁先檢查四組狀態，新對話與新自動任務共用結果。慢速的 Teams 請求只送一次，且不會讀取 Slack 個人檔案。 |
| 切換至曾經無法使用的權限（兩種情境） | 分別經過 1 秒和 61 秒後切換權限。重新檢查期間會保留草稿的選擇，新結果確認授權後即可使用。 |
| 在新對話選取可用的 App | 確認可用前無法勾選。遠端檢查較慢或失敗時，已確認的本機項目仍可選取。重新檢查、重開選單、返回視窗或更改檔案權限會更新可用狀態。 |
| 建立自動任務前再次檢查 | 從設定返回會移除已失去權限的選項。若剩下的 App 在建立前也失去連線，訊息和附件仍保留在草稿中，系統不會建立任務。 |
| 主動確認 Slack 連線 | 展開或返回草稿不會查詢個人檔案。按下確認後可選擇 Slack。送出前若失去連線，系統會保留草稿。 |
| 保留已選取但驗證已過期的 Slack | 返回新自動任務時會保留已選的 Slack，送出時再次確認；僅在確認成功後才建立自動任務。 |
| Obsidian 實際可用狀態 | 新增測試 Vault 並授權已登入的測試助理後可以勾選。移除 Vault 後，選項再次停用並取消勾選。 |

## App 設定與確認

[`app-confirmation.spec.ts`](specs/app-confirmation.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 在完全存取對話中於所選的 Obsidian 筆記庫建立或編輯筆記 | Claude Code | 兩個筆記庫有同名筆記時，預覽會顯示所選筆記庫的完整路徑，只有所選的筆記會變更。若在確認前解除該筆記庫的連結，就無法儲存待確認的修改。每項提案都會在聊天中等候確認。**捨棄**會取消提案，**建立筆記**與**儲存變更**會將預覽的 Markdown 寫入筆記庫。預覽後在磁碟上變動過的筆記會保留較新的內容。 |
| 編輯舊的 Gmail 密碼信箱 | — | 改用 OAuth 登入前已儲存的信箱仍能編輯，不需重新輸入已儲存的密碼。 |
| 暫停與恢復 Google 存取 | Claude Code | Drive 已連結時，停用 Google 前會列出受影響服務並要求確認。取消後連線仍有效。確認並重新整理後，Google 維持停用、Outlook 仍可使用，再啟用 Google 會沿用原用戶端與帳號授權。 |
| 連結 Google Drive 並開啟文件編輯 | Claude Code | Drive 預設為唯讀。卡片說明如何授權該帳號編輯，以及每次變更前都會預覽並確認。「新增另一個 Google 帳號」獨立顯示。授權編輯後會更新原帳號。在共用 OAuth 設定解除整個帳號的連結後，兩項授權一併移除。 |
| 從兩個已連結的帳號移除其中一個帳號的 Drive | Claude Code | 取消會保留存取權。確認後，該帳號的檔案存取與文件編輯會移除，Gmail、行事曆及另一個帳號的 Drive 仍可使用。重新連結只會恢復這次要求的權限。 |
| 移除最後一個只有編輯權限的 Drive 帳號 | — | Drive 回到預設唯讀的設定畫面。OAuth 設定保留 Google 登入，並顯示未連結任何服務。在該處解除整個帳號的連結後，才會撤銷儲存的憑證。 |
| 在完全存取對話中建立及編輯 Google 文件 | Claude Code | 使用本機 Google OAuth 與 Docs 替身，驗證另外授予的文件編輯權限。建立文件或替換唯一符合的原文前，都要核對帳號、目標與文字並確認。捨棄不會寫入，重新整理後仍可檢閱待建立的文件；即使標題含另一份文件的網址，儲存結果仍連到實際建立的文件。文件版本變更後則無法套用舊提案。 |
| 在完全存取對話中傳送 Slack 訊息 | Claude Code | 工作區權杖啟用發文後，才會在**從 Relay 傳送訊息**中顯示助理選擇。開放 Claude Code 使用這項工具後，它的代管 Slack 連線仍可維持未設定。預覽顯示傳送者、目的地與純文字訊息。**捨棄**會取消提案，第二則草稿在重新整理後仍保留，按**送出**才會依預覽內容發送一次。 |
| 桌面與手機上的常用 App 與設定表單 | — | 檢查 Google Drive、郵件與行事曆控制項的字型及間距、服務按鈕在桌面與手機寬度下是否貼合單行標籤、**其他（CalDAV）**表單中 iCloud 預設的密碼說明，以及 OpenHands 執行檔標籤在 1280、390 與 320 像素寬度下的位置。 |
| 選擇行事曆服務並連結 Apple 行事曆 | — | 檢查四個服務選項、Google 設定按鈕及 CalDAV 表單。選 Apple 後只會開啟 Apple 的設定。表單要求 Apple 帳號電子郵件和 App 專用密碼，並提供 Apple 帳號網站連結。尋找行事曆時會使用 iCloud 伺服器，變更憑證後會捨棄舊的查詢結果。已加入的行事曆無法重複選擇；同名的其他行事曆以帳號電子郵件和必要的編號區分。選取行事曆後才能按**儲存**，只儲存選取的行事曆，回應中也不會出現密碼。再次開啟時會清空表單，儲存或取消後鍵盤焦點會回到 **iCloud 行事曆**。 |
| 區分 Gmail 登入與手動信箱，並儲存 iCloud 郵件 | — | 選取 Gmail 後會顯示 Google OAuth 登入按鈕與相關說明。手動新增信箱使用其他服務的預設值。iCloud 郵件接受地址與 App 專用密碼，儲存時使用預設的 IMAP 與 SMTP 主機，回應中不含密碼。鍵盤焦點回到服務按鈕。Fastmail 和 Yahoo Mail 的預設值互相切換時會清空之前的密碼。 |
| 從常用 App 登出 GitHub | — | 確認視窗顯示共用的 GitHub CLI 帳號，並說明登出會影響哪些其他應用程式。取消會保留登入；確認後會登出，重新整理後仍能再次登入。 |

## 聊天中的 App 存取權

[`app-lifecycle.spec.ts`](specs/app-lifecycle.spec.ts) 以 Claude Code 假 CLI 透過 Relay 呼叫實際工具。每個案例都在設定中連結服務、開放給助理，再核對工具回傳的資料。關閉存取後，在同一聊天再詢問一次，確認助理已無法使用工具。

| 服務 | 助理讀取的內容 |
| --- | --- |
| 郵件 | 在**其他信箱**設定的本機 IMAP 信箱中的郵件內文。 |
| 行事曆 | 在**其他（CalDAV）**設定的行事曆中的一場會議。 |
| 瀏覽器 | 使用在設定中選取的 Chromium，讀取本機網頁的文字。 |
| GitHub | 完成本機 GitHub CLI 登入後，讀取測試 repository 的一筆 pull request。 |
| Obsidian | 在設定中選取的筆記庫中的 Markdown 筆記。 |
| Notion | 在瀏覽器同意 OAuth 授權後，從本機 MCP 伺服器讀取搜尋結果。在伺服器預設名單移除 Claude 後，無法再次呼叫已授權的工具。 |
| Heptabase | 在瀏覽器同意 OAuth 授權後，從本機 MCP 伺服器搜尋卡片。在伺服器預設名單移除 Claude 後，無法再次呼叫已授權的工具。 |

[Google 文件與 Slack 的確認案例](#app-設定與確認)也會在確認寫入後關閉工具，再讓助理嘗試一次，並核對文件內容或已送出的訊息筆數仍維持原值。

## 接手瀏覽器

[`handover.spec.ts`](specs/handover.spec.ts) 讓 Claude Code 的假 CLI 用 `browser_hand_over`（`e2e:mcp`）把對話的瀏覽器（系統的 Chromium，否則是 Playwright 的；在 Windows 上用 Playwright 的，和[聊天中的 App 存取權](#聊天中的-app-存取權)的瀏覽器測試一樣，因為系統的 Chrome 或 Edge 在測試伺服器自己的家目錄下啟動不了，那裡沒有 AppData 資料夾）交給使用者，網頁是測試自己的登入頁：上半部是一個欄位、下半部是一個按鈕，它會記下送出的內容。在完全存取中執行，所以不會詢問主機。

| 情境 | 檢查的內容 |
| --- | --- |
| 用滑鼠與按鍵透過畫面串流登入，附上給助理的話交回 | 卡片（agent 的原因、網頁、使用者登入的帳號會留在對話的瀏覽器中）、側邊欄的**需要你**；**在這裡顯示** 開啟面板，網址就是那個網頁；在畫面上點一下讓欄位取得焦點，在打字框打的按鍵和輸入法的文字會送到欄位，點按鈕送出（網頁的伺服器收到 `someone注音`），網址也跟著變；**先隱藏**、在卡片上寫給助理的話、**完成，交回給 agent**；回覆只說使用者交回了，附上那句話，絕不包含打的字；卡片顯示**已交回（在聊天中）**。 |
| 婉拒 | 附上一句話按**不用了**：agent 會聽到，卡片顯示**已婉拒**，沒有送出任何東西。 |
| 從視窗交回 | 設定 `RELAY_HEADLESS_WINDOWS=on`（代替能顯示視窗的電腦，視窗以無頭模式開啟）時，卡片說明視窗會開在哪裡，按 **Open in a window** 不會開面板：卡片說明瀏覽器開在那裡的視窗中；按 **Done: hand it back** 後，agent 拿回在沒有視窗的瀏覽器中重新開啟的網頁，卡片顯示 **Handed back (in a window)**。 |
| 在手機上，中文介面 | 390 像素寬、繁體中文的觸控螢幕：面板佔滿螢幕，在畫面上點一下就是點擊，在打字框打的字會送到網頁，**完成，交回給 agent** 交回。 |

交接的視窗在這裡只以無頭模式開啟（`RELAY_HEADLESS_WINDOWS`），所以沒有人在裡面點擊：它的啟動、環境變數與交接的票在 `test/handover.test.ts`，用真的 Chromium 測試畫面串流與視窗（無頭模式）則在 `test/browser.test.ts`。

## 用 OAuth 登入的帳號

[`oauth.spec.ts`](specs/oauth.spec.ts)：在**設定 → App 與工具 → 常用 App** 選**郵件 → Outlook** 或**行事曆 → Outlook**，對這台電腦上 Microsoft 登入頁面與 Graph 的替身，以及只接受替身給的 Exchange Online 權杖、以 XOAUTH2 登入的 Exchange Online IMAP 與 SMTP 替身測試，測試的伺服器指向它們（`RELAY_MICROSOFT_LOGIN_URL`、`RELAY_MICROSOFT_GRAPH_URL`、`RELAY_MICROSOFT_IMAP`、`RELAY_MICROSOFT_SMTP`）。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 帳號在新分頁用 Microsoft 登入，回到 web app 自己的回呼頁面，它的行事曆加入行事曆工具 | — | 選 **Outlook** 可查看該服務的設定。還沒有註冊 app 時，按**設定 Microsoft 登入**會開啟共用的**帳號登入設定（OAuth 2.0）**，顯示要允許的重新導向網址（`http://127.0.0.1/oauth/callback`），並填入用戶端 ID。**用 … 登入**（Sign in with …）在新分頁打開替身的頁面，「設定」顯示正在等待；它的 **Allow** 把那個分頁帶到 `/oauth/callback`，頁面顯示 **已登入 …**（Signed in as …），並把授權碼與 state 從網址拿掉；替身只看到一次用 PKCE 驗證碼交換授權碼。接著「設定」顯示帳號 **已連線**（Connected），它自己的行事曆出現在行事曆清單中，沒有 **編輯**（Edit）；**管理行事曆**會將預設行事曆標為**已加入**。加入另一個後再全部移除，仍可在同一帳號按**選擇行事曆**重新加入。然後替身拒絕這個帳號的權杖與它的更新（`invalid_grant`，就像在 Microsoft 撤銷了登入）：它的行事曆的 **測試**（Test）說登入已經失效，帳號接著顯示 **需要重新登入**（Needs a new sign-in）與原因，以及 **重新登入**（Sign in again）。**重新登入** 再次打開替身的頁面，它的 **Allow** 讓帳號重新連線（第二次交換）；再被拒絕一次後，重新打開的**管理行事曆**說登入已經失效，帳號不用 **測試** 就又顯示 **需要重新登入**。在**帳號登入設定（OAuth 2.0）**的 **Microsoft** 區塊按**解除帳號連結**，會先列出受影響的服務。同一註冊的另一個帳號與手動行事曆會保留。確認後會說明要到 Microsoft 哪裡移除 app 的存取權，並移除帳號與它的行事曆。 |
| 相同電子郵件地址的 Google 與 Microsoft 帳號可各自解除連結 | — | 兩個服務提供者分別列出該地址及其授權用途。在 Microsoft 下按「解除帳號連結」只會列出 Outlook 行事曆與舊版 Teams 存取權。取消會保留帳號，確認後 Google 的 Gmail、Drive 和文件授權仍可使用。 |
| 為郵件用 Microsoft 登入的帳號加入它的郵件帳號，它的「測試」以 XOAUTH2 登入它的 IMAP 與 SMTP 伺服器 | — | 在**郵件 → Outlook** 按**用 … 登入** 與替身的 **Allow** 只為郵件登入帳號（交換一次授權碼）。**郵件**會列出這個帳號。它的郵件帳號 `Outlook · ming@contoso.com` 加入郵件帳號，用替身伺服器（`127.0.0.1`），沒有 **編輯**，也沒有加入行事曆。它的 **測試** 顯示 **Connected: the sign-in works.**，替身看到 IMAP 與 SMTP 以這個帳號進行的 XOAUTH2 登入，各用一個 Exchange Online 的權杖（不是 Graph 的）。只從郵件帳號移除它（確認）後，帳號的 **加入信箱**（Add mailbox）不必重新登入就再加入它，之後這個按鈕就不見了。從行事曆登入並選取相同的 Microsoft 帳號後，原有的郵件帳號會新增行事曆用途，Teams 權限維持關閉。等候授權時無法從郵件再開始登入。回呼頁面連回常用 App，同一帳號具有兩種用途。移除信箱後，如果共用的登入失效，收合的郵件列會顯示**需要重新登入**。從郵件重新登入可恢復兩項授權，再按**加入信箱**即可加回信箱。在共用 OAuth 設定的 **Microsoft** 區塊解除該帳號連結前會列出兩種用途，確認後才移除信箱與行事曆。 |
| 較早的回應延遲時依舊正確移除資源 | — | 同帳號第一個行事曆的刪除回應延遲，不會讓已刪除的第二個行事曆重現。來自行事曆的較早清單回應也不會讓已移除的信箱重現。兩個服務中都仍可從該帳號加回資源。 |
| 找到常用 App 的連線方式 | — | 十個服務中，郵件與行事曆排在最前面。Teams 可直接登入 Microsoft，Slack 提供可用鍵盤操作的 Claude、Codex 連線。Drive 提供 Google OAuth 與獨立的 Google 文件編輯授權。 |
| 三個服務共用 Google 桌面用戶端 | — | Gmail、行事曆與 Drive 會開啟同一份用戶端表單。儲存後三者皆可登入，各服務向 Google 要求授權時都使用已儲存的用戶端 ID 與該服務的權限範圍。已設定的 Gmail 與 Google Calendar 各只顯示一個登入按鈕。 |
| 重試失敗的儲存並保留較新的草稿 | — | 儲存失敗可重試，較舊的請求完成時也不會覆寫另一個服務提供者較新的草稿。 |
| 從帳號登入設定開啟教學（英文、繁體中文） | — | 兩家服務的連結會在新分頁開啟 Relay 隨附的本機圖解。步驟和圖片可以讀取，手機與桌面上的圖片都保持原比例，並可點開原圖。編輯註冊資料時會顯示該服務的指南。 |
| OAuth 設定的桌面與手機版面 | — | 不同螢幕寬度下，說明、按鈕和表單控制項之間都有足夠間距。 |
| Google 用戶端缺少密碼時 | — | Google 登入、Drive 讀取與文件編輯按鈕停用，原因、設定捷徑和圖解仍可開啟。完成設定後即可授權。已設定的 Outlook 與手動信箱仍可使用。 |
| OAuth 設定無法載入時仍可手動設定帳號 | — | OAuth 設定請求失敗時，仍可在郵件的**其他信箱**表單儲存手動設定的 IMAP/SMTP 信箱，也可從行事曆的**其他（CalDAV）**開啟表單，儲存使用密碼的 CalDAV 網址。重新整理後，兩者仍在各自的服務列。 |
| 從常用 App 連結多個本機 Obsidian 筆記庫 | — | 若選取的資料夾中含有一般資料夾，整批都不會加入。兩個同名筆記庫會分別顯示完整路徑，重新整理後仍在。解除其中一個筆記庫的連結後，另一個筆記庫仍保持連結，磁碟上的筆記也會保留。 |

## 直接連結 Microsoft Teams

[`teams.spec.ts`](specs/teams.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 從 Teams 列安裝 PowerShell 7 | — | 缺少 PowerShell 時會出現安裝按鈕，準備期間重新整理仍可查看進度。本機測試套件雜湊值不符時會出現錯誤，重試後會驗證替換後的套件、解壓縮，確認 PowerShell 可啟動，再安裝 Graph 模組並開放登入。 |
| 修復無法載入的 Graph 模組 | — | Relay 沿用可正常載入的既有模組。系統模組無法載入時，Relay 在私有資料夾驗證替代模組並保留原檔。該私有副本日後損壞也可再修復。 |
| 透過 Graph 直接連線讀取、擬稿與送出 | Claude Code | 以本機 PowerShell 替身測試安裝 Graph 模組、用裝置代碼取得唯讀權限、選擇助理及查詢 Teams。經第二次裝置登入取得發送權限後，捨棄草稿不會發文，按送出才會傳送預覽的完整文字。解除連結後助理無法存取。 |

## 需要登入的 MCP 伺服器

[`mcp-oauth.spec.ts`](specs/mcp-oauth.spec.ts)：**設定 → App 與工具 → 工具庫 → MCP 伺服器**，HTTP 伺服器自己的登入（MCP 的授權），對這台電腦上的替身測試：一台回 401 並指出它受保護資源中繼資料的 MCP 伺服器，以及它的授權伺服器，發行者帶有路徑（RFC 8414 的中繼資料、註冊、有「Allow」連結的授權頁面（測試要求時放在它自己的另一個位址）、檢查 PKCE、重新導向網址與 `resource` 的權杖端點、只能用一秒的存取權杖、撤銷）。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 從整列連結 Notion 或 Heptabase | — | 按服務名稱或列內留白都會開啟授權頁。淺色與深色模式中，游標移到服務列上都會醒目顯示整列。等候登入時，仍可貼上網址、重開登入頁或取消。Notion 會讀出登入與登出結果，若使用者已移至其他 App，鍵盤焦點會留在該處。 |
| 工具庫的 MCP 伺服器在新分頁登入，回到 web app 的回呼頁面，成員這一回合在伺服器的標頭拿到它的權杖 | Claude Code | 伺服器透過 API 加入。它那一列的 **登入**（Sign in）在按下時就開一個新分頁，在授權伺服器註冊一個用戶端，用頁面自己的重新導向網址（`<origin>/oauth/callback`），再把分頁送到授權頁面，那一列則顯示在等它；按 **Allow** 把分頁送到 /oauth/callback，頁面說已登入這台 MCP 伺服器，並把授權碼與 state 從網址拿掉。那一列接著顯示 **已登入**（Signed in）與時間；交換授權碼時以伺服器的網址為資源。Claude Code 成員的一回合：假的 Claude Code 拿到的伺服器帶著 `Authorization: Bearer <最新的存取權杖>`（每個權杖請求都指名資源）。在授權伺服器撤銷登入後（更新被拒，`invalid_grant`），過一秒、它的權杖剩不到一半時：下一則回覆有這一回合沒給這台伺服器的說明（它的登入已經失效），假的 CLI 也沒拿到它。設定頁那一列顯示 **需要重新登入**（Needs a new sign-in）與原因；**重新登入**（Sign in again）用保留的用戶端再登入一次（不再註冊），被它取代的更新權杖也被撤銷。**登出**（Sign out，確認後）：那一列說已登出、標籤消失、**登入** 又出現，授權伺服器也收到這次撤銷。即使發行版缺少註冊設定，已連結的服務仍可從卡片登出。 |
| 登入頁面在另一台主機的工具庫 MCP 伺服器，會先說明在哪裡，按 **繼續** 才打開 | — | 授權伺服器的中繼資料把登入頁面放在和發行者不同的位址（另一個埠）。**登入** 不打開頁面（按下時開的分頁又關掉）：那一列顯示「你會在 <那台主機> 登入，它不是 <發行者的主機>。」以及 **取消** 和 **繼續**，還不等任何頁面。**取消** 讓它消失，什麼都沒登入。再按 **登入**，然後 **繼續**：頁面在那台主機的新分頁打開，按 **Allow** 讓伺服器登入（那一列顯示 **已登入**）；每次登入都註冊自己的用戶端，取消的那個不會保留。 |
| 連結及解除連結代管的 Slack 帳號 | Claude Code、Codex | Slack 的 Claude 與 Codex 連線各自有狀態。Codex 一開始回報可呼叫的 App。從供應商頁回來或按**重新檢查連線**，Codex 會透過 Slack 的唯讀個人資料工具驗證所選帳號，狀態回應不包含個人資料。只開啟頁面後取消不會授權。在供應商管理頁移除連線後，另一個供應商與 Relay 的授權仍保留。 |
| 管理既有的 Slack 共用連線 | — | 按 Slack 這一列的**管理**，可重新登入或登出既有連線。登出後，MCP 伺服器仍有返回常用 App 的連結。 |

## 修改對話的歷史

[`history.spec.ts`](specs/history.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 編輯訊息後重新送出：取代它之後的內容 | Claude Code | 編輯框警告重新送出會刪掉之後的內容；之後對話裡是修改過的訊息與一則新的回答。 |
| 對已完成的回答重試，成員再回答一次 | Grok | CLI 再次收到 prompt，對話裡仍然只有一則回答。 |
| 從某則回答分支出的對話自己繼續，原本的對話不變 | Codex | **分支對話**（Branch conversation）打開一個標明延續自哪裡的新對話；新的訊息不在原本的對話裡，側邊欄兩個都列出。 |

## 複製與分享

[`share.spec.ts`](specs/share.spec.ts)：分享透過使用者自己的 `gh`，這裡是假的那個。分享在 Harness Relay 的分享頁（`site/share/`）閱讀，以儲存庫裡的樣子放在網站的網址打開，GitHub 的原始檔與 API 由測試代替（`e2e/support/share.ts`）；分享頁自己的測試打開它們自己寫的 gist，不需要伺服器。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 回答的複製按鈕複製的是 Markdown，而不是畫面上的文字 | Codex | 剪貼簿裡是原始內容（標題、表格的直線、程式碼區塊的圍欄），按鈕顯示已複製。只在 Chromium。 |
| 分享對話框把整個對話，或到某則回答為止的部分，複製成 Markdown | Claude Code | 標題列的對話框複製整段對話；某則回答自己的**分享**只複製到它為止。只在 Chromium。 |
| 分享的對話是瀏覽器產生的頁面做成的 secret gist，在 Harness Relay 的網站上打開，在設定中列出直到移除 | Claude Code | `gh gist create --filename index.html …` 存下一個 secret gist，頁面有問題與回答，但沒有中間的步驟（思考、工具）；連結是 Harness Relay 的分享頁（`…/harness-relay/share/#relay-e2e/<id>`），旁邊是 gist 本身的連結。打開時（儲存庫的 `site/` 放在網站的網址、假 `gh` 的 gist 放在 GitHub 原始檔的網址，都由測試攔截，離線進行），分享頁只讀一次 gist 的原始 `index.html`，完全不呼叫 GitHub 的 API，說明這是誰的 gist 並附上它在 GitHub 上的連結，使用頁面的標題，並把回覆顯示在只允許彈出視窗的 sandbox 框架裡。**設定 → 分享**列出它，按**移除**會刪掉 gist（`gist delete <id> --yes`）；之後它的連結會在問過一次 GitHub 的 API 它是否在別處（這裡被拒絕）後，說 GitHub 上沒有這個對話。 |
| gh 未登入時，分享會說明如何登入，什麼都不分享 | Grok | `E2E_FAKE_SIGNED_OUT=gh`：說明中寫著 `gh auth login`，可以再按一次**建立連結**，也沒有存下任何東西。 |
| gh 未登入時，對話框用 GitHub 的代碼登入它，再建立連結 | Grok | **登入 GitHub** 在伺服器上執行 `gh auth login --web --hostname github.com`；對話框顯示 GitHub 的代碼和它的裝置頁面（終端機的指令仍保留，作為另一種方法）；測試核准之後（假 `gh` 的 `fake-github/approve`），gh 就登入了，對話框會自己建立連結。 |
| 從對話框開始的登入可以取消，也能再開始 | Grok | **取消**會停止 gh 的登入（對話框顯示已取消，代碼消失），什麼都沒分享，**登入 GitHub** 會開始新的登入並顯示它的代碼。 |
| 被 GitHub 拒絕的登入會說明，附上 gh 的訊息，也能再試 | Grok | 被拒絕（假 `gh` 的 `fake-github/deny`）：顯示登入失敗與 gh 自己的錯誤，什麼都沒分享，**登入 GitHub** 又出現。 |
| 對話框再次打開時接手仍在等待的登入，一次失敗的詢問也保留它的代碼 | Grok | 在 gh 等待時關掉再打開對話框、再按**建立連結**：顯示同一組代碼，不會開始新的登入（只有一次 `auth login`）；中斷一次詢問，代碼仍留在畫面上；核准後，接手的登入只建立一個連結。 |
| gh 未登入時，在設定移除分享會在那裡登入，再移除 | Grok | 先透過對話框的登入建立一個分享，再讓 gh 登出（刪掉假 gh 的 `signed-in`）：在設定按**移除**會顯示同樣的說明，在那裡登入（說明接著只寫已登入 GitHub。與接下來怎麼做，卡片上也不再說 gh 沒有登入），下一次就移除成功（移除會先詢問，所以不會自己重做）。 |
| 網路很慢時，登入後仍只建立一個連結，而且只建立一次 | Grok | 每次詢問登入狀態都要 2.5 秒（比兩次詢問的間隔一秒還久）：核准後對話框只建立一個連結，還在路上的回應不會再建立第二個。 |
| 沒有 gh 時，分享會說明如何安裝並登入 | Claude Code | 無法啟動的 `gh` 得到含安裝指令與重新啟動提醒的說明。Windows 上跳過，因為那裡不能用 `#!` 行代替不存在的程式。 |
| 分享頁：一起附上的檔案在新分頁下載 | — | 一個 gist 頁面（由測試寫入，沒有伺服器）連到第二個 gist 裡不是文字的檔案，GitHub 會以下載提供：在分享頁的框架裡點它會完整下載（框架的 `allow-downloads`）。不在 WebKit 執行，Playwright 下的 WebKit 不會下載連結打開的任何東西。 |
| 分享頁：gist 的頁面不執行、不載入任何東西，也不能把頁面導到別處 | — | 一個惡意的 gist 頁面：它的腳本和圖片的 `onerror` 什麼都加不進去，別處的圖片與重新整理都連不到；它指向最上層、帶 `rel="opener"` 與沒有 target 的連結，都在新分頁打開，新分頁的頁面拿不到 `opener`（所以不能把分享頁的分頁導走），表單也送不出去；分享頁的網址保持不變。 |
| 分享頁用頁面或瀏覽器的語言說明它不能顯示的情況 | — | 中文頁面的上方列也是中文，並使用它的標題；`#` 後面換成另一個 gist（不重新載入）、而它沒說是 Harness Relay 做的，就不顯示，也不用它的標題；沒有指向 gist 的網址不會問 GitHub，並有回首頁的連結；GitHub 回 503 時會說明，也不問它的 API。 |
| 擁有者改了名稱或連結沒寫擁有者時，分享頁透過 GitHub 的 API 找到 gist | — | 原始檔在舊名稱底下回 404：問一次（替身）API，它指出新名稱底下的原始檔，上方列寫出新的擁有者；只有 id 的連結先問 API；在現在的擁有者底下則完全不問 API。 |

## 側邊欄

[`sidebar.spec.ts`](specs/sidebar.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 首席 agent 把新對話分進使用者的群組 | Claude Code | 用**新群組**（New group）建立的群組，收到第一則訊息提到它名稱的新對話。 |
| 重新命名與刪除對話 | — | 標題列與側邊欄的標題都改變；**刪除對話**（Delete conversation）會把它從側邊欄與伺服器上移除，並改為顯示首頁。 |
| 「新對話」下方先是搜尋，旁邊的新群組只有圖示，按下仍會打開新群組的欄位 | — | 這一列的按鈕依序是**搜尋**（Search，有文字）和**新群組**（New group，沒有文字：只有名稱與提示，和資料夾圖示），新群組在這一列右邊的窄欄，兩個按鈕一樣高；按**新群組**會打開群組名稱欄位並取得焦點，按 Escape 回到原本那一列；按**搜尋**則讓搜尋欄位取得焦點。 |
| 依 agent 寫的內容搜尋對話 | Codex | 搜尋回答中的文字，找到那一個對話，點了就打開。 |
| 在 UI 開始的對話保留一開始給的標題 | Claude Code | 第一個問題之後標題不變。 |
| agent 回覆時，對話那一列在狀態圓點的位置顯示 app 的載入標示，回覆完就消失 | Claude Code | 回覆很慢時（`e2e:slow=3`），這一列的「回覆中」狀態是旋轉的標誌（`.logo-spinner`，三個圓點），12px，置中在圓點 8px 的位置上（所以標題留在圓點會讓它在的地方）；回覆完成後就消失。 |
| 拖進群組的對話會留在那裡，拖出來則回到「其他」 | — | 伺服器存下群組，重新載入後仍在；拖到「其他」後群組被清除，群組裡又顯示可以把對話拖到這裡。 |
| 分支對話的家族在群組之間一起移動 | Codex | 拖動分支時，原本的對話跟著移動，分支仍在它底下；把原本的對話拖回來時兩個都回來。 |
| 對話左上角的釘選按鈕在滑過時出現，把對話列在群組上方的「已釘選」，最後釘選的在最上面，也能取消釘選 | — | 游標移到對話上之前，釘選按鈕是隱藏的（opacity 0），之後出現，中心落在對話列的左上角，不碰到標題，圖示在圓圈正中央，圖釘是斜的（`rotate(-45…)`）、沒有填色；按下後對話列在群組上方的**已釘選**（Pinned），也仍在「其他」，游標移開後釘選按鈕仍顯示，圖釘立起來、變成黃色，名稱是**取消釘選**（Unpin）；伺服器回報 `pinnedAt`。第二個用鍵盤釘選的對話（從對話按 Tab 會到它的釘選按鈕，按鈕隨之出現；按 Enter）排在前面，重新載入後也一樣，它的 `pinnedAt` 較晚。已釘選那一列的資料夾選單顯示它的群組（在別處移到 Billing），也能把它移回「其他」。從箭頭收合**已釘選**（也包括箭頭左下角、第一列釘選按鈕旁邊）後只顯示數量，重新載入後仍收合，再打開。伺服器拒絕釘選（500）時顯示**無法變更釘選**，什麼都沒改。一個從「已釘選」取消、另一個從它的群組取消後，「已釘選」區消失，兩個都仍在「其他」；從「已釘選」刪除釘選的對話，它也會離開那裡。 |
| 每個 CLI 的狀態點與可用數量排得進一行 | — | 十二個 CLI 都已安裝且可用時（在傳到頁面的途中改掉伺服器的回答，「12/12 ready」），這一行沒有超出邊界，第一個點在設定的 ⚙ 正下方，箭頭的尖端對齊下方回報問題圖示的右緣；顯示名稱、箭頭轉向下時也一樣。 |
| 回報問題左邊的星星請使用者到 GitHub 給一顆星星、說明怎麼按，並在新分頁打開 repo | — | 星星在回報問題圖示左邊、同一行；對話框請使用者給星星並說明要按哪裡；示意圖寫出 repo 名稱，按下的動畫播三次，只用 `transform` 與 `opacity`；**到 GitHub 按星星**（Star it on GitHub）連到 repo（`REPO_URL`），在新分頁以 `noopener` 開啟，新分頁確實打開（GitHub 的頁面由測試代替，不會連上網路），對話框接著謝謝使用者；**稍後再說**（Later）關閉對話框；用鍵盤再打開時還沒有道謝，按 Escape 關閉後焦點回到星星；按 × 或點對話框外面也會關閉。側邊欄的星星與連結上的星星是黃色的（連結上的是實心；側邊欄的在滑鼠移上去時）。 |
| 減少動態效果時，星星對話框的游標停在 Star 上，不播按下的動畫 | — | 示意圖裡沒有動畫在跑；看得到游標與 **Star**，看不到 **Starred** 與實心的星星。 |

## 首席 agent 在團隊之外的協助

[`lead-drafts.spec.ts`](specs/lead-drafts.spec.ts)：首席 agent 在各自的編輯器裡撰寫範本、團隊檢查和自動任務，成員在回覆裡提議的排程，側邊欄的群組建議，以及替新對話命名。假的首席 agent 每種都回一份固定的草稿（`fake-cli/lib/plan.cjs` 的 `templateReply`、`checksReply`、`scheduleReply`、`organizeReply`），成員收到 `e2e:propose` 時在回覆結尾加上 `<schedule>` 區塊（`=mail` 是等新郵件的），首席 agent 用 `e2e:title=<字詞>` 給的標題替新對話命名（沒有就不命名）。測試伺服器一開始關閉命名（`RELAY_CHAT_TITLES=off`，`support/relay.ts`），它的測試再打開。

| 情境 | CLI | 檢查內容 |
| --- | --- | --- |
| 撰寫新範本，可以復原，儲存後會保留 | Claude Code | 在**＋ 新增範本**裡按**請首席 agent 撰寫範本**：說明列出*名稱改為「Review pair」*和*改寫說明*，名稱欄和成員（Reviewer、Tester）都填好了；**復原**會再清空；再問一次並儲存後，範本庫列出「Review pair」。 |
| 在各 CLI 狀態到之前請首席 agent 撰寫的新範本，照樣套用 | Claude Code | 擋住 `/api/providers` 並重新載入，讓**＋ 新增範本**打開時沒有成員；按**請首席 agent 撰寫範本**，然後在它的回答被擋住時放行狀態（就像 Windows 上狀態來得晚）：回答照樣套用（說明、Reviewer），不會出現*首席 agent 撰寫期間範本已經變更*。以前狀態的團隊會取代它被問的那一個，回答就被丟掉。 |
| 讀過專案後撰寫對話的團隊檢查，儲存團隊後會保留 | Claude Code | 在**團隊設定 → 進階設定**按**請首席 agent 撰寫規則**：說明寫它讀了專案，列出*保護 .env*和*新增指令 npm test*，欄位也顯示它們；團隊設定自己的**請首席 agent 調整**仍是另一個輸入框。之後把成員改名為「Claudia」，**復原**會清空規則並保留新名字，再問一次時規則套用在團隊目前的樣子上；**儲存**後對話有這兩條規則和 Claudia。 |
| 開源 agent 當首席時，在它的沙箱能讀的空資料夾裡起草，不在 Harness Relay 的暫存資料夾 | Pi | 以 Pi 當首席 agent，在**新自動任務**按**請首席 agent 填寫**會得到回覆（假 CLI 的排程填好訊息）：它的執行在 Harness Relay 自己的沙箱裡啟動，那個沙箱不能讀暫存資料夾。只在那個沙箱能運作的地方執行。 |
| 用一句話填好新的自動任務 | Claude Code | 在**新自動任務**按**請首席 agent 填寫**，會填好訊息、**每天**和 18:00；**建立自動任務**可以按。 |
| 成員提議的排程是一張卡片，可以直接建立、先在表單中修改，或略過 | Claude Code | 回覆裡看不到 `<schedule>` 區塊，只有一張**提議的自動任務**卡片：**建立自動任務**會儲存它（每天 08:00、開啟），卡片顯示*已建立自動任務*，按鈕消失。第二張說它會取代對話目前的自動任務；**在表單中修改**會打開**自動任務**抽屜並帶入訊息，在那裡修改並儲存後，卡片顯示已建立。第三張是等郵件的（`e2e:propose=mail`）：**建立自動任務**不能按，說觸發條件還沒有帳號；**略過**後自動任務維持原樣。 |
| 首席 agent 建議側邊欄的群組，並套用使用者勾選的 | Claude Code | 有兩個對話時，**請首席 agent 整理群組** → **取得建議**：新群組「E2E projects」和兩項搬移都已勾選；取消勾選群組會擋下搬進它的搬移，**套用**也跟著不能按；再勾回來，**套用 3 項**會關閉對話框，側邊欄顯示這個群組裝著兩個對話。 |
| 首席 agent 依第一則訊息替新對話命名，直到在設定裡關掉 | Claude Code | 開啟命名時，新對話（`e2e:title=Flaky_test_hunt`）在側邊欄顯示為「Flaky test hunt」。在**設定 → 首席 agent**，**自動為新對話命名**是勾選的；取消勾選（立即儲存，說明會這麼說）後，下一個對話保留第一行「Second question」。 |

## 自動任務

[`schedule.spec.ts`](specs/schedule.spec.ts)：自動任務（程式碼中稱為 schedule）。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 儲存對話的排程，立即執行一次會把訊息送給團隊 | Codex | 存成「每天」（Every day）後，側邊欄標出這個對話；按**立即執行一次**（Run once now）送出標為自動任務的訊息與附件，成員回答。按 Esc 取消錄音時，抽屜保留已編輯的訊息和附件。讀取附件時關閉抽屜會取消這次編輯，稍後刪除的任務不會重新出現。從任務移除附件後，仍可從先前的訊息下載原本的內容。 |
| 上傳附件時重開自動任務並刪除 | Codex | 上傳途中關閉抽屜，重開後刪除任務。瀏覽器等上傳完成才送出刪除請求，並向伺服器確認任務已刪除。 |
| 追蹤目標的排程會顯示回覆回報的進度，目標達成時自動關閉 | Codex | 加上目標儲存後，視窗的**進度**（Progress）說還沒有紀錄；按**立即執行一次**（假 CLI 用 `e2e:progress` 在回覆最後加上 `<progress status="done">` 區塊，寫出 briefing 給它的目標）：回覆顯示**已達成**（Done）卡片而不是區塊的文字，一則說明寫著目標已達成、自動任務已關閉，視窗列出這一則紀錄、**已達成**，**啟用**（On）也取消了勾選。 |
| 回覆說目標卡住的執行，會把對話標為需要你，自動任務維持啟用 | Codex | 回覆（假 CLI 的 `e2e:progress=blocked`）顯示 **卡住了**（Blocked）卡片和目標卡住的說明；側邊欄把對話標為 **目標卡住了**（Goal held up），分頁標題也算進去；抽屜的 **進度**（Progress）顯示 **卡住了**。使用者回答、成員回覆之後，標記就消失。 |
| 排程的 webhook 只顯示一次權杖，程式呼叫時會連同送來的內容送出訊息 | Codex | 選**不定時**（No set times）時，抽屜說明只有**立即執行一次**（Run once now）和 webhook 會送出，沒有**啟用**（On）也沒有**錯過的時間**（Missed times）；儲存後側邊欄的時鐘也這麼說，狀態顯示**不定時**。**讓其他程式啟動它（Webhook）**（Let another program start it (webhook)）收起來，打開才看得到；**建立 webhook**（Add a webhook）會顯示帶權杖與網址的 `curl` 指令（Windows 上是 PowerShell 的 `Invoke-RestMethod`），以及**還沒有被呼叫過**（Not called yet）；從瀏覽器以外呼叫時，權杖錯誤是 404，正確是 202，視窗會顯示上次呼叫的時間。訊息標為自動任務，顯示**Webhook 傳來的內容**（What the webhook sent）與送來的 JSON，成員回答它。再次打開時，視窗不再顯示權杖，只有**換一個新的權杖**（New token）。 |
| 收到新郵件時啟動的自動任務自己檢查收件匣：第一次檢查只記下已經在的郵件，之後收到的郵件會送到團隊，訊息中有它的寄件者與主旨 | Codex | 郵件帳號的 IMAP 是這台電腦上的替身；**當某件事發生時**（When something happens）自動選了唯一的帳號，說明第一次檢查只記下已經在的郵件，也沒有**錯過的時間**（Missed times）；填了**寄件者包含（選填）**（The sender contains (optional)）後，側邊欄的時鐘顯示 **when a new mail from carol arrives**。**立即檢查**（Check now）只記錄（狀態顯示 **Checked**），不送出任何東西；收到兩封信後，再按一次**立即檢查**會送出一次標為自動任務的訊息，**新郵件**（The new mail）區塊裡有 Carol 的主旨，沒有另一封新郵件，也沒有舊郵件；Codex 的回覆引用了它的 `<event source="mail">` 區塊。 |
| 工作目錄中出現檔案時啟動的自動任務：第一次檢查記下已經在的檔案，新的檔案以路徑送到團隊，從不送出內容 | Codex | **要等的事** → **工作目錄中的檔案出現或變動**（When something happens → A file appears or changes in the working directory），樣式 `reports/*.csv`；說明寫著只列出檔名、不列內容，側邊欄的時鐘寫著 **when a file matching reports/\*.csv appears or changes in the working directory**。**立即檢查** 記下 `reports/jan.csv`，什麼都不送；新的 `reports/feb.csv`（以及樣式不包含的 `notes.txt`），都在一分鐘前就寫完了，讓下一次 **立即檢查** 送出訊息一次，它的 **The files that appeared or changed** 區塊把 `reports/feb.csv` 列為新檔案，沒有 `jan.csv`、`notes.txt`，也沒有檔案裡的內容；agent 收到的是 `<event source="file">` |
| 等兩件事的自動任務，任何一件發生都會啟動：每件各自檢查、各一行顯示，各送自己的訊息 | Codex | **當某件事發生時**選**工作目錄中的檔案出現或變動**（A file appears or changes in the working directory），樣式 `reports/*.csv`：只有一件時沒有**移除**（Remove）；**再等一件事**（Add another）加上**要等的第 2 件事**（Thing 2 to wait for），同樣是檔案樣式，樣式還是空的。在那裡填 `./reports/*.csv` 時表單說 **Two of the things to wait for are the same**，**儲存**變灰；改填 `invoices/*.pdf` 就能儲存，說明寫著每件各自檢查，側邊欄的時鐘寫著 **when a file matching reports/\*.csv appears or changes in the working directory, or when a file matching invoices/\*.pdf appears or changes in the working directory**。再打開時抽屜列出兩件，各在自己的群組裡、各有**移除**；**立即檢查**記下已經在的檔案，什麼都不送，狀態裡每件的檢查情況各一行。新的 `reports/feb.csv` 讓下一次**立即檢查**送出訊息一次，它的區塊寫著 `reports/*.csv` 並列出 `reports/feb.csv`；Codex 回覆之後，新的 `invoices/inv-7.pdf` 讓再下一次送出另一則訊息，只列出這張發票（沒有 `feb.csv`，也沒有舊的發票）；Codex 收到的是 `<event source="file">`。關掉之後（取消勾選**啟用**（On）並儲存），狀態寫著兩件事與 **paused**，沒有每件一行；**移除要等的第 1 件事**（Remove thing 1 to wait for）之後只剩 `invoices/*.pdf`，不在群組裡，也沒有**移除**，儲存後狀態只寫著它，仍然是 **paused**。 |
| GitHub 上開了 pull request 時啟動的自動任務：透過 gh 檢查，第一次檢查記下已經在的，新開的以資料送到團隊 | Codex | **要等的事** → **GitHub 上有新的 pull request 或 CI 失敗**（A pull request or a failed CI run on GitHub）；填 `not a repo` 時表單說 **Give the GitHub repository as owner/name**（和伺服器一樣），`https://github.com/octo/app` 當作 `octo/app`；說明提到你自己的 GitHub CLI，側邊欄的時鐘寫著 **when a pull request is opened in octo/app**。**立即檢查** 執行假的 `gh`（`pr list --repo octo/app --state all …`），記下 #41，什麼都不送；標題含有 `</event>` 的 #42 讓下一次 **立即檢查** 送出訊息一次，它的 **What is new on GitHub** 區塊列出 #42 與它的分支，沒有 #41；Codex 收到的是 `<event source="github">`，標題的 `<` 寫成 `\u003c`。 |
| 每週自動任務草稿 | Claude Code | 以合成音訊錄音並將轉寫結果插入任務欄位。只加附件時不能建立。用 Tab 依序經過常用 App、附件與麥克風，再用鍵盤開啟常用 App，可複選多項。管理連線後返回，訊息、App 選項、附件、目標與每週排程仍保留。確認建立才會把選取的 App 名稱寫入任務。經過首席設定仍保留標題、執行與確認方式。建立時只組隊，下次新建是空白任務。 |
| 事件草稿 | Claude Code | 從連接帳號設定返回，保留事件草稿，改選檔案事件並儲存。 |
| 建立 webhook | Claude Code | 從「Webhook 與執行設定」建立 webhook；權杖只顯示一次，外部程式可用它啟動任務。 |

## 設定

[`settings.spec.ts`](specs/settings.spec.ts)

從工具庫點「前往助理設定」會展開助理選單。測試涵蓋鍵盤選擇 Codex、返回，以及重新開啟書籤後的焦點。 按「前進」後再選已開啟的助理卡，選單會關閉，焦點回到助理選單按鈕。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 在 GitHub 和瀏覽器列安裝缺少的工具 | — | 缺少時顯示安裝按鈕，重新整理保留進度，失敗可重試。完成後顯示 GitHub 登入或瀏覽器路徑。 |
| 全新安裝時會先檢查助理，再展開初次設定選項 | — | 繁中介面的總覽先顯示檢查中，取得狀態後列出需要安裝的助理，點 Codex 可前往它的設定卡。 |
| 找到每個 CLI，顯示版本，且已登入 | 各一，同一個測試 | 每張卡片顯示 CLI 的版本，以及**已登入**（Claude Code 附帳號），開源 agent 在假端點上則是**可使用**（Ready）；側邊欄十二個狀態點都正常（「12/12 ready」，開源 agent 的標題是「Model access set up」）；要求時顯示它們的名稱，重新載入後仍保留。 |
| 版本太舊的 CLI 在設定與側邊欄說明，提供新版，它的回合說明需要哪個版本 | Codex | `E2E_FAKE_TOO_OLD=codex`：它的假程式說自己是 0.0.1，其他指令都會失敗，就像 Codex 0.27 在沒有終端機時那樣。它的狀態點顯示「Too old: needs an update」，總覽顯示 **Needs an update**；卡片與帳號的標籤都是 **Too old**，帶著 v0.0.1、需要的版本、使用者自己的那份維持原樣的說明，以及 **Install Codex**（不點它）；**Sign in** 不能按。它的回覆錯誤說它太舊、Harness Relay 需要哪個版本，而且 Codex 除了 `--version` 之外從沒被啟動。 |
| 未安裝的 CLI 在設定與側邊欄顯示未安裝 | Cursor、Antigravity | 設成未安裝（`missingClis`）：它們的狀態點與卡片顯示**未安裝**（Not installed）。助理總覽顯示 Claude Code 已可用，展開**連接另一個助理**就能選 Cursor 前往設定。 |
| 沒有模型來源的開源 agent 還不能用，它的回合說明要先設定一個 | OpenCode | `openBackend: false`：助理總覽裡的 OpenCode 連到**模型連線**。按 Enter 後焦點到達標題，Tab 會走進該區的設定。狀態點寫著「Model access not set up」，卡片顯示**尚未就緒**（Not ready）與「No model backend set up yet (Settings → Model connections)」，回答的錯誤說 OpenCode 沒有模型。 |
| 可以指定 CLI 的執行檔路徑，錯誤的路徑顯示找不到 | Grok | 不存在的路徑顯示**未安裝**（Not installed）；清空後又找到它。 |
| 常用 App 與工具庫共用一張設定卡片 | — | 設定導覽列只有一個 **App 與工具**連結。開啟 `#/settings/apps` 會選到**常用 App**，`#/settings/tools` 則會選到**工具庫**。只會顯示選定分頁的內容。End 與向左鍵可在分頁間移動焦點。重新載入後同一個導覽連結仍會標亮；用瀏覽器的上一頁回到工具庫時，尚未儲存的記憶草稿會保留。常用 App 的十列中，八個內建工具各有一組聊天存取選項，連線前即可設定。 十個服務也依順序列在正確的四個具名區域中。 |
| 連結列把 agent 合成一個選單，選單通往每個 agent 的卡片，並顯示正在看的那一個 | — | 連結列從**助理總覽**開始，放著除了 agent 以外每張卡片的連結（兩個分頁共用一個 **App 與工具**連結），模型連線與首席助理之間有一個**助理設定**（Agents）按鈕。打開後選單列出十二個 agent，開源 agent 在名為**開源 agent**（Open-source agents）的群組中，焦點在第一個；方向鍵（到兩端會繞回）、Home、End 與 Escape（回到按鈕）可以移動與關閉；在按鈕上按 ArrowUp 會打開並停在最後一個，Tab 會關閉並移到**首席 agent**（Lead agent），Shift+Tab 回到按鈕。點選單的標題時焦點留在原本的項目，按鍵照常有效；焦點移到別的連結會關閉選單。選 **Codex** 會關閉選單、前往 `#/settings/codex` 且卡片在畫面內，按鈕的名稱是 **助理設定：Codex**（Agents: Codex）並標亮；再打開時 Codex 有標記與焦點；點別處會關閉。點**首席 agent** 後標亮回到它，而且它不會移動（按鈕寬度不變）；`#/settings/opencode` 的按鈕名稱是 **助理設定：OpenCode**（Agents: OpenCode）。 |
| 在矮的視窗裡，agent 選單留在視窗內，按鍵會顯示移到的項目 | — | 在 1280×480 下，從設定頁頂端（連結列比固定後低）打開時，選單底部在視窗內；End 讓 **Pi** 取得焦點並捲進選單的可見範圍，Home 回到第一個。 |
| 在手機上，agent 按鈕完整顯示，選單留在螢幕內並跟著按鈕，並通往卡片 | — | 在 390×844 下，從 `#/settings/codex` 進來時連結列會讓出左上角按鈕的位置而變窄，**助理設定：Codex**（Agents: Codex）仍完整顯示；用 Tab 離開選單時會把**首席 agent**（Lead agent）捲進畫面；按鈕在連結列右端時選單在螢幕內打開，連結列捲動時選單保持打開並跟著按鈕移動；選 **Pi** 會前往它的卡片。 |
| 連結列在收合的側邊欄按鈕旁固定時，agent 選單跟著按鈕移動 | — | 在 900×900 下收合側邊欄，在設定頁頂端打開選單；用滾輪捲動頁面後連結列固定並往右移，選單跟著按鈕移動。 |
| 選擇自訂端點提供給助理的模型 | Claude Code | 開啟頁面時可直接看到開源助理的 API Key。展開**自訂端點**，從測試伺服器載入模型，勾選一個，再手動輸入一個只能在端點按 ID 查到的模型。重新載入頁面、編輯端點並改選另一個模型後，Claude Code 的預設模型選單會列出新選的模型與手動輸入的 ID，並移除取消勾選的模型。 |
| 儲存手動輸入的模型 ID | — | 在編輯器中直接輸入不存在的模型 ID 並儲存，會顯示該 ID 並保留草稿。新增失敗時不會建立端點，編輯失敗時已儲存的名稱與模型維持原值。分別改成只能按 ID 查到的模型與清單上的模型後，兩次都能成功儲存。也測試兩種模型資料查詢都不支援時，取消會保留草稿，確認則儲存未驗證的 ID。 |
| 端點模型的上下文長度在儲存時從伺服器讀取，自己填的優先 | — | 在測試伺服器上新增端點並勾選兩個模型：**上下文長度與輸出上限** 中，上下文長度顯示會在儲存時從伺服器讀取。儲存後，端點那一行顯示第二個模型的 32,768 token *（伺服器回報）*，與測試伺服器回報的一樣（`max_model_len`）。再編輯時，它的欄位以伺服器的數字當提示文字；填入不是數字的值會說明原因，**儲存** 維持停用；為第一個模型填的上下文長度與輸出上限顯示為自己的，旁邊是第二個模型伺服器回報的值，並照這樣儲存（`limits`）。 |
| 實驗室：一次一種模式，重新整理後保留 | — | `#/settings/labs`：選的是**關閉（預設）**，**儲存**無法按；每種模式的選項只以名稱為名，並以它做什麼、代價為說明。選**分段閱讀長文字（RLM）**會出現模型欄位：不是 `backend/model` 的名稱、以及來源不在模型連線裡的名稱，各自說明原因，儲存仍無法按。**透過什麼來問**先列模型連線，再列能透過的已安裝 CLI 的帳號（這裡是 Claude Code 的，絕不會有 Codex 的）；選 Claude Code 的帳號時模型欄位留空就是帳號的預設，並說明每個問題都會啟動拿掉工具的 Claude Code，可以儲存，重新整理後仍是那個帳號。選**讓助理寫程式來用工具（CodeAct）**會隱藏欄位；儲存後說明從下一個回合開始生效，重新整理後仍保留。 |
| 桌面與手機的設定小標題間距 | — | 檢查**開源助理的 API Key**、**自訂端點**、**已刪除的端點**及 session 設定的小標題與第一個欄位或說明之間的距離。展開自訂端點後才會看到已刪除的端點。 |
| 切換語言，選擇會保留 | — | 選繁體中文後頁面改變，重新載入後仍保留，選 English 再改回來。翻譯後的「模型連線」連結都開啟同一張卡片，開源助理的 API Key與自訂端點的標籤也會跟著切換。 |
| 選另一個 CLI 擔任首席 agent | Codex 當首席 agent | 新對話頁寫出它，團隊卡片寫著「Lead agent: Codex」，首席 agent 的 prompt 交給了 Codex。 |
| 未登入的 CLI 顯示未登入，它的回答說明原因 | 有登入的各一 | `E2E_FAKE_SIGNED_OUT=<cli>`：狀態點與卡片顯示**未登入**（不含 CLI 自己的說法），並有**登入**按鈕，另一個 CLI 則仍然登入；它的回答帶著 CLI 的錯誤。Harness Relay 只用 Gemini API key 執行的 Antigravity：伺服器以空的 `GEMINI_API_KEY` 執行，而它的假 CLI 保留它（假的）Google 登入；它照樣顯示**未登入**，沒有**登入**按鈕，API key 欄位已展開，附上 Harness Relay 只用 Gemini API key 執行它的說明；它的回答說它沒有 Gemini API key、所以沒有啟動，agy 除了 `--version` 之外從沒被啟動。 |

## 安裝 CLI

[`install.spec.ts`](specs/install.spec.ts)：在設定頁 CLI 卡片上按 **安裝**，伺服器的 PATH 最前面是假的 npm（`e2e/fake-cli/fake-npm.cjs`），它照 npm 的全域配置，把 CLI 的假程式放進 Harness Relay 給它的資料夾。Copilot、Cline 與 Grok 設成未安裝（`missingClis`）。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 找不到的 CLI 裝進專屬的資料夾，再移除 | Copilot | 卡片顯示**未安裝**（Not installed，沒有「找不到」那一行，也沒有官網連結），有 **Install Copilot** 與資料夾（`<data>/clis/copilot`），不顯示會執行的指令。安裝中（`fake-npm/hold`）：**Installing Copilot…**、目前為止 npm 的輸出（第一行是它的指令），以及 **Cancel install**；這時關掉設定頁，裝好後側欄的紅點一樣會消失。完成：「Installed by Harness Relay in …」、標題顯示版本且沒有狀態標籤、**執行檔**是裝好的程式、側邊欄的圓點不再是紅色，而 npm 收到的是 `install --global --prefix <資料夾> --cache <資料夾>/install-cache/npm … @github/copilot`，裝完後那個快取（假的 npm 會寫入它）已經不在。**Remove**（確認後）刪掉資料夾，卡片又提供安裝，顯示**未安裝**（執行檔設定改回安裝前的）。 |
| 安裝失敗會說明原因且不留下任何東西；安裝中可以取消 | Cline | `fake-npm/fail`：**Install failed**、「npm install -g --prefix … cline@3.0.74 failed (exit 1)」、安裝程式的輸出裡有 npm 自己的 404，而且沒有資料夾。用 `fake-npm/hold` 按 **Try again**，再按 **Cancel install**：「Install cancelled; nothing was left behind.」、**Try again**，且沒有資料夾。 |
| 提供官方安裝程式：macOS 與 Linux 上是 bash 腳本，Windows 上是 PowerShell 版，但不顯示它的指令 | Grok | **Install Grok** 與安裝程式會以那個資料夾當家目錄的說明（不按：那是官方在網路上的腳本），不顯示它的指令；`GET /api/clis` 說那是 `curl -fsSL https://x.ai/cli/install.sh \| bash`（Windows 上是 `irm https://x.ai/cli/install.ps1 \| iex`），沒有「找不到」那一行，也沒有官網連結。 |

## 安裝 Git

[`git-install.spec.ts`](specs/git-install.spec.ts) 模擬伺服器的 Git 安裝與狀態回應，確認需要 Git 時會開啟對話框、可以先關閉、安裝後會保留新對話的輸入，無法自動安裝時可查看手動指令並重新檢查，以及關閉對話框後設定頁仍會更新 Git Bash 的狀態。測試可在各平台上執行，使用模擬安裝程式。

## 沙箱需要的元件

[`sandbox-setup.spec.ts`](specs/sandbox-setup.spec.ts)：agent 的沙箱在這台電腦上缺東西時，新對話跳出的對話框，以及**設定 → 沙箱**（`sandboxAsk: true`）。每台電腦缺的東西不同，所以伺服器的回答（`GET /api/sandbox-setup` 與安裝）由測試提供（`page.route`）；伺服器那一端由 `test/sandbox-setup.test.ts` 涵蓋。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 新對話詢問是否安裝、強烈建議；按「先不要」就留給設定頁 | — | 對話框 **Installing what the sandboxes need is strongly recommended**：寫著「installing it now is strongly recommended」、給 Claude Code 與開源 agent 的沙箱用的「Linux packages: bubblewrap, socat」、會跳出 pkexec 的密碼視窗、**Install (strongly recommended)**，以及之後可在**設定 → 沙箱**安裝。按 **Not now** 會在新對話頁上關掉它；再按新對話、或重新整理，都不再詢問。**Sandboxes** 卡片列出這些套件，附 **Install**。 |
| 從對話框安裝會顯示輸出，接著說沙箱需要的都有了 | — | 按 **Install (strongly recommended)** 會送出 `POST /api/sandbox-setup/install`；對話框接著說「Installed: the sandboxes have everything they need.」，不再列出缺少的東西、也不再說之後可在設定頁安裝，按 **Close** 關掉，重新整理後不再詢問。 |
| 這裡無法安裝的，附上要在終端機執行的指令，沒有安裝按鈕 | — | 沒辦法取得系統管理員權限（`blocked: 'admin'`）：說明這件事，並附「To install it yourself, run this in a terminal:」與 `sudo apt-get install -y bubblewrap socat`，沒有 **Install**。按 Escape 只在這個頁面關掉：重新整理後會再詢問。 |
| 安裝裝好這裡能裝的之後，說剩下的要使用者自己裝 | — | 在**設定 → 沙箱**，Node.js 能裝、套件不能（`blocked: 'admin'`）：按 **Install** 送出 `POST /api/sandbox-setup/install`；成功後卡片說「Installed what Harness Relay can install here; the rest, listed here, is yours to install.」，列出套件與它們的指令，不再列出 Node.js，也沒有 **Install**。 |
| 什麼都不缺時，新對話不詢問 | — | 沒有對話框；**Sandboxes** 卡片寫著「The sandboxes have everything they need on this computer.」 |
| 在開發版 build 中也一樣 | — | 在介面的開發版 build（React 的 StrictMode 會把每個 effect 執行兩次）中，新對話仍會詢問，**設定 → 沙箱**也仍列出這些套件並附 **Install**。 |

## 在 Windows 上是腳本的 CLI

[`windows.spec.ts`](specs/windows.spec.ts)：只在 Windows 上執行。在其他地方，以及 Windows 上預設的情況，假 CLI 都是在 PATH 上找到的程式。這裡則像使用者一樣在設定中，把每個 CLI 的執行檔路徑設成它在 Windows 上安裝後的那種啟動器；Harness Relay 會把它當成它所執行的程式來啟動（`src/server/winLaunch.ts`），從不透過 `cmd.exe`。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 透過 Cursor 自己的啟動器啟動，找得到它與它的版本，並且會回答 | Cursor | 透過 `cursor-agent.cmd`（它會執行 Node 與 Cursor 自己的腳本），設定顯示它的版本，完全存取的回合以 Cursor 的身分執行。 |
| 透過 Muse Code 自己的啟動器啟動，找得到它與它的版本，並且會回答 | Muse Code | 同上，透過 `muse.cmd`（它的腳本會執行 `.muse-version` 指定的 `muse-bin-<版本>.exe`），Harness Relay 直接把它當成那個執行檔啟動。 |
| 透過 npm 給 Node 腳本的 shim 啟動，找得到它與它的版本，並且會回答 | Cline、Pi | 同上，透過 npm 給 Node 腳本的 `.cmd` shim。 |
| 透過 npm 給程式的 shim 啟動，找得到它與它的版本，並且會回答 | OpenCode | 同上，透過 npm 給程式的 `.cmd` shim。 |

## 帳號

[`accounts.spec.ts`](specs/accounts.spec.ts)：**設定 → 各 CLI 的卡片 → 新增帳號**，針對有自己登入的七個 CLI（開源 agent 沒有帳號：它們使用模型來源）。Cursor 與 Muse Code 新增的帳號只能用 API key 登入，由這些測試給它們；Antigravity 的每個帳號也一樣，預設帳號也是：測試的伺服器在它自己的環境變數（`GEMINI_API_KEY`）裡給預設帳號一把 key。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 新增的帳號有自己的資料夾，設定使用它的成員在那裡執行 | 有登入的各一 | 帳號放在 `<資料>/accounts/<cli>-<id>`，卡片上顯示這個資料夾，並在那裡登入（Cursor、Antigravity 與 Muse Code 用給它的 key：「Using an API key」；Copilot 的登入狀態在這次詢問自己的家目錄中詢問，放在資料資料夾的 `tmp` 裡，帶著帳號登入狀態的副本）；使用它的成員以這個家目錄執行（`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`GROK_HOME`、Cursor 的帳號資料夾、裡面 Antigravity 的 `.gemini`、Copilot 這次執行自己的家目錄，它的 session 連到那個資料夾、裡面 Muse Code 的資料資料夾 `data/muse`，它的設定資料夾則是那個回合自己的），使用預設帳號的成員則用預設的。 |
| 每個帳號各自登入與登出 | Claude Code | **登出**只在新增帳號的家目錄執行 `auth logout`；**登入**走 CLI 自己的流程（一個連結，再貼上代碼），等待時狀態旁有 app 的載入標示（旋轉的標誌），之後顯示這個帳號已登入，載入標示消失。 |
| 登出新增的帳號，只會登出那個帳號 | Codex、Grok、Copilot | `logout`（Copilot 的透過 ACP）只在那個帳號的資料夾執行；它的卡片顯示**未登入**，預設帳號仍然登入。 |
| 金鑰儲存區關閉時，帳號的 API key 加密存在資料庫、遮蔽顯示，並只交給它的 CLI | Claude Code、Grok、Cursor、Antigravity、Copilot、Muse Code | API key 欄位說明金鑰存在哪裡（加密存在資料庫；只能用 key 登入的帳號，包括 Antigravity 的預設帳號，欄位一開始就展開）；儲存後顯示遮蔽的值與「Using an API key」，`/api/settings` 裡從沒有它，`relay.db` 和它的 WAL 裡也沒有它的原文，資料夾裡則有金鑰檔 `secrets.key`；那個帳號的執行拿到它（`ANTHROPIC_API_KEY`、`XAI_API_KEY`、`CURSOR_API_KEY`、`GEMINI_API_KEY`、`COPILOT_GITHUB_TOKEN`、`META_API_KEY`），不在任何參數裡，預設帳號的執行則沒有（Antigravity 的拿到啟動伺服器時帶的 key）。 |
| 帳號的 API key 用 Codex 自己的登入讓那個帳號登入 | Codex | Codex 不從環境變數拿 key：key 經由 stdin 交給只在那個帳號資料夾執行的 `codex login --with-api-key`，Harness Relay 不保存它，只有那個帳號的執行拿得到。 |
| 啟動 Harness Relay 時帶的 API key 只屬於預設帳號 | 有登入的各一 | 伺服器自己環境中的 key（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`XAI_API_KEY`、`CURSOR_API_KEY`、`GEMINI_API_KEY`、`COPILOT_GITHUB_TOKEN`、`META_API_KEY`）會交給預設帳號的回合，不會交給新增的帳號（Cursor、Antigravity 與 Muse Code 新增的帳號用自己的 key）。 |
| 移除新增的帳號會登出它並刪除它的資料夾，它的成員與首席 agent 改用預設帳號 | 有登入的各一 | 確認時寫出資料夾；帳號在那裡登出（只能用 key 登入的帳號沒有東西要登出），之後資料夾與其中的 session 都刪除；首席 agent 回到預設帳號；成員的下一回合在預設的家目錄、以新的 session 執行。 |
| 在 CLI 狀態的回答還在路上時新增帳號，保留較新回答的狀態 | Claude Code | 頁面的下一個狀態回答被擋到帳號新增之後（`page.route`）：這個較舊、沒有該帳號的回答最後才到時，帳號的狀態仍是**已登入**，不會變回「檢查中…」。 |
| 在 Harness Relay 以外登出的 CLI，重新打開設定時會顯示出來 | Claude Code | 在它的家目錄登出（就像在終端機執行 `claude auth logout`），而伺服器的快取仍說已登入。重新打開時，設定再檢查一次，app 則拿到快取的回答，這個回答被擋到（`page.route`）設定自己的回答之後：最後才到也不會勝出，狀態顯示**未登入**。 |
| 有對話正在執行時不能移除帳號 | Claude Code | 回答慢慢進行時，**移除**說有對話正在執行，什麼都不變；停止對話後就能移除。 |

## 伺服器環境變數裡的金鑰

[`agent-env.spec.ts`](specs/agent-env.spec.ts)：啟動 Harness Relay 的環境裡別家模型供應商的金鑰，只會傳給那家自己的 CLI；**設定 → 各 CLI 的卡片 → 環境變數**列出它拿不到的金鑰，也能把它們傳過去。伺服器啟動時帶著 `HF_TOKEN` 與 `MISTRAL_API_KEY`，它們不屬於任何 CLI。

| 情境 | CLI | 檢查什麼 |
| --- | --- | --- |
| 新對話說一次每個已安裝的 CLI 拿不到哪些金鑰，只列名稱，並帶到它的卡片 | Claude Code、Codex、Grok | 設定 `envNotice: true` 時，新對話會開一個提示，為每個已安裝的 CLI 列出它拿不到的金鑰（沒有未安裝的 CLI，也沒有值）；**開啟設定** 關掉提示並打開 Claude Code 的卡片，它的 **環境變數** 說有兩個金鑰沒傳給它。再開新對話、重新載入後，都不再出現。 |
| 從 CLI 的卡片傳過去的金鑰，只有那個 CLI 的執行拿得到 | Claude Code、Grok | fake 會說每個變數有沒有設定（`e2e:env`）：一開始兩個都沒有。在 Claude Code 的卡片按 `HF_TOKEN` 旁的 **傳給它**，它就移到要傳過去的清單（摘要改說有一個金鑰沒傳給它），不是名稱的輸入在送出前就被頁面擋下，打進去的名稱（前後有空白）按 Enter 就加入並清空輸入框，再按 **×** 拿掉；伺服器只為 Claude Code 保存這份清單。在同一個對話裡，Claude Code 的下一次執行拿到 `HF_TOKEN`，仍然沒有 `MISTRAL_API_KEY`，Grok 則兩個都沒有。 |

## 方案用量

[`usage.spec.ts`](specs/usage.spec.ts)：**設定 → 每個 CLI 的卡片 → 帳號的方案用量**，涵蓋有自己登入的七個 CLI。每個替身都像它的 CLI 一樣不送 prompt 回報方案用量（Claude Code 的 `get_usage`、Codex 的 `account/rateLimits/read`、Grok 的 `_x.ai/billing`、`muse usage --json`、Copilot headless 伺服器的 `account.getQuota`、Cursor 從 `about --format json` 取得的方案）：預設的登入（e2e@example.com）已用 42%，其他帳號 7%，並記下每次詢問與它的家目錄。只用 Gemini API key 執行的 Antigravity 沒有方案，也從不詢問 agy。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 預設帳號顯示方案還剩多少，或它的 CLI 為什麼不說 | 每個有登入的 | Claude Code、Codex、Grok、Copilot 與 Muse Code：方案（Muse Code 沒有）、第一個額度的名稱（「5-hour limit」、「Weekly limit」、「Monthly limit · Premium requests」、「Allowance」）、「58% left · 42% used · resets …」（Copilot：「126 of 300 requests used」）與停在 42 的 meter，在預設帳號的家目錄只問一次（Copilot 在詢問專用的家目錄）。Cursor：取自 `about` 的方案，以及它的用量只在它自己的終端畫面顯示。Antigravity：說明這個帳號用 API key 執行、沒有額度，也從不詢問 agy。都沒有錯誤。 |
| 每個帳號顯示自己方案的用量，在它自己的資料夾詢問，「重新查詢」會再問一次 | Claude Code | 以另一個地址登入的新帳號在區塊捲到畫面上後顯示「93% left · 7% used」與它的每週額度，旁邊是預設帳號的 58%，各在自己的家目錄詢問；它的「重新查詢」（以帳號命名）只會再問那個帳號的 CLI 一次，不問預設帳號的。 |
| 用 API key 的帳號說明它沒有方案額度，未登入的帳號不顯示用量 | Claude Code | 有自己金鑰的帳號（它的 `get_usage` 回答 `rate_limits_available: false`）說明它用 API key 執行、沒有額度；未登入的帳號沒有用量區塊。 |

## 各 CLI 自己載入的內容，以及 Grok 的信任

[`native.spec.ts`](specs/native.spec.ts)：帳號框中的**這個 CLI 自己載入的 skill、MCP、hook 與記憶等 → 查詢**、它的 **Subagent 與 workflow** 框，以及 Grok 對專案的信任。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 它自己的 skill 會列出，設為不載入的在下一次執行時不會載入 | Claude Code、Codex | CLI 家目錄中的 skill 會列出（Codex 的附上檔案），並在回合中載入；勾選後**查詢**標示它不載入，下一回合一個都不載入（Claude Code 的 `skillOverrides`、Codex 的 `skills.config`）。 |
| Grok 卡片顯示資料夾的信任狀態；信任後載入專案的 skill，設為不載入則影響下一次執行 | Grok | 未信任時卡片會標示，也沒有列出 skill；**信任這個資料夾**會寫入 `$GROK_HOME/trusted_folders.toml`，專案的 skill 隨之出現；**全部不載入**會影響下一回合（`GROK_CLAUDE_SKILLS_ENABLED=false`），它在信任下執行且不載入任何 skill。 |
| 團隊有 Grok 成員時會說明 Grok 不信任這個資料夾，在那裡信任它就會記錄下來 | Grok | 從團隊卡片信任後記錄下來，Grok 的回合在信任下執行。 |
| 使用者拒絕時，團隊不信任資料夾就開始 | Grok | 什麼都沒記錄，**確認團隊**仍會開始，Grok 的回合在未信任下執行。 |
| 預設 subagent 開啟、workflow 關閉；切換後重新載入仍保留，也用在下一次執行；其他 CLI 的框說明它有什麼 | Claude Code（以及 Codex 與 Cursor 的框） | 一回合在有 subagent、沒有 workflow 下執行；**Subagent 與 workflow**：關掉 subagent、打開 workflow 與 **Ultracode**（workflow 打開前 Ultracode 不能勾，關掉 workflow 時一起關掉），重新載入後仍保留，下一回合帶著拒絕 `Agent` 的規則、沒有 `CLAUDE_CODE_DISABLE_WORKFLOWS`、並有 `"ultracode": true`。Codex 的框有 subagent 開關，並說明完全存取以外一律關閉，沒有 workflow 開關；Cursor 的沒有開關，並說明原因。 |

## Agent 的 session 與 AgentsView

[`sessions.spec.ts`](specs/sessions.spec.ts)：**設定 → Agent 的 session**。AgentsView 由 spec 裡一個在 127.0.0.1 上的 HTTP 伺服器代替。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 在設定中選的資料夾就是各 CLI 存放 session 的地方 | 兩個團隊 | 資料夾存下（只有擁有者能存取，Windows 上不檢查），每個 CLI 的 session 都在 `<資料夾>/<cli>/`（開源 agent 的在那裡它成員的狀態中），平常的家目錄裡沒有任何東西。 |
| 資料夾改變後，每位成員帶著到目前為止的對話在那裡開始新的 session | 兩個團隊 | 下一個 prompt 帶著整段對話，新的 session 在新的資料夾，舊的留在原處。 |
| Harness Relay 自己的資料夾或預設工作目錄裡的資料夾會被拒絕 | — | 兩種拒絕都會顯示，不建立任何東西，設定維持空白。 |
| 有對話正在執行時不能改資料夾 | Claude Code | 回答慢慢進行時，儲存會說有對話正在執行；停止後就能儲存。 |
| 每個回合之後與重新命名時，對話會送到 AgentsView，成員的 session 列在它底下 | Claude Code、Codex | 上傳帶著 AgentsView 自己的 `Origin`，以及它認得的 session 的專案與電腦；紀錄包含問題、兩則回答與標題；每位成員的 session 都連到它底下；重新命名會送出新標題。 |
| Cursor 成員的 session 是 Harness Relay 記下的，在討論串之後送出並放在它底下 | Codex、Cursor | 這個 session（id 由對話與成員的 id 推出）在討論串之後送出，與它同一個專案與電腦；內容有成員聽到的話、它的思考、列出資料夾的呼叫（以 Claude Code 的 `Read` 呈現，資料夾放在 `file_path`）、呼叫的結果與它的回答，名稱是成員、它的 CLI 與對話的標題；它連到討論串底下，Cursor 自己的 session id 從不送出。 |
| Copilot 與 Muse Code 自己的 session 依 AgentsView 的命名放在討論串底下，不替它們記下 session | Copilot、Muse Code | 每個成員自己的 session 以它的 CLI 給的 id 查詢並連到討論串底下，分別是 `copilot:<id>` 與 `muse:<id>`；只上傳討論串（兩個回覆與標題），不送出也不連結任何成員記下的 session。 |
| 其他位置的網址會被拒絕；更新失敗時設定會說明原因，對話照常進行 | Claude Code | 不在這台電腦上的網址會被拒絕並說明原因，設定維持空白；AgentsView 回應 503 時，回答沒有錯誤，卡片說明上次更新失敗與原因。 |

## 回報問題

[`report.spec.ts`](specs/report.spec.ts)：側邊欄的**回報問題**。郵件的連結在頁面中攔下（`window.open`、剪貼簿與被取消的 `mailto:` 導覽），所以不會開啟任何東西，也不會連上網路。讀取郵件連結的四個測試，在沒有 Navigation API 的瀏覽器中跳過。

| 情境 | 檢查的內容 |
| --- | --- |
| 郵件的連結帶著描述、版本與系統資訊 | 沒有描述前不能送出；資訊與 `/api/about`、瀏覽器、各 CLI 的版本與語言一致，沒有暫存路徑；`mailto:` 連結有收件地址、取自第一行的主旨與內文；Gmail 連結也一樣；**複製內容**會複製整封郵件；送出後再打開時是空的。 |
| 送出前關掉的回報會保留，選的類型與主旨會放進郵件 | 類型、主旨與描述在按 Escape 後仍在，郵件寫著 `[Harness Relay] Idea: <主旨>` 與 `Type: Idea`。 |
| 在手機上，寄出的方式固定在對話框底部，其餘內容從它下面捲過，寄出後的結果也顯示在那裡 | 在 390×640 下對話框會捲動，它的底部（**用 Gmail 寄**、**複製內容**、**寄出**）固定在對話框底部，**寄出**在畫面中，蓋住從下面捲過的內容，捲到頂端、一半與最後都一樣；從頂端寄出時對話框不會移動，底部會說郵件程式已打開。 |
| 太長而放不進郵件連結的回報放到剪貼簿，郵件請你貼上 | `mailto:` 連結維持在上限內並請你貼上回報，回報已在剪貼簿裡；Gmail 連結仍帶著全部內容。 |
| 加入的截圖要先上傳或移除，郵件才能送出 | 文字檔會被拒絕並說明原因；PNG 顯示縮圖，兩個送出按鈕都暫停，直到移除它。 |
| 無法上傳的截圖會說明原因，回報不帶截圖送出 | 假的 `gh` 未登入時，**上傳截圖**顯示和分享對話框一樣的說明（**登入 GitHub**、終端機的指令、再上傳一次），以及改用郵件附上截圖的方法，移除截圖後就能送出。 |
| 從回報視窗登入 gh，再自動上傳截圖 | 在那裡按**登入 GitHub** 會顯示 GitHub 的代碼；核准後說明消失，視窗會自己再上傳一次，而且只有一次（假的 `gh` 停在上傳本身，因為那需要 git）。 |

## 語音輸入的安裝

[`voice.spec.ts`](specs/voice.spec.ts)：安裝進行中的**設定 → 語音輸入**。真正的安裝要下載引擎與模型，測試無法離線做到，所以頁面拿到的是伺服器自己對 `GET /api/voice` 的回答，再加上一個安裝。

| 情境 | 檢查的內容 |
| --- | --- |
| 新對話與新自動任務的附件和麥克風按鈕保持原位（各一個測試） | 在桌面和手機寬度下，量測選取多個檔案（從迴紋針的選單選 **檔案…**）前後、錄音中、取消後、轉寫中與移除附件後兩個按鈕的位置及大小。另外檢查常用 App 排在最前面，後面依序是附件與麥克風按鈕：三個同樣大小、沒有外框的圖示，圖示在按鈕內水平垂直置中，常用 App 以提示文字標示名稱。 |
| 離開新對話後才取得麥克風權限 | 開啟首席設定後才允許使用合成麥克風，音軌會立即關閉。 |
| 安裝的步驟排成一列，向螢幕閱讀器說明狀態，下載顯示在進度條上 | 步驟排成一列、目前的步驟標為 `aria-current`、下載百分比與進度條的填色；安裝狀態旁有 app 的載入標示，新對話、新自動任務和聊天輸入列的麥克風右上角都有 12px 的安裝標示。 |
| 安裝失敗時說明停在哪一步 | 停下的步驟顯示為失敗。 |

## 使用導覽與主題

[`appearance.spec.ts`](specs/appearance.spec.ts)：像第一次造訪時的導覽（`tour: true`），以及**設定 → 外觀**。

| 情境 | 檢查的內容 |
| --- | --- |
| 第一次造訪時打開在第一個主題，顯示過的主題打勾，之後不會自己打開 | 開在**認識 Harness Relay**（已打勾），顯示**已看 1 / 7**，該主題標為 `aria-current`；**下一個**、從清單點選主題與方向鍵都能切換，顯示過的主題都打勾；最後一個主題的按鈕是**完成**而不是**下一個**，按下後關閉；重新載入後不再打開，首頁改問剩下的兩個主題。 |
| 首頁詢問剩下的主題：看看會打開其中第一個，不用了就不再問 | 看完第一個主題就關掉時，同一頁不會詢問；重新載入後首頁問剩下的六個主題，在新對話頁不顯示，回到首頁又出現；**看看**打開導覽，停在第一個還沒看的主題，第一個已打勾；按 Escape 並重新載入後再問一次（剩五個），**不用了**讓問題消失，重新載入後也不再出現；**設定 → 使用導覽 → 重新觀看導覽**會帶著打勾紀錄打開，停在第一個還沒看的主題。 |
| 看完舊版導覽的瀏覽器，會被問到之後更新的主題，並標示有更新 | 瀏覽器留著清單之前的導覽版本 20 時，導覽不會自己打開，首頁說有六個主題更新了；**看看**打開**準備一位 agent**，**認識 Harness Relay** 已打勾，其他五個還沒看的主題在清單上標示**有更新**；版本 45（清單之前的最後一版）則什麼都不問。 |
| 主題的按鈕會帶你到它說的地方，並關閉導覽 | **開始新對話**關閉導覽並打開新對話（`#/new`）；**連接手機**關閉導覽並打開**設定 → 連接手機**，捲動到看得見的位置。 |
| 在手機上，導覽是貼齊底部、一次顯示一個主題的面板，全部主題會顯示清單 | 在 390×844 下，面板貼齊螢幕底部，**下一步**在面板內，清單隱藏；**全部主題**改顯示清單，目前的主題取得焦點；點選主題就顯示它，**下一步**取得焦點，面板仍貼齊底部。 |
| 在很矮的手機上，圖先讓出空間，主題的內容在按鈕之上捲動 | 在 390×300 下，**團隊工作時**沒有圖，貼齊螢幕底部，**下一步**在面板內；內容可以捲動（**下一步**有焦點時按 End 也行），按鈕上方出現分隔線，下一個主題則從頂端開始。 |
| 在手機上，導覽打開時從下往上滑出一次（從設定重新觀看也是），停在螢幕底部，減少動態效果時不播放 | 在 390×560 下打開，面板從螢幕下方（`translateY(100%)`）往上滑出、背後的遮罩從透明淡入（主題的圖與打勾的轉場除外），只改變 `transform` 與 `opacity`，兩者都會自己結束；之後面板的底部貼齊螢幕底部，**下一步**在畫面內且有焦點（面板還在螢幕下方時就讓**下一步**取得焦點，不會讓它移位）；換到下一個主題時仍是同樣已播完的動畫，不會重播；**設定 → 使用導覽 → 重新觀看導覽**會再播一次（開始時間較晚），面板一樣停在底部；開啟減少動態效果時完全沒有動畫，面板一樣在底部。 |
| 在寬螢幕上，每個主題的卡片大小與「下一步」位置都相同 | 在 1280×800 下，導覽裡除了主題的圖之外沒有任何動畫；從清單逐一點選每個主題，卡片高度與**下一步**（或**完成**）的位置都一樣。 |
| 歡迎主題的圖：請求進去、結果出來，畫出一次後靜止 | 在 1280×800 下，歡迎主題在卡片標題列與主題標題之間顯示這張圖，高度超過 180px，螢幕閱讀器不會讀它，圖裡也沒有文字：左上是你的請求，中間是 Harness Relay 的標誌（logo 的三個圓點），右下是結果：新增兩行、刪除一行，還有一個勾。它的動畫只改變 `transform`、`opacity` 與箭頭的虛線位移，而且都會自己結束：每個部分都就位，箭頭與箭頭尖端都畫好，每一行都寫完整，光圈消失。下一個主題改顯示它自己的圖；開啟減少動態效果時，再點回歡迎主題，圖會立刻以靜止的最終狀態出現，沒有任何動畫。 |
| 每個主題都有自己的圖，沒有文字，最後會靜止 | 從清單點選七個主題，每個都只顯示一張圖（各自的 `data-art`，七張都不同），螢幕閱讀器不會讀它，圖裡沒有文字，動畫在十秒內全部結束。 |
| 圖佔用主題上方的空間，空間太小時就不顯示 | 在 1280×440 下，卡片被裁成螢幕的高度，圖縮到比最大尺寸（216px）小，放在卡片標題列與主題標題之間，內容不捲動；在 1280×320 下圖會隱藏；在 390×844 下，手機的面板會替它留空間，放在**全部主題**與標題之間，主題的內容不捲動。 |
| 在設定中選的深色或淺色會套用到頁面，重新載入後保留，且優先於系統 | 深色會設定 `data-theme`、背景與 `theme-color` meta，重新載入後仍在；系統是深色時，淺色仍維持淺色。 |
| 跟隨系統時會跟著系統的淺色或深色模式 | **跟隨系統**會移除 `data-theme`，頁面在開著時與重新載入後都跟著模擬的淺色或深色模式。 |

## 通知與提示音

[`notifications.spec.ts`](specs/notifications.spec.ts)：**設定 → 通知與提示音**、團隊回覆完或需要使用者時頁面怎麼做，以及伺服器保存、在側邊欄鈴鐺後面的通知收件匣。瀏覽器的通知與提示音由替身記錄（`Notification`、`AudioContext`，以及模擬視窗被擋住的 `document.hasFocus()`），在 app 的程式之前就設定好；這個瀏覽器也沒有推播服務（拿掉 `PushManager`），所以由頁面自己告訴使用者，就像桌面 app 的視窗。團隊是一個 Claude 成員。收件匣情境會開啟既有的空白自動組隊對話，確認畫面沒有組隊介紹後送出第一個問題。

| 情境 | 檢查的內容 |
| --- | --- |
| 設定會詢問瀏覽器、播放提示音試聽，並傳送測試通知 | 沒有推播時說明頁面開著時才會通知；**顯示系統通知**開啟前（開啟時會請瀏覽器允許）**傳送測試通知**不能按；**播放提示音**會先播一次；測試會跳出靜音的通知並播放提示音；重新載入後選擇仍在。 |
| 視窗被擋住時，等待確認的團隊與回覆完成都會跳出通知，點一下會打開對話 | 首席 agent 的團隊等待確認（「…等你確認」）與回覆（「Claude finished replying」加上回覆的開頭），標題都是對話標題、tag 都是那個對話、都是靜音，並分別播放三個音與兩個音；在首頁點其中一則會打開對話。 |
| agent 的提問會跳出通知，附上它問的內容 | `e2e:ask`：「Claude asked you something」與問題；提示音關掉時不播放。 |
| 正在看的對話不通知，其他對話只播放提示音 | 視窗有焦點、正在看的對話回覆完：什麼都沒有。顯示首頁時才結束的慢回覆（`e2e:slow=5`）：只有提示音，沒有通知。在設定裡兩者都關掉：什麼都沒有。 |
| 鈴鐺收著團隊說的話：有幾則未讀、列表、點一則打開它的對話並標為已讀，以及清除全部 | 通知與提示音都關掉、視窗被擋住時，鈴鐺在 **收合側邊欄**（Collapse sidebar）左邊，名稱是 **Notifications**（通知）；伺服器查看過之後（它每 1.5 秒讀一次狀態），等待確認的團隊讓它變成 **Notifications (1 unread)**，回覆讓它變成 **Notifications (2 unread)**、紅色數字是 **2**，而且沒有跳出任何系統通知。在首頁打開它的對話框，寫著 **2 unread**，兩則都以粗體列出、最新的在前：先是附上對話標題、「Claude finished replying」與回覆內容的回覆，再來是「The lead agent's team is ready for you to confirm」。點那則回覆會打開它的對話並關掉對話框；紅色數字消失，伺服器上兩則都已讀。再打開時兩則都沒有未讀標記，**全部標為已讀**（Mark all as read）不能按；**清除全部**（Clear all，確認後）留下「No notifications yet.」，伺服器上也沒有了；按 Escape 關掉，焦點回到鈴鐺。 |
| 畫面上的對話來的消息立刻標為已讀；全部標為已讀把其餘的標為已讀；側邊欄收合時，鈴鐺在展開按鈕的右邊，展開按鈕留在角落 | 視窗有焦點時畫面上對話的回覆，記下時就是已讀，鈴鐺仍是 **Notifications**。顯示首頁時才結束的慢回覆（`e2e:slow=5`）維持未讀（**Notifications (1 unread)**）。側邊欄收合時，左上角先是 **展開側邊欄**（Expand sidebar），帶著紅色數字 **1** 的鈴鐺在它右邊；對話框的 **全部標為已讀** 讓未讀的一則都不剩，鈴鐺的名稱回到 **Notifications**；**關閉**（Close）關掉它，展開後側邊欄裡的鈴鐺也是 **Notifications**。 |

## 環境變數設定的上限

[`limits.spec.ts`](specs/limits.spec.ts)：用 `RELAY_MAX_TEAM_AGENTS=2`、`RELAY_MAX_ACCOUNTS=2` 與 `RELAY_TURN_TIMEOUT_MIN=90` 啟動的伺服器。

| 情境 | 檢查的內容 |
| --- | --- |
| 團隊編輯器到上限就不能再加成員，伺服器也拒絕更多 | `GET /api/limits` 回傳這三個值；第二位成員之後 **＋** 按鈕都停用；三位成員的範本以 400 拒絕。 |
| 人數超過上限的範本說明它為何不能用，首席 agent 也不會選它 | 「三方辯論」說明一個團隊最多兩位成員；首席 agent 選它時，卡片說明原因，改用截成兩位的「一般問題智囊團」（Analyst 與 Critic）。 |
| 排程的說明顯示回合逾時 | 選**詢問我**（Ask me）時，新自動任務頁說明 agent 每回合最多等 90 分鐘。 |
| 設定到上限就不能再加帳號 | 第二個帳號之後，**新增帳號**（Add an account）停用並說明原因。 |

## 語言

[`i18n.spec.ts`](specs/i18n.spec.ts)

| 情境 | 檢查的內容 |
| --- | --- |
| app、範本與首席 agent 的卡片都是中文，agent 收到英文 prompt | 在 zh-TW 下，首頁的標語、新對話頁、內建範本、必填的問題欄位、送出按鈕與團隊卡片都是中文，而回合的 prompt 是英文（見 [AGENTS.md](../AGENTS.md) 的「Prompts and languages」）。 |
| 登入頁與伺服器自己的訊息跟著語言 | 登入頁與伺服器對錯誤代碼的訊息都是中文。 |
| 只抓取顯示的語言，和頁面自己的檔案一起；另一種在選了之後才抓 | 頁面的 head 會要求記住的語言的檔案（`modulepreload` 連結），而且只抓取這種語言；在設定裡選繁體中文時才抓它，重新載入後 head 就改要求它。 |
| 選了文字載入不了的語言：頁面為它重新載入一次，之後說明原因並維持原樣 | 中文的檔案不見時（404），選繁體中文會讓頁面重新載入一次；再選一次會說無法載入，而且仍選著 English；檔案回來後重新載入，頁面就會切換。 |
| 在桌面 app 自己的視窗裡，頁面在打開時與每次選擇語言時告訴 app 它顯示的語言 | User agent 裡有 Electron（就像 app 的視窗）時，登入後送出一次 `PUT /api/desktop/lang`（`en`），在設定裡先選繁體中文再選 English，也各送出一次（沒有 app 時伺服器回答 200）。 |
| 其他瀏覽器（例如手機）從不告訴 app | User agent 裡沒有 Electron 時，重新載入與選繁體中文都不會送出 `PUT /api/desktop/lang`。 |
| 頁面自己的文字載入不了時重新載入一次，之後用兩種語言說明 | 分頁第一個頁面（登入連結）就沒有英文的檔案時（載入過這個檔案的頁面可能從 WebKit 的記憶體快取拿到它，測試攔不住），頁面重新載入一次，之後用中文與英文說無法載入，並有重新載入的按鈕；檔案回來後，按鈕會把頁面找回來，並完成登入。 |

## 在手機上

[`mobile.spec.ts`](specs/mobile.spec.ts)：Pixel 7 的螢幕與觸控，就像透過 Tailscale 使用聊天時一樣。Firefox 沒有行動裝置模擬，所以跳過。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 從電腦首頁連接手機 | — | 側欄和收合後的首頁入口可直達「連接手機」內的配對操作。登出仍在「已登入的瀏覽器」中。手機能切換 Android／iPhone 圖解並開啟通知設定，關閉網頁、登出後電腦端狀態會更新。 |
| 安裝 Tailscale 後配對 | — | 下載碼與登入碼分開；用帶有 8443 port 的模擬分享位址產生連結，獨立瀏覽器用真實代碼登入一次。 |
| 遺失送出回應、核准與下載 | Claude Code | 任務送達後切斷回應，重新送出只執行一次。手機斷線時另一個用戶端核准，模擬通知開啟後取得最新結果並下載報告。 |
| 從選單開啟側邊欄，以觸控使用對話 | Grok | 選單按鈕的三條線（圖示）在按鈕正中央，誤差在十分之一個像素內；按**開啟側邊欄**（Open sidebar）前側邊欄不在畫面上，前往別處時又會收起；送出按鈕會送出（觸控螢幕上 Enter 是換行）；標題列的動作收在**更多**（More）之下。 |
| 向右滑打開側邊欄、向左滑收起；捲動、在訊息框中或在寬螢幕上滑動不會，寬螢幕會收起它 | Grok | 觸控事件從頁面送到手指底下的元素（Playwright 的觸控螢幕只能點；WebKit 沒有 `Touch` 建構式，所以在那裡和 Playwright 一樣用 `document.createTouch` 建立）：在對話中橫向 60px、往上 150px 的移動，側邊欄維持收起；從對話中間（不是螢幕邊緣）向右滑會打開它；側邊欄完全滑出後在它上面向左滑，以及在它右邊變暗的頁面上向左滑，都會收起它；從訊息框開始向右滑不會打開它；在手機寬度下打開後，螢幕變成 1000px 寬會收起它，在那裡滑動沒有作用，回到手機寬度時它是收起的。 |
| 快速輕滑會打開側邊欄；慢慢的短距離拖動、被取消的觸控、長按、第二隻手指、對話框或選取的文字不會 | Grok | 向右 40px（不到滑動的 50px）一次送出就是輕滑，會打開側邊欄（向左輕滑會收起），同樣的 40px 被取消（`touchcancel`）則沒有作用，慢慢移動、放開前停 150ms 也沒有；手指停 450ms 才移動（長按），以及滑動中加入第二隻手指，側邊欄都維持收起；選取了訊息的文字時滑動沒有作用，但在訊息框中選取的文字，不論它有沒有焦點（這時 Chromium 仍把它當成選取），都不會擋住滑動；**檔案**開著時在它上面，或在它旁邊變暗的背景上滑動，都沒有作用，關上之後滑動會打開側邊欄。 |
| 在左右捲動過的程式碼區塊上滑動由程式碼區塊處理，在影片上滑動由影片處理 | Grok | 一則回答有比手機寬得多的程式碼區塊（`e2e:widecode`）和工作目錄中的影片（534 位元組的 WebM）：捲動了 120px 的程式碼區塊自己處理向右滑，捲回開頭後，滑動會打開側邊欄；在載入好的影片上、它的控制列所在處滑動（整個影片都自己處理這次移動），側邊欄維持收起。 |
| 用瀏覽器自己的觸控，滑動與輕滑會打開、收起側邊欄，在左右捲動過的程式碼區塊上則是把它捲回去 | Grok | 只在 Chromium：觸控透過 Chromium 的 DevTools 協定（`Input.dispatchTouchEvent`）送出，瀏覽器會像對真正的手指一樣判斷點到哪裡、跟著捲動；事件的時間是指定的（相隔 8ms），所以速度不受電腦快慢影響：150px 的滑動會打開側邊欄，在它旁邊向左滑會收起；32ms 內 40px 的輕滑會打開它、向左輕滑會收起，400ms 內 40px 則維持收起；在捲動了 120px 的程式碼區塊上向右滑會把它捲回去，側邊欄維持收起，捲到開頭後滑動就會打開它。 |
| 導覽開著時滑動，側邊欄維持收起，關閉導覽後滑動就會打開 | — | 導覽開著（`tour: true`）時在它上面滑動沒有作用；按**關閉導覽**（×，Close the tour）後，在頁面上滑動會打開側邊欄。 |
| 對話的釘選按鈕不用滑過就顯示，點一下就釘到群組上方 | Grok | 從別的頁面打開側邊欄時，對話的**釘選**（Pin）不用滑過就顯示（opacity 1）；點一下後它列在**已釘選**（Pinned），兩列都顯示**取消釘選**（Unpin）；點已釘選那一列的標題會打開對話並收起側邊欄，釘選按鈕只蓋住它的角落。 |
| 選單按鈕會告訴你有未讀通知；從抽屜裡的鈴鐺打開一則通知會收起抽屜，正在看的對話也一樣 | Grok | 視窗當作被別的視窗擋住（正在看的對話不會自己標為已讀），Grok 回覆後選單按鈕變成**開啟側邊欄（1 則未讀通知）**（Open sidebar (1 unread notification)），上面有小紅點；抽屜裡的鈴鐺是**通知收件匣（1 則未讀）**（Notifications (1 unread)），有數字；在對話框裡點那則回覆的通知（就是正在看的對話），對話框和抽屜都會收起，選單按鈕的名稱和小紅點也恢復原樣。 |
| 很長的訊息不會讓頁面左右捲動 | Claude Code | 300 個字元的單字與 Markdown 回答都不會造成左右捲動。 |
| 回答後的長指令保持一行，點開可看完整指令，頁面不會左右捲動 | Claude Code | 點一下允許之後（`e2e:approve=long`），那一行並排顯示指令的第一行與 **Allowed**；點開後完整指令在框內換行；收起或展開時頁面都不會左右捲動。 |
| 以觸控在「檔案」中為 CSV 檔加一列，畫面不會左右捲動 | Claude Code | 從**更多 → 檔案**（More → Files）打開，列表提供**新增檔案**（New file）與**上傳檔案**（Upload files）；打開 `queue.csv`，點**編輯**（Edit），在文字框中加一列，頁面與「檔案」對話框都不會左右捲動（最多一個像素），**儲存**（Save）寫入檔案，**返回列表**（Back to the list）回到列表。 |
| 往上捲之後，回到最後的箭頭在訊息框上方中間，點一下就把對話帶到那裡 | Claude Code | 長回覆（`e2e:long`）往上捲 800px 後出現箭頭，與訊息框置中對齊（誤差一個像素內）、在它上方，顯示的圓形是 36px，手指可點的範圍是 48px（圓形四邊外 5px 仍是箭頭）。點一下對話回到最後、箭頭消失，手機的鍵盤維持原狀：沒有焦點的訊息框仍然沒有，有焦點的則保有焦點。 |
| 很窄的手機上，範本編輯視窗和團隊設定不會左右捲動，新增成員卡列出所有 CLI | — | 在 320px（比 290px 的成員卡加上邊距還窄）和 280px（英文的 **hand-offs / message** 會自己換到下一行）下，內建接力範本的編輯視窗和接力對話的**團隊設定**左右捲動都不超過一個像素；只有一欄時，新增成員卡全部列出所有 CLI，不必自己捲動。**團隊設定**裡的四種權限維持在同一列，在列內左右捲動。 |
| 很窄的手機上，語音輸入的語言維持一列、可以左右捲動，兩種語言都是 | — | 在 320px 和 280px、英文與中文介面下，**設定 → 語音輸入**的四種語言都在同一行，每個名稱完整不換行；列本身可以左右捲動，頁面不會。 |
| 很窄的手機上，任何一種新排程都不會左右捲動（兩種語言），對話的排程也不會 | — | 在新自動任務頁，每一種排程方式在 320px 和 280px 下、英文另外在 400px 和 430px、中文另外在 250px 和 360px 下，都沒有東西會左右捲動。兩種語言在 250px 展開團隊範本也不會左右捲動。建立頁的時間選單在各種寬度下都會顯示選定的觸發方式。一週七天在英文 320px、280px 與中文 280px、250px 時排成兩列，其他時候一列。選**每隔幾小時**時，間隔的單位只有「小時」，說明另起一行，並且是小時數字框的無障礙說明。選**當某件事發生時**時，**再等一件事**把第二件要等的事放在自己的框裡、附上**移除**，在這些寬度下仍然不會左右捲動。對話的**自動任務**抽屜選**每週**時，在 320px 和 280px 下也不會左右捲動；儲存為這一列最後的**每隔幾小時**後，在 280px 再打開時，它在這一列的可見範圍內。 |
| 首頁的標語變小，每一行都不換行，點 logo 會收起側邊欄 | — | 標語小於 22px，英文兩行、中文一行，頁面不會左右捲動；在首頁點側邊欄的 **Harness Relay** 會收起側邊欄。 |

## 各 CLI 一覽

每個 CLI 都測到的情境（大多是每個 CLI 一個測試，其餘用有登入的七個或五個開源 agent 組成的團隊），所以某個轉接器的改變會在這裡看出來：在 Linux 與本機上十二個都測，在 CI 的 macOS 與 Windows 上則是各自執行方式不同的 CLI（[平台與瀏覽器](#平台與瀏覽器)）。有自己登入的 CLI：

| 情境 | Claude Code | Codex | Grok | Cursor | Antigravity | Copilot | Muse Code |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 思考、工具呼叫與待辦清單 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| subagent 的呼叫摺進啟動它的那次呼叫，以及 CLI 對自己這次執行的附註 | ✓ | — | — | — | — | — | — |
| 設定頁的方案用量 | ✓（5 小時與每週額度） | ✓（5 小時與每週時段） | ✓（這週的點數） | 只有方案 | ✓（用 API key：沒有方案，從不詢問 agy） | ✓（以次數計的 premium 請求） | ✓（訂閱額度） |
| 允許指令，以及附註後拒絕 | ✓（以及回答後摺起來的長指令） | ✓（沒有附註） | ✓ | ✓（丟掉附註） | ✓（被拒絕就結束回合） | ✓（編輯模式下的 `npm publish`；被拒絕就結束回合） | ✓（丟掉附註） |
| 首席 agent 審查期間，CLI 自己撤回的請求 | ✓ | — | — | — | — | — | — |
| 背景子代理的請求在這一輪回覆之後才回答 | ✓ | — | — | — | — | — | — |
| 完全存取：不詢問就執行並寫到任何地方 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 唯讀對話不寫入任何檔案 | ✓（沒有檔案工具） | ✓（詢問後被拒絕） | ✓（詢問後被拒絕） | ✓（被自己的規則拒絕，沒有卡片） | ✓（詢問後被拒絕；結束回合） | ✓（被它的沙箱拒絕，沒有卡片） | ✓（沒有檔案工具） |
| 對話沒有的資料夾碰不到 | ✓（詢問後被拒絕） | ✓（詢問後被拒絕） | ✓（詢問後被拒絕；不在 Windows 上） | ✓（詢問後被拒絕） | ✓（詢問後被拒絕；結束回合） | ✓（它的沙箱不詢問就拒絕） | ✓（檔案工具拒絕，它接著試的指令被沙箱拒絕） |
| 使用者允許後寫到那裡 | ✓ | ✓ | —（它的沙箱會拒絕） | ✓ | ✓ | —（它的沙箱不詢問就拒絕） | —（它在那裡什麼都不詢問） |
| 多個工作目錄：每個都寫一個檔案 | ✓ | ✓ | ✓ | ✓（第二個先詢問） | ✓ | ✓ | ✓ |
| 工具庫的 MCP 伺服器，秘密不在命令列上 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| HTTP MCP 伺服器與它的標頭 | ✓ | ✓ | ✓ | ✓ | —（不提供） | ✓ | ✓ |
| 工具庫 HTTP MCP 伺服器自己的登入（登入頁面在另一台主機時先經過確認）：存取權杖放在伺服器的 `Authorization` 標頭，登入失效後那一回合不給它 | ✓ | — | — | — | — | — | — |
| 團隊檢查：找出受保護檔案和是誰發言時改的、擋住等待的訊息、略過、重新檢查、請成員修正、無法預覽的應用程式自動交回，指令（完整權限，和在 Harness Relay 自己的沙箱裡），以及平行模式的結果在仍要套用前不套用 | ✓ | — | — | — | — | — | — |
| 接手瀏覽器（`browser_hand_over`）：用滑鼠、按鍵與觸控操作畫面串流、婉拒，以及從它的視窗（無頭模式）交回 | ✓ | — | — | — | — | — | — |
| 透過 gateway 使用 Harness Relay 自己的工具：郵件在待送出匣等到使用者按送出；完全存取以下，CLI 自己的詢問被代為回答、gateway 對 act 的卡片 | ✓ | ✓（透過本機 HTTP，完全存取以下） | — | — | — | ✓（透過本機 HTTP，完全存取以下） | — |
| 在設定中開放或關閉常用 App，以同一個聊天內的兩個回合核對工具是否可用 | ✓ | — | — | — | — | — | — |
| 已登入的 Drive 帳號可搜尋檔案，停用 Google 後會暫停存取。在完全存取中，Google 文件與 Obsidian 的提案等使用者確認才寫入，Teams 和 Slack 訊息等使用者按「送出」才張貼。 | ✓ | — | — | — | — | — | — |
| 在回覆中記下長期記憶、顯示成卡片，並提供給之後的對話 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 在卡片上提供密鑰，以及儲存固定指令、在 Harness Relay 自己的沙箱裡試跑、在執行中停止它，並從待送出匣執行 | ✓ | — | — | — | — | — | — |
| 從卡片和待送出匣核准改過的指令；會發布的指令試跑前先確認；只執行指令的提議自動任務 | ✓ | — | — | — | — | — | — |
| 回覆中給使用者的步驟：卡片被勾選並回覆，之後它先繼續 | ✓ | — | ✓（在它之後繼續） | — | — | — | — |
| 請使用者執行的指令：從卡片啟動、隱藏輸入，並回答它的密碼小幫手（不在 Windows 上） | ✓ | — | — | — | — | — | — |
| 附加的圖片 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 停止回答；協定之內的錯誤；失敗的回答與重試 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 訊息直接送進進行中的回合 | ✓ | ✓ | —（只有離線測試） | —（不能） | —（只有離線測試） | —（還不能） | —（還不能） |
| 下一回合接續自己的 session | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 設定中的版本與登入，以及未登入 | ✓ | ✓ | ✓ | ✓ | ✓（它的 Gemini API key；沒有時不提供登入，也不啟動 agy） | ✓ | ✓ |
| 在設定與側邊欄顯示未安裝 | — | — | ✓（錯誤的執行檔路徑） | ✓ | ✓ | — | — |
| 版本太舊不能執行：設定、側邊欄與它的回合，除了版本什麼都沒啟動 | — | ✓ | — | — | — | — | — |
| 從設定頁的卡片安裝，再移除 | — | — | 提供官方腳本（不執行） | — | — | ✓（用假的 npm） | — |
| 成員的模型與推理強度 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 在七個組成的團隊中：依序回答（照首席 agent 設計的方式，四人與三人一組）、編輯模式的變更、工具庫、各 CLI 存放 session 的資料夾 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 列出它自己的 skill，並在下一次執行時不載入 | ✓ | ✓ | ✓（信任資料夾之後） | — | — | — | — |
| 新增帳號自己的家目錄 | ✓ | ✓ | ✓ | ✓（用它的 API key） | ✓（用它的 API key） | ✓（登入狀態在它自己的家目錄中詢問） | ✓（用它的 API key） |
| 新增的帳號各自登出 | ✓ | ✓ | ✓ | —（只用 key） | —（只用 key） | ✓（透過 ACP） | —（只用 key） |
| 帳號的 API key 只交給那個帳號 | ✓ | ✓（透過 `codex login`） | ✓ | ✓ | ✓ | ✓ | ✓ |
| 伺服器自己的 API key 只交給預設帳號 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 伺服器環境變數裡別家的金鑰會擋下，也能從卡片傳過去 | ✓（傳過去，檢查它的執行） | ✓（列在提示裡） | ✓（擋下，檢查它的執行） | — | — | — | — |
| 移除新增的帳號 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| CLI 啟動前先詢問專案自己的設定 | — | — | — | — | ✓ | ✓（它專案的 hook） | — |
| 在 Windows 上透過 `.cmd` 啟動器啟動 | — | — | — | ✓（它自己的） | — | — | ✓（它自己的） |
| 它在 AgentsView 中的 session，放在對話的討論串底下 | ✓ | ✓ | — | ✓（由 Harness Relay 記下） | — | ✓（`copilot:<id>`） | ✓（`muse:<id>`） |

開源 agent，在完全存取以外於 Harness Relay 自己的沙箱中執行：

| 情境 | OpenCode | Goose | Cline | OpenHands | Pi |
| --- | --- | --- | --- | --- | --- |
| 在完全存取以外執行（其他地方只能以完全存取執行，要求較低權限時會說明） | macOS | macOS、Linux | macOS、Linux | macOS（要打開終端機開關，關掉時也有測）、Linux | macOS、Linux |
| 思考、工具呼叫與待辦清單 | ✓ | ✓ | ✓（沒有待辦清單） | ✓ | ✓（gate 的計畫工具） |
| 允許指令，以及附註後拒絕 | ✓ | ✓（`env echo`） | ✓（丟掉附註） | ✓（丟掉附註） | ✓（編輯模式下的 `npm publish`，透過它的 gate） |
| 完全存取：不詢問就執行並寫到任何地方 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 唯讀對話不寫入任何檔案 | ✓（詢問後被拒絕） | ✓（詢問後被拒絕） | ✓（詢問後被拒絕） | ✓（詢問後被拒絕） | ✓（沒有寫檔的工具） |
| 唯讀對話中允許的寫入，被沙箱拒絕 | ✓ | ✓ | ✓ | ✓ | —（沒有寫檔的工具） |
| 對話沒有的資料夾碰不到（由沙箱拒絕） | ✓ | ✓ | ✓ | ✓ | ✓ |
| 使用者允許後寫到那裡 | — | — | — | — | — |
| 這次執行不能連的主機會先詢問，並被拒絕 | ✓ | ✓ | ✓ | ✓（編輯模式下） | ✓（編輯模式下） |
| 多個工作目錄：每個都寫一個檔案 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 工具庫的 MCP 伺服器，秘密不在命令列上 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 透過 gateway 使用 Harness Relay 自己的工具，經由本機 HTTP：郵件在待送出匣等待 | ✓（macOS 上也在完全存取以下） | — | — | — | — |
| HTTP MCP 伺服器與它的標頭 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 在回覆中記下長期記憶、顯示成卡片，並提供給之後的對話 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 附加的圖片 | ✓ | ✓ | —（只有路徑） | ✓ | ✓ |
| 停止回答；協定之內的錯誤；失敗的回答與重試 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 訊息直接送進進行中的回合 | —（還不能） | —（只有離線測試） | —（還不能） | —（還不能） | —（只有離線測試） |
| 下一回合接續自己的 session | ✓ | ✓ | ✓ | ✓ | ✓ |
| 設定中的版本與「可使用」，用假端點 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 沒有模型來源時還不能用 | ✓ | — | — | — | — |
| 從設定頁的卡片安裝 | — | 提供 Git Bash 並在安裝後更新卡片（模擬） | 安裝失敗與取消（用假的 npm） | — | — |
| 成員的模型（端點的）與推理強度 | ✓（沒有推理強度） | ✓（`off`） | ✓ | ✓ | ✓ |
| 在五個組成的團隊中：依序回答、編輯模式的變更、工具庫、各 CLI 存放 session 的資料夾 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 在 Windows 上透過 `.cmd` 啟動器啟動 | ✓（npm 給程式的） | — | ✓（npm 給 Node 腳本的） | — | ✓（npm 給 Node 腳本的） |

預覽面板與 agent 使用的 CLI 無關。上述檔案與草稿情境使用 Claude Code，平行 worktree 另加入 Codex。

## 平台與瀏覽器

- 在[首席 agent 在團隊之外的協助](#首席-agent-在團隊之外的協助)裡，以開源 agent 當首席的測試只在 Harness Relay 自己的沙箱能運作的地方執行（macOS，以及裝了 bubblewrap、socat 與 ripgrep 的 Linux）。
- [安裝 Git](#安裝-git) 在各測試平台模擬伺服器回應，測試缺少 Git 與 Windows Git Bash 的流程。
- [`.github/workflows/e2e.yml`](../.github/workflows/e2e.yml) 會在每個候選版本發佈前（發佈 workflow 會呼叫它；正式版本一定在它最新的候選版本發佈之後），以及每個碰到它們依賴的檔案的 pull request 上（`scripts/ci-scope.ts`：只改文件、單元測試、桌面 app 或網站首頁的 pull request 不會跑，維護者開的（`MAINTAINERS`）也不跑，他們的改動由候選版本那次執行測試；手動執行一定會跑），推送到 `main` 時不跑，以 Node 24 在 Ubuntu、macOS 與 Windows 上，並以 Node 22 在 Ubuntu 上，用 Chromium 執行所有 spec：每一種都分成兩個 job，各跑一半的測試（Playwright 的 `--shard=1/2` 與 `2/2`），讓每個 job 都不超過七分鐘多少。手動執行可以選擇其他瀏覽器；在本機則用 `E2E_BROWSERS=chromium,firefox,webkit`（[`playwright.config.ts`](../playwright.config.ts)）。在 Ubuntu 上它會安裝 Harness Relay 自己的沙箱需要的東西（bubblewrap、socat 與 ripgrep，以及讓 `/usr/bin/bwrap` 能建立 namespace 的 AppArmor 設定檔），在 Ubuntu 上先執行沙箱自己的檢查（`scripts/sandbox-check.ts`），並在那裡設定 `E2E_REQUIRE_RELAY_SANDBOX=1`，讓需要沙箱的測試失敗而不是跳過。
- 開源 agent 只在 macOS 與 Linux 上（Linux 需要 bubblewrap、socat 與 ripgrep）以完全存取以外的權限執行：在 Harness Relay 自己的沙箱不支援的 Windows 上，它們只能以完全存取執行，Linux 上的 OpenCode 也是。在那裡，與權限有關的測試會跳過它們並說明原因，其他測試以完全存取執行它們，而 [Harness Relay 自己的沙箱](#harness-relay-自己的沙箱)會檢查權限低於完全存取的對話不會啟動它們。在沒有這個沙箱的 Mac 或 Linux 電腦上，需要它的測試會跳過並說明原因（`E2E_RELAY_SANDBOX`，由 `global-setup.ts` 判斷一次）。
- 在 CI 上（`E2E_SYSTEM_CLIS=1`），每個 CLI 自己的測試在 Linux 上十二個都跑，在 macOS 與 Windows 上只跑 Harness Relay 在那裡的執行方式和 Linux 不同、而且它的假 CLI 看得出差別的 CLI（`support/clis/<cli>.ts` 的 `testedOn`，那裡寫了原因）；在其他系統上會跳過並說明在哪裡執行。**macOS**：五個開源 agent（Harness Relay 自己的沙箱在那裡由 Seatbelt 構成，OpenCode 只在那裡以完全存取以外的權限執行，還有 OpenHands 的終端機開關），以及代表有登入的七個 CLI 的 Claude Code，它們的假 CLI 在那裡做的事和在 Linux 上一樣。**Windows**：有登入的七個（Claude Code 沒有沙箱設定、Codex 沒有權限設定檔、Grok 的 `workspace` 設定檔、Cursor 的 session 以 junction 連進來、Antigravity 的家目錄以 `USERPROFILE` 傳給它、Copilot 的資料夾以 junction 連進來、Muse Code 的登入用複本，以及它的 PowerShell），OpenCode 與 Goose（用它們自己的 shell），以及 OpenHands（它的 PowerShell 終端機）；Cline 與 Pi 不在其中，它們在那裡只能以完全存取執行，和在 Linux 上以完全存取執行時一樣（[在 Windows 上是腳本的 CLI](#在-windows-上是腳本的-cli) 仍會在那裡啟動它們）。在本機沒有設定這個變數時，每個 CLI 的測試在每個系統上都跑；手動執行 workflow 並勾選 **every_cli**，macOS 與 Windows 上也會十二個都跑。
- OpenHands 在 macOS 上要在完全存取以外執行，需要沙箱裡的終端機：測試的伺服器會打開它的開關，而關掉開關的測試只在 macOS 上執行。
- OpenCode 在完全存取以下、經由沙箱對 gateway 連接埠的開放使用 Harness Relay 自己的工具，這個測試只在 macOS 上執行，也就是 OpenCode 能在完全存取以下執行的地方。
- [在 Windows 上是腳本的 CLI](#在-windows-上是腳本的-cli)只在 Windows 上執行。
- [使用者自己執行的指令](#使用者自己執行的指令)只在 macOS 與 Linux 上執行它的指令（`/bin/sh`）；在 Windows 上，它唯一的測試檢查卡片說明那裡不能執行。
- [團隊檢查](#團隊檢查)裡，未通過指令的測試和 hook 的測試在 Windows 上略過（那裡還不能執行指令檢查和 hook），在 Harness Relay 自己沙箱裡執行的兩個測試（一輪之後的指令，以及套用平行模式結果時的指令）只在那個沙箱能用的地方執行（macOS，以及裝了 bubblewrap、socat 和 ripgrep 的 Linux）。
- 在[安裝 CLI](#安裝-cli)中，Grok 的卡片在 macOS 與 Linux 上提供官方 bash 腳本，在 Windows 上提供它的 PowerShell 安裝程式；假的 npm 在每個系統上都照 npm 的方式安裝（macOS 與 Linux 上是連結，Windows 上是 npm 給程式的 `.cmd` shim）。
- 選擇資料夾視窗的測試只在 Linux 上執行：Linux 從 PATH 找它的視窗，假的視窗可以替代；macOS 與 Windows 以完整路徑開啟自己的視窗。
- 「對話沒有的資料夾碰不到」在 Windows 上跳過 Grok，因為它在那裡沒有沙箱（[各平台的作業系統沙箱](../docs/sandboxing.zh-TW.md)）。
- Copilot 在 macOS、Linux 與 Windows 上都以完全存取以外的權限執行，就像它自己的沙箱一樣：它的假 CLI 遵守這次執行的設定給的政策，所以它的測試不需要執行測試的電腦上有沙箱。
- [要使用者做的步驟](#要使用者做的步驟)的手機測試在 Firefox 中跳過，因為 Firefox 沒有手機模擬。
- [密鑰與固定指令](#密鑰與固定指令)：三個固定指令的測試在 Harness Relay 自己的沙箱不能執行的地方會略過（Windows；CI 上沒有 bubblewrap 的 Linux 會失敗，`E2E_REQUIRE_RELAY_SANDBOX=1`）。
- [在手機上](#在手機上)在 Firefox 中跳過；其中用瀏覽器自己的觸控的測試只在 Chromium 執行（觸控透過它的 DevTools 協定送出）。
- [修改對話的團隊](#修改對話的團隊)的新增成員卡測試，只在支援捲動驅動動畫的瀏覽器（Chromium、WebKit）檢查清單的陰影，因為其他瀏覽器沒有陰影：在 Firefox 中只檢查其餘部分。
- [複製與分享](#複製與分享)的兩個複製測試只在 Chromium 執行（要讀剪貼簿），「沒有 gh」在 Windows 上跳過，分享頁的下載測試則在 WebKit 中跳過：Playwright 下的 WebKit 不會下載連結打開的任何東西（在沒有框架的頁面、以附件送出也一樣）。
- [檔案與修改](#檔案與修改)中附加資料夾的測試，在 WebKit 只檢查送出標籤的下載檔名而不下載，因為 WebKit 在 Playwright 下不會下載連結開啟的任何東西；WebKit 的資料夾選擇器會自己略過名稱以點開頭的資料夾，所以它的標籤可能只列出略過了 `node_modules`；空資料夾那一步在 WebKit 也會跳過。
- [回報問題](#回報問題)中讀取郵件連結的四個測試，在沒有 Navigation API 的瀏覽器中跳過。
- [接手瀏覽器](#接手瀏覽器)在 Windows 上用 Playwright 的 Chromium 啟動對話的瀏覽器，而不是系統的 Chrome 或 Edge：它們在那裡的測試伺服器自己的家目錄下啟動不了（那裡沒有 AppData 資料夾）。

本機預覽情境使用 loopback 主機名稱，並把瀏覽器縮成手機寬度。WebKit 的本機驗證採用已兌換的票券、專屬隨機主機名稱及同 origin 的 Fetch Metadata。Linux CI 另啟用需 Docker 的面板測試：npm 的建置與後端、`Dockerfile` 應用程式、WebSocket 應用程式、終端機程式，以及 compose 應用程式。

## 沒有測到的部分

- **伺服器環境變數裡的金鑰，每個 CLI 拿到哪些的大部分。** 端對端測試列出 Claude Code、Codex 與 Grok 被擋下的金鑰，檢查 Claude Code 與 Grok 的執行，並把一個金鑰傳給 Claude Code（沒有檢查 Codex 的執行）。離線測試（`test/agent-env.test.ts`）涵蓋：七個有登入的 CLI 各自保留自己的金鑰、Codex 保留它的 `config.toml` 指定的、開源 agent 維持原樣、預設以外的帳號、GitHub 與雲端的 token 和網址類的變數從不擋下，以及清單在重新啟動後仍保留。
- **交接的視窗，以及完全存取以下的畫面串流。** 沒有 spec 會開出顯示在執行 Harness Relay 的電腦上的視窗（它以無頭模式開啟，`RELAY_HEADLESS_WINDOWS`），也沒有在視窗中通過 CAPTCHA：它的啟動參數與環境變數、在哪裡提供，以及交接的票在 `test/handover.test.ts`，並在 Mac 上手動試過（視窗開在那個網頁、`chrome://` 頁面與檔案會被送回、新分頁會被關閉、視窗關閉後登入的 session cookie 還在）。spec 也沒有在面板中回答新主機的詢問、真正的輸入法組字（它們直接插入文字）、貼上，或會把瀏覽器當成自動化瀏覽器的網站。
- **長期記憶的大部分。**端對端測試檢查記下、提供、擱置、還原、釘選與整理記憶，以及關閉記憶。以下情況在離線測試中涵蓋（`test/memory.test.ts`、`test/orchestrator-memory.test.ts`）：修正與 forget、等使用者確認的記憶（需確認）、使用者自己的記憶不讓 agent 改動、只適用一個資料夾的記憶、每個 session 只提供一次、自動整理與它的變更遵守的規則。
- **發布到真的 Render 與 Neon**：spec 用的是它們 API 的替身；以及透過 UI 發布後端、`Dockerfile` 或含 PostgreSQL 的 compose 檔（Neon 專案、用 `psql` 執行的初始化腳本、改寫的環境變數），這些由 `test/publish.test.ts` 用替身與真的 git 測試，`test/publish-initdb.test.ts` 用假的 Docker 測試（真的 `psql` 已手動試過）。
- **密鑰與固定指令的大部分。** 端對端測試只用 Claude Code 的 fake 提供密鑰、儲存試跑並分享固定指令、從待送出匣送出一次執行、從卡片和待送出匣核准改過的程式碼、確認會發布的指令的試跑、在卡片上停止執行中的指令（目前為止的輸出收起來），以及建立只執行指令的提議自動任務（自動任務到時間執行指令的部分，連同它的說明與核准，在離線測試裡）：區塊是伺服器讀的純文字，所以每個 CLI 的回覆讀法都一樣。離線測試涵蓋：區塊的各種寫法與哪些留作文字、遮蔽、儲存區（`test/handoffs.test.ts`），執行的沙箱、環境、密鑰檔與續期的值、執行中回報的內容、以 0 結束的執行被擋下的主機（以及卡片上的警告），以及在真的儲存庫上的鎖定（`test/fixed-commands.test.ts`），鎖定失效、自動任務的固定指令和它的各種結果（`test/orchestrator-handoffs.test.ts`），以及路由（`test/handoffs-api.test.ts`）。任何 agent 自己的沙箱都讀不到執行中的密鑰檔，靠的是轉接器（`agentProtectedReads()`），沒有在端對端測試裡試過。
- **步驟卡片的大部分。**端對端測試只用 Claude Code 的假 CLI 給步驟：區塊是伺服器讀取的純文字，所以每個 CLI 的回覆都以同樣的方式讀取。離線測試涵蓋：區塊的各種寫法與留作文字的情況（`test/steps.test.ts`）、平行與接力模式、只有步驟的回覆、旁邊的提問標記、重新啟動後的勾選與送不出去的回答（`test/orchestrator-steps.test.ts`）、路由拒絕的請求（`test/steps-api.test.ts`），以及分享頁面、複製與對話紀錄中的步驟（`test/steps-web.test.ts`）與 AgentsView 中的步驟（`test/agentsview.test.ts`）。
- **實機手機與正式網域。** 測試使用手機寬度的瀏覽器，另用測試用 HTTPS 設定驗證遠端模式。手機本身、DNS、憑證與代理仍需在部署環境中確認。真實 Docker 另有獨立檢查 `npx tsx scripts/preview-runtime-check.ts`，也在 Linux CI 執行。
- **完全存取下團隊做出的容器自動開始。** spec 試了自動開始的網頁，以及在完全存取以外會等待的 Dockerfile；完全存取下哪些模式會自動開始，由 `test/webPreview.test.ts` 測試。
- **Windows 與 macOS CI 上的容器預覽。** 它們的真實 Docker 測試在 Linux CI 與手動（macOS 上用 OrbStack）執行；經 Windows 具名管道的 Engine API 尚未試過。其他地方用模擬的串流測試面板的終端機。
- **團隊檢查的大部分。**端對端測試檢查編輯器、受保護路徑、指令與 hook，需要 CLI 時用 Claude Code 的替身。以下情況由離線測試涵蓋：commit 格式、平行模式成員的 worktree、停下來問使用者的一輪、首席 agent 審閱讀到結果、沒人看著的自動任務那一輪、範本的清單複製進對話、改到設定而擋下的指令、重新檢查時在背景執行指令，以及套用平行模式結果時在檢查樹裡（連進依賴）執行的指令，都在離線測試裡（`test/orchestrator-checks.test.ts`、`test/checks.test.ts`、`test/checkCommands.test.ts`），各 CLI 寫入受保護檔案也是（檢查讀的是磁碟，不管是誰寫的）。指令能開的兩個開放（macOS 的所有本機連接埠、Linux 的所有 Unix socket）只有手動試過，因為 `scripts/sandbox-check.ts` 不會執行檢查的指令。
- **每個 CLI 在兩個對話同一個資料夾時的情形，以及之後的事。**端對端測試讓 Codex 在團隊自己的 worktree 裡執行；每個 CLI 都能在 worktree 裡寫入，由[平行模式](#檔案與修改)的測試涵蓋。那裡的團隊檢查、首席 agent 審閱、倒回時丟掉它、多個資料夾、巢狀的 repository，以及自動任務在那裡的執行，由離線測試涵蓋（`test/orchestrator-workspace.test.ts`、`orchestrator-folders`、`orchestrator-checks`、`orchestrator-review`、`orchestrator-schedule`）。
- **實際安裝 Git。** 對話框測試模擬缺少 Git 與安裝程式的回應。`test/git-install.test.ts` 用替代程序確認各平台的安裝方式。
- **其他 CLI 的「直接送進進行中的回合」。**只有 Claude Code 與 Codex 的假 CLI 會把訊息收進進行中的回合；Grok 的 `x.ai/interject`、Antigravity 再送的 `session/prompt`、Goose 的 `_goose/unstable/session/steer` 與 Pi 的 `steer` 只在離線測試裡（`test/steer.test.ts`，共用 ACP 回合的 hook 在 `test/acp-turn.test.ts`），協調器在各模式的規則（平行模式要嘛全部、要嘛都不送）則用它的假 runner 測（`test/orchestrator-steer.test.ts`）。還沒有任何真正的 CLI 在測試裡收過這樣的訊息，實機測試也還沒有。
- **互動指令的大部分。**端對端測試從卡片啟動指令、隱藏輸入、回答它的密碼小幫手、取消它，並送出它的輸出。以下改由離線測試涵蓋（`test/interactive.test.ts`、`test/orchestrator-handoffs.test.ts`、`test/handoffs-api.test.ts`）：區塊的規則、工作目錄（從不替使用者選好；列出它的設定檔、hooks 和安裝的程式，多了別的或其中有改變時拒絕啟動）、自動化執行提議的卡片與別的對話的卡片、時間上限、資料夾的密鑰遮蔽、拒絕小幫手的問題，以及伺服器停止時留下的執行。真正的登入（`gcloud`、`npm login`）、`sudo -A`，以及透過小幫手的 ssh 與 git，都沒有端對端試過。
- **真正的首席 agent 判斷什麼是安全的（「替我核准」）。**假的首席 agent 依指令核准或標記；審查讀到什麼、何時不送審、時間限制、同時執行幾個，以及自動任務的執行，都在離線測試中涵蓋（`test/approvalReview.test.ts`、`test/orchestrator-approve.test.ts`、`orchestrator-schedule`）。真正的模型會怎麼決定，沒有測試。
- **版本太舊而不能執行的 CLI，大部分情況。** 端對端測試讓 Codex 的假程式變舊，檢查設定、側邊欄與它的回合。改在離線測試涵蓋（`test/cli-version.test.ts`、`test/providers.test.ts`、`test/usage.test.ts`、`test/cli-install-web.test.ts`）：版本的比較、最低版本與驗證過的版本及使用指南的對照、每個程式只讀一次版本、其他每個 CLI 的執行都一樣被拒、它的用量、模型、登入與登出都不去問，以及 Harness Relay 自己安裝的那份的**更新**。在太舊的 CLI 上按**安裝**或**更新**會真的下載它，所以沒有 spec 這麼做；真正的 Codex 0.27.0，以及從卡片安裝新版的 Codex，是手動試過的。
- **CLI 本身。**假 CLI 檢查的是 Harness Relay 這一端的協定；[實機測試](#實機測試)會手動試用真正的 CLI。CLI 改變它的輸出時，由轉接器測試錄下來的訊息（`test/claude.test.ts`、`test/codex.test.ts`、`test/grok.test.ts`、`test/cursor.test.ts`、`test/antigravity.test.ts`、`test/copilot.test.ts`、`test/muse.test.ts` 與開源 agent 的測試，後面這些重播從真正的 CLI 錄下的訊息）以及在 app 中試用真正的 CLI 發現；那些錄音是 adapter 當初所依據的版本，所以 CLI 的新版本要用 `scripts/cli-check.ts` 對真正的 CLI 手動檢查（[開發者指南「檢查 CLI 的新版本」](../docs/developer-guide.zh-TW.md#檢查-cli-的新版本)）。真的 CLI 是否只把 gateway 的權杖（HTTP MCP server 的 header）留在記憶體中，要用 `scripts/mcp-headers-check.ts` 手動檢查，不在這裡：假 CLI 只顯示 Harness Relay 把它放在 header 裡、不在任何參數中。
- **CLI 自己的沙箱。**Claude Code、Codex、Grok、Copilot 與 Muse Code 的假 CLI 是從 Harness Relay 給它們的設定，推算它們 CLI 的沙箱會允許什麼（Copilot 的從這次執行的設定推算，並且像 Copilot 那樣，用這些設定給的政策回答 `/sandbox policy`）；只有包住開源 agent 的 Harness Relay 自己的沙箱是真的。真正的 CLI 在完全存取以外不會寫到對話的資料夾之外，由實機測試（`live/sandbox.spec.ts`）試用。
- **AgentsView 本身。**它是 [`sessions.spec.ts`](specs/sessions.spec.ts) 中的替身伺服器，只回應 Harness Relay 的請求，從不讀 session 檔。真正的 AgentsView 是否在 Harness Relay 的執行留下 session 的地方讀到各 CLI 自己的 session、用的是不是 Harness Relay 連結的 id（包括 Copilot 的 `session-state` 與 Muse Code 的資料資料夾，在各 CLI 平常的家目錄，以及透過使用者說明中專用 AgentsView 的 `config.toml`），並把它們放在討論串底下，是用 AgentsView 0.46.1 手動試過的（Copilot 與 Muse Code 也用 copilot 1.0.109 與 muse 1.4.18 透過它們的 adapter 在 Linux 與 Windows 上寫的 session 試過）。
- **GitHub 對 gh 的真正登入。** 分享對話框的登入跑的是假的 `gh`，它印出一組代碼後等測試核准；gh 真正的裝置登入只用手動檢查過（沒有終端機時它會印出代碼與 `github.com/login/device`，不會開瀏覽器），沒有經過 GitHub 的核准。
- **真正的 GitHub 與網站上的分享頁。**測試從儲存庫的 `site/` 與測試自己的 gist 打開分享頁，都用真正的網址但由測試攔截：GitHub 原始檔主機與 API 本身（它們的快取與限制、改了名稱的帳號）和發布出去的網站沒有測，WebKit 中的下載也沒有；分享頁曾用使用情境的分享在 Chromium、Firefox 與 WebKit 中對真正的 GitHub 手動試過。gistpreview.github.io 上的連結（分享頁出現之前的分享）沒有打開。
- **長時間追蹤的目標。**執行失敗後的重試（5、30、120 分鐘）、被重新啟動中斷的執行，以及排程本身的時間，是在單元測試中用假時鐘測的（`test/orchestrator-tracking.test.ts`）；端對端測試只用**立即執行一次**跑一次追蹤目標的排程。
- **真實 OAuth 服務帳號。** 常用 App 透過服務替身測試授權與權杖交換。Teams 的瀏覽器測試會透過本機 Graph PowerShell 替身直接讀取資料，並在使用者確認後發文。單元測試也涵蓋 Drive 與 Teams 的讀取工具，以及既有 Slack 授權的更新。瀏覽器使用 Microsoft 登入與 Graph 的替身，以及 Google OAuth 頁面與 Docs API 的替身（[用 OAuth 登入的帳號](#用-oauth-登入的帳號)）；裝置代碼、貼上網址、被拒或過期的登入、權杖代理的更新、帳號移除後才回來的更新，以及透過 Graph 和用權杖透過 Google 的 CalDAV 使用的行事曆工具（對 Google 登入與 CalDAV 的替身），在 `test/oauth.test.ts` 中測試；透過 XOAUTH2 的郵件工具、郵件觸發與 IDLE、被拒的權杖的更新、為郵件登入的權限範圍、Google 的漸進式同意與 Gmail，在 `test/oauth-mail.test.ts` 中測試。在瀏覽器裡，透過登入的郵件只有登入與測試（沒有 agent 讀信或寄信），而且是以純 TCP 連到替身。這些測試不登入真的帳號：真的 Google 帳號（它的行事曆，以及 Gmail 接受它的權杖）是手動試過的，見架構文件的已知限制；Microsoft 的還沒有。
- **真正需要登入的 MCP 伺服器，以及它們登入的其他方式。** [需要登入的 MCP 伺服器](#需要登入的-mcp-伺服器)只對替身登入，而且只把權杖交給 Claude Code 的假 CLI（每個 CLI 怎麼拿 HTTP 伺服器的標頭，是[除了 prompt 之外交給各 CLI 的東西](#除了-prompt-之外交給各-cli-的東西)測的）。探索的其他形式（well-known 網址、OpenID 的中繼資料、challenge 的權限範圍）與它失敗的情形、各種拒絕（沒有 S256 的 PKCE、沒有註冊、別的資源或伺服器路徑上層的中繼資料、別的發行者、連到別台電腦的純 http、不要求登入的伺服器）、不在這台電腦上的伺服器（只連網際網路上的位址，用替身查詢位址，並固定連到查過的位址）、RFC 9207 的 `iss`、對兩個替身的混淆攻擊（冒充伺服器的中繼資料指向另一台授權伺服器的頁面：先經過確認，它的授權碼也絕不會送到冒充的權杖端點）、為另一個重新導向網址或在更新拒絕用戶端後重新註冊、用戶端密碼（登入、更新與撤銷時用 Basic 或放在表單）、貼上網址、沒有更新權杖的登入、其他原因的更新失敗、十分鐘以內的權杖、沒有拿到伺服器或用 Antigravity 的成員、主機規則、太大的回應或太長的權杖、撤銷失敗、登入取代舊登入時撤銷舊的更新權杖、移除伺服器或改網址、探索進行中時的等待上限，以及重新啟動，都在單元測試中測試（`test/mcp-oauth.test.ts`、`test/orchestrator-mcp-oauth.test.ts`）。
- **觸發的檢查頻率、行事曆來源、CI 執行，以及團隊自己寫的檔案。** [自動任務](#自動任務)用**立即檢查**來檢查，GitHub 只透過假的 `gh`（它的 pull request；從不連到真的 gh 與 GitHub）；每 2 分鐘一次、失敗後放慢、重新啟動後保留的狀態、團隊在資料夾裡寫的檔案（不會再啟動一次執行），以及兩個檔案樣式以外的多件要等的事（不同來源一起、各自的錯誤與放慢、同一次檢查送出兩則訊息、IMAP IDLE 只要求其中一件），在 `test/orchestrator-watch.test.ts` 中用假時鐘測試，IMAP 的部分（UIDVALIDITY、條件、一次很多封）在 `test/watch.test.ts`，即將開始的行程（對 CalDAV 行事曆替身，也包括會展開重複行程的，以及透過 OAuth 的）、失敗的 CI 執行（對 gh 的替身），以及還在寫的檔案在 `test/watch-sources.test.ts`，IMAP IDLE（在資料夾中等待的連線、重新開始與重新連線）在 `test/idle.test.ts`，沒有端對端測試。
- **真實服務帳號與郵件伺服器 TLS。** 單元測試使用本機未加密的 IMAP、SMTP 與 CalDAV 替身。若 STARTTLS 回應後還跟著其他資料，會在啟動 TLS 前拒絕（`test/connectors.test.ts`）。找得到 Chromium 時，瀏覽器工具會使用真的 Chromium 測試（`test/browser.test.ts`）。端對端測試透過 Claude Code 的假 CLI 經由 stdio 呼叫 `mail_send`，Codex、Copilot 與 OpenCode 則經由本機 HTTP 呼叫。Claude Code 的假 CLI 也會透過郵件、行事曆、瀏覽器、Google Drive、GitHub、Obsidian、Notion 與 Heptabase 工具讀取資料。Google 文件與 Slack 案例則涵蓋確認後寫入。確認流程使用本機替身或暫存筆記庫，不需要真實的雲端帳號。
- **Cursor 在暫存資料夾中不詢問就做的事。**真正的 Cursor 在暫存資料夾（`/tmp`、macOS 的 `/private/var/folders`）中寫入不會詢問；它的假 CLI 不會這樣，因為測試的資料夾都在暫存資料夾裡，否則寫到工作區之外的每個檔案都會不經詢問就寫入。也沒有 spec 試用 Cursor 團隊的自動執行允許清單（假 CLI 有一份，`E2E_FAKE_CURSOR_TEAM_ALLOW`）。真正的 Muse Code 的沙箱也讓它的指令寫入暫存資料夾；它的假 CLI 因為同樣的原因不會這樣。
- **CLI 真正的方案用量。**[方案用量](#方案用量)用替身的回答檢查 Harness Relay 這一邊；真正 CLI 的回答由 `test/usage.test.ts` 中從它們錄下的回答涵蓋，沒有 live 測試問真正的 CLI。Harness Relay 只用 Gemini API key 執行的 Antigravity 沒有方案用量可以詢問。錯誤訊息與面板的 zh-TW 文字由 `test/usage-web.test.ts` 涵蓋，不在這裡。
- **捲到對話最後的平滑捲動。**[捲動對話](#捲動對話)檢查箭頭把對話帶到哪裡，以及減少動態效果時立刻到達，不檢查平滑捲動途中的樣子。在最後展開訊息的某個部分、底下又多了內容時出現的箭頭，只有 `test/chat.test.ts` 測到；手機上的對話是用程式捲動，不是用手指。
- **使用導覽各張圖的樣子。**[使用導覽與主題](#使用導覽與主題)檢查歡迎圖的各個部分、尺寸、動畫與最後的狀態，以及每個主題都有一張沒有文字、最後會靜止的圖；它在淺色與深色、兩種語言、桌面與手機上的樣子，以及逐格的動畫，則是用眼睛確認的。
- **首頁 logo 動畫的流暢度。**[首頁](#首頁)檢查它只動 `transform` 與 `opacity`、只播一次；它由 Chrome 的 compositor 執行、頁面畫好之後不再重新排版或繪製，則是在 Chrome 的 trace 中手動確認的。團隊設計卡片上、組隊完成前不停旋轉的 logo 也一樣（[新對話與首席 agent 的團隊](#新對話與首席-agent-的團隊)檢查它沒有任何元素同時有兩個 `transform` 動畫，那樣 Chrome 兩個都不會交給 compositor）：它不再每一格都重新計算樣式，是手動量測的（Chrome 的 `RecalcStyleCount`，兩圈旋轉放在同一個元素上時每秒約 60 次）。app 的載入標示（`LogoSpinner`）也一樣：[agent 回答前做了什麼](#agent-回答前做了什麼)檢查只有它軌道的旋轉在動；同時十個時，頁面重新計算樣式的次數和沒有時差不多、也不重新排版，是手動量測的（兩秒內的 `RecalcStyleCount` 與 `LayoutCount`）。
- **推播通知與系統本身的通知。**[通知與提示音](#通知與提示音)用替身記錄它們；推播需要真正的推播服務（Google、Apple 的…），所以伺服器這一端（訂閱、加密、簽章、送出與保留什麼）由單元測試涵蓋（`test/push.test.ts`、`test/alerts.test.ts`、`test/push-api.test.ts`），頁面這一端由 `test/alerts-web.test.ts` 涵蓋，service worker 的處理程序則以替身的 `self` 由 `test/sw.test.ts` 涵蓋；瀏覽器向推播服務訂閱、真正的推播送到手機，則沒有任何測試走過。
- **OpenCode 與 Goose 的 token 和費用。** Harness Relay 從這兩個 CLI 自己的 SQLite 資料庫（`opencode.db`、`sessions.db`）讀取，它們的假 CLI 不保存這些資料庫，所以在這裡它們的回覆不顯示用量；轉接器的測試（`test/opencode.test.ts`、`test/goose.test.ts`）會對照真正 CLI 寫法寫成的資料庫跑完整的回合。
- **真正的首席 agent 會指出什麼。** 假首席 agent 的審閱總是標出第一則回覆開頭的幾個字；真正的模型給的 highlight 與下一步值不值得讀，這裡沒有測。它的 prompt，以及怎麼檢查它的回答（回覆裡沒有的引用會被拿掉、不認得的類型、上限），在單元測試中（`test/reviewer.test.ts`、`test/orchestrator-review.test.ts`）。
- **真正手機上的滑動。**[在手機上](#在手機上)大部分的滑動觸控事件是從頁面本身送出的，所以瀏覽器不會跟著捲動；有一個測試送出 Chromium 自己的觸控，瀏覽器會判斷點到哪裡並跟著捲動，但沒有測試有手機自己的手勢或觸控處理：從螢幕最邊緣開始的滑動（手機可能留給「返回」用），以及 Android 的 Chrome 從手指移動多遠開始送出移動事件（約 8dp；手指底下可捲動的區塊在它第一次移動時量），都沒有測試。
- **真正安裝沙箱需要的元件。**[沙箱需要的元件](#沙箱需要的元件)由測試代替伺服器回答：不會執行任何套件管理工具、sudo、pkexec 或 AppArmor。`test/sandbox-setup.test.ts` 涵蓋 Harness Relay 執行的東西（固定的腳本、它的環境變數、取得系統管理員權限的方式），並用 apt-get 與 apparmor_parser 的替身真的執行那個腳本；套件與桌面 app 的 Node.js 則在 Linux 與 macOS 上，透過打包好的桌面 app 與 `npm start` 的對話框真的裝過（[各平台的作業系統沙箱](../docs/sandboxing.zh-TW.md#由-harness-relay-安裝它們需要的東西)）。
- **從設定頁真正的安裝。**[安裝 CLI](#安裝-cli) 用的是假的 npm，不會連到 npm 套件庫、官方腳本或 uv，也不會連到 nodejs.org：PATH 上沒有 npm 時把 Node.js 官方版本放進 CLI 資料夾、再安裝 Claude Code、Codex 或 Copilot，由 `test/cli-install.test.ts` 涵蓋，它們的程式用那份 Node 啟動，由 `test/winLaunch.test.ts` 與 `test/process.test.ts` 涵蓋，並在 macOS、Linux 與 Windows 上手動試過。`test/cli-install.test.ts` 用假的電腦涵蓋 Harness Relay 交給它們的東西（參數、環境變數、資料夾，Windows 上的也有），每個 CLI 真正的安裝則在 Linux 上手動試過（Windows 的安裝程式還沒在 Windows 電腦上試過）。
- **桌面 app 自己的選單。**[語言](#語言)檢查 app 視窗裡的頁面（user agent 裡有 Electron）會把它的語言告訴伺服器；app 本身（Electron）不在這裡執行。伺服器轉送什麼、app 記住什麼，由 `test/app.test.ts`、`test/desktop-supervisor.test.ts` 與 `test/desktop-app.test.ts` 測試，選單換語言則在 app 裡手動確認過。
- **端點模型的上下文長度在執行中的作用。** [設定](#設定) 測儲存時會讀取它、並以使用者填的優先；各轉接器據此寫入的內容（OpenCode 的 `limit` 與清理、Goose 的 `context_limit` 與環境變數、Pi 的 `contextWindow` 與壓縮、OpenHands 的 condenser、Codex 與 Claude Code 的設定）由轉接器自己的測試檢查，因為假 CLI 不會壓縮。測試伺服器預設的端點 `e2e` 是沒經過模型檢查就設定的，所以它的執行拿不到上下文長度。
- **成員自己的上限在執行中的作用、首席 agent 依形狀回答，以及以 interrupt 停止 Claude Code。** 團隊編輯器的上限欄位由範本與團隊的測試檢查，但沒有假 CLI 會依上限或 JSON 形狀行動：各轉接器傳出的內容（`--max-budget-usd`、`--max-ai-credits`、`GOOSE_MAX_TURNS`、`steps`、`--json-schema`、`outputSchema`）與 Claude Code 在結束程序前的 interrupt 由單元測試涵蓋（`test/orchestrator-budgets.test.ts`、各轉接器的測試）。透過 Grok、Antigravity、Goose 與 Pi 的引導也由單元測試涵蓋（`test/steer.test.ts`）；只有 Claude Code 與 Codex 的假 CLI 會在回合中接收訊息。
- **「檔案」面板大部分的拒絕情況。** spec 測試了儲存時檔案已有較新版本、有任務在資料夾寫入時儲存，以及新檔案用了不合法的名稱；其他的在離線測試中涵蓋（`test/fileEdit.test.ts` 用真的資料夾，`test/files-edit-api.test.ts` 透過 HTTP）：路徑上的連結、`.git`、伺服器保留不給的檔案或 Harness Relay 的資料資料夾、成員的 worktree 與不允許可編輯模式的資料夾（列表的 `writable`）、唯讀檔案、某個系統不能用的名稱、超過上限的檔案，以及不是來自介面的請求。刪除只從列表試了一個檔案和一個資料夾；拒絕刪除根目錄、`.git`、保留不給的檔案、途經的連結資料夾、包含 Harness Relay 資料的資料夾、worktree 與有任務寫入的資料夾，以及連結只刪連結本身，都在同樣兩個檔案中離線測試。兩者都沒有測試其他程式在儲存或刪除最後一次檢查與改名或移除之間的瞬間改動資料夾，也沒有測試 Windows 上被其他程式開著的檔案（刪除時會回報只刪掉一部分）。
- **拖放的資料夾。** Playwright 無法拖放資料夾（它做出的 `DataTransfer` 只能放檔案），所以 spec 透過迴紋針的資料夾選擇器附加資料夾；一批一批讀取拖放資料夾的 entry、不進入 `.git` 或 `node_modules`、超過 1,000 個檔案就停止、讀不到檔案時失敗，都在離線測試中涵蓋（`test/attachments-web.test.ts`），伺服器對資料夾路徑的檢查也是（`test/attachments.test.ts`）。拖放的資料夾還在讀取時的標籤，以及送出會等它讀完，都沒有測試。自動任務附加的資料夾同樣在離線測試中涵蓋：保存與計算（`test/store.test.ts`）、透過 HTTP 儲存（`test/app.test.ts`），以及每次執行時寫出（`test/orchestrator-schedule.test.ts`）。
- **首席 agent 的草稿在固定回覆之外的部分**：假的首席 agent 對範本、團隊檢查、排程和群組建議都回固定的草稿，所以每個 prompt 告訴它什麼（要讀的專案、使用者時區的時間、帳號、分支家族），以及它可能寫錯的草稿（用不了的規則、沒設定的帳號、已過的時間、和現有群組同名），都在 `test/checksDraft.test.ts`、`test/scheduleDraft.test.ts`、`test/grouping.test.ts`、`test/planner.test.ts` 與 `test/orchestrator-drafts.test.ts` 裡；在分類群組的同一次執行裡替對話命名，以及使用者期間打的標題，也在那裡。
- **還沒有 spec 走過的功能**：agent 從「設定 → 實驗室」呼叫 `run_code`，以及它 RLM 模式的子模型（沒有假 CLI 會呼叫它：`test/runCode.test.ts` 跑它真的 runner，並透過真的 gateway 發出呼叫，`test/llmQuery.test.ts` 測子模型的請求，`test/cliSubModel.test.ts` 測透過 CLI 的問題，`scripts/cli-check.ts` 的 `toolless` 情境測真的 CLI 沒有工具的執行，`scripts/sandbox-check.ts --only run-code` 在真的沙箱裡跑 runner）；同時在第二個瀏覽器裡看通知收件匣（伺服器這一端由 `test/inbox.test.ts` 與 `test/inbox-api.test.ts` 測試，頁面這一端由 `test/inbox-web.test.ts` 測試）；實體麥克風與下載的引擎一起執行語音轉寫（自動任務的瀏覽器測試使用合成音訊與固定的轉寫結果）；分享的回答所連結的檔案，以及上傳回報的截圖（兩者都用 git 推送到 gist，假的 `gh` 沒有代替這部分）；作業系統金鑰儲存區中的 API key（測試會關掉它，所以 key 加密存在資料庫）；從設定登入 Codex、Grok、Cursor、Copilot 與 Muse Code（它們自己的登入流程；Copilot 的裝置登入由 `test/providers.test.ts` 測試），以及真正的 Codex 拿到 `codex login --with-api-key` 的 key 之後做了什麼；Copilot 沙箱的政策和這次執行設定的不一樣時，完全存取以外拒絕啟動（由 `test/copilot.test.ts` 測試）；Muse Code 詢問指令要不要連網（它的假 CLI 在沙箱中會為 `e2e:approve=publish` 詢問，但沒有 spec 送出這個指令），以及對話的權限改變或伺服器重新啟動後，Muse Code 的成員開新的 session（由 `test/muse.test.ts` 測試）；AgentsView 中首席 agent 與分類對話的 session 連結、設定網址後才送出的對話，以及 Harness Relay 為開源 agent 記下的成員 session（由 `test/agentsview.test.ts` 測試，Cursor 的也是，另有 spec 試過）；Claude Code 以外每個 CLI 的 subagent，以及 Codex、Grok、Copilot 與 Pi 對自己這次執行的附註（只有 Claude Code 的假 CLI 會送出：各轉接器的測試播放它的 CLI 的訊息，`test/codex.test.ts`、`test/grok.test.ts`（用替身等一個背景 subagent，以及它喚醒 Grok 的那一輪）、`test/cursor.test.ts`、`test/copilot.test.ts`、`test/pi.test.ts`）；Pi 和 Muse Code 的團隊 hook（它們的假 CLI 不會呼叫：`test/pi.test.ts` 跑 Pi 真的 gate，`test/muse.test.ts` 測 Muse Code 的設定和答案，`scripts/cli-check.ts` 的 hook 情境則用真的 CLI）；連不含 git 忽略的檔案都太大的 ZIP；以及桌面 app 視窗裡登入之後的部分（它自己的檢查 `desktop/scripts/smoke.ts` 與 `desktop/scripts/check-package.ts` 會開一個這些假 claude、codex 與 grok 的唯讀對話，讓每一個回答一個問題，在打包好的伺服器上與打包好的 app 裡都會跑：CI 在 Linux 與 Windows 上，發佈前則在每個系統上；那裡預覽的 **New tab** 以 Electron 的 user agent 和替身 `window.open()` 測試，視窗的防護把預覽網址交給預設瀏覽器則在 `test/desktop-app.test.ts`）。其中有些有單元測試，在 [`test/`](../test/) 裡，列在開發者說明的[測試](../docs/developer-guide.zh-TW.md#測試)。

## 實機測試

[`live/`](live/) 裡是第二套測試，`npm run test:e2e:live`，設定是 [`playwright.live.config.ts`](../playwright.live.config.ts)：真正的 CLI，用你自己的登入（Antigravity 只在設定了 `GEMINI_API_KEY` 時試用，這是它在 Harness Relay 唯一的登入方式），跑在真正的模型上，所以會花一點費用，也從不在 CI 上執行，不算在上面的數量裡。它預設試用全部十二個 CLI，環境沒有提供某個測試需要的東西時（一個端點，或各 CLI 自己的雲端模型所需的 `E2E_LIVE_CLOUD=1`），那個測試就會跳過：在 Mac 上，有一個端點時是三個檔案、48 個測試，再加上雲端模型並設定 `GEMINI_API_KEY` 時是 58 個（每個 `E2E_LIVE_MODEL_<CLI>` 再多一個；什麼都沒設定時列出 21 個，全部跳過）。它們涵蓋：每個 CLI 用在「團隊設定」中選的端點模型、在設定中把 CLI 的預設模型設為某個端點的模型、有登入的七個 CLI 自己的雲端模型（Claude Code、Codex、Grok、Cursor、Antigravity、Copilot 與 Muse Code 的）、成員用的端點被刪除、替端點手動輸入的模型、原生 Windows 上權限低於完全存取的開源 agent、雲端與本機模型一起組成的團隊、每個 CLI 用它的 shell 在對話的兩個工作目錄中各寫一個檔案（用端點的模型，有登入的七個也用它們自己的模型）、Cursor 用自己的檔案工具寫入第二個工作目錄、Antigravity 在指令被拒絕時結束它的回合，以及啟動前先詢問專案自己的 MCP 伺服器、Copilot 同樣在指令被拒絕時結束回合，以及啟動前先詢問專案自己的 hook，還有每個 CLI 在完全存取以外都不會寫到對話的資料夾之外。執行方式見開發者說明的[實機測試](../docs/developer-guide.zh-TW.md#實機測試)。

## 相關文件

- [開發者說明 → 端對端測試](../docs/developer-guide.zh-TW.md#端對端測試)：它們如何運作、fixture、假 CLI 與它們的 `e2e:` 指令，以及如何撰寫測試。
- [開發者說明 → 測試](../docs/developer-guide.zh-TW.md#測試)與[持續整合](../docs/developer-guide.zh-TW.md#持續整合ci)：單元測試與 CI workflow。
- [參與開發 → 測試](../CONTRIBUTING.zh-TW.md#測試)：測試的規則。
- [使用者說明](../docs/user-guide.zh-TW.md)：這些情境走過的功能，以使用者的角度說明。
- [架構](../docs/architecture.zh-TW.md)：伺服器如何做到它們檢查的事（[CLI 轉接器](../docs/architecture.zh-TW.md#cli-轉接器)、[權限對應](../docs/architecture.zh-TW.md#權限對應)、[安全性](../docs/architecture.zh-TW.md#安全性)）。
- [各平台的作業系統沙箱](../docs/sandboxing.zh-TW.md)：為什麼對話沒有的資料夾各 CLI 都碰不到，以及哪裡做不到。
- [開源 agent](../docs/open-agents.zh-TW.md)：它們的模型來源、權限，以及它們的假 CLI 在其中執行的 Harness Relay 的沙箱。
- [用手機連線](../docs/remote-access.zh-TW.md)：[在手機上](#在手機上)代表的使用情境。
- [開發者說明 → 實機測試](../docs/developer-guide.zh-TW.md#實機測試)：第二套測試，用真正的 CLI。
- 程式碼：[`playwright.config.ts`](../playwright.config.ts)、[`fixtures.ts`](fixtures.ts)、[`global-setup.ts`](global-setup.ts)、[`support/`](support/)（`relay.ts`、`app.ts`、`clis.ts` 與 `clis/` 裡各 CLI 的資料、`fake-cli.ts`、`sandbox.ts`）、[`fake-cli/`](fake-cli/) 與 [`specs/`](specs/)。
