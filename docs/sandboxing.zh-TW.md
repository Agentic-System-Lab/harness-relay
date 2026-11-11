[English](sandboxing.md) | **繁體中文**

# 各平台的作業系統沙箱

Harness Relay 本身不做任何沙箱：它啟動真正的 `claude`、`codex`、`grok` 和 `cursor-agent` CLI，沙箱由各 CLI 自己提供，或者沒有（Cursor 在 Harness Relay 的執行中沒有提供）。這一頁說明 Harness Relay 目前哪些執行用了沙箱、各沙箱能在哪些平台上運作、在那裡需要什麼前提、無法啟動時會怎樣，以及它管不到哪些事。

於 2026 年 11 月 10 日確認，Cursor 則於 2026 年 11 月 11 日確認。實際試過什麼、在哪些系統上、用哪些版本，見[已測試的範圍](#已測試的範圍)：一台 Mac（macOS 26.6）與一台 NVIDIA DGX Spark（Ubuntu 24.04，aarch64）；Cursor 只在 Mac 上試過。其他內容，包括所有 Windows 與 WSL 的部分，都來自各 CLI 自己的文件（見[資料來源](#資料來源)）。這些 CLI 變動很快，要依賴某個細節之前請再確認一次。

## 已測試的範圍

在兩台機器上、於 2026 年 11 月 10 日，透過 Harness Relay 自己的 adapter 執行真正的 CLI（各在一個暫存的 git 資料夾中；檢查它們的回覆、工具列與檔案），另外還有單元測試（`npm test`，兩台都通過）：

| | Mac | NVIDIA DGX Spark |
| --- | --- | --- |
| 系統 | macOS 26.6.2，arm64 | Ubuntu 24.04.5 LTS，aarch64，kernel 7.0.0-1019-nvidia（AppArmor 限制 unprivileged user namespace） |
| 沙箱 | Seatbelt | bubblewrap 0.9.0 與 socat 1.8.0，加上[在 Linux 上](#在-linux-上)中給 `/usr/bin/bwrap` 的 AppArmor 設定檔（沒有它時，三者都拒絕在沙箱中執行） |
| CLI | Claude Code 2.1.322、Codex 0.167.0、Grok 1.0.77；Cursor（`cursor-agent`）2026.11.11-043ef28，11 月 11 日 | Claude Code 2.1.321、Codex 0.167.0、Grok 1.0.77；Cursor 沒有試過 |
| git | 2.50.1 | 2.43.0 |

每個 CLI 在唯讀與可編輯模式下、在兩台機器上被要求做的事：寫入工作目錄、寫入家目錄、連到 example.com、列出某個瀏覽器的資料夾、用 shell 讀取 `data/relay.db`（Claude Code 與 Grok 也用它們自己的檔案工具讀）。除了離開沙箱與連到主機以外，核准請求都允許。

| | Mac | DGX Spark |
| --- | --- | --- |
| Claude Code | 寫入工作目錄（唯讀模式下允許之後）；家目錄以沙箱外執行的形式詢問，沒有寫入；example.com 會詢問，之後被擋；Firefox 的資料夾與資料庫被拒絕（`Operation not permitted`），它的 Read 工具也被拒絕，含空格的路徑也一樣 | 相同；Chrome 的資料夾顯示為空（bubblewrap 蓋住了它），資料庫被拒絕（`Permission denied`） |
| Codex | 只在可編輯模式寫入工作目錄；家目錄與 example.com 被拒絕；Firefox 的資料夾與資料庫被拒絕 | 它的設定檔無法載入（見上文）：使用舊的沙箱；只在可編輯模式寫入工作目錄，家目錄與 example.com 被拒絕，但讀得到 Chrome 的資料夾與資料庫；它在工作目錄與 `/tmp` 留下空的 `.agents`、`.aws`、`.codex` 資料夾，原本沒有 `.git` 的地方也留下空的 `.git`（空的 `.git` 對 git 與 Grok 來說都不是儲存庫） |
| Grok | 寫入工作目錄；家目錄被拒絕；連得到 example.com（macOS）；Firefox 的資料夾與資料庫被拒絕，它的檔案工具也被拒絕；`~/.grok/downloads` 與 `~/.grok/bin` 被拒絕；在 `~/.grok/config.toml` 後面附加內容被 Grok 拒絕 | 寫入工作目錄；家目錄被拒絕；連得到 example.com；Chrome 的資料夾與資料庫被拒絕（`Permission denied`）；寫得到 `~/.grok/downloads`（在 Linux 上改為每一輪前後檢查它的程式） |

另外試過：Grok 的指令寫得到 `.git/config`（`git config core.fsmonitor …`，兩台都是），而 Harness Relay 自己的 git 不會執行它；在 Mac 上，Claude Code 與 Codex 的沙箱擋下 `127.0.0.1`，Grok 的則連得到，而 Harness Relay 的 API 對沒有登入的程式回應 401。沒有試過：原生 Windows、WSL、容器、其他 Linux 發行版、其他版本的 CLI。

**Cursor** 是隔天才加入的，只在 Mac（arm64）上以 `cursor-agent` 2026.11.11-043ef28 確認：讀過它 ACP 伺服器與權限層的程式碼，並透過 Harness Relay 的轉接器實際執行。它的 ACP 模式不論 `--sandbox` 或 `sandbox.mode` 怎麼設，都沒有套用沙箱，所以它要執行的每個 shell 指令都送到 Harness Relay 詢問。從程式碼看，它的 ACP 模式在任何平台上都不套用沙箱；Linux 與 Windows 沒有用真正的 CLI 試過。

這些執行是從原始碼啟動的，跟 `npm start` 執行伺服器的方式一樣。[桌面 app](user-guide.zh-TW.md#桌面-app) 執行的是同一個伺服器，用同樣的轉接器與同樣的沙箱設定，只是使用它自己的資料夾；上面的執行沒有在它底下重做。在 macOS 上，你給桌面 app 的隱私權限（例如「文件」等資料夾、麥克風）也會給到它執行的 agent，因為 agent 在它裡面執行；用 `npm start` 時則是終端機的權限。

## 什麼是作業系統沙箱

作業系統沙箱是作業系統核心套在一個行程及它啟動的所有行程上的限制：可以寫入（有時也包括讀取）哪些檔案、能不能使用網路。macOS 用的是 Seatbelt（`/usr/bin/sandbox-exec`）；Linux 有 Landlock、seccomp 與 bubblewrap（使用 user namespace）。

它和核准作用在不同的時間點：

- **核准**在指令執行*之前*，依指令的文字決定。指令一旦放行，就不再檢查它做了什麼。
- **沙箱**在指令執行*當中*生效。超出限制的寫入或連線會失敗（寫入通常是 `Operation not permitted`），即使是 agent 寫的程式碼、再由測試執行也一樣。

這就是為什麼在可編輯模式下沙箱同樣重要：測試與建置執行的是 agent 剛剛可能改過的程式碼；使用 Grok 時，這些程式碼仍能連網；Cursor 則完全沒有沙箱，只能靠詢問把關（見[架構 → 權限對應](architecture.zh-TW.md#權限對應)）。

## Harness Relay 目前的執行用了什麼

| Relay 權限 | Claude Code | Codex | Grok | Cursor |
| --- | --- | --- | --- | --- |
| 唯讀 | 它的沙箱：寫入限於工作目錄與暫存資料夾，每個主機都會詢問 | 由 `:read-only` 延伸的設定檔 `harness-relay-…` | 由 `workspace` 延伸的設定檔 `harness-relay`，可以連網 | 沒有沙箱：每個指令都要詢問（Cursor 團隊允許清單上的除外）；拒絕規則讓它自己的讀取與寫入工具碰不到受保護的路徑（照寫下來的路徑，見下文），寫入工具也不能寫入或刪除 |
| 可編輯 | 它的沙箱：寫入限於工作目錄與暫存資料夾，每個主機都會詢問 | 由 `:workspace` 延伸的設定檔 `harness-relay-…`，關閉網路 | 由 `workspace` 延伸的設定檔 `harness-relay`，可以連網 | 沒有沙箱：每個指令都要詢問（Cursor 團隊允許清單上的除外），Cursor 詢問的每個寫入也一樣；拒絕規則讓它自己的讀取與寫入工具碰不到受保護的路徑（照寫下來的路徑，見下文） |
| 完全存取 | 沒有沙箱 | 沒有（`danger-full-access`） | 沒有 | 沒有（`--force`） |

- **Claude Code** 的沙箱涵蓋它的 Bash 工具（`sandbox` 設定）。在完全存取以外的權限，Harness Relay 會在這一輪的 `--settings` 中開啟它，並設定 `failIfUnavailable`（沒有沙箱就不執行）、`autoAllowBashIfSandboxed: false`（哪些操作不必詢問仍由權限決定），以及詢問規則 `Bash(dangerouslyDisableSandbox:true)`（模型要在沙箱外執行的每個指令都會詢問）；在 Claude Code 沒有沙箱的原生 Windows 上，則不使用沙箱執行。在 Mac 上兩種模式都試過：在工作目錄中寫入可以（唯讀模式下要先允許）；寫入家目錄會先詢問並註明會在沙箱外執行，拒絕後就失敗；連到 example.com 會先詢問，拒絕後就被擋下。
- **Codex** 在完全存取以外的權限，每個指令都在沙箱中執行，使用的是 Harness Relay 在 thread 的設定中定義的權限設定檔（`harness-relay-` 加上每次執行都不同的隨機部分，由 `:read-only` 或 `:workspace` 延伸），並在 thread 中指名它（`permissions`，它選擇使用的實驗性欄位）；這會勝過你設定中的 `sandbox_mode`。Codex 沒有回報它套用了這個設定檔時（舊版 Codex 會忽略這個欄位），這次執行會失敗。在原生 Windows 上則和以前一樣使用舊的沙箱模式。在 Mac 上以 `workspace-write` 試過：在工作目錄中寫入可以；寫入家目錄或 `~/.npm`、連到 github.com 都被拒絕；讀取家目錄可以。
- **Grok** 在唯讀與可編輯模式下使用它的自訂設定檔 `harness-relay`：Grok 的 `workspace` 加上下文的路徑。唯讀模式不使用它的 `read-only` 設定檔，因為後者在某些機器上無法啟動：在裝了 OrbStack 的 Mac 上，`/var/run/docker.sock` 是 symlink，Grok 會以 `could not apply the 'read-only' sandbox profile … Refusing to start with its protections missing` 停止。在 Mac 上兩種模式都試過：在工作目錄中寫入可以，寫入家目錄會以 `Operation not permitted` 失敗，也連得到 example.com，因為 `workspace` 允許連網（`~/.grok/sessions/sandbox-events.jsonl` 中為 `"restrict_network": false`，並有 `"enforced": true`）。這些是在 `harness-relay` 之前以 `workspace` 試的；`harness-relay` 也確實套用了（`"enforced": true`，並有它的 `deny_paths`）。Harness Relay 只在完全存取以外的權限設定設定檔（`GROK_SANDBOX`），所以完全存取時，Grok 自己 `config.toml` 中的 `[sandbox] profile`，或啟動伺服器時的 `GROK_SANDBOX`，仍會生效。
- **Cursor** 透過 ACP（`cursor-agent acp`）執行，它的權限層從不套用 Cursor 的沙箱，不論它設定中的 `--sandbox` 或 `sandbox.mode` 怎麼寫，在任何平台上都一樣。所以 Harness Relay 只能靠核准管住它的指令：在完全存取以外的權限，沒有任何指令能不經詢問就執行（Cursor 團隊自動執行允許清單上的除外，見[沙箱管不到的事](#沙箱管不到的事)），包括測試與建置；使用者允許的指令則在任何沙箱之外，以使用者的完整權限執行，包括連網。它自己的工具能讀取任何位置（下文受保護的路徑除外，以它的拒絕規則擋得住的為限），可編輯模式下也不經詢問就修改工作目錄內的檔案，但 Cursor 受保護的檔案（`.git/hooks/**`、`.git/config`、`.vscode/**`、`.claude/*.json`、`.cursor/*.json`、`*.code-workspace`……）除外：寫入這些檔案時 Cursor 會詢問，而 Harness Relay 會把 Cursor 詢問的每個寫入交給使用者（或拒絕），因為這種寫入可能讓程式碼之後在任何沙箱之外執行。Cursor 每次刪除都會詢問；可編輯模式會核准工作目錄內的刪除。唯讀模式下，它的寫入工具既不能寫入也不能刪除（`Write(**)`，Cursor 在詢問之前就會檢查）。讀網頁與網路搜尋直接執行，subagent 的也是。每一輪的私有設定資料夾沒有允許規則，所以你自己的 Cursor 允許規則和專案的 `.cursor/cli.json`（不會讀取：`--disable-project-configs`）都無法讓指令通過（見[架構 → 權限對應](architecture.zh-TW.md#權限對應)）。

## agent 不能讀寫的地方

在完全存取以外的權限，Harness Relay 會讓每個 agent 的沙箱（Cursor 沒有沙箱，所以是它自己的讀取與寫入工具，以它的拒絕規則擋得住的為限：見下文）碰不到這些地方（`src/server/protect.ts`），在 macOS 與 Linux 上：

- **瀏覽器自己的資料夾**：已登入的瀏覽器把送給 Harness Relay 的金鑰（有些瀏覽器還有 cookie）存放在磁碟上的位置：Chrome、Chromium、Edge、Brave、Arc、Vivaldi、Opera、Firefox、LibreWolf、Zen、Orion、Floorp、Waterfox、Helium、DuckDuckGo 與 GNOME Web，以及 Safari 與 WebKit 的資料夾（macOS 上的 `~/Library/…`；Linux 上的 `~/.config/…` 與 `$XDG_CONFIG_HOME/…`、`~/.mozilla`、snap 與 Flatpak 資料夾）。只列出實際存在的，每個也連同它的真實路徑。
- **桌面 app 視窗自己的資料夾**（app 資料夾裡的 `browser/`：macOS 是 `~/Library/Application Support/Harness Relay/browser`，Linux 是 `~/.config/Harness Relay/browser`），它的視窗把 cookie 與金鑰放在這裡；app 以 `RELAY_APP_BROWSER_DIR` 告訴伺服器。
- **Harness Relay 的資料庫**（`relay.db` 與 SQLite 放在它旁邊的檔案，在 `data/` 裡；桌面 app 則在它自己資料夾的 `data` 裡），即使工作目錄包含它也一樣。
- **Harness Relay 自己的暫存資料夾**（`data/tmp`，桌面 app 則是它資料夾裡的 `data/tmp`），Claude Code 一輪的 `--settings` 與 MCP 設定放在這裡等它讀取，Cursor 每一輪的設定資料夾也在這裡。若放在每個沙箱都讓指令寫入的系統暫存資料夾，另一個 agent 的指令就能在 Claude Code 讀取前改掉它們（關掉它的沙箱，或把自己的指令當成 MCP 伺服器，在任何沙箱之外啟動），或讀到 MCP 伺服器的秘密值。

各 CLI 的做法：

- **Claude Code**：`sandbox.filesystem.denyRead` 與 `denyWrite`，以及給它自己的檔案工具（在它的沙箱之外）的 `Read` 拒絕規則。這一輪的 `--settings` 也設定 `filesystem.disabled: false`，勝過關閉檔案隔離的使用者設定。`allowRead`／`allowWrite` 清單會跨設定檔相加，所以當你自己的 Claude Code 設定（它資料夾中的 `settings.json`）或電腦上的受管理設定（`managed-settings.json` 與 `managed-settings.d`）允許的路徑碰到受保護的路徑時，執行不會開始，相對路徑的項目從該設定檔所在的資料夾算起；訊息會指出要移除的項目。（Claude Code 本身（2.1.322）會忽略專案設定中、會打開這一輪 `--settings` 所禁止路徑的 `allowRead` 項目。）
- **Codex**：thread 的 `harness-relay-…` 權限設定檔中，每個路徑一個 `deny` 項目（Windows 除外，它舊的沙箱無法在任何地方禁止讀取）。它的名稱每次執行都不同：Codex 會把它其他設定檔（例如已信任專案的 `.codex/config.toml`）中同名的設定檔合併進來，而那裡更具體的項目（對被禁止的資料夾內的某個資料夾設 `read`）會讓這個路徑重新可讀（用 `codex sandbox` 試過）。DGX Spark 上的 Codex 0.167 無法使用自訂的設定檔：thread 可以開始，但每一輪送出請求時都會失敗（`failed to load workspace requirements: invalid input parameter`；Codex 內建的 `:workspace` 則可以）。遇到這種情況的執行會改用 Codex 舊的沙箱模式重跑，並在伺服器這次執行期間都這樣做：寫入與網路的限制和以前一樣，但沒有禁止清單，所以在那裡 Codex 的指令讀得到瀏覽器的資料夾與資料庫（它們仍然連不到網路，包括 Harness Relay 的 API）。
- **Grok**：它的自訂設定檔 `harness-relay` 的 `deny` 清單。Harness Relay 在每次執行前把它寫進 Grok 自己資料夾（`~/.grok`，或各 CLI 自己的資料夾中的 `grok`）的 `sandbox.toml`，放在 `# >>> harness-relay` 與 `# <<< harness-relay` 之間，檔案的其餘部分保持原樣。Grok 無法套用自訂設定檔時會拒絕啟動；在 Linux 上，它的 `deny` 清單需要 bubblewrap。Grok 的 `workspace` 讓它的指令能寫入整個 Grok 資料夾，而它自己的程式就在那裡（`downloads`、`bin`）：清單也禁止這些，以及 Harness Relay 啟動的程式所在的資料夾。Grok 在沙箱套用後才讀取那裡的設定（Harness Relay 區塊以外的 `sandbox.toml`、`config.toml`、`managed_config.toml`、`requirements.toml`、`trusted_folders.toml`、`permission.toml`、`hooks-paths`），所以無法禁止：Harness Relay 會在每一輪前讀取它們（連結就當作連結；空檔案視同沒有，因為它們不存在時 Grok 的沙箱會建立空的檔案），這一輪改動了其中之一時，就把改動後的版本移到旁邊（`….changed-<時間>`，以改名的方式，不跟著連結走）、把它改回原樣，並讓這一輪失敗並說明；`skills` 資料夾被改動時同樣會回報，但不會改回。同時執行的 Grok 各輪共用第一輪開始前的設定，後開始的一輪會先把另一輪的指令改動的地方改回。在這樣的一輪中，Grok 自己或你對這些檔案做的改動，也會同樣被改回。在這樣的一輪中於 Harness Relay 信任資料夾時，會先把這一輪的指令改動的地方改回，再把信任記錄到這一輪開始時的信任紀錄中，這一輪會保留它。（Grok 設定檔的 `read_only` 是授予讀取，並不會禁止寫入。）在 Linux 上，Grok 會透過 bubblewrap 再執行一次自己的程式來啟動沙箱，所以被禁止的程式根本無法啟動（試過）：在那裡它的程式不禁止，改為檢查：`~/.grok/bin` 中的連結與程式檔案，並在 `data/tmp` 保留一份副本；被改動時，會在另一個沙箱中的一輪啟動它之前、以及每一輪之後，從副本改回原樣，並讓那一輪失敗。
- **Cursor**：這一輪自己的 `cli-config.json` 中的拒絕規則，每個路徑都有 `Read(<路徑>)`、`Read(<路徑>/**)`、`Write(<路徑>)` 與 `Write(<路徑>/**)`（路徑本身，給資料庫的檔案用，以及它底下的一切），和你在帳號的 `cli-config.json` 中自己的拒絕規則放在一起。它們只約束 Cursor 自己的讀取與寫入工具，而 Cursor 是拿寫下來的路徑去比對，分大小寫，也不解析連結：受保護路徑的另一種寫法（換個大小寫，在 macOS 一般不分大小寫的磁碟上）或專案裡指向它的連結都不會被拒絕，它的讀取工具不經詢問就能讀。它的 shell 指令沒有沙箱，所以只能靠詢問擋在這些路徑之外：使用者允許的指令（或 Cursor 團隊允許清單上的指令）讀寫得到它們。

在 Mac 上以可編輯模式對 Claude Code、Codex 與 Grok 都試過：用 shell 列出 `~/Library/Application Support/Firefox`、讀取 `data/relay.db` 都以 `Operation not permitted` 失敗，用 Claude Code 的 Read 工具或 Grok 的檔案工具讀取資料庫會被拒絕，而在工作目錄中寫入可以。Claude Code 的 Read 工具讀取 Firefox 資料夾中的檔案（含空格的路徑）也會被拒絕。Grok 的指令無法寫入 `~/.grok/downloads`，也無法改名 `~/.grok/bin`（在這之前可以），在 `~/.grok/config.toml` 後面附加內容則被 Grok 自己拒絕；它的 sessions 仍可寫入。

它涵蓋不到的：無法使用自訂設定檔的 Codex（見上文）；沒有沙箱的 Cursor 指令，以及它的 hook 與 MCP 伺服器；拿到受保護路徑另一種寫法或指向它的連結的 Cursor 讀取與寫入工具；資料夾不在清單上的瀏覽器（新的、可攜版，或用 `--user-data-dir` 放在別處的 Chrome）；使用者允許在沙箱外執行的指令；CLI 在沙箱外執行的東西，例如 Claude Code 的 hooks 與本機 MCP 伺服器（見[沙箱管不到的事](#沙箱管不到的事)）；專案自己的 Claude Code 設定（`.claude/settings.json`、`.claude/settings.local.json`），可編輯模式下其他 agent 能寫入它們，而下一輪 Claude Code 會採用其中的 hooks、`sandbox.excludedCommands` 與 `network.allowUnixSockets`；Grok 在它資料夾中自己維護的 plugin 資料夾（`marketplace-cache`、`installed-plugins`、`bundles`、`bundled`），它的指令能為之後完全存取的執行改動它們；某個指令在它那一輪結束後還留著執行的行程對 Grok 設定所做的改動，下一輪會照它看到的樣子接受；完全存取；原生 Windows。名稱含 `*`、`?` 或 `[` 的受保護路徑，沙箱會把它當成樣式，因此完全存取以外的執行會拒絕開始，並指出是哪一個。

工作目錄包含 Harness Relay 本身（它的資料夾或資料資料夾；平行模式的 worktree 位於資料資料夾內，不受影響），或決定 agent 怎麼執行的地方時，也會拒絕可編輯模式：你的家目錄（裡面的專案不受影響）、CLI 自己的資料夾（`~/.claude`、`~/.claude.json`、`~/.codex`、`~/.grok`、`~/.cursor`，或它們的環境變數指定的位置——Cursor 的設定放在 `$XDG_CONFIG_HOME/cursor` 時也包括那裡；即使如此，`~/.cursor` 仍會被拒絕；不論它的設定在哪裡，Cursor 在 Linux 上保存登入的 `$XDG_CONFIG_HOME/cursor`（沒有設定時是 `~/.config/cursor`）也會被拒絕）、Harness Relay 給各 CLI 的資料夾，或 CLI 程式所在的資料夾；包含它或位於它之內都算。agent 在那裡不經詢問就能修改檔案，也就能改動 Harness Relay 的程式碼、CLI 的設定或程式，或你的 shell 設定。對話在建立、排程或改成這樣時會被拒絕（在建立不存在的資料夾之前），每一輪開始時也會。唯讀模式在那裡仍可使用，因為它寫入前會詢問（Codex 則完全不能寫）。要開發 Harness Relay 本身，請從另一個資料夾執行你使用的那份 Harness Relay。

## 各平台

| | macOS | Linux | Windows | WSL2 |
| --- | --- | --- | --- | --- |
| **Codex** | ✅ Seatbelt | ✅ bubblewrap + seccomp | ✅ 自己的沙箱（見下文） | ✅ Linux 的沙箱 |
| **Claude Code** | ✅ Seatbelt | ✅ bubblewrap + socat | ❌ 指令在沙箱外執行 | ✅ Linux 的沙箱 |
| **Grok** | ⚠️ Seatbelt，但擋不了網路 | ✅ Landlock + seccomp，Harness Relay 的執行還要 bubblewrap | ❌ 文件中沒有列出 | 未驗證 |
| **Cursor** | ❌ ACP 模式下沒有 | ❌ ACP 模式下沒有（沒有試過） | ❌ ACP 模式下沒有（沒有試過） | ❌ ACP 模式下沒有（沒有試過） |

Harness Relay 本身在這三種平台上都能執行，所以在原生 Windows 上只有 Codex 有沙箱。在 Harness Relay 的執行中，Cursor 在哪個平台上都沒有沙箱。

### macOS

- Claude Code、Codex 與 Grok 都使用 macOS 內建的 Seatbelt，不需要另外安裝。
- **Cursor** 在 Harness Relay 的執行中不套用沙箱（以 `cursor-agent` 2026.11.11 試過）：在完全存取以外的權限，它執行的每個指令都要詢問（Cursor 團隊允許清單上的除外），使用者允許的指令則以使用者的完整權限執行，包括連網。
- **Grok 在 macOS 上擋不了網路。** 它的文件說，封鎖它所執行指令的網路只在 Linux 上（透過 seccomp）生效，在 macOS 上沒有作用，所有設定檔都一樣，`read-only` 和 `strict` 也不例外。在任何平台上，Grok 自己做的事（網路搜尋、讀網頁、模型的 API）都不會被擋。
- runtime socket 是 symlink 時，Grok 的 `read-only` 與 `strict` 設定檔可能無法啟動（見上文；兩者都試過）。
- Claude Code 的文件列出在它的 Seatbelt 沙箱中會失敗的事：`gh`、`gcloud` 和 `terraform` 的 TLS 驗證可能會失敗；`open`、`osascript` 和在瀏覽器中登入會被擋（Apple Events）；走 SSH 的 git 會失敗（它經由沙箱 proxy 的通道在 macOS 上無法驗證身分）；指令要監聽或連到 localhost 的 port，必須設定 `network.allowLocalBinding`。

### Linux

- **Claude Code** 需要 `bubblewrap` 與 `socat`（`sudo apt-get install bubblewrap socat`，或 `sudo dnf install bubblewrap socat`）。要連 Unix socket 也一起擋，需要 `npm install -g @anthropic-ai/sandbox-runtime` 提供的 seccomp 過濾器。每個指令都有自己的 localhost，所以連不到這台電腦 localhost 上的伺服器。
- **Codex** 使用 bubblewrap 與 seccomp。它採用 `PATH` 上第一個（工作目錄以外的）`bwrap`，找不到就改用它自己附帶的，並在啟動時顯示警告。它舊的 Landlock 程式碼（`features.use_legacy_landlock`）在限制檔案的政策下會被拒絕。
- **Grok** 使用 Landlock，需要 kernel 5.13 以上。kernel 6.2（Landlock ABI 3）以前（Ubuntu 22.04 與 Debian 12 預設的 kernel 都更舊），指令仍能用 `truncate` 截短可寫入路徑以外的檔案。有 `deny` 清單的自訂設定檔也需要 bubblewrap，所以 Harness Relay 在完全存取以外的執行都需要（它們的清單一定有它的資料庫）。它的文件也說，`workspace`、`read-only` 與 `strict` 在 Linux 上「without verified read-only mounts」時會拒絕啟動（這些掛載讓 Grok 自己的設定與 hook 無法被寫入）。網路封鎖（`restrict_network`）使用 seccomp，在 Linux 上有效。
- bubblewrap 需要 unprivileged user namespace。Ubuntu 從 23.10 起用 AppArmor 限制它，這可能讓 bubblewrap 無法運作；Claude Code 的文件說，這時要為 `/usr/bin/bwrap` 加上 AppArmor 設定檔，其他位置的 `bwrap` 則用 `sysctl` 解除限制。
- **Cursor** 在這裡什麼都不需要，因為它的 ACP 模式在 Linux 上也不套用沙箱（從它的程式碼看；沒有在 Linux 上試過）。它的指令只靠詢問把關。

### Docker 與 dev container

容器常讓 bubblewrap 無法運作：它們可能封鎖 bubblewrap 需要的 user namespace，或不允許掛載新的 `/proc`。

- **Claude Code**：`sandbox.enableWeakerNestedSandbox: true` 讓它能在 unprivileged 容器中運作（沿用容器既有的 `/proc`），但隔離較弱。
- **Codex** 在 bubblewrap 無法建立 user namespace 時，會在啟動時顯示警告。它的文件建議讓容器提供 bubblewrap 需要的條件，或在容器中以 `--sandbox danger-full-access` 執行 `codex`，讓容器本身當作沙箱。
- **Grok**：Landlock 本身不需要 user namespace，但 `deny` 清單需要 bubblewrap，內建設定檔的唯讀掛載（見上方 Linux）可能也需要 mount namespace（未驗證）。沒有在容器中試過。
- **Cursor** 沒有會被容器弄壞的沙箱：在那裡，容器本身就是它的指令唯一的隔離（沒有試過）。

### Windows

- **Codex** 有自己的沙箱，分成三種實作（`config.toml` 中的 `[windows] sandbox = "…"`）：
  - `mxc`，它的文件推薦的一種：不需要管理員設定，也不必建立額外的帳號或防火牆規則。需要 Windows 11 24H2（build 26100.9278）或 25H2（build 26200.9278）以上。指令可以連到 loopback 上的服務；指令結束時，它留下的行程也會跟著結束（所以在背景啟動的 dev server 會一起停掉）。
  - `elevated`，`mxc` 無法使用時它的文件優先建議的舊式備案：由管理員設定一次（UAC 提示、建立本機使用者與群組、防火牆規則、這些使用者的登入權限）；之後指令以這些權限較低的使用者執行，不需管理員權限。IT 可以事先從有管理員權限的行程執行 `codex sandbox setup --elevated`。
  - `unelevated`，第二個舊式備案：從你的帳號衍生出受限的 token，以檔案權限作為邊界，用在無法做 elevated 設定的時候。網路隔離較弱，也無法禁止讀取某個路徑。
  - 建議使用 Windows 11；Windows 10 只是盡量支援，且需要 1809 以上。記錄檔在 `CODEX_HOME/.sandbox/sandbox.log`。
- **Claude Code** 在原生 Windows 上沒有沙箱：指令在沙箱外執行。請改用 WSL2。
- **Grok**：它的文件只列出 macOS 與 Linux。Grok 在 Windows 上是會在沒有沙箱的情況下執行（它的文件說無法套用的內建設定檔只會顯示警告，見下文），還是拒絕啟動，沒有驗證過。
- **Cursor** 在這裡也沒有沙箱。Harness Relay 在 Windows 上沒有受保護的路徑，所以在那裡它的讀取與寫入工具也沒有針對它們的拒絕規則（沒有用真正的 CLI 試過）。

### WSL

- **WSL2**：Codex 與 Claude Code 使用它們的 Linux 沙箱，前提相同（bubblewrap；Claude Code 還需要 `socat`）。Grok 的 Landlock 能不能用，要看 WSL2 的 kernel（未驗證）。Cursor 在這裡也沒有沙箱。
- **WSL1** 無法建立 user namespace。Claude Code 的沙箱需要 WSL2；Codex（從 0.115 起）會拒絕執行需要 bubblewrap 的沙箱指令。

## 開啟各個沙箱

以下依平台列出開啟各 CLI 沙箱的指令與設定，以及確認它已開啟的方法。這些是給你自己使用各 CLI 時用的；[下一個表格](#harness-relay-的執行從哪裡讀這些設定)說明 Harness Relay 的執行會採用其中哪些。Linux 的指令使用 `apt-get`（Debian、Ubuntu），旁邊附上 `dnf`（Fedora）。

| | macOS | Linux | Windows | WSL2 | 容器 |
| --- | --- | --- | --- | --- | --- |
| **Claude Code** | 只需設定 | 先裝 `bubblewrap` 與 `socat`，再設定 | 沒有沙箱：改用 WSL2 | 同 Linux | 同 Linux，再加 `enableWeakerNestedSandbox` |
| **Codex** | 只需設定 | 設定（建議安裝 `bubblewrap`） | `[windows] sandbox` | 同 Linux | 讓容器提供 bubblewrap 需要的條件，或讓容器本身當作沙箱 |
| **Grok** | 只需設定 | kernel 5.13 以上且有 Landlock，Harness Relay 的執行還要 `bubblewrap`，再設定 | 文件中沒有：改用 WSL2 | 同 Linux，前提是它的 kernel 有 Landlock（未驗證） | 沒有試過 |
| **Cursor** | 沒有可開啟的：它的 ACP 模式會忽略 `--sandbox` 與 `sandbox.mode` | 同左（沒有試過） | 同左（沒有試過） | 同左（沒有試過） | 同左（沒有試過） |

### Harness Relay 的執行從哪裡讀這些設定

| | Harness Relay 的執行會讀的設定 | Harness Relay 自己設定的部分 |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json`，或[各 CLI 自己的資料夾](user-guide.zh-TW.md#agent-的-session各-cli-自己的資料夾與-agentsview)中的 `claude/settings.json`；專案的 `.claude/settings.json` 與 `.claude/settings.local.json`；managed settings | 完全存取以外的權限（原生 Windows 除外）設定 `sandbox.enabled`、`failIfUnavailable`、`autoAllowBashIfSandboxed: false`、上述的詢問規則與受保護的路徑（`denyRead`、`denyWrite`、`Read` 拒絕規則，見下文）；你其他的 `sandbox` 鍵，例如 `network.allowedDomains`，會照原樣保留（沒有試過） |
| Codex | `~/.codex/config.toml`，或各 CLI 自己的資料夾中的 `codex/config.toml` | 完全存取以外的權限，thread 使用 `harness-relay-…` 權限設定檔（所以你的 `sandbox_mode` 與 `[sandbox_workspace_write]` 不會被採用）；在 Windows 上依權限設定沙箱模式，可編輯模式再加上 `network_access = false`；其他鍵不會設定，例如 `[windows] sandbox` |
| Grok | 啟動 Harness Relay 時環境中的 `GROK_SANDBOX`；沒有的話，是 `~/.grok/config.toml`，或各 CLI 自己的資料夾中 `grok/config.toml` 的 `[sandbox] profile` | 唯讀與可編輯模式設定 `GROK_SANDBOX=harness-relay`（Windows 上為 `workspace`），以及 Grok 自己資料夾中 `sandbox.toml` 的 `[profiles.harness-relay]` 區塊（見下文）；完全存取時，你設定的會生效 |
| Cursor | 它設定資料夾中的 `cli-config.json`（`~/.cursor`、各 CLI 自己的資料夾中的 `cursor`，或其他帳號的家目錄），複製到每一輪自己的設定資料夾；絕不讀專案的 `.cursor/cli.json`（`--disable-project-configs`） | 在每一輪的設定資料夾中：沒有允許規則，你的拒絕規則再加上（完全存取以外的權限）受保護的路徑（唯讀模式還有 `Write(**)`），`approvalMode: "allowlist"`（完全存取：`"unrestricted"`，並加 `--force`）；`sandbox.mode` 透過 ACP 沒有作用 |

Grok 會讓一個 session 在整個生命週期都使用它開始時的設定檔，並拒絕以不同的設定檔續用它（它的文件）。Harness Relay 每一輪都會續用各 agent 的 session，續用失敗時會帶著目前為止的對話開始新的 session。唯讀與可編輯使用同一個設定檔，所以只有切換到完全存取或從完全存取切回來，或改變你設定的設定檔，才會這樣（`harness-relay` 之前的 Grok session 也會重新開始一次）。

### 在 macOS 上

它們都不需要另外安裝。

**Claude Code。** 在 `~/.claude/settings.json` 中：

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "network": {
      "allowedDomains": ["github.com", "*.npmjs.org"],
      "allowLocalBinding": true
    }
  }
}
```

- `failIfUnavailable` 讓 Claude Code 在沙箱無法使用時於啟動時停止，而不是在沙箱外執行指令；`allowUnsandboxedCommands: false` 拿掉在沙箱外重試的出口。
- `network.allowedDomains` 列出指令可以連到的主機；其他主機會被詢問或拒絕（見[核准能做的事](#沙箱管不到的事)）。`network.allowLocalBinding` 讓指令能監聽及連到 localhost 的 port，給 dev server 與測試使用。
- 只用於一個 session：`claude --settings '{"sandbox": {"enabled": true, "allowUnsandboxedCommands": false}}'`。在 session 中，`/sandbox` 會顯示並修改它，並把修改存到專案的 `.claude/settings.local.json`。
- 要確認時，請 Claude（不是用 `!` 提示）執行 `touch ~/sandbox-probe`，應該以 `Operation not permitted` 失敗；以及 `curl --noproxy '*' https://example.com`，應該以 `Could not resolve host` 失敗；若它要求在沙箱外重試，請拒絕。

**Codex。**

```sh
codex --sandbox workspace-write    # 這個 session：read-only、workspace-write 或 danger-full-access
codex sandbox --permission-profile :workspace -- touch ~/sandbox-probe    # 確認：Operation not permitted
```

在 `~/.codex/config.toml` 中：

```toml
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
network_access = false
writable_roots = ["/absolute/path/to/another/folder"]
```

- `codex sandbox` 以某個內建設定檔的沙箱執行一個指令：`:read-only`、`:workspace` 或 `:danger-full-access`。0.167 不接受平台名稱；Codex 的文件仍寫成 `codex sandbox macos …`（試過：0.167 會把 `macos` 當成要執行的指令）。

**Grok。**

```sh
grok --sandbox workspace    # 這個 session：workspace、read-only、strict、devbox 或自訂設定檔
GROK_SANDBOX=workspace grok    # 同上，從環境變數指定
tail -n 1 ~/.grok/sessions/sandbox-events.jsonl    # 確認："enforced": true
```

在 `~/.grok/config.toml` 中：

```toml
[sandbox]
profile = "workspace"
```

自訂設定檔放在 `~/.grok/sandbox.toml` 或專案的 `.grok/sandbox.toml`，以 `grok --sandbox project` 使用：

```toml
[profiles.project]
extends = "workspace"
read_only = ["/data"]
deny = ["~/.ssh", "**/.env", "**/*.pem"]
```

- `devbox` 是給用完即丟的機器用的：它幾乎到處都能寫入，包括家目錄。`restrict_network = true` 在 macOS 上沒有作用（見 [macOS](#macos)）。
- Harness Relay 在完全存取以外的權限已經讓 Grok 使用它自己由 `workspace` 延伸的設定檔 `harness-relay`；啟動它時的 `GROK_SANDBOX` 只會套用到完全存取的 Grok 執行。

**Cursor。** Harness Relay 的執行沒有可開啟的沙箱：它的 ACP 模式會忽略 `--sandbox` 與 `sandbox.mode`。在那裡管住它的指令的是詢問；不信任的程式碼，請使用唯讀，或把「超出權限的動作」設為自動拒絕。

### 在 Linux 上

先確認沙箱需要的條件（這些檢查不是出自各 CLI 的文件，也沒有試過）：

```sh
bwrap --ro-bind / / true && echo "bubblewrap works"    # Claude Code、Codex、Grok 的 deny 清單
uname -r    # Grok：5.13 以上（6.2 以上才擋得住 truncate）
cat /sys/kernel/security/lsm    # Grok：清單中要有 landlock
sysctl kernel.apparmor_restrict_unprivileged_userns    # Ubuntu 23.10 以後：1 = 受限
```

在 Ubuntu 23.10 以後 bubblewrap 無法運作時，Claude Code 的文件提供一個給 `/usr/bin/bwrap` 的 AppArmor 設定檔：

```sh
sudo tee /etc/apparmor.d/bwrap > /dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
sudo systemctl reload apparmor
```

它只涵蓋 `/usr/bin/bwrap`（見 `which bwrap`），不包括 Codex 自己附帶的那份。其他位置的 `bwrap`，可用 `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` 對所有程式解除限制，直到下次重新開機。

**Claude Code。**

```sh
sudo apt-get install bubblewrap socat    # Fedora：sudo dnf install bubblewrap socat
npm install -g @anthropic-ai/sandbox-runtime    # 選用：連 Unix socket 也一起擋
```

接著使用和 macOS 相同的 `settings.json`；`allowLocalBinding` 在 Linux 上沒有作用。安裝後請重新啟動 Claude Code，因為它在啟動時檢查。確認方式和 macOS 相同的兩個指令：這裡 `touch ~/sandbox-probe` 會以 `Read-only file system` 失敗；`/sandbox` 會顯示是否缺了什麼。

**Codex。**

```sh
sudo apt-get install bubblewrap    # Fedora：sudo dnf install bubblewrap
```

沒有安裝的話，Codex 會使用它自己附帶的 `bwrap`，並在啟動時顯示警告。接著使用和 macOS 相同的 `config.toml` 與指令（`codex sandbox` 只在 Mac 上試過）。

**Grok。** 通過上面的檢查後，使用和 macOS 相同的 `config.toml`、`--sandbox` 與 `GROK_SANDBOX`。在 Linux 上，自訂設定檔還能擋住 Grok 所執行指令的網路：

```toml
[profiles.offline]
extends = "workspace"
restrict_network = true
```

`deny` 清單需要 bubblewrap：`sudo apt-get install bubblewrap`。

**Cursor。** 不需要安裝任何東西：Harness Relay 的執行在 Linux 上同樣沒有沙箱。

### 在 Docker 與 dev container 中

- **Claude Code**：在 unprivileged 容器中，於 `sandbox` 底下加上 `"enableWeakerNestedSandbox": true`；隔離會較弱。
- **Codex**：讓容器提供 bubblewrap 需要的條件（user namespace、它自己的 `/proc`、seccomp），或在容器中以 `codex --sandbox danger-full-access` 執行，讓容器本身當作沙箱。它的文件沒有列出容器要用的旗標。
- **Grok**：沒有試過；上面 Linux 的檢查在容器中同樣適用。
- **Cursor**：不需要設定；容器就是它的指令唯一的沙箱（沒有試過）。

### 在 Windows 上

`winver` 會顯示 Windows 的 build（例如 `OS Build 26100.9278`）。

**Codex**，在 `%USERPROFILE%\.codex\config.toml` 中擇一：

```toml
[windows]
sandbox = "mxc"    # 沒有 mxc 的環境會失敗
```

```toml
[features]
prefer_mxc = true    # Windows 有 mxc 時使用它
```

```toml
[windows]
sandbox = "elevated"    # 或 "unelevated"
```

- `elevated` 需要一次由管理員核准的設定（UAC 提示）。IT 可以事先在提升權限的行程中執行：`codex sandbox setup --elevated --user 'DOMAIN\alice' --codex-home 'C:\Users\alice\.codex'`。
- 要確認 `mxc`，在 PowerShell 中執行（應該先輸出 `MXC_OK`，再輸出 `0`）：

  ```powershell
  codex -c windows.sandbox=mxc sandbox --include-managed-config --permission-profile :workspace -- cmd.exe /d /c echo MXC_OK
  $LASTEXITCODE
  ```

- `codex sandbox uninstall` 會移除舊版沙箱建立的帳號與網路規則。記錄檔在 `%USERPROFILE%\.codex\.sandbox\sandbox.log`。

**Claude Code 與 Grok** 在原生 Windows 上沒有沙箱：請在 WSL2 中執行它們與 Harness Relay。**Cursor** 在任何系統上都沒有沙箱，所以改用 WSL2 對它沒有差別。

### 在 WSL2 上

以系統管理員身分在 PowerShell 或 Windows Terminal 中執行：

```powershell
wsl --install    # 安裝 WSL2 與 Ubuntu
wsl -l -v    # VERSION 必須是 2
wsl --set-version Ubuntu 2    # 把 WSL1 的發行版轉成 WSL2
```

接著在 WSL 中安裝 Node.js、各 CLI 與 Harness Relay，並依[在 Linux 上](#在-linux-上)設定各 CLI。Harness Relay 會啟動它所在系統上的 CLI：在 Windows 上執行時，它啟動的是 Windows 版，而 Claude Code 與 Grok 在那裡沒有沙箱。對 Grok，在 WSL 中執行 `cat /sys/kernel/security/lsm` 可以看出它的 kernel 有沒有 Landlock。WSL2 預設會把 `localhost` 轉給 Windows，所以 Windows 上的瀏覽器能照常打開 Harness Relay（沒有試過）。

## 沙箱無法啟動時

其中有些失敗不會出聲：CLI 會在沒有沙箱的情況下繼續執行，而 CLI 印出的警告 Harness Relay 都不會顯示。

| | 會發生什麼事 |
| --- | --- |
| Claude Code | 指令在沙箱外執行；除非 `sandbox.failIfUnavailable` 為 `true`，這時它在啟動時就結束。Harness Relay 在完全存取以外的權限會設定它，所以這一輪會失敗，並顯示 Claude Code 給的原因與修正方式。 |
| Codex | 在 WSL1 上，沙箱指令會被拒絕。其他平台會在啟動時顯示警告（例如 bubblewrap 無法建立 user namespace）；它的 Linux README 把另一種情況稱為「a runtime sandbox failure」，所以之後的沙箱指令很可能是失敗，而不是在沙箱外執行（未驗證）。 |
| Grok | 內建設定檔：它的文件說會顯示警告，並在沒有限制的情況下繼續執行；但有些失敗（例如上文的 symlink socket，或 Linux 上沒有唯讀掛載）會讓它直接拒絕啟動。自訂設定檔（`sandbox.toml`）一律拒絕啟動。Grok 的 `sessions` 資料夾（`~/.grok/sessions`，或各 CLI 自己的資料夾中的 `grok/sessions`）裡 `sandbox-events.jsonl` 的 `"enforced": true` 表示設定檔確實套用了。 |
| Cursor | 它的 ACP 模式從不啟動沙箱，所以不會失敗，也不會有警告：在完全存取以外的權限，改為每個指令都要詢問（Cursor 團隊允許清單上的除外）。 |

Grok 因為沙箱而拒絕啟動時，這一輪會失敗並顯示 Grok 給的原因。Harness Relay 不會檢查沙箱是否真的套用了。

## 沙箱管不到的事

- **讀取。** 這三個沙箱預設都讓指令讀取幾乎整台電腦，包括 `~/.ssh` 和 `~/.aws`；只有 Grok 的 `strict` 設定檔會限制讀取（工作目錄、系統路徑與 `~/.grok`）。Harness Relay 不讓它們讀取瀏覽器的資料夾（包括桌面 app 視窗的）與它自己的資料庫（見 [agent 不能讀寫的地方](#agent-不能讀寫的地方)），其他的不在此限。使用者允許的 Cursor 指令（或 Cursor 團隊允許清單上的指令）沒有沙箱，使用者讀寫得到的，它都讀寫得到。要讓機密不離開這台電腦，靠的是擋網路，而 Grok 在 macOS 上做不到，Cursor 在哪裡都做不到。
- **Harness Relay 自己的 API。** Grok 的沙箱讓指令連得到 localhost（在 Mac 上試過：可編輯模式下，Grok 執行的 `curl http://127.0.0.1:…` 得到了回應），但 Harness Relay 在 `127.0.0.1:8787` 的 API 只接受已登入的瀏覽器：沒有瀏覽器 cookie 與金鑰的程式會收到 401（用 `curl` 試過），所以這類指令無法開始一輪執行（它擋不住的見[架構 → 登入](architecture.zh-TW.md#登入)）。同樣的測試中，Claude Code 與 Codex 的沙箱都擋下了 localhost。使用者允許的 Cursor 指令沒有沙箱，同樣連得到 localhost，也會收到同樣的 401。
- **Claude Code 自己的工具。** 它的沙箱只涵蓋 Bash 指令及它們啟動的行程，不包括它的 Read、Edit、Write、WebFetch、WebSearch 工具（這些由它的權限規則管）、hooks、本機的 MCP 伺服器（包括工具庫的）和 LSP 伺服器。
- **Cursor 自己的工具。** 它的拒絕規則只約束它的讀取與寫入工具，不約束它的指令，而且只照寫下來的路徑：Cursor 比對時分大小寫，也不解析連結，所以受保護路徑的另一種寫法（換個大小寫，在 macOS 一般不分大小寫的磁碟上）或專案裡指向它的連結都不會被拒絕，它的讀取工具不經詢問就能讀。它的 hook（`~/.cursor/hooks.json`、組織的，以及 Cursor 也會載入的 `~/.claude/settings.json` 裡 Claude Code 的，不論 Claude Code 自己的執行不載入哪些）每次執行都會在它的工具呼叫上執行，沒有能在單次執行中關掉的開關；它啟動的 MCP 伺服器也在任何沙箱之外執行。
- **Cursor 團隊的允許清單。** Cursor 團隊自動執行允許清單上的指令（由團隊管理員在 Cursor 的後台設定，從 Cursor 的伺服器讀取）可能不經詢問就在任何沙箱之外執行。Harness Relay 無法清除它。
- **寫到工作目錄與暫存資料夾以外會失敗**，包括套件快取（`~/.npm`、pip、cargo、Go 的 build cache）。如果網路也關閉，安裝相依套件就會失敗。
- **Git。** Codex 的 `workspace-write` 把 `.git` 設為唯讀：`git add` 與 `git commit` 會以 `.git/index.lock: Operation not permitted` 失敗（在 Mac 上試過）。Claude Code 不讓指令寫入 `.git/config` 與 `.git/hooks`。平行模式下，worktree 的 git 資料放在主 repository 的 `.git/worktrees/<name>`，在工作目錄之外。Harness Relay 的快照和 worktree 結果的 commit 都由伺服器在沙箱外執行，所以不受影響。Grok 的沙箱讓指令能寫入 `.git/config`、`.git/info` 與 `.git/hooks`（在 Mac 上試過：`git config core.fsmonitor …` 可以執行），使用者允許的 Cursor 指令，或使用者允許 Cursor 對它們的寫入，也能，所以 Harness Relay 自己在沙箱外執行的 git 指令，絕不執行 repository 自己的設定所指定的東西：它的 hooks 與 fsmonitor 都關閉，它的設定（或其包含的檔案）定義的每個 filter、diff 與 merge driver 都被清空，diff 也不執行外部 diff 或 textconv（`repoDriverGuards()`）。它的 submodule 所在的 repository 也一樣，因為 `git add` 會在其中執行 `git status`：agent 能寫入它們的設定，在 worktree 中也能在 submodule 的空資料夾裡建立一個。git 不會抓取缺少的物件（`GIT_NO_LAZY_FETCH`，git 2.44 以上），因為 partial clone 的遠端要透過設定所指定的指令連線；`core.worktree` 指向 repository 自己以外的資料夾時會拒絕，因為快照會把那個資料夾的檔案收進來，套用時也會寫到那裡。使用者自己的 driver，例如 `~/.gitconfig` 中 git-lfs 的，仍會執行。
- **在沙箱中常會壞掉的工具**（來自 Claude Code 的文件）：Docker 與 ssh-agent（Unix socket）、走 SSH 的 git 與 `open`、`osascript`（在 macOS 上）、watchman（請用 `jest --no-watchman`）、Linux 上的 Chromium（會啟動它的 Playwright 沒有試過）。
- **核准能做的事。** 在沙箱中，詢問使用者的意思變成詢問某個指令能不能離開沙箱：
  - Claude Code：模型可能會帶著 `dangerouslyDisableSandbox` 在沙箱外再執行一次指令（`sandbox.allowUnsandboxedCommands: false` 會拿掉這個出口）。這種重試，以及連到不在網路允許清單上的主機，在 `manual` 與 `acceptEdits` 中會詢問，在 `dontAsk` 中會被拒絕。在非互動的 `-p` 執行中，它們以 `can_use_tool` 請求送來（在 Mac 上試過）：主機以 `SandboxNetworkAccess` 送來，Harness Relay 把它顯示成讀取那個主機的網頁；Claude Code 因為某個沙箱無法寫入的路徑（`blocked_path`）而詢問的指令，就算允許了在沙箱中也會失敗，所以使用者允許時 Harness Relay 會讓它在沙箱外執行，卡片也會註明。設定為拒絕時，`acceptEdits` 仍會送來主機的請求，由 Harness Relay 拒絕。
  - Codex：和現在一樣，只有在模型要求超出沙箱允許的範圍時才會詢問。
  - Grok：設定檔一旦套用就無法撤除，所以就算核准了某個呼叫，它也不能寫到設定檔允許的路徑以外。
  - Cursor：沒有可離開的沙箱，所以允許一個指令，就是讓它以使用者的完整權限執行。

## 尚未處理的部分

唯讀與可編輯現在在 Claude Code、Codex 與 Grok 上都會使用沙箱（平台有沙箱時）；Cursor 的指令在任何平台上都不在沙箱中，只靠詢問把關。完全存取本來就是要在沙箱外執行：Docker、推送、安裝和寫到資料夾以外，正是它的用途。尚未處理的有：

1. **不能把設定當成沙箱。** 原生 Windows 上的 Claude Code 與 Grok，以及 macOS 上 Grok 的網路，都是設定了也不會生效，而 Cursor 的 ACP 模式完全不套用沙箱。UI 應該說明每個 agent 在這台電腦上是否真的在沙箱中，或在這些情況下拒絕使用沙箱模式。
2. **在 Linux 上執行前先檢查前提。** Claude Code 的沙箱無法執行時，這一輪會失敗並說明要安裝 `bubblewrap` 與 `socat`；Codex 與 Grok 的前提（`bwrap`、kernel 版本、在容器中能否使用 user namespace）則沒有檢查，也沒有用使用者的語言說明要為它們安裝什麼。
3. **Codex 在 Windows 上的 `elevated` 沙箱**需要做一次設定，其中有 UAC 提示；在背景啟動的 `codex app-server` 能不能顯示它，沒有驗證過。可以由管理員先執行 `codex sandbox setup --elevated`，或在 Windows 支援時改用 `mxc`。

## 資料來源

- Claude Code：[Sandboxing](https://code.claude.com/docs/en/sandboxing) 與 [All settings](https://code.claude.com/docs/en/settings-reference)。
- Codex：[Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security)、[Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox) 與 [Linux sandbox README](https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md)。
- Grok：`grok` 1.0.77 附帶的沙箱文件（設定檔、平台支援、網路限制）。
- Cursor：`cursor-agent` 2026.11.11-043ef28 本身：它的 ACP 伺服器與權限層，讀過程式碼並在 Mac 上試過。
