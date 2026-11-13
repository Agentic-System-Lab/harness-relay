[English](SECURITY.md) | **繁體中文**

# 安全性政策

Harness Relay 會啟動可以修改你的檔案、執行指令的 coding agent，所以只要有辦法繞過它的防護，就可能造成真正的傷害。謝謝你幫忙保護它的使用者。

## 回報漏洞

請**不要**為此開公開的 issue 或 pull request，也不要把細節放進分享出去的對話。

請在 GitHub 上用 **[Report a vulnerability](https://github.com/Agentic-System-Lab/harness-relay/security/advisories/new)** 私下回報（repository 的 **Security** 分頁 → **Report a vulnerability**）。只有你和維護者看得到這份回報，我們也可以在那裡一起修正。如果你無法使用 GitHub，請寄信到 [chihyu.jimmy.yeh@gmail.com](mailto:chihyu.jimmy.yeh@gmail.com)，主旨裡寫上「Security」。要從 app 的**回報問題**寄出的話，請不要用**上傳截圖**：截圖會放進一個 secret gist，任何拿到連結的人都看得到。

用中文或英文寫都可以，並請附上：

- 攻擊者能做到什麼，以及他們事先需要什麼（同一個瀏覽器裡開著的某個網站、同一台電腦上的某個程式、agent 執行的程式碼、tailnet 裡的某台裝置……）；
- 重現的步驟，或概念驗證（proof of concept）；
- Harness Relay 的版本（**設定與登入 → 版本**，或在 clone 下來的專案裡執行 `git rev-parse --short HEAD`）、你怎麼執行它（桌面 app、`npm start` 或 `npm run dev`）、作業系統，以及用到的 agent CLI 與版本；
- 如果有關係，也請附上對話的模式與權限。

請不要附上真的 API key、token 或私人檔案：用編造的值一樣可以說明問題。

## 接下來會怎麼處理

1. 維護者會在一週內回覆，確認收到回報，並在調查期間讓你知道進度。
2. 確認問題之後，我們會在 `main` 上修正，並發佈包含修正的版本。桌面 app 會自己向使用者提供新版本。
3. 接著我們會發佈 GitHub security advisory，並列出你的名字作為致謝，除非你不希望被具名。

在我們發佈修正之前，請先不要公開談論這個問題；公開的日期我們會和你一起決定。

## 支援的版本

版本以日期命名（例如 `2026-11-11.1`）。修正會放進下一個版本；較舊的版本與候選版本（release candidate）不會另外修正。

| 版本 | 支援 |
| --- | --- |
| 最新的正式版本 | ✅ |
| `main` | ✅ |
| 較舊的版本與候選版本 | ❌ |

最新的正式版本推出後，桌面 app 會提供給你，在你選擇**更新**時安裝（**設定與登入 → 版本**）。從 clone 下來的專案執行時，請 pull `main`。

## 算是漏洞的情況

只有使用者登入過的瀏覽器可以使用伺服器。權限低於完全存取時，在平台有沙箱的情況下，Claude Code、Codex、Grok 與 Copilot 的指令都在它們的 CLI 沙箱裡執行，由 Harness Relay 設定；開源 agent（OpenCode、Goose、Cline、OpenHands、Pi）在 Harness Relay 自己的沙箱裡執行（[各平台的作業系統沙箱 → Harness Relay 自己的沙箱](docs/sandboxing.zh-TW.md#harness-relay-自己的沙箱)）；沒有沙箱的 Cursor 則每個指令都先詢問。Harness Relay 也讓它們碰不到幾個地方（[各平台的作業系統沙箱 → agent 不能讀寫的地方](docs/sandboxing.zh-TW.md#agent-不能讀寫的地方)）。[架構 → 安全性](docs/architecture.zh-TW.md#安全性)列出了這些防護。能繞過它們就是漏洞，例如：

- 某個網站，或同一台電腦上的某個程式（包括 agent 執行的程式碼），不需要已登入瀏覽器的 cookie 與金鑰，就能操作 API 或 agent；
- agent 的回覆讓瀏覽器載入其他網站的內容，或在 app 的頁面裡執行腳本；
- 繞過媒體、下載與瀏覽檔案端點的路徑檢查（例如透過 agent 回覆裡的連結或 symlink），拿到工作目錄、agent 的 worktree 與附件以外的檔案，或 `.git` 裡的任何東西；
- API key 或 MCP 伺服器的機密值出現在瀏覽器、記錄檔或命令列上，或在有金鑰儲存區的系統上出現在資料庫裡；
- 權限低於完全存取的 agent，因為 Harness Relay 設定它的 CLI 的方式，碰到了 Harness Relay 不讓它碰的地方（瀏覽器的資料夾、Harness Relay 的資料庫與暫存資料夾），或在 Harness Relay 拒絕的資料夾（Harness Relay 本身、你的家目錄、CLI 自己的資料夾）以可編輯模式開始執行；
- 權限低於完全存取的開源 agent 逃出 Harness Relay 自己的沙箱：寫入權限不允許的地方、讀到其他對話或其他成員的狀態，或不經詢問就連到它不被允許的主機；
- 權限低於完全存取時，Cursor 的指令或它詢問的寫入沒經過使用者允許就執行了（Cursor 團隊自動執行允許清單上的除外）；
- 權限低於完全存取時，Copilot 的沙箱不是 Harness Relay 設定的樣子（沒有開啟、指令可以離開、讓指令能用鑰匙圈或 git 與 gh 的憑證，或少了 Harness Relay 給它的路徑），這一輪卻照樣開始了；或專案的 hook 在使用者允許之前、或在那個沙箱檢查過之前就執行了；
- 模型來源或端點的金鑰交給了沒用到它的執行，或成員在你自己端點上的一輪改送到了 CLI 自己的服務；
- 分享出去的對話公開了使用者沒有選擇分享的內容；
- 推播通知送到瀏覽器推播服務（`PUSH_HOSTS`）以外的地方、被它要送達的瀏覽器以外的人讀到，或送到已登出、沒有訂閱的瀏覽器；
- 桌面 app 的視窗載入其他網站，或取得 Node 的能力。

## 不算是漏洞的情況

下列情況是已知、且已寫在文件裡的，所以不算漏洞：

- agent 在你給的權限內所做的事，即使是它們讀到的檔案或網頁叫它們這麼做：**完全存取**時它們可以執行任何指令；**可編輯**模式下它們可以修改各工作目錄裡的檔案，並不經詢問就執行測試、建置與腳本等專案指令（Grok、Copilot 與開源 agent 則是推送與發佈，以及 shell 或直譯器執行管線傳來的內容以外的一切；Cursor 不經詢問不會執行任何指令，Cursor 團隊自動執行允許清單上的除外）；而在任何模式下它們都可以讀取網頁，也就可能把讀到的內容帶出去；
- CLI 沙箱管不到的事，如[各平台的作業系統沙箱 → 沙箱管不到的事](docs/sandboxing.zh-TW.md#沙箱管不到的事)與[已知限制](docs/architecture.zh-TW.md#已知限制)所述。除了上面那幾個地方，指令幾乎可以讀取整台電腦（包括 `~/.ssh` 與 `~/.aws`）；Grok 或 Copilot 執行的專案程式碼可以連上網路；Claude Code 的沙箱只管它的 Bash 指令，不管它自己的工具、hook 與 MCP 伺服器，Copilot 的沙箱也不管它的 MCP 伺服器；在 macOS 上，Copilot 在工作目錄裡的唯讀路徑是路徑規則，指令可以把上一層的資料夾改名來繞過；你允許的指令會在沙箱外執行；而在原生 Windows 上 Claude Code 與 Grok 完全沒有沙箱，開源 agent 也只能以完全存取執行；
- Cursor 在 Harness Relay 執行它的模式下沒有沙箱：你允許的指令以你的完整權限執行，Cursor 團隊的自動執行允許清單可以讓指令不經詢問就執行，而讓它自己的檔案工具碰不到受保護路徑的拒絕規則，是拿寫下來的路徑去比對（換個大小寫，或用連結，都擋不住）；
- 登入擋不住的事，如[架構 → 登入](docs/architecture.zh-TW.md#登入)所述：沙箱外、能讀取你瀏覽器設定檔或寫入 Harness Relay `data/` 資料夾的程式；agent 在這台電腦另一個 port 提供的網頁，若你打開了，就會拿到 cookie，而瀏覽器自己載入的唯讀路由只需要 cookie；不斷送出錯誤代碼的程式，在它這麼做的期間讓新的瀏覽器無法登入；
- 在沒有金鑰儲存區的系統上，API key 存在 `data/relay.db` 裡，如 [README](README.zh-TW.md#安全性) 所述；
- 簽署推播通知的金鑰與瀏覽器的推播訂閱存在 `data/relay.db` 裡（[架構 → 通知](docs/architecture.zh-TW.md#通知)）：拿到它副本的人可以傳通知到你的裝置（點通知仍然只會打開你的 Harness Relay），所以 `data/` 資料夾請勿外流；
- 用 `tailscale serve` 分享伺服器之後，tailnet 裡每台裝置都連得到的東西：它的登入頁，以及沒有登入機制的 AgentsView（[用手機連線 → 安全性](docs/remote-access.zh-TW.md#安全性)）；
- 用其他方式連到伺服器（綁定到 `0.0.0.0`、`tailscale funnel`），那份文件已經警告過不要這麼做；
- agent CLI 本身或它們自己沙箱的問題：請回報給它們的開發者（`claude` 給 Anthropic、`codex` 給 OpenAI、`grok` 給 xAI、`cursor-agent` 給 Cursor、`copilot` 給 GitHub，OpenCode、Goose、Cline、OpenHands 與 Pi 給各自的專案）。如果 Harness Relay 讓問題變得更嚴重，也請在這裡回報。

不確定算不算？還是請回報，我們一起釐清。
