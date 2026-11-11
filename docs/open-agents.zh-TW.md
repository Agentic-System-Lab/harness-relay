[English](open-agents.md) | **繁體中文**

# 開源 agent

除了 `claude`、`codex` 與 `grok`，Harness Relay 也能執行五個開源的 coding agent CLI。程式裡稱它們為「open agents」（`src/shared/types.ts` 的 `OPEN_PROVIDERS`）：

| Provider id | CLI | 協定 | 轉接器 |
| --- | --- | --- | --- |
| `opencode` | OpenCode（`opencode`，npm `opencode-ai`） | ACP：`opencode acp` | `src/server/agents/opencode.ts` |
| `goose` | Goose（`goose`，Homebrew `block-goose-cli`） | ACP：`goose acp` | `src/server/agents/goose.ts` |
| `cline` | Cline（`cline`，npm `cline`） | ACP：`cline --acp` | `src/server/agents/cline.ts` |
| `openhands` | OpenHands（`openhands`，`uv tool install openhands`） | ACP：`openhands acp` | `src/server/agents/openhands.ts` |
| `pi` | Pi（`pi`，npm `@earendil-works/pi-coding-agent`） | JSONL RPC：`pi --mode rpc` | `src/server/agents/pi.ts` |

它們和另外三個 CLI 不同的地方在於模型從哪裡來：它們在 Harness Relay 裡沒有自己的登入，而是使用「設定」裡的**模型來源**（OpenAI、Anthropic 或 xAI 的 API key，或你自己的 OpenAI 相容端點）。這份文件說明它們共用的部分，最後每個 agent 各有一節。

一個 agent 的轉接器完成之前（它的檔案裡 `implemented: true`），它的每次執行都會在任何東西啟動前就失敗，說明「not implemented yet」，「設定」中也顯示它尚未就緒。

## 模型來源

**設定 → 模型來源** 存放 開源 agent 執行模型用的來源（`src/server/backends.ts` 的 `ModelBackendStore`，透過 `settings.backends` 取得）：

- **API 來源**：`openai`、`anthropic` 與 `xai`，各一把 API key。
- **自訂端點**：你自己的 OpenAI 相容伺服器（vLLM、Ollama、LM Studio、llama.cpp），每個是 `{ id, name, baseUrl, models }`，加上選用的金鑰。id 是小寫的 slug（`ENDPOINT_ID_RE`，不能是 API 來源的名稱），是它的模型 id 的開頭，改名時不變；`models` 是你輸入的模型名稱，因為 Harness Relay 從不向任何模型 API 查詢。base URL 必須是 http(s)，不含帳號密碼、查詢字串或 #，也不能是 Harness Relay 在這台電腦上自己的位址（它的 API 的連接埠或開發伺服器的），不論怎麼寫：`localhost` 與它底下的名稱、結尾多一個點、127/8、`::1`、寫成 IPv6 的 IPv4 位址、未指定位址（`0`、`[::]`），或這台電腦自己的位址之一（`validEndpointUrl`）。

