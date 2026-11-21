[English](agent-cli-features.md) | **繁體中文**

# agent CLI 自己的功能

> **狀態：提案，尚未實作。** 見[提案](README.zh-TW.md)。

十二個 agent CLI 本身做得到、Harness Relay 卻還沒用上（或用的方式行不通）的功能，以及其中哪些能讓 agent 做得更好：subagent 與 workflow（包括 Claude Code 的 agent teams 與 dynamic workflows）、使用者自己端點上的 context 長度、計畫、提問、引導執行中的回合、結構化回答與預算。

## 怎麼找到的

2026-11-21 做的一次盤點，一個 CLI 一個 CLI 看，再由沒有參與盤點的審查者重新核對。每個 CLI 看的是：

- 它在 `src/server/agents/` 的轉接器，以及 Harness Relay 送出什麼、讀取什麼；
- 安裝的 CLI 的 `--help` 與各子命令的說明、套件裡的檔案（文件、changelog、schema；Codex 用 `codex app-server generate-json-schema`），以及它執行檔裡的字串；
- 廠商的文件、版本說明與公開的原始碼。

沒有對任何 CLI 下 prompt，也沒有讀任何 CLI 的 home。關於 CLI 的每項發現都有標籤：

- **本機**：在安裝的 CLI 裡看到（它的說明、schema、內附程式碼或內附文件）；
- **文件**：只出現在廠商的文件、版本說明或公開的原始碼；
- **待確認**：要實際跑一次才能確定。

關於 Harness Relay 本身的說法，會附上它的檔案與行號，不加標籤。

| CLI | 已檢查（`cliVersions.ts`） | 這次讀的版本 | 看到的最新版 |
| --- | --- | --- | --- |
| Claude Code | 2.1.322 | 2.1.330 | 2.1.330（npm `latest`；`stable` 是 2.1.323） |
| Codex | 0.167.0 | 0.167.0 | 0.171.0 |
| Grok | 1.0.77 | 1.0.89 | 沒有查 |
| Cursor | 2026.11.11-043ef28 | 2026.11.11-043ef28 | 2026.11.17 |
| Antigravity | 1.5.6 | 1.5.11（它的 `agy changelog` 到 1.5.13） | 1.5.13 |
| Copilot | 1.0.109 | 1.0.112 | 1.0.114（預覽版 1.0.115-4） |
| Muse Code | 1.4.18 | 1.4.23 | 1.4.24 |
| OpenCode | 1.19.5 | 1.19.5 | npm 上 1.19.6（GitHub 上另有 2.x，2.3.2） |
| Goose | 1.58.1 | 1.58.1 | 1.60.2 |
| Cline | 3.0.74 | 3.0.74 | 3.0.74 |
| OpenHands | 1.16.0 | 1.16.0 | 1.16.0 |
| Pi | 1.5.1 | 1.5.1 | 1.6.0 |

