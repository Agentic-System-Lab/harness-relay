[English](adding-a-coding-agent.md) | **繁體中文**

# 新增 coding agent 的流程

一個新的 coding-agent CLI 怎麼加進 Harness Relay，一步一步來，就像過去加入 Grok、Cursor、五個開源 agent（OpenCode、Goose、Cline、OpenHands、Pi）與 Antigravity 時那樣做。[開發者說明](developer-guide.zh-TW.md#新增一個-agent-cli)列出程式碼要改的地方；這一頁說的是圍繞著它們的工作順序，以及每一步進到下一步前要做的檢查。每個改動都要遵守的規則在 [CONTRIBUTING](../CONTRIBUTING.zh-TW.md)。

一個 agent 要**對真正的 CLI 確認過**才算可以合併：adapter 依賴的行為都是實際看過的，不是猜的，而且文件寫明是用哪個版本、哪個系統確認的。

## 1. 先取得共識

寫程式之前先開一個**功能建議**的 issue：新的 agent CLI 屬於比較大的改動（[CONTRIBUTING → 提出功能建議](../CONTRIBUTING.zh-TW.md#提出功能建議)）。說明它走哪一條路：

- **原生 adapter**，給有自己登入的 CLI（Claude Code、Codex、Grok、Cursor、Antigravity）。它在自己的家目錄與帳號下執行，低於完全存取時在它自己的 OS 沙箱裡執行；沒有可用的沙箱時，每個指令都先詢問（Cursor、Antigravity）。
- **開源 agent**，給在「設定」的模型來源上執行的開源 CLI，用 Harness Relay 自己的家目錄，低於完全存取時在 Harness Relay 自己的沙箱裡執行（[開源 agent](open-agents.zh-TW.md)）。

從 `main` 開分支，在 repository 裡你自己的 worktree 工作（[AGENTS.md → Worktrees](../AGENTS.md#worktrees)），在裡面執行 `npm install`，並設定一個短的 `RELAY_DATA_DIR`（relay 沙箱的 socket 需要短路徑）。

## 2. 取得 CLI，但不動到你自己的環境

- **分開安裝。** 執行安裝腳本前先讀過；寧可自己抓它的發行檔（Antigravity：它的 manifest、壓縮檔、SHA-512 檢查），放進 worktree 的暫存空間；不要讓它改你的 shell 設定檔，也不要裝在你平常用的那份上面。
- **每次執行都隔離它的家目錄**：用它自己的變數（`CODEX_HOME`、`GROK_HOME`、`CURSOR_CONFIG_DIR`）、參數（`agy acp --gemini-dir`），或暫時看一下時用 `HOME`。光是 `agy --version` 就會寫進 `~/.gemini`；你建立的東西要清掉。
- **不要讓它開瀏覽器。** 有些 CLI 在未登入時，第一個需要登入的指令就會啟動瀏覽器登入（Antigravity 除非認為自己在 SSH 裡；Cursor 除非有 `NO_OPEN_BROWSER`）。問它任何事之前先設好這個開關。

## 3. 弄清楚它實際的行為

讀它的 `--help`（以及每個子指令的）、文件、changelog（Antigravity 內建一份：`agy changelog`），有原始碼就讀原始碼，然後用 CLI 本身實際試下面每一點。邊做邊記下答案：它們會變成 adapter 開頭的註解、測試和文件。

| 問題 | 為什麼重要 | 以前的例子 |
| --- | --- | --- |
| 有沒有能在工具呼叫前**詢問**的協定（ACP、JSON-RPC、帶權限 hook 的 stream-json）？ | 不能詢問的 headless 模式，第一次拒絕就會把回覆截斷。 | Grok 為此從 `grok -p` 改走 ACP（`Run Grok over ACP so refused tool calls no longer end the turn`）。 |
| 它的每種模式下哪些**不詢問**就執行，它自己的設定能放寬什麼？ | 它自己的允許規則、核准模式或「一律允許」的回答，都不能放寬唯讀或編輯。 | Cursor：`cli-config.json` 的允許規則（每次執行一個私有設定資料夾）；Antigravity：`toolPermission` 與 `allowNonWorkspaceAccess`（每次執行自己的設定，只保留帳號的模型與服務），而它的允許與拒絕規則在 ACP 下不生效。 |
| 它的**沙箱**在這個模式下能用嗎？無法啟用時會不會直接拒絕執行？ | 低於完全存取時，是沙箱把編輯限制在工作目錄裡。 | Cursor 的 ACP 模式不套用任何沙箱；Antigravity 的沙箱在 ACP 下不讓指令寫工作目錄；Grok 的自訂 profile 套不上時會拒絕啟動，而不是不帶沙箱執行。 |
| **拒絕**會發生什麼事？理由能不能傳給模型？ | 決定簡報要怎麼寫、聊天室要顯示什麼。 | Grok 接受 `_meta.followup_message`；Cursor 與 Cline 只傳它們自己的固定字句；Antigravity 會結束這一輪。 |
| **簡報**放在哪裡？ | 系統提示（Claude Code 的 `--append-system-prompt`、Grok 的 `_meta.rules`、Antigravity 的 `_meta.antigravity.systemPrompt.append`），或 prompt 的最上面（Cursor）。接續的 session 要不要再給一次。 | Antigravity 每收到一份簡報就加一份，所以只有內容變了才再給。 |
| **Session**：新建、resume、load；load 會不會重播歷史？ | 重播的更新不屬於這一輪；無法接續的 session 必須在這一輪說任何話之前就失敗，orchestrator 才會開新的重試。 | Cursor 的 `session/load` 會重播；Grok 與 Antigravity 的 `session/resume` 不會。 |
| **家目錄與登入**：搬移家目錄的變數、登入存在哪裡、怎麼用連結登入、不靠提示就能查狀態與登出？ | 帳號、「設定」的登入、狀態標籤。每個電腦使用者只保留一份的登入，會讓額外帳號只能用 key。 | Cursor（鑰匙圈）與 Antigravity（系統 keyring）的非預設帳號只用 API key 登入。 |
| **模型與推理強度**：怎麼列出、怎麼命名、每個 session 怎麼設定？ | 模型選單，以及每一輪要設定什麼。 | Cursor 的參數化模型選擇；Antigravity 在 resume 後會重設模型。 |
| **MCP 伺服器**、圖片、其他工作目錄？ | 工具庫與附件能提供它什麼。 | HTTP MCP 伺服器只給有宣告支援的 agent。 |
| **它自己會載入的東西**（skill、MCP 伺服器、hook、subagent、plugin、指示檔），以及每一種有沒有單次執行的開關？ | 「設定」裡的清單與 `NATIVE_OFF_SUPPORT`；會執行程式碼的專案檔案（hook、MCP 伺服器）是逃出沙箱的途徑。 | Antigravity 一開啟 session 就會啟動專案的 `.agents/hooks.json` 與 `mcp_config.json`，不經詢問，唯讀模式下也一樣；其他 agent 寫得到它們，所以 Harness Relay 會在 agy 啟動前先詢問。 |

**沒有付費帳號時**，若 CLI 能設定 base URL，就讓它連到模型 API 的模擬伺服器（Antigravity 是用 Gemini API key 搭配一個照腳本回應的 Gemini API 模擬伺服器探索的，順便看到它送出的系統提示與工具），或是 OpenAI 相容的 CLI 連到本機模型伺服器（Ollama、vLLM）。用這種方式確認不了的部分（真正的登入、真正的模型），要在文件裡寫明。

## 4. 決定權限對應

寫 adapter 之前，先在[架構 → 權限對應](architecture.zh-TW.md#權限對應)寫好它在唯讀／編輯／完全存取下的那一列，之後照著做：

- **唯讀**：讀取與網路查詢直接執行；其他都問使用者（對話設為自動拒絕時則拒絕）。
- **編輯**：對話工作目錄內的編輯直接執行；發布（`isPublishCommand`）要詢問；指令只有在能把它們限制在那裡的沙箱裡才直接執行；沒有這種沙箱時，每個指令都要詢問，卡片要說明它會在沙箱外執行（`outsideSandbox`）。寫在之後可能讓程式碼執行的地方（專案的 agent 設定、`.git/hooks`、`.vscode`）要詢問。
- **完全存取**：agent 自己的一律允許模式。
- 低於完全存取時，受保護的路徑（`protectedReads()`）一律不給：CLI 有沙箱或規則時透過它們，否則在它詢問時拒絕。
- 絕不回答「一律允許」（CLI 會把規則存起來）；只回答允許一次或拒絕一次。
- 做不到就不執行：套不上的設定、無法啟動的沙箱、會被規則當成 pattern 的路徑，這一輪都不啟動，並說明原因。

## 5. 寫 adapter

照著[開發者說明的檢查清單](developer-guide.zh-TW.md#新增一個-agent-cli)（原生 adapter 或開源 agent）做，再處理型別檢查找不到的地方：首席 agent 與各 agent 的簡報（CLI 的清單）、`agentFolders()`，以及需要時的 `INHERITED_BACKEND_VARS`、`PROJECT_AGENT_CONFIG`、`keyOnlyAccount()` 與 `failedProbe()`。`AGENTSVIEW_SESSIONS` 型別檢查會指出來，但該填什麼它不知道：先從 AgentsView 自己的原始碼查清楚，它讀不讀得到 Harness Relay 的執行留下 session 的地方、用什麼 id，再決定給它前綴還是 `recorded`。接著：

- 讓 parser 保持純函式（更新進、`AgentEvent` 出），決策也是（`<name>PermissionDecision`、`<name>ApprovalRequest`），測試才能餵它錄下來的訊息。
- 只透過 `src/server/process.ts` 啟動 CLI，絕不透過 shell；開源 agent 透過 `startOpenProcess()`。
- 每次執行的設定寫在它自己的資料夾，只有擁有者能存取，這一輪結束就刪掉，絕不寫進使用者自己的檔案（Cursor 的設定資料夾、Antigravity 的 `--cli_dir_name` 資料夾），也只從使用者自己的設定拿這次執行需要的部分（Antigravity：模型與服務）。
- 小心循環 import：`agents/index.ts` 會 import 每個 adapter，所以 adapter 不能 import 會反過來 import `agents/index.ts` 的模組（`models.ts`、`native.ts`、`providers.ts`）；循環會在伺服器啟動時出現「Cannot access … before initialization」（`test/parent.test.ts`）。
- 每則訊息都要有兩種語言（`src/server/i18n.ts`、語系檔），以及 UI 的部分（顏色、「設定」卡片、API key 說明、原生設定附註、問題回報表單、pull request 範本）。

## 6. 錄製與測試

- **錄下由你的 adapter 驅動的真正 CLI**：把 adapter 的執行檔指向一個小包裝程式，由它啟動真正的 CLI，並把雙向的每一行都記下來（`{dir, msg}`），然後跑每個情境：一般回覆（含思考與工具呼叫）、唯讀下的拒絕、自動拒絕、受保護路徑、工作目錄內外的編輯、完全存取、接續 session、中途停止、未登入。
- 錄音放進 `test/fixtures/<name>/` 前**先清理**：你的路徑（改成 `/work/app`、`/home/user`）、使用者名稱、key、token、登入連結；然後在資料夾裡搜尋確認都清掉了。
- 透過 stand-in **重播**它們（`test/fake-<name>.ts`，像 `fake-cline.ts` 與 `fake-antigravity.ts`），在 `test/<name>.test.ts` 測：決策、核准卡片、parser、每次執行的設定與參數、簡報、模型與原生清單，以及完整的一輪。把它的情境加進共用的測試（`providers`、`protect`、`agentsview`、`native`、`store`、`app`、`route`、`i18n`、`tour`），並親手用 CLI 真正的指令跑一次狀態、模型與原生清單。
- **幫它寫端對端測試用的假 CLI**（見開發者說明的[端對端測試](developer-guide.zh-TW.md#端對端測試)）：`e2e/fake-cli/agents/<name>.cjs`（列在 `e2e/fake-cli/fake-cli.cjs` 裡）照錄音的格式，說它的 adapter 會用到的那部分協定（ACP 的 CLI 用 `lib/acp.cjs`）；伺服器問它的每件事（版本、狀態、模型、原生清單、登入與登出）都要回答，其他的一律立刻以錯誤結束；它的行為只取決於 Harness Relay 設好的東西：參數、設定檔與環境變數、權限、核准請求的答覆，開源 agent 則還有完全存取以外真正的 relay 沙箱。它的事實寫在 `e2e/support/clis/<name>.ts`（列在 `clis/all.ts` 裡）：每個逐 CLI 的 spec 依它分支。設成 `implemented: true` 後，每個逐 CLI 的測試都會為它執行，標題是 `<name>: …`（`npx playwright test -g "<name>:"`），它也會加入團隊測試。spec 需要、但之前的 CLI 都沒有的事實，加在 `CliFacts` 最後，設為選填，預設值寫在 `clis.ts`。先用一個它自己的暫時 spec 經由真正的 UI 試過各個情境：比共用的 spec 更快找出格式錯在哪裡。
- 測試要保持離線，並在 Windows 上通過：靠 `#!` 啟動的 stand-in 放在 `skipIf(process.platform === 'win32')` 底下，路徑用 `join()` 組。

## 7. 端到端檢查

- `npm run typecheck`、`npm test`、`npm run build`、`npm run test:e2e`（它的假 CLI 的測試、有它的團隊測試，以及設定頁與側邊欄的數量，它們會算進每個 CLI），沙箱相關檔案有改時再跑 `npx tsx scripts/sandbox-check.ts`。改到 `desktop/` 時跑 `npm run desktop:typecheck`。
- **在 agent 會執行的每個系統上**：macOS、Linux（一台機器，或用 Docker 跑 relay 沙箱：[各平台的作業系統沙箱](sandboxing.zh-TW.md)）、Windows（一台電腦或 VM；那裡用 npm 安裝的 CLI 是 `.cmd` shim，照 `winLaunch.ts` 的方式啟動）。在那裡跑測試，以及對真正的 CLI 跑錄製過的情境。
- 有模型伺服器或登入時跑 `npm run test:e2e:live`。把 CLI 加進 `e2e/live/live.ts`：加到 `CLIS` 的預設清單，並依它能跑在哪裡加到 `ENDPOINT_CLIS`、`OPEN` 或 `CLOUD_CLIS`，實機的模型、團隊、寫入與沙箱測試才會納入它；只有它會做的事，再寫一個它自己的測試（例如 Antigravity 被拒絕後會結束這一輪）。

## 8. 寫文件，兩種語言

先把你確認過的事實（含版本與系統）整理成一份清單，文件才會一致；然後更新以下每一份及它的 `.zh-TW.md`：[README](../README.zh-TW.md)、[使用者說明](user-guide.zh-TW.md)、[架構](architecture.zh-TW.md)（每個逐 CLI 表格的一欄、adapter 段落、權限對應、providers 與帳號、安全性與已知限制）、[各平台的作業系統沙箱](sandboxing.zh-TW.md)、[開發者說明](developer-guide.zh-TW.md)（專案結構、測試清單）、[端對端測試情境](../e2e/README.zh-TW.md)（各區的表格與「各 CLI 一覽」）、開源 agent 的話還有[開源 agent](open-agents.zh-TW.md)（每個 agent 一節，附上確認過的版本）、[遠端存取](remote-access.zh-TW.md)、CONTRIBUTING 與 AGENTS.md，以及官網（`site/`，照 `site/DESIGN-GUIDELINES.md`）。確認不了的要寫出來。

## 9. Commit 與 review

- 一個（或少數幾個）commit，標題說明使用者得到什麼（`Add Cursor as a fourth coding agent, run over ACP with every command asked below full access`），內文依區域分組：adapter、設定與登入、UI 與 prompt、測試、文件；schema 有沒有變。
- Pull request 寫明試過哪些真正的 CLI、版本與系統。預期會有好幾輪 review：Cursor 與開源 agent 的工作就經過好幾輪（`close the gaps the review found`），每一輪都在同一個 commit 裡補上測試與文件。
- 側邊欄或「設定」有明顯變化時，demo 可能要重新錄（`npm run demo`）。
