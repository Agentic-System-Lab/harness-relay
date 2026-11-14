[English](sandboxing.md) | **繁體中文**

# 各平台的作業系統沙箱

Harness Relay 啟動真正的 `claude`、`codex`、`grok`、`cursor-agent`、`agy`（Antigravity）、`copilot`（GitHub Copilot）和 `muse`（Muse Code）CLI，沙箱由各 CLI 自己提供，或者沒有（Cursor 在 Harness Relay 的執行中沒有提供，Antigravity 的則會讓它的指令寫不進工作目錄，所以兩者都在沒有沙箱的情況下執行）。五個開源 agent（OpenCode、Goose、Cline、OpenHands、Pi）自己也沒有沙箱，所以 Harness Relay 用[自己的沙箱](#harness-relay-自己的沙箱)把它們關起來（用的是同一套機制：macOS 的 Seatbelt、Linux 的 bubblewrap、網路用過濾代理）。這一頁說明 Harness Relay 目前哪些執行用了沙箱、各沙箱能在哪些平台上運作、在那裡需要什麼前提、無法啟動時會怎樣，以及它管不到哪些事。

於 2026 年 11 月 10 日確認，Cursor 於 2026 年 11 月 11 日確認，Antigravity 於 2026 年 11 月 12 日以 `agy` 1.5.6 確認，Copilot 則於 2026 年 11 月 13 日以 `copilot` 1.0.109 確認，Muse Code 則於 2026 年 11 月 13 日以 `muse` 1.4.18 確認。實際試過什麼、在哪些系統上、用哪些版本，見[已測試的範圍](#已測試的範圍)：一台 Mac（macOS 26.6）與一台 NVIDIA DGX Spark（Ubuntu 24.04，aarch64）；Cursor 只在 Mac 上試過；Antigravity 與 Copilot 與 Muse Code 在這兩台與一台 Windows 11 虛擬機（arm64）上都試過，Muse Code 在那裡沒有完成它沙箱的設定。其他內容，包括所有 Windows 與 WSL 的部分，都來自各 CLI 自己的文件（見[資料來源](#資料來源)）。這些 CLI 變動很快，要依賴某個細節之前請再確認一次。

## 已測試的範圍

在兩台機器上、於 2026 年 11 月 10 日，透過 Harness Relay 自己的 adapter 執行真正的 CLI（各在一個暫存的 git 資料夾中；檢查它們的回覆、工具列與檔案），另外還有單元測試（`npm test`，兩台都通過）：

| | Mac | NVIDIA DGX Spark |
| --- | --- | --- |
| 系統 | macOS 26.6.2，arm64 | Ubuntu 24.04.5 LTS，aarch64，kernel 7.0.0-1019-nvidia（AppArmor 限制 unprivileged user namespace） |
| 沙箱 | Seatbelt | bubblewrap 0.9.0 與 socat 1.8.0，加上[在 Linux 上](#在-linux-上)中給 `/usr/bin/bwrap` 的 AppArmor 設定檔（沒有它時，三者都拒絕在沙箱中執行） |
| CLI | Claude Code 2.1.322、Codex 0.167.0、Grok 1.0.77；Cursor（`cursor-agent`）2026.11.11-043ef28，11 月 11 日；Antigravity（`agy`）1.5.6，11 月 12 日；Copilot（`copilot`）1.0.109，11 月 13 日；Muse Code（`muse`）1.4.18，11 月 13 日 | Claude Code 2.1.321、Codex 0.167.0、Grok 1.0.77；Antigravity（`agy`）1.5.6，11 月 12 日；Copilot（`copilot`）1.0.109，11 月 13 日；Muse Code（`muse`）1.4.18，11 月 13 日；Cursor 沒有試過 |
| git | 2.50.1 | 2.43.0 |

每個 CLI 在唯讀與可編輯模式下、在兩台機器上被要求做的事：寫入工作目錄、寫入家目錄、連到 example.com、列出某個瀏覽器的資料夾、用 shell 讀取 `data/relay.db`（Claude Code 與 Grok 也用它們自己的檔案工具讀）。除了離開沙箱與連到主機以外，核准請求都允許。

| | Mac | DGX Spark |
| --- | --- | --- |
| Claude Code | 寫入工作目錄（唯讀模式下允許之後）；家目錄以沙箱外執行的形式詢問，沒有寫入；example.com 會詢問，之後被擋；Firefox 的資料夾與資料庫被拒絕（`Operation not permitted`），它的 Read 工具也被拒絕，含空格的路徑也一樣 | 相同；Chrome 的資料夾顯示為空（bubblewrap 蓋住了它），資料庫被拒絕（`Permission denied`） |
| Codex | 只在可編輯模式寫入工作目錄；家目錄與 example.com 被拒絕；Firefox 的資料夾與資料庫被拒絕 | 它的設定檔無法載入（見上文）：使用舊的沙箱；只在可編輯模式寫入工作目錄，家目錄與 example.com 被拒絕，但讀得到 Chrome 的資料夾與資料庫；它在工作目錄與 `/tmp` 留下空的 `.agents`、`.aws`、`.codex` 資料夾，原本沒有 `.git` 的地方也留下空的 `.git`（空的 `.git` 對 git 與 Grok 來說都不是儲存庫） |
| Grok | 寫入工作目錄；家目錄被拒絕；連得到 example.com（macOS）；Firefox 的資料夾與資料庫被拒絕，它的檔案工具也被拒絕；`~/.grok/downloads` 與 `~/.grok/bin` 被拒絕；在 `~/.grok/config.toml` 後面附加內容被 Grok 拒絕 | 寫入工作目錄；家目錄被拒絕；連得到 example.com；Chrome 的資料夾與資料庫被拒絕（`Permission denied`）；寫得到 `~/.grok/downloads`（在 Linux 上改為每一輪前後檢查它的程式） |

另外試過：Grok 的指令寫得到 `.git/config`（`git config core.fsmonitor …`，兩台都是），而 Harness Relay 自己的 git 不會執行它；在 Mac 上，Claude Code 與 Codex 的沙箱擋下 `127.0.0.1`，Grok 的則連得到，而 Harness Relay 的 API 對沒有登入的程式回應 401。沒有試過：原生 Windows、WSL、容器、其他 Linux 發行版、其他版本的 CLI。

**Cursor** 是隔天才加入的，只在 Mac（arm64）上以 `cursor-agent` 2026.11.11-043ef28 確認：讀過它 ACP 伺服器與權限層的程式碼，並透過 Harness Relay 的轉接器實際執行。它的 ACP 模式不論 `--sandbox` 或 `sandbox.mode` 怎麼設，都沒有套用沙箱，所以它要執行的每個 shell 指令都送到 Harness Relay 詢問。從程式碼看，它的 ACP 模式在任何平台上都不套用沙箱；Linux 與 Windows 沒有用真正的 CLI 試過。

**Antigravity** 是在那之後加入的，以 `agy` 1.5.6 在 Mac（arm64）上確認，之後也在 DGX Spark（Linux，aarch64）與一台 Windows 11 虛擬機（arm64）上確認：透過 Harness Relay 的轉接器試過它的 ACP 伺服器與設定，用的是 Gemini API key，搭配 Gemini API 的替身（沒有真正的 Google 登入與真正的 Gemini 模型可用）。它有自己的終端機沙箱（`--sandbox`，或設定中的 `enableTerminalSandbox`），但透過 ACP 時，這個沙箱讓指令在工作目錄中哪裡都寫不進去，只能寫暫存資料夾（agy 的記錄中沒有任何工作區資料夾），每種模式下都一樣，加上 `--add-dir` 或 `additionalDirectories` 也一樣。所以 Harness Relay 不開啟它，在完全存取以外，Antigravity 要執行的每個 shell 指令都送到 Harness Relay 詢問。在 Linux 與 Windows 上，同樣的執行（登出、拒絕、受保護的路徑、完全存取、中途停止、接續 session、它的模型與清單）都和在 Mac 上一樣；它的沙箱在那裡沒有試，因為 Harness Relay 不開啟它。在 Windows 上，agy 用 PowerShell 執行指令。

**Copilot**（GitHub Copilot CLI）最後加入，以 `copilot` 1.0.109 在 Mac（arm64）、一台 Windows 11 Pro 虛擬機（arm64，build 26200）與 DGX Spark（Linux，aarch64）上確認：透過 Harness Relay 的轉接器試過它的 ACP 伺服器、設定與沙箱，用的是 OpenAI 相容 API 的腳本替身，以及透過它自己那組「使用者自己的模型供應商」變數（BYOK）接上的 Ollama（`gemma4:e4b`，在 DGX Spark 上），也用了真正的 GitHub Copilot 登入（裝置代碼），搭配 Copilot 自己服務上的 Claude Haiku 4.5 與 Claude Sonnet 5.5。它有自己的沙箱（`--sandbox`：macOS 上是 Seatbelt、Linux 上是 bubblewrap、Windows 上是行程容器（process container）），透過 ACP 也能運作，Harness Relay 在完全存取以外會開啟它。在 Mac 上，指令寫到工作目錄以外會以 `Operation not permitted` 失敗，受保護的路徑也讀不到，這台電腦的 loopback 則連得到（`127.0.0.1` 上的模型伺服器有回應）。在 Windows 上，寫到工作目錄以外會以 `Access to the path … is denied` 失敗，第二個工作目錄可以寫入，當作受保護路徑交給它的檔案也被拒絕。DGX Spark 一開始缺少 Copilot 的 Linux 沙箱需要的東西（見 [Linux](#linux)：slirp4netns，而且 Ubuntu 限制 unprivileged user namespace），它在沙箱中執行的每個指令都失敗，並附上 Copilot 自己的原因，沒有任何指令在沙箱外執行。裝好 slirp4netns 1.2.1、把 `kernel.apparmor_restrict_unprivileged_userns` 設為 0 之後，它在那裡和在 macOS 上一樣能用：指令寫入了工作目錄與交給它的第二個工作目錄；寫到它們以外的指令失敗（那個資料夾在 bubblewrap 裡根本不存在：`No such file or directory`），它的檔案工具也拒絕這種寫入（`Outside the sandbox's writable paths.`）；受保護的檔案被拒絕，detached 指令也被拒絕；完全存取時它哪裡都寫得進去。它的指令連得到網際網路（一個 HTTPS 請求回應 200），但連不到這台電腦自己 loopback 上的服務（`127.0.0.1`：`Couldn't connect`），因為它們的網路是 slirp4netns 自己的。live 測試（`npm run test:e2e:live`，用 DGX Spark 上的 Ollama）在那裡也通過了。只靠給 `/usr/bin/bwrap` 的 AppArmor 設定檔、不改 sysctl 夠不夠，沒有確認過。在每個系統上，中途停止後都沒有留下任何東西在執行（`sleep 30` 不見了），專案的 `sessionStart` hook 允許後，在另外啟動一次的檢查之後於沙箱內執行（它的檔案寫在工作目錄裡），寫入 Cargo registry 也被拒絕（在 macOS 與 Linux 上，寫入 go-build 快取與模組快取也是）。把 `.git` 改名、寫入 `.git/hooks` 再改回原名的指令，在 macOS 上成功了；在 Linux 上 bind mount 擋住了（`Read-only file system`）。沒有試過：GitHub Enterprise 的登入，以及 Copilot Business 或 Enterprise 組織的政策（例如由組織管理的沙箱政策）。

**Muse Code** 接著加入，以 `muse` 1.4.18 在 Mac（arm64）、DGX Spark（Linux，aarch64，用 `muse` 自帶的 bubblewrap）與同一台 Windows 11 虛擬機上確認：透過 Harness Relay 的轉接器試過它的 ACP 伺服器、權限設定檔與沙箱，用的是假的 Meta API key，搭配 Meta API 的替身（後來也在 Mac 上用真正的 Meta 帳號與它的模型試過，表現一致）。在 Mac 與 DGX Spark 上，同樣錄下的執行表現一致：它的沙箱擋住了指令寫到工作目錄以外（`Operation not permitted`，允許後也一樣），它的拒絕規則讓它的 `read_file` 與 `cat` 都讀不到受保護的檔案，唯讀時每個指令都詢問，可編輯模式下會寫入工作目錄的指令照常執行，完全存取則能寫到外面。在 Windows 上，完全存取以外的權限下每個指令都在開始前就失敗，之後在虛擬機上以系統管理員權限執行了 Muse 自己的沙箱設定也一樣（它建立了沙箱帳號與防火牆過濾規則，`muse sandbox windows check` 也回報 `ready`）：它的 ACP 模式在那裡不用任何沙箱。它的檔案工具、唯讀、網路擷取、接續 session 與完全存取都和在 Mac 上一樣。在 Windows 上它的 shell 工具是 PowerShell。

這些執行是從原始碼啟動的，跟 `npm start` 執行伺服器的方式一樣。[桌面 app](user-guide.zh-TW.md#桌面-app) 執行的是同一個伺服器，用同樣的轉接器與同樣的沙箱設定，只是使用它自己的資料夾；上面的執行沒有在它底下重做。在 macOS 上，你給桌面 app 的隱私權限（例如「文件」等資料夾、麥克風）也會給到它執行的 agent，因為 agent 在它裡面執行；用 `npm start` 時則是終端機的權限。

## 什麼是作業系統沙箱

作業系統沙箱是作業系統核心套在一個行程及它啟動的所有行程上的限制：可以寫入（有時也包括讀取）哪些檔案、能不能使用網路。macOS 用的是 Seatbelt（`/usr/bin/sandbox-exec`）；Linux 有 Landlock、seccomp 與 bubblewrap（使用 user namespace）。

它和核准作用在不同的時間點：

- **核准**在指令執行*之前*，依指令的文字決定。指令一旦放行，就不再檢查它做了什麼。
- **沙箱**在指令執行*當中*生效。超出限制的寫入或連線會失敗（寫入通常是 `Operation not permitted`），即使是 agent 寫的程式碼、再由測試執行也一樣。

這就是為什麼在可編輯模式下沙箱同樣重要：測試與建置執行的是 agent 剛剛可能改過的程式碼；使用 Grok 與 Copilot 時，這些程式碼仍能連網；Cursor 與 Antigravity 在 Harness Relay 的執行中則完全沒有沙箱，只能靠詢問把關（見[架構 → 權限對應](architecture.zh-TW.md#權限對應)）。

## Harness Relay 目前的執行用了什麼

| Relay 權限 | Claude Code | Codex | Grok | Cursor | Antigravity | Copilot | Muse Code | 開源 agent（OpenCode、Goose、Cline、OpenHands、Pi） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 唯讀 | 它的沙箱：寫入限於工作目錄與暫存資料夾，每個主機都會詢問 | 由 `:read-only` 延伸的設定檔 `harness-relay-…` | 由 `workspace` 延伸的設定檔 `harness-relay`，可以連網 | 沒有沙箱：每個指令都要詢問（Cursor 團隊允許清單上的除外）；拒絕規則讓它自己的讀取與寫入工具碰不到受保護的路徑（照寫下來的路徑，見下文），寫入工具也不能寫入或刪除 | 沒有沙箱：每個指令與每個寫入都要詢問；它的讀取與網路搜尋直接執行，但讀寫受保護路徑時不經詢問就拒絕（見下文） | 它的沙箱：寫入限於工作目錄與暫存資料夾（`.git`、`.muse`、`.agents` 是唯讀的），每個主機都會詢問；它的檔案工具不能寫入（`--disable-write`），每個指令都要詢問（允許的在沙箱裡執行）；受保護路徑的拒絕規則（見下文） | 它的沙箱（`--sandbox`，搭配 Harness Relay 為這一輪寫的政策）：指令只能寫入各工作目錄與暫存資料夾，只能讀系統、工具與工作資料夾，以及你的 git 設定（家目錄的其他地方都不行），讀不到受保護的路徑，可以連網；它認為是唯讀的指令（`ls`、`cat`、`git status`、`echo`）直接執行，其他每個指令與每個寫入都要詢問；它的讀取與網址直接執行 | [Harness Relay 自己的沙箱](#harness-relay-自己的沙箱)：不能寫工作目錄；這次執行用的模型主機可連，其他主機都會詢問 |
| 可編輯 | 它的沙箱：寫入限於工作目錄與暫存資料夾，每個主機都會詢問 | 由 `:workspace` 延伸的設定檔 `harness-relay-…`，關閉網路 | 由 `workspace` 延伸的設定檔 `harness-relay`，可以連網 | 沒有沙箱：每個指令都要詢問（Cursor 團隊允許清單上的除外），Cursor 詢問的每個寫入也一樣（也包括它不在其中執行的、這個對話的其他工作目錄）；拒絕規則讓它自己的讀取與寫入工具碰不到受保護的路徑（照寫下來的路徑，見下文） | 沒有沙箱：每個指令都要詢問，寫到工作目錄以外、或寫進決定 agent 怎麼執行的資料夾（`.agents`、`.gemini`、`.claude`、`.git/hooks`……）也要詢問；工作目錄內的其他寫入直接執行；受保護路徑同上，一律拒絕 | 同一個沙箱：指令直接執行，但推送與發布要詢問；各工作目錄內的寫入直接執行，但寫進決定 agent 怎麼執行的資料夾（`.github/hooks`、`.github/copilot`、`.agents`、`.claude`、`.git/hooks`……）要詢問，其中已經存在的與共用的套件與建置快取，對它的指令都是唯讀；寫到它們以外，Copilot 自己會不經詢問就拒絕；MCP 工具呼叫與儲存記憶要詢問 | 它的沙箱，和唯讀一樣；它的檔案工具可寫入工作目錄；指令照常執行，但推送與發佈要詢問，指令要連網也要詢問；Muse 詢問的寫入（`.git`、`.muse`、`.agents` 底下，以及 `.envrc`）中，寫進 agent 設定的要詢問 | Harness Relay 自己的沙箱：也能寫各工作目錄；網路同上 |
| 完全存取 | 沒有沙箱 | 沒有（`danger-full-access`） | 沒有 | 沒有（`--force`） | 沒有（`--dangerously-skip-permissions`） | 沒有（`--allow-all`） | 沒有（`--disable-sandbox`） | 沒有 |

有多個工作目錄的對話，會以和第一個相同的權限把其他工作目錄交給每個 CLI：Claude Code 用 `--add-dir`（它的沙箱也能寫入那裡），Codex 在可編輯模式下於設定檔中為每一個加上 `write` 項目（舊版沙箱用 `writable_roots`），Grok 則用這次執行專用的設定檔，名稱是 `harness-relay-` 加上這些資料夾的雜湊，也就是 `harness-relay` 再加上這些資料夾的 `read_write`。在 Mac 上以可編輯模式逐一試過每個 CLI：在第二個資料夾中，用檔案工具寫的檔案與用 `touch` 建立的檔案都寫成了，而且沒有詢問；沒有給它那個資料夾時，Claude Code 與 Codex 會先詢問，Grok 的沙箱則兩個都拒絕（`Operation not permitted`）。開源 agent 在 Harness Relay 自己的沙箱中得到其他工作目錄，權限和第一個相同（可編輯模式下每一個都能寫入）。Cursor 沒有沙箱，在第一個工作目錄中執行：可編輯模式下，它用自己的工具寫入另一個工作目錄時會先詢問，卡片會說明檔案在對話的另一個工作目錄中（以 cursor-agent 2026.11.11 在 macOS 與 Linux 上試過）；但在 `/tmp` 這類暫存資料夾中，Cursor 寫入時不會詢問。它的指令則和其他地方一樣都會詢問。Antigravity 以它 session 的 `additionalDirectories` 得到其他工作目錄；它沒有沙箱，可編輯模式下它在其中任何一個的寫入都不經詢問就執行（決定 agent 怎麼執行的資料夾除外），它的指令則和其他地方一樣都會詢問（沒有用多個資料夾試過）。Copilot 以 `--add-dir` 得到其他工作目錄，但這不會讓它們在它的沙箱中可寫，所以它們也是這一輪沙箱政策的 `readwritePaths`，每一輪前的政策檢查會確認每一個都列在裡面（以 `copilot` 1.0.109 試過：指令的 `touch` 在第二個資料夾寫入了檔案）。Muse Code 也以它 session 的 `additionalDirectories` 得到它們，它的檔案工具與沙箱都把它們當成工作區的一部分：可編輯模式下，它的 `write_file` 寫在另一個資料夾的檔案不經詢問就寫入了（以 `muse` 1.4.18 試過；它在那裡的指令沒有試過）。

- **Claude Code** 的沙箱涵蓋它的 Bash 工具（`sandbox` 設定）。在完全存取以外的權限，Harness Relay 會在這一輪的 `--settings` 中開啟它，並設定 `failIfUnavailable`（沒有沙箱就不執行）、`autoAllowBashIfSandboxed: false`（哪些操作不必詢問仍由權限決定），以及詢問規則 `Bash(dangerouslyDisableSandbox:true)`（模型要在沙箱外執行的每個指令都會詢問）；在 Claude Code 沒有沙箱的原生 Windows 上，則不使用沙箱執行。在 Mac 上兩種模式都試過：在工作目錄中寫入可以（唯讀模式下要先允許）；寫入家目錄會先詢問並註明會在沙箱外執行，拒絕後就失敗；連到 example.com 會先詢問，拒絕後就被擋下。
- **Codex** 在完全存取以外的權限，每個指令都在沙箱中執行，使用的是 Harness Relay 在 thread 的設定中定義的權限設定檔（`harness-relay-` 加上每次執行都不同的隨機部分，由 `:read-only` 或 `:workspace` 延伸），並在 thread 中指名它（`permissions`，它選擇使用的實驗性欄位）；這會勝過你設定中的 `sandbox_mode`。Codex 沒有回報它套用了這個設定檔時（舊版 Codex 會忽略這個欄位），這次執行會失敗。在原生 Windows 上則和以前一樣使用舊的沙箱模式。在 Mac 上以 `workspace-write` 試過：在工作目錄中寫入可以；寫入家目錄或 `~/.npm`、連到 github.com 都被拒絕；讀取家目錄可以。
- **Grok** 在唯讀與可編輯模式下使用它的自訂設定檔 `harness-relay`：Grok 的 `workspace` 加上下文的路徑。唯讀模式不使用它的 `read-only` 設定檔，因為後者在某些機器上無法啟動：在裝了 OrbStack 的 Mac 上，`/var/run/docker.sock` 是 symlink，Grok 會以 `could not apply the 'read-only' sandbox profile … Refusing to start with its protections missing` 停止。在 Mac 上兩種模式都試過：在工作目錄中寫入可以，寫入家目錄會以 `Operation not permitted` 失敗，也連得到 example.com，因為 `workspace` 允許連網（`~/.grok/sessions/sandbox-events.jsonl` 中為 `"restrict_network": false`，並有 `"enforced": true`）。這些是在 `harness-relay` 之前以 `workspace` 試的；`harness-relay` 也確實套用了（`"enforced": true`，並有它的 `deny_paths`）。Harness Relay 只在完全存取以外的權限設定設定檔（`GROK_SANDBOX`），所以完全存取時，Grok 自己 `config.toml` 中的 `[sandbox] profile`，或啟動伺服器時的 `GROK_SANDBOX`，仍會生效。
- **Cursor** 透過 ACP（`cursor-agent acp`）執行，它的權限層從不套用 Cursor 的沙箱，不論它設定中的 `--sandbox` 或 `sandbox.mode` 怎麼寫，在任何平台上都一樣。所以 Harness Relay 只能靠核准管住它的指令：在完全存取以外的權限，沒有任何指令能不經詢問就執行（Cursor 團隊自動執行允許清單上的除外，見[沙箱管不到的事](#沙箱管不到的事)），包括測試與建置；使用者允許的指令則在任何沙箱之外，以使用者的完整權限執行，包括連網。它自己的工具能讀取任何位置（下文受保護的路徑除外，以它的拒絕規則擋得住的為限），可編輯模式下也不經詢問就修改工作目錄內的檔案，但 Cursor 受保護的檔案（`.git/hooks/**`、`.git/config`、`.vscode/**`、`.claude/*.json`、`.cursor/*.json`、`*.code-workspace`……）除外：寫入這些檔案時 Cursor 會詢問，寫入工作目錄外的任何檔案時也會詢問（`/tmp` 這類暫存資料夾除外，它在那裡寫入不會詢問），而 Harness Relay 會把 Cursor 詢問的每個寫入交給使用者（或拒絕），因為這種寫入可能讓程式碼之後在任何沙箱之外執行；卡片會說是哪一種。Cursor 每次刪除都會詢問；可編輯模式會核准這個對話任一個工作目錄內的刪除，路上的連結以它指向的地方為準，`~/…` 的路徑則以家目錄為準。Cursor 在第一個工作目錄裡執行：它詢問的、在其他工作目錄裡的寫入也會交給使用者，卡片上會說明檔案在哪裡。唯讀模式下，它的寫入工具既不能寫入也不能刪除（`Write(**)`，Cursor 在詢問之前就會檢查）。讀網頁與網路搜尋直接執行，subagent 的也是。每一輪的私有設定資料夾沒有允許規則，所以你自己的 Cursor 允許規則和專案的 `.cursor/cli.json`（不會讀取：`--disable-project-configs`）都無法讓指令通過（見[架構 → 權限對應](architecture.zh-TW.md#權限對應)）。
- **Antigravity** 透過 ACP（`agy acp`）執行。在 `agy` 1.5.6 中，它的終端機沙箱透過 ACP 時讓指令在工作目錄中哪裡都寫不進去（只能寫暫存資料夾），所以 Harness Relay 在任何平台上都不開啟它，而和 Cursor 一樣靠核准管住它的指令：在完全存取以外的權限，沒有任何指令能不經詢問就執行，包括測試與建置；使用者允許的指令則在任何沙箱之外，以使用者的完整權限執行，包括連網（卡片會註明）。透過 ACP 時，agy 會忽略它自己的權限規則（它設定中的 `permissions.allow` 與 `permissions.deny`：試過，兩者都沒有作用），但它的 `toolPermission` 設定有作用，而 `proceed-in-sandbox` 或 `always-proceed` 會讓指令不經詢問就執行。所以每一輪都有自己的設定（`--cli_dir_name harness-relay-<亂數>`，在帳號的 `.gemini/antigravity-cli` 裡的一個資料夾，只有擁有者能存取，這一輪結束後刪除）：只有帳號自己 `settings.json` 裡的模型與服務（`model`、`modelProvider`、`gcp`、`customModelsConfig`），加上 `toolPermission: "request-review"`、`allowNonWorkspaceAccess: false` 與預設模式；agy 讀這份，而不讀帳號的。這樣 agy 在每個 shell 指令、每次寫入或編輯、每次讀取工作區以外的檔案之前都會詢問；工作區內的讀取與網路搜尋則不經詢問就執行。Harness Relay 會直接執行讀取（下文受保護的路徑除外）、網路搜尋與讀網頁；可編輯模式下也直接執行對話各工作目錄內的寫入（路上的連結以它指向的地方為準，`~/…` 以家目錄為準），但寫入可能改變 agent 之後怎麼執行的地方（`.agents`、`.agent`、`_agents`、`_agent`、`.gemini`、`.claude`、`.codex`、`.grok`、`.cursor`、`.opencode`、`.goose`、`.cline`、`.clinerules`、`.openhands`、`.pi`、`.vscode`、`.idea`、`.mcp.json`、`.gitmodules`、`.gitconfig`、`.envrc`、Copilot 的 `.github/hooks`、`.github/copilot`、`.github/mcp.json`、`.github/lsp.json`、`.github/extensions` 與 `.github/agents`、`.git/hooks`、`.git/config`，以及 submodule 的 `.git/modules/<名稱>/hooks` 與 `…/config`，比對時不分大小寫，也像 Windows 一樣忽略結尾的點與空白）除外：這些會交給使用者，卡片會說明原因，寫到工作目錄以外也一樣。移動，或指名好幾個路徑的呼叫，會依所有路徑決定。指令、MCP 工具呼叫、subagent 與其他一切都交給使用者（或拒絕）。唯讀模式下，使用者允許的寫入會真的寫入：沒有沙箱擋住它。任何一種拒絕都會結束它的這一輪（見[核准能做的事](#沙箱管不到的事)）。帳號的其他設定不會進到這一輪，使用者自己設定的 `enableTerminalSandbox: true` 也一樣。在完全存取以外的權限，agy 一開啟 session 就會不經詢問啟動的專案 MCP 伺服器、hook 與 plugin，會在 agy 啟動前先詢問（見[沙箱管不到的事](#沙箱管不到的事)）。它留著執行的指令會隨這一輪結束：agy 把每個指令放在自己的 process group 裡啟動，而它移到背景的指令在它結束時仍會留著執行，所以在 macOS 與 Linux 上，Harness Relay 會在 agy 結束後，結束這些群組裡仍在執行的行程（只限這一輪中啟動的）；在 Windows 上，它們會隨 agy 一起結束（以 `agy` 1.5.6 確認過）。完全存取時，Harness Relay 傳入 `--dangerously-skip-permissions` 與 `toolPermission: "always-proceed"`：什麼都不會詢問。
- **Copilot** 透過 ACP（`copilot --acp`）執行，在完全存取以外的權限則在它自己的沙箱中執行（`--sandbox`：macOS 上是 Seatbelt、Linux 上是 bubblewrap、Windows 上是行程容器）。它的家目錄（`COPILOT_HOME`，沒有設定時是 `~/.copilot`）存放著決定哪些操作不必詢問的東西：記住的核准（`permissions-config.json`）、信任的資料夾（`config.json`）、網址規則與沙箱政策（`settings.json`）。所以每一輪都有自己的家目錄，放在 Harness Relay 自己的暫存資料夾裡（`data/tmp/copilot-…`，只有擁有者能存取，這一輪結束後刪除；伺服器在某一輪進行中停止時，則在它下次啟動時刪除）：一份 Harness Relay 的 `settings.json`，帳號自己的設定只保留它的模型與服務、它的 proxy、是否把 session 同步到 GitHub（`remoteExport`）與是否自動更新（`autoUpdate`、`autoUpdatesChannel`），以及它自己載入的內容（絕不保留它的 `sandbox`、`allowedUrls`、`defaultPermissionMode`、`statusLine` 或 `telemetry`）；帳號的登入狀態（去掉信任資料夾的 `config.json`，也去掉舊版 Copilot 放在那裡的設定，例如 `trusted_folders`、`allowed_urls` 或 `allow_all`，兩種寫法都算，略過 hook 與 plugin 時也去掉它們的設定）；簡報；一個指向帳號 session 的連結；以及指向帳號自己載入的內容的連結；記住的核准則絕不帶過去。在完全存取以外的權限，這一輪的 `sandbox` 設定會開啟它，並設定 `allowBypass: false`（任何指令都不能離開它）、對話的其他工作目錄可寫（`readwritePaths`）、skill 資料夾、附件與下面那些路徑唯讀、受保護的路徑禁止（`deniedPaths`，見下文）、git 與 `gh` 不能透過它的 proxy 拿到憑證（`auth`）、在 macOS 上它的指令不能用鑰匙圈（`seatbelt.keychainAccess: false`）、MCP 伺服器和其他 CLI 一樣在沙箱外（`sandboxMcpServers: false`）、它的語言伺服器與擴充功能在沙箱內，網路則開放（`allowOutbound`、`allowLocalNetwork`）。專案的 `.github/copilot/settings.json` 無法放寬它（試過：那裡的 `allowBypass` 與 `readwritePaths` 都被忽略）。這樣它的指令只讀得到系統、`PATH` 與開發工具的資料夾、各工作目錄與暫存資料夾，讀不到家目錄（所以 `~/.copilot` 與 `~/.ssh` 都讀不到），也只能寫入各工作目錄與暫存資料夾；它的檔案工具也遵守同一份政策。另外設為唯讀的（`copilotReadOnlyPaths()`），每一個都只在這一輪開始時已經存在才加入（它的沙箱啟動時不存在的路徑不受它保護，bubblewrap 也會拒絕在這種路徑上啟動）：你的 git 設定（`~/.gitconfig`，以及 `~/.config/git` 裡的 `config`、`ignore` 與 `attributes` 檔，不是整個資料夾，所以 git 的 credential store 可能放在那裡的檔案仍然讀不到），git 少了它就完全不能執行；它的 dev-tool access 會讓指令在工作目錄以外寫入的共用套件與建置快取（在 Mac 上用各種專案試過：Cargo 的 registry、git 儲存區與鎖定檔，Go 的建置與模組快取，npm、pnpm、Yarn、Bun、Deno、pip、uv、Poetry、virtualenv、Bundler、Maven、Gradle、ccache、sccache、node-gyp、Electron 與 Playwright），變數把它移到的地方與它預設的地方都算，因為 Copilot 兩個都放行；其中有些放著之後在任何沙箱外執行的程式（npx 的套件、Playwright 的瀏覽器、Gradle 的 wrapper），而這也是每個 CLI 都遵守的規則（見[沙箱管不到的事](#沙箱管不到的事)）；以及每個工作目錄裡決定 agent 之後怎麼執行的東西（`.git/hooks`、`.git/config`、`.gitmodules`、`.vscode`、`.idea`，以及 [Harness Relay 自己的沙箱](#harness-relay-自己的沙箱)設為唯讀的 agent 設定，見[沙箱管不到的事](#沙箱管不到的事)的 Git；在 macOS 上這些是路徑規則，指令可以把上一層的資料夾改名來繞過，那一段有說明）。只有旗標會在失敗時關起來：只在設定中開啟的沙箱，在無法執行它的電腦上會被略過，而 Copilot 自己的沙箱功能開關（`SANDBOX`）關閉時，旗標也會被忽略。所以每次送出 prompt 前，Harness Relay 會先送 `/sandbox policy`，這是 Copilot 自己回答的指令（不會送到模型，也不會留在 session 裡）；等它回答的期間，任何權限請求都會被拒絕，如果還是由模型回答了（工具呼叫、它的思考，或結果裡有用量），這一輪就失敗。接著檢查它的回答：政策確實生效、`Allow sandbox bypass: no`，有寫到 `Allow keychain access`、`Authenticate git` 與 `Authenticate gh` 時都是 off，每個受保護的路徑與其他工作目錄都列在裡面；否則這一輪不會開始，並說明原因。它的「Dev tools」段落列為可讀寫、而且不在暫存資料夾裡的其他路徑，會讓這次執行把那個路徑也設為唯讀，再啟動一次（`copilotDevWrites()`）；指令執行時仍可能帶進更多放行的路徑（Copilot：「run /sandbox policy <command> to resolve those」），這些事先看不到。session 開啟時就會自己執行東西的（專案的 hook，或這次執行家目錄裡帳號自己的 hook、plugin、擴充功能或語言伺服器），沒辦法在那之前檢查，所以會先另外啟動一次檢查它的沙箱：家目錄裡只有登入狀態與這次執行的沙箱設定，其他全部略過，工作目錄是系統暫存資料夾裡的一個空 repository，所以那裡什麼都不會執行；它的 `/sandbox policy` 必須通過，這次執行才會啟動（只有這種情況會多一次短短的啟動；以 `copilot` 1.0.109 在 macOS、Linux 與 Windows 上試過）。Copilot 在每個它不認為是唯讀的指令（`ls`、`cat`、`git status` 與 `echo` 不經詢問就在它的沙箱中執行）、每個它建立或編輯的檔案、指令或它的讀網頁工具指名的每個網址，以及每次讀取工作目錄與暫存資料夾以外的檔案之前，都會詢問（允許一次、永遠允許、拒絕）；Harness Relay 從不回答「永遠允許」。唯讀模式下，讀取與網址直接執行，指令、寫入與 MCP 工具呼叫交給使用者（或拒絕）；使用者允許的指令在沙箱中執行，而沙箱能寫入各工作目錄，所以和 Grok 一樣，專案是靠詢問保住的。可編輯模式下，指令直接執行，但推送與發布除外；各工作目錄內的寫入直接執行，但寫入可能改變 agent 之後怎麼執行的地方除外（其他 CLI 的資料夾、`.git/hooks`、`.vscode`……，比對方式和 Antigravity 相同，以及 Copilot 自己在 `.github` 裡的 `hooks`、`copilot`、`mcp.json`、`lsp.json`、`extensions` 與 `agents`，自訂 agent 可能指定它們自己的 MCP 伺服器），這些會交給使用者，卡片會說明原因；MCP 工具呼叫與儲存記憶也交給使用者（Copilot 內建的 GitHub MCP 伺服器能推送檔案、開 pull request，而且在任何沙箱之外；記憶則存在 GitHub 上，給所有使用這個 repository 記憶的人）。寫到沙箱可寫路徑以外的檔案，Copilot 自己會不經詢問就拒絕（`Outside the sandbox's writable paths.`），它的這一輪則繼續，所以在可編輯模式下，使用者無法允許這種寫入；detached 指令也一樣（`Detached commands cannot run inside the sandbox`）。Harness Relay 的任何拒絕都會結束它的這一輪（見[核准能做的事](#沙箱管不到的事)）。Copilot 會不經詢問就執行的專案 hook，會在它啟動前先詢問，帳號略過 hook 時也一樣（見[沙箱管不到的事](#沙箱管不到的事)）。每一輪也會把 session 設成 Copilot 的 agent 模式（它的 autopilot 模式會開啟 allow-all），在完全存取以外的權限，沒有回報 allow-all 選項的 session（例如從完全存取接續的）不會執行，並把 `COPILOT_ALLOW_ALL` 與 `COPILOT_ASSISTED_APPROVAL` 從它的環境中拿掉。完全存取時，Harness Relay 傳入 `--allow-all`，開啟 session 的 allow-all，並關閉沙箱（`sandbox.enabled: false`）：什麼都不會詢問。中途停止會取消 session 的 prompt（`session/cancel`），它啟動的東西都不會留著執行（確認過：`sleep 30` 不見了）。
- **Muse Code** 透過 ACP（`muse acp`）執行，在完全存取以外的權限，於它自己的作業系統沙箱中執行：macOS 上是 Seatbelt，Linux 上是它自帶的 bubblewrap，Windows 上則是完成設定後它自己的沙箱（見 [Windows](#windows)）。它的指令只能寫入工作區（工作目錄與它的 `additionalDirectories`）與系統的暫存資料夾（`/tmp`、`/private/tmp`），`.git`、`.muse` 與 `.agents` 維持唯讀；指令或它的網路擷取連到的每個主機都會詢問（`--sandbox-network proxy-only`，它的預設）。哪些不經詢問就執行，由它的權限設定檔與 session 模式決定，而設定檔只能在它的 `settings.json` 裡選，所以每一輪都有自己的設定資料夾（`XDG_CONFIG_HOME`，Harness Relay 資料夾裡 `muse-runs` 中的一個 `run-…` 資料夾，只有擁有者能存取，這一輪結束後刪除；不放在 `data/tmp`，因為設定檔拒絕那裡，而 git 連看都不能看它的 `XDG_CONFIG_HOME` 時就會失敗），其中的設定放的是 Harness Relay 的設定檔 `harness-relay`：Muse 的 `:ask-me`（由人審核），每個受保護的路徑一條 `"deny"` 規則（見下文）。Muse 自己的 `:read-only` 不接受拒絕規則（「deny cannot be enforced」），所以唯讀是那個設定檔拿掉 Muse 寫入檔案的工具（`--disable-write`），用 session 模式 `promptUnmatched`，每個指令都要詢問；使用者允許的指令在沙箱裡執行，沙箱讓它可以寫入工作目錄。可編輯是 `onRequest` 模式，指令在沙箱裡執行，寫入或連網的指令會詢問；Harness Relay 會允許寫入的指令，但推送、發佈，以及 shell 或直譯器執行它從標準輸入讀到的內容要交給使用者，而且允許後它仍在沙箱裡執行（試過：寫到工作區外的指令被問了兩次，允許後仍以 `Operation not permitted` 失敗）。指令要連網時，完全存取以外不論哪種模式都交給使用者。可編輯模式下它的檔案工具寫入工作目錄不必詢問，但 `.git`、`.muse` 與 `.agents` 底下（以及 `.envrc`）Muse 會詢問，寫進 agent 設定的 Harness Relay 會交給使用者；寫到工作目錄以外 Muse 自己就會拒絕，而工作目錄裡其他 agent 的設定（`.claude`、`.vscode`、`.mcp.json`…）它不經詢問就寫入，和 Claude Code、Codex 與 Grok 一樣。Muse 預設設定檔的評審（會判斷呼叫的模型）是關掉的（`MUSE_DISABLE_APPROVAL_JUDGE=1`），完全存取以外的權限下，這一輪的設定資料夾有它自己的 `trust.json`，把工作目錄標成不受信任（絕不用帳號的，也不給 `--trust-workspace`），所以不信任任何工作區，專案的 hook（`.muse/hooks.json`，在受信任的工作區裡 Muse 會在沙箱外執行它）絕不會載入。在 Linux 上，它的 bubblewrap 會在每個工作目錄替它掛載覆蓋的每個路徑留下一個空資料夾（`.agents` 與 `.muse` 維持唯讀；`.hg`、`.sl` 與 `.eden` 被隱藏）；這一輪之前不存在的，Harness Relay 會在那個資料夾裡最後一次執行結束後刪除，前提是它們是空的，或只有已不在執行的沙箱程序留下的 `.tbh-sandbox-mountpoint.<pid>` 標記（停止的回合會留下）。完全存取時，Harness Relay 傳入 `--disable-sandbox` 與 `--trust-workspace`，用 Muse 的 `:unrestricted` 設定檔與 `allowAll` 模式：什麼都不會詢問。Muse 會沿用 session 建立時的設定檔與沙箱（試過：以完全存取建立、再以可編輯的設定接續的 session，仍讀到了被拒絕的檔案，也寫到了外面），所以只有同一個伺服器程序以相同的權限與受保護路徑建立的 Muse session，Harness Relay 才會接續，否則就開新的。

## Harness Relay 自己的沙箱

五個開源 agent（OpenCode、Goose、Cline、OpenHands、Pi）自己沒有作業系統沙箱，所以在完全存取以外的權限，Harness Relay 用 [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime)（`srt`，Apache-2.0：macOS 的 Seatbelt、Linux 的 bubblewrap + seccomp、網路用過濾 HTTP/SOCKS 代理）自己做的沙箱，把每個 agent 及它啟動的一切都關起來。程式在 `src/server/relaySandbox.ts`；各轉接器透過 `sandboxCommand()` 要用它，完全存取以外沒有東西在它之外執行。

**每次執行一個沙箱。** 每次執行有自己的主控行程（host，`relaySandboxHost.ts`），和其他 CLI 一樣透過 `src/server/process.ts` 啟動（會被追蹤，關機時連同整個行程樹一起結束），並有一條在它的檔案描述符 3 上的私有控制通道。主控行程只為那一次執行跑一個 sandbox-runtime，所以同時進行的不同對話的執行——不同的工作目錄、權限與主機——彼此看不到對方的規則：每個有自己的代理，只有它自己的沙箱連得到（macOS 上 Seatbelt 只允許連到那個代理的連接埠；Linux 上沙箱沒有自己的網路，只有那個代理的 socket），而且要帶只有它自己的沙箱才有的 token。沒有規則決定的主機會透過那次執行的通道來詢問，所以核准會送到正確那一次執行的「詢問我」，不會被別的執行回答；規則與指令都不經過命令列，也不放在沙箱中的行程能改的共用檔案裡。在沙箱裡，agent 透過一段固定的 `/bin/sh` script（`SANDBOX_EXEC_SCRIPT`）啟動，程式、它的參數與這次執行自己的變數都從環境變數取得（`HARNESS_RELAY_SBX_*`，在 agent 啟動前移除），所以任何值都不會成為 shell 文字的一部分。

**主控行程用的 Node。** 主控行程是 Node.js 程式。用 `npm start` 時，它用伺服器自己的 Node 執行。桌面 app 的 Electron 不能當成 Node 執行（它的 fuses 關掉了這個功能），所以在那裡它用登入 shell 的 `PATH` 上找到的 Node.js 22.12 以上執行（`hostNode()`），打包成 `relaySandboxHost.mjs`，沙箱 runtime 的套件放在它旁邊；沒有這樣的 Node 時，開源 agent 在完全存取以外會被拒絕，並附上說明。

**檔案系統。**

| | 讀 | 寫 |
| --- | --- | --- |
| 唯讀 | 下列受保護路徑以外的一切 | 只有這次執行自己的暫存資料夾與 agent 的狀態資料夾（它的 session、記錄與快取）——**不含工作目錄** |
| 可編輯 | 同上 | 上述加上各工作目錄與這個對話的附件資料夾 |

- 完全不能讀**也**不能寫（`denyRead` + `denyWrite`）：受保護路徑（`protectedReads()`：瀏覽器自己的資料夾、Harness Relay 的資料庫與暫存資料夾，與其他 CLI 相同，見[agent 不能讀寫的地方](#agent-不能讀寫的地方)）。
- 永遠不能寫（`denyWrite`），即使上層資料夾可寫：agent 的設定路徑（所有啟動時會改變 CLI 行為的東西——它的設定、plugin、擴充功能、hook、MCP 設定、指示檔），這樣一次執行就不能放寬它下一次執行；可編輯模式下，工作目錄裡其他 CLI 與這些開源 agent 自己的設定（`.claude`、`.codex`、`.grok`、`.cursor`（Cursor 沒有沙箱，會從這裡讀它的規則、subagent、skill 與 MCP 伺服器）、`.mcp.json`、`.opencode`、`opencode.json`、`opencode.jsonc`、`.goose`、`.cline`、`.clinerules`（Cline 會不經詢問執行 `.clinerules/hooks` 裡的 hook）、`.openhands`、`.pi`、`.agents`，以及 `.agent`、`_agents` 與 `_agent`，沒有沙箱的 Antigravity 也會從這些地方讀專案的 hook 與 MCP 伺服器，還有 `.github/hooks`、`.github/copilot`、`.github/mcp.json`、`.github/lsp.json`、`.github/extensions` 與 `.github/agents`（只在有 `.github` 資料夾時，好讓這個資料夾還建立得起來），因為 Copilot 會不經詢問執行專案 `.github/hooks` 裡的 hook，也從那裡讀它的設定、MCP 與語言伺服器、擴充功能與自訂 agent，而自訂 agent 可能指定 MCP 伺服器，以及 `.muse`，在受信任的工作區裡 Muse Code 會在它的沙箱外執行其中的 hook）、沙箱要執行的程式所在的資料夾，以及 sandbox-runtime 原本會讓任何指令寫入的地方（`/tmp/claude`、`~/.npm/_logs`、`~/.claude/debug`）。sandbox-runtime 自己也會把 `.git/hooks`、`.git/config`、`.gitmodules` 與 shell 的設定檔設為唯讀。
- **每次執行寫自己全新的暫存資料夾**（在 Harness Relay 的資料夾裡，執行結束時刪除），不是共用的。sandbox-runtime 預設給每次執行同一個 `TMPDIR`（`/tmp/claude`）；Harness Relay 把它改掉，這樣一次執行就不能留下一個檔案（例如一份轉譯或編譯快取）讓下一次執行——也許是另一個對話的——載入並執行。
- **host 自己的暫存資料夾**（sandbox-runtime 的 socket、它的 CA bundle）也在資料夾裡，`data/srt/<亂數>`，其他執行都讀不到：絕不放在系統的暫存資料夾，那裡其他 CLI 沙箱中的指令可以替換或刪除裡面的東西。Unix socket 的路徑在 macOS 上必須放得進 104 個位元組、Linux 上 108 個，所以資料夾路徑太長、放不下這些 socket 時（macOS 上超過 70 個位元組，Linux 上超過 61 個，以 UTF-8 計：中文字每個佔 3 個），完全存取以外會拒絕執行，並提示把 `RELAY_DATA_DIR` 設成較短的資料夾。桌面 app 的資料夾放得下，除非使用者名稱很長；很深的 checkout（例如 `.claude/worktrees/` 下的 worktree）可能放不下。
- 下列情況不會開始執行：受保護路徑或設定路徑的名稱含有 `*`、`?` 或 `[`（沙箱會把它當成樣式，可能擋不住）；這次執行可以寫的資料夾包含了 Harness Relay、家目錄或其他 CLI 自己的資料夾（那它就能改到沙箱外會執行的東西）；或者在可編輯模式下，工作目錄本身就是上述之一（`relayFolderRefusal()`，和其他 CLI 一樣）。

**網路。** 這次執行可以不經詢問連到它用的模型來源的主機（`api.openai.com`、`api.anthropic.com`、`api.x.ai`，以及自訂端點的 `host:port`），其他主機都不行。其他主機會透過「詢問我」來詢問（一張 `fetch` 類型、針對那個主機的核准卡；「本對話都允許」只涵蓋那個主機的那個埠號，卡片只寫主機時則是 443 與 80）；被拒絕、或在自動拒絕的對話裡，則以模型看得到的理由擋下。agent 每次啟動都會連、但不該每輪都擋住整輪的主機（Goose 的 `models.dev` 目錄），可以列為**安靜拒絕**——帶理由擋下，不詢問。Harness Relay 自己的埠（`PORT`（為 0 時是伺服器實際取得的埠）、8787、8789 與 5173：`npm start` 與桌面 app 的，以及 `npm run dev` 的 API 與 Vite）永遠不允許（直接連或透過代理都不行），這台電腦自己的位址、link-local 與 metadata 位址也不行，不論怎麼寫（`127.1`、`2130706433`、`0x7f.0.0.1`、`localhost.` 都讀成 proxy 實際連的位址）。在你允許之前，Harness Relay 絕不查詢主機名稱（它的解析器在沙箱外，若替指令要連的每個名稱都去查，名稱本身就能把資料帶出去）：會解析到這台電腦的名稱（`localtest.me`、`127.0.0.1.nip.io`）會像其他名稱一樣詢問你，你若允許，sandbox-runtime 在連線時會拒絕它。回合結束時還在排隊等著詢問的主機會被拒絕，不會在之後才拿去問你。這台電腦上的模型來源必須寫出連接埠（`localhost:11434`；區域網路上其他電腦的，例如 `192.168.1.20:8000`，則不一定要），兩者都走代理——Harness Relay 只把 loopback 排除在代理外，不排除私有網段，所以本機來源仍會走到代理、由允許清單決定（sandbox-runtime 自己的 `NO_PROXY` 會涵蓋私有網段，那會讓本機來源繞過代理而被擋；Harness Relay 把它收窄）。模型來源本身就在 loopback 上時（Ollama、本機的 vLLM），`NO_PROXY` 只列出 agent 自己的連接埠（下面的 `localPorts`），所以這個來源與其他所有 loopback 連接埠都走代理。

**代理，各種用戶端。** sandbox-runtime 把網路導到它在 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 裡指名的本機代理。Harness Relay 設 `NODE_USE_ENV_PROXY=1`，讓 Node 22 的 `fetch` / `http` / `https` 照它走（Node 22.21+）；Bun、Python 的 `httpx` 與 `requests`、Rust 的 `reqwest`、Go 與 curl 自己會讀代理變數。在這台 Mac 與 Linux 上的 Docker 都確認過：Node 22 `fetch`、Bun、Python `httpx` 與 `requests`，以及 curl（當作 Rust `reqwest` 用戶端的替身）都能透過代理連到允許的主機，而不被允許的主機則被擋。從不把 loopback 交給代理的用戶端（Cline 會自己把 `localhost`、`127.0.0.1` 與 `::1` 加進 `NO_PROXY`），照樣連得到這次執行可以連的、在 loopback 上的模型來源或伺服器：在 macOS 上，這次執行可以直接連那些 loopback 埠（不能在上面監聽）；在 Linux 上，沙箱的 loopback 是它自己的，所以 agent 啟動前，`socat` 會把每個這樣的埠，經代理、用這次執行自己的憑證，轉接到沙箱的 loopback 上（`loopbackRelay`、`SANDBOX_EXEC_SCRIPT`）。兩種情況都只連得到代理的允許清單允許的地方。

**各轉接器的選擇性開啟**（預設都關，各為一個需要的 CLI，用到的地方都有說明）：

- **偽終端機**（`allowPty`），給在偽終端機裡跑指令的 OpenHands（完全存取以外絕不用 tmux）。**`allowPty` 在 macOS 上打開了什麼：** sandbox-runtime 的規則讓這次執行能依路徑讀寫 `/dev/ptmx` 與**所有** `/dev/ttys*`，所以沙箱中的程式可以打開你當時開著的任何一個終端機：在上面印字、讀得到在裡面打的字，也能改它的設定，例如關掉回顯（核心仍不讓程式把輸入推進不是它自己的終端機，`TIOCSTI`）。Seatbelt 無法把它收窄到這次執行自己的終端機：它的規則在執行開始時就固定、按路徑指名裝置，而終端機的編號要到打開時才由核心挑（而且會重複使用）。所以在 macOS 上，要等使用者在「設定」打開它的開關（預設關閉，開關上會寫明這件事），OpenHands 才會在完全存取以外執行。**Linux 上** bubblewrap 給沙箱一個它自己的 `/dev/pts`（在 Docker 裡檢查過：裡面只有 `ptmx`，沒有外面的終端機），所以這個選項在那裡打不開你的任何終端機，也不需要開關。**這次執行自己的 Unix socket**（`allowUnixSocketsInTmp`）仍然可以給轉接器用（只在 macOS 上、只在這次執行自己的暫存資料夾裡、每次執行都是新的），但現在沒有轉接器需要它；Linux 上 sandbox-runtime 無法只允許一個 socket 路徑（它的 seccomp 過濾器會擋掉所有 Unix socket，除非全部允許，而這個沙箱絕不會這樣做）。
- **agent 只連線、不自己提供的 loopback 連接埠**（`connectPorts`）：agent 不自己跑的、你自己的伺服器（Goose 在這台電腦上的 HTTP MCP 伺服器）。它們透過代理連到，代理的允許清單在這些連接埠上指名 `127.0.0.1`、`localhost` 與 `[::1]`；沙箱不能在這些連接埠上監聽（macOS），所以指令無法搶走一個停掉的伺服器的連接埠；Linux 上它只能在自己的 loopback 上監聽，那不是這台電腦的。絕不會是 Harness Relay 的連接埠。
- **agent 自己的 loopback 連接埠**（`localPorts`），給會自己跑 HTTP 伺服器並跟自己講話的 CLI（OpenCode 的 `opencode acp`）。macOS 上沙箱只能在那幾個連接埠上監聽與連線，別的本機連接埠都不行，直接連或透過代理都可以（代理的允許清單這時只多了這幾個連接埠上的 `127.0.0.1`、`localhost` 與 `[::1]`）；Linux 上它有自己的 loopback，任何連接埠都行，而且連不到這台電腦的任何連接埠，所以在它之外的代理不允許這些連接埠。旁邊有 loopback 上的模型來源時，`NO_PROXY` 只放這些連接埠的 `127.0.0.1:<port>` 與 `localhost:<port>`：Node、Bun 與 httpx 會照這裡的連接埠直接連到 agent 自己的伺服器（兩個平台都確認過），curl，以及 Python 的 requests 對位址，則忽略連接埠而走代理，只有在 macOS 上代理才連得到 agent 的伺服器。絕不會是 Harness Relay 的連接埠，也不會是模型來源的。這比 sandbox-runtime 的 `allowLocalBinding` 窄，後者會打開每個 localhost 連接埠（Harness Relay 自己的 API、其他本機服務、其他執行的伺服器）。
- **憑證信任服務**（`allowTlsTrustd`），給 Goose，它的 TLS 驗證（Rust，經 rustls-platform-verifier → macOS Security framework）需要 `com.apple.trustd.agent`，而 sandbox-runtime 的 Seatbelt 設定檔預設擋掉它。這只打開那一個 mach 服務（就是 sandbox-runtime 自己的 `enableWeakerNetworkIsolation` 會打開的那一個，單獨列出，不多開別的），只在 macOS 上。它是一條可能的出口，因為 trustd 會自己從網路抓憑證的 OCSP 或 CRL，走在代理之外，所以程式可以把一點資料藏在它請 trustd 檢查的東西裡；TLS 已經走代理的 CLI（Node、Bun、Python）則關閉它。

**失敗就關起來。** 沙箱無法啟動時——原生 Windows（sandbox-runtime 的 Windows 支援還是 alpha；開源 agent 在完全存取以外拒絕在那裡執行，就像 sandbox-runtime 在低於完整隔離時會被拒絕一樣）、其他平台、sandbox-runtime 擋不住 Unix socket 的處理器（非 x64 或 arm64）、Linux 上缺 `bubblewrap` / `socat` / `ripgrep`、或 sandbox-runtime 套不上規則——這一輪會以使用者語言的理由、以及各平台怎麼修的說明失敗，除非權限是完全存取。Harness Relay 在每次執行前會確認沙箱真的能啟動（它在沙箱裡跑一個很小的指令），結果會短暫快取;host 自己在開始任何東西之前也會失敗就關起來，當 sandbox-runtime 套不上規則、或警告有破口時（沒有 seccomp helper、它自己那份可被寫）。

**殘留的行程。** 一次執行結束時，host 會停掉沙箱的整個行程樹。離開 host 行程群組的行程——agent 放到背景的指令（有些 CLI 用 detached 執行，一次 double fork 就把它重新掛到 `launchd`）、呼叫過 `setsid` 的 daemon，或像 tmux 這種伺服器——用群組的方式殺不到，而 macOS 也沒有 PID namespace 可以把行程樹放進去。macOS 上有兩種清掃會找出這類行程：
- **依它的沙箱**（`src/server/sandboxProcs.ts`）：每個子孫行程都保有啟動時的 Seatbelt 設定檔，而且丟不掉，不管它關掉了什麼、被重新掛到哪裡。對你的每個行程，核心會回答它的設定檔是否允許寫入這次執行自己的暫存資料夾（只有這次執行的設定檔允許），而且不允許寫入外面那一層資料夾（連那一層也能寫的行程，代表它有更寬的沙箱，例如另一個工具的沙箱、工作目錄剛好包含 Harness Relay 的資料，這種會被放過）。這不讀任何環境變數或終端機，只讀核心對規則的回答（libsandbox 的 `sandbox_check`，透過系統的 Python `/usr/bin/python3` 呼叫，它隨 Xcode 命令列工具一起安裝）。這次執行的設定檔允許它刪掉自己的暫存資料夾、或在原處放一個連結，所以伺服器詢問之前會先把它重新做成真的資料夾（核心是依路徑回答）。伺服器在處理掉這次執行時、移除它的資料夾之前執行這項清掃；伺服器被殺掉後，下一次啟動時會對它留下的每個執行資料夾做同樣的清掃。
- **依標記檔**：每個沙箱中的行程也會繼承一個對 `data/relay-sandbox/` 下每次執行專屬標記檔的唯讀描述符，還握著它的行程會用 `lsof` 找出並殺掉：執行結束時由 host 做，處理掉這次執行時由伺服器做，伺服器被殺後由下一次啟動做。CLI 啟動指令時會關掉繼承來的描述符（Node、Bun 與 Python 都會；Goose 會保留），所以這種方式抓到的較少；少了命令列工具時，就只剩它。這時啟動也無法確定伺服器被殺時留下的執行資料夾裡已經沒有東西在跑，所以會保留它們（見下方）。

只看這次執行自己的設定檔與標記檔，所以你自己的 shell 若只是工作目錄在那個資料夾裡、或任何在這次執行沙箱以外的行程，都不會被動到。啟動時，只有清掃確定被殺的執行沒有東西還在執行，才移除它們留下的東西；否則保留它們的資料夾與標記檔給之後的啟動，也不在任何地方恢復權限（還在執行的行程可能把資料夾換成連結）。Linux 上不需要這些：bubblewrap 把行程樹放進它自己的 PID namespace，host（以及 bubblewrap）一死，namespace 就隨沙箱一起結束，連伺服器被殺也一樣。這**抓不到**的情況：沒有 Xcode 命令列工具時，一個關掉了繼承的描述符、又離開 host 群組的行程。這種殘留會保留 Seatbelt 設定檔中凍結的檔案規則——可編輯模式下它仍能寫工作目錄、附件與那次執行的狀態資料夾，讀受保護路徑以外的一切——但它的代理沒了，所以它連**任何**網路主機都到不了（Seatbelt 只允許代理那個現在已關閉的 localhost 連接埠），包括 Harness Relay 自己的 API。它的寫入會在電腦下次重開時停止。

**需要安裝什麼。** macOS 上什麼都不用（Seatbelt 與 `sandbox-exec` 是系統內建）。Linux 上：`bubblewrap`、`socat` 與 `ripgrep`（`sudo apt-get install bubblewrap socat ripgrep`，或 `sudo dnf install …`），以及在 Ubuntu 23.10 以後，[在 Linux 上](#在-linux-上)那段給 `/usr/bin/bwrap` 的 AppArmor 設定檔（bubblewrap 需要非特權 user namespace）。在容器裡，bubblewrap 需要容器允許 user namespace 與一個新的 `/proc`（用過即丟的容器可以：`docker run --security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined`），或改用完全存取、讓容器當沙箱。

**它管不到的事。** 沙箱裡的程式可以**讀**什麼（它幾乎讀得到整台電腦，包含 `~/.ssh` 與 `~/.aws`，受保護路徑除外）；要把祕密留在電腦上靠的是擋網路，這在兩個平台都成立。你允許的模型來源整個可達，所以有心的 agent 仍可能用它把資料帶出去（允許清單是按主機名、不是按流量內容）。macOS 上開了 `allowTlsTrustd` 時的 trustd 服務，如上。Linux 上 agent 需要的 Unix socket（那裡無法只允許一個）。**macOS 上，指令之上每個行程的啟動環境**：agent 行程（`opencode` 等）、relay 沙箱的 host、Harness Relay 伺服器，以及啟動伺服器的 shell（或 npm）——裡面有它們啟動時帶的 API 金鑰，以及 OpenCode 的本機伺服器密碼。指令可以透過 `kern.procargs2` sysctl 讀到祖先的環境（不相關行程的環境 macOS 不給，這是在沙箱外看到的）。所以在 macOS 上，把金鑰排除在 agent 的環境之外，並不能讓 agent 的指令拿不到它，只要伺服器自己的啟動環境裡還有：啟動伺服器時環境裡別放 API 金鑰（Harness Relay 把它們存在作業系統的憑證儲存區）。Linux 上沙箱的 PID namespace 只讓沙箱中的行程樹看得見。要擋掉它得加一條 Seatbelt 規則，而那同時會讓 `ps` 完全無法執行（procargs2 也是取得一個行程命令列的唯一管道），代價太大，所以 Harness Relay 不擋；改由轉接器把自己的祕密排除在 agent 執行的指令的環境之外（OpenCode 把它的伺服器密碼拿掉），而網路封鎖讓這樣讀到的祕密也送不出去。完全存取，它本就不用沙箱，和其他 CLI 一樣。

**確認過**於 2026 年 11 月 10 日：在這台 Mac（macOS 26.6，arm64）上用 `scripts/sandbox-check.ts`，以及在 Linux 上一個用過即丟的 Docker 容器（`node:22-bookworm`，bubblewrap 0.8、socat、ripgrep）裡用同一個腳本。2026 年 11 月 11 日又在 DGX Spark（Ubuntu 24.04，arm64，bubblewrap 0.9）上直接執行、以及在同樣的 Docker 容器裡確認過，也在那裡端到端執行了每個開源 agent 真正的 CLI（唯讀與可編輯，搭配照劇本回答的端點與 loopback 上的 Ollama）。在唯讀與可編輯模式下，沙箱中的行程都無法寫入它被允許的資料夾以外（唯讀時的工作目錄、家目錄、一個類 ssh 資料夾、agent 的設定、任何外部資料夾），讀不到受保護路徑（瀏覽器資料夾、祕密檔與資料庫的替身），連不到不被允許的主機（而且核准流程可用、綁到正確那次執行），用上述每種用戶端都透過代理連到了允許的主機，連不到 Harness Relay 的連接埠或這台電腦自己的位址，也無法透過子行程、symlink、hard link、`git -c core.hooksPath` / 設定的花招、或改寫自己的設定路徑逃出去。兩個規則不同、同時進行的執行互不干擾。被停掉的執行沒留下行程或暫存資料夾，一個想在回合結束後才寫入、已離開 host 群組（重新掛到別處）的 detached 指令被標記掃掉了；由 Node、Python 與 Perl 啟動、關掉所有描述符又離開群組的背景寫入者，在回合結束時依它們的沙箱被掃掉（關掉這項清掃時它們都會在回合後寫入），而另一個更寬的沙箱裡的行程不受影響；而一個替身（代表被殺掉的伺服器留下的行程）在下一次啟動時被掃掉。每項檢查都帶著真實執行用的私有根目錄；一次執行讀得到在其中的自己的設定（Goose 的配置方式），host 暫存資料夾位在被藏起的資料夾下時網路照樣能用（資料路徑很短時），只連線的連接埠透過代理連得到、也不能被監聽（macOS），會解析到這台電腦的名稱會被詢問（伺服器從不查詢它），允許後在連線時被拒絕，而一個工作目錄在 `data/relay-sandbox/` 裡的 shell 在啟動清掃後仍活著。`npm test` 跑離線單元測試（`test/relaySandbox.test.ts`、`test/sandboxProcs.test.ts`），絕不啟動真的沙箱。真的沙箱檢查是另外的 `scripts/sandbox-check.ts`。

## agent 不能讀寫的地方

在完全存取以外的權限，Harness Relay 會讓每個 agent 的沙箱（Cursor 與 Antigravity 沒有沙箱，所以是它們自己的讀取與寫入工具，以 Cursor 的拒絕規則擋得住的、以及 Antigravity 會詢問的呼叫為限：見下文）碰不到這些地方（`src/server/protect.ts`），在 macOS 與 Linux 上：

- **瀏覽器自己的資料夾**：已登入的瀏覽器把送給 Harness Relay 的金鑰（有些瀏覽器還有 cookie）存放在磁碟上的位置：Chrome、Chromium、Edge、Brave、Arc、Vivaldi、Opera、Firefox、LibreWolf、Zen、Orion、Floorp、Waterfox、Helium、DuckDuckGo 與 GNOME Web，以及 Safari 與 WebKit 的資料夾（macOS 上的 `~/Library/…`；Linux 上的 `~/.config/…` 與 `$XDG_CONFIG_HOME/…`、`~/.mozilla`、snap 與 Flatpak 資料夾）。只列出實際存在的，每個也連同它的真實路徑。
- **桌面 app 視窗自己的資料夾**（app 資料夾裡的 `browser/`：macOS 是 `~/Library/Application Support/Harness Relay/browser`，Linux 是 `~/.config/Harness Relay/browser`），它的視窗把 cookie 與金鑰放在這裡；app 以 `RELAY_APP_BROWSER_DIR` 告訴伺服器。
- **Harness Relay 的資料庫**（`relay.db` 與 SQLite 放在它旁邊的檔案，在 `data/` 裡；桌面 app 則在它自己資料夾的 `data` 裡），即使工作目錄包含它也一樣。
- **Harness Relay 自己的暫存資料夾**（`data/tmp`，桌面 app 則是它資料夾裡的 `data/tmp`），Claude Code 一輪的 `--settings` 與 MCP 設定放在這裡等它讀取，Cursor 每一輪的設定資料夾與 Copilot 每一輪的家目錄（它的設定決定它的沙箱，還有帳號登入狀態的副本）也在這裡。若放在每個沙箱都讓指令寫入的系統暫存資料夾，另一個 agent 的指令就能在 Claude Code（或 Copilot）讀取前改掉它們（關掉它的沙箱，或把自己的指令當成 MCP 伺服器，在任何沙箱之外啟動），或讀到 MCP 伺服器的秘密值。每一輪結束時會刪掉它的資料夾；伺服器在某一輪進行中停止時留下的（Claude Code 在端點上執行時，它的設定裡有端點的金鑰），會在伺服器下次啟動時刪掉（`clearRunTmp()`）。

各 CLI 的做法：

- **Claude Code**：`sandbox.filesystem.denyRead` 與 `denyWrite`，以及給它自己的檔案工具（在它的沙箱之外）的 `Read` 拒絕規則。這一輪的 `--settings` 也設定 `filesystem.disabled: false`，勝過關閉檔案隔離的使用者設定。`allowRead`／`allowWrite` 清單會跨設定檔相加，所以當你自己的 Claude Code 設定（它資料夾中的 `settings.json`）或電腦上的受管理設定（`managed-settings.json` 與 `managed-settings.d`）允許的路徑碰到受保護的路徑時，執行不會開始，相對路徑的項目從該設定檔所在的資料夾算起；訊息會指出要移除的項目。（Claude Code 本身（2.1.322）會忽略專案設定中、會打開這一輪 `--settings` 所禁止路徑的 `allowRead` 項目。）
- **Codex**：thread 的 `harness-relay-…` 權限設定檔中，每個路徑一個 `deny` 項目（Windows 除外，它舊的沙箱無法在任何地方禁止讀取）。它的名稱每次執行都不同：Codex 會把它其他設定檔（例如已信任專案的 `.codex/config.toml`）中同名的設定檔合併進來，而那裡更具體的項目（對被禁止的資料夾內的某個資料夾設 `read`）會讓這個路徑重新可讀（用 `codex sandbox` 試過）。DGX Spark 上的 Codex 0.167 無法使用自訂的設定檔：thread 可以開始，但每一輪送出請求時都會失敗（`failed to load workspace requirements: invalid input parameter`；Codex 內建的 `:workspace` 則可以）。遇到這種情況的執行會改用 Codex 舊的沙箱模式重跑，並在伺服器這次執行期間都這樣做：寫入與網路的限制和以前一樣，但沒有禁止清單，所以在那裡 Codex 的指令讀得到瀏覽器的資料夾與資料庫（它們仍然連不到網路，包括 Harness Relay 的 API）。
- **Grok**：它的自訂設定檔 `harness-relay` 的 `deny` 清單。Harness Relay 在每次執行前把它寫進 Grok 自己資料夾（`~/.grok`，或各 CLI 自己的資料夾中的 `grok`）的 `sandbox.toml`，放在 `# >>> harness-relay` 與 `# <<< harness-relay` 之間，檔案的其餘部分保持原樣。Grok 無法套用自訂設定檔時會拒絕啟動；在 Linux 上，它的 `deny` 清單需要 bubblewrap。Grok 的 `workspace` 讓它的指令能寫入整個 Grok 資料夾，而它自己的程式就在那裡（`downloads`、`bin`）：清單也禁止這些，以及 Harness Relay 啟動的程式所在的資料夾。Grok 在沙箱套用後才讀取那裡的設定（Harness Relay 區塊以外的 `sandbox.toml`、`config.toml`、`managed_config.toml`、`requirements.toml`、`trusted_folders.toml`、`permission.toml`、`hooks-paths`），所以無法禁止：Harness Relay 會在每一輪前讀取它們（連結就當作連結；空檔案視同沒有，因為它們不存在時 Grok 的沙箱會建立空的檔案），這一輪改動了其中之一時，就把改動後的版本移到旁邊（`….changed-<時間>`，以改名的方式，不跟著連結走）、把它改回原樣，並讓這一輪失敗並說明；`skills` 資料夾被改動時同樣會回報，但不會改回。同時執行的 Grok 各輪共用第一輪開始前的設定，後開始的一輪會先把另一輪的指令改動的地方改回。在這樣的一輪中，Grok 自己或你對這些檔案做的改動，也會同樣被改回。在這樣的一輪中於 Harness Relay 信任資料夾時，會先把這一輪的指令改動的地方改回，再把信任記錄到這一輪開始時的信任紀錄中，這一輪會保留它。（Grok 設定檔的 `read_only` 是授予讀取，並不會禁止寫入。）在 Linux 上，Grok 會透過 bubblewrap 再執行一次自己的程式來啟動沙箱，所以被禁止的程式根本無法啟動（試過）：在那裡它的程式不禁止，改為檢查：`~/.grok/bin` 中的連結與程式檔案，並在 `data/tmp` 保留一份副本；被改動時，會在另一個沙箱中的一輪啟動它之前、以及每一輪之後，從副本改回原樣，並讓那一輪失敗。
- **Cursor**：這一輪自己的 `cli-config.json` 中的拒絕規則，每個路徑都有 `Read(<路徑>)`、`Read(<路徑>/**)`、`Write(<路徑>)` 與 `Write(<路徑>/**)`（路徑本身，給資料庫的檔案用，以及它底下的一切），和你在帳號的 `cli-config.json` 中自己的拒絕規則放在一起。它們只約束 Cursor 自己的讀取與寫入工具，而 Cursor 是拿寫下來的路徑去比對，分大小寫，也不解析連結：受保護路徑的另一種寫法（換個大小寫，在 macOS 一般不分大小寫的磁碟上）或專案裡指向它的連結都不會被拒絕，它的讀取工具不經詢問就能讀。它的 shell 指令沒有沙箱，所以只能靠詢問擋在這些路徑之外：使用者允許的指令（或 Cursor 團隊允許清單上的指令）讀寫得到它們。
- **Antigravity**：agy 詢問的呼叫若要讀寫這些路徑之一（比對時會解析路上的連結），Harness Relay 不經詢問就拒絕（聊天中會說明原因），而拒絕會結束它的這一輪，所以這一輪就在那裡結束。agy 只在讀取工作區以外的檔案時才詢問，經由連結讀到工作區以外的也算（它會解析連結；以 `agy` 1.5.6 確認過），所以這樣讀取受保護的路徑也會被拒絕；轉接器看不出路徑的讀取會詢問。Harness Relay 看不到的，是 agy 不經詢問、在工作區內的讀取。它的 shell 指令沒有沙箱，所以只能靠詢問擋在這些路徑之外：使用者允許的指令讀寫得到它們。
- **Copilot**：這一輪沙箱政策的 `deniedPaths`（這一輪自己家目錄中 `settings.json` 的 `sandbox.userPolicy.filesystem`），它的指令與它自己的檔案工具都遵守（它的檔案工具碰到這種路徑會自己拒絕，不經詢問：`Is a sandbox denied path.`）；每一輪前的政策檢查會確認每一個都列在裡面。Copilot 詢問的呼叫若指名其中之一（比對時會解析路上的連結），Harness Relay 也會不經詢問就拒絕，而拒絕會結束它的這一輪，所以這一輪就在那裡結束。
- **Muse Code**：在這一輪自己的 `settings.json` 裡，Harness Relay 權限設定檔（`harness-relay`，由 `:ask-me` 延伸）的 `filesystem` 中，每個路徑一條 `"deny"`，檔案與資料夾都可以，存不存在都行。它對 Muse 自己的檔案工具與沙箱都有效（在 macOS 與 Linux 上試過：`read_file` 讀受保護的檔案被拒絕，沙箱裡的 `cat` 則以 `Operation not permitted` 失敗）。替不存在的路徑寫 `"read"` 或 `"write"` 規則會讓 Muse 拒絕執行（「cannot be enforced」），所以只用 `deny`；Muse 無法套用的設定檔會以關閉的方式失敗。Muse 詢問的呼叫若指名受保護的路徑，Harness Relay 也會不經詢問就拒絕。Muse 會把規則裡的 `*`、`?` 與 `[` 當成樣式（見下文）。
- **開源 agent**（OpenCode、Goose、Cline、OpenHands、Pi）：在 [Harness Relay 自己的沙箱](#harness-relay-自己的沙箱)裡，對相同的路徑以字面名稱設 `denyRead` + `denyWrite`；agent 的 config 路徑也設 `denyWrite`，這樣一次執行就不能放寬它下一次執行。

在 Mac 上以可編輯模式對 Claude Code、Codex 與 Grok 都試過：用 shell 列出 `~/Library/Application Support/Firefox`、讀取 `data/relay.db` 都以 `Operation not permitted` 失敗，用 Claude Code 的 Read 工具或 Grok 的檔案工具讀取資料庫會被拒絕，而在工作目錄中寫入可以。Claude Code 的 Read 工具讀取 Firefox 資料夾中的檔案（含空格的路徑）也會被拒絕。Grok 的指令無法寫入 `~/.grok/downloads`，也無法改名 `~/.grok/bin`（在這之前可以），在 `~/.grok/config.toml` 後面附加內容則被 Grok 自己拒絕；它的 sessions 仍可寫入。在 Mac 上，Copilot 的指令讀不到受保護的路徑，它的檔案工具也會自己拒絕。

它涵蓋不到的：無法使用自訂設定檔的 Codex（見上文）；沒有沙箱的 Cursor 與 Antigravity 指令，以及它們的 hook 與 MCP 伺服器；拿到受保護路徑另一種寫法或指向它的連結的 Cursor 讀取與寫入工具；Antigravity 不會詢問的工作區內讀取（例如工作目錄裡的受保護路徑）；Muse Code 自己的 hook 與 MCP 伺服器（它們是否在它的沙箱裡執行，沒有確認過）；資料夾不在清單上的瀏覽器（新的、可攜版，或用 `--user-data-dir` 放在別處的 Chrome）；使用者允許在沙箱外執行的指令；CLI 在沙箱外執行的東西，例如 Claude Code 的 hooks 與本機 MCP 伺服器，以及 Copilot 的 MCP 伺服器（見[沙箱管不到的事](#沙箱管不到的事)）；專案自己的 Claude Code 設定（`.claude/settings.json`、`.claude/settings.local.json`），可編輯模式下其他 agent 能寫入它們，而下一輪 Claude Code 會採用其中的 hooks、`sandbox.excludedCommands` 與 `network.allowUnixSockets`；Grok 在它資料夾中自己維護的 plugin 資料夾（`marketplace-cache`、`installed-plugins`、`bundles`、`bundled`），它的指令能為之後完全存取的執行改動它們；某個指令在它那一輪結束後還留著執行的行程對 Grok 設定所做的改動，下一輪會照它看到的樣子接受；完全存取；原生 Windows。名稱含 `*`、`?` 或 `[` 的受保護路徑，沙箱會把它當成樣式，因此完全存取以外的執行會拒絕開始，並指出是哪一個。

工作目錄包含 Harness Relay 本身（它的資料夾或資料資料夾；平行模式的 worktree 位於資料資料夾內，不受影響）或語音輸入的資料夾（`data/voice`，或 `RELAY_VOICE_DIR` 指定的位置，在它裡面的資料夾也一樣：Harness Relay 會在沙箱外執行那裡的引擎），或決定 agent 怎麼執行的地方時，也會拒絕可編輯模式：你的家目錄（裡面的專案不受影響）、CLI 自己的資料夾（`~/.claude`、`~/.claude.json`、`~/.codex`、`~/.grok`、`~/.cursor`、`~/.gemini`（Antigravity 的，或某個帳號的 `.gemini`）、`~/.copilot`（Copilot 的）、Muse Code 的設定與資料資料夾（`~/.config/muse`、`~/.local/share/muse`，或某個帳號的），或它們的環境變數指定的位置——Cursor 的設定放在 `$XDG_CONFIG_HOME/cursor` 時也包括那裡；即使如此，`~/.cursor` 仍會被拒絕；不論它的設定在哪裡，Cursor 在 Linux 與 Windows 上保存登入的 `$XDG_CONFIG_HOME/cursor`（沒有設定時是 `~/.config/cursor`）與 `%APPDATA%\Cursor` 也會被拒絕）、Harness Relay 給各 CLI 的資料夾，或 CLI 程式所在的資料夾；包含它或位於它之內都算。agent 在那裡不經詢問就能修改檔案，也就能改動 Harness Relay 的程式碼、CLI 的設定或程式，或你的 shell 設定。對話在建立、排程或改成這樣時會被拒絕（在建立不存在的資料夾之前），每一輪開始時也會。唯讀模式在那裡仍可使用，因為它寫入前會詢問（Codex 則完全不能寫）。要開發 Harness Relay 本身，請從另一個資料夾執行你使用的那份 Harness Relay。

## 各平台

| | macOS | Linux | Windows | WSL2 |
| --- | --- | --- | --- | --- |
| **Codex** | ✅ Seatbelt | ✅ bubblewrap + seccomp | ✅ 自己的沙箱（見下文） | ✅ Linux 的沙箱 |
| **Claude Code** | ✅ Seatbelt | ✅ bubblewrap + socat | ❌ 指令在沙箱外執行 | ✅ Linux 的沙箱 |
| **Grok** | ⚠️ Seatbelt，但擋不了網路 | ✅ Landlock + seccomp，Harness Relay 的執行還要 bubblewrap | ❌ 文件中沒有列出 | 未驗證 |
| **Cursor** | ❌ ACP 模式下沒有 | ❌ ACP 模式下沒有（沒有試過） | ❌ ACP 模式下沒有（沒有試過） | ❌ ACP 模式下沒有（沒有試過） |
| **Antigravity** | ❌ 不開啟：透過 ACP 時，它自己的沙箱讓指令寫不進工作目錄 | ❌ 不開啟（試過：每個指令都詢問） | ❌ 不開啟（試過：每個指令都詢問） | ❌ 不開啟（沒有試過） |
| **Copilot** | ✅ 自己的沙箱（Seatbelt）；在 Harness Relay 的執行中可以連網 | ✅ 自己的沙箱（bubblewrap），前提是 slirp4netns、network namespace 等都備齊（見下文；缺少時每個指令都會失敗，失敗就關起來）；指令連不到這台電腦的 loopback | ✅ 自己的沙箱（行程容器；在 Windows 11 arm64 上試過） | 沒有試過 |
| **Muse Code** | ✅ Seatbelt | ✅ 它自帶的 bubblewrap（試過） | ❌ 完全存取以外的權限不執行任何指令：它的 ACP 模式在那裡不用沙箱，完成它自己的設定（`muse sandbox windows setup`，試過）後也一樣；指令以關閉的方式失敗 | 沒有試過 |
| **開源 agent**（Harness Relay 自己的沙箱） | ✅ Seatbelt | ✅ bubblewrap + socat + ripgrep，加上 seccomp（x64/arm64） | ❌ 完全存取以外拒絕執行（在 sandbox-runtime 還是 alpha） | ✅ Linux 的沙箱 |

Harness Relay 本身在這三種平台上都能執行。在原生 Windows 上只有 Codex 與 Copilot 的沙箱裝好就能用，Muse Code 的則要先完成它自己的一次性設定；開源 agent 在完全存取以外拒絕在那裡執行（請在 WSL2 裡執行它們）。在 Harness Relay 的執行中，Cursor 與 Antigravity 在哪個平台上都沒有沙箱。

### macOS

- Claude Code、Codex 與 Grok 都使用 macOS 內建的 Seatbelt，不需要另外安裝。
- **Cursor** 在 Harness Relay 的執行中不套用沙箱（以 `cursor-agent` 2026.11.11 試過）：在完全存取以外的權限，它執行的每個指令都要詢問（Cursor 團隊允許清單上的除外），使用者允許的指令則以使用者的完整權限執行，包括連網。
- **Antigravity** 有自己的終端機沙箱，在 macOS 上還會擋網路，但 Harness Relay 不開啟它：在 `agy` 1.5.6 中透過 ACP 時，它讓沙箱中的指令只能寫暫存資料夾，在工作目錄中哪裡都寫不進去。在完全存取以外的權限，它執行的每個指令都要詢問，使用者允許的指令則以使用者的完整權限執行，包括連網。
- **Copilot** 也透過它自己的沙箱使用 Seatbelt，Harness Relay 在完全存取以外會開啟它：不需要另外安裝。以 `copilot` 1.0.109 試過：指令寫到工作目錄以外會以 `Operation not permitted` 失敗，受保護的路徑也讀不到。Harness Relay 給它的政策讓指令可以連網，也連得到這台電腦的 loopback（試過：可編輯模式下，Copilot 執行的 `curl http://127.0.0.1:…` 得到了回應）。
- **Muse Code** 使用 Seatbelt，不需要安裝任何東西：在完全存取以外的權限，它的指令只能寫入工作目錄與暫存資料夾，連到的每個主機都會詢問（以 `muse` 1.4.18 試過）。
- **Grok 在 macOS 上擋不了網路。** 它的文件說，封鎖它所執行指令的網路只在 Linux 上（透過 seccomp）生效，在 macOS 上沒有作用，所有設定檔都一樣，`read-only` 和 `strict` 也不例外。在任何平台上，Grok 自己做的事（網路搜尋、讀網頁、模型的 API）都不會被擋。
- runtime socket 是 symlink 時，Grok 的 `read-only` 與 `strict` 設定檔可能無法啟動（見上文；兩者都試過）。
- Claude Code 的文件列出在它的 Seatbelt 沙箱中會失敗的事：`gh`、`gcloud` 和 `terraform` 的 TLS 驗證可能會失敗；`open`、`osascript` 和在瀏覽器中登入會被擋（Apple Events）；走 SSH 的 git 會失敗（它經由沙箱 proxy 的通道在 macOS 上無法驗證身分）；指令要監聽或連到 localhost 的 port，必須設定 `network.allowLocalBinding`。

### Linux

- **Claude Code** 需要 `bubblewrap` 與 `socat`（`sudo apt-get install bubblewrap socat`，或 `sudo dnf install bubblewrap socat`）。要連 Unix socket 也一起擋，需要 `npm install -g @anthropic-ai/sandbox-runtime` 提供的 seccomp 過濾器。每個指令都有自己的 localhost，所以連不到這台電腦 localhost 上的伺服器。
- **Codex** 使用 bubblewrap 與 seccomp。它採用 `PATH` 上第一個（工作目錄以外的）`bwrap`，找不到就改用它自己附帶的，並在啟動時顯示警告。它舊的 Landlock 程式碼（`features.use_legacy_landlock`）在限制檔案的政策下會被拒絕。
- **Grok** 使用 Landlock，需要 kernel 5.13 以上。kernel 6.2（Landlock ABI 3）以前（Ubuntu 22.04 與 Debian 12 預設的 kernel 都更舊），指令仍能用 `truncate` 截短可寫入路徑以外的檔案。有 `deny` 清單的自訂設定檔也需要 bubblewrap，所以 Harness Relay 在完全存取以外的執行都需要（它們的清單一定有它的資料庫）。它的文件也說，`workspace`、`read-only` 與 `strict` 在 Linux 上「without verified read-only mounts」時會拒絕啟動（這些掛載讓 Grok 自己的設定與 hook 無法被寫入）。網路封鎖（`restrict_network`）使用 seccomp，在 Linux 上有效。
- bubblewrap 需要 unprivileged user namespace。Ubuntu 從 23.10 起用 AppArmor 限制它，這可能讓 bubblewrap 無法運作；Claude Code 的文件說，這時要為 `/usr/bin/bwrap` 加上 AppArmor 設定檔，其他位置的 `bwrap` 則用 `sysctl` 解除限制。
- **Cursor** 在這裡什麼都不需要，因為它的 ACP 模式在 Linux 上也不套用沙箱（從它的程式碼看；沒有在 Linux 上試過）。它的指令只靠詢問把關。
- **Antigravity** 在這裡也什麼都不需要：Harness Relay 不開啟它的沙箱（在 Linux 上試過：每個指令都詢問）。它的指令只靠詢問把關。
- **Copilot** 的沙箱使用 bubblewrap 0.5 以上，除此之外還需要 slirp4netns、util-linux 2.35 以上（`unshare`、`nsenter`）、iproute2、`iptables` 與 `ip6tables`（以及 `iptables-restore` 與 `ip6tables-restore`）、`/dev/net/tun`，以及 unprivileged user namespace 與 network namespace；Ubuntu 24.04 以 `kernel.apparmor_restrict_unprivileged_userns=1` 擋住這些 namespace（[在 Linux 上](#在-linux-上)那段給 `/usr/bin/bwrap` 的 AppArmor 設定檔對它夠不夠，沒有確認過）。缺少它們時，Copilot 在沙箱中執行的每個指令都會失敗，失敗就關起來，並附上 Copilot 自己的原因（`Cannot start sandboxed command: Bubblewrap … private network is unavailable … requires 'slirp4netns'`）：它的這一輪會繼續，沒有任何東西在沙箱外執行，它的檔案工具也仍遵守政策（在 DGX Spark 上試過）。這些都備齊之後（在那裡以 slirp4netns 1.2.1 與設為 0 的 sysctl 試過），它在 Harness Relay 的執行中和在 macOS 上一樣能用：指令只能寫入各工作目錄與暫存資料夾（它們以外的資料夾在 bubblewrap 裡根本不存在：`No such file or directory`），受保護的路徑也會被拒絕。它的指令連得到網際網路，但連不到這台電腦自己 loopback（`127.0.0.1`）上的服務，因為它們的網路是 slirp4netns 自己的：在那裡，連到沙箱外啟動的本機資料庫或 dev server 的測試會失敗，除非改用這台電腦的區域網路位址（伺服器也要在那裡接受連線），而只聽 loopback 的 Harness Relay 自己的伺服器也連不到。Harness Relay 給它的唯讀路徑，只限這一輪開始時已經存在的，因為 bubblewrap 會拒絕在不存在的路徑上啟動。
- **Muse Code** 自帶 bubblewrap，所以不需要安裝任何東西（在 DGX Spark 的 Ubuntu 24.04 上試過）。它會在工作目錄裡替它掛載覆蓋的路徑留下空的 `.agents`、`.muse`、`.hg`、`.sl` 與 `.eden` 資料夾，沙箱執行中被停止的回合還會在裡面留下 `.tbh-sandbox-mountpoint.<pid>` 標記。一輪留下的這些，Harness Relay 會在那個資料夾裡最後一次執行結束後刪除，前提是它們是空的，或只有已不在執行的沙箱程序留下的標記；裡面有其他東西時就保留。

### Docker 與 dev container

容器常讓 bubblewrap 無法運作：它們可能封鎖 bubblewrap 需要的 user namespace，或不允許掛載新的 `/proc`。

- **Claude Code**：`sandbox.enableWeakerNestedSandbox: true` 讓它能在 unprivileged 容器中運作（沿用容器既有的 `/proc`），但隔離較弱。
- **Codex** 在 bubblewrap 無法建立 user namespace 時，會在啟動時顯示警告。它的文件建議讓容器提供 bubblewrap 需要的條件，或在容器中以 `--sandbox danger-full-access` 執行 `codex`，讓容器本身當作沙箱。
- **Grok**：Landlock 本身不需要 user namespace，但 `deny` 清單需要 bubblewrap，內建設定檔的唯讀掛載（見上方 Linux）可能也需要 mount namespace（未驗證）。沒有在容器中試過。
- **Cursor** 沒有會被容器弄壞的沙箱：在那裡，容器本身就是它的指令唯一的隔離（沒有試過）。
- **Antigravity**：同上，因為 Harness Relay 不開啟它的沙箱（沒有試過）。
- **Copilot**：它的 bubblewrap 沙箱在容器中同樣需要上方 Linux 列出的條件，包括 user 與 network namespace 以及 `/dev/net/tun`（沒有試過）。
- **Muse Code**：它的 bubblewrap 需要 bubblewrap 需要的東西（沒有試過）。

**這個 repo 的 dev container**（`.devcontainer/`，給 [GitHub Codespaces](codespaces.zh-TW.md) 用）會給 bubblewrap 它需要的條件：`securityOpt` 的 `seccomp=unconfined`、`apparmor=unconfined` 和 `systempaths=unconfined`，以及給 Copilot 沙箱的 TUN 裝置（`--device=/dev/net/tun`）；沒有用 `privileged`。2026 年 11 月 14 日在 codespace 裡試過（Debian 12、kernel 6.8、x86_64、2 核）：

- 沒有這些選項時，`bwrap` 會以 `No permissions to create new namespace` 停下（Docker 的 seccomp 設定檔），所以完全存取以下的每個指令都會失敗。
- 有了這些選項，`scripts/sandbox-check.ts` 的 51 項檢查全數通過；Codex 的沙箱（`codex sandbox`，workspace-write）寫得了工作目錄，寫不了 home 資料夾，也連不上網路；Copilot 的沙箱在 Harness Relay 的編輯模式對話裡讀不到資料庫（`Permission denied`），寫到 home 資料夾和 Harness Relay 資料夾的內容只留在沙箱裡，沒有寫到磁碟上。
- Claude Code 的沙箱（與 Harness Relay 自己的沙箱用同一個 sandbox runtime）沒有在登入狀態下實際跑過。

### Windows

- **Codex** 有自己的沙箱，分成三種實作（`config.toml` 中的 `[windows] sandbox = "…"`）：
  - `mxc`，它的文件推薦的一種：不需要管理員設定，也不必建立額外的帳號或防火牆規則。需要 Windows 11 24H2（build 26100.9278）或 25H2（build 26200.9278）以上。指令可以連到 loopback 上的服務；指令結束時，它留下的行程也會跟著結束（所以在背景啟動的 dev server 會一起停掉）。
  - `elevated`，`mxc` 無法使用時它的文件優先建議的舊式備案：由管理員設定一次（UAC 提示、建立本機使用者與群組、防火牆規則、這些使用者的登入權限）；之後指令以這些權限較低的使用者執行，不需管理員權限。IT 可以事先從有管理員權限的行程執行 `codex sandbox setup --elevated`。
  - `unelevated`，第二個舊式備案：從你的帳號衍生出受限的 token，以檔案權限作為邊界，用在無法做 elevated 設定的時候。網路隔離較弱，也無法禁止讀取某個路徑。
  - 建議使用 Windows 11；Windows 10 只是盡量支援，且需要 1809 以上。記錄檔在 `CODEX_HOME/.sandbox/sandbox.log`。
- **Claude Code** 在原生 Windows 上沒有沙箱：指令在沙箱外執行。請改用 WSL2。
- **Grok**：它的文件只列出 macOS 與 Linux。Grok 在 Windows 上是會在沒有沙箱的情況下執行（它的文件說無法套用的內建設定檔只會顯示警告，見下文），還是拒絕啟動，沒有驗證過。
- **Cursor** 在這裡也沒有沙箱。Harness Relay 在 Windows 上沒有受保護的路徑，所以在那裡它的讀取與寫入工具也沒有針對它們的拒絕規則（沒有用真正的 CLI 試過）。
- **Antigravity**：同樣沒有；Windows 上沒有受保護的路徑，所以 Harness Relay 在那裡不會因為它們拒絕它的任何讀寫（用真正的 CLI 試過：每個指令都詢問，並以 PowerShell 執行）。
- **Copilot** 在這裡有自己的沙箱，是一個行程容器，Harness Relay 在完全存取以外會開啟它，和 macOS 上一樣。以 `copilot` 1.0.109 在 Windows 11 Pro（arm64，build 26200）上試過：指令寫到工作目錄以外會以 `Access to the path … is denied` 失敗，第二個工作目錄可以寫入，當作受保護路徑交給它的檔案也被拒絕。Harness Relay 在 Windows 上沒有受保護的路徑，和每個 CLI 一樣，所以它的政策在那裡不禁止任何路徑；沙箱自己的讀取政策仍讓指令只能讀各工作目錄、工具與系統資料夾。它在那裡用 PowerShell。用 npm 安裝時，Copilot 在那裡是 npm 的 `copilot.cmd`，Harness Relay 會改為啟動它實際執行的程式（`winLaunch.ts`；試過：一輪回覆、一次拒絕、一次停止）。其他 Windows 版本沒有試過。
- **Muse Code** 在 Windows 上有自己的沙箱，要由使用者以系統管理員權限執行一次設定（會出現 UAC 提示；以 SYSTEM 執行時它會拒絕：「runtime user SID is not a supported account SID」）：`muse sandbox windows setup` 會建立兩個本機帳號（`muse-sbx-r1`、`muse-sbx-u1`）與 `MuseSandboxUsers` 群組、它們的權限、不讓它們連線、監聽與接受連線的防火牆（WFP）過濾規則，以及 `C:\ProgramData\muse`（裡面有這些帳號的密碼），每台電腦一次；`muse sandbox windows check` 會說明是否已完成（之前是 `setup_required`，「sandbox users are not ready」；之後是 `ready`）。Muse 沒有移除它們的指令。但 Harness Relay 使用的 muse 1.4.18 ACP 模式不用這個沙箱：設定完成後（在 Windows 11、arm64 上試過），完全存取以外的權限下每個指令仍然在開始前失敗（「sandbox enforcement unavailable: windows_elevated setup_required…」；它的追蹤記錄寫著 `sandbox.prepare … platform="none"`），每種網路模式都一樣，直接驅動 `muse acp`、用 Muse 的預設設定時也一樣。指令會以關閉的方式失敗，所以沒有指令在沙箱外執行。它的檔案工具、網路擷取與完全存取都能用。它在那裡的 shell 工具是 PowerShell。Harness Relay 在 Windows 上不保留受保護的路徑，所以 Muse 在那裡沒有拒絕規則（反正它也會拒絕寫在規則裡的 Windows 路徑）。Muse 透過 `SystemDrive` 找到 `C:\ProgramData`，Harness Relay 會連同其他環境變數一起傳給它；沒有它時，連 `check` 都會說 `setup_required`。

### WSL

- **WSL2**：Codex 與 Claude Code 使用它們的 Linux 沙箱，前提相同（bubblewrap；Claude Code 還需要 `socat`）。Grok 的 Landlock 能不能用，要看 WSL2 的 kernel（未驗證）。Cursor 與 Antigravity 在這裡也沒有沙箱。Copilot 的 Linux 沙箱沒有在 WSL2 中試過。Muse Code 在這裡沒有試過。
- **WSL1** 無法建立 user namespace。Claude Code 的沙箱需要 WSL2；Codex（從 0.115 起）會拒絕執行需要 bubblewrap 的沙箱指令。

## 開啟各個沙箱

以下依平台列出開啟各 CLI 沙箱的指令與設定，以及確認它已開啟的方法。這些是給你自己使用各 CLI 時用的；[下一個表格](#harness-relay-的執行從哪裡讀這些設定)說明 Harness Relay 的執行會採用其中哪些。Linux 的指令使用 `apt-get`（Debian、Ubuntu），旁邊附上 `dnf`（Fedora）。

| | macOS | Linux | Windows | WSL2 | 容器 |
| --- | --- | --- | --- | --- | --- |
| **Claude Code** | 只需設定 | 先裝 `bubblewrap` 與 `socat`，再設定 | 沒有沙箱：改用 WSL2 | 同 Linux | 同 Linux，再加 `enableWeakerNestedSandbox` |
| **Codex** | 只需設定 | 設定（建議安裝 `bubblewrap`） | `[windows] sandbox` | 同 Linux | 讓容器提供 bubblewrap 需要的條件，或讓容器本身當作沙箱 |
| **Grok** | 只需設定 | kernel 5.13 以上且有 Landlock，Harness Relay 的執行還要 `bubblewrap`，再設定 | 文件中沒有：改用 WSL2 | 同 Linux，前提是它的 kernel 有 Landlock（未驗證） | 沒有試過 |
| **Cursor** | 沒有可開啟的：它的 ACP 模式會忽略 `--sandbox` 與 `sandbox.mode` | 同左（沒有試過） | 同左（沒有試過） | 同左（沒有試過） | 同左（沒有試過） |
| **Antigravity** | Harness Relay 的執行沒有可開啟的：透過 ACP 時，它的沙箱（`enableTerminalSandbox`）讓指令寫不進工作目錄 | 同左（試過） | 同左（試過） | 同左（沒有試過） | 同左（沒有試過） |
| **Copilot** | `--sandbox`（只靠設定不會失敗就關起來） | bubblewrap 0.5 以上、slirp4netns、util-linux 2.35 以上、iproute2、iptables、`/dev/net/tun` 與 unprivileged user 及 network namespace，再加 `--sandbox` | `--sandbox`（在 Windows 11 上試過） | 同 Linux（沒有試過） | 同 Linux（沒有試過） |
| **Muse Code** | 沒有要開啟的：除非給了 `--disable-sandbox`，否則就是開著 | 不需要安裝：它的 bubblewrap 隨它附上（試過） | 沒有能幫上忙的：它的 ACP 模式在那裡不用沙箱，執行 `muse sandbox windows setup` 後也一樣（試過） | 沒有試過 | 沒有試過 |

### Harness Relay 的執行從哪裡讀這些設定

| | Harness Relay 的執行會讀的設定 | Harness Relay 自己設定的部分 |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json`，或[各 CLI 自己的資料夾](user-guide.zh-TW.md#agent-的-session各-cli-自己的資料夾與-agentsview)中的 `claude/settings.json`；專案的 `.claude/settings.json` 與 `.claude/settings.local.json`；managed settings | 完全存取以外的權限（原生 Windows 除外）設定 `sandbox.enabled`、`failIfUnavailable`、`autoAllowBashIfSandboxed: false`、上述的詢問規則與受保護的路徑（`denyRead`、`denyWrite`、`Read` 拒絕規則，見下文）；你其他的 `sandbox` 鍵，例如 `network.allowedDomains`，會照原樣保留（沒有試過） |
| Codex | `~/.codex/config.toml`，或各 CLI 自己的資料夾中的 `codex/config.toml` | 完全存取以外的權限，thread 使用 `harness-relay-…` 權限設定檔（所以你的 `sandbox_mode` 與 `[sandbox_workspace_write]` 不會被採用）；在 Windows 上依權限設定沙箱模式，可編輯模式再加上 `network_access = false`；其他鍵不會設定，例如 `[windows] sandbox` |
| Grok | 啟動 Harness Relay 時環境中的 `GROK_SANDBOX`；沒有的話，是 `~/.grok/config.toml`，或各 CLI 自己的資料夾中 `grok/config.toml` 的 `[sandbox] profile` | 唯讀與可編輯模式設定 `GROK_SANDBOX=harness-relay`（Windows 上為 `workspace`），以及 Grok 自己資料夾中 `sandbox.toml` 的 `[profiles.harness-relay]` 區塊（見下文）；完全存取時，你設定的會生效 |
| Cursor | 它設定資料夾中的 `cli-config.json`（`~/.cursor`、各 CLI 自己的資料夾中的 `cursor`，或其他帳號的家目錄），複製到每一輪自己的設定資料夾；絕不讀專案的 `.cursor/cli.json`（`--disable-project-configs`） | 在每一輪的設定資料夾中：沒有允許規則，你的拒絕規則再加上（完全存取以外的權限）受保護的路徑（唯讀模式還有 `Write(**)`），`approvalMode: "allowlist"`（完全存取：`"unrestricted"`，並加 `--force`）；`sandbox.mode` 透過 ACP 沒有作用 |
| Antigravity | 它 `.gemini` 資料夾（`~/.gemini`、各 CLI 自己的資料夾中的 `antigravity/.gemini`，或其他帳號的家目錄）裡 `antigravity-cli` 中的 `settings.json`，其中只有 `model`、`modelProvider`、`gcp` 與 `customModelsConfig` 會放進每一輪自己的設定資料夾（`--cli_dir_name`），agy 改讀那裡；它的 `permissions.allow` 與 `permissions.deny` 透過 ACP 沒有作用 | 在每一輪的設定中：`toolPermission: "request-review"`（完全存取：`"always-proceed"`，並加 `--dangerously-skip-permissions`）、`agentMode: ""`、完全存取以外的 `allowNonWorkspaceAccess: false`，有 Gemini API key 或不是預設帳號時再加 `modelProvider: "gemini"`；你的其他設定（`enableTerminalSandbox`、權限、信任的工作區、狀態列……）不會進到這一輪 |
| Copilot | 它家目錄（`~/.copilot`、`COPILOT_HOME`、各 CLI 自己的資料夾中的 `copilot`，或其他帳號的家目錄）中的 `settings.json`，其中只有它的模型與服務、它的 proxy、是否把 session 同步到 GitHub（`remoteExport`）與是否自動更新（`autoUpdate`、`autoUpdatesChannel`），以及它自己載入的內容會放進每一輪自己的家目錄（`COPILOT_HOME`），Copilot 改讀那裡；絕不帶入它的 `sandbox`、`allowedUrls`、`defaultPermissionMode`、記住的核准（`permissions-config.json`）或信任的資料夾；專案的 `.github/copilot/settings.json` 無法放寬沙箱 | 在每一輪的家目錄中：完全存取以外的權限設定 `--sandbox` 與上述的 `sandbox` 區塊，每次送出 prompt 前以 `/sandbox policy` 檢查；session 的模式設為 agent，並關閉它的 allow-all；完全存取：`--allow-all`、開啟 allow-all 與 `sandbox.enabled: false` |
| Muse Code | 它設定資料夾裡的 `settings.json`（`$XDG_CONFIG_HOME/muse`，沒有設定時是 `~/.config/muse`；各 CLI 自己的資料夾裡的 `muse/config/muse`，或另一個帳號的家目錄），每一輪自己的設定資料夾只保留允許清單上的（`MUSE_KEPT_SETTINGS`：模型、推理強度、provider、endpoint transport、MCP 伺服器、hook、plugin、skill、context 與工具……；不保留 `permissions`、自訂 agent、`run`、runtime capabilities 或 feature config），並拿掉不載入的 MCP 伺服器與 hook | 每一輪的設定裡：`permissions` 是設定檔 `harness-relay`（由 `:ask-me` 延伸，每個受保護的路徑一條 `"deny"`），完全存取時則是 `:unrestricted`；完全存取以外，一個把工作目錄標成不受信任的 `trust.json`；`MUSE_DISABLE_APPROVAL_JUDGE=1`；唯讀時 `--disable-write`，完全存取時 `--disable-sandbox --trust-workspace`；session 模式（`promptUnmatched`、`onRequest`、`allowAll`）；你自己的設定檔與信任的資料夾不會進到這一輪 |

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

**Antigravity。** Harness Relay 的執行沒有可開啟的沙箱：透過 ACP 時（`agy` 1.5.6），`enableTerminalSandbox`（或 `--sandbox`）會讓它的指令寫不進工作目錄。在那裡管住它的指令的是詢問，和 Cursor 一樣。

**Copilot。**

```sh
copilot --sandbox    # 這個 session：在它的沙箱中執行，否則就不執行
```

- 在 session 中，`/sandbox policy` 會顯示生效中的政策（`Effective sandbox policy`、`Allow sandbox bypass: …`，以及它列出的路徑），沙箱關閉時則顯示 `Command sandboxing is disabled, so no policy is in force…`。
- 只在 `~/.copilot/settings.json` 中開啟的沙箱（`sandbox.enabled`），在無法執行它的電腦上會被略過；只有 `--sandbox` 會失敗就關起來。
- Harness Relay 在完全存取以外的權限，已經讓 Copilot 在它的沙箱中執行，每一輪都用自己的政策；你自己的 `sandbox` 設定不會進到這些執行。

**Muse Code。** 沒有要開啟的：Seatbelt 是 macOS 內建的，除非給了 `--disable-sandbox`，Muse 都會在它的沙箱裡執行指令（Harness Relay 只在完全存取時給這個旗標）。

### 在 Linux 上

先確認沙箱需要的條件（這些檢查不是出自各 CLI 的文件，也沒有試過）：

```sh
bwrap --ro-bind / / true && echo "bubblewrap works"    # Claude Code、Codex、Grok 的 deny 清單
uname -r    # Grok：5.13 以上（6.2 以上才擋得住 truncate）
cat /sys/kernel/security/lsm    # Grok：清單中要有 landlock
sysctl kernel.apparmor_restrict_unprivileged_userns    # Ubuntu 23.10 以後：1 = 受限
bwrap --version    # Copilot：0.5 以上
unshare --version    # Copilot：util-linux 2.35 以上
command -v slirp4netns ip iptables ip6tables iptables-restore ip6tables-restore    # Copilot：每個都要找得到
ls -l /dev/net/tun    # Copilot：要存在
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

**Antigravity。** 同樣不需要安裝任何東西：Harness Relay 不開啟它的沙箱（在 Linux 上試過）。

**Copilot。** 它的沙箱需要上面檢查中提到的程式，以及 unprivileged user namespace 與 network namespace。在 Debian 與 Ubuntu 上（套件名稱；沒有在全新的系統上試過）：

```sh
sudo apt-get install bubblewrap slirp4netns iproute2 iptables
```

Ubuntu 23.10 以後會限制這些 namespace（`kernel.apparmor_restrict_unprivileged_userns=1`，Ubuntu 24.04 也是）；上面的 AppArmor 設定檔對 Copilot 夠不夠，沒有確認過：在 DGX Spark 上改為解除限制（`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`，直到下次重新開機）。缺少這些時，Copilot 在沙箱中執行的每個指令都會失敗，並附上 Copilot 自己的原因。都備齊時，它的沙箱在 Harness Relay 的執行中能用（在 DGX Spark 上試過），但它的指令連不到這台電腦 loopback 上的服務，例如本機的資料庫或 dev server：它們 network namespace 裡的 `127.0.0.1` 不是主機的，請改用主機的區域網路位址。

**Muse Code。** 不需要安裝任何東西：它自帶 bubblewrap（在 Ubuntu 24.04 上試過）。

### 在 Docker 與 dev container 中

- **Claude Code**：在 unprivileged 容器中，於 `sandbox` 底下加上 `"enableWeakerNestedSandbox": true`；隔離會較弱。
- **Codex**：讓容器提供 bubblewrap 需要的條件（user namespace、它自己的 `/proc`、seccomp），或在容器中以 `codex --sandbox danger-full-access` 執行，讓容器本身當作沙箱。它的文件沒有列出容器要用的旗標。
- **Grok**：沒有試過；上面 Linux 的檢查在容器中同樣適用。
- **Cursor**：不需要設定；容器就是它的指令唯一的沙箱（沒有試過）。
- **Antigravity**：同上（沒有試過）。
- **Copilot**：沒有試過；上面 Linux 的前提在容器中同樣適用（`/dev/net/tun` 與 network namespace 也是）。
- **Muse Code**：上面 Linux 的檢查在容器裡同樣適用（沒有試過）。

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

**Muse Code**：它的設定能完成（試過），但 Harness Relay 使用的 muse 1.4.18 ACP 模式不用它設定好的沙箱，所以設定後完全存取以外的權限仍不會執行指令：

```powershell
muse sandbox windows check    # 完成設定前是 setup_required，之後是 ready
muse sandbox windows setup    # 建立它的沙箱帳號與防火牆過濾規則（UAC）
```

**Claude Code 與 Grok** 在原生 Windows 上沒有沙箱：請在 WSL2 中執行它們與 Harness Relay。**Cursor** 與 **Antigravity** 在 Harness Relay 的執行中，在任何系統上都沒有沙箱，所以改用 WSL2 對它們沒有差別。**Copilot** 在那裡的沙箱不需要另外安裝任何東西：Harness Relay 會傳入 `--sandbox`（在 Windows 11 Pro，arm64，build 26200 上試過）。

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
| Antigravity | Harness Relay 不開啟它的沙箱，所以不會失敗，也不會有警告：在完全存取以外的權限，改為每個指令都要詢問。你自己開啟的沙箱（它設定中的 `enableTerminalSandbox: true`）不會進到 Harness Relay 的執行，它們的設定只保留你的模型與服務。 |
| Copilot | 只有 `--sandbox` 會失敗就關起來：只在設定中開啟的沙箱，在無法執行它的地方會被略過，而 Copilot 自己的沙箱功能開關關閉時，旗標也會被忽略。Harness Relay 傳入這個旗標，並在每次送出 prompt 前檢查 `/sandbox policy`：政策確實生效、不能繞過、有寫到時不能用鑰匙圈也不能做 git 或 gh 驗證、每個受保護的路徑與其他工作目錄都列在裡面，而且是 Copilot 自己回答、不是它的模型（沒有工具呼叫、思考或用量；這期間的任何權限請求都會被拒絕）。否則這一輪不會開始，並說明原因（*Copilot 的沙箱不是 Harness Relay 設定的樣子（…）*）。session 開啟時會自己執行東西的（hook、plugin、擴充功能、語言伺服器），會先在一次什麼都不會執行的啟動中檢查。在缺少沙箱所需條件的 Linux 上，政策仍會生效，但它在沙箱中執行的每個指令都會以 Copilot 自己的原因失敗，這一輪則繼續：沒有任何東西在沙箱外執行。 |
| Muse Code | 它無法套用的設定檔會以關閉的方式失敗：`session/new` 不會開啟，這一輪以 Muse 的訊息失敗。在 Windows 上，每個指令都會在開始前失敗（「sandbox enforcement unavailable: windows_elevated setup_required…」），完成它自己的沙箱設定後也一樣，模型看到的是這個指令失敗；它的檔案工具仍能用。在 macOS 或 Linux 上沒有見過它的沙箱無法啟動。 |

Grok 因為沙箱而拒絕啟動時，這一輪會失敗並顯示 Grok 給的原因。除了 Copilot 的政策以外，Harness Relay 不會檢查沙箱是否真的套用了。

## 沙箱管不到的事

- **讀取。** 各沙箱預設都讓指令讀取幾乎整台電腦，包括 `~/.ssh` 和 `~/.aws`；只有 Grok 的 `strict` 設定檔會限制讀取（工作目錄、系統路徑與 `~/.grok`），Copilot 的沙箱也會（系統、工具與工作資料夾，以及暫存資料夾：不含家目錄）。Harness Relay 不讓任何沙箱（包括[它自己的](#harness-relay-自己的沙箱)）讀取瀏覽器的資料夾（包括桌面 app 視窗的）與它自己的資料庫（見 [agent 不能讀寫的地方](#agent-不能讀寫的地方)），其他的不在此限。使用者允許的 Cursor 指令（或 Cursor 團隊允許清單上的指令），以及使用者允許的 Antigravity 指令，都沒有沙箱，使用者讀寫得到的，它們都讀寫得到。要讓機密不離開這台電腦，靠的是擋網路，而 Grok 在 macOS 上做不到，Copilot 的沙箱在 Harness Relay 的執行中不擋（它的政策讓指令可以連網），Muse Code 的沙箱靠詢問指令能不能連網，Harness Relay 會把它交給使用者，Cursor 與 Antigravity 在 Harness Relay 的執行中在哪裡都做不到；Harness Relay 自己的沙箱在兩個平台都擋網路，但你允許的模型來源整個可達，所以有心的 agent 仍可能透過它把資料帶出去（允許清單是按主機、不是按流量內容）。
- **Harness Relay 自己的 API。** Grok 的沙箱讓指令連得到 localhost（在 Mac 上試過：可編輯模式下，Grok 執行的 `curl http://127.0.0.1:…` 得到了回應），但 Harness Relay 在 `127.0.0.1:8787` 的 API 只接受已登入的瀏覽器：沒有瀏覽器 cookie 與金鑰的程式會收到 401（用 `curl` 試過），所以這類指令無法開始一輪執行（它擋不住的見[架構 → 登入](architecture.zh-TW.md#登入)）。同樣的測試中，Claude Code、Codex 與 Harness Relay 自己的沙箱都擋下了 localhost——Harness Relay 自己的沙箱還按名字拒絕它的連接埠，所以即使是被授予自己 loopback 連接埠的 agent（OpenCode）也連不到它。使用者允許的 Cursor 指令沒有沙箱，同樣連得到 localhost，也會收到同樣的 401（Antigravity 的指令也會如此：沒有試過）。在 macOS 上，Copilot 的指令也連得到 localhost（試過：可編輯模式下，Copilot 執行的 `curl http://127.0.0.1:…` 得到了回應），所以在那裡，只有 Harness Relay 的登入擋住它使用 API。在 Linux 上，它完全連不到這台電腦的 loopback：bubblewrap 給它一個自己的 network namespace（透過 slirp4netns），那裡的 `127.0.0.1` 不是主機的（`Couldn't connect`），它只能用區域網路位址連到這台電腦，而 Harness Relay 不在那裡接受連線。在 Windows 上沒有試過。
- **開源 agent 在自己工具外執行的東西。** Harness Relay 自己的沙箱涵蓋 agent 與它的子行程所做的一切；agent 沒有任何部分在沙箱外執行（不像 Claude Code 的 hooks 與 MCP 伺服器）。Linux 上它無法允許單一一個 Unix socket（所以在那裡需要 socket 的 CLI 必須不用它），macOS 上透過系統驗證 TLS 的 CLI（Goose）會被授予 trustd 服務，那是一條可能的出口（見 [Harness Relay 自己的沙箱](#harness-relay-自己的沙箱)）。
- **Claude Code 自己的工具。** 它的沙箱只涵蓋 Bash 指令及它們啟動的行程，不包括它的 Read、Edit、Write、WebFetch、WebSearch 工具（這些由它的權限規則管）、hooks、本機的 MCP 伺服器（包括工具庫的）和 LSP 伺服器。
- **Cursor 自己的工具。** 它的拒絕規則只約束它的讀取與寫入工具，不約束它的指令，而且只照寫下來的路徑：Cursor 比對時分大小寫，也不解析連結，所以受保護路徑的另一種寫法（換個大小寫，在 macOS 一般不分大小寫的磁碟上）或專案裡指向它的連結都不會被拒絕，它的讀取工具不經詢問就能讀。它的 hook（`~/.cursor/hooks.json`、組織的，以及 Cursor 也會載入的 `~/.claude/settings.json` 裡 Claude Code 的，不論 Claude Code 自己的執行不載入哪些）每次執行都會在它的工具呼叫上執行，沒有能在單次執行中關掉的開關；它啟動的 MCP 伺服器也在任何沙箱之外執行。
- **Antigravity 自己的工具。** Harness Relay 只能決定 agy 詢問的呼叫：工作區內的讀取從不會送到它（經由連結讀到工作區以外的會送到，指向受保護路徑時會被拒絕）。`~/.gemini/config/`（或某個帳號的 `.gemini`）裡的 hook 與 MCP 伺服器在 Harness Relay 的執行中也會載入，並在任何沙箱之外執行：agy 沒有能在單次執行中略過它們的開關。專案自己的 MCP 伺服器、hook 與 plugin（從每個工作目錄往上到它的 repository 根目錄，`.agents`、`.agent`、`_agents` 或 `_agent` 裡的 `mcp_config.json`、`hooks.json`、`plugins/` 與 `plugins.json`），agy 一開啟 session 就會啟動，在任何沙箱之外執行，也不送出權限請求，唯讀模式下也一樣（以 `agy` 1.5.6 確認過）。可編輯模式下的其他 agent 寫得到這些檔案（Claude Code、Codex、Grok 與 Cursor 都會寫入工作目錄；只有 Harness Relay 自己的沙箱讓開源 agent 無法寫入），做出這個 repository 的人也寫得到。所以在完全存取以外的權限，工作目錄裡有其中任何一個時，Harness Relay 會在 agy 啟動前先問使用者，卡片上列出這些檔案；只要它們的內容不變，「本對話都允許」就一直有效。被拒絕，或被自動拒絕時，這一輪不會開始。完全存取時什麼都不問。
- **Copilot 自己的工具與專案的 hook。** 它的 MCP 伺服器（帳號的與工具庫的）和每個 CLI 的一樣，在它的沙箱外執行；它的語言伺服器與擴充功能則在沙箱內。專案的 hook（從每個工作目錄往上到它的 repository 根目錄的 `.github/hooks/*.json`）會在 Copilot 的 session 開啟時與每次使用工具前執行，不送出權限請求，唯讀模式下也一樣（完全存取以外在它的沙箱中；以 `copilot` 1.0.109 確認過）。帳號略過 Copilot 的 hook（`disableAllHooks`）時，它們也照樣執行，那只會關掉帳號自己的 hook（以 `copilot` 1.0.109 試過）。Copilot 的說明說，它也會執行專案的 `.github/copilot/settings.json` 或 `settings.local.json`，以及 Claude Code 的 `.claude/settings.json` 或 `settings.local.json` 裡定義的 hook；這些在不信任任何資料夾的 Harness Relay 執行中沒有執行，但還是一樣會詢問。可編輯模式下的其他 agent 寫得到這些檔案（Harness Relay 自己的沙箱讓開源 agent 無法寫入 `.claude`，有 `.github` 資料夾時也無法寫入 `.github/hooks`、`.github/copilot` 與 `.github/agents`；Antigravity 的可編輯模式寫入它們之前會詢問；Copilot 自己寫入那裡會詢問，它的指令也寫不了在它這一輪開始時已經存在的那些），做出這個 repository 的人也寫得到。所以在完全存取以外的權限，工作目錄裡有任何這種檔案時，Harness Relay 會在 Copilot 啟動前先問使用者，卡片上列出這些檔案；只要每個完整 `.github/hooks` 資料夾（包括 JSON 檔旁邊的 script）與 hook 設定檔的內容不變，「本對話都允許」就一直有效（16 位數的指紋；hook 執行的、放在別處的 script 不算在內）。被拒絕，或被自動拒絕時，這一輪不會開始；所以不能詢問的 Copilot 首席 agent 或分群，在這種專案裡不會啟動（Antigravity 在有專案自己設定的專案裡也一樣）。允許後，會先在一次什麼都不會執行的啟動中檢查它的沙箱，hook 接著在沙箱內執行（以 `copilot` 1.0.109 在 macOS、Linux 與 Windows 上試過：`sessionStart` hook 的檔案寫在工作目錄裡）。帳號略過 Copilot 的 hook 時也會詢問；完全存取時不會。Copilot 不會啟動專案的 `.mcp.json` 或 `.github/mcp.json`（只在它信任的資料夾中才會，而 Harness Relay 的執行不信任任何資料夾）、`.github/extensions`（只在實驗功能中）或 `.github/lsp.json`（沒有啟動）。
- **Muse Code 自己的工具。** 它的檔案工具遵守它的設定檔，包括拒絕規則；它的網路擷取與搜尋會詢問，在完全存取以外的權限會被允許。唯讀時，使用者允許的指令在它的沙箱裡執行，沙箱讓它可以寫入工作目錄：Muse 的 `:read-only` 設定檔不會，但它不接受拒絕規則。可編輯模式下，它的檔案工具不經詢問就會寫入工作目錄裡其他 agent 的設定（`.claude`、`.vscode`、`.mcp.json`、`.codex`、`.cursor`…），就像 Claude Code、Codex 與 Grok 也會寫入工作目錄：Muse 只對 `.git`、`.muse` 與 `.agents` 底下（以及 `.envrc`）的寫入詢問。它的 skill 與指示檔，它自己的以及它從 Claude Code 與 Codex 拿來的，每次執行都會載入。受信任工作區的 hook（`.muse/hooks.json`）在它的沙箱外執行（測試中有一個寫到了工作區外）：完全存取以外的權限不信任任何工作區，所以它們不會載入。
- **Cursor 團隊的允許清單。** Cursor 團隊自動執行允許清單上的指令（由團隊管理員在 Cursor 的後台設定，從 Cursor 的伺服器讀取）可能不經詢問就在任何沙箱之外執行。Harness Relay 無法清除它。
- **寫到工作目錄與暫存資料夾以外會失敗**，包括套件快取（`~/.npm`、pip、cargo、Go 的 build cache）。如果網路也關閉，安裝相依套件就會失敗。Copilot 的 dev-tool access 本來會讓指令寫入許多這類快取，所以在完全存取以外的權限，Harness Relay 會替它把它們設為唯讀（見上面的 Copilot）：會寫入它們的安裝相依套件在那裡也會失敗（試過：在 macOS 與 Linux 上寫入 Cargo registry、go-build 快取與模組快取都被拒絕，在 Windows 上寫入 Cargo registry 被拒絕）。
- **Git。** Codex 的 `workspace-write` 把 `.git` 設為唯讀：`git add` 與 `git commit` 會以 `.git/index.lock: Operation not permitted` 失敗（在 Mac 上試過）。Claude Code 不讓指令寫入 `.git/config` 與 `.git/hooks`。Copilot 的沙箱讓指令能寫入工作目錄裡的任何地方，包括 `.git/hooks` 與 `.git/config`，所以 Harness Relay 把它們交給 Copilot 的沙箱設為唯讀路徑，連同 `.gitmodules`、`.vscode`、`.idea`，以及 Harness Relay 自己的沙箱設為唯讀的 agent 設定檔（`relaySandbox.ts` 的 `PROJECT_AGENT_CONFIG`），但只限這一輪開始時已經存在的：那時不存在的路徑不受 Copilot 的沙箱保護（bubblewrap 也會拒絕在這種路徑上啟動），所以指令仍能建立原本沒有的（例如一個 `.vscode` 資料夾）。在 macOS 上，這些唯讀路徑是路徑規則，所以指令可以把上一層的資料夾改名、在裡面寫入，再改回原名（以 `copilot` 1.0.109 試過：`mv .git .g; touch .g/hooks/planted; mv .g .git` 在 macOS 上成功；在 Linux 上 bind mount 擋住了，`Read-only file system`）：Harness Relay 自己的 git 指令絕不執行 repository 的 hook 或它的設定指定的指令（`repoDriverGuards()`，見下文），但你之後自己執行的 git 會。它的指令讀得到你自己的 git 設定（`~/.gitconfig`，以及 `~/.config/git` 裡的 `config`、`ignore` 與 `attributes` 檔），git 要有它才能執行，但不能寫入，也讀不到那個資料夾裡的其他檔案，git 的 credential store 可能把檔案放在那裡，Muse Code 的沙箱則讓整個 `.git` 都寫不進去。平行模式下，worktree 的 git 資料放在主 repository 的 `.git/worktrees/<name>`，在工作目錄之外。Harness Relay 的快照和 worktree 結果的 commit 都由伺服器在沙箱外執行，所以不受影響。Grok 的沙箱讓指令能寫入 `.git/config`、`.git/info` 與 `.git/hooks`（在 Mac 上試過：`git config core.fsmonitor …` 可以執行），使用者允許的 Cursor 或 Antigravity 指令，或使用者允許 Cursor 或 Antigravity 對它們的寫入，也能，所以 Harness Relay 自己在沙箱外執行的 git 指令，絕不執行 repository 自己的設定所指定的東西：它的 hooks 與 fsmonitor 都關閉，它的設定（或其包含的檔案）定義的每個 filter、diff 與 merge driver 都被清空，diff 也不執行外部 diff 或 textconv（`repoDriverGuards()`）。它的 submodule 所在的 repository 也一樣，因為 `git add` 會在其中執行 `git status`：agent 能寫入它們的設定，在 worktree 中也能在 submodule 的空資料夾裡建立一個。git 不會抓取缺少的物件（`GIT_NO_LAZY_FETCH`，git 2.44 以上），因為 partial clone 的遠端要透過設定所指定的指令連線；`core.worktree` 指向 repository 自己以外的資料夾時會拒絕，因為快照會把那個資料夾的檔案收進來，套用時也會寫到那裡。使用者自己的 driver，例如 `~/.gitconfig` 中 git-lfs 的，仍會執行。
- **在沙箱中常會壞掉的工具**（來自 Claude Code 的文件）：Docker 與 ssh-agent（Unix socket）、走 SSH 的 git 與 `open`、`osascript`（在 macOS 上）、watchman（請用 `jest --no-watchman`）、Linux 上的 Chromium（會啟動它的 Playwright 沒有試過）。
- **核准能做的事。** 在沙箱中，詢問使用者的意思變成詢問某個指令能不能離開沙箱：
  - Claude Code：模型可能會帶著 `dangerouslyDisableSandbox` 在沙箱外再執行一次指令（`sandbox.allowUnsandboxedCommands: false` 會拿掉這個出口）。這種重試，以及連到不在網路允許清單上的主機，在 `manual` 與 `acceptEdits` 中會詢問，在 `dontAsk` 中會被拒絕。在非互動的 `-p` 執行中，它們以 `can_use_tool` 請求送來（在 Mac 上試過）：主機以 `SandboxNetworkAccess` 送來，Harness Relay 把它顯示成讀取那個主機的網頁；Claude Code 因為某個沙箱無法寫入的路徑（`blocked_path`）而詢問的指令，就算允許了在沙箱中也會失敗，所以使用者允許時 Harness Relay 會讓它在沙箱外執行，卡片也會註明。設定為拒絕時，`acceptEdits` 仍會送來主機的請求，由 Harness Relay 拒絕。
  - Codex：和現在一樣，只有在模型要求超出沙箱允許的範圍時才會詢問。
  - Grok：設定檔一旦套用就無法撤除，所以就算核准了某個呼叫，它也不能寫到設定檔允許的路徑以外。
  - Cursor：沒有可離開的沙箱，所以允許一個指令，就是讓它以使用者的完整權限執行。
  - Muse Code：允許一個指令，它就會執行，但仍在沙箱裡：寫到工作目錄以外仍會失敗（試過）。指令要連網時，完全存取以外不論哪種模式，都會另外詢問使用者。拒絕時模型收不到任何說明，只有 Muse 自己的話，這一輪會繼續。
  - Antigravity：和 Cursor 一樣；而且任何一種拒絕（使用者的、自動的，或受保護的路徑）都會立刻結束它的這一輪：agy 會停下（`stopReason: "end_turn"`），什麼都不告訴模型，所以拒絕時附上的說明傳不過去。
  - Copilot：它的沙箱無法離開（`allowBypass: false`），所以使用者允許的指令也在沙箱中執行；Harness Relay 從不回答「永遠允許」，否則 Copilot 會把它存下來。任何一種拒絕（使用者的、自動的，或受保護的路徑）都會立刻結束它的這一輪：Copilot 只告訴模型「The user rejected this tool call.」就停下（`stopReason: "end_turn"`），所以拒絕時附上的說明傳不過去。
  - 開源 agent：只有沒有規則決定的主機會被詢問（一張 `fetch` 類型的核准卡），允許後這次執行就能透過代理連到那個主機；檔案規則無法撤除，所以核准什麼都不會讓 agent 寫到它權限允許的資料夾以外。這台電腦上的主機，或 Harness Relay 自己的連接埠，不詢問就直接拒絕。

## 尚未處理的部分

唯讀與可編輯現在在 Claude Code、Codex、Grok、Copilot、Muse Code 與開源 agent（用 Harness Relay 自己的沙箱）上都會使用沙箱（平台有沙箱時）；Cursor 與 Antigravity 的指令在任何平台上都不在沙箱中，只靠詢問把關。完全存取本來就是要在沙箱外執行：Docker、推送、安裝和寫到資料夾以外，正是它的用途。尚未處理的有：

1. **不能把設定當成沙箱。** 原生 Windows 上的 Claude Code 與 Grok，以及 macOS 上 Grok 的網路，都是設定了也不會生效，Cursor 的 ACP 模式完全不套用沙箱，Antigravity 的終端機沙箱透過 ACP 無法使用（`agy` 1.5.6：它的指令寫不進工作目錄），而只在設定中開啟的 Copilot 沙箱，在無法執行它的地方會被略過（Harness Relay 的執行會傳入旗標並檢查政策）。UI 應該說明每個 agent 在這台電腦上是否真的在沙箱中，或在這些情況下拒絕使用沙箱模式。
2. **在 Linux 上執行前先檢查前提。** Claude Code 的沙箱無法執行時，這一輪會失敗並說明要安裝 `bubblewrap` 與 `socat`；Codex 與 Grok 的前提（`bwrap`、kernel 版本、在容器中能否使用 user namespace）則沒有檢查，也沒有用使用者的語言說明要為它們安裝什麼。Copilot 的前提（slirp4netns、network namespace……）也一樣：缺少時，它的每個指令都會以 Copilot 自己的英文原因失敗。
3. **Codex 在 Windows 上的 `elevated` 沙箱**需要做一次設定，其中有 UAC 提示；在背景啟動的 `codex app-server` 能不能顯示它，沒有驗證過。可以由管理員先執行 `codex sandbox setup --elevated`，或在 Windows 支援時改用 `mxc`。
4. **Muse Code 的 Windows 沙箱**需要以系統管理員權限做一次設定。Harness Relay 不會執行它，也不會在一輪開始前檢查它是否已完成（在那之前它的指令都會失敗），而在這個沙箱裡執行的指令沒有試過。

## 資料來源

- Claude Code：[Sandboxing](https://code.claude.com/docs/en/sandboxing) 與 [All settings](https://code.claude.com/docs/en/settings-reference)。
- Codex：[Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security)、[Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox) 與 [Linux sandbox README](https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md)。
- Grok：`grok` 1.0.77 附帶的沙箱文件（設定檔、平台支援、網路限制）。
- Cursor：`cursor-agent` 2026.11.11-043ef28 本身：它的 ACP 伺服器與權限層，讀過程式碼並在 Mac 上試過。
- Antigravity：`agy` 1.5.6 本身：它的 ACP 伺服器、設定與終端機沙箱，在 Mac 上透過 Harness Relay 的轉接器試過（它的執行也在 Linux 與 Windows 11 上試過，兩者都是 arm64），用的是 Gemini API key，搭配 Gemini API 的替身。
- Copilot：`copilot` 1.0.109 本身：它的 ACP 伺服器、設定、`/sandbox policy` 與沙箱，透過 Harness Relay 的轉接器在一台 Mac、一台 Windows 11 虛擬機與 DGX Spark（都是 arm64）上試過，用的是 OpenAI 相容 API 的替身、Ollama，以及真正的 GitHub Copilot 登入。
- Muse Code：`muse` 1.4.18 本身（它沒有公開原始碼）：它的 ACP 伺服器、權限設定檔與沙箱，透過 Harness Relay 的轉接器在 Mac、Linux（aarch64）與 Windows 11（arm64，完成它沙箱的設定前後）上試過，用的是假的 Meta API key，搭配 Meta API 的替身；在 Mac 上也用真正的 Meta 帳號試過。