讀的版本比已檢查的新時，關於它的發現不一定適用於已檢查的版本；在據此動手之前，先用 [CLI 檢查](../developer-guide.zh-TW.md#檢查-cli-的新版本)確認。

## 現在有什麼

- **Harness Relay 自己的團隊在 CLI 之上運作。** 對話的每個成員是一個 CLI session；每個回合啟動一次 CLI（Codex 的 app-server、Grok 等的 ACP、Claude Code 的 stream-json、Pi 的 RPC），接續成員的 session，回合回答後就結束程序。誰發言由協調器決定（[發言排程](../architecture.zh-TW.md#發言排程模式)），首席 agent 設計團隊並審閱它的回覆，[團隊檢查](../architecture.zh-TW.md#團隊檢查)讓團隊遵守同一套規則。
- **聊天畫面能顯示的**，是轉接器轉成 `AgentEvent` 的內容（`src/server/agents/types.ts`）：文字、思考、計畫、工具呼叫和 session id。回合裡由 subagent 做的事沒有對應的事件，壓縮、重試或換模型也沒有通知。
- **Harness Relay 已經用上的**，依 CLI 不同：推理強度；思考摘要（Claude Code 的 `--thinking-display`、Codex 的 `model_reasoning_summary`）；CLI 有回報時的計畫；CLI 自己的壓縮，有的都保持開啟；Copilot 的 LSP 設定；Goose 用來傳達拒絕原因的引導；以及每個帳號對 CLI 自己載入的內容（技能、MCP 伺服器、內建工具、指示檔、記憶、hooks、subagent、外掛）的開關，CLI 允許到哪裡就到哪裡（[各 CLI 自己載入的內容](../architecture.zh-TW.md#各-cli-自己載入的內容)）。Claude Code 自己的 subagent（內建的除外）與單一內建工具都能排除，OpenCode 的 subagent 也能；Codex 與 Grok 沒有只排除自己的、保留內建 subagent 的開關。

## 缺什麼

### 1. subagent 與 workflow 在看不見的地方執行，有些還會被中斷

現在大多數 CLI 都能把回合的一部分交給 subagent，有幾個還能跑整套由 subagent 組成的 workflow。在 Harness Relay 的執行裡，這些大多是開著的，它們做的事卻沒有一樣進到聊天畫面。

| CLI | 內建的 | 在 Harness Relay 的執行裡 | 聊天畫面看得到什麼 | 問題 |
| --- | --- | --- | --- | --- |
| Claude Code | `Agent` 工具與自訂 subagent；dynamic workflows（`Workflow` 工具）；agent teams | `Agent` 開著。`Workflow` 除了 Pro 以外的帳號都預設開啟（本機：它的開關；文件），並經過權限檢查：完全存取以外，對話會詢問時以一般的核准卡送到使用者面前，否則被拒絕；完全存取時直接執行。agent teams（`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`）在 `-p` 下不會產生 teammate，指名的 subagent 會以一般 subagent 執行（文件） | 它們做的事都看不到：帶 `parent_tool_use_id` 的事件全部丟掉（`claude.ts:1177`），所有 `system` 訊息（`task_started`、`task_progress`、`task_notification`）也被忽略。它們的 token 有算進回合總數 | Harness Relay 在第一個 `result` 關閉 stdin（`claude.ts:1479`），但會一直讀到 Claude Code 結束，並加總之後 result 的用量（`claude.ts:1236-1240`）。Claude Code 會等背景的 subagent 與 workflow，但閒置 10 分鐘就停掉它們（本機與文件：`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`，預設 600,000），而 Harness Relay 的一個回合可以長達一天 |
| Codex | subagent：預設開啟。在 0.167.0，`agents.enabled=false` 會關掉它們，但 `features.multi_agent_v2` 開著時以它為準；否則由內附目錄裡模型的 `multi_agent_version` 決定，沒有這個值的模型（`gpt-5.5`、端點上的模型）才看 `multi_agent` 旗標（文件：原始碼；本機：內附目錄）。`ultra` 強度會自己分派工作（「Maximum reasoning with automatic task delegation」，本機：內附目錄） | 開著，且有提供 `ultra` | 什麼都沒有：其他 thread 的通知被丟掉（`codex.ts:808`），`collabAgentToolCall` 與 `subAgentActivity` 項目沒有處理；subagent 的 thread 沒有算進回合的 token | 在編輯模式（原生 Windows 除外），受保護的路徑是 thread 權限設定檔裡的 `read` 項目（`codexGuardReads()`，`codex.ts:88`）。子 thread 會失去沙箱的限制，0.170.0 才修好（文件：版本說明）；這次修改保留的是 `deny` 項目，`read` 項目是否保留：待確認。核准時的檢查對 subagent 沒有路徑：它的請求只帶項目 id，路徑在 `codex.ts:808` 被丟掉的通知裡，所以 `codexGuardRefuses()` 什麼都不拒絕，卡片上也沒有檔名。團隊檢查在回合後仍會在磁碟上比對受保護的路徑 |
| Grok | `spawn_subagent`，預設在背景執行；完成時會喚醒上層（本機：內附文件） | 開著（只能連同內建的一起全部關掉） | 什麼都沒有：其他 session 的更新被丟掉（`grok.ts:1179`） | prompt 一回答，Harness Relay 就關閉 stdin（`grok.ts:1275`），所以喚醒的回合永遠不會執行（在 ACP 下是否如此：待確認）。`GROK_MAX_CONCURRENT_SUBAGENTS` 與 `GROK_SUBAGENTS_MAX_DEPTH` 都存在（本機），但沒有設定 |
| Cursor | subagent（`explore`、`shell`、`browser_use`…）；每個完成的 Task 呼叫都有一則 `cursor/task` 訊息；client 宣告 `subagents` 能力時，每個 subagent 也是一個子 session，而且 prompt 會等它的背景 subagent（文件：2026.09.15；本機：內附程式碼） | 開著；沒有宣告這個能力（`cursor.ts:608`） | 什麼都沒有：其他 session 的更新與其他方法都被忽略（`cursor.ts:547-552`） | — |
| Copilot | `/fleet`（平行的 subagent）、`rubber-duck`、`explore`、`task`、`code-review` agent、自訂 agent（本機：說明主題、內附定義） | 保留帳號的 `subagents`、`customAgents`、`experimental` 與 `extensions` 設定（`KEPT`，`copilot.ts:144`）；從不要求 `/fleet` | 沒有任何標成 subagent 的內容：ACP 的執行期事件（`github.com/copilot/sessionEvent`；帶 `params.agentId` 的屬於 subagent）只會送 client 在 `initialize` 列出的類型，而 Harness Relay 一個都沒列（`copilot.ts:1564`）。subagent 的呼叫是否已經以沒有標記的工具呼叫送來：待確認 | 到 1.0.114 為止沒發現：`session/prompt` 會等附屬的背景工作完成（本機：`copilot help acp`）；1.0.115 的預覽版不再等背景 agent 的更新（文件），下次 CLI 檢查要重新確認 |
| Antigravity | subagent（`pro`、`flash`、`browser` 與自訂的）、`run_workflow`（1.5.9）、`/swarm`（1.5.5 起的預覽功能）（本機：`agy changelog`） | 開著；完全存取以外，它們的呼叫和其他呼叫一樣交給使用者（[沙箱](../sandboxing.zh-TW.md)） | 什麼都沒有（它們的更新是否送得到 Harness Relay：待確認） | prompt 回答後，Harness Relay 關閉 agy 的 stdin，3 秒後停掉它，並結束它的指令留下還在跑的程序（`antigravity.ts:1007-1010`）。這時還在跑的 subagent，完成時會喚醒 agent（本機：changelog 1.5.10，這個版本也讓關閉時會停掉它們），所以它的工作會遺失。`browser` subagent 透過 Chrome DevTools MCP（agy 用 `npx` 啟動）操作使用者自己正在執行的 Chrome（它的設定檔與登入狀態），只要使用者在 Chrome 允許了遠端偵錯：不經過 Harness Relay 的瀏覽器 proxy，也不在任何沙箱裡（文件；本機：執行檔）；1.5.8 修好了它的工具忽略拒絕與詢問規則的問題。`agy acp` 的 session 能否用到它：待確認 |
| Muse Code | `subagent_spawn`、`subagent_wait`、`subagent_read_result`、`subagent_status`、`subagent_send_message`、`subagent_cancel`；workflow（本機：1.4.23 執行檔） | 已檢查的 1.4.18 不給 session subagent 工具（[CLI 轉接器](../architecture.zh-TW.md#cli-轉接器)的 Muse Code）；1.4.23 有（本機），執行時會不會有：待確認。workflow 刻意關閉（`MUSE_RUN_RUN_SETTINGS`）：回合結束時它們的 agent 都被取消了（`muse.ts:178-182`） | 什麼都沒有 | Muse 告訴模型，結果會「在 session 閒置時」送達，「所以繼續工作或結束回合」（本機）：回合結束時還在跑的子 agent 可能會遺失，就像 workflow 的 agent 那樣（待確認） |
| Cline | `spawn_agent`；agent teams（本機：它的 ACP 設定，`enableSpawnAgent:!0`、`enableAgentTeams:!1`） | `spawn_agent` 開著，它的 subagent 也會詢問（[開源 agent](../open-agents.zh-TW.md) 的 Cline）；teams 依 Cline 自己的 ACP 預設關閉 | `spawn_agent` 呼叫顯示成一列（類型 `think`，`cline.ts:374`）；它的 subagent 的呼叫不會顯示 | — |
| OpenCode | `task` 工具與 subagent（`explore`、`general`、自訂的） | 完全存取以外拒絕（`opencode.ts:504`）：會發問的 subagent 會卡住 | `task` 呼叫顯示成一列；子 session 的更新被丟掉（`acpTurn.ts:767`） | 一個唯讀、規則設成永不發問的 `explore` 不會卡住（本機：`opencode agent list` 解析出了這樣的規則；仍需實際跑一次） |
| Goose | subagent（`delegate`，透過 `summon` 擴充功能） | 開著；它們的工具呼叫和 agent 自己的一樣會詢問（`goose.ts` 的 `GOOSE_PLATFORM_EXTENSIONS`） | 它們的工具呼叫不會顯示 | `GOOSE_MAX_CONCURRENT_SUBAGENTS`（預設 5）、`GOOSE_SUBAGENT_MAX_TURNS`、`GOOSE_SUBAGENT_MODEL` 都存在（本機：執行檔），但沒有設定 |
| OpenHands | `task` subagent | 完全存取以外關閉，這是對的：它們不經詢問就行動（本機：`TaskManager(confirmation_handler=None)`） | — | — |
| Pi | 沒有內建（一個範例擴充功能會另外啟動 `pi` 程序，不經過 Harness Relay 的 gate 擴充功能） | — | — | — |

**簡單說 agent teams 與 dynamic workflows。**

- Claude Code 的 **agent teams** 是實驗功能，要設 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 才會開啟，而在 `-p`（Harness Relay 執行它的模式）下，即使開啟，Claude 也不會產生 teammate（文件）。Cline 的在 ACP 下是關閉的。兩者都取代不了 Harness Relay 自己混合多種 CLI 的團隊。
- Claude Code 的 **dynamic workflows**（`Workflow` 工具：執行 subagent 的腳本，預設一次最多跑 16 個，處理器少時更少，可用 `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` 設為 1 到 256，文件；每次最多 1,000 個，本機）在 `-p` 下可以用，除了 Pro 以外的帳號都預設開啟。在 Harness Relay 的執行裡，它既不受管理，也看不到：完全存取以外，對話會詢問時，這個呼叫以一般的核准卡送到使用者面前，卡片沒說它要跑什麼；完全存取時直接執行；它的進度只以 `task_*` 訊息送來，而這些訊息都被丟掉了。`ultracode` 關鍵字（Claude 會為每個實質的任務規劃 workflow）只在標成使用者本人的訊息（`origin: { kind: "human" }`）裡有效，所以 Harness Relay 送出的沒有標記的 stream-json 訊息無效；`--effort ultracode` 有效但會強制 `xhigh`，`"ultracode": true` 設定則保留原本的強度（文件）。
- 其他 CLI 的 workflow 是同樣的概念，只在一個 CLI 之內：Antigravity 的 `run_workflow`、Grok 的 workflow，以及 Copilot 的 dynamic workflows。Copilot 的只由擴充功能註冊，需要它的實驗模式、未停用的擴充功能模式，以及用量計費、Microsoft 365 帳號或（未登入 GitHub 時）使用者自己的模型供應商其中之一（本機）。因為 Harness Relay 保留帳號的 `experimental` 與 `extensions` 設定，帳號的擴充功能 workflow 現在就能在成員的回合裡執行。

CLI 自己的 subagent 能為 Harness Relay 的團隊多帶來的，是一個成員回合內、在它自己的 CLI 和模型上的平行工作：在另一個 context 裡探索、第二意見（Copilot 的 `rubber-duck`）、用便宜的模型做小任務。它取代不了由不同 CLI 組成的團隊，而且現在聊天畫面看不到它做的事。它的 token 在 Claude Code、OpenCode、Goose 與 Cline 上有算進回合總數，Codex 的 subagent thread 則沒有（[每則回覆的費用與 token](../architecture.zh-TW.md#每則回覆的費用與-token)）。

### 2. 端點的模型沒有 context window

Harness Relay 從不向端點詢問它的模型 context 有多長（`src/shared/types.ts` 的 `ModelEndpointView`），而開源 agent 需要這個數字，才能及時壓縮。context 最短的、在使用者自己電腦上跑的小模型受影響最大。

| CLI | 沒有 context window 時 | Harness Relay 可以寫在哪裡 |
| --- | --- | --- |
| OpenCode | context 為 0，所以在伺服器拒絕之前永遠不會壓縮（本機：執行檔）。在它認得的溢出錯誤之後（HTTP 413、`context_length_exceeded`，或 vLLM 的「maximum context length is N tokens」之類的訊息）會壓縮並重試（本機），1.19.6 起，供應商以請求內容過大拒絕時也會（文件）。默默截斷 context 的伺服器永遠不會觸發 | 每個端點模型項目裡的 `limit.context` 與 `limit.output`，現在只有 `{ name, tool_call: true }`（`opencode.ts:571`） |
| Goose | `/v1/models` 有回報時用 llama.cpp 的 `meta.n_ctx`；否則用它內附目錄裡認得的模型名稱的長度；再不然是 128,000 token（文件：1.58.1 原始碼）。所以 vLLM 或 Ollama 上 32k 的模型，壓縮（在 context 的 80%）永遠趕不上伺服器拒絕；之後 Goose 在它認得的溢出錯誤後才壓縮（文件：1.58.1 原始碼）。舊工具輸出的摘要預設關閉，除非設了 `GOOSE_TOOL_PAIR_SUMMARIZATION` | provider 檔裡每個模型的 `context_limit`，現在只有 `{ name }`（`goose.ts:314`），或 `GOOSE_CONTEXT_LIMIT` |
| Pi | `contextWindow` 128,000、`maxTokens` 16,384；壓縮從 `contextWindow − reserveTokens` 開始（本機：內附文件） | 它的 `models.json` 裡的 `contextWindow` 與 `maxTokens` |
| OpenHands | 依事件數量濃縮（`max_size: 80`，`openhands.ts:260`），以及伺服器回報溢出錯誤時；默默截斷 context 的伺服器永遠不會觸發（本機） | condenser 的 `max_tokens` |
| Cline | 3.0.74 在 ACP 下完全不壓縮（本機：它的 ACP 設定沒有送 `compaction`，`--compaction` 搭配 `--acp` 時被忽略） | 沒有：要等 Cline 在 ACP 下採用它的設定 |

其他對小模型有幫助、但現在都沒設定的：OpenCode 的 `compaction.prune`、`tool_output.max_lines` 與 `max_bytes`（預設 2,000 行與 51,200 位元組），以及 agent 的 `steps`，防止無限迴圈，到上限就強制用文字回答（本機）；Goose 的 `GOOSE_MAX_TOOL_RESPONSE_SIZE`（預設 200,000 字元，超過就寫進暫存檔）、`GOOSE_MAX_TURNS`、`GOOSE_AUTO_COMPACT_THRESHOLD`、`GOOSE_TOOL_PAIR_SUMMARIZATION` 與 `GOOSE_TOOL_CALL_CUTOFF`（本機：執行檔）；OpenHands 的 `native_tool_calling: false`，給不支援工具呼叫的端點用（本機）。

### 3. 從不出現的計畫

- **Claude Code。** 它所有追蹤任務的工具共用一道開關（本機：2.1.330 執行檔；文件：2.1.268 起，所以已檢查的 2.1.322 也是）。預設只有 Claude 3.x、Opus 4.0 到 4.7、Sonnet 4.0 到 4.6、Haiku 4.5，或透過 application inference profile 時才有；設 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`，或在 `--allowedTools`、`--tools` 列出其中一個，就能開啟。有這些工具時，Claude Code 給的是任務工具（`TaskCreate`、`TaskUpdate`…），設了 `CLAUDE_CODE_ENABLE_TASKS=0` 時則是 `TodoWrite`。Harness Relay 只把 `TodoWrite` 轉成計畫（`claude.ts:1202`），兩個變數都沒設，所以預設在任何模型上都不會出現計畫；而它使用的別名（`fable`、`opus`、`sonnet`、`haiku`：`src/server/models.ts`）在 Anthropic 自己的服務上指向 Claude 5 系列，兩種工具都沒有。Anthropic 的理由：較新的模型不需要寫下的清單就能追蹤多步驟的工作，而工具的定義與提醒會佔用 context（文件）。架構文件的表格說 Claude Code 的計畫來自「`TodoWrite` 工具」，已知限制也說計畫需要 `TodoWrite`；兩處都沒說它現在預設是關閉的。
- **Codex。** 它只在 `tools.update_plan.enabled=true` 時提供 `update_plan` 工具，2026 年 8 月起預設關閉（文件：0.167.0 的設定 schema 與原始碼；openai/codex#41744），而 Harness Relay 沒有設定：所以不會收到 `turn/plan/updated`，架構文件的表格說 Codex 的計畫來自 `turn/plan/updated`，描述的是預設已不會發生的事。`plan` 項目與 `item/plan/delta` 屬於 plan 模式。
- **Cursor。** 在 agent 模式下，它的待辦清單以 `cursor/update_todos` 送來，Harness Relay 忽略它；`plan` 更新只來自它的建立計畫工具（本機：內附程式碼）。架構文件的表格說 Cursor 的計畫來自 `plan` 更新；這大概只對 plan 模式成立（實際跑一次之前：待確認）。
- **Pi** 沒有待辦工具；它的擴充功能 API 可以註冊一個（本機：套件裡的 `examples/extensions/todo.ts`）。Harness Relay 的 gate 擴充功能在完全存取以外、以及團隊有 hooks 時會載入（`piGated()`，`pi.ts:86`）。
- **OpenHands** 的長期任務 system prompt（`system_prompt_long_horizon.j2`）會讓模型維護 `task_tracker` 計畫，聊天畫面本來就會顯示；預設的 prompt 沒有提到它（本機）。

### 4. CLI 自己的提問工具沒有下文

Harness Relay 的簡報要 agent 需要使用者時，在回覆結尾加上 `[ASK_USER]`（`src/shared/ask.ts`）。有幾個 CLI 有自己的提問工具，模型用到時，在 Harness Relay 的執行裡會失敗或得不到任何回答：

| CLI | 會怎樣 |
| --- | --- |
| Codex | `item/tool/requestUserInput` 被回答 `{ answers: {} }`（`codex.ts:813`）。這個工具預設只在 Harness Relay 不使用的 plan 模式提供，`tools.experimental_request_user_input.enabled=false` 可以關掉它（文件：0.167.0 的設定 schema 與原始碼） |
| Claude Code | 在 `-p` 下，只要設了 permission prompt tool，`AskUserQuestion` 就會開啟（本機）；完全存取以外、對話會詢問時正是如此（`--permission-prompt-tool stdio`，`claude.ts:954`）。它以一般的核准送到使用者面前，允許後回傳的也沒有答案（Claude 之後會怎樣：待確認）；Agent SDK 是用 `updatedInput.answers` 回答它（文件） |
| Grok | `ask_user_question` 與 plan 模式的請求都得到 -32601（`grok.ts:1183`）；`GROK_ASK_USER_QUESTION=0` 可以關掉這個工具（本機） |
| Antigravity | 它的簡報已經要 agy 照 Harness Relay 的指示提問，不要用它的 `ask_question` 工具（`antigravity.ts:450`）。如果它還是用了，問題在 ACP 下以表單（`elicitation/create`）送來，Harness Relay 以 -32601 回答（`antigravity.ts:903`）；agy 之後會怎樣：待確認（本機：changelog 1.5.1、執行檔） |
| Copilot | 用戶端沒有 elicitation 時，它的 `ask_user`（提問表單）會被拒絕並告知模型（本機：內附程式碼）；`--no-ask-user` 可以不提供這個工具（本機）。在 ACP 下會怎樣：待確認 |
| Muse Code | Harness Relay 沒有宣告表單 elicitation 能力（`muse.ts:1169`），所以 Muse 自己取消 `request_user_input` 的提問，並要模型說明假設後繼續（本機：執行檔）：問題到不了使用者，但回合會繼續。`--disable-request-user-input` 會把這個工具從主對話拿掉（本機）；能得到的不多 |

### 5. 訊息進不了執行中的回合

團隊工作時使用者送出的訊息，會在佇列裡等待，在它要給的 agent 的下一個回合之前送出（[發言排程](../architecture.zh-TW.md#發言排程模式)）。有幾個 CLI 能把訊息帶進正在進行的回合：

| CLI | 方法 | 標籤 |
| --- | --- | --- |
| Codex | `turn/steer { threadId, input, expectedTurnId }`（stable）；Harness Relay 本來就有記下回合 id | 本機 |
| Claude Code | 對執行中的 stream-json session 寫入一則使用者訊息，`priority` 為 `now`、`next` 或 `later` | 文件 |
| Grok | `x.ai/interject`、`x.ai/queue/*` | 本機 |
| Antigravity | 回合執行時再送一個 prompt 就會引導它（1.5.0） | 本機 |
| Goose | `_goose/unstable/session/steer`，Harness Relay 已經用它傳達拒絕的原因（`goose.ts:980`） | 本機 |
| Pi | `steer`（在目前的工具呼叫之後、下一次呼叫模型之前）與 `follow_up` RPC 命令 | 本機 |
| Cursor | 沒有：新的 prompt 會取消執行中的那個 | 本機 |

Muse Code 有 `user_steer` 輸入，Copilot 的 ACP 也可能可以引導；兩者都還沒確定（待確認）。

### 6. 首席 agent 回合的結構化回答

首席 agent 的團隊設計、審閱與側邊欄分組都是自由文字，由 Harness Relay 解析（`planner.ts` 的 `parsePlanReply()`、`reviewer.ts` 的 `parseReviewReply()`、`grouping.ts` 的 `parseGroupReply()`）。Claude Code 的 `--json-schema`（它的 `result` 帶有 `structured_output`）與 Codex 在 `turn/start` 上的 `outputSchema`（stable，只對一個回合）會讓 CLI 依指定的 JSON 形狀回答（本機）。使用者自己的端點不一定支援，所以解析器保留作為備援。

### 7. 預算、備援模型與費用

- **Claude Code**：`--max-budget-usd`（限制一次執行的花費，到上限時拒絕開新的 subagent，並停下背景的 subagent；它看的是 Claude Code 自己的估算，所以在端點上不適用，因為 Claude Code 會把端點的模型當成它自己的某個模型來計價）與 `--fallback-model`（本機：說明；文件）。停止時送的是 `SIGTERM`（`process.ts`），回合不會留下 result；送 `interrupt` 控制請求（或 `SIGINT`），回合會以一個帶用量的 result 結束（文件）。
- **Copilot**：Harness Relay 不顯示它的費用。它的 `assistant.usage` 執行期事件帶有費用與額度（本機：它的 session 事件 schema），和 subagent 事件一樣要選擇加入；`--usage-output-file` 會在 session 結束時寫出每個模型、每個 subagent 的 token 與 AI credits（本機：說明；在 ACP 下跑完一個回合後是否會寫出：待確認）。`--max-ai-credits` 是軟上限（至少 30 credits；一次回應可能超過），1.0.112 起才涵蓋 subagent（本機：內附的 changelog）；在使用者自己的端點上是否適用：待確認。它的 `continueOnAutoMode` 設定（預設關閉：遇到單一模型、每週或整合的速率限制時改用 Auto 並重試；不適用於全域限制，也不適用於使用者自己的模型供應商，本機）不在 Harness Relay 保留的帳號設定裡（`KEPT`，`copilot.ts:144`）。
- **Goose**：`GOOSE_MAX_TURNS`（預設 1,000）與上面的 subagent 上限（本機）。**OpenCode**：agent 的 `steps`（本機）。
- **Codex**：列出的每個模型都提供名為 Fast 的 `priority` 服務等級（1.5 或 2 倍速度，多數會增加用量；本機：內附目錄）。
- **Pi**：Harness Relay 只加總 assistant 訊息的用量（`pi.ts`），所以壓縮本身的模型呼叫沒有算進去；Pi 會在 `compaction_end` 的 `usage` 與 `get_session_stats` 回報它們，並附上 context 的使用量（本機：內附文件）。

### 8. 較小的發現，逐個 CLI

| CLI | 發現 | 標籤 |
| --- | --- | --- |
| Codex | `review/start`：內建的審閱，對象可以是未提交的變更、目前分支與某個基準的比較、一個 commit，或自訂的指示；適合審閱者角色，或把平行模式的 worktree 與它的基準比對 | 本機 |
| Codex | 目標（`goals`，stable，預設開啟）會自己接續 thread；Harness Relay 有自己的追蹤目標，並在 `turn/completed` 時結束程序。`features.goals=false` 可以排除意外 | 本機；影響待確認 |
| Codex、Claude Code、Grok、OpenCode、Pi | 分岔 session（`thread/fork`、`--fork-session`、`x.ai/session/fork`、ACP 的 `session/fork`、Pi 的 `fork`（從某則使用者訊息）或 `clone`（在目前位置））：[分支對話](../architecture.zh-TW.md#分支對話)可以保留每個成員的 context，而不是重播歷史 | 本機／文件 |
| Codex | 被丟掉的通知：`model/rerouted`（聊天畫面可能寫錯模型）、警告、即時的命令輸出 | 本機 |
| Grok | ACP 的 client hooks（`x.ai/hooks`）可以把 Grok 加進 `HOOK_PROVIDERS`（`src/shared/types.ts`）；遇到 `ask`、格式錯誤的回覆、逾時或傳輸錯誤時會放行 | 本機 |
| Grok | `session/resume` 時是否採用 `rules`（已接續的 session 換了簡報） | 待確認 |
| Cursor | Plan 與 Ask 模式：Harness Relay 強制使用 `agent`（`cursor.ts:684`）。唯讀成員改用 Ask 模式（「no edits or command execution」），可以多一道 Cursor 自己的唯讀防護；plan 模式仍允許修改 Markdown 與 canvas 檔案（文件：2026.11.04） | 本機 |
| Cursor | 強度以外的模型參數，作為 session 的設定選項：`context` 設為 `1m`、`fast`（來自 Cursor 服務送來的模型清單，`test/cursor.test.ts:509` 記錄了它） | 待確認 |
| Cursor | 2026.11.14 會拒絕整檔重寫一個在 agent 上次讀取後被改過的檔案：多個 agent 編輯同一批檔案時比較安全 | 文件 |
| Copilot | 每個角色一個自訂 agent：ACP 的 `agent` 設定選項（1.0.40），可能只在有自訂 agent 時列出（待確認），或 `--agent`，1.0.106 起 ACP 也採用（內附的 changelog）；以及它的 `/review` 與 `/security-review` 命令 | 本機 |
| Antigravity | 它的終端機沙箱（`--sandbox`）刻意關閉：在 1.5.6，ACP 下沙箱裡的命令無法寫入工作目錄（`antigravity.ts:48-50`）。因為每次拒絕都會結束 agy 的回合，值得在較新版本再試，但 1.5.7 到 1.5.12 的版本說明沒有提到這點有改 | 本機 |
| OpenCode | 各種權限下 LSP 都關閉（`lsp: false`，`opencode.ts:158`），完全存取以外有很好的理由；但文件說的「關掉不損失任何功能」（`docs/open-agents.md:185`、`opencode.ts:149`）不正確：它的編輯工具會把檔案的 LSP 錯誤交給模型修正（本機）。完全存取時可以提供 | 本機 |
| OpenCode | 唯讀成員用 plan 模式（Harness Relay 設成 `build`，`opencode.ts:1444`）會在 prompt 加上 OpenCode 的唯讀提醒；它自己對編輯的拒絕，只有 Harness Relay 把規則寫成 plan agent 自己的規則時才成立，因為 Harness Relay 的 `"*": "ask"` 排在內建規則之後、會勝出（本機：`opencode agent list`）。以 `/` 開頭的 prompt 有防護（`acpTurn.ts` 的 `acpPromptText()`），所以送不出 `/compact` | 本機 |
| OpenCode | Harness Relay 設了 `OPENCODE_EXPERIMENTAL=false`（`opencode.ts:437`），但沒有設 `OPENCODE_EXPERIMENTAL_CODE_MODE` 或 `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`，而 OpenCode 會分別讀取它們，只在它們沒設時才看 `OPENCODE_EXPERIMENTAL`（本機：執行檔）；開源 agent 的環境從伺服器的環境開始（`open.ts:509`），所以伺服器繼承到其中一個時就會傳下去，而且它會勝出 | 本機 |
| Goose | 常駐指示（`tom` 擴充功能，被 `GOOSE_PLATFORM_EXTENSIONS` 排除；文字來自 `GOOSE_MOIM_MESSAGE_TEXT` 或 `GOOSE_MOIM_MESSAGE_FILE`）：每回合的 context 區塊裡放一段簡短提醒，能幫弱模型記住規則；context 小於 32,000 token 時 Goose 不放這個區塊 | 本機 |
| Goose | `_goose/unstable/context/report` 拆解 context 被什麼佔滿，不呼叫模型 | 本機 |
| Goose | 1.59.0 與 1.60.1 修好了被 Claude 模型拒絕的壓縮 prompt | 文件 |
| Cline | Plan 模式；只在新 session 有效（`session/load` 以 `act` 建立執行環境） | 本機 |
| OpenHands | `reasoning_summary`，取得 OpenAI 的推理摘要（只限 Responses API；需要經過驗證的 OpenAI 組織） | 本機 |
| Pi | `compaction_*`、`auto_retry_*` 與 `summarization_retry_*` 事件沒有顯示；`cacheWarming` 是 `'off'`（`pi.ts:205`），而 `"streaming"` 只在執行期間預熱 | 本機 |

### 9. 已關閉、也應該維持關閉的

- **由模型代替使用者核准。** 它們都用模型的判斷取代使用者的決定，所以維持 Harness Relay 自己固定的決定：
  - Codex 的 `auto_review`：預設關閉，但 Harness Relay 沒有設定審閱者（`codexConfig()`），所以帳號的 `approvals_reviewer = "auto_review"` 會生效；把它固定為 `user`（設計第 1 步）。
  - Cursor 的 auto-review：完全存取以外，Harness Relay 把 `approvalMode` 固定為 `allowlist`（`cursor.ts:123`）；在 ACP 下它會在沒有沙箱的情況下執行核准的命令。
  - Muse Code 的核准評審：關閉（`MUSE_DISABLE_APPROVAL_JUDGE`，`muse.ts:647`）。
  - Copilot 的 assisted approval：被拿掉（`copilot.ts:257`、`copilot.ts:527`）。
  - Claude Code 的 auto 模式：從不使用（`PERMISSION_MODE`，`claude.ts:39-44`）。
  - Goose 的 `smart_approve`：由模型判斷哪些呼叫只是讀取；它也會在每次呼叫模型時寫入 `permission.yaml`，在 relay 沙箱裡會卡住。從不使用（`goose.ts:88-90`）。
  - Antigravity 的 Auto 模式：離開沙箱的命令由另一個模型審核；Harness Relay 每個回合都設成 `default`（`antigravity.ts:1042`）。
- **Copilot 的 autopilot**（全部允許），以及 Copilot 在 ACP 下不提供的 **`/delegate`**。
- **完全存取以外 OpenHands 的 subagent**：它們不經詢問就行動。
- **Cline 的 agent teams 與 checkpoint**（Cline 的 ACP 模式本來就不開；應維持如此）；**OpenCode 的分享、snapshot 與網路搜尋**，由 Harness Relay 關閉（`opencode.ts:156-157`、`opencode.ts:437-441`），以及它的 code mode（隨它的實驗功能一起關閉，除非伺服器繼承了 `OPENCODE_EXPERIMENTAL_CODE_MODE`：[第 8 節](#8-較小的發現逐個-cli)）。Harness Relay 有自己的團隊與快照，其餘的會連到這次執行之外。
- **各 CLI 的目標與 `/goal`、`/grind`、`/learn`**：和 Harness Relay 的追蹤目標與團隊檢查重疊，而 `/learn` 會寫入 `GEMINI.md`／`AGENTS.md`。Codex 的目標預設開啟（[第 8 節](#8-較小的發現逐個-cli)）：把它固定為關閉（第 1 步）。

## 設計

依這個順序；某一步要等另一步時，會寫明。

### 1. 決定每個 CLI 的 subagent，並固定該關的

完全存取以外，下面這些 CLI 的 subagent 不是加上限制，就是關掉，並在[權限對應](../architecture.zh-TW.md#權限對應)寫明是哪一種；其他 CLI 維持現狀：

- **Codex**：完全存取以外設 `agents.enabled=false` 與 `features.multi_agent_v2=false`（架構文件的[在 Harness Relay 的執行中不載入](../architecture.zh-TW.md#在-harness-relay-的執行中不載入)只寫了 `features.multi_agent = false`，它只決定內附目錄沒給版本的模型：隨這一步一起補上），直到在 0.170.0 或之後的 CLI 檢查（第 9 步）顯示 subagent 會保留權限設定檔的 `read` 項目；之後再加上限（`agents.max_concurrent_threads_per_session`、`agents.default_subagent_reasoning_effort`）。各種權限下都固定 `features.goals=false`，並在 `thread/start` 設 `approvalsReviewer: "user"`，否則帳號自己的 `approvals_reviewer` 會生效。
- **Grok**：設 `GROK_SUBAGENTS=0`，直到第 3 步能保住它的背景工作；之後設 `GROK_MAX_CONCURRENT_SUBAGENTS` 與 `GROK_SUBAGENTS_MAX_DEPTH`。
- **Claude Code**：預設用 `CLAUDE_CODE_DISABLE_WORKFLOWS=1` 關閉 `Workflow`（或用排除單一內建工具的開關本來就會寫的拒絕規則，`claudeNativeSettings()`），帳號開啟時才保留；ultracode 會讓 Claude 為每個實質的任務規劃 workflow，只作為另外的選項，用 `"ultracode": true` 設定，以保留成員的強度；依回合的逾時設定 `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`。
- **Antigravity**：`agy acp` 沒有關閉 subagent 的開關（[在 Harness Relay 的執行中不載入](../architecture.zh-TW.md#在-harness-relay-的執行中不載入)），所以它們保持開啟；到 1.5.10（第 9 步）後由第 3 步等它們完成，在那之前由簡報要它結束回合前不要留下還在跑的 subagent。
- **Goose**：在端點上調低 `GOOSE_MAX_CONCURRENT_SUBAGENTS`，因為端點常常一次只服務一個請求。

### 2. 顯示 subagent 做的事

工具呼叫多一個可選的上層：`tool_start` 與 `tool_end` 帶 `parentId`，也就是啟動 subagent 的那個呼叫的 id，聊天畫面把這些呼叫收在它底下，CLI 有說時也顯示 subagent 的名稱與模型。新的 `notice` 事件傳達 CLI 對自己執行狀況的回報（壓縮、重試、換模型）。各 CLI 的來源：

| CLI | subagent 的呼叫 | 通知 |
| --- | --- | --- |
| Claude Code | 帶 `parent_tool_use_id` 的事件；`task_*` system 訊息；在 `initialize` 裡加 `agentProgressSummaries`，取得一行摘要 | `compact_boundary`、`api_retry`、`model_fallback` |
| Codex | `collabAgentToolCall` 與 `subAgentActivity`，以及依 `parentThreadId` 追蹤的子 thread 項目；加上它們的 token 用量 | `contextCompaction`、`model/rerouted` |
| Grok | `subagent_spawned`、`subagent_progress`、`subagent_finished`、`task_backgrounded` | `auto_compact_completed`、`model_auto_switched`、`auto_recovery_*` |
| Cursor | `subagents` client 能力：連到 Task 呼叫的子 session；`cursor/task` | — |
| Copilot | `subagent.started`（`toolCallId`、`agentName`、`model`）、`subagent.completed` 與 `subagent.failed`，以及帶 `params.agentId` 的事件，每種類型都要指名訂閱 | `session.compaction_start` 與 `_complete`、`assistant.turn_retry`、`session.model_change`、`auto_mode_switch.completed` |
| Pi | — | `compaction_*`、`auto_retry_*`、`summarization_retry_*` |

上層只是一個 id，所以共用型別與儲存的訊息仍然只有一份呼叫清單。

### 3. 等背景工作結束再結束回合

Grok、Antigravity（1.5.10 起）與 Muse Code：prompt 回答之後繼續讀，直到 CLI 回報它啟動的工作都完成，或回合逾時，這段時間收到的內容串流進同一則回覆。CLI 沒有提供這種訊號的，就在簡報裡要它在結束回合前等它的 subagent 完成。Cursor 在宣告 `subagents` 能力後（第 2 步）會自己這樣做；Claude Code 本來就會讀到它結束，只需要第 1 步的上限。

### 4. 端點模型的 context window

設定 → 模型來源，為端點的每個模型加一個可選的 context window，伺服器有回報時自動填入（vLLM 的 `/v1/models` 回報 `max_model_len`，llama.cpp 回報 `meta.n_ctx`；其他伺服器：待確認）。每個開源 agent 的轉接器依[第 2 節](#2-端點的模型沒有-context-window)表格寫入對應位置，並為短 context 提供一組設定：OpenCode 的修剪與工具輸出上限、Goose 的工具回應大小與工具輸出摘要、步數上限。Goose 的常駐指示在 32,000 token 以下不會放進去，所以不適合這些模型。Cline 的部分，請廠商讓 ACP 採用壓縮設定；在那之前，context 溢出的成員從 Harness Relay 自己的紀錄開一個新 session。

### 5. 計畫

Claude Code 與 Codex 的計畫工具現在是廠商選擇關閉的，打開就會佔用 context；不論怎麼決定，架構文件的表格與已知限制現在就要修正。

- Claude Code：每個帳號可以選擇開啟：`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` 搭配 `CLAUDE_CODE_ENABLE_TASKS=0`，直接沿用 `TodoWrite` 的轉換；或保留任務工具，把 `TaskCreate` 與 `TaskUpdate` 轉成計畫。
- Codex：同樣是選擇開啟，`tools.update_plan.enabled=true`。
- Cursor：把 `cursor/update_todos` 當成計畫，並依實際跑出來的結果修正架構文件的表格與端對端測試的假 CLI（`e2e/fake-cli/agents/cursor.cjs`，連同 `e2e/README.md` 與 `e2e/README.zh-TW.md`）。
- Pi：由 gate 擴充功能註冊一個待辦工具，gate 擴充功能也因此在每次執行都要載入。

### 6. 提問

CLI 的提問工具能關的就關掉：Codex 用 `tools.experimental_request_user_input.enabled=false`（作為防護，因為它預設只在 plan 模式出現），Grok 用 `GROK_ASK_USER_QUESTION=0`，Claude Code 拒絕 `AskUserQuestion`，Copilot 用 `--no-ask-user`。Antigravity 的簡報已經引導它不用 `ask_question`；先查清楚 agy 收到拒絕後會怎樣，如果它的回合因此受影響，就以一段說明回答表單，要它在回覆裡提問並以 `[ASK_USER]` 結尾。Muse Code 不需要處理。

### 7. 引導

一個對話設定，預設關閉：給正在發言的成員的訊息，在它的 CLI 能引導時（[第 5 節](#5-訊息進不了執行中的回合)）送進它執行中的回合，並在聊天畫面標示；否則和現在一樣在佇列裡等。

### 8. 結構化回答、預算與費用

- 首席 agent 在 Claude Code 或 Codex 上、用廠商自己的模型時，設計、審閱與分組的回合都要求它們的 JSON 形狀；其他情況照現在的方式解析。
- 每個成員可選的上限：Claude Code 的 `--max-budget-usd`（在端點上不適用）、Copilot 的 `--max-ai-credits`（軟上限，1.0.112 起涵蓋 subagent）、Goose 的 `GOOSE_MAX_TURNS`、OpenCode 的 `steps`。
- Copilot 的費用取自它的 `assistant.usage` 執行期事件（或 `--usage-output-file`，等實際跑過確認 ACP 下會寫出）。
- Claude Code 停止時，先送 `interrupt` 再送 `SIGTERM`。

### 9. 版本

透過 CLI 檢查把這些往前移，取得新版修好的部分：Codex 0.170.0（子 thread 保留沙箱的 `deny` 項目）、Cursor 2026.11.14（拒絕過時的整檔重寫）、Goose 1.60.1 或之後（Claude 模型上的壓縮）、Antigravity 1.5.10 或之後（回報 subagent 之後的工作，關閉時停掉它們）。Copilot 下次檢查時，重新確認 `session/prompt` 是否等背景 agent（1.0.115）。

## 資料庫

一個 migration，給第 4 步：端點模型的 context window，和它們的模型一起存在 `model_backends`。

## 測試

- 各轉接器的解析器，用錄下的訊息：subagent 的呼叫帶上它的上層、通知、Cursor 的待辦清單成為計畫。
- 協調器搭配假 runner：引導的訊息送進執行中的回合並加上標示；回合等到背景工作結束才結束，且不超過逾時。
- 轉接器的參數與設定：第 1 步固定的與第 4 步寫入的，依權限分別測試。
- 端對端：假 CLI 加上 subagent 事件與引導的指令；`e2e/README.md` 與 `e2e/README.zh-TW.md` 列出它們。

## 考慮過的其他做法

- **用 Claude Code 的 agent teams 取代 Harness Relay 的團隊。** 不採用：它們是實驗功能，在 `-p` 下不會產生 teammate，而且只限 Claude Code，Harness Relay 的團隊則混合多種 CLI。
- **用 CLI 的 workflow（`Workflow`、`/fleet`、`run_workflow`）取代平行模式。** 不採用：每一種都只在一個 CLI 之內，沒有平行模式的 worktree、檢查與套用。放在一個成員的回合裡、受到管理（第 1 步）並且看得到（第 2 步），它們值得保留。
- **全部 subagent 都關掉。** 最簡單也最安全；對 Harness Relay 還無法加上限制的 CLI，這是第 1 步的預設。但如果只做這件事，就會失去回合內的平行工作，而這對大任務有幫助。
- **打開核准評審**，以減少核准卡。不採用：見[第 9 節](#9-已關閉也應該維持關閉的)。
- **讓 Claude Code 與 Codex 的計畫工具維持關閉，只修正文件。** 這是廠商為現在的模型做的選擇，也最省事；代價是使用者看不到回覆旁的計畫。第 5 步把它做成選擇開啟，而不是預設。

## 待決問題

- subagent 的呼叫應該收在啟動它的呼叫底下，還是顯示在自己的面板？
- 完全存取時，subagent 與 workflow 是否應該像 CLI 自己的預設一樣開啟？
- 要不要違反廠商的預設，提供 Claude Code 與 Codex 的計畫工具？
- 引導適合每一種模式嗎？在平行模式裡，同一輪應該看到相同的訊息。
- context window 應該在儲存端點時向伺服器詢問，還是只在使用者要求時？
- 標為待確認的發現，哪些應該先用實際測試確定？建議：Grok 遺失的喚醒回合、Codex 的 subagent 與沙箱、Antigravity 的 browser subagent、Cursor 的待辦清單。
