[English](README.md) | **繁體中文**

# 端對端測試的情境

端對端測試（`npm run test:e2e`）目前測到的情境，依功能分區列出。它們在真正的瀏覽器中（[Playwright](https://playwright.dev)）操作建置好的 UI，面對真正的伺服器，agent 則是假的 `claude`、`codex` 與 `grok` CLI，所以不連網路、不花費用，在 macOS、Linux 與 Windows 上的執行方式都一樣。

它們如何運作、怎麼執行單一測試、怎麼撰寫新測試，見開發者說明的[端對端測試](../docs/developer-guide.zh-TW.md#端對端測試)。這一頁是情境清單：新增、修改或刪除端對端測試時，請在同一個 commit 裡一起修改這一頁與[英文版](README.md)（見 [AGENTS.md](../AGENTS.md) 的「Documentation」）。

目前共有 26 個 spec 檔、153 個測試，在每個執行的瀏覽器中各跑一次（預設是 Chromium）。

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

- **自己的伺服器**：使用空閒的 port，資料、家目錄與各 CLI 的家目錄都在暫存資料夾裡，並關閉作業系統的鑰匙圈：不會讀取或更動你自己的 Harness Relay、CLI 或鑰匙圈，你的憑證不會留在它的環境變數裡，git 找 repository 時也不會超出測試的資料夾（[`support/relay.ts`](support/relay.ts)）。
- **一個工作目錄**，裡面是一個小專案：`README.md`、`src/hello.ts` 與 `src/lib/math.ts`（`seedProject()`）。需要其他資料夾的測試會在它旁邊新增（`relay.addProject()`）。
- **已登入的瀏覽器頁面**：用一組新的一次性代碼登入，使用導覽已完成，介面為英文（[`fixtures.ts`](fixtures.ts)）。測試可用 `test.use()` 改變這些：`lang: 'zh-TW'`、`signIn: false`、`tour: true`，或給伺服器更多環境變數（`serverEnv`）。
- **假的 CLI**（[`fake-cli/fake-cli.cjs`](fake-cli/fake-cli.cjs)）說各 CLI 的協定，回答 `Hello from <名稱> (<CLI>). You said: “<使用者最新的訊息>”.`。測試用訊息中的 `e2e:` 指令操控它們（`e2e:write=notes.md`、`e2e:approve`、`e2e:slow`…）。假 CLI 總是會嘗試指令要求的事，成不成功只取決於 Harness Relay 給了 CLI 什麼（權限、沙箱、資料夾，以及它的核准請求得到的回答），所以在不該寫的地方寫檔的測試，能看出轉接器有沒有把 CLI 設定對。
- **假的 `gh`**（[`fake-cli/fake-gh.cjs`](fake-cli/fake-gh.cjs)），用於分享與問題回報的截圖：它把 gist 存在測試自己的資料夾（`fake-github/`），從不送到 GitHub；`E2E_FAKE_SIGNED_OUT=gh` 會讓它處於未登入狀態。Linux 上還有假的選擇資料夾視窗（`zenity`）。AgentsView 則是 [`specs/sessions.spec.ts`](specs/sessions.spec.ts) 裡的一個小 HTTP 伺服器，因為 Harness Relay 只會送請求給它。

下面的表格中，CLI 欄寫「**各一**」表示這個測試對每個 CLI（Claude Code、Codex 與 Grok）各跑一次。

## 分區

| 分區 | Spec | 測試數 | 相關文件 |
| --- | --- | --- | --- |
| [登入](#登入) | [`signin.spec.ts`](specs/signin.spec.ts) | 14 | [架構 → 登入](../docs/architecture.zh-TW.md#登入) |
| [新對話與首席 agent 的團隊](#新對話與首席-agent-的團隊) | [`chat.spec.ts`](specs/chat.spec.ts) | 4 | [使用者說明 → 自動組隊](../docs/user-guide.zh-TW.md#自動組隊)、[架構 → 自動組隊](../docs/architecture.zh-TW.md#自動組隊) |
| [範本](#範本) | [`templates.spec.ts`](specs/templates.spec.ts) | 3 | [使用者說明 → 範本](../docs/user-guide.zh-TW.md#範本) |
| [修改對話的團隊](#修改對話的團隊) | [`team.spec.ts`](specs/team.spec.ts) | 3 | [使用者說明 → 對話中修改團隊](../docs/user-guide.zh-TW.md#對話中修改團隊) |
| [成員的模型與推理強度](#成員的模型與推理強度) | [`models.spec.ts`](specs/models.spec.ts) | 4 | [使用者說明 → 預設模型與推理強度](../docs/user-guide.zh-TW.md#預設模型與推理強度)、[團隊成員](../docs/user-guide.zh-TW.md#團隊成員) |
| [成員如何輪流發言](#成員如何輪流發言) | [`turns.spec.ts`](specs/turns.spec.ts) | 19 | [架構 → 發言排程](../docs/architecture.zh-TW.md#發言排程模式)、[agent 之間如何共享上下文](../docs/architecture.zh-TW.md#agent-之間如何共享上下文) |
| [agent 回答前做了什麼](#agent-回答前做了什麼) | [`activity.spec.ts`](specs/activity.spec.ts) | 4 | [架構 → agent 活動](../docs/architecture.zh-TW.md#agent-活動) |
| [核准](#核准) | [`approvals.spec.ts`](specs/approvals.spec.ts) | 12 | [使用者說明 → 核准](../docs/user-guide.zh-TW.md#核准)、[架構 → 核准](../docs/architecture.zh-TW.md#核准)、[權限對應](../docs/architecture.zh-TW.md#權限對應) |
| [檔案與修改](#檔案與修改) | [`files.spec.ts`](specs/files.spec.ts) | 10 | [使用者說明 → 檢視與套用修改](../docs/user-guide.zh-TW.md#檢視與套用修改)、[瀏覽檔案](../docs/user-guide.zh-TW.md#瀏覽檔案)、[架構 → 工作區與檔案修改](../docs/architecture.zh-TW.md#工作區與檔案修改) |
| [工作目錄與其他資料夾](#工作目錄與其他資料夾) | [`folders.spec.ts`](specs/folders.spec.ts) | 14 | [架構 → 多個工作目錄](../docs/architecture.zh-TW.md#多個工作目錄)、[各平台的作業系統沙箱](../docs/sandboxing.zh-TW.md) |
| [除了 prompt 之外交給各 CLI 的東西](#除了-prompt-之外交給各-cli-的東西) | [`inputs.spec.ts`](specs/inputs.spec.ts) | 6 | [架構 → 工具庫](../docs/architecture.zh-TW.md#工具庫) |
| [工具庫](#工具庫) | [`tools.spec.ts`](specs/tools.spec.ts) | 5 | [使用者說明 → 工具庫](../docs/user-guide.zh-TW.md#工具庫mcp-伺服器skill-與記憶)、[架構 → 工具庫](../docs/architecture.zh-TW.md#工具庫) |
| [修改對話的歷史](#修改對話的歷史) | [`history.spec.ts`](specs/history.spec.ts) | 3 | [使用者說明 → 複製、編輯與重試](../docs/user-guide.zh-TW.md#複製編輯與重試)、[分支對話](../docs/user-guide.zh-TW.md#分支對話) |
| [複製與分享](#複製與分享) | [`share.spec.ts`](specs/share.spec.ts) | 5 | [使用者說明 → 分享對話](../docs/user-guide.zh-TW.md#分享對話)、[架構 → 分享對話](../docs/architecture.zh-TW.md#分享對話) |
| [側邊欄](#側邊欄) | [`sidebar.spec.ts`](specs/sidebar.spec.ts) | 6 | [使用者說明 → 群組](../docs/user-guide.zh-TW.md#群組)、[搜尋](../docs/user-guide.zh-TW.md#搜尋) |
| [排程](#排程) | [`schedule.spec.ts`](specs/schedule.spec.ts) | 1 | [使用者說明 → 排程](../docs/user-guide.zh-TW.md#排程)、[架構 → 排程](../docs/architecture.zh-TW.md#排程) |
| [設定](#設定) | [`settings.spec.ts`](specs/settings.spec.ts) | 5 | [使用者說明 → 登入](../docs/user-guide.zh-TW.md#登入)、[首席 agent](../docs/user-guide.zh-TW.md#首席-agent) |
| [帳號](#帳號) | [`accounts.spec.ts`](specs/accounts.spec.ts) | 5 | [使用者說明 → 多個帳號](../docs/user-guide.zh-TW.md#多個帳號)、[API key](../docs/user-guide.zh-TW.md#api-key選用)、[架構 → 帳號](../docs/architecture.zh-TW.md#帳號) |
| [各 CLI 自己載入的內容，以及 Grok 的信任](#各-cli-自己載入的內容以及-grok-的信任) | [`native.spec.ts`](specs/native.spec.ts) | 5 | [使用者說明 → 各 CLI 自己載入的內容](../docs/user-guide.zh-TW.md#各-cli-自己載入的內容)、[架構 → 各 CLI 自己載入的內容](../docs/architecture.zh-TW.md#各-cli-自己載入的內容) |
| [Agent 的 session 與 AgentsView](#agent-的-session-與-agentsview) | [`sessions.spec.ts`](specs/sessions.spec.ts) | 6 | [使用者說明 → Agent 的 session](../docs/user-guide.zh-TW.md#agent-的-session各-cli-自己的資料夾與-agentsview)、[架構 → Agent 的家目錄與 AgentsView](../docs/architecture.zh-TW.md#agent-的家目錄與-agentsview) |
| [語音輸入的安裝](#語音輸入的安裝) | [`voice.spec.ts`](specs/voice.spec.ts) | 2 | [使用者說明 → 語音輸入](../docs/user-guide.zh-TW.md#語音輸入)、[架構 → 語音輸入](../docs/architecture.zh-TW.md#語音輸入) |
| [回報問題](#回報問題) | [`report.spec.ts`](specs/report.spec.ts) | 5 | [使用者說明 → 回報問題](../docs/user-guide.zh-TW.md#回報問題)、[架構 → 回報問題](../docs/architecture.zh-TW.md#回報問題) |
| [使用導覽與主題](#使用導覽與主題) | [`appearance.spec.ts`](specs/appearance.spec.ts) | 4 | [使用者說明 → 介面語言與使用導覽](../docs/user-guide.zh-TW.md#介面語言與使用導覽) |
| [環境變數設定的上限](#環境變數設定的上限) | [`limits.spec.ts`](specs/limits.spec.ts) | 4 | [開發者說明 → 環境變數](../docs/developer-guide.zh-TW.md#環境變數) |
| [語言](#語言) | [`i18n.spec.ts`](specs/i18n.spec.ts) | 2 | [架構 → 語言](../docs/architecture.zh-TW.md#語言) |
| [在手機上](#在手機上) | [`mobile.spec.ts`](specs/mobile.spec.ts) | 2 | [用手機連線](../docs/remote-access.zh-TW.md) |

測試以英文介面執行，所以下面括號裡附上測試實際操作的英文標籤。

## 登入

[`signin.spec.ts`](specs/signin.spec.ts)：還沒登入的瀏覽器（`signIn: false`）。最後四個也在介面的開發版 build 中執行（React 的 StrictMode 會把每個 effect 跑兩次），由 `global-setup.ts` 在一般的 build 旁邊建置。

| 情境 | 檢查的內容 |
| --- | --- |
| 還沒登入的瀏覽器看到登入頁，輸入代碼後登入 | 顯示登入頁，API 回應 401；錯誤的代碼會顯示代碼錯誤或已過期；新的代碼會打開 app，重新載入後仍保持登入。 |
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

## 新對話與首席 agent 的團隊

[`chat.spec.ts`](specs/chat.spec.ts)：從新對話頁開始的對話，首席 agent 會為每個問題組隊。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 首席 agent 提議團隊，確認後團隊回答 | Claude Code | 團隊卡片寫出團隊、理由與成員；按**確認團隊**（Confirm team）後，回答帶著它的 CLI 標籤；對話以第一個問題列在側邊欄，回答存成已完成。 |
| 不詢問直接採用首席 agent 組的團隊 | Claude Code | 卡片寫著**已直接採用**（Used without asking），團隊不必等待就回答。 |
| 三個 CLI 組成的團隊依序回答 | 三個一起 | 每位成員帶著自己 CLI 的標籤回答，依圓桌順序：Claude、Codex、Grok。 |
| 追問時再組一次團隊 | Claude Code、Codex | 第二個問題有自己的團隊，只有那位成員回答。 |

## 範本

[`templates.spec.ts`](specs/templates.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 列出內建範本，打開其中一個可看到成員 | — | 「三方辯論」（Three-way debate）標為內建，對話框列出 Proposer、Pragmatist 與 Skeptic。 |
| 首席 agent 直接使用範本 | 三個一起 | 卡片寫著使用「三方辯論」；兩輪中每位成員先以自己的 CLI 回答，再 PASS（共六則回答）。 |
| 把首席 agent 設計的團隊存成範本 | Claude Code、Grok | **存成範本**（Save as template）預設帶入團隊的名稱，卡片顯示已儲存，新對話頁也出現這個範本。 |

## 修改對話的團隊

[`team.spec.ts`](specs/team.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 請首席 agent 調整團隊，儲存後新成員回答 | Claude Code、Grok | 在**團隊設定 → 請首席 agent 調整**（Team settings → Ask the lead agent）中，要求會交給首席 agent，抽屜顯示它加入的成員，按**儲存**後兩位成員都回答。 |
| 首席 agent 的回答無法解讀時，改用範本 | Claude Code | 回答不是 JSON 時改用「一般問題智囊團」（General-question panel），由它的三位成員回答。 |
| 拒絕為新問題提議的團隊 | Claude Code、Codex | 按**不採用，沿用目前的團隊**（No, keep the current team）：卡片顯示沒有採用，由目前的團隊回答，提議的成員不回答。 |

## 成員的模型與推理強度

[`models.spec.ts`](specs/models.spec.ts)：在**團隊設定**中選擇並儲存。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 為成員選的模型與推理強度會交給它的 CLI | 各一 | 它們存在成員上，CLI 依轉接器的方式拿到：Claude Code 的 `--model` 與 `--effort`、Codex 的 `thread/start` 參數（`model_reasoning_effort`）、Grok 在 prompt 之前的 `session/set_config_option`。 |
| 設定中的預設模型與推理強度，就是保留「預設」的成員執行時用的 | Claude Code | 把 sonnet 與 Low 存成預設後，抽屜顯示「Default: sonnet」，成員仍是預設，它的回合拿到 `--model sonnet --effort low`。 |

## 成員如何輪流發言

[`turns.spec.ts`](specs/turns.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| agent 向使用者提問，等回答之後再用它來回答 | Claude Code | 問題顯示時沒有 `[ASK_USER]`，並有等待回答的卡片；輸入框提示回答 @Claude，側邊欄顯示**等你回答**（Answer needed）；回答會交給 agent。 |
| 略過問題，團隊其他人繼續 | Claude Code、Grok | 按**略過，讓團隊繼續**（Skip, let the team go on），下一位成員回答。 |
| 接力模式：成員把發言權交給它 @ 的隊友 | Claude Code、Codex | 第一位成員先回答並 @ 第二位，第二位接著回答；之後發言權交還給使用者（共兩則回答）。 |
| @ 某位成員的訊息只由那位成員回答 | 三個一起 | 只有 @Grok 回答。 |
| 之後的回合沒有補充的成員 PASS，提前結束 | Claude Code、Codex | 設定三輪：兩人都回答、兩人都 PASS，沒有第三輪。 |
| 回答可以停止 | 各一 | 回答串流時按**停止**（Stop），回答以「(stopped)」結束，即時標籤與停止按鈕都消失。 |
| CLI 協定之內的錯誤顯示在回答上 | 各一 | Claude 的錯誤結果、失敗的 Codex 回合與 Grok 的 JSON-RPC 錯誤都顯示在回答上。 |
| 成員的下一回合接續自己的 session | 各一 | 第二回合接續第一回合開始的 session（假 CLI 和真正的 CLI 一樣，拒絕接續從沒開始過的 session）。 |
| CLI 遺失 session 的成員，帶著到目前為止的對話重新開始 | Claude Code | 刪掉 CLI 的 session 後，下一個 prompt 帶著整段對話，連第一則訊息也在。 |
| 失敗的回答顯示 CLI 的錯誤，重試後再回答 | 各一 | CLI 帶著錯誤結束：錯誤顯示在回答上，按**重試**（Retry）後回答。 |
| 團隊回答途中送出的訊息先等待，再交給下一位成員 | Claude Code、Grok | 第一位成員慢慢回答時，訊息在等待送出的區塊裡，下一位成員會回答它。 |

## agent 回答前做了什麼

[`activity.spec.ts`](specs/activity.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 思考、工具呼叫與待辦清單和回答一起顯示 | 各一 | 這些步驟收合成列；展開後可看到思考、已完成的工具（Claude 的 `Bash`、Codex 的 `Shell`、Grok 的 `list_dir`）與它的輸出，以及三項中完成一項、進行中一項的待辦清單。 |
| Markdown 回答會轉成格式 | Claude Code | 標題、清單、表格與上色的程式碼。 |

## 核准

[`approvals.spec.ts`](specs/approvals.spec.ts)：在會詢問使用者的唯讀對話中，agent 想執行指令（`echo e2e-approval`）。回答會交給各 CLI 自己的請求：Claude Code 的 `can_use_tool`、Codex 的核准請求與 Grok 的 `session/request_permission`。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 使用者允許的指令會執行 | 各一 | 卡片顯示指令，側邊欄顯示**等你核准**（Needs you）；按**允許**（Allow）後指令執行，卡片顯示已允許。 |
| 使用者拒絕的指令不會執行，附註會一起交給它 | 各一 | 卡片顯示「Declined: Not now」；Claude Code 與 Grok 拒絕時會收到附註（Codex 的回答沒有附註的位置）。 |
| 「本對話都允許」讓下一次同樣的請求自動通過 | Claude Code | 第二次請求自動允許，沒有卡片。 |
| 請求等待時停止團隊，指令不會執行 | Claude Code | 回答以「(stopped)」結束，請求被拒絕或沒有回答。 |
| 完全存取時，指令直接執行，也能不詢問就寫到任何地方 | 各一 | 標題列警告**完全存取**（Full access）；指令執行，檔案寫到另一個資料夾，沒有卡片。 |
| 自動拒絕的對話不詢問就拒絕 | Claude Code | 指令被拒絕，沒有卡片。 |

## 檔案與修改

[`files.spec.ts`](specs/files.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 編輯模式下 agent 修改檔案，聊天中顯示改了什麼 | Claude Code | 檔案在工作目錄裡，工作目錄也變成 git repository；變更卡片列出它，並能打開這一回合的 diff。 |
| 唯讀對話中不會寫入任何檔案 | 各一 | Claude Code 執行時沒有檔案工具（沒有卡片）；Codex 與 Grok 會詢問，然後被拒絕；沒有寫入檔案，也沒有變更卡片。 |
| 自動拒絕的唯讀對話中，Grok 說明原因 | Grok | 工具的錯誤寫著唯讀模式下不允許。 |
| 每個 CLI 都能在編輯模式寫檔，每一回合各自記下變更 | 三個一起 | 每位成員寫自己的檔案，每則回答的變更卡片都列出它。 |
| 平行模式中每位成員在自己的 worktree 工作，可以套用其中一份結果 | Claude Code、Codex | 兩張變更卡片都寫著「in worktree」，工作目錄裡什麼都沒有，直到按**套用到工作目錄**（Apply to working directory）帶進 Codex 的檔案。 |
| 檔案瀏覽器顯示工作目錄並預覽檔案 | Claude Code | **檔案**（Files）列出專案；`src/hello.ts` 打開後顯示程式碼；按 Escape 關閉。 |
| 資料夾可下載成 ZIP 檔，裡面沒有 .git | Claude Code | 工作目錄的 ZIP（`work.zip`）剛好包含它的檔案與內容，沒有 `.git`；某個資料夾自己的 ZIP（`src.zip`）只有那個資料夾。 |
| 太大而無法整個壓縮的資料夾，改為提供不含 git 忽略的檔案 | Claude Code | 一個長度設為超過 1 GiB、但沒有真的寫入的被忽略檔案（Windows 上仍會佔用磁碟空間）讓資料夾太大：拒絕時不下載任何東西，接受時得到不含被忽略資料夾的 ZIP。 |

## 工作目錄與其他資料夾

[`folders.spec.ts`](specs/folders.spec.ts)：假 CLI 只會寫在真正的 CLI 能寫的地方，所以這些測試能看出對話的資料夾有沒有傳到各 CLI。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 編輯模式下，對話沒有的資料夾碰不到 | 各一（Grok 不在 Windows 上） | 自動拒絕時，隔壁的資料夾不會寫入任何東西。Grok 在原生 Windows 上沒有沙箱，所以那裡跳過。 |
| 寫到對話沒有的資料夾前先詢問，使用者允許後才寫 | Claude Code、Codex | 在「想修改檔案」卡片按**允許**，檔案就寫在那裡。 |
| 在輸入框加入與移除資料夾，對話在所有資料夾中工作 | Claude Code | 在**工作目錄**（Working directories）輸入的資料夾變成標籤，也能移除；對話存下留下的資料夾，agent 在第一個與第二個寫檔，被移除的沒有。 |
| 各 CLI 在每個資料夾寫檔，變更卡片依資料夾列出 | 各一 | 兩個資料夾各一個檔案：卡片寫著「Changed 2 files」，每個資料夾一組，diff 兩個都有。 |
| 檔案瀏覽器列出每個工作目錄 | Claude Code | **檔案**有**資料夾**（Folder）選單，列出兩個資料夾；第二個顯示它自己的檔案。 |
| 平行模式中每位成員在每個資料夾都有 worktree，套用時全部一起套用 | Claude Code、Codex | 兩則回答在每個資料夾都有 worktree 的變更；**套用**會把 Codex 的檔案寫進兩個資料夾。 |
| 新對話從設定中的預設工作目錄開始 | — | 在**設定 → 預設工作目錄**存下的資料夾，出現在下一個新對話的輸入框裡。 |
| 選擇資料夾視窗加入在其中選的資料夾，對話在所有資料夾中開始 | 只在 Linux | **選擇資料夾…**（Choose folders…，假的 `zenity`）加入兩個資料夾；視窗開在最後一個資料夾裡，允許多選，標題是英文；新對話有這三個資料夾。 |
| 在沒有 UTF-8 locale 的伺服器上，以中文開啟選擇資料夾視窗 | 只在 Linux | 視窗標題是中文，並帶 `LC_CTYPE=C.UTF-8`；按取消不會加入任何資料夾。 |

## 除了 prompt 之外交給各 CLI 的東西

[`inputs.spec.ts`](specs/inputs.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 工具庫的 MCP 伺服器，其秘密不會出現在命令列上 | 各一 | 成員說出它拿到的伺服器，而秘密的值不在 CLI 啟動的任何參數裡。 |
| 附加的圖片 | 各一 | 圖片附加在輸入框中，回答說收到一張圖片，prompt 也寫出檔案名稱，讓 agent 能用自己的工具讀取。 |

## 工具庫

[`tools.spec.ts`](specs/tools.spec.ts)：**設定 → 工具庫**，在有 Claude Code、Codex 與 Grok 成員的對話中。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 在頁面上新增的 MCP 伺服器會交給每個 CLI，其秘密遮蔽顯示，也不在命令列上 | 三個一起 | 列上顯示給所有成員；編輯時值是空的，提示文字是遮蔽後的值；頁面與 `GET /api/tools` 都沒有秘密；每位成員都說出這個伺服器並拿到它的值，而值不在任何參數裡；回合結束後 Claude Code 的 `--mcp-config` 檔已經刪除。 |
| 對某個 CLI 或在成員的工具中關掉的 MCP 伺服器不會給出去 | 三個一起 | 在「預設提供給」中關掉 Codex，Codex 就拿不到；在 Codex 的**工具**中勾選、在 Grok 的取消勾選後，Codex 拿到它（保留存下的值），Grok 則沒有。 |
| 從資料夾挑選的 skill 出現在每個 CLI 的簡報中，每個 CLI 都讀了它的 SKILL.md | 三個一起 | 有兩個 skill 的資料夾中，加入的那個列在每份簡報中，每個 CLI 都讀出它的第一行；另一個從沒出現。Claude Code 只能透過轉接器加上的 `Read(…)` 規則讀取它（沒有這條規則時假 CLI 會拒絕）。 |
| 對某個 CLI 或在成員的工具中關掉的 skill 不會給出去 | 三個一起 | 對 Grok 關掉、在 Claude 的**工具**中取消勾選後，兩者都拿不到，Claude Code 的參數裡也沒有它。 |
| 給所有成員與給某個 CLI 的記憶會進入各自的簡報，成員的工具可以不帶 | 三個一起 | Codex 依序拿到共享記憶與它自己的筆記，其他人只有共享記憶；在 Grok 的**工具**中取消勾選**共享記憶**後，Grok 一則都沒有。 |

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
| 重新命名與刪除對話 | — | 標題列與側邊欄的標題都改變；**刪除對話**（Delete conversation）會把它從側邊欄與伺服器上移除。 |
| 依 agent 寫的內容搜尋對話 | Codex | 搜尋回答中的文字，找到那一個對話，點了就打開。 |
| 在 UI 開始的對話保留一開始給的標題 | Claude Code | 第一個問題之後標題不變。 |
| 拖進群組的對話會留在那裡，拖出來則回到「其他」 | — | 伺服器存下群組，重新載入後仍在；拖到「其他」後群組被清除，群組裡又顯示可以把對話拖到這裡。 |
| 分支對話的家族在群組之間一起移動 | Codex | 拖動分支時，原本的對話跟著移動，分支仍在它底下；把原本的對話拖回來時兩個都回來。 |

## 排程

[`schedule.spec.ts`](specs/schedule.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 儲存對話的排程，立即執行一次會把訊息送給團隊 | Codex | 存成「每天」（Every day）後，側邊欄標出這個對話；按**立即執行一次**（Run once now）送出標為排程的訊息，成員回答。 |

## 設定

[`settings.spec.ts`](specs/settings.spec.ts)

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 找到每個 CLI，顯示版本，且已登入 | 三個，同一個測試 | 每張卡片顯示 CLI 的版本與**已登入**（Claude Code 附帳號），側邊欄的三個狀態點都正常。 |
| 可以指定 CLI 的執行檔路徑，錯誤的路徑顯示找不到 | Grok | 不存在的路徑顯示**未安裝**（Not installed）；清空後又找到它。 |
| 切換語言，選擇會保留 | — | 選繁體中文後頁面改變，重新載入後仍保留，選 English 再改回來。 |
| 選另一個 CLI 擔任首席 agent | Codex 當首席 agent | 新對話頁寫出它，團隊卡片寫著「Lead agent: Codex」，首席 agent 的 prompt 交給了 Codex。 |
| 未登入的 CLI 顯示未登入，它的回答說明原因 | Codex | `E2E_FAKE_SIGNED_OUT=codex`：狀態點與卡片顯示**未登入**（不含 CLI 自己的說法），並有**登入**按鈕，它的回答帶著 CLI 的錯誤。 |

## 帳號

[`accounts.spec.ts`](specs/accounts.spec.ts)：**設定 → 各 CLI 的卡片 → 新增帳號**。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 新增的帳號有自己的資料夾，設定使用它的成員在那裡執行 | 各一 | 帳號放在 `<資料>/accounts/<cli>-<id>`，卡片上顯示這個資料夾；使用它的成員以這個家目錄執行（`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`GROK_HOME`），使用預設帳號的成員則用預設的。 |
| 每個帳號各自登入與登出 | Claude Code | **登出**只在新增帳號的家目錄執行 `auth logout`；**登入**走 CLI 自己的流程（一個連結，再貼上代碼），之後顯示這個帳號已登入。 |
| 金鑰儲存區關閉時，帳號的 API key 存在資料庫、遮蔽顯示，並只交給它的 CLI | Claude Code | API key 欄位說明金鑰存在哪裡；儲存後顯示遮蔽的值與「Using an API key」，`/api/settings` 裡從沒有它；那個帳號的執行以 `ANTHROPIC_API_KEY` 拿到它，不在任何參數裡，預設帳號的執行則沒有。 |

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
| 在設定中選的資料夾就是各 CLI 存放 session 的地方 | 三個一起 | 資料夾存下（只有擁有者能存取，Windows 上不檢查），每個 CLI 的 session 都在 `<資料夾>/<cli>/`，平常的家目錄裡沒有任何東西。 |
| 資料夾改變後，每位成員帶著到目前為止的對話在那裡開始新的 session | 三個一起 | 下一個 prompt 帶著整段對話，新的 session 在新的資料夾，舊的留在原處。 |
| Harness Relay 自己的資料夾或預設工作目錄裡的資料夾會被拒絕 | — | 兩種拒絕都會顯示，不建立任何東西，設定維持空白。 |
| 有對話正在執行時不能改資料夾 | Claude Code | 回答慢慢進行時，儲存會說有對話正在執行；停止後就能儲存。 |
| 每個回合之後與重新命名時，對話會送到 AgentsView，成員的 session 列在它底下 | Claude Code、Codex | 上傳帶著 AgentsView 自己的 `Origin`，以及它認得的 session 的專案與電腦；紀錄包含問題、兩則回答與標題；每位成員的 session 都連到它底下；重新命名會送出新標題。 |
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
| 在設定中選的深色或淺色會套用到頁面，重新載入後保留，且優先於系統 | 深色會設定 `data-theme`、背景與 `theme-color` meta，重新載入後仍在；系統是深色時，淺色仍維持淺色。 |
| 跟隨系統時會跟著系統的淺色或深色模式 | **跟隨系統**會移除 `data-theme`，頁面在開著時與重新載入後都跟著模擬的淺色或深色模式。 |

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
| app、範本與首席 agent 的卡片都是中文，agent 收到英文 prompt | 在 zh-TW 下，新對話頁、內建範本、輸入框的提示與團隊卡片都是中文，而回合的 prompt 是英文（見 [AGENTS.md](../AGENTS.md) 的「Prompts and languages」）。 |
| 登入頁與伺服器自己的訊息跟著語言 | 登入頁與伺服器對錯誤代碼的訊息都是中文。 |

## 在手機上

[`mobile.spec.ts`](specs/mobile.spec.ts)：Pixel 7 的螢幕與觸控，就像透過 Tailscale 使用聊天時一樣。Firefox 沒有行動裝置模擬，所以跳過。

| 情境 | CLI | 檢查的內容 |
| --- | --- | --- |
| 從選單開啟側邊欄，以觸控使用對話 | Grok | 按**開啟側邊欄**（Open sidebar）前側邊欄不在畫面上，前往別處時又會收起；送出按鈕會送出（觸控螢幕上 Enter 是換行）；標題列的動作收在**更多**（More）之下。 |
| 很長的訊息不會讓頁面左右捲動 | Claude Code | 300 個字元的單字與 Markdown 回答都不會造成左右捲動。 |

## 各 CLI 一覽

三個 CLI 都測到的情境（大多是每個 CLI 一個測試），所以某個轉接器的改變會在這裡看出來：

| 情境 | Claude Code | Codex | Grok |
| --- | --- | --- | --- |
| 思考、工具呼叫與待辦清單 | ✓ | ✓ | ✓ |
| 允許指令，以及附註後拒絕 | ✓ | ✓（沒有附註） | ✓ |
| 完全存取：不詢問就執行並寫到任何地方 | ✓ | ✓ | ✓ |
| 唯讀對話不寫入任何檔案 | ✓（沒有檔案工具） | ✓（詢問後被拒絕） | ✓（詢問後被拒絕） |
| 對話沒有的資料夾碰不到 | ✓ | ✓ | ✓（不在 Windows 上） |
| 使用者允許後寫到那裡 | ✓ | ✓ | — |
| 多個工作目錄：每個都寫一個檔案 | ✓ | ✓ | ✓ |
| 工具庫的 MCP 伺服器，秘密不在命令列上 | ✓ | ✓ | ✓ |
| 附加的圖片 | ✓ | ✓ | ✓ |
| 停止回答 | ✓ | ✓ | ✓ |
| 協定之內的錯誤 | ✓ | ✓ | ✓ |
| 失敗的回答（CLI 結束）與重試 | ✓ | ✓ | ✓ |
| 下一回合接續自己的 session | ✓ | ✓ | ✓ |
| 設定中的版本與登入 | ✓ | ✓ | ✓ |
| 成員的模型與推理強度 | ✓ | ✓ | ✓ |
| 新增帳號自己的家目錄 | ✓ | ✓ | ✓ |
| 工具庫的 MCP 伺服器、skill 與記憶，給出去與拿掉 | ✓ | ✓ | ✓ |
| 各 CLI 存放 session 的資料夾，以及改變後的新 session | ✓ | ✓ | ✓ |
| 列出它自己的 skill，並在下一次執行時不載入 | ✓ | ✓ | ✓（信任資料夾之後） |

## 平台與瀏覽器

- [`.github/workflows/e2e.yml`](../.github/workflows/e2e.yml) 會在每個 pull request 與每次推送到 `main` 時，以 Node 24 在 Ubuntu、macOS 與 Windows 上，並以 Node 22 在 Ubuntu 上，用 Chromium 執行所有 spec。手動執行可以選擇其他瀏覽器；在本機則用 `E2E_BROWSERS=chromium,firefox,webkit`（[`playwright.config.ts`](../playwright.config.ts)）。
- 選擇資料夾視窗的測試只在 Linux 上執行：Linux 從 PATH 找它的視窗，假的視窗可以替代；macOS 與 Windows 以完整路徑開啟自己的視窗。
- 「對話沒有的資料夾碰不到」在 Windows 上跳過 Grok，因為它在那裡沒有沙箱（[各平台的作業系統沙箱](../docs/sandboxing.zh-TW.md)）。
- [在手機上](#在手機上)在 Firefox 中跳過。
- [複製與分享](#複製與分享)的兩個複製測試只在 Chromium 執行（要讀剪貼簿），「沒有 gh」則在 Windows 上跳過。
- [回報問題](#回報問題)中讀取郵件連結的三個測試，在沒有 Navigation API 的瀏覽器中跳過。

## 沒有測到的部分

- **CLI 本身。**假 CLI 檢查的是 Harness Relay 這一端的協定。CLI 改變它的輸出時，由轉接器測試錄下來的訊息（`test/claude.test.ts`、`test/codex.test.ts`、`test/grok.test.ts`）以及在 app 中試用真正的 CLI 發現。
- **還沒有 spec 走過的功能**：語音輸入本身的錄音與轉寫（它會下載引擎與模型，也需要麥克風；只測了安裝的面板）；分享的回答所連結的檔案，以及上傳回報的截圖（兩者都用 git 推送到 gist，假的 `gh` 沒有代替這部分）；作業系統金鑰儲存區中的 API key（測試會關掉它，所以 key 存在資料庫）；從設定登入 Codex 與 Grok；AgentsView 中首席 agent 與分類對話的 session 連結，以及設定網址後才送出的對話；連不含 git 忽略的檔案都太大的 ZIP；以及桌面 app 視窗裡登入之後的部分（它自己的檢查 `desktop/scripts/smoke.ts` 與 `desktop/scripts/check-package.ts` 會開一個這些假 claude、codex 與 grok 的唯讀對話，讓每一個回答一個問題，在打包好的伺服器上與打包好的 app 裡都會跑：CI 在 Linux 與 Windows 上，發佈前則在每個系統上）。其中有些有單元測試，在 [`test/`](../test/) 裡，列在開發者說明的[測試](../docs/developer-guide.zh-TW.md#測試)。

## 相關文件

- [開發者說明 → 端對端測試](../docs/developer-guide.zh-TW.md#端對端測試)：它們如何運作、fixture、假 CLI 與它們的 `e2e:` 指令，以及如何撰寫測試。
- [開發者說明 → 測試](../docs/developer-guide.zh-TW.md#測試)與[持續整合](../docs/developer-guide.zh-TW.md#持續整合ci)：單元測試與 CI workflow。
- [參與開發 → 測試](../CONTRIBUTING.zh-TW.md#測試)：測試的規則。
- [使用者說明](../docs/user-guide.zh-TW.md)：這些情境走過的功能，以使用者的角度說明。
- [架構](../docs/architecture.zh-TW.md)：伺服器如何做到它們檢查的事（[CLI 轉接器](../docs/architecture.zh-TW.md#cli-轉接器)、[權限對應](../docs/architecture.zh-TW.md#權限對應)、[安全性](../docs/architecture.zh-TW.md#安全性)）。
- [各平台的作業系統沙箱](../docs/sandboxing.zh-TW.md)：為什麼對話沒有的資料夾各 CLI 都碰不到，以及哪裡做不到。
- [用手機連線](../docs/remote-access.zh-TW.md)：[在手機上](#在手機上)代表的使用情境。
- 程式碼：[`playwright.config.ts`](../playwright.config.ts)、[`fixtures.ts`](fixtures.ts)、[`global-setup.ts`](global-setup.ts)、[`support/`](support/)（`relay.ts`、`app.ts`、`fake-cli.ts`）、[`fake-cli/`](fake-cli/) 與 [`specs/`](specs/)。
