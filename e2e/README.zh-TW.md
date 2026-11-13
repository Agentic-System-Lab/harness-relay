[English](README.md) | **繁體中文**

# 端對端測試的情境

端對端測試（`npm run test:e2e`）目前測到的情境，依功能分區列出。它們在真正的瀏覽器中（[Playwright](https://playwright.dev)）操作建置好的 UI，面對真正的伺服器，十二個 agent CLI 則各有一個假的代替（Claude Code、Codex、Grok、Cursor、Antigravity、Copilot、Muse Code，以及五個開源 agent：OpenCode、Goose、Cline、OpenHands 與 Pi），所以不連網路、不花費用，在 macOS、Linux 與 Windows 上的執行方式也一樣，只差在各系統的沙箱允許什麼（見[平台與瀏覽器](#平台與瀏覽器)）。

它們如何運作、怎麼執行單一測試、怎麼撰寫新測試，見開發者說明的[端對端測試](../docs/developer-guide.zh-TW.md#端對端測試)。這一頁是情境清單：新增、修改或刪除端對端測試時，請在同一個 commit 裡一起修改這一頁與[英文版](README.md)（見 [AGENTS.md](../AGENTS.md) 的「Documentation」）。

目前共有 31 個 spec 檔、391 個測試，在每個執行的瀏覽器中各跑一次（預設是 Chromium）。有些只在某些系統上執行，或只在 Harness Relay 自己的沙箱能運作的地方執行：見[平台與瀏覽器](#平台與瀏覽器)。

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

- **自己的伺服器**：使用空閒的 port，資料、家目錄與各 CLI 的家目錄（那個家目錄裡的 `.claude`、`.codex`、`.grok`、`.gemini`、`.copilot`、`.config/cursor`，以及 Muse Code 的 `.config/muse` 與 `.local/share/muse`，開源 agent 的則在資料資料夾裡）都在暫存資料夾裡，並關閉作業系統的鑰匙圈：不會讀取或更動你自己的 Harness Relay、CLI 或鑰匙圈，你的憑證（Cursor、Antigravity 與 Google 的也一樣）不會留在它的環境變數裡，git 找 repository 時也不會超出測試的資料夾（[`support/relay.ts`](support/relay.ts)）。在 macOS 與 Linux 上，它的資料夾放在 `/tmp`（或 `E2E_TMP_DIR`），路徑短到放得下 Harness Relay 自己的沙箱的 socket。
- **自己的假模型端點**：一個小 HTTP 伺服器，設成模型來源 `e2e`（**設定 → 模型來源**，Settings → Model backends），有 `e2e-model` 與 `e2e-model-mini` 兩個模型，每個開源 agent 的預設模型都設成 `e2e/e2e-model`，所以測試安裝的開源 agent 都可使用（OpenHands 的終端機開關也已打開）。那裡沒有模型會回答：它只列出自己的模型，並收下在 Harness Relay 自己的沙箱裡執行的假 CLI 送來的紀錄。測試可以不要它（`openBackend: false`）、關掉 OpenHands 的開關（`sandboxTerminal: false`），或讓某些 CLI 未安裝（`missingClis`）。
- **一個工作目錄**，裡面是一個小專案：`README.md`、`src/hello.ts` 與 `src/lib/math.ts`（`seedProject()`）。需要其他資料夾的測試會在它旁邊新增（`relay.addProject()`）。
- **已登入的瀏覽器頁面**：用一組新的一次性代碼登入，使用導覽已完成，介面為英文（[`fixtures.ts`](fixtures.ts)）。測試可用 `test.use()` 改變這些：`lang: 'zh-TW'`、`signIn: false`、`tour: true`，或給伺服器更多環境變數（`serverEnv`）。
- **假的 CLI**（[`fake-cli/`](fake-cli/)），十二個 CLI 各一個。測試的伺服器裝了 Claude Code、Codex 與 Grok，以及測試要用的 CLI（每個 CLI 各一的測試裝它自己，兩個團隊的測試裝它那一隊的，其他的用 [`support/clis.ts`](support/clis.ts) 的 `withClis()`）：其餘的在那裡都未安裝，因為每次開啟頁面時，伺服器會向每個已安裝的 CLI 詢問版本、登入、模型與它自己會載入的東西，每個大約啟動六次。它們說各 CLI 的協定，回答 `Hello from <名稱> (<CLI>). You said: “<使用者最新的訊息>”.`。測試用訊息中的 `e2e:` 指令操控它們（`e2e:write=notes.md`、`e2e:approve`、`e2e:slow`…）。假 CLI 總是會嘗試指令要求的事，成不成功只取決於 Harness Relay 給了 CLI 什麼（權限、參數與設定、沙箱、資料夾，以及它的核准請求得到的回答），所以在不該寫的地方寫檔的測試，能看出轉接器有沒有把 CLI 設定對。Claude Code、Codex、Grok、Copilot 與 Muse Code 的假 CLI 自己推算它們 CLI 的沙箱會允許什麼；沒有沙箱的 Cursor 與 Antigravity，假 CLI 像真正的一樣先詢問；開源 agent 的假 CLI 則真的寫檔、真的連線，所以在完全存取以外，不屬於它們的事由 Harness Relay 自己的沙箱本身拒絕（在 macOS 與 Linux 上）。在沙箱裡的假 CLI 無法寫入假 CLI 的紀錄檔，所以把紀錄送到假模型端點。
- **假的 `gh`**（[`fake-cli/fake-gh.cjs`](fake-cli/fake-gh.cjs)），用於分享與問題回報的截圖：它把 gist 存在測試自己的資料夾（`fake-github/`），從不送到 GitHub；`E2E_FAKE_SIGNED_OUT=gh` 會讓它處於未登入狀態。Linux 上還有假的選擇資料夾視窗（`zenity`）。AgentsView 則是 [`specs/sessions.spec.ts`](specs/sessions.spec.ts) 裡的一個小 HTTP 伺服器，因為 Harness Relay 只會送請求給它。

下面的表格中，CLI 欄寫出測試用哪些 CLI 執行：「**各一**」表示十二個 CLI 各跑一次；「**有登入的各一**」表示 Claude Code、Codex、Grok、Cursor、Antigravity、Copilot 與 Muse Code 各跑一次；「**開源 agent 各一**」表示 OpenCode、Goose、Cline、OpenHands 與 Pi 各跑一次；「**兩個團隊**」表示測試跑兩次，一次是有登入的七個組成的團隊，一次是五個開源 agent 組成的團隊（這時標題以 `open agents:` 開頭）。某個 CLI 只能以完全存取執行的地方（Windows 上的開源 agent、Linux 上的 OpenCode），與權限有關的測試會跳過它並說明原因，其他測試則以完全存取執行它。在 CI 上，某個 CLI 自己的測試（各一的，以及它在兩個團隊中的位置）在 macOS 與 Windows 上只跑 Harness Relay 在那裡的執行方式和 Linux 不同的 CLI：見[平台與瀏覽器](#平台與瀏覽器)。

## 分區

| 分區 | Spec | 測試數 | 相關文件 |
| --- | --- | --- | --- |
| [登入](#登入) | [`signin.spec.ts`](specs/signin.spec.ts) | 14 | [架構 → 登入](../docs/architecture.zh-TW.md#登入) |
| [首頁](#首頁) | [`home.spec.ts`](specs/home.spec.ts) | 2 | [使用者說明 → 開始對話](../docs/user-guide.zh-TW.md#3-開始對話新對話與範本) |
| [新對話與首席 agent 的團隊](#新對話與首席-agent-的團隊) | [`chat.spec.ts`](specs/chat.spec.ts) | 5 | [使用者說明 → 自動組隊](../docs/user-guide.zh-TW.md#自動組隊)、[架構 → 自動組隊](../docs/architecture.zh-TW.md#自動組隊) |
| [範本](#範本) | [`templates.spec.ts`](specs/templates.spec.ts) | 4 | [使用者說明 → 範本](../docs/user-guide.zh-TW.md#範本) |
| [修改對話的團隊](#修改對話的團隊) | [`team.spec.ts`](specs/team.spec.ts) | 4 | [使用者說明 → 對話中修改團隊](../docs/user-guide.zh-TW.md#對話中修改團隊) |
| [成員的模型與推理強度](#成員的模型與推理強度) | [`models.spec.ts`](specs/models.spec.ts) | 13 | [使用者說明 → 預設模型與推理強度](../docs/user-guide.zh-TW.md#預設模型與推理強度)、[團隊成員](../docs/user-guide.zh-TW.md#團隊成員) |
| [成員如何輪流發言](#成員如何輪流發言) | [`turns.spec.ts`](specs/turns.spec.ts) | 55 | [架構 → 發言排程](../docs/architecture.zh-TW.md#發言排程模式)、[agent 之間如何共享上下文](../docs/architecture.zh-TW.md#agent-之間如何共享上下文) |
| [agent 回答前做了什麼](#agent-回答前做了什麼) | [`activity.spec.ts`](specs/activity.spec.ts) | 13 | [架構 → agent 活動](../docs/architecture.zh-TW.md#agent-活動) |
| [核准](#核准) | [`approvals.spec.ts`](specs/approvals.spec.ts) | 39 | [使用者說明 → 核准](../docs/user-guide.zh-TW.md#核准)、[架構 → 核准](../docs/architecture.zh-TW.md#核准)、[權限對應](../docs/architecture.zh-TW.md#權限對應) |
| [檔案與修改](#檔案與修改) | [`files.spec.ts`](specs/files.spec.ts) | 20 | [使用者說明 → 檢視與套用修改](../docs/user-guide.zh-TW.md#檢視與套用修改)、[瀏覽檔案](../docs/user-guide.zh-TW.md#瀏覽檔案)、[架構 → 工作區與檔案修改](../docs/architecture.zh-TW.md#工作區與檔案修改) |
| [工作目錄與其他資料夾](#工作目錄與其他資料夾) | [`folders.spec.ts`](specs/folders.spec.ts) | 34 | [架構 → 多個工作目錄](../docs/architecture.zh-TW.md#多個工作目錄)、[各平台的作業系統沙箱](../docs/sandboxing.zh-TW.md) |
| [Harness Relay 自己的沙箱](#harness-relay-自己的沙箱) | [`sandbox.spec.ts`](specs/sandbox.spec.ts) | 17 | [各平台的作業系統沙箱 → Harness Relay 自己的沙箱](../docs/sandboxing.zh-TW.md#harness-relay-自己的沙箱)、[開源 agent → Harness Relay 的沙箱](../docs/open-agents.zh-TW.md#harness-relay-的沙箱) |
| [除了 prompt 之外交給各 CLI 的東西](#除了-prompt-之外交給各-cli-的東西) | [`inputs.spec.ts`](specs/inputs.spec.ts) | 34 | [架構 → 工具庫](../docs/architecture.zh-TW.md#工具庫) |
| [工具庫](#工具庫) | [`tools.spec.ts`](specs/tools.spec.ts) | 15 | [使用者說明 → 工具庫](../docs/user-guide.zh-TW.md#工具庫mcp-伺服器skill-與記憶)、[架構 → 工具庫](../docs/architecture.zh-TW.md#工具庫) |
| [修改對話的歷史](#修改對話的歷史) | [`history.spec.ts`](specs/history.spec.ts) | 3 | [使用者說明 → 複製、編輯與重試](../docs/user-guide.zh-TW.md#複製編輯與重試)、[分支對話](../docs/user-guide.zh-TW.md#分支對話) |
| [複製與分享](#複製與分享) | [`share.spec.ts`](specs/share.spec.ts) | 5 | [使用者說明 → 分享對話](../docs/user-guide.zh-TW.md#分享對話)、[架構 → 分享對話](../docs/architecture.zh-TW.md#分享對話) |
| [側邊欄](#側邊欄) | [`sidebar.spec.ts`](specs/sidebar.spec.ts) | 7 | [使用者說明 → 群組](../docs/user-guide.zh-TW.md#群組)、[搜尋](../docs/user-guide.zh-TW.md#搜尋) |
| [排程](#排程) | [`schedule.spec.ts`](specs/schedule.spec.ts) | 1 | [使用者說明 → 排程](../docs/user-guide.zh-TW.md#排程)、[架構 → 排程](../docs/architecture.zh-TW.md#排程) |
| [設定](#設定) | [`settings.spec.ts`](specs/settings.spec.ts) | 13 | [使用者說明 → 登入](../docs/user-guide.zh-TW.md#登入)、[首席 agent](../docs/user-guide.zh-TW.md#首席-agent)、[開源 agent → 模型來源](../docs/open-agents.zh-TW.md#模型來源) |
| [在 Windows 上是腳本的 CLI](#在-windows-上是腳本的-cli) | [`windows.spec.ts`](specs/windows.spec.ts) | 5 | [架構 → CLI 轉接器](../docs/architecture.zh-TW.md#cli-轉接器) |
| [帳號](#帳號) | [`accounts.spec.ts`](specs/accounts.spec.ts) | 35 | [使用者說明 → 多個帳號](../docs/user-guide.zh-TW.md#多個帳號)、[API key](../docs/user-guide.zh-TW.md#api-key選用)、[架構 → 帳號](../docs/architecture.zh-TW.md#帳號) |
| [方案用量](#方案用量) | [`usage.spec.ts`](specs/usage.spec.ts) | 9 | [使用者說明 → 方案用量](../docs/user-guide.zh-TW.md#方案用量)、[架構 → Provider](../docs/architecture.zh-TW.md#provider狀態登入與模型) |
| [各 CLI 自己載入的內容，以及 Grok 的信任](#各-cli-自己載入的內容以及-grok-的信任) | [`native.spec.ts`](specs/native.spec.ts) | 5 | [使用者說明 → 各 CLI 自己載入的內容](../docs/user-guide.zh-TW.md#各-cli-自己載入的內容)、[架構 → 各 CLI 自己載入的內容](../docs/architecture.zh-TW.md#各-cli-自己載入的內容) |
| [Agent 的 session 與 AgentsView](#agent-的-session-與-agentsview) | [`sessions.spec.ts`](specs/sessions.spec.ts) | 10 | [使用者說明 → Agent 的 session](../docs/user-guide.zh-TW.md#agent-的-session各-cli-自己的資料夾與-agentsview)、[架構 → Agent 的家目錄與 AgentsView](../docs/architecture.zh-TW.md#agent-的家目錄與-agentsview) |
| [語音輸入的安裝](#語音輸入的安裝) | [`voice.spec.ts`](specs/voice.spec.ts) | 2 | [使用者說明 → 語音輸入](../docs/user-guide.zh-TW.md#語音輸入)、[架構 → 語音輸入](../docs/architecture.zh-TW.md#語音輸入) |
| [回報問題](#回報問題) | [`report.spec.ts`](specs/report.spec.ts) | 5 | [使用者說明 → 回報問題](../docs/user-guide.zh-TW.md#回報問題)、[架構 → 回報問題](../docs/architecture.zh-TW.md#回報問題) |
| [使用導覽與主題](#使用導覽與主題) | [`appearance.spec.ts`](specs/appearance.spec.ts) | 7 | [使用者說明 → 介面語言與使用導覽](../docs/user-guide.zh-TW.md#介面語言與使用導覽) |
| [通知與提示音](#通知與提示音) | [`notifications.spec.ts`](specs/notifications.spec.ts) | 4 | [使用者說明 → 通知與提示音](../docs/user-guide.zh-TW.md#通知與提示音)、[架構 → 通知](../docs/architecture.zh-TW.md#通知) |
| [環境變數設定的上限](#環境變數設定的上限) | [`limits.spec.ts`](specs/limits.spec.ts) | 4 | [開發者說明 → 環境變數](../docs/developer-guide.zh-TW.md#環境變數) |
| [語言](#語言) | [`i18n.spec.ts`](specs/i18n.spec.ts) | 2 | [架構 → 語言](../docs/architecture.zh-TW.md#語言) |
| [在手機上](#在手機上) | [`mobile.spec.ts`](specs/mobile.spec.ts) | 5 | [用手機連線](../docs/remote-access.zh-TW.md) |

測試以英文介面執行，所以下面括號裡附上測試實際操作的英文標籤。

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
| app 打開時是首頁，點 logo 與名稱會回到首頁 | 首頁顯示 logo 與下面的標語；從新對話頁和對話中點側邊欄的 logo 與 **Harness Relay**（在首頁時標為目前的頁面），都會回到首頁（`#/`）。 |
| logo 每次進入首頁播放一次動畫，只動 transform 與 opacity，減少動態效果時不播放 | logo 的圓點、轉圈與標語都有一段播放時間（而不是像沒寫名稱的 `animation` 簡寫被壓縮成 `none` 那樣完全不播），只播一次，只改變 `transform` 與 `opacity`；播完會自己結束，再次打開首頁時會重播；開啟減少動態效果時完全沒有動畫。 |

## 新對話與首席 agent 的團隊

[`chat.spec.ts`](specs/chat.spec.ts)：從新對話頁開始的對話，首席 agent 會為每個問題組隊。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 首席 agent 提議團隊，確認後團隊回答 | Claude Code | 團隊卡片寫出團隊、理由與成員；按**確認團隊**（Confirm team）後，回答帶著它的 CLI 標籤；對話以第一個問題列在側邊欄，回答存成已完成。 |
| 不詢問直接採用首席 agent 組的團隊 | Claude Code | 卡片寫著**已直接採用**（Used without asking），團隊不必等待就回答。 |
| 所有 CLI 組成的團隊依序回答 | 兩個團隊 | 每位成員帶著自己 CLI 的標籤回答，依圓桌順序：Claude Code、Codex、Grok、Cursor；Antigravity、Copilot、Muse Code；以及 OpenCode、Goose、Cline、OpenHands、Pi（團隊裡有在這裡只能以完全存取執行的 CLI 時，對話以完全存取執行）。首席 agent 為新問題組的團隊最多五位成員，所以有登入的七個分成四人與三人的兩個團隊，各在自己的對話中回答。 |
| 追問時再組一次團隊 | Claude Code、Codex | 第二個問題有自己的團隊，只有那位成員回答。 |

## 範本

[`templates.spec.ts`](specs/templates.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 列出內建範本，打開其中一個可看到成員 | — | 「三方辯論」（Three-way debate）標為內建，對話框列出 Proposer、Pragmatist 與 Skeptic。 |
| 範本編輯視窗有三欄時，新增成員卡自己一列就列出所有 CLI，在成員旁邊就和成員一樣高 | — | 1280px 下編輯視窗的格線有三欄：內建接力範本的三位成員填滿第一列，新增成員卡自己一列，全部列出、不用捲動；加入第四位、以及移除兩位後在第一列兩位成員旁邊時，清單可以捲動，那些成員保有自己的高度（隱藏新增成員卡再量一次比對：同一列的卡片本來就一樣高，互相比較證明不了什麼）。 |
| 首席 agent 直接使用範本 | Claude Code、Codex、Grok | 卡片寫著使用「三方辯論」；兩輪中每位成員先以自己的 CLI 回答，再 PASS（共六則回答）。 |
| 把首席 agent 設計的團隊存成範本 | Claude Code、Grok | **存成範本**（Save as template）預設帶入團隊的名稱，卡片顯示已儲存，新對話頁也出現這個範本。 |

## 修改對話的團隊

[`team.spec.ts`](specs/team.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 請首席 agent 調整團隊，儲存後新成員回答 | Claude Code、Grok | 在**團隊設定 → 請首席 agent 調整**（Team settings → Ask the lead agent）中，要求會交給首席 agent，抽屜顯示它加入的成員，按**儲存**後兩位成員都回答。 |
| 首席 agent 的回答無法解讀時，改用範本 | Claude Code | 回答不是 JSON 時改用「一般問題智囊團」（General-question panel），由它的三位成員回答。 |
| 拒絕為新問題提議的團隊 | Claude Code、Codex | 按**不採用，沿用目前的團隊**（No, keep the current team）：卡片顯示沒有採用，由目前的團隊回答，提議的成員不回答。 |
| 新增成員卡和旁邊的成員一樣高，下面還有 CLI 時底部有陰影，自己一列時列出所有 CLI，一張卡變高只撐高自己那一列 | — | 在**團隊設定**中（1280px 下兩欄），清單是名為**新增成員**（Add member）的群組：在一位成員旁邊時，那位成員保有自己的高度（隱藏新增成員卡再量一次比對），十二個 CLI 的清單可以捲動。瀏覽器支援捲動驅動動畫時，清單底部邊緣有陰影（那一條的截圖和拿掉陰影時不同），減少動態效果時也有，取得焦點的每個按鈕都停在它上方，捲到底後陰影消失。兩位成員時它自己一列，全部列出、不用捲動，也沒有陰影；硬讓它取用沒有給它的高度時（欄數算錯時就會這樣），它至少有 280px 高並可以捲動，不會變成空框。在第三位旁邊時那一位保有自己的高度，而第一列的角色框拉高後，第二列的卡片高度不變。 |

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

## agent 回答前做了什麼

[`activity.spec.ts`](specs/activity.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 思考、工具呼叫與待辦清單和回答一起顯示 | 各一 | 這些步驟收合成列；展開後可看到思考、CLI 自己列出工作目錄的工具已完成與它的輸出（Claude 的 `Bash`、Codex 的 `Shell`、Grok 的 `list_dir`、Cursor、Antigravity 與 Copilot 的 `Read`、Muse Code 的 `Search`、OpenCode 的 `glob`、Goose 的 `tree`、Cline 的 `read_files`、OpenHands 的 `file_editor`、Pi 的 `List`，完全存取時是 `Bash`），以及三項中完成一項、進行中一項的待辦清單（Cline 與 Pi 沒有待辦清單可顯示）。 |
| Markdown 回答會轉成格式 | Claude Code | 標題、清單、表格與上色的程式碼。 |

## 核准

[`approvals.spec.ts`](specs/approvals.spec.ts)：在會詢問使用者的對話中，agent 想執行指令（`echo e2e-approval`）。除了 Pi 與 Copilot 之外都是唯讀對話：Pi 在唯讀時沒有執行指令的工具，Copilot 不詢問就執行 `echo`（它把它當成唯讀指令），所以它們在編輯模式下，針對那裡唯一會詢問的那種指令詢問（`npm publish e2e-approval`，用 `e2e:approve=publish`）。Goose 要求執行的是 `env echo e2e-approval`，因為在唯讀時 Harness Relay 讓它不詢問就執行 `echo` 這類單純讀取的指令。回答會交給各 CLI 自己的請求：Claude Code 的 `can_use_tool`、Codex 的核准請求、ACP agent 的 `session/request_permission`（Grok、Cursor、Antigravity、Copilot、Muse Code、OpenCode、Goose、Cline、OpenHands），以及 Pi 的 gate 擴充功能的對話框。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 使用者允許的指令會執行 | 各一 | 卡片顯示指令，側邊欄顯示**等你核准**（Needs you）；按**允許**（Allow）後指令執行，卡片顯示已允許。CLI 只能以完全存取執行的地方跳過。 |
| 使用者拒絕的指令不會執行，附註會一起交給它 | 各一 | 卡片顯示「Declined: Not now」。Claude Code、Grok、OpenCode、Goose 與 Pi 拒絕時會收到附註；Codex 的回答沒有附註的位置，Cursor、Muse Code、Cline 與 OpenHands 則丟掉附註（回答只說指令被拒絕）；Antigravity 與 Copilot 一被拒絕就結束它們的回合，回答只說明這一點，不再多說。CLI 只能以完全存取執行的地方跳過。 |
| 「本對話都允許」讓下一次同樣的請求自動通過 | Claude Code | 第二次請求自動允許，沒有卡片。 |
| 請求等待時停止團隊，指令不會執行 | Claude Code | 回答以「(stopped)」結束，請求被拒絕或沒有回答。 |
| 完全存取時，指令直接執行，也能不詢問就寫到任何地方 | 各一 | 標題列警告**完全存取**（Full access）；指令執行，檔案寫到另一個資料夾，沒有卡片（在每個系統上都一樣：完全存取的 CLI 外面沒有沙箱）。 |
| 自動拒絕的對話不詢問就拒絕 | Claude Code | 指令被拒絕，沒有卡片。 |

## 檔案與修改

[`files.spec.ts`](specs/files.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 編輯模式下 agent 修改檔案，聊天中顯示改了什麼 | Claude Code | 檔案在工作目錄裡，工作目錄也變成 git repository；變更卡片列出它，並能打開這一回合的 diff。 |
| 唯讀對話中不會寫入任何檔案 | 各一 | Claude Code、Muse Code 與 Pi 執行時沒有檔案工具，Cursor 的寫入被它自己的規則拒絕，都沒有卡片；其他的會詢問，然後被拒絕（Antigravity 與 Copilot 接著結束它們的回合）；沒有寫入檔案，也沒有變更卡片。CLI 只能以完全存取執行的地方跳過。（使用者允許的寫入仍然寫不進資料夾：見 [Harness Relay 自己的沙箱](#harness-relay-自己的沙箱)。） |
| 自動拒絕的唯讀對話中，Grok 說明原因 | Grok | 工具的錯誤寫著唯讀模式下不允許。 |
| 每個 CLI 都能在編輯模式寫檔，每一回合各自記下變更 | 兩個團隊 | 每位成員寫自己的檔案（`<cli>.txt`），每則回答的變更卡片都列出它。在這裡只能以完全存取執行的 CLI，在自己的對話中以完全存取執行。 |
| 平行模式中每位成員在自己的 worktree 工作，可以套用其中一份結果 | Claude Code、Codex | 兩張變更卡片都寫著「in worktree」，工作目錄裡什麼都沒有，直到按**套用到工作目錄**（Apply to working directory）帶進 Codex 的檔案。 |
| 檔案瀏覽器顯示工作目錄並預覽檔案 | Claude Code | **檔案**（Files）列出專案；`src/hello.ts` 打開後顯示程式碼；按 Escape 關閉。 |
| 資料夾可下載成 ZIP 檔，裡面沒有 .git | Claude Code | 工作目錄的 ZIP（`work.zip`）剛好包含它的檔案與內容，沒有 `.git`；某個資料夾自己的 ZIP（`src.zip`）只有那個資料夾。 |
| 太大而無法整個壓縮的資料夾，改為提供不含 git 忽略的檔案 | Claude Code | 一個長度設為超過 1 GiB、但沒有真的寫入的被忽略檔案（Windows 上仍會佔用磁碟空間）讓資料夾太大：拒絕時不下載任何東西，接受時得到不含被忽略資料夾的 ZIP。 |

## 工作目錄與其他資料夾

[`folders.spec.ts`](specs/folders.spec.ts)：假 CLI 只會寫在真正的 CLI 能寫的地方，所以這些測試能看出對話的資料夾有沒有傳到各 CLI。開源 agent 的假 CLI 會真的寫檔，不屬於它們的地方由 Harness Relay 自己的沙箱拒絕。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 編輯模式下，對話沒有的資料夾碰不到 | 各一（Grok 不在 Windows 上） | 自動拒絕時，隔壁的資料夾不會寫入任何東西：Copilot 與 Muse Code 以外有登入的 CLI 會詢問，然後被拒絕（Antigravity 接著結束它的回合）；Copilot 的寫入由它自己的沙箱不詢問就拒絕，它的回合繼續；Muse Code 的檔案工具不詢問就拒絕，接著試的寫入指令在編輯模式下由轉接器允許，再被它的沙箱拒絕；開源 agent 不詢問就寫，由 Harness Relay 自己的沙箱拒絕。CLI 只能以完全存取執行的地方跳過；Grok 在原生 Windows 上沒有沙箱，所以那裡也跳過。 |
| 寫到對話沒有的資料夾前先詢問，使用者允許後才寫 | Claude Code、Codex、Cursor、Antigravity | 在「想修改檔案」卡片按**允許**，檔案就寫在那裡。Grok 不在其中，因為它的沙箱照樣會拒絕；Copilot 也不在其中，因為它的沙箱不詢問就拒絕；Muse Code 也不在其中，因為它在那裡什麼都不詢問（它的檔案工具拒絕，它的沙箱拒絕它接著試的指令）；開源 agent 也不在其中，因為沒有任何回答能放寬它們的沙箱。 |
| 在輸入框加入與移除資料夾，對話在所有資料夾中工作 | Claude Code | 在**工作目錄**（Working directories）輸入的資料夾變成標籤，也能移除；對話存下留下的資料夾，agent 在第一個與第二個寫檔，被移除的沒有。 |
| 各 CLI 在每個資料夾寫檔，變更卡片依資料夾列出 | 各一 | 兩個資料夾各一個檔案：卡片寫著「Changed 2 files」，每個資料夾一組，diff 兩個都有。Cursor 寫入第二個資料夾前會詢問，並得到允許。 |
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

[`tools.spec.ts`](specs/tools.spec.ts)：**設定 → 工具庫**。工具庫是空的時候成員的「工具」怎麼說，只檢查一次；其他每個測試都跑兩次：一次在有登入的七個 CLI 各一位成員的對話中，一次在五個開源 agent 各一位成員的對話中（`open agents: …`）。對某個 CLI 關掉項目、或對某位成員打開或關掉項目的測試，用的是團隊的第二與第三位成員（Codex 與 Grok；Goose 與 Cline）。

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

## 修改對話的歷史

[`history.spec.ts`](specs/history.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 編輯訊息後重新送出：取代它之後的內容 | Claude Code | 編輯框警告重新送出會刪掉之後的內容；之後對話裡是修改過的訊息與一則新的回答。 |
| 對已完成的回答重試，成員再回答一次 | Grok | CLI 再次收到 prompt，對話裡仍然只有一則回答。 |
| 從某則回答分支出的對話自己繼續，原本的對話不變 | Codex | **分支對話**（Branch conversation）打開一個標明延續自哪裡的新對話；新的訊息不在原本的對話裡，側邊欄兩個都列出。 |

## 複製與分享

[`share.spec.ts`](specs/share.spec.ts)：分享透過使用者自己的 `gh`，這裡是假的那個。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 回答的複製按鈕複製的是 Markdown，而不是畫面上的文字 | Codex | 剪貼簿裡是原始內容（標題、表格的直線、程式碼區塊的圍欄），按鈕顯示已複製。只在 Chromium。 |
| 分享對話框把整個對話，或到某則回答為止的部分，複製成 Markdown | Claude Code | 標題列的對話框複製整段對話；某則回答自己的**分享**只複製到它為止。只在 Chromium。 |
| 分享的對話是瀏覽器產生的頁面做成的 secret gist，在設定中列出直到移除 | Claude Code | `gh gist create --filename index.html …` 存下一個 secret gist，頁面有問題與回答，但沒有中間的步驟（思考、工具）；連結是 gistpreview 的，旁邊是 gist 本身的連結；**設定 → 分享**列出它，按**移除**會刪掉 gist（`gist delete <id> --yes`）。 |
| gh 未登入時，分享會說明如何登入，什麼都不分享 | Grok | `E2E_FAKE_SIGNED_OUT=gh`：說明中寫著 `gh auth login`，可以再按一次**建立連結**，也沒有存下任何東西。 |
| 沒有 gh 時，分享會說明如何安裝並登入 | Claude Code | 無法啟動的 `gh` 得到含安裝指令與重新啟動提醒的說明。Windows 上跳過，因為那裡不能用 `#!` 行代替不存在的程式。 |

## 側邊欄

[`sidebar.spec.ts`](specs/sidebar.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 首席 agent 把新對話分進使用者的群組 | Claude Code | 用**新群組**（New group）建立的群組，收到第一則訊息提到它名稱的新對話。 |
| 重新命名與刪除對話 | — | 標題列與側邊欄的標題都改變；**刪除對話**（Delete conversation）會把它從側邊欄與伺服器上移除，並改為顯示首頁。 |
| 依 agent 寫的內容搜尋對話 | Codex | 搜尋回答中的文字，找到那一個對話，點了就打開。 |
| 在 UI 開始的對話保留一開始給的標題 | Claude Code | 第一個問題之後標題不變。 |
| 拖進群組的對話會留在那裡，拖出來則回到「其他」 | — | 伺服器存下群組，重新載入後仍在；拖到「其他」後群組被清除，群組裡又顯示可以把對話拖到這裡。 |
| 分支對話的家族在群組之間一起移動 | Codex | 拖動分支時，原本的對話跟著移動，分支仍在它底下；把原本的對話拖回來時兩個都回來。 |
| 每個 CLI 的狀態點與可用數量排得進一行 | — | 十二個 CLI 都已安裝且可用時（在傳到頁面的途中改掉伺服器的回答，「12/12 ready」），這一行沒有超出邊界，第一個點在設定的 ⚙ 正下方，箭頭的尖端對齊下方回報問題圖示的右緣；顯示名稱、箭頭轉向下時也一樣。 |

## 排程

[`schedule.spec.ts`](specs/schedule.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 儲存對話的排程，立即執行一次會把訊息送給團隊 | Codex | 存成「每天」（Every day）後，側邊欄標出這個對話；按**立即執行一次**（Run once now）送出標為排程的訊息，成員回答。 |

## 設定

[`settings.spec.ts`](specs/settings.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 找到每個 CLI，顯示版本，且已登入 | 各一，同一個測試 | 每張卡片顯示 CLI 的版本，以及**已登入**（Claude Code 附帳號），開源 agent 在假端點上則是**可使用**（Ready）；側邊欄十二個狀態點都正常（「12/12 ready」，開源 agent 的標題是「Model backends set up」）；要求時顯示它們的名稱，重新載入後仍保留。 |
| 未安裝的 CLI 在設定與側邊欄顯示未安裝 | Cursor、Antigravity | 設成未安裝（`missingClis`）：它們的狀態點與卡片顯示**未安裝**（Not installed）。 |
| 沒有模型來源的開源 agent 還不能用，它的回合說明要先設定一個 | OpenCode | `openBackend: false`：狀態點寫著「No model backend yet」，卡片顯示**尚未就緒**（Not ready）與「No model backend set up yet (Settings → Model backends)」，回答的錯誤說 OpenCode 沒有模型。 |
| 可以指定 CLI 的執行檔路徑，錯誤的路徑顯示找不到 | Grok | 不存在的路徑顯示**未安裝**（Not installed）；清空後又找到它。 |
| 切換語言，選擇會保留 | — | 選繁體中文後頁面改變，重新載入後仍保留，選 English 再改回來。 |
| 選另一個 CLI 擔任首席 agent | Codex 當首席 agent | 新對話頁寫出它，團隊卡片寫著「Lead agent: Codex」，首席 agent 的 prompt 交給了 Codex。 |
| 未登入的 CLI 顯示未登入，它的回答說明原因 | 有登入的各一 | `E2E_FAKE_SIGNED_OUT=<cli>`：狀態點與卡片顯示**未登入**（不含 CLI 自己的說法），並有**登入**按鈕，另一個 CLI 則仍然登入；它的回答帶著 CLI 的錯誤。 |

## 在 Windows 上是腳本的 CLI

[`windows.spec.ts`](specs/windows.spec.ts)：只在 Windows 上執行。在其他地方，以及 Windows 上預設的情況，假 CLI 都是在 PATH 上找到的程式。這裡則像使用者一樣在設定中，把每個 CLI 的執行檔路徑設成它在 Windows 上安裝後的那種啟動器；Harness Relay 會把它當成它所執行的程式來啟動（`src/server/winLaunch.ts`），從不透過 `cmd.exe`。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 透過 Cursor 自己的啟動器啟動，找得到它與它的版本，並且會回答 | Cursor | 透過 `cursor-agent.cmd`（它會執行 Node 與 Cursor 自己的腳本），設定顯示它的版本，完全存取的回合以 Cursor 的身分執行。 |
| 透過 Muse Code 自己的啟動器啟動，找得到它與它的版本，並且會回答 | Muse Code | 同上，透過 `muse.cmd`（它的腳本會執行 `.muse-version` 指定的 `muse-bin-<版本>.exe`），Harness Relay 直接把它當成那個執行檔啟動。 |
| 透過 npm 給 Node 腳本的 shim 啟動，找得到它與它的版本，並且會回答 | Cline、Pi | 同上，透過 npm 給 Node 腳本的 `.cmd` shim。 |
| 透過 npm 給程式的 shim 啟動，找得到它與它的版本，並且會回答 | OpenCode | 同上，透過 npm 給程式的 `.cmd` shim。 |

## 帳號

[`accounts.spec.ts`](specs/accounts.spec.ts)：**設定 → 各 CLI 的卡片 → 新增帳號**，針對有自己登入的七個 CLI（開源 agent 沒有帳號：它們使用模型來源）。Cursor、Antigravity 與 Muse Code 新增的帳號只能用 API key 登入，由這些測試給它們。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 新增的帳號有自己的資料夾，設定使用它的成員在那裡執行 | 有登入的各一 | 帳號放在 `<資料>/accounts/<cli>-<id>`，卡片上顯示這個資料夾，並在那裡登入（Cursor、Antigravity 與 Muse Code 用給它的 key：「Using an API key」；Copilot 的登入狀態在這次詢問自己的家目錄中詢問，放在資料資料夾的 `tmp` 裡，帶著帳號登入狀態的副本）；使用它的成員以這個家目錄執行（`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`GROK_HOME`、Cursor 的帳號資料夾、裡面 Antigravity 的 `.gemini`、Copilot 這次執行自己的家目錄，它的 session 連到那個資料夾、裡面 Muse Code 的資料資料夾 `data/muse`，它的設定資料夾則是那個回合自己的），使用預設帳號的成員則用預設的。 |
| 每個帳號各自登入與登出 | Claude Code | **登出**只在新增帳號的家目錄執行 `auth logout`；**登入**走 CLI 自己的流程（一個連結，再貼上代碼），之後顯示這個帳號已登入。 |
| 登出新增的帳號，只會登出那個帳號 | Codex、Grok、Copilot | `logout`（Copilot 的透過 ACP）只在那個帳號的資料夾執行；它的卡片顯示**未登入**，預設帳號仍然登入。 |
| 金鑰儲存區關閉時，帳號的 API key 存在資料庫、遮蔽顯示，並只交給它的 CLI | Claude Code、Grok、Cursor、Antigravity、Copilot、Muse Code | API key 欄位說明金鑰存在哪裡（只能用 key 登入的帳號，欄位一開始就展開）；儲存後顯示遮蔽的值與「Using an API key」，`/api/settings` 裡從沒有它；那個帳號的執行拿到它（`ANTHROPIC_API_KEY`、`XAI_API_KEY`、`CURSOR_API_KEY`、`GEMINI_API_KEY`、`COPILOT_GITHUB_TOKEN`、`META_API_KEY`），不在任何參數裡，預設帳號的執行則沒有。 |
| 帳號的 API key 用 Codex 自己的登入讓那個帳號登入 | Codex | Codex 不從環境變數拿 key：key 經由 stdin 交給只在那個帳號資料夾執行的 `codex login --with-api-key`，Harness Relay 不保存它，只有那個帳號的執行拿得到。 |
| 啟動 Harness Relay 時帶的 API key 只屬於預設帳號 | 有登入的各一 | 伺服器自己環境中的 key（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`XAI_API_KEY`、`CURSOR_API_KEY`、`GEMINI_API_KEY`、`COPILOT_GITHUB_TOKEN`、`META_API_KEY`）會交給預設帳號的回合，不會交給新增的帳號（Cursor、Antigravity 與 Muse Code 新增的帳號用自己的 key）。 |
| 移除新增的帳號會登出它並刪除它的資料夾，它的成員與首席 agent 改用預設帳號 | 有登入的各一 | 確認時寫出資料夾；帳號在那裡登出（只能用 key 登入的帳號沒有東西要登出），之後資料夾與其中的 session 都刪除；首席 agent 回到預設帳號；成員的下一回合在預設的家目錄、以新的 session 執行。 |
| 在 CLI 狀態的回答還在路上時新增帳號，保留較新回答的狀態 | Claude Code | 頁面的下一個狀態回答被擋到帳號新增之後（`page.route`）：這個較舊、沒有該帳號的回答最後才到時，帳號的狀態仍是**已登入**，不會變回「檢查中…」。 |
| 在 Harness Relay 以外登出的 CLI，重新打開設定時會顯示出來 | Claude Code | 在它的家目錄登出（就像在終端機執行 `claude auth logout`），而伺服器的快取仍說已登入。重新打開時，設定再檢查一次，app 則拿到快取的回答，這個回答被擋到（`page.route`）設定自己的回答之後：最後才到也不會勝出，狀態顯示**未登入**。 |
| 有對話正在執行時不能移除帳號 | Claude Code | 回答慢慢進行時，**移除**說有對話正在執行，什麼都不變；停止對話後就能移除。 |

## 方案用量

[`usage.spec.ts`](specs/usage.spec.ts)：**設定 → 每個 CLI 的卡片 → 帳號的方案用量**，涵蓋有自己登入的七個 CLI。每個替身都像它的 CLI 一樣不送 prompt 回報方案用量（Claude Code 的 `get_usage`、Codex 的 `account/rateLimits/read`、Grok 的 `_x.ai/billing`、`muse usage --json`、Copilot headless 伺服器的 `account.getQuota`、Antigravity print 模式的 `/usage` 與 `/credits`、Cursor 從 `about --format json` 取得的方案）：預設的登入（e2e@example.com）已用 42%，其他帳號 7%，並記下每次詢問與它的家目錄。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 預設帳號顯示方案還剩多少，或它的 CLI 為什麼不說 | 每個有登入的 | Claude Code、Codex、Grok、Antigravity、Copilot 與 Muse Code：方案（Muse Code 沒有）、第一個額度的名稱（「5-hour limit」、「Weekly limit」、「5-hour limit · Gemini 3.1 Pro」、「Monthly limit · Premium requests」、「Allowance」）、「58% left · 42% used · resets …」（Copilot：「126 of 300 requests used」）與停在 42 的 meter，在預設帳號的家目錄只問一次（Copilot 在詢問專用的家目錄）。Cursor：取自 `about` 的方案，以及它的用量只在它自己的終端畫面顯示。都沒有錯誤。 |
| 每個帳號顯示自己方案的用量，在它自己的資料夾詢問，「重新查詢」會再問一次 | Claude Code | 以另一個地址登入的新帳號在區塊捲到畫面上後顯示「93% left · 7% used」與它的每週額度，旁邊是預設帳號的 58%，各在自己的家目錄詢問；它的「重新查詢」（以帳號命名）只會再問那個帳號的 CLI 一次，不問預設帳號的。 |
| 用 API key 的帳號說明它沒有方案額度，未登入的帳號不顯示用量 | Claude Code | 有自己金鑰的帳號（它的 `get_usage` 回答 `rate_limits_available: false`）說明它用 API key 執行、沒有額度；未登入的帳號沒有用量區塊。 |

## 各 CLI 自己載入的內容，以及 Grok 的信任

[`native.spec.ts`](specs/native.spec.ts)：帳號框中的**這個 CLI 自己載入的 skill、MCP、hook 與記憶等 → 查詢**，以及 Grok 對專案的信任。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 它自己的 skill 會列出，設為不載入的在下一次執行時不會載入 | Claude Code、Codex | CLI 家目錄中的 skill 會列出（Codex 的附上檔案），並在回合中載入；勾選後**查詢**標示它不載入，下一回合一個都不載入（Claude Code 的 `skillOverrides`、Codex 的 `skills.config`）。 |
| Grok 卡片顯示資料夾的信任狀態；信任後載入專案的 skill，設為不載入則影響下一次執行 | Grok | 未信任時卡片會標示，也沒有列出 skill；**信任這個資料夾**會寫入 `$GROK_HOME/trusted_folders.toml`，專案的 skill 隨之出現；**全部不載入**會影響下一回合（`GROK_CLAUDE_SKILLS_ENABLED=false`），它在信任下執行且不載入任何 skill。 |
| 團隊有 Grok 成員時會說明 Grok 不信任這個資料夾，在那裡信任它就會記錄下來 | Grok | 從團隊卡片信任後記錄下來，Grok 的回合在信任下執行。 |
| 使用者拒絕時，團隊不信任資料夾就開始 | Grok | 什麼都沒記錄，**確認團隊**仍會開始，Grok 的回合在未信任下執行。 |

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

[`report.spec.ts`](specs/report.spec.ts)：側邊欄的**回報問題**。郵件的連結在頁面中攔下（`window.open`、剪貼簿與被取消的 `mailto:` 導覽），所以不會開啟任何東西，也不會連上網路。讀取郵件連結的三個測試，在沒有 Navigation API 的瀏覽器中跳過。

| 情境 | 檢查的內容 |
| --- | --- |
| 郵件的連結帶著描述、版本與系統資訊 | 沒有描述前不能送出；資訊與 `/api/about`、瀏覽器、各 CLI 的版本與語言一致，沒有暫存路徑；`mailto:` 連結有收件地址、取自第一行的主旨與內文；Gmail 連結也一樣；**複製內容**會複製整封郵件；送出後再打開時是空的。 |
| 送出前關掉的回報會保留，選的類型與主旨會放進郵件 | 類型、主旨與描述在按 Escape 後仍在，郵件寫著 `[Harness Relay] Idea: <主旨>` 與 `Type: Idea`。 |
| 太長而放不進郵件連結的回報放到剪貼簿，郵件請你貼上 | `mailto:` 連結維持在上限內並請你貼上回報，回報已在剪貼簿裡；Gmail 連結仍帶著全部內容。 |
| 加入的截圖要先上傳或移除，郵件才能送出 | 文字檔會被拒絕並說明原因；PNG 顯示縮圖，兩個送出按鈕都暫停，直到移除它。 |
| 無法上傳的截圖會說明原因，回報不帶截圖送出 | 假的 `gh` 未登入時，**上傳截圖**說明 gh 沒有登入，移除截圖後就能送出。 |

## 語音輸入的安裝

[`voice.spec.ts`](specs/voice.spec.ts)：安裝進行中的**設定 → 語音輸入**。真正的安裝要下載引擎與模型，測試無法離線做到，所以頁面拿到的是伺服器自己對 `GET /api/voice` 的回答，再加上一個安裝。

| 情境 | 檢查的內容 |
| --- | --- |
| 安裝的步驟排成一列，向螢幕閱讀器說明狀態，下載顯示在進度條上 | 步驟排成一列、目前的步驟標為 `aria-current`、下載百分比與進度條的填色。 |
| 安裝失敗時說明停在哪一步 | 停下的步驟顯示為失敗。 |

## 使用導覽與主題

[`appearance.spec.ts`](specs/appearance.spec.ts)：像第一次造訪時的導覽（`tour: true`），以及**設定 → 外觀**。

| 情境 | 檢查的內容 |
| --- | --- |
| 第一次造訪時顯示導覽，可以一步步走到最後，之後不再顯示 | 開在第 1 步，沒有上一步；下一步、上一步與方向鍵都能移動；最後一步沒有**跳過導覽**，按**開始使用**後關閉，重新載入也不會再出現。 |
| 導覽可以略過，設定可以重新開始 | **跳過導覽**後重新載入也不會出現；**設定 → 使用導覽 → 重新觀看導覽**會從第 1 步開始，Escape 關閉後仍算完成。 |
| 在手機上，導覽是貼齊螢幕底部的面板，長步驟的內容在按鈕之上捲動 | 在 390×560 下，最長的一步（檔案權限）貼齊螢幕底部，**下一步**在面板內；內容可以捲動（**下一步**有焦點時按 End 也行），按鈕上方出現分隔線，下一步則從頂端開始。 |
| 在手機上，導覽打開時從下往上滑出一次（從設定重新觀看也是），停在螢幕底部，減少動態效果時不播放 | 在 390×560 下打開，面板從螢幕下方（`translateY(100%)`）往上滑出、背後的遮罩從透明淡入，只改變 `transform` 與 `opacity`，兩者都會自己結束；之後面板的底部貼齊螢幕底部，**下一步**在畫面內且有焦點（面板還在螢幕下方時就讓**下一步**取得焦點，不會讓它移位）；換到下一步時仍是同樣已播完的動畫，不會重播；**設定 → 使用導覽 → 重新觀看導覽**會再播一次（開始時間較晚），面板一樣停在底部；開啟減少動態效果時完全沒有動畫，面板一樣在底部。 |
| 在寬螢幕上，畫面中央的步驟「下一步」都在同一個位置 | 在 1280×800 下，導覽裡沒有任何動畫；沒有指向側邊欄的步驟，**下一步**都在同一個高度：卡片和最高的那一步一樣高。 |
| 在設定中選的深色或淺色會套用到頁面，重新載入後保留，且優先於系統 | 深色會設定 `data-theme`、背景與 `theme-color` meta，重新載入後仍在；系統是深色時，淺色仍維持淺色。 |
| 跟隨系統時會跟著系統的淺色或深色模式 | **跟隨系統**會移除 `data-theme`，頁面在開著時與重新載入後都跟著模擬的淺色或深色模式。 |

## 通知與提示音

[`notifications.spec.ts`](specs/notifications.spec.ts)：**設定 → 通知與提示音**，以及團隊回覆完或需要使用者時頁面怎麼做。瀏覽器的通知與提示音由替身記錄（`Notification`、`AudioContext`，以及模擬視窗被擋住的 `document.hasFocus()`），在 app 的程式之前就設定好；這個瀏覽器也沒有推播服務（拿掉 `PushManager`），所以由頁面自己告訴使用者，就像桌面 app 的視窗。團隊是一個 Claude 成員。

| 情境 | 檢查的內容 |
| --- | --- |
| 設定會詢問瀏覽器、播放提示音試聽，並傳送測試通知 | 沒有推播時說明頁面開著時才會通知；**顯示系統通知**開啟前（開啟時會請瀏覽器允許）**傳送測試通知**不能按；**播放提示音**會先播一次；測試會跳出靜音的通知並播放提示音；重新載入後選擇仍在。 |
| 視窗被擋住時，等待確認的團隊與回覆完成都會跳出通知，點一下會打開對話 | 首席 agent 的團隊等待確認（「…等你確認」）與回覆（「Claude finished replying」加上回覆的開頭），標題都是對話標題、tag 都是那個對話、都是靜音，並分別播放三個音與兩個音；在首頁點其中一則會打開對話。 |
| agent 的提問會跳出通知，附上它問的內容 | `e2e:ask`：「Claude asked you something」與問題；提示音關掉時不播放。 |
| 正在看的對話不通知，其他對話只播放提示音 | 視窗有焦點、正在看的對話回覆完：什麼都沒有。顯示首頁時才結束的慢回覆（`e2e:slow=5`）：只有提示音，沒有通知。在設定裡兩者都關掉：什麼都沒有。 |

## 環境變數設定的上限

[`limits.spec.ts`](specs/limits.spec.ts)：用 `RELAY_MAX_TEAM_AGENTS=2`、`RELAY_MAX_ACCOUNTS=2` 與 `RELAY_TURN_TIMEOUT_MIN=90` 啟動的伺服器。

| 情境 | 檢查的內容 |
| --- | --- |
| 團隊編輯器到上限就不能再加成員，伺服器也拒絕更多 | `GET /api/limits` 回傳這三個值；第二位成員之後 **＋** 按鈕都停用；三位成員的範本以 400 拒絕。 |
| 人數超過上限的範本說明它為何不能用，首席 agent 也不會選它 | 「三方辯論」說明一個團隊最多兩位成員；首席 agent 選它時，卡片說明原因，改用截成兩位的「一般問題智囊團」（Analyst 與 Critic）。 |
| 排程的說明顯示回合逾時 | 選**詢問我**（Ask me）時，新排程頁說明 agent 每回合最多等 90 分鐘。 |
| 設定到上限就不能再加帳號 | 第二個帳號之後，**新增帳號**（Add an account）停用並說明原因。 |

## 語言

[`i18n.spec.ts`](specs/i18n.spec.ts)

| 情境 | 檢查的內容 |
| --- | --- |
| app、範本與首席 agent 的卡片都是中文，agent 收到英文 prompt | 在 zh-TW 下，首頁的標語、新對話頁、內建範本、輸入框的提示與團隊卡片都是中文，而回合的 prompt 是英文（見 [AGENTS.md](../AGENTS.md) 的「Prompts and languages」）。 |
| 登入頁與伺服器自己的訊息跟著語言 | 登入頁與伺服器對錯誤代碼的訊息都是中文。 |

## 在手機上

[`mobile.spec.ts`](specs/mobile.spec.ts)：Pixel 7 的螢幕與觸控，就像透過 Tailscale 使用聊天時一樣。Firefox 沒有行動裝置模擬，所以跳過。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 從選單開啟側邊欄，以觸控使用對話 | Grok | 選單按鈕的三條線（圖示）在按鈕正中央，誤差在十分之一個像素內；按**開啟側邊欄**（Open sidebar）前側邊欄不在畫面上，前往別處時又會收起；送出按鈕會送出（觸控螢幕上 Enter 是換行）；標題列的動作收在**更多**（More）之下。 |
| 很長的訊息不會讓頁面左右捲動 | Claude Code | 300 個字元的單字與 Markdown 回答都不會造成左右捲動。 |
| 很窄的手機上，範本編輯視窗和團隊設定不會左右捲動，新增成員卡列出所有 CLI | — | 在 320px（比 290px 的成員卡加上邊距還窄）和 280px（英文的 **hand-offs / message** 會自己換到下一行）下，內建接力範本的編輯視窗和接力對話的**團隊設定**左右捲動都不超過一個像素；只有一欄時，新增成員卡全部列出所有 CLI，不必自己捲動。 |
| 很窄的手機上，任何一種新排程都不會左右捲動（兩種語言），對話的排程也不會 | — | 在新排程頁，每一種排程方式在 320px 和 280px 下、英文另外在 400px 和 430px、中文另外在 250px 下，都沒有東西會左右捲動。四種排程方式在英文 400px 以下排成兩列（欄寬小於 380px 就兩兩排列，留給較寬的字型），430px 時一列；中文只有 250px 時兩列。一週七天在英文 320px、280px 與中文 280px、250px 時排成兩列，其他時候一列。選**每隔幾小時**時，間隔的單位只有「小時」，說明另起一行，並且是小時數字框的無障礙說明。對話的**排程**抽屜選**每週**時，在 320px 和 280px 下也不會左右捲動。 |
| 首頁的標語變小，每一行都不換行，點 logo 會收起側邊欄 | — | 標語小於 22px，英文兩行、中文一行，頁面不會左右捲動；在首頁點側邊欄的 **Harness Relay** 會收起側邊欄。 |

## 各 CLI 一覽

每個 CLI 都測到的情境（大多是每個 CLI 一個測試，其餘用有登入的七個或五個開源 agent 組成的團隊），所以某個轉接器的改變會在這裡看出來：在 Linux 與本機上十二個都測，在 CI 的 macOS 與 Windows 上則是各自執行方式不同的 CLI（[平台與瀏覽器](#平台與瀏覽器)）。有自己登入的 CLI：

| 情境 | Claude Code | Codex | Grok | Cursor | Antigravity | Copilot | Muse Code |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 思考、工具呼叫與待辦清單 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 設定頁的方案用量 | ✓（5 小時與每週額度） | ✓（5 小時與每週時段） | ✓（這週的點數） | 只有方案 | ✓（模型的 5 小時額度、點數） | ✓（以次數計的 premium 請求） | ✓（訂閱額度） |
| 允許指令，以及附註後拒絕 | ✓ | ✓（沒有附註） | ✓ | ✓（丟掉附註） | ✓（被拒絕就結束回合） | ✓（編輯模式下的 `npm publish`；被拒絕就結束回合） | ✓（丟掉附註） |
| 完全存取：不詢問就執行並寫到任何地方 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 唯讀對話不寫入任何檔案 | ✓（沒有檔案工具） | ✓（詢問後被拒絕） | ✓（詢問後被拒絕） | ✓（被自己的規則拒絕，沒有卡片） | ✓（詢問後被拒絕；結束回合） | ✓（詢問後被拒絕；結束回合） | ✓（沒有檔案工具） |
| 對話沒有的資料夾碰不到 | ✓（詢問後被拒絕） | ✓（詢問後被拒絕） | ✓（詢問後被拒絕；不在 Windows 上） | ✓（詢問後被拒絕） | ✓（詢問後被拒絕；結束回合） | ✓（它的沙箱不詢問就拒絕） | ✓（檔案工具拒絕，它接著試的指令被沙箱拒絕） |
| 使用者允許後寫到那裡 | ✓ | ✓ | —（它的沙箱會拒絕） | ✓ | ✓ | —（它的沙箱不詢問就拒絕） | —（它在那裡什麼都不詢問） |
| 多個工作目錄：每個都寫一個檔案 | ✓ | ✓ | ✓ | ✓（第二個先詢問） | ✓ | ✓ | ✓ |
| 工具庫的 MCP 伺服器，秘密不在命令列上 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| HTTP MCP 伺服器與它的標頭 | ✓ | ✓ | ✓ | ✓ | —（不提供） | ✓ | ✓ |
| 附加的圖片 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 停止回答；協定之內的錯誤；失敗的回答與重試 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 下一回合接續自己的 session | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 設定中的版本與登入，以及未登入 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 在設定與側邊欄顯示未安裝 | — | — | ✓（錯誤的執行檔路徑） | ✓ | ✓ | — | — |
| 成員的模型與推理強度 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 在七個組成的團隊中：依序回答（照首席 agent 設計的方式，四人與三人一組）、編輯模式的變更、工具庫、各 CLI 存放 session 的資料夾 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 列出它自己的 skill，並在下一次執行時不載入 | ✓ | ✓ | ✓（信任資料夾之後） | — | — | — | — |
| 新增帳號自己的家目錄 | ✓ | ✓ | ✓ | ✓（用它的 API key） | ✓（用它的 API key） | ✓（登入狀態在它自己的家目錄中詢問） | ✓（用它的 API key） |
| 新增的帳號各自登出 | ✓ | ✓ | ✓ | —（只用 key） | —（只用 key） | ✓（透過 ACP） | —（只用 key） |
| 帳號的 API key 只交給那個帳號 | ✓ | ✓（透過 `codex login`） | ✓ | ✓ | ✓ | ✓ | ✓ |
| 伺服器自己的 API key 只交給預設帳號 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 移除新增的帳號 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| CLI 啟動前先詢問專案自己的設定 | — | — | — | — | ✓ | ✓（它專案的 hook） | — |
| 在 Windows 上透過 `.cmd` 啟動器啟動 | — | — | — | ✓（它自己的） | — | — | ✓（它自己的） |
| 它在 AgentsView 中的 session，放在對話的討論串底下 | ✓ | ✓ | — | ✓（由 Harness Relay 記下） | — | ✓（`copilot:<id>`） | ✓（`muse:<id>`） |

開源 agent，在完全存取以外於 Harness Relay 自己的沙箱中執行：

| 情境 | OpenCode | Goose | Cline | OpenHands | Pi |
| --- | --- | --- | --- | --- | --- |
| 在完全存取以外執行（其他地方只能以完全存取執行，要求較低權限時會說明） | macOS | macOS、Linux | macOS、Linux | macOS（要打開終端機開關，關掉時也有測）、Linux | macOS、Linux |
| 思考、工具呼叫與待辦清單 | ✓ | ✓ | ✓（沒有待辦清單） | ✓ | ✓（沒有待辦清單） |
| 允許指令，以及附註後拒絕 | ✓ | ✓（`env echo`） | ✓（丟掉附註） | ✓（丟掉附註） | ✓（編輯模式下的 `npm publish`，透過它的 gate） |
| 完全存取：不詢問就執行並寫到任何地方 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 唯讀對話不寫入任何檔案 | ✓（詢問後被拒絕） | ✓（詢問後被拒絕） | ✓（詢問後被拒絕） | ✓（詢問後被拒絕） | ✓（沒有寫檔的工具） |
| 唯讀對話中允許的寫入，被沙箱拒絕 | ✓ | ✓ | ✓ | ✓ | —（沒有寫檔的工具） |
| 對話沒有的資料夾碰不到（由沙箱拒絕） | ✓ | ✓ | ✓ | ✓ | ✓ |
| 使用者允許後寫到那裡 | — | — | — | — | — |
| 這次執行不能連的主機會先詢問，並被拒絕 | ✓ | ✓ | ✓ | ✓（編輯模式下） | ✓（編輯模式下） |
| 多個工作目錄：每個都寫一個檔案 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 工具庫的 MCP 伺服器，秘密不在命令列上 | ✓ | ✓ | ✓ | ✓ | ✓ |
| HTTP MCP 伺服器與它的標頭 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 附加的圖片 | ✓ | ✓ | —（只有路徑） | ✓ | ✓ |
| 停止回答；協定之內的錯誤；失敗的回答與重試 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 下一回合接續自己的 session | ✓ | ✓ | ✓ | ✓ | ✓ |
| 設定中的版本與「可使用」，用假端點 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 沒有模型來源時還不能用 | ✓ | — | — | — | — |
| 成員的模型（端點的）與推理強度 | ✓（沒有推理強度） | ✓（`off`） | ✓ | ✓ | ✓ |
| 在五個組成的團隊中：依序回答、編輯模式的變更、工具庫、各 CLI 存放 session 的資料夾 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 在 Windows 上透過 `.cmd` 啟動器啟動 | ✓（npm 給程式的） | — | ✓（npm 給 Node 腳本的） | — | ✓（npm 給 Node 腳本的） |

## 平台與瀏覽器

- [`.github/workflows/e2e.yml`](../.github/workflows/e2e.yml) 會在每個 pull request 與每次推送到 `main` 時，以 Node 24 在 Ubuntu、macOS 與 Windows 上，並以 Node 22 在 Ubuntu 上，用 Chromium 執行所有 spec：每一種都分成兩個 job，各跑一半的測試（Playwright 的 `--shard=1/2` 與 `2/2`），讓每個 job 都不超過七分鐘多少。手動執行可以選擇其他瀏覽器；在本機則用 `E2E_BROWSERS=chromium,firefox,webkit`（[`playwright.config.ts`](../playwright.config.ts)）。在 Ubuntu 上它會安裝 Harness Relay 自己的沙箱需要的東西（bubblewrap、socat 與 ripgrep，以及讓 `/usr/bin/bwrap` 能建立 namespace 的 AppArmor 設定檔），在 Ubuntu 與 macOS 上先執行沙箱自己的檢查（`scripts/sandbox-check.ts`），並在那裡設定 `E2E_REQUIRE_RELAY_SANDBOX=1`，讓需要沙箱的測試失敗而不是跳過。
- 開源 agent 只在 macOS 與 Linux 上（Linux 需要 bubblewrap、socat 與 ripgrep）以完全存取以外的權限執行：在 Harness Relay 自己的沙箱不支援的 Windows 上，它們只能以完全存取執行，Linux 上的 OpenCode 也是。在那裡，與權限有關的測試會跳過它們並說明原因，其他測試以完全存取執行它們，而 [Harness Relay 自己的沙箱](#harness-relay-自己的沙箱)會檢查權限低於完全存取的對話不會啟動它們。在沒有這個沙箱的 Mac 或 Linux 電腦上，需要它的測試會跳過並說明原因（`E2E_RELAY_SANDBOX`，由 `global-setup.ts` 判斷一次）。
- 在 CI 上（`E2E_SYSTEM_CLIS=1`），每個 CLI 自己的測試在 Linux 上十二個都跑，在 macOS 與 Windows 上只跑 Harness Relay 在那裡的執行方式和 Linux 不同、而且它的假 CLI 看得出差別的 CLI（`support/clis/<cli>.ts` 的 `testedOn`，那裡寫了原因）；在其他系統上會跳過並說明在哪裡執行。**macOS**：五個開源 agent（Harness Relay 自己的沙箱在那裡由 Seatbelt 構成，OpenCode 只在那裡以完全存取以外的權限執行，還有 OpenHands 的終端機開關），以及代表有登入的七個 CLI 的 Claude Code，它們的假 CLI 在那裡做的事和在 Linux 上一樣。**Windows**：有登入的七個（Claude Code 沒有沙箱設定、Codex 沒有權限設定檔、Grok 的 `workspace` 設定檔、Cursor 的 session 以 junction 連進來、Antigravity 的家目錄以 `USERPROFILE` 傳給它、Copilot 的資料夾以 junction 連進來、Muse Code 的登入用複本，以及它的 PowerShell），OpenCode 與 Goose（用它們自己的 shell），以及 OpenHands（它的 PowerShell 終端機）；Cline 與 Pi 不在其中，它們在那裡只能以完全存取執行，和在 Linux 上以完全存取執行時一樣（[在 Windows 上是腳本的 CLI](#在-windows-上是腳本的-cli) 仍會在那裡啟動它們）。在本機沒有設定這個變數時，每個 CLI 的測試在每個系統上都跑；手動執行 workflow 並勾選 **every_cli**，macOS 與 Windows 上也會十二個都跑。
- OpenHands 在 macOS 上要在完全存取以外執行，需要沙箱裡的終端機：測試的伺服器會打開它的開關，而關掉開關的測試只在 macOS 上執行。
- [在 Windows 上是腳本的 CLI](#在-windows-上是腳本的-cli)只在 Windows 上執行。
- 選擇資料夾視窗的測試只在 Linux 上執行：Linux 從 PATH 找它的視窗，假的視窗可以替代；macOS 與 Windows 以完整路徑開啟自己的視窗。
- 「對話沒有的資料夾碰不到」在 Windows 上跳過 Grok，因為它在那裡沒有沙箱（[各平台的作業系統沙箱](../docs/sandboxing.zh-TW.md)）。
- Copilot 在 macOS、Linux 與 Windows 上都以完全存取以外的權限執行，就像它自己的沙箱一樣：它的假 CLI 遵守這次執行的設定給的政策，所以它的測試不需要執行測試的電腦上有沙箱。
- [在手機上](#在手機上)在 Firefox 中跳過。
- [修改對話的團隊](#修改對話的團隊)的新增成員卡測試，只在支援捲動驅動動畫的瀏覽器（Chromium、WebKit）檢查清單的陰影，因為其他瀏覽器沒有陰影：在 Firefox 中只檢查其餘部分。
- [複製與分享](#複製與分享)的兩個複製測試只在 Chromium 執行（要讀剪貼簿），「沒有 gh」則在 Windows 上跳過。
- [回報問題](#回報問題)中讀取郵件連結的三個測試，在沒有 Navigation API 的瀏覽器中跳過。

## 沒有測到的部分

- **CLI 本身。**假 CLI 檢查的是 Harness Relay 這一端的協定；[實機測試](#實機測試)會手動試用真正的 CLI。CLI 改變它的輸出時，由轉接器測試錄下來的訊息（`test/claude.test.ts`、`test/codex.test.ts`、`test/grok.test.ts`、`test/cursor.test.ts`、`test/antigravity.test.ts`、`test/copilot.test.ts`、`test/muse.test.ts` 與開源 agent 的測試，後面這些重播從真正的 CLI 錄下的訊息）以及在 app 中試用真正的 CLI 發現。
- **CLI 自己的沙箱。**Claude Code、Codex、Grok、Copilot 與 Muse Code 的假 CLI 是從 Harness Relay 給它們的設定，推算它們 CLI 的沙箱會允許什麼（Copilot 的從這次執行的設定推算，並且像 Copilot 那樣，用這些設定給的政策回答 `/sandbox policy`）；只有包住開源 agent 的 Harness Relay 自己的沙箱是真的。真正的 CLI 在完全存取以外不會寫到對話的資料夾之外，由實機測試（`live/sandbox.spec.ts`）試用。
- **AgentsView 本身。**它是 [`sessions.spec.ts`](specs/sessions.spec.ts) 中的替身伺服器，只回應 Harness Relay 的請求，從不讀 session 檔。真正的 AgentsView 是否在 Harness Relay 的執行留下 session 的地方讀到各 CLI 自己的 session、用的是不是 Harness Relay 連結的 id（包括 Copilot 的 `session-state` 與 Muse Code 的資料資料夾，在各 CLI 平常的家目錄，以及透過使用者說明中專用 AgentsView 的 `config.toml`），並把它們放在討論串底下，是用 AgentsView 0.46.1 手動試過的（Copilot 與 Muse Code 也用 copilot 1.0.109 與 muse 1.4.18 透過它們的 adapter 在 Linux 與 Windows 上寫的 session 試過）。
- **Cursor 在暫存資料夾中不詢問就做的事。**真正的 Cursor 在暫存資料夾（`/tmp`、macOS 的 `/private/var/folders`）中寫入不會詢問；它的假 CLI 不會這樣，因為測試的資料夾都在暫存資料夾裡，否則寫到工作區之外的每個檔案都會不經詢問就寫入。也沒有 spec 試用 Cursor 團隊的自動執行允許清單（假 CLI 有一份，`E2E_FAKE_CURSOR_TEAM_ALLOW`）。真正的 Muse Code 的沙箱也讓它的指令寫入暫存資料夾；它的假 CLI 因為同樣的原因不會這樣。
- **CLI 真正的方案用量。**[方案用量](#方案用量)用替身的回答檢查 Harness Relay 這一邊；真正 CLI 的回答由 `test/usage.test.ts` 中從它們錄下的回答涵蓋（Antigravity 只照 agy 1.5.8 的型別：沒有看過真正 Google 帳號的回答），沒有 live 測試問真正的 CLI。未登入時替身 agy 會立刻以錯誤回答 `/usage`，真正的則會在 stderr 要求登入並等待（單元測試的替身會這樣做）。錯誤訊息與面板的 zh-TW 文字由 `test/usage-web.test.ts` 涵蓋，不在這裡。
- **首頁 logo 動畫的流暢度。**[首頁](#首頁)檢查它只動 `transform` 與 `opacity`、只播一次；它由 Chrome 的 compositor 執行、頁面畫好之後不再重新排版或繪製，則是在 Chrome 的 trace 中手動確認的。
- **推播通知與系統本身的通知。**[通知與提示音](#通知與提示音)用替身記錄它們；推播需要真正的推播服務（Google、Apple 的…），所以伺服器這一端（訂閱、加密、簽章、送出與保留什麼）由單元測試涵蓋（`test/push.test.ts`、`test/alerts.test.ts`、`test/push-api.test.ts`），頁面這一端由 `test/alerts-web.test.ts` 涵蓋，service worker 的處理程序則以替身的 `self` 由 `test/sw.test.ts` 涵蓋；瀏覽器向推播服務訂閱、真正的推播送到手機，則沒有任何測試走過。
- **OpenCode 與 Goose 的 token 和費用。** Harness Relay 從這兩個 CLI 自己的 SQLite 資料庫（`opencode.db`、`sessions.db`）讀取，它們的假 CLI 不保存這些資料庫，所以在這裡它們的回覆不顯示用量；轉接器的測試（`test/opencode.test.ts`、`test/goose.test.ts`）會對照真正 CLI 寫法寫成的資料庫跑完整的回合。
- **還沒有 spec 走過的功能**：語音輸入本身的錄音與轉寫（它會下載引擎與模型，也需要麥克風；只測了安裝的面板）；分享的回答所連結的檔案，以及上傳回報的截圖（兩者都用 git 推送到 gist，假的 `gh` 沒有代替這部分）；作業系統金鑰儲存區中的 API key（測試會關掉它，所以 key 存在資料庫）；從設定登入 Codex、Grok、Cursor、Antigravity、Copilot 與 Muse Code（它們自己的登入流程；Copilot 的裝置登入由 `test/providers.test.ts` 測試），以及真正的 Codex 拿到 `codex login --with-api-key` 的 key 之後做了什麼；Copilot 沙箱的政策和這次執行設定的不一樣時，完全存取以外拒絕啟動（由 `test/copilot.test.ts` 測試）；Muse Code 詢問指令要不要連網（它的假 CLI 在沙箱中會為 `e2e:approve=publish` 詢問，但沒有 spec 送出這個指令），以及對話的權限改變或伺服器重新啟動後，Muse Code 的成員開新的 session（由 `test/muse.test.ts` 測試）；AgentsView 中首席 agent 與分類對話的 session 連結、設定網址後才送出的對話，以及 Harness Relay 為開源 agent 記下的成員 session（由 `test/agentsview.test.ts` 測試，Cursor 的也是，另有 spec 試過）；連不含 git 忽略的檔案都太大的 ZIP；以及桌面 app 視窗裡登入之後的部分（它自己的檢查 `desktop/scripts/smoke.ts` 與 `desktop/scripts/check-package.ts` 會開一個這些假 claude、codex 與 grok 的唯讀對話，讓每一個回答一個問題，在打包好的伺服器上與打包好的 app 裡都會跑：CI 在 Linux 與 Windows 上，發佈前則在每個系統上）。其中有些有單元測試，在 [`test/`](../test/) 裡，列在開發者說明的[測試](../docs/developer-guide.zh-TW.md#測試)。

## 實機測試

[`live/`](live/) 裡是第二套測試，`npm run test:e2e:live`，設定是 [`playwright.live.config.ts`](../playwright.live.config.ts)：真正的 CLI，用你自己的登入，跑在真正的模型上，所以會花一點費用，也從不在 CI 上執行，不算在上面的數量裡。它預設試用全部十二個 CLI，環境沒有提供某個測試需要的東西時（一個端點，或各 CLI 自己的雲端模型所需的 `E2E_LIVE_CLOUD=1`），那個測試就會跳過：在 Mac 上，有一個端點時是三個檔案、48 個測試，再加上雲端模型時是 58 個（每個 `E2E_LIVE_MODEL_<CLI>` 再多一個；什麼都沒設定時列出 21 個，全部跳過）。它們涵蓋：每個 CLI 用在「團隊設定」中選的端點模型、在設定中把 CLI 的預設模型設為某個端點的模型、有登入的七個 CLI 自己的雲端模型（Claude Code、Codex、Grok、Cursor、Antigravity、Copilot 與 Muse Code 的）、成員用的端點被刪除、替端點手動輸入的模型、原生 Windows 上權限低於完全存取的開源 agent、雲端與本機模型一起組成的團隊、每個 CLI 用它的 shell 在對話的兩個工作目錄中各寫一個檔案（用端點的模型，有登入的七個也用它們自己的模型）、Cursor 用自己的檔案工具寫入第二個工作目錄、Antigravity 在指令被拒絕時結束它的回合，以及啟動前先詢問專案自己的 MCP 伺服器、Copilot 同樣在指令被拒絕時結束回合，以及啟動前先詢問專案自己的 hook，還有每個 CLI 在完全存取以外都不會寫到對話的資料夾之外。執行方式見開發者說明的[實機測試](../docs/developer-guide.zh-TW.md#實機測試)。

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