**金鑰**存在作業系統的金鑰儲存區，服務名稱 `harness-relay`，帳號為 `backend-<id>-api-key` 與 `endpoint-<id>-api-key`，規則和各 CLI 的 API key 相同（[架構 → Provider](architecture.zh-TW.md#provider狀態登入與模型)）：沒有金鑰儲存區時留在資料庫，「設定」會註明；有儲存區時，在資料庫中找到的金鑰會搬進去、讀回確認並從資料庫清除（並做 WAL checkpoint）；儲存區拒絕儲存時請求直接失敗，絕不默默改存資料庫；啟動時讀不到的金鑰會標示出來，讓你重新輸入。介面只會拿到遮蔽過的金鑰：20 個字元以上的金鑰顯示 `••••` 加最後四個字元，較短的只顯示 `••••`（`maskSecret`），所以短的金鑰不會露出大半。端點本身存在 `model_backends` 資料表（schema version 19），API 來源的金鑰只有在必須留在資料庫時才放在這裡。

**模型 id。** 開源 agent 的模型寫成 `<模型來源>/<模型>`，例如 `openai/gpt-5.4-nano`、`anthropic/claude-haiku-5-5`、`xai/grok-4.3` 或 `homelab/muse-glimmer-30b-nvfp4`（只是例子：實際的 id 請以各 API 或 CLI 的模型清單為準）。第一個 `/` 之前是模型來源，所以模型名稱本身也可以含 `/`（`parseBackendModel()`，伺服器與介面共用）。

**每次執行拿到什麼。** `backendRun(o.backends, o.model, …)` 給每次執行它的模型來源與模型；沒有模型、id 不是 `<模型來源>/<模型>`，或模型來源還沒設定時，執行會失敗並說明該怎麼做：

- 只有這次執行自己的 API 來源的金鑰，放在各 CLI 讀取的變數（`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 或 `XAI_API_KEY`），沒有其他的：agent 執行的指令會繼承這個環境，所以用 Anthropic 的執行絕不會拿到 OpenAI 的金鑰。伺服器保存的每一把金鑰，以及從你的 shell 繼承來的每個模型供應商的金鑰、登入憑證或位址，都會先移除（`backends.ts` 的 `INHERITED_BACKEND_VARS`）：OpenAI、Anthropic 與 xAI 的金鑰、base URL、組織與專案，`CLAUDE_CODE_OAUTH_TOKEN`，Google 的（`GEMINI_API_KEY`、`GOOGLE_API_KEY`、`GOOGLE_GENERATIVE_AI_API_KEY`、`GOOGLE_APPLICATION_CREDENTIALS`、`VERTEX_API_KEY`），OpenRouter、Mistral、Groq、DeepSeek、Together、Fireworks、Azure OpenAI、Cohere、Hugging Face、Perplexity、Cerebras、NVIDIA、Replicate、Voyage、Moonshot、DashScope、Z.ai、LiteLLM 的，Ollama 的（`OLLAMA_HOST`、`OLLAMA_API_KEY`），以及 Bedrock 的 bearer token（`AWS_BEARER_TOKEN_BEDROCK`）。不屬於模型來源的仍會傳給 agent，和其他 CLI 一樣：`PATH`、`HOME`、SSH agent、`GITHUB_TOKEN`、AWS 的其他變數。CLI 需要所有已設定金鑰的轉接器，必須說明並寫出原因（`allBackendKeys`）；目前沒有一個需要；
- 模型在自訂端點上時，該端點的 base URL 與金鑰：轉接器把金鑰放在它的 CLI 設定所指定的變數，絕不寫進設定檔；
- 這次執行需要連到的主機（`api.openai.com`、`api.anthropic.com`、`api.x.ai`、端點的 `host:port`），交給 Harness Relay 的沙箱。

orchestrator 把模型來源傳給每次 開源 agent 的執行（`RunOptions.backends`，來自 `SettingsStore.backendsFor()`），首席 agent 與側邊欄分組的執行也一樣。

**模型選單**列出 CLI 自己模型清單中、模型來源已設定的模型（轉接器的 `models` hook，CLI 有清單時），再加上每個端點輸入的模型；也隨時可以自己輸入 id。成員留在「預設」時，就用選單顯示為預設的模型執行，和其他 CLI 一樣：先用「設定」裡這個 CLI 的預設，否則用它的清單預設（該模型的來源已設定時；`Orchestrator.modelFor`，取自 `ProviderService.models`）。兩者都沒有時，選單會說需要選一個模型，執行時也會請你選一個。

**狀態。** CLI 已安裝（`--version`）、轉接器已完成，且至少設定了一個模型來源時，開源 agent 就可使用。它沒有登入流程：登入相關的路由對它回應 400。Claude 訂閱帳號與 Grok 的登入不能用在這些 CLI（Anthropic 不允許在第三方 agent 中使用它的訂閱）；「設定」會說明這點，Claude Code 與 Grok 本身照常使用它們自己的登入。

## Agent 的家目錄

開源 agent 一律在 Harness Relay 自己的家目錄中執行，絕不使用你的（`~/.config/opencode`、`~/.config/goose`、`~/.cline`、`~/.openhands`、`~/.pi`…），因為 Harness Relay 每次執行前都會寫入它的設定：**設定 → Agent 的 session** 指定了資料夾時是 `<資料夾>/<provider>`，否則是 `data/agent-homes/<provider>`。`SettingsStore.env()` 用 `HARNESS_RELAY_AGENT_HOME` 告訴轉接器這個位置，轉接器再透過它的 `home` hook，用 CLI 自己的變數（XDG 資料夾、它的家目錄變數）把 CLI 指向那裡，並宣告：

- `statePaths`：CLI 寫入 session、記錄與快取的地方，在 Harness Relay 的沙箱中可以寫入；
- `configPaths`：所有會改變 CLI 啟動時行為的檔案或資料夾（設定、plugin、擴充功能、自訂 provider、hook、skill、指示檔、MCP 設定、權限檔）。轉接器的 `prepare` 在每次執行前寫入它們，它們在沙箱中是唯讀的，所以 agent 無法替自己的下一次執行放寬限制。CLI 需要在旁邊寫檔時，也可以只列出可寫資料夾中的單一檔案。

家目錄變數涵蓋不到的地方（例如仍會讀 `~/.agents/skills`，或從工作目錄一路往上讀每個 `AGENTS.md` 的 CLI），每次執行時用 CLI 自己的開關關掉，或列為它自己載入的內容。

### 每位成員自己的狀態

一次執行能寫入的一切都屬於它自己：對話中一位成員的 session、記錄與快取，放在它自己的資料夾 `<家目錄>/private/<key>`，其他對話或其他成員的開源 agent 在沙箱中（完全存取以外）的執行都不能讀寫，其他在沙箱中的 agent 也都不能寫入。完全存取以外的 Claude Code、Codex 與 Grok 讀得到它，就像它們讀得到彼此的 session：它們的沙箱只擋住受保護路徑的讀取（[沙箱](sandboxing.zh-TW.md#agent-不能讀寫的地方)）。完全存取時沒有沙箱，和其他 CLI 一樣（曾有一個對話的執行在另一個對話的 session 檔加上一則假的使用者訊息，那個對話的下一個回答就照著做了）。

- **key** 由 orchestrator 給出（`RunOptions.stateKey`，`src/server/agents/types.ts` 的 `stateKeys`）：成員是 `conv.<對話>.<成員>`，每一輪都相同，所以它的 session 可以接續；首席 agent 設計團隊、依你的要求修改團隊、把對話分進群組，分別是 `lead.<對話>`、`revise.<對話>` 與 `sort.<對話>`。分支出來的對話是另一個對話，所以它的成員從自己的狀態開始，session 也和以前一樣重新開始。沒有 key 的執行有一個自己的資料夾，執行後刪除。
- **寫入。** 轉接器的 `home(root, state)` 把每個可寫入的路徑（`statePaths`）放在 `state` 裡；完全存取以外，有一個在它之外時就不會執行。伺服器為一個 key 留給之後執行的東西（Goose 的擴充清單）放在它旁邊的封存資料夾（`<家目錄>/private/.sealed-<key>`，`sealedFolder`），任何執行都不能讀寫，並和狀態資料夾一起清空。家目錄中共用的部分（每次執行前寫入的設定、模型清單）留在 `root`，沙箱中的執行絕不能寫入。
- **讀取。** 完全存取以外，Harness Relay 的沙箱不讓執行讀取每個 開源 agent 的 `private/` 資料夾（也包括 **設定 → Agent 的 session** 把家目錄搬走之前所在資料夾裡的，`openAgentRoots`，以 `HARNESS_RELAY_AGENT_HOMES_BEFORE` 交給每次執行）與每次執行的暫存資料夾所在的資料夾（`privateRoots`），只有其中屬於這次執行自己的資料夾例外（`denyRead`，自己的放在 `allowRead`）。已在 macOS 上用 `scripts/sandbox-check.ts --only private` 驗證：執行可以讀寫自己的資料夾，不能讀、寫或列出別人的。
- **會載入程式碼的快取**放在這次執行的暫存資料夾，或關掉（各 agent 見下）；不會在成員之間共用，也只有成員自己的才會留到下一次執行。
- **權限提高時。** 成員在這個 CLI 上最近一次執行的權限較低時（唯讀 → 可編輯 → 完全存取），不接續它的 session：改開新的 session，從 Harness Relay 自己的紀錄給它完整的歷史，並由 orchestrator 在執行前清空它在這個 CLI 家目錄裡的狀態資料夾（`emptyStateFolder`；也會告訴這次執行，`freshState`），所以權限較低的執行寫下的東西，不會在權限較高時被讀到。紀錄是每個 CLI 各一份（`agent_sessions.by_cli`）：成員先用 OpenCode 以唯讀執行，再用 Goose 以可編輯執行，之後回到 OpenCode 以可編輯執行時，OpenCode 的資料夾會被清空。紀錄裡也記著那次執行所在的家目錄：在另一個家目錄執行時（**設定 → Agent 的 session** 把它們搬走之後，或回到先前的家目錄），不論權限，也同樣開新的 session 並清空那裡的資料夾，因為那個資料夾可能留著權限較低的舊執行寫下的東西。它在執行前寫進 Harness Relay 的資料庫，絕不在 agent 能寫入的檔案中，並附上一個「資料夾還要清空」的標記（`mustEmpty`），清空之後才會取消：資料夾無法清空時，這一輪不執行並說明原因，成員的下一輪會先清空它，即使權限相同。清空時先把資料夾改名移到一旁（`private/.gone-<隨機>`），這只需要 `private/` 可寫入，所以執行在自己資料夾裡做的任何事（對資料夾 `chmod 000`、唯讀的檔案、macOS 上的不可變更旗標 `chflags uchg`，會先清掉資料夾本身的這個旗標），都無法讓下一輪不能以新的資料夾開始；舊的資料夾接著盡力移除，絕不跟隨連結，被執行鎖住的部分會留在一旁，等到某次啟動清掃殘留的行程、確定沒有還在執行的之後，才恢復擁有者的權限（並清掉不可變更旗標）再移除，所以執行放進去的連結，無法讓伺服器更改或刪除 `private/` 以外的東西。清掃發現有行程留下來、或無法判斷時，那次啟動不恢復任何權限，並保留 Harness Relay 沙箱的資料夾與標記檔，讓之後的啟動還找得到它。從未記錄的權限視為唯讀。權限降低時，session 照常接續。
- **留下的東西。** 刪除對話時，會從每個開源 agent 的家目錄（也包括家目錄先前所在的資料夾）移除它的成員、首席 agent 與側邊欄分組的狀態資料夾（`removeConversationState`）。啟動時、任何執行開始之前，伺服器會移除執行中途停下的伺服器留下的東西：`data/run-tmp` 裡的每個資料夾，以及沒有 key 的執行、或移到一旁等待移除的狀態資料夾（`private/run-*`、`private/.gone-*`）（`clearOpenRunLeftovers`）。

| Agent | 成員自己的狀態（`<家目錄>/private/<key>`） | 會載入程式碼的快取 | 共用、執行時唯讀 |
| --- | --- | --- | --- |
| OpenCode | `data/`（session 資料庫、記錄、工具輸出）、`state/`（鎖） | 在這次執行的暫存資料夾（`XDG_CACHE_HOME`：ripgrep 與 LSP 程式、npm plugin；Bun 的安裝快取）；Bun 的轉譯快取關閉 | 它的設定資料夾、模型清單（`cache/opencode/models.json`，在執行以外更新） |
| Goose | `GOOSE_PATH_ROOT` 與 `HOME`：`data/`（session、它的模型清單快取）、`state/`（記錄）；那裡的 `config/`、`.agents/`、`.config/`… 每次執行前寫入，唯讀 | 沒有（Rust 程式） | shell 包裝（`bin/bash`） |
| Cline | `data/`（`CLINE_DATA_DIR`：session、SQLite、hook 紀錄；功能旗標檔每次執行前寫入，唯讀） | 在這次執行的暫存資料夾（jiti、Bun 的轉譯快取） | `config/`（狀態檢查、模型清單與探測讀的設定） |
| OpenHands | `conversations/`（`OPENHANDS_CONVERSATIONS_DIR`） | 在這次執行暫存資料夾中自己的家目錄（執行後刪除） | 沒有 |
| Pi | `sessions/`（`PI_CODING_AGENT_SESSION_DIR`） | 關閉（`JITI_FS_CACHE=false`、`NODE_DISABLE_COMPILE_CACHE=1`） | 沒有（它的 agent 資料夾屬於這次執行，在暫存資料夾中） |

執行以外（狀態、模型清單、它自己載入的內容），CLI 的狀態放在 `<家目錄>/private/probe`，沒有任何沙箱中的執行能讀寫。

**每次執行都有自己的暫存資料夾**（完全存取以外是 Harness Relay 沙箱的 `data/relay-sandbox/<id>`，完全存取時是 `data/run-tmp/<provider>-<亂數>`；只有擁有者能存取，執行結束後刪除），放在 `TMPDIR`、`TMP` 與 `TEMP`，在沙箱中可以寫入。它在 Harness Relay 的資料資料夾裡，那裡沒有任何沙箱能寫入；而不是系統的暫存資料夾，那裡每個沙箱都讓指令寫入。會載入程式碼的快取（jiti、Node 的 compile cache、Bun 的快取、Python bytecode）由轉接器搬到這裡或關掉，所以沒有一次執行能埋下另一次執行會載入的程式碼。

快照一律不包含 開源 agent 的家目錄，不論它們在哪裡。

## 共用的 ACP 回合

OpenCode、Goose、Cline 與 OpenHands 透過 stdio 使用 [Agent Client Protocol](https://agentclientprotocol.com)，共用同一套回合流程（`src/server/agents/acpTurn.ts`），取自 Grok 轉接器的邏輯（Grok 轉接器本身不變）。每一輪執行一個程序：

1. **啟動。** `startOpenProcess()`（`src/server/agents/open.ts`，Pi 也用它）拒絕尚未完成的轉接器、讀取這次執行的模型來源、在完全存取以外檢查 Harness Relay 的沙箱、建立家目錄與這次執行的暫存資料夾、讓轉接器寫入 CLI 的設定（`prepare`），並在完全存取以外把指令包進沙箱。
2. **`initialize`**，告知 Harness Relay 不提供檔案系統或終端機（`fs.readTextFile`、`fs.writeTextFile`、`terminal` 都是 false）。agent 仍送來的請求（`fs/write_text_file`、`terminal/create`…）絕不代它執行，否則就會在沙箱外執行：它們會收到「method not found」錯誤，或是轉接器的 `clientRequest` 給的回應（OpenCode 需要 `null`）。
3. **Session。** 新對話的 agent 用 `session/new`。之後的回合在 agent 宣告支援時用 `session/resume` 接續（`sessionCapabilities.resume`，不會重播），否則用 `session/load`（`loadSession`；它在回應前以 update 重播的歷史會被丟棄，不會再顯示一次），兩者都不支援就失敗。接續失敗時，這一輪會在說出任何內容前就結束，於是 orchestrator 開新的 session 並給它完整的歷史，和任何接續失敗時一樣。
4. **模式、模型、推理強度**，各依轉接器的設定：依權限設定 session 模式（`session/set_mode`），模型用 `session/set_model` 或 `session/set_config_option`（`model`，或類別為 `model` 的選項），或寫在執行前的設定中；推理強度用 `session/set_config_option`（`thought_level`）或寫在設定中；只送出和 session 目前值不同的部分。`afterSession` 可以接手這一切：例如載入的 session 會保留舊設定、必須依它自己的順序重新設定的 agent，或用它自己的方法接收角色說明的 agent。
5. **Prompt**（`session/prompt`）：角色說明透過 CLI 自己的 system prompt 機制傳入（`briefing: 'custom'`），或放在 prompt 前面（`'prompt'`）；以 `/` 開頭的 prompt 前面會加上一個字，因為 agent 會把這樣的文字當成它自己的指令執行；agent 接受圖片時，附加的圖片也一併送出。
6. **Update → 事件**：`agent_message_chunk` → `text`、`agent_thought_chunk` → `thinking`、`plan` → `plan`、`tool_call` / `tool_call_update` → `tool_start` / `tool_end`（附上輸出或失敗原因；只在之後的 update 才出現的輸入，會在呼叫結束時顯示），`usage_update` → 成本。`filterUpdate` 讓轉接器先丟掉、修正或暫存 update（當成 thought 送來的 system prompt、回報為 `completed` 的失敗工具、可能是 agent 通知失敗的訊息，prompt 回覆後由 `heldUpdates` 交出），`hideTool` 與 `planOf` 隱藏待辦工具並從它的輸入取出計畫，subagent 的 session 的 update 不顯示。回合結束時，agent 沒有收尾的工具列會被收尾：正常結束時算完成，停止或失敗時標示「沒有執行完」。
7. **結束**：回應的 `stopReason`（agent 自己 `cancelled` 時附上它最後失敗的工具；`refusal`），token 數取自回應的 `usage`，成本取自最後一個以 USD 計的 `usage_update`（或轉接器的 `usage`，給以整個對話累計的 agent 用）。停止時送出 `session/cancel`，兩秒後結束程序；在送出 prompt 之前停止（正在檢查 Harness Relay 的沙箱、寫設定，或 session 啟動的任何一步），這一輪就在那裡結束，prompt 永遠不會送出。45 分鐘逾時以「逾時」結束，當掉時以 agent 自己的話（它 stderr 的結尾）結束。stdin 關閉後，程序有 `exitGraceMs`（3 秒）可以自己結束，之後就會被停止。

工具庫的 MCP 伺服器放在 `mcpServers`（`env` 與 `headers` 是 name/value 清單；agent 宣告 `mcpCapabilities.http` 時才給 HTTP 伺服器），或者，對 `session/load` 時會忽略它們的 agent，寫在它的設定中。

各 CLI 的每一個差異，都是轉接器自己檔案中 `AcpAgentSpec` 的一個 hook：`args`、`home`、`proxyEnv`、`emptyEnv`（設為空字串的變數，讓專案的 `.env` 無法設定它們）、`prepare`、`initialize`、`afterInitialize`、`sessionParams`、`afterSession`、`mode`、`model`、`effort`、`briefing`、`describeCall`、`decide`、`chooseOption`、`hideTool`、`planOf`、`toolName`、`rejection`、`afterRefusal`、`clientRequest`、`mcpServers`、`filterUpdate`、`heldUpdates`、`usage`、`endTurn`、`promptText`、`updateMethods`、`exitGraceMs`、`defaultModel`，以及程序的 `sandbox` 與 `cleanup`（在刪除這次執行的暫存資料夾前，停掉 CLI 留下來還在跑的東西）。每次執行自己的資料（`ctx.state`）保存一個 hook 得知、另一個 hook 要用的內容，因為平行的執行共用同一組 hook。

## 權限

| Relay 權限 | agent 自己的設定 | Harness Relay 的沙箱 |
| --- | --- | --- |
| 唯讀 | 每個修改與每個指令都先詢問；讀取、搜尋與網路照常執行 | 不能寫入工作目錄；只能寫入這次執行的暫存資料夾與 agent 的 `statePaths` |
| 可編輯 | 修改與指令照常執行，推送與發佈（`commands.ts` 的 `isPublishCommand()`），以及 shell 或直譯器執行從標準輸入讀到的內容（`… \| sh`）會先詢問 | 可寫入工作目錄、附件資料夾、這次執行的暫存資料夾與 `statePaths` |
| 完全存取 | agent 的全部允許模式 | 不使用（和其他 CLI 一樣） |

每個轉接器都會把它的 CLI 設定成會詢問（多數預設幾乎什麼都不問），並用測試證明設定後的行為。每個 `session/request_permission` 都經過和 Grok 相同的步驟：

1. **依權限判斷**（`acpPermissionDecision`）：唯讀時，種類為 `read`、`search`、`think` 與 `fetch` 的呼叫照常執行，其他（`edit`、`delete`、`move`、`execute`、`other`、`switch_mode`）交給使用者；可編輯時，除了推送或發佈的指令，全部照常執行；完全存取全部允許。是哪一種呼叫，取自它的種類、標題與輸入（`acpCallInfo`；只有執行指令的呼叫，`command` 才算 shell 指令；以參數清單給的指令，會讀成它實際執行的那一行，每個參數在 shell 會拆開的地方加上引號，所以 `["bash", "-lc", "git push origin main"]` 會當成推送而詢問：`commands.ts` 的 `commandLine`），或取自轉接器的 `describeCall`；它也看得到 agent 在先前的 update 中對這個呼叫說了什麼，以及上一次詢問之後更新過的呼叫（給詢問時不指明是哪個呼叫的 agent；被拒絕時，理由就顯示在那些呼叫的那一列）。轉接器自己的 `decide` 做出的拒絕是最終的：不會再問使用者（用於任何回答都無法限制住的呼叫）。subagent 的詢問也經過同樣的步驟。
2. **詢問**使用者（`requestApproval`：對話中的核准卡片、「本對話都允許」、拒絕時的留言），或在對話設定為自動拒絕時直接拒絕（`settings.approvals = "deny"`）。沒有指令、檔案或網址的工具（例如 MCP 伺服器的工具）會顯示它收到的內容：常見的欄位，否則是縮短後的 JSON 輸入。完全沒說是什麼的詢問（沒有標題、工具、指令、檔案、網址或輸入；例如 OpenHands 在之前沒有宣告任何呼叫的詢問）只能允許一次：它的卡片沒有「本對話都允許」，因為那會允許所有這類詢問（`noRule`）。在這一輪結束後才來的詢問（例如 Harness Relay 的沙箱排在另一個詢問後面的那一個），不顯示卡片，直接拒絕。
3. **回應** agent 的 `allow_once` 或 `reject_once` 選項，絕不選「always」的選項（agent 之後可能不再詢問，或改寫它自己的設定），或依轉接器的 `chooseOption` 以 id 選擇。這一輪被停止時才進來的詢問，或正在詢問使用者的那一個，回答 `cancelled`（ACP 對於正在取消的一輪的回答），而不是拒絕，也不會轉告模型任何東西。
4. **告訴模型原因**，依 agent 能接受的方式：放在回應中（`rejection`，例如 Grok 的 `_meta.followup_message`），在回應送出後用它自己的請求傳遞（`afterRefusal`），或在兩者都不行時寫在角色說明中，說明被拒絕的呼叫代表什麼。不論哪一種，對話中都會顯示 Harness Relay 的原因與使用者的留言。

**唯讀是一道界線，不只是一個詢問。** 唯讀時，即使使用者允許了修改或指令，它仍然無法寫入：Harness Relay 的沙箱會擋下，核准卡片也會說明這點（`readOnlySandbox`），其他工具也一樣（MCP 伺服器同樣在沙箱中執行）；之後若工具因 CLI 原始的「Operation not permitted」而失敗，對話裡會說明是 Harness Relay 的沙箱拒絕了它，以及原因。要讓 agent 修改檔案，對話需要可編輯權限。權限提高時，成員會開新的 session，並清空它的狀態（[每位成員自己的狀態](#每位成員自己的狀態)）。

Pi 自己沒有權限詢問：Harness Relay 的一個小型 gate 擴充功能會攔下它的每個工具呼叫，透過它的 RPC 詢問，所以它也有同樣的判斷與核准；唯讀時也會把它的工具限制為只讀的那些。Harness Relay 的沙箱仍然是界線。

## Harness Relay 的沙箱

完全存取以外，每個 開源 agent 的程序，以及它啟動的一切，都在 Harness Relay 自己的沙箱中執行（`src/server/relaySandbox.ts`，基於 [`@anthropic-ai/sandbox-runtime`](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime)），不論 CLI 自己的沙箱怎麼做：

- **檔案**：只能寫入上表所列的地方；受保護的路徑（瀏覽器的資料夾、Harness Relay 的資料庫與暫存資料夾：`protectedReads()`）不能讀也不能寫；agent 的 `configPaths` 唯讀；其他讀取照常允許，和其他 CLI 一樣。
- **網路**：只能連到這次執行的模型來源的主機；連線能確定屬於這次執行時，其他主機會詢問使用者（種類為 `fetch` 的核准），否則直接拒絕，並附上模型看得到的原因。不詢問就直接拒絕的有：這台電腦自己的位址、link-local 與 metadata 位址（不論怎麼寫：`127.1`、`2130706433`、`0x7f.0.0.1`、`localhost.` 都讀成 proxy 實際連的位址，`canonicalHost`）、轉接器列為安靜拒絕的主機，以及一次執行中第 30 個之後要詢問的主機。Harness Relay 自己的埠（`PORT`、8787、8789 與 5173：`npm start` 與桌面 app 的，以及 `npm run dev` 的 API 與 Vite）一律連不到。沙箱透過本機的 proxy 轉送網路（`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`），並自己設定 `NODE_USE_ENV_PROXY=1`，讓 Node 22 的 `fetch` 也走 proxy；CLI 還需要別的時，由轉接器加上（`proxyEnv`；目前五個都不需要）。
- **無法啟動就不執行**：沙箱無法啟動時（沒有 `sandbox-exec`；在 Linux 上沒有 `bubblewrap`、`socat` 或 `ripgrep`），這一輪會失敗並說明如何修正；在原生 Windows 上它還沒準備好，所以 開源 agent 只能以完全存取執行。

各 CLI 自己的沙箱，以及每個平台需要什麼，請見[各平台的作業系統沙箱](sandboxing.zh-TW.md)。

## OpenCode

`src/server/agents/opencode.ts`，以 OpenCode 1.19.5（npm `opencode-ai`，一個 Bun 程式）實測過。

**指令**：`opencode acp --port <這次執行的埠>`（ACP，stdin/stdout 上的 JSON-RPC）。`opencode acp` 在整個回合中會在 127.0.0.1 上開一個自己的 HTTP API，它的 ACP 端也透過這個 API 運作：每次執行都有自己的埠（`freeLoopbackPort()`）與隨機的 `OPENCODE_SERVER_PASSWORD`，沒有這個密碼，本機任何程式都能操作它。它宣告 `session/resume`（不重播歷史）、`session/load`、圖片，以及 stdio 與 HTTP 的 MCP 伺服器；工具庫的 MCP 伺服器放在 `session/new` / `session/resume` 的 `mcpServers`，工具名稱是 `<伺服器>_<工具>`。

**家目錄**（`<agent 家目錄>/opencode`）：四個 XDG 資料夾都在裡面（`config`、`data`、`state`、`cache`），`OPENCODE_CONFIG_DIR` 固定指向它自己的設定資料夾（繼承來的值會多讀使用者的），`OPENCODE_TEST_HOME` 指向一個空的資料夾，取代它從使用者家目錄讀的 `~/.opencode/`、`~/.claude/CLAUDE.md`、`~/.claude/skills`、`~/.agents/skills`（只有這個變數能做到這點而不改變它執行的指令的 HOME；名稱雖然是 test，1.19.5 就是用它），`OPENCODE_AUTH_CONTENT={}`（它的 `auth.json` 可能指定一個抓設定的網址），`OPENCODE_PURE=1`（不載入外部 plugin）。每次啟動前：

- 設定資料夾只放 Harness Relay 寫的 `opencode.json`、`.gitignore` 與 `relay-shell`（它的指令執行用的 shell，見下方），權限為唯讀（0555）；其他東西（plugin、工具、skill、別的程式的設定）都會被移除。唯讀讓 OpenCode 不會從 npm 把 `@opencode-ai/plugin` 裝進去（62 MB，還會寫 `~/.npm`），也不會在設定檔裡補寫 `$schema`；`.gitignore` 先寫好，因為在沙箱裡它寫不進去時會整個當掉。
- 每次執行前，它的資料庫（`data/opencode/opencode.db`）裡會讓之後的執行權限變寬的東西都會被清掉，因為沙箱裡的指令能寫這個資料庫：每個 session 的權限規則（`session.permission`，OpenCode 會把它疊在 agent 自己的規則之上，套用到這個 session 的每個工具呼叫，所以指令寫進去的規則會讓接續這個 session 的下一輪不經詢問就編輯、執行指令與推送；Harness Relay 從不設定這些規則）、已儲存的權限（`permission` 資料表，也就是 Harness Relay 從不給的「一律允許」回答），以及 console 帳號：植入的帳號會讓之後的執行（例如完全存取）從帳號的伺服器抓設定並合併。
- 每次執行的設定都在 `OPENCODE_CONFIG_CONTENT` 裡（同一個家目錄可能同時有好幾次執行）：模型、只啟用這次的模型來源（`enabled_providers`，所以不需要 key 的免費「opencode」來源和它的預設模型不會出現）、權限規則、角色說明、關掉產生標題的模型呼叫（每個新 session 都會多花一次呼叫）。
- 這次執行的快取（`XDG_CACHE_HOME`：它下載的 ripgrep 與 LSP 程式、npm plugin）在這次執行的暫存資料夾裡；只有模型目錄（`models.json`，資料）從家目錄讀取，而且不在執行中更新（`OPENCODE_DISABLE_MODELS_FETCH`）。Bun 的轉譯快取關閉，快照（`snapshot`，它狀態資料夾裡一個 git 資料夾，另一次執行的指令會用到）也關閉。

`statePaths`：`data`、`state`，都在成員自己的狀態資料夾（`XDG_DATA_HOME`、`XDG_STATE_HOME`）。`configPaths`：`config`、取代家目錄的資料夾、`cache`（執行會讀的模型目錄）、`relay`（Harness Relay 記下的每個 session 的花費），在共用的家目錄。

**模型來源**：OpenAI、Anthropic、xAI 用它們內建的 provider，key 來自 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`XAI_API_KEY`；自訂端點寫成 `@ai-sdk/openai-compatible` 的 provider，id 是 `relay-<端點 id>`（這樣叫 lmstudio、ollama、groq 之類名稱的端點不會和 OpenCode 已知的 provider 混在一起），`baseURL` 是端點網址，key 透過 provider 的 `env`（變數 `HARNESS_RELAY_ENDPOINT_KEY`）傳入，從不寫進檔案；模型清單是端點輸入的模型加上這次的模型。設定裡的 `{env:…}`、`{file:…}` 與網址裡的 `${…}` 會被 OpenCode 代換，所以 Harness Relay 寫入時會跳脫。1.19.5 讀的是 `provider` / `npm` 的設定格式（較新的 `providers` / `package` 在這版只會被忽略）。

**模型與推理強度**：session 開始後，依 OpenCode 自己的順序以 `session/set_config_option` 設定：模式 `build`（接續的 session 會保留原本的模式）、模型（`<provider>/<model>`）、推理強度（模型的 variant；換模型會重設它，所以放在最後）。沒有指定推理強度時，由 OpenCode 決定（新 session 用模型的第一個 variant）。端點的模型沒有推理強度。模型選單來自 `opencode models --verbose`（只用假的 key 列出 API 模型來源的模型，不呼叫任何 API）：會呼叫工具、以文字回答、沒有棄用的模型，以及每個模型的推理強度。

**權限**（OpenCode 的規則以最後一條符合的為準，所以 `"*"` 放第一條）：

| Relay 權限 | OpenCode 的規則 | Harness Relay 的決定 |
| --- | --- | --- |
| 唯讀 | `"*": "ask"`；`read`、`glob`、`grep`、`list`、`lsp`、`webfetch`、`websearch`、`todowrite`、`skill` 允許；`task`（subagent）拒絕 | 讀取（也包括專案外的資料夾）、搜尋與網路照常；編輯、指令、MCP 工具交給使用者 |
| 可編輯 | 同上，再加上 `edit` 允許 | 每個指令都會詢問：推送與發佈交給使用者，其他照常 |
| 完全存取 | `"*": "allow"` | 全部允許 |

「每個指令都會詢問」是 OpenCode 自己對「什麼算指令」的判斷：它以 tree-sitter 解析整行，對它要執行的每個程式詢問，所以一行若不含任何指令——只有 `cd`／`pushd`、宣告（`export X=1`、`unset X`）、`(( … ))`、`[[ … ]]`、`[ … ]`、參數展開（`${x}`）、陣列字面值（`arr=(a b)`）、函式標頭（`f() { … }`）、賦值或註解——就會不經詢問地執行（這些也不會動到沙箱在意的東西）。其中的命令替換（`export X=$(id)`、`${x:-$(id)}`）本身是一個指令，仍會詢問。只有在完全存取以外，`relay-shell` 才會在執行前拒絕少數幾種 OpenCode 解析為「沒有指令」、但 shell 仍會在其中執行指令的形式：作為指令字的 `eval`，或在 shell 會重新求值的下標或算術裡、被引號或跳脫包起來（OpenCode 因此看不到）的 `$(…)`／反引號——單引號下標陷阱，`x='a[$(cmd)]'; a[x]=1`——並給模型一段清楚的訊息。完全存取時這個篩檢是關閉的，因為那時每個指令本來就不經詢問地執行。這個篩檢刻意收窄，所以仍有些形式會不經 OpenCode 詢問就執行指令：賦值裡 zsh 的 `=(…)` 程序替換與 `(e:…:)` glob 限定詞，以及把 `$(` 完全用宣告名稱會重新解析的片段拼出來的寫法，但在唯讀下它寫不了（而讀取本來就開放），在可編輯下指令本來就不經詢問地執行。

完全存取以外 subagent 會關閉：OpenCode 只會為 ACP 開的 session 發出權限請求，subagent 需要詢問時會一直卡住。一個請求只說「專案外的資料夾」（`external_directory`）時，它是讀取還是寫入，取自同一個工具呼叫先前的更新；重複三次相同呼叫（`doom_loop`）時，依那個工具判斷。

**拒絕與附註**：OpenCode 會忽略 ACP 回覆裡的任何理由，預設還會在拒絕後直接結束這一輪。所以 Harness Relay 在送出 ACP 回覆之前，先透過 OpenCode 自己的伺服器（`GET /permission`、`POST /permission/<id>/reply`，帶這次執行的密碼）以理由拒絕這個請求：模型看到「The user rejected permission … with the following feedback: <理由>」，包括使用者的附註，回合繼續。做不到時（例如沒有拿到埠），模型只看到 OpenCode 的一般拒絕文字，角色說明會解釋它的意思；`experimental.continue_loop_on_deny` 讓回合不會因此中斷。編輯被允許後，它還會送 `fs/write_text_file`（雖然 `initialize` 說用戶端不能寫）：回覆 `null`，從不照做（檔案它自己已經寫了；在沙箱外照做會繞過沙箱）。

**事件**：它的待辦清單只會出現在 `todowrite` 工具的輸入裡（`rawInput.todos`），會轉成計畫，不顯示成工具列；工具呼叫做什麼只在 `in_progress` 更新裡，結束時會補回去，`apply_patch` 顯示它修改的第一個檔案。結束碼不是 0 的指令照樣是完成的呼叫（帶它的輸出）。token 是這一輪最後一次模型呼叫的；花費是 `usage_update` 回報的整個 session 總額，扣掉上一輪結束時記下的總額，就是這一輪的花費。模型來源的錯誤（key 不對、端點沒有這個模型、連不到端點）會說明是哪個模型來源回報的，以及到哪裡修正。

**它自己載入的內容**：Harness Relay 的執行從不讀取專案自己的 OpenCode 設定（`opencode.json`、`.opencode/`，`OPENCODE_DISABLE_PROJECT_CONFIG`）：它在 Harness Relay 的設定之前合併並保留自己的鍵順序，而 OpenCode 以最後一條符合的規則為準，所以儲存庫可以把「詢問」變成「允許」（它的 `agent.build.permission` 甚至排在 Harness Relay 的規則後面）。這也會略過專案的 AGENTS.md，所以 Harness Relay 依 OpenCode 自己的找法（從工作目錄往上到儲存庫根目錄，AGENTS.md、CLAUDE.md、CONTEXT.md 中第一個存在的種類，路上每一份）把它當成指示檔傳回去。「設定 → OpenCode」列出：

- **Skill**（`opencode debug skill`）：專案的 `.claude/skills`、`.agents/skills`，以及內建的 `customize-opencode`。全部略過：`permission.skill: "deny"`，這會關掉它的 skill 工具，也讓這些 skill 不進入系統提示；單一 skill：`permission.skill: { "<名稱>": "deny" }`。
- **Subagent**（`opencode agent list`）：內建的 `general`、`explore`，可以全部或逐一略過（`agent.<名稱>.disable`）；完全存取以外它們一律關閉。
- **指示檔**：上面說的專案指示檔，可以略過；子資料夾裡的 AGENTS.md 在它讀取那裡的檔案時仍會加入，這一點沒有開關。
- MCP 伺服器、plugin、hook：Harness Relay 的執行裡沒有它自己的（只有工具庫的 MCP 伺服器）。
- **LSP 與格式化器都關閉**（`lsp: false`、`formatter: false`），所有權限都一樣，包含完全存取：OpenCode 會為它們自己啟動專案的程式（讀取檔案時會預熱 LSP，而 LSP 會執行 `node_modules/.bin/biome`、專案的 `tsserver.js` 等；編輯時會執行格式化器），而且環境裡帶著伺服器密碼與模型來源的 key，所以只要在一個內含這類程式的儲存庫裡讀一個檔案，就會不經核准地執行它。Harness Relay 不會顯示診斷或格式化結果，關掉不損失任何功能；agent 自己選擇執行這類程式時仍會詢問（完全存取下則是使用者的 yolo 模式）。

**沙箱需要它的**（`opencodeSandbox()`）：`localPorts` 只有它自己伺服器的埠（沒有它，`opencode acp` 會在回答 `initialize` 前以 `ServeError` 結束）；它的指令連不到其他本機埠，也連不到 Harness Relay 的。`quietlyDeniedHosts`：它的模型目錄 `models.opencode.ai`（執行中本來就關掉了）。Bun 自己讀 proxy 變數，不需要 PTY、Unix socket 或 macOS 的 trustd。沙箱裡 stderr 會出現無害的「Error starting FSEvents stream」（它的檔案監看）。

**它自己的伺服器**：這個伺服器的埠必須讓 OpenCode 連得到，所以 agent 的指令也連得到；它的密碼不在指令的環境變數裡（指令都經過設定資料夾裡唯讀的 `relay-shell`，它會先移除 `OPENCODE_SERVER_PASSWORD` 再啟動使用者的 shell），但仍能從 OpenCode 程序啟動時的環境讀到（macOS 的 `sysctl kern.procargs2`、Linux 的 `/proc/<pid>/environ`），OpenCode 也沒有 Unix socket、單次 token 或關掉 API 路由的選項。所以完全存取以外，Harness Relay 會監看它伺服器的事件（`GET /global/event`），看到下列任何一件事就停止這次執行，並在對話裡記下安全錯誤：不是 Harness Relay 允許的權限請求被核准；不是這次執行（或它的 subagent）的 session 被建立或開始工作；這次執行的 session 被設定了權限規則；開了一個終端機（PTY）；以及 OpenCode 沒有詢問就執行的指令（這個檢查比照 OpenCode 自己的 tree-sitter 判斷，所以只切換資料夾的一行、宣告、`(( ))`／`[[ ]]`、賦值或註解都不會誤觸）。監看一直持續到 prompt 回覆為止，回覆時、在通知程序結束之前就停止，所以程序退出時串流關閉不會被當成問題；使用者停止一輪時，只有串流關閉被視為預期（其他事件照樣算數）；其他任何結束方式，都會在程序被清理時停止監看。無法監看時就不執行。仍然可能的：在被發現之前，透過它的伺服器做一件沙箱本來就允許的事（一個被自己核准的工具呼叫、一個新加入的 MCP 伺服器所啟動的程式、發給這次執行自己 session 的訊息）；這些都還在沙箱的檔案與網路限制內，連到其他主機仍要經過沙箱的核准，而 Harness Relay 的埠一律連不到。

**限制**：

- 它執行的指令看得到它的 XDG 資料夾，以及這次執行的模型來源金鑰（一次執行只拿到這一個 API key 環境變數）。Harness Relay 會把 GitHub CLI 的 `GH_CONFIG_DIR` 設回使用者自己的設定，讓 `gh` 保持登入：這表示 agent 刻意可以讀到 `hosts.yml` 裡的 GitHub token（其他讀取本來就開放給每個 agent，但這裡是特意讓 `gh` 能用）。連到 github.com 仍然要經過沙箱對主機的核准。
- 沒有 `rg` 時它會從 GitHub 下載 ripgrep 到這次執行的快取；在沙箱裡這會詢問 github.com。
- token 只算這一輪最後一次模型呼叫；端點的模型沒有花費資訊。
- 一個請求只說是 MCP 工具時，核准卡片上看不到它的參數（OpenCode 在請求裡不附）。
- 與某些 Bun CLI 不同，編譯後的 `opencode` 程式不會讀取它啟動所在資料夾裡專案的 `bunfig.toml`（`preload`）或任何 `.env` 變體（`.env`、`.env.local`、`.env.<NODE_ENV>`…），所以啟動時不會從儲存庫執行任何程式、也不會載入任何變數（已對 `opencode acp` 與 `opencode models` 實測）；它在工作目錄中啟動。

## Goose

轉接器：`src/server/agents/goose.ts`，以 Goose 1.58.1（Homebrew `block-goose-cli`）驗證。

**指令。** `goose acp`，每一輪一個行程，走共用的 ACP 回合。它提供 `loadSession`（沒有 `session/resume`）、圖片、內嵌內容與 HTTP MCP 伺服器。

**家目錄。** Goose 的家目錄是 Harness Relay 自己的：`GOOSE_PATH_ROOT` 把它的設定、資料、狀態與 `.agents` 資料夾指到成員自己的狀態資料夾（`<agent 家目錄>/goose/private/<key>`：它們一起搬動），`HOME` 也一樣，因為 Goose 仍透過 `$HOME` 找 skill 與 recipe（`~/.agents/skills`、`~/.claude/skills`、`~/.config/agents/skills`、`~/.goose/recipes`）。它執行的 shell 指令會拿回使用者自己的 `HOME`：Harness Relay 給它一個小包裝當 shell（`GOOSE_SHELL` → `<家目錄>/bin/bash`，設好 `HOME` 再執行 bash），所以 git、rustup、nvm 等照常運作。因此 Goose 的指令能讀取使用者真正的家目錄，就像每個 agent 的指令一樣：所有 agent 都能讀取，只有受保護的路徑會被拒絕；完全存取以外，Harness Relay 沙箱的網路封鎖才是界線。金鑰儲存區關閉（`GOOSE_DISABLE_KEYRING`；金鑰只從環境變數來，所以從不詢問 macOS 鑰匙圈），遙測與 session 命名（每個新 session 多一次模型呼叫）也關閉。`/etc/goose/config.yaml` 是 Goose 最先讀的系統層設定，無法移開。
- `statePaths`：`data/`（SQLite 裡的 session、模型目錄快取）與 `state/`（記錄檔，以及 `llm_request.*.jsonl`：最近幾次模型請求的完整內容）。
- `configPaths`：`config/`（`config.yaml`、空的 `permission.yaml`、`custom_providers/`）、`.agents/`、`.config/`、`.claude/`、`.goose/`，在那個資料夾中、每次執行前寫入；以及共用家目錄中的 `bin/`（shell 包裝）。每次執行前，這些資料夾裡不是 Harness Relay 寫入的東西都會清掉（完全存取的執行留下的 plugin、skill、recipe、提示檔），所以同一成員之後的唯讀執行不會載入先前執行埋下的東西。

Goose 每次存取都會重讀 `config.yaml`，而且任何設定鍵都先看同名的大寫環境變數，所以每次執行決定的事都放在環境變數裡，不寫進共用的檔案（平行執行會互相覆蓋）：`GOOSE_PROVIDER`、`GOOSE_MODEL`、`GOOSE_MODE`、`EXTENSIONS`、`PLUGINS`、`CONTEXT_FILE_NAMES`。伺服器繼承來、會改變 Goose 行為的變數（所有 `GOOSE_*`、`OPENAI_HOST`、`ANTHROPIC_HOST`、`XAI_HOST`、`EXTENSIONS`…）會先拿掉；Goose 會讀的追蹤變數（`OTEL_*`，例如 `OTEL_EXPORTER_OTLP_ENDPOINT`，以及 `LANGFUSE_*`）也會拿掉，否則它會把這一輪的提示與回覆送到別處。`config.yaml` 只放每次都一樣的設定。

**模型來源。** `openai`、`anthropic`、`xai` 是 Goose 自己的 provider，金鑰來自 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 或 `XAI_API_KEY`（OpenAI 走它的 Responses API）。每個自訂端點寫成 provider 檔 `config/custom_providers/relay-<id>.json`（`engine: openai`、它的 base URL、輸入的模型），金鑰放在 `HARNESS_RELAY_ENDPOINT_<ID>_API_KEY`，從不寫進檔案。新 session 從環境變數取 provider 與模型；接續的 session 保留它原本的，所以每次 `session/load` 之後，Harness Relay 用 `session/set_config_option` 依 Goose 的順序重新設定：`provider`（會把模型重設為該 provider 的預設）、`model`、`thinking_effort`（`off`、`low`、`medium`、`high`、`max`；自訂端點只有 `off`，就照它執行），最後是模式。模型選單來自 Goose 自己的目錄（`_goose/unstable/providers/list`，不需要金鑰），只留已設定的模型來源，再加上各端點的模型。金鑰錯誤、模型不存在、端點連不上，這一輪會以清楚的訊息結束並說明是哪一個。

**權限。**

| Relay 權限 | Goose |
| --- | --- |
| 唯讀 | `approve` 模式：每個工具呼叫 Goose 都會先問。讀取的工具（`tree`、`analyze`、`load_skill`、`load`、讀檔的 `read_image`）、subagent（沒有指定來源的 `delegate`：它自己的呼叫會一一詢問）與它的 todo 筆記直接執行；指定來源（recipe 或 agent，包括專案自己的）或接續 subagent 的 `delegate` 會詢問，因為來源會啟動它宣告的擴充，指令也包括在內。只讀取的 shell 指令也直接執行，因為 Goose 沒有讀檔的工具，都用 shell 讀：bash 不會在程式看到之前改寫任何字（單引號以外沒有 `$`，所以沒有變數、`$'…'` 或 `$"…"`；沒有未加引號的 `*`、`?`、`[`、`{`、`~`、`#`、`(` 或 `)`，所以沒有 subshell、`((…))` 或 `[[…]]`），沒有重新導向；每個指令都以讀取程式自己的名稱開頭（`cat`、`ls`、`rg`、`grep`、`find`、`sort`、`head`…；不能是 `./cat`，也不能放在 `xargs`、`env`、`timeout`、`nohup`、`eval`、shell 或這一行設定的變數後面）；每個選項都在該程式的允許清單上（沒有會寫檔、執行其他程式或設定變數的選項：`printf` 不能有任何選項，因為 `printf -v` 會設定變數；不能有 `sort -o` 或 `--compress-program`、`find -exec` 或 `-delete`、`rg --pre` 或 `-z`、`tree -o`、`tail -f`；git 完全不算，因為儲存庫自己的設定能讓它的讀取指令執行程式）。其他編輯與指令都交給使用者。 |
| 可編輯 | `approve` 模式：除了推送與發佈的指令要問使用者，其他都直接執行。 |
| 完全存取 | `auto` 模式：Goose 什麼都不問。 |

每一輪都明確設定模式（`session/set_mode`），因為接續的 session 會保留原本的模式。每次執行前 `permission.yaml` 都寫成空的，所以 Goose 自己沒有規則能繞過 Harness Relay。只會回答 `allow_once` 或 `reject_once`：選「一律」時 Goose 會寫 `permission.yaml`，`smart_approve` 則每次模型呼叫都寫（設定資料夾唯讀時 Goose 會當掉、這一輪卡住），所以兩者都不用。Goose 不理會跟著回答送去的理由（`_meta.followup_message`），只告訴模型使用者拒絕了、要它停下。所以回答拒絕之後，Harness Relay 用 `_goose/unstable/session/steer` 把理由與使用者的留言送進進行中的這一輪，當成使用者訊息；模型在被拒絕的呼叫之後就會讀到並繼續。subagent 的呼叫在上層 session 底下詢問。

**角色說明。** 用 `_goose/unstable/session/system-prompt/set`（append，key `harness-relay`），每一輪都送，以取代接續 session 先前的內容；它也說明 Harness Relay 怎麼顯示 Goose 的 todo 筆記。

**事件。** Goose 的工具呼叫沒有 ACP 的 `kind`，所以呼叫的種類取自工具名稱（`_meta.goose.toolCall.toolName`，subagent 的呼叫則取標題的第一段）：`shell`、`write`、`edit`、`tree`、`analyze`、`read_image`、`load_skill`、`load`、`delegate`、`<extension>__<tool>`。工具列顯示指令或路徑；編輯的那一列說明改了什麼（Goose 不送 diff）；以錯誤結束的指令顯示為失敗。`todo` 擴充的筆記顯示為計畫（`- [ ]`、`- [~]`、`- [x]` 與一般清單項目），不顯示成一列；Goose 不送 ACP `plan`。思考以 `agent_thought_chunk` 傳來（Anthropic、xAI，以及端點上的推理模型）。被取消的呼叫 Goose 不會再更新，那一列會標為沒有執行完。token 是這一輪最後一次模型呼叫的數字；Goose 的費用是整個 session 的總和，所以一輪的費用是它增加的部分（總和記在共用家目錄的 `relay-cost/` 供下一輪使用，那裡由 Harness Relay 寫入、沙箱中的執行不能寫，所以 agent 無法改變它每一輪顯示的費用；自訂端點沒有費用）。

**擴充。** 每次執行透過 `EXTENSIONS` 開啟 `developer`（shell、write、edit、tree、read_image）、`analyze`、`summon`（subagent）與 `todo`。`apps`、`extensionmanager`（會讓模型自己開啟其他擴充，例如操控電腦）、`scheduler`、`tom`、`chatrecall`、`summarize`、`code_execution` 都關閉。工具庫的 MCP 伺服器放在 `mcpServers`（stdio 與 HTTP）；接續的 session 保留它的擴充清單，再加上工具庫的伺服器。Goose 把這份清單存在它資料庫裡這個 session 的那一列（`sessions.extension_data`），也就是成員的狀態資料夾裡，執行的指令能寫入；載入 session 時它會啟動清單裡的每個擴充功能，包括 stdio 的指令，不經詢問，也不理會隨 `session/load` 送來的清單（用 1.58.1 確認過）。所以在 `session/new` 之後、送出 prompt 之前，Harness Relay 把 Goose 算出的清單封存在這個 key 的封存資料夾（`private/.sealed-<key>`，任何執行都不能讀寫），之後每次接續前再把它放回那一列（`restoreGooseSession`）。沒有封存的（在這之前開始的 session），只保留它自己的平台擴充功能：工具庫的伺服器會隨載入補回，外掛的 MCP 伺服器則要在新的 session 才有。它也會清掉 Harness Relay 從不在那裡設定的欄位（`recipe_json`、`user_recipe_values_json`、`system_prompt_override`、`system_prompt_extras_json`（角色說明會在載入後重新設定）與 `container_id`）。無法檢查的那一列不會被接續：這一輪改開新的 session。stdio 伺服器以 Goose 的環境執行，而它的 `HOME` 是成員的狀態資料夾，所以和 shell 一樣拿回使用者真正的 `HOME`；在 Harness Relay 的沙箱裡兩個家目錄都不能寫，`npx`、`uvx`、`pip` 寫的快取（`npm_config_cache`、`XDG_CACHE_HOME`、`UV_CACHE_DIR`、`PIP_CACHE_DIR`）就放在這次執行的暫存資料夾。工具庫為伺服器設定的值優先。

**它自己載入的項目**（設定 → Goose；以 `_goose/unstable/sources/list` 詢問，並讀取它會讀的資料夾）：
- **指示檔**：工作目錄到儲存庫根目錄之間的 `.goosehints` 與 `AGENTS.md`，以及它家目錄裡的（不讀 `CLAUDE.md`）。可每次執行以 `CONTEXT_FILE_NAMES` 全部略過。
- **Plugin**：專案 `.agents/plugins/`（以及它家目錄）裡的每個資料夾，連同它的 hook（`hooks/hooks.json`）、skill 與 MCP 伺服器（`.mcp.json`），預設開啟。可全部或一個一個略過（`PLUGINS`，以資料夾為準）；plugin 的 MCP 伺服器從新的對話開始生效。
- **它自己啟動的 MCP 伺服器**（plugin 的）：在新 session 以完整的擴充清單略過（`_meta.enabledExtensions`：只有上面的擴充與工具庫的伺服器）；接續的 session 沿用開始時的清單。
- **Skill**：專案的 `.goose/skills`、`.claude/skills`、`.agents/skills`、它家目錄裡的，以及兩個內建的。Goose 沒有關掉它們的設定，一定會載入（使用者自己 `~/.claude/skills` 等處的不會，因為它的家目錄是 Harness Relay 的）。
- **Recipe 與 agent**：專案的 `.goose/recipes`、`.agents/recipes`、`.agents/agents` 與 `.claude/agents`（以及已拿掉的 `GOOSE_RECIPE_PATH`），模型可以 `load` 或 `delegate` 給它們。Goose 沒有關掉專案這些項目的設定：一定找得到。recipe 可以宣告擴充，其中可能有指令，`delegate` 給它時就會啟動：唯讀模式下這種 `delegate` 會詢問；可編輯模式下會執行，就像執行一個指令。

**Harness Relay 的沙箱**（完全存取以外）。可寫入：`data/`、`state/` 與這次執行的暫存資料夾（完全存取以外是沙箱自己的 `data/relay-sandbox/<hex>`，放在 `TMPDIR`；完全存取時是 `data/run-tmp/goose-<亂數>`），可編輯模式另有工作目錄與附件資料夾；`configPaths` 唯讀。Rust 的 reqwest 直接使用沙箱的 proxy。Goose 要求的項目（`gooseSandbox()`）：
- `allowTlsTrustd`（macOS），在這次執行走 HTTPS 時（API 模型來源、HTTPS 端點或 HTTPS MCP 伺服器）：Goose 透過 macOS Security framework（rustls-platform-verifier）驗證憑證，需要 `com.apple.trustd.agent`；沒有它，每個 HTTPS 請求都會失敗（「invalid peer certificate: OSStatus -26276」），`GOOSE_CA_CERT_PATH` 與 `SSL_CERT_FILE` 都無法避開。這會開放那一個服務，是帶出少量資料的可能管道（見 [Harness Relay 自己的沙箱](sandboxing.zh-TW.md#harness-relay-自己的沙箱)）。純 HTTP 的端點不需要。
- `quietlyDeniedHosts`：`models.dev`（它的模型目錄，每次啟動都會抓，沒有設定可關）、`api.osv.dev`（`npx` / `uvx` MCP 伺服器啟動前的惡意套件檢查，失敗時照樣啟動）與 `us.i.posthog.com`（遙測，本來就關閉）。
- `connectPorts`：工具庫中位在這台電腦的 HTTP MCP 伺服器的連接埠，Goose 透過 proxy 連過去；只能連線：沙箱不能在這些埠上監聽，所以伺服器沒在執行時，指令也不能搶佔它的埠。

**限制。**
- 唯讀模式下只讀取的指令不經詢問直接執行（如上）；無論執行什麼，沙箱都讓資料夾無法寫入。
- 它的 shell 指令以使用者真正的 `HOME` 執行（`GOOSE_SHELL`：一段固定的包裝 script，從 `HARNESS_RELAY_USER_HOME` 與 `HARNESS_RELAY_GOOSE_BASH` 取得那個家目錄與使用者的 bash，再移除這兩個變數），所以能讀取使用者的家目錄，和任何 agent 的指令一樣；網路封鎖才是界線。
- 無法略過 skill，也無法略過專案的 recipe 與 agent；接續的 session 沿用開始時的擴充與 plugin 的 MCP 伺服器。
- 拒絕的理由是以這一輪的使用者訊息（steer）送到模型，在 Goose 自己的「已拒絕，請停下」之後。
- macOS 上使用 HTTPS 模型來源時會開放 trustd 服務（如上）。
- 若管理者寫了 `/etc/goose/config.yaml`，它仍然有效。

## Cline

以 `cline` 3.0.74（npm `cline`；原始碼為標籤 `cli-v3.0.74`）在 macOS 上搭配每一種模型來源檢查過。轉接器：`src/server/agents/cline.ts`；`test/cline.test.ts` 重播從真實 CLI 錄下的訊息（`test/fixtures/cline/`）。

**指令。** `cline --acp`，在 stdio 上說 ACP；完全存取時加 `--auto-approve true`；推理強度用 `--thinking none|low|medium|high|xhigh`（它唯一的推理強度設定：沒有這個參數時，一輪不會思考）。`PATH` 上的 `cline` 是一個小小的 Node 啟動程式，由它啟動旁邊以 Bun 編譯的 CLI。加上 `--acp` 時，`-P`、`-m`、`-s`、`--config` 與 `--data-dir` 都沒有作用。

**在哪裡啟動。** Cline 執行在 Bun 上，而 Bun 會自己讀取它啟動所在資料夾的 `.env`、`.env.local`、`.env.development`（`.env.<NODE_ENV>` 與其 `.local`）以及 `bunfig.toml`（其中的 `preload` 會執行程式碼）；不讀上層資料夾的，也不讀 `~/.bunfig.toml`（檢查過）。專案的 `.env` 因此可以設定 Cline 自己的變數（它從哪裡讀規則、plugin 的啟動程式、它的 JavaScript 執行環境…），`bunfig.toml` 則能在任何詢問之前執行程式碼。所以 Cline 在這次執行專屬的暫存資料夾啟動（`processCwd`），而它的 session 仍是專案：它的工具、規則與 `AGENTS.md`、相對路徑與 `git` 照常在專案中運作（檢查過，也在 Harness Relay 的沙箱中，放了 `.env`、`.env.local`、`.env.development` 與 `bunfig.toml`：沒有一個被讀取或執行）。探測它自己載入的內容時，也從一個專屬的空資料夾啟動，以 `--cwd` 指向專案；工具庫的 stdio MCP 伺服器則和其他 CLI 一樣在工作目錄啟動。伺服器環境中除了它家目錄的變數以外，其他所有 `CLINE_*` 變數都會拿掉（它讀取的約有一百個）。

**它的家目錄**（`<agent 家目錄>/cline`）：

- `data/`（`CLINE_DATA_DIR`），在成員自己的狀態資料夾（`<agent 家目錄>/cline/private/<key>/data`）：它的 session（`sessions/<id>/<id>.json`、`<id>.messages.json`）、SQLite（`db/`）、hook 紀錄與快取：屬於狀態，在沙箱中可寫入。
- `config/`（`CLINE_DIR`，以及狀態檢查、模型目錄與探測讀取的設定檔）和 `data/cache/feature-flags.json`（每次執行前重新寫入）：唯讀。
- 每次執行在自己的暫存資料夾裡有專屬的 `CLINE_DIR`，內含 `rules/harness-relay-briefing.md`（角色說明）、`global-settings.json`、`mcp.json` 與 `providers.json`（由 `CLINE_GLOBAL_SETTINGS_PATH`、`CLINE_MCP_SETTINGS_PATH`、`CLINE_PROVIDER_SETTINGS_PATH` 指定）：在沙箱中唯讀，隨資料夾一起移除。平行執行不會共用角色說明或設定，session 仍從 `data/` 接續。
- `CLINE_SESSION_BACKEND_MODE=local`：否則它的執行環境會加入正在執行的 Cline「hub」（使用者自己的，在 25463 埠），或在背景啟動一個、活得比這次執行還久。`E2E_TEST=true`：它的 feature flag 即使關掉遙測也會向 data.cline.bot 取得，設了之後不再取得。`CLINE_NO_AUTO_UPDATE=1`。`BUN_RUNTIME_TRANSPILER_CACHE_PATH` 放在這次執行的暫存資料夾（Bun 對它載入的 plugin 的快取；jiti 的快取在 `TMPDIR`）。會搬動它的資料、換掉它的程式（`CLINE_BIN_PATH`）、重播或錄下請求（`CLINE_VCR`、`CLINE_CAPTURE_*`）、加入 hook（`CLINE_HOOKS_DIR`）或指向 hub 的變數都設為空值，伺服器的其他 `CLINE_*` 變數則全部拿掉。
- **遙測**：發佈的版本會直接把 OpenTelemetry 送到 otel.cline.bot，不經過任何代理。每次啟動都寫入的全域設定 `"telemetryOptOut": true` 會關掉它（檢查過：之後不再連線）。
- **`cli-node-extra-ca-certs.pem`**：每次啟動時（包括 `cline --version`），Node 啟動程式都會把系統信任的憑證寫進 `CLINE_DIR`；沒有設定這個變數時就是 `~/.cline`。它不會寫到 `CLINE_DIR` 以外的地方。開發這個轉接器的電腦上出現的 `~/.cline/cli-node-extra-ca-certs.pem`，來自轉接器設定 `CLINE_DIR` 之前的一次版本檢查；現在 Harness Relay 每次啟動它（狀態檢查、模型目錄、探測、執行）都會設定 `CLINE_DIR`，所以 Cline 不會再寫入 `~/.cline`。
- `HOME` 維持原樣，agent 執行的指令才能沿用使用者的 git 與 ssh 設定。因此 Cline 仍會讀取 `~/.agents/AGENTS.md`、`~/.agents/skills`、`~/.agents/plugins`、`~/Documents/Cline/{Rules,Workflows,Hooks,Plugins}` 與 `~/Cline/Rules`（見它自己載入的內容）。

**模型來源。** 每次執行一個 provider，放在 `CLINE_PROVIDER`：`openai-native`、`anthropic`、`xai`，或自訂端點用的 `openai-compatible`，端點的 `baseUrl` 寫進這次執行的 `providers.json`（從不寫入 key）。key 放在 `CLINE_API_KEY`，Cline 會把它送給那個 provider；沒有 key 的端點會得到一個佔位值，因為沒有 key 時 Cline 的 ACP 不肯開始 session。模型來源自己的 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 與 `XAI_API_KEY` 會從它的環境中拿掉。不會有任何東西送到 Cline 自己的帳號：從不呼叫 `authenticate`，它也只為自己的 provider 查詢組織。模型用 `session/set_config_option`（`model`）設定：同時設定的 `CLINE_MODEL` 只對 Cline 目錄裡有的模型有效，其他模型會在不知不覺中變成 provider 的預設模型。在兩輪之間換模型或模型來源，接續的 session 就會使用新的。**模型目錄**：對每個 API 模型來源以佔位 key 呼叫 `session/new`（不會送出任何東西），寫成 `<模型來源>/<模型>`；預設模型是第一個有 key 的 API 模型來源的預設。

**權限。** 透過 ACP，Cline 對每個工具呼叫都會詢問，連讀取也是（它的 ACP session 設定為 `toolPolicies: {"*": {autoApprove: false}}`），所以共用的決定方式原樣適用：唯讀模式直接執行 `read_files`、`search_codebase`、`fetch_web_content` 與 `skills`（只讀取 skill 的說明），其他的都會詢問；可編輯模式只詢問推送與發佈（`run_commands` 的每一條指令，一行一條）；完全存取用 `--auto-approve true`。session 一律維持在 `act`：Cline 的 `session/set_mode` 影響不到由 `session/load` 開始的 session，它的 plan 模式只會對新 session 有效。它的工具：`read_files`、`search_codebase`、`run_commands`、`fetch_web_content`、`editor`（OpenAI 模型則用 `apply_patch`：視為編輯，patch 裡寫明檔案）、`skills`、`spawn_agent`（它的 subagent 也會詢問），以及 MCP 伺服器的工具，名稱為 `<伺服器>__<工具>`。provider 自己的網頁搜尋（OpenAI 的）在 provider 那邊執行，不會詢問。

- 它提供的選項是 `allow_once`、`allow_always`（它當成只允許一次）與 `reject_once`。**拒絕傳到它的模型時，只有 Cline 自己固定的文字**（「User rejected the tool call…」）：答覆裡的其他內容它都忽略，所以使用者的說明只顯示在對話裡，角色說明則會告訴模型被拒絕的呼叫是什麼意思。
- 在它等待答覆時停止，Cline 要等到請求得到答覆才結束這一輪：轉接器會立刻答覆 `cancelled`。

**角色說明。** 這次執行專屬 `CLINE_DIR/rules` 裡的一個規則檔，每次啟動都會讀取，所以接續的 session 也會採用改過的角色說明。Cline 不讀取任何 `_meta`，加上 `--acp` 時 `-s` 也沒有作用。

**工具庫。** 它的 MCP 伺服器寫進這次執行的 MCP 設定檔（stdio：`command`、`args`、`env`；HTTP：`type: "streamableHttp"`、`url`、`headers`），因為 Cline 會忽略 `session/new` 與 `session/load` 的 `mcpServers`。skill 和其他 agent 一樣透過角色說明提供。

**事件。** 文字與思考片段；沒有計畫或待辦事項的事件（透過 ACP 它沒有待辦事項工具）。它的工具更新會在共用回合讀取前先修正（`filterUpdate`）：它詢問的呼叫先以 `tool_call_update` 出現（那一列從這裡開始），答覆後又以 `tool_call` 出現一次；輸出在 `rawOutput`（`{query, result, success, error}` 的清單、MCP 的結果、provider 的搜尋），不在 `content`；失敗的指令或編輯常以 `completed` 加上 `success: false` 回報，會顯示為失敗。它宣稱接受圖片，卻只取用提示的文字（附加圖片的路徑寫在提示裡，它的讀檔工具可以打開）。用量不在 ACP 裡：這一輪的 token 數與費用，是它的 session 紀錄（`data/sessions/<id>/<id>.json`，在一輪結束時寫入）在這一輪增加的部分；端點的回合沒有費用。

**接續。** `session/load`（它宣告 `loadSession`，沒有 `resume`）；不存在的 session 會得到 `-32002 Resource not found`，orchestrator 便以完整歷史開始新的 session。

**錯誤。** key 被拒絕、模型來源沒有那個模型、連不上端點，都有說明該怎麼做的訊息，並附上 provider 自己的說法。

**它自己載入的內容**，以 `cline config <種類> --json` 詢問規則、skill、hook、agent 與 plugin（它們只讀取檔案；不使用不加種類的 `cline config --json`：它會以「auto」模式建立 Cline 的執行環境，因而加入正在執行的 hub 或啟動一個）。完全存取以外，hook 與 plugin 在 Harness Relay 的沙箱裡執行；完全存取時以使用者的身分執行。

- 指示：專案的 `AGENTS.md`、`.clinerules`（檔案或資料夾）與 `.cline/rules`；`~/.agents/AGENTS.md`、`~/Documents/Cline/Rules`、`~/Cline/Rules`（不讀 `CLAUDE.md`）。沒有開關。
- skill：專案的 `.clinerules/skills`、`.cline/skills`、`.claude/skills` 與 `.agents/skills`，以及 `~/.agents/skills`。關掉它的 `skills` 工具（`disabledTools`）就**全部不載入**。不論如何 `cline config skills` 都會列出它們，所以探測結果由轉接器依這次執行的設定標出不載入的項目（skill、個別工具與 plugin：`leftOut`，並設 `asRun`）。
- hook（`.clinerules/hooks`、`.cline/hooks`、`~/Documents/Cline/Hooks` 裡的 `TaskStart`、`PreToolUse`… 腳本）：會執行，不經詢問。沒有開關。
- plugin（`.cline/plugins`、`~/Documents/Cline/Plugins`、`~/.agents/plugins` 裡的 JavaScript 或 TypeScript）：session 開始時執行它們的程式碼。可依路徑**個別不載入**（`disabledPlugins`）。
- 內建工具：可依名稱**個別不載入**（`disabledTools`）。
- workflow（斜線指令）不列出：Harness Relay 的提示不會以 `/` 開頭。

**沙箱的需要。** 可寫入：`data/` 與這次執行的暫存資料夾；唯讀：`config/`、`data/cache/feature-flags.json` 與這次執行專屬的 `CLINE_DIR`。唯一的額外選項是 `quietlyDeniedHosts`：otel.cline.bot、data.cline.bot 與 api.cline.bot，都是它自己的服務，每次執行都已關閉，所以即使它仍試著連線，也會直接拒絕、不跳出核准卡片。不需要 loopback 埠（沒有 hub）、虛擬終端、Unix socket 或 macOS 的 trustd：Cline 在 Bun 上執行，它的 TLS 經過沙箱的代理，使用自己的憑證清單（啟動程式查看系統信任存放區時在沙箱中會失敗，印出「failed to copy trust settings」，沒有影響）。已在 macOS 上搭配每一種模型來源、以唯讀與可編輯模式檢查過：agent 正常工作；寫到允許的資料夾以外會失敗；連到其他主機會詢問；Cline 自己的主機會直接拒絕；受保護的路徑與 Harness Relay 的埠都連不到；一輪結束後 Cline 本身與這次執行的暫存資料夾都已不在。和 Claude Code、Codex、Grok 一樣，Harness Relay 在一輪結束時停止它的程序樹；指令或專案的 hook 讓程序脫離這棵樹（`nohup … &`、`setsid`）時，那個程序就不在其中，完全存取時沒有沙箱，它會繼續執行。Linux 上尚未檢查。

**限制。** 拒絕時的說明傳不到它的模型；不使用 plan 模式；推理強度是每個程序設定（`--thinking`），不是每個 session；圖片以路徑提供；它的 session 紀錄保留 session 開始時的模型（`model`），但每一輪都使用設定的模型；專案的 hook、規則與 workflow 沒有開關，plugin 只能個別略過。

## OpenHands

`openhands acp`（PyPI 套件 `openhands`，用 `uv tool install openhands` 安裝；以 1.16.0 開發與檢查，它帶 openhands-sdk 1.21.0 與 LiteLLM 1.108.4），轉接器在 `src/server/agents/openhands.ts`。每一輪一個程序，走共用的 ACP 回合。OpenHands 在 stdin 關閉後不會自己結束，所以一輪結束就停掉它（`exitGraceMs: 0`）；它啟動並回應 `initialize` 約需 2.5 秒。

**家目錄。** OpenHands 的設定是一整個序列化的 agent（`agent_settings.json`），而 `OPENHANDS_PERSISTENCE_DIR` 只搬動它、`mcp.json` 與 session；skill、hook、subagent 與快取都跟著 `HOME`。因此每次執行都在這次執行的暫存資料夾（完全存取時是 `data/run-tmp/openhands-<亂數>`，完全存取以外是 relay 沙箱的 `data/relay-sandbox/<id>`）裡有一個自己的家目錄（`HOME`、`OPENHANDS_PERSISTENCE_DIR`，以及它的 `cli_config.json` 讀的 `PERSISTENCE_DIR`），執行前寫好、執行後刪除；只保存 session，放在成員自己的狀態資料夾（`OPENHANDS_CONVERSATIONS_DIR` = `<agent 家目錄>/openhands/private/<key>/conversations`，即它的 `statePaths`）。用不同模型的成員可以同時執行，不會改到彼此的設定。Harness Relay 在這次執行的家目錄寫入下列檔案，在 relay 沙箱內唯讀（`configPaths`）：`agent_settings.json`、`mcp.json`、寫成 skill 的角色說明、關掉公開 skill 的佔位檔，以及 `.bashrc`（見下）。

**環境變數。** OpenHands 會把它啟動所在資料夾的 `.env` 載入環境，只要那個變數還沒設定，而它的終端機（`bash -i`）原封不動拿到這個環境：專案的 `PROMPT_COMMAND`（或 `PS0`，Linux 上還有 `LD_PRELOAD`）會在每一輪開始時、任何核准之前執行。所以它在這次執行的暫存資料夾啟動（`processCwd`），那裡沒有 `.env`；session 的資料夾仍是專案（`session/new` 的 `cwd` 與 `OPENHANDS_WORK_DIR`），它的工具、終端機，以及專案的 skill、hook 與 `AGENTS.md` 都在那裡（實際檢查過：`pwd` 是專案，專案 `.env` 的 `PROMPT_COMMAND` 與變數都到不了它的指令，`AGENTS.md` 仍然有效）。`LITELLM_MODE=PRODUCTION` 讓 LiteLLM 不去載入它安裝資料夾上方找到的第一個 `.env`（例如 `~/.env`）。專案的 `.env` 現在只會影響自己去讀它的程式（指令執行的專案自身程式碼）。轉接器依賴的每個變數照樣每次執行都明確設定（上面的資料夾、`OPENHANDS_WORK_DIR` = 工作目錄、完全存取時的 `TMUX_TMPDIR`、`OPENHANDS_SUPPRESS_BANNER=1`、LiteLLM 改用內建副本的 `LITELLM_LOCAL_*` 開關、XDG 資料夾），而會把金鑰送到別處或打開追蹤的變數設成空字串（`emptyEnv`：`OPENAI_BASE_URL`、`ANTHROPIC_BASE_URL`、`XAI_API_BASE`、`LMNR_PROJECT_API_KEY`、`OTEL_*`、`LLM_API_KEY` / `LLM_MODEL` / `LLM_BASE_URL`、`DEBUG`、`LOG_TO_FILE`…：LiteLLM 與 OpenAI、Anthropic SDK 為 OpenAI、OpenAI 相容端點、Anthropic 與 xAI 讀取的每個 base URL，`OPENAI_BASE_URL`、`OPENAI_API_BASE`、`ANTHROPIC_API_BASE`（比 `ANTHROPIC_BASE_URL` 先讀）、`ANTHROPIC_BASE_URL`、`XAI_API_BASE`、Azure 的，以及 LiteLLM 的 proxy 與 gateway 網址；完全存取時連 proxy 變數也是，完全存取以外由沙箱設定）。它終端機的 shell 會讀這次執行的 `.bashrc`，讓指令拿回使用者自己的 `HOME` 與 XDG 資料夾。

**模型來源。** 模型只能在 `agent_settings.json` 裡選（ACP 的 `session/set_model` 不存在，`session/set_config_option` 不起作用），寫成 LiteLLM 的名稱：`openai/<model>`、`anthropic/<model>`、`xai/<model>`；端點寫成 `openai/<model>` 加上它的 `base_url`，金鑰在那次執行放進 `OPENAI_API_KEY`（沒有金鑰時是 `no-key`）。檔案裡不寫金鑰：LiteLLM 讀 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 與 `XAI_API_KEY`。它每次啟動都讀這個檔，所以同一個 session 的成員可以在兩輪之間換模型，甚至換到另一個模型來源。重試次數降到 2 次（OpenHands 預設會對連不到的模型來源重試好幾分鐘）。**推理強度**是它的 `reasoning_effort`（`low`、`medium`、`high`、`xhigh`），有選擇時就寫入，除非 LiteLLM 的模型資訊說這個模型不會推理（LiteLLM 沒有資訊的模型，例如端點的模型，會送出選的推理強度；拒絕它的模型會讓這一輪失敗，並說明要改設什麼）；選 `none` 或沒有選時什麼都不送（OpenHands 自己的預設會送 `high`，有些模型會拒絕）；對 OpenHands 會開延伸思考的 Claude Sonnet 4.5 / 4.6 與 Haiku 4.5，另外設定思考預算（2 048 到 64 000 個 token）。選單只為每個模型提供 LiteLLM 說它接受的推理強度（不會推理的模型沒有，`xhigh` 只在它說可以時）。xAI 對好幾個 LiteLLM 標成會推理的模型（grok-code-fast-1、grok-4.20 系列、grok-build）拒絕推理強度：這樣的一輪會失敗，並說明要改設 `none`。**模型選單**是 OpenHands 安裝裡 LiteLLM 自己的清單（`litellm/model_prices_and_context_window_backup.json`，從 `openhands` 程式的 `#!` 行找到；不執行也不下載任何東西）：OpenAI、Anthropic 與 xAI 能呼叫工具的對話模型，去掉微調樣板、語音與搜尋模型，以及已列出模型的日期版本，依系列排列、新的在前，各自附上可選的推理強度。

**權限。** 完全存取以外它用自己的 `always-ask` 模式（除了 `think` 與 `finish`，每個動作都先問），完全存取用 `always-approve`（`session/set_mode`）。它的權限請求不說是哪個動作（`confirmation-<session>`，kind `other`）：所以依它等待中的動作來決定，在請求來的當下從 session 自己的紀錄讀出（OpenHands 在宣告並詢問之前，先把每個動作存進 `conversations/<id>/events`），也就是它前一刻宣告的工具呼叫（`describeCall`）；兩者不完全相同時（某個更新來晚了，或紀錄被別的東西改過），不論權限如何都先問使用者。這些呼叫中，`file_editor view` 與 `task_tracker` 算讀取，`invoke_skill` 算 `other`（叫用 skill 會執行它的 `SKILL.md` 裡內嵌的 shell 指令，也就是 `!` 後面接反引號括起的指令），其他 `file_editor` 指令算編輯，`terminal` 算指令，MCP 工具算 `other`；MCP 工具的卡片寫出工具名稱（取自 session 的紀錄：它的更新只有模型對這次呼叫的摘要），並以精簡的 JSON 顯示它的輸入，「一律允許」也以工具為準。一個請求涵蓋好幾個呼叫時（模型平行呼叫工具），一個回答會讓它們全部執行，所以只有權限涵蓋其中每一個時才不經詢問執行；否則卡片列出全部的呼叫，「一律允許」也以它們全部為準（指令就是它們全部的指令，每行一個；編輯就是它們全部的檔案，每行一個；種類不同的呼叫則是整份清單，只有完全相同的呼叫才會再符合）。對話自行拒絕這樣的請求時，每個呼叫的那一列都會說明原因：它自己的理由，或是它跟同一批的其他動作一起被拒絕。前面沒有宣告任何呼叫的請求（例如上一輪留下、還在等待回答的動作）絕不會自動允許：會先問使用者，或在對話設定自動拒絕時拒絕。回答用它自己的選項 id `accept` 或 `reject`，從不選 `always_proceed`（它之後就不再問）或 `risk_based`。

- **Subagent**（它的 `task` 工具，以及較舊的 `delegate`）一旦啟動，就會不經詢問執行自己的指令與修改，所以完全存取以外把這個工具從它的工具中拿掉（`filter_tools_regex`），萬一仍出現也不問使用者、直接拒絕（`decide`）。完全存取時照常提供。
- **拒絕**：OpenHands 只把它自己固定的文字告訴模型（"User rejected the action. Please ask the user how they want to proceed."），不會轉達 Harness Relay 的理由或使用者的附註；角色說明會解釋被拒絕代表什麼，聊天裡的那一列則顯示 Harness Relay 的理由與附註。

**角色說明。** 寫成這次執行家目錄裡沒有觸發條件的 skill（`skills/harness-relay-briefing.md`），OpenHands 會把它放進系統提示（它的 repository context 區塊）。系統提示在 session 開始時就存進 session，所以角色說明之後改變時（換了權限或團隊），接續的 session 也會在這次的提示前面收到新的說明。

**工具庫。** 它的 MCP 伺服器寫進這次執行的 `mcp.json`（stdio 與 HTTP），新的與接續的 session 都一樣：`session/load` 會忽略 ACP 的 `mcpServers`。

**Session。** 用 `session/load` 接續（它沒有提供 `session/resume`）；它重播的歷史會被略過。不認得的 session id 會被它「載入」成一個新的空 session，所以找不到 `conversations/<id>/base_state.json` 時，這一輪在 OpenHands 啟動前就失敗，orchestrator 再帶著完整歷史開新的 session。**上一輪留下的動作**（一輪被停止時正在執行的指令，或伺服器中斷時還在等待回答的動作）在接續時會最先執行，不經詢問、也沒有那一列（OpenHands 對沒有結果的動作的「implicit confirmation」）：轉接器在接續前，依 OpenHands 記錄拒絕的方式逐一拒絕它們（在 session 最後一個事件之後加上 `UserRejectObservation` 事件），所以它們絕不會執行，模型也會看到它們沒有執行；無法寫入時就不接續，orchestrator 改開新的 session。紀錄的讀法與 OpenHands 完全相同（從索引 0 開始、到第一個缺號為止、名為 `event-<五位數字>-<id>.json` 的檔案；從最新的往回看，之後沒有 observation、拒絕或錯誤回應的動作），而 OpenHands 自己不會寫出的紀錄也不接續：任何其他檔案、缺號、同一個索引有兩個檔案、JSON.parse 讀不了（OpenHands 自己的解析器接受 `Infinity` 與 `NaN`）或缺少欄位的事件，或是記錄為等待確認、卻沒有任何等待中動作的 session。

**事件。** 它不串流：每則訊息一次整段送來。轉接器略過它在 session 開始時當成思考送出的系統提示、它的「Conversation Paused」提示，以及它在 prompt 失敗前一刻送出的「Error: …」訊息（只是看起來像的訊息，例如開頭是「Error: AssertionError…」的回覆，會先暫存，等後面又有東西送來或 prompt 回覆時再顯示）；拿掉思考前的標題（`**Reasoning**:`、`**Thought**:`）、`finish` 呼叫的呈現方式，以及回覆末尾的推理摘要或 skill 清單。工具的結果取自它的 observation：工具自己的輸出（不含純終端機回顯的指令），observation 說失敗時就算失敗（錯誤、非零的結束碼、逾時），因為 OpenHands 把這些工具回報成 `completed`。計畫以 `plan` 更新送來；它的 `task_tracker` 呼叫不顯示成一列。Token 與費用：OpenHands 是整個 session 累計（跨接續）；這一輪的數字是結束時的累計減去 session 的 `base_state.json` 先前的數字（端點沒有費用）。

**錯誤。** 金鑰被拒（401）、模型來源沒有這個模型、額度或速率限制、連不到模型來源（relay 沙箱的 proxy 這樣回報時也是：`502 Bad Gateway`，LiteLLM 的 `BadGatewayError`）、終端機無法啟動，都會照實說明並附上模型來源的名稱；其他錯誤用 OpenHands 自己的說法，去掉它的日誌資料夾提示。**卡住而停止**：它的卡住偵測會把一直重複相同動作、或一直得到相同錯誤的一輪（在 xAI 上連續七次相同的失敗呼叫後看過）當成一般的結束，什麼都不說；只有 session 的 `base_state.json` 寫著 `execution_status: stuck`。這樣的一輪會失敗，並說明發生了什麼、可以怎麼做（再問一次、換個說法，或換一個模型；`endTurn`），下一輪則在同一個 session 繼續。

**它的終端機與 relay 沙箱。** `tmux -V` 可用時，OpenHands 在 tmux 伺服器裡執行指令（socket `openhands`，在 `TMUX_TMPDIR` 下），否則用純虛擬終端機；它沒有其他有用的開關（SDK 的工具參數 `terminal_type` 本來是一個，但 CLI 在 `session/new` 時會把 `agent_settings.json` 的工具換成它自己的，`session/load` 時換成保存的 session 的：在那裡寫 `terminal_type: "subprocess"`，實際檢查時仍然用 tmux），在 macOS 與 Linux 上也沒有不用虛擬終端機的終端機（它用管線的終端機是 Windows 的 PowerShell；從工具中拿掉 `terminal` 也沒用，因為它在篩選工具之前就啟動終端機）。**完全存取以外它一律不用 tmux**：在 tmux 裡放到背景的指令（`nohup … &`）會比這一輪活得久，因為 tmux 伺服器會關掉 relay 沙箱用來找出這次執行程序的描述子，而停止伺服器只會對它的 shell 掛斷，這種指令會忽略。所以在它的 `PATH` 最前面放一個會失敗的 `tmux`（`<這次執行的暫存資料夾>/bin/tmux`，唯讀），它就改用純虛擬終端機，沙箱會在這次執行結束時停掉它的指令。完全存取時用 tmux，socket 放在這次執行的暫存資料夾（路徑對 socket 太長時，放在它自己的短資料夾），一輪結束後，它的伺服器與底下的每個程序都會被強制結束（SIGKILL），再叫伺服器停止（`cleanup`）。

完全存取以外，它的虛擬終端機需要 `allowPty`（少了它每一輪都會立刻失敗，`fork failed`，連不用工具的也是）；不開放任何 Unix socket。**在 macOS 上** `allowPty` 會開放 `/dev/ptmx` 與每個 `/dev/ttys*`，所以這次執行的指令可以在使用者其他的終端機視窗印出文字、讀取在那裡輸入的內容、更改它們的設定（例如關掉回顯）（在我們自己開的虛擬終端機上檢查過：寫入、讀取與 `tcsetattr` 都可以；`TIOCSTI`，也就是替它打字，會被拒絕）。因此在那裡，只有使用者打開 **設定 → OpenHands →「讓 OpenHands 在沙箱裡使用終端機：它的指令因此可以讀寫你其他的終端機視窗」** 時，OpenHands 才會在完全存取以外執行（預設關閉；跟它的 provider 設定存在一起，`provider_settings.sandbox_terminal`，每次執行以 `RunOptions.sandboxTerminal` 傳入）。沒打開時，這一輪在 OpenHands 啟動前就失敗，並說出這個開關與它開放了什麼，或改用完全存取。**在 Linux 上**不需要開關：bubblewrap 給沙箱一個自己的 `/dev/pts`（新的 devpts instance，只有沙箱自己的終端機；主機的不在裡面），而且只有在它自己的輸出是終端機時，才會把那個終端機綁到 `/dev/console`，這次執行的輸出從來不是（它的輸出接到管線）。在 Docker 裡用 bubblewrap 0.8.0 與 sandbox-runtime 0.0.82 檢查過：比較內外的 devpts 掛載與 `/dev/pts` 裡的項目，沒有開啟任何終端機。

沒有任何主機被默默拒絕：它每次啟動會做的下載（從 GitHub 抓公開 skill；LiteLLM 的價格表與 Anthropic beta header，後者在呼叫開延伸思考的 Claude 模型時才抓）改成直接關掉。Python 的 `httpx`（LiteLLM 底下）與 `git` 原本就會走沙箱的 proxy。

**它自己載入的內容**（設定 → 它的卡片：從它會讀的檔案讀出；它沒有列出這些的指令）：工作目錄與其 repository 根目錄的 `AGENTS.md`、`agent.md`、`CLAUDE.md`、`GEMINI.md` 與 `.cursorrules`，當成指示；那裡的 `.agents/skills`、`.openhands/skills` 與 `.openhands/microagents` 裡的 skill；`.agents/agents` 與 `.openhands/agents` 裡的 subagent；工作目錄 `.openhands/hooks.json` 裡的 hook（不包括專案的 `.env`：見「環境變數」）。這些都無法從執行中排除（沒有開關），而 hook 會在它的事件上執行 shell 指令：完全存取以外在 relay 沙箱內，完全存取時不在沙箱內。它的家目錄是 Harness Relay 的，所以不會從那裡載入任何東西；它的公開 skill（約 70 個，來自 `github.com/OpenHands/extensions`，每次啟動都會抓）一律關掉：在它要 clone 的位置放一個普通檔案（`cache/skills/public-skills`）。它的系統提示要模型把 `AGENTS.md` 當成記憶，所以它可能會修改這個檔案。

**限制。** 使用者拒絕時寫的附註永遠不會傳給模型，那一輪不會，之後的輪次也不會（模型只看到 OpenHands 自己的文字）；附註只顯示在聊天裡。取消只會讓 OpenHands 暫停，不會停止正在執行的指令，所以被停止的一輪會在兩秒後結束它的程序（完全存取時還有它的 tmux 伺服器）。被拒絕的寫入會在那一列說明（「Harness Relay 的沙箱拒絕了：這個對話是唯讀的。」），被拒絕讀取受保護的路徑時，則會說那是受保護的路徑（Harness Relay 的資料庫與暫存檔、瀏覽器的資料）。它檔案編輯器的 `insert` 指令會讓改過的檔案權限變成 0600（它先寫暫存檔再搬過去；這是 OpenHands 本身的行為，不是轉接器造成的）。它的純虛擬終端機（完全存取以外一律使用）會回顯每個指令，轉接器會拿掉；偶爾會把上一個指令的結束碼當成這個指令的，而且沒有輸出：那一列就會顯示一個沒有發生的失敗。它的 condenser 會用同一個模型額外呼叫，摘要很長的 session。圖片提示、HTTP MCP 伺服器與 Linux 尚未用真的 CLI 試過（Linux 上只在 Docker 裡檢查過它沙箱的終端機）。

## Pi

轉接器：`src/server/agents/pi.ts`，以及它的 gate 擴充功能 `src/server/agents/piGate.js`。以 Pi 1.5.1（npm `@earendil-works/pi-coding-agent`，Node ≥ 22.19）驗證過。

**指令與協定。** 每一輪一個程序：`pi --mode rpc --model <provider>/<model> --no-extensions --no-skills --no-prompt-templates --no-themes --no-approve`，完全存取以外加上 `-e <gate>`，有工具庫的伺服器時加 `-e builtin:mcp`（否則 `--no-mcp`），角色說明用 `--append-system-prompt <檔案>`，接續用 `--session <檔案>`，唯讀時加 `--tools …`，有推理強度時加 `--thinking <level>`，不載入指示檔時加 `--no-context-files`。Pi 的 RPC 是 JSONL：指令走 stdin，回應與事件走 stdout，每行一個 JSON 物件，**只以 LF 分隔**（`PiLines` 直接切原始位元組；一般的逐行讀取器也可能在 U+2028/U+2029 或單獨的 CR 處斷行）。一輪是 `get_state`（session 與模型）→ `get_commands`（gate 已載入）→ `get_available_thinking_levels` / `set_thinking_level` → `prompt` → 事件 → **`agent_settled`**，這一輪的結束（`agent_end` 不是：之後還可能重試或處理排隊的訊息）；接著關閉 stdin，Pi 自行結束。一輪的結果看最後一個 assistant 的 `message_end`：`stopReason` 為 `error` 時這一輪失敗，並把 `errorMessage` 說成使用者能處理的話（金鑰被拒、模型來源沒有這個模型、連不上端點，包括沙箱的 proxy 這樣回報時：顯示 `HTTP 502`，而不是 undici 的原文）；不是我們停止的 `aborted` 也算失敗。

**事件。** `message_update` → `text`（`text_delta`，到 `text_end` 結束）與 `thinking`（`thinking_delta`）；`tool_execution_start` / `_end` → 工具列，名稱為 `Read`、`Bash`、`Edit`、`Write`、`Grep`、`Find`、`List` 或 `mcp__<server>__<tool>`，附上檔案、指令或搜尋樣式、輸出（修改時是帶行號的 diff）或失敗原因。用量加總這一輪所有 assistant 訊息（輸入含快取的 token、輸出；費用是 Pi 依它的目錄為 OpenAI、Anthropic、xAI 算的，端點或它不認得的模型沒有費用）。Pi 沒有計畫或待辦事件。`system` 角色的訊息（Pi 在 session 第一次請求時送出的提示）不會顯示。OpenAI 的推理摘要在它的 API 送出時以思考顯示（有些輪次沒有）。

**核准：gate。** Pi 自己沒有權限詢問。完全存取以外，gate 擴充功能以絕對路徑從 Harness Relay 自己的資料夾載入（不會從 agent 的家目錄載入，也不在這一輪可以寫入的任何資料夾裡，否則這一輪不會開始），攔下每個工具呼叫（包括 MCP 工具），透過 RPC 詢問：一個標題為 `harness-relay:tool_call` 的 `input` 對話框，它的 `placeholder` 欄位是這個呼叫的 JSON；轉接器回答 `{"allow":true}` 或 `{"allow":false,"reason":…}`。判斷方式和 ACP agent 相同（`acpPermissionDecision` → `requestApproval` → `acpDeclined`）：唯讀時讀取工具直接執行，其他的（MCP 工具）詢問；可編輯時一律執行，只有推送與發佈要詢問。拒絕的原因（連同使用者的留言）成為被擋下的呼叫的結果，並指明是哪一個呼叫（`Bash npm publish`），所以**模型看得到原因**，即使同一批呼叫中只有一個被拒絕也分得清楚，這一輪繼續進行；聊天中顯示 Harness Relay 的說明。MCP 工具的核准卡片會顯示它的輸入（常見的欄位、完整路徑，否則是它的 JSON），唯讀時也會說明即使使用者允許，沙箱仍會擋下寫入。gate 遇到問題一律拒絕：對話框被取消、讀不懂的回答、沒有可詢問的對象或發生錯誤，都會擋下呼叫。它會註冊指令 `harness-relay-gate`，轉接器在送出提示前會確認它存在：gate 沒有載入就不會執行。停止一輪時會送出 `abort`；Pi 會取消還在等待的對話框，但不會另外通知，這一輪結束時那個核准就會過期（工具列保留 Pi 的說法，不算拒絕）。唯讀時也把 Pi 的工具限制為 `read`、`grep`、`find`、`ls`（PATH 上有 ripgrep 與 fd 時才有 `grep` 與 `find`）以及工具庫的 MCP 工具（`mcp__*`）。完全存取沒有 gate。

**家目錄。** `<agent 家目錄>/pi` 只保存 session，放在成員自己的狀態資料夾（`private/<key>/sessions/`，`PI_CODING_AGENT_SESSION_DIR`；每個是一個 `<時間>_<id>.jsonl`）。Pi 啟動時讀取的一切，每一輪都寫進這一輪暫存資料夾裡全新的 agent 資料夾（`PI_CODING_AGENT_DIR`）：`settings.json`（不信任專案、不送遙測、不預熱快取）、`models.json`（端點，或 Pi 目錄中沒有的模型）、`mcp.json`、空的 `auth.json` 與 `models-store.json`，以及角色說明。這個資料夾保持可寫入（Pi 每次查金鑰都會在 `auth.json` 旁建立 `auth.json.lock`），而這些檔案，以及 Pi 會載入的其他每一個（`AGENTS.md`、`SYSTEM.md`、`APPEND_SYSTEM.md`、`keybindings.json`、`trust.json`、`extensions/`、`skills/`、`prompts/`、`themes/`、它會先於 PATH 尋找 fd 與 ripgrep 的 `bin/`、它的套件資料夾）在 Harness Relay 的沙箱中都是唯讀的。平行執行的各輪不會共用它，一輪留下的東西也到不了下一輪。每個 Pi 程序也都會設定 `PI_OFFLINE=1`（不更新模型目錄、不下載 fd/ripgrep）、`PI_SKIP_VERSION_CHECK=1`、`PI_TELEMETRY=0`，並關閉會載入程式碼的快取（擴充功能的 `JITI_FS_CACHE=false`、`NODE_DISABLE_COMPILE_CACHE=1`）。執行以外（狀態、模型清單），Pi 指向 `<agent 家目錄>/pi/agent`，絕不是 `~/.pi/agent`。

**用它的參數堵住的漏洞。** `--no-skills`：不論家目錄設在哪裡，Pi 都會讀 `$HOME/.agents/skills`（工具庫的 skill 透過角色說明交給它）。`--no-approve`：專案的 `.pi/` 資料夾（設定、MCP 伺服器、擴充功能、skill、`SYSTEM.md`）與 `.agents/skills` 都不會載入；session 資料夾一律指定，因為 Pi 在判斷信任之前就會讀專案的 `sessionDir`。另外還有 `--no-extensions`、`--no-prompt-templates`、`--no-themes`。

**模型來源。** OpenAI、Anthropic、xAI 透過它們的金鑰變數（`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`XAI_API_KEY`）；Pi 離線目錄裡沒有的模型（例如 xAI 的新模型）會連同它 API 的位址加進 `models.json`，否則 Pi 會沿用它預設模型的設定。端點是 `models.json` 裡一個 `openai-completions` 的 provider `relay-<id>`，指向它的 base URL，帶上手動輸入的模型，金鑰透過變數提供（`$HARNESS_RELAY_ENDPOINT_API_KEY`，不會寫進檔案；沒有金鑰的端點會得到一個佔位值）。啟動後會檢查模型（`get_state`；Pi 比對 `--model` 時很寬鬆，接續的 session 也會保留它自己的模型），不同時用 `set_model` 重設。**推理強度**對應 Pi 的 thinking level（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`），設定前先用 `get_available_thinking_levels` 確認，因為 Pi 會默默把不支援的強度調整掉（不認得的會變成 `off`）。模型選單來自 Pi 的目錄（離線的 `get_available_models`），附上每個模型可用的強度。

**接續。** Pi 啟動前就在 sessions 資料夾裡依 id 找到 session，並以它的檔案接續（`--session <檔案>`，會在它自己的資料夾執行）。檔案不見了（Pi 會默默開新的 session），或 session 屬於另一個工作目錄，都算接續失敗，orchestrator 會帶著完整歷史重新開始；不使用 `--session <id>`，因為遇到另一個資料夾的 session 時，Pi 會在 stdin 上詢問要不要 fork。啟動後，`get_state` 必須是同一個 session。

**它自己載入的內容。** 它的指示檔：從工作目錄**一路往上到 `/`**，每一層取 `AGENTS.override.md`、`AGENTS.md` 或 `CLAUDE.md` 中的第一個，可能包括專案以外的檔案（平行模式的 worktree 位在 Harness Relay 的資料夾裡，所以 Harness Relay 自己的 `AGENTS.md` 也在其中）。「設定」會列出它們；不載入指示檔時會加上 `--no-context-files`，一次全部略過（Pi 沒有只略過一個檔案的開關）。除此之外不會載入它自己的任何東西。

**工具庫。** MCP 伺服器（stdio 與 streamable HTTP）寫進 `mcp.json`，設定 `exposure: "direct"`（直接提供給模型），秘密值放在變數裡（`${HARNESS_RELAY_MCP_<n>_<kind>_<m>}`），以 `-e builtin:mcp` 載入。實際只測過 stdio 伺服器。

**沙箱需要什麼。** 不需要任何額外開放：Pi 的網路走 undici 的 `EnvHttpProxyAgent`，會讀沙箱設定的 proxy 變數（不需要 `NODE_USE_ENV_PROXY`），而沙箱會縮小 `NO_PROXY`，所以本機或區網的端點也經過 proxy。它不需要自己的 loopback 埠、PTY、Unix socket 或 macOS 的 trustd；也沒有需要默默拒絕的主機，因為 Pi 會自己去抓的東西都已關掉。已在 macOS 上以可編輯與唯讀模式、每個模型來源實際驗證：寫到允許範圍以外、Harness Relay 的資料庫與埠、它自己的設定檔，以及其他主機（會詢問）都被擋下。

**限制。** 沒有計畫或待辦清單；HTTP 的 MCP 伺服器沒有實際測過；`find` 需要 fd、`grep` 需要 ripgrep；Pi 自己的 skill 永遠不會載入（只有工具庫的，透過角色說明）；指示檔只能一次全部略過；gate 檔案必須和 `pi.ts` 放在一起（打包伺服器時需要一併複製）。
