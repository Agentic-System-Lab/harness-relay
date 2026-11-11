[English](README.md) | **繁體中文**

# Harness Relay

[![CI](https://github.com/Agentic-System-Lab/harness-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/Agentic-System-Lab/harness-relay/actions/workflows/ci.yml)

**網站：** https://agentic-system-lab.github.io/harness-relay/zh-TW/

一個在本機執行的群組聊天室，讓真正的 **Claude Code、Codex 和 Grok** CLI 組成團隊：替每個 agent 安排角色、決定輪流發言的方式，它們就會處理你的程式碼或任何問題，並且互相回應。

每個問題都由首席 agent 從你的範本挑選團隊（或依範本調整、重新設計），你確認後團隊才開始回答：每個 agent 的定位（架構師、實作者、審查者、魔鬼代言人……）、模型與推理強度，以及對話模式（圓桌、平行或接力）。團隊設計放在範本裡。Harness Relay 會用你自己的登入與工具執行 `claude`、`codex`、`grok`，把每個 agent 還沒看過的訊息交給它，並把所有內容即時串流到同一個聊天畫面。

## 示範

[![Harness Relay 示範：新增群組並提問，首席 agent 把對話歸進群組並為這個問題設計團隊，確認後 Claude Code、Codex 與 Grok 閱讀程式碼並回答，接著的新問題也有自己的團隊，再到檔案瀏覽器裡看它們討論到的程式碼，最後用搜尋找回對話](docs/media/demo-zh-TW.webp)](docs/media/demo-zh-TW.mp4)

## 功能

- **三個 coding agent 同一個聊天室**：直接使用你已安裝的 `claude`、`codex`、`grok` CLI，保有它們各自的工具、session 與登入狀態。
- **用範本設計團隊**：角色、模型、推理強度、發言順序；五個內建範本（寫程式與一般問題）可以複製修改，也能在新對話頁新增、修改自己的範本。對話中也能隨時調整目前的團隊：自己動手改，或告訴首席 agent 想怎麼改。
- **附加檔案**：直接貼上截圖、拖曳檔案或按 📎；每個 agent 都拿得到檔案，圖片也會直接交給三種 CLI 看。
- **語音輸入（選用）**：在輸入框按 🎙 說話，由你電腦上的 [whisper.cpp](https://github.com/ggml-org/whisper.cpp) 轉成文字，錄音不會離開這台電腦。不需要就不會安裝：第一次按下時會先說明要下載什麼，再於背景安裝引擎與模型（進度、換模型與移除都在設定頁）。支援 macOS（Homebrew、Metal GPU）、Linux 與 Windows（x64 / arm64）。
- **每個問題自動組隊**：首席 agent 會讀你的問題、先前的對話、目前的團隊與所有範本的完整內容，再決定沿用團隊、直接套用範本、依範本調整，或從頭設計新團隊，並說明原因；你確認後（也可以設定為直接採用）團隊就開始回答；@ 成員的追問則直接交給他。它設計或調整的團隊可以存成範本。
- **agent 之間互相溝通**，三種對話模式：
  - **圓桌**：依序發言、互相接續，最多 N 輪；所有人都回覆 `[PASS]` 時提前結束。
  - **平行**：每一輪大家各自獨立回答；下一輪才看得到彼此的答案。
  - **接力**：一次一位發言；agent 用 `@名稱` 把棒子交給隊友。
- **`@` 指定成員**：只有被 @ 的 agent 會回覆。
- **用 git 安全地改檔**：工作目錄會自動成為 git repository；每則回覆都會列出該 agent 改了哪些檔案並可查看 diff。平行模式中每個 agent 在自己的 git worktree 工作，再由你選擇要套用哪一份結果。
- **即時串流**：回覆文字與工具動作（改檔、執行指令）即時顯示；隨時可以停止或讓團隊繼續。被拒絕或失敗的工具呼叫會顯示原因。Mermaid 程式碼區塊會畫成圖表，agent 存在工作目錄裡的圖片與影片會直接顯示在聊天室，它為你做的檔案（PDF、簡報、試算表）則是可以下載的連結，在電腦或手機上都能下載。
- **在對話中核准**：權限（唯讀 / 可編輯 / 完全存取）決定 agent 不必詢問就能做哪些事；超出範圍的動作會在對話中詢問你：允許一次、本對話都允許，或拒絕並附上說明。
- **回覆中也能插話**：團隊回覆時送出的訊息會先停在輸入框上方，在下一位 agent 發言前送到（@ 了成員的訊息會等該成員發言）；送到之前可以撤回或編輯，也可以按 ⌘/Ctrl+Enter 停止團隊、立刻改問這個。
- **先問你，不亂猜**：好答案取決於只有你知道的事時，agent 會先問你，團隊停下來等；你回覆後，提問的 agent 先依你的回答給出完整答案，其他成員再接著往下。
- **排程**：在設定的時間（一次、每天、選定的星期幾，或每隔幾小時）把訊息傳給團隊，在同一個對話裡或每次開新對話；例如每個平日 9:00 審查昨天的 commit。側邊欄的 **新排程** 可以直接從排程開始，由首席 agent 挑選團隊。排程執行時可能沒人看著，所以預設會自動拒絕權限範圍以外的動作；Harness Relay 關閉期間錯過的時間會略過，或在開啟後補送一次。
- **看見 agent 的思考與動作**：推理過程、計畫 / 待辦清單，以及每個工具的輸出都會即時串流到對話中。
- **複製、編輯與重試**：把任何一則訊息或整段對話複製成 Markdown；編輯自己的某則訊息，或重試某個 agent 的回覆，團隊就會從那裡重新回答。
- **分支對話**：agent 回覆下方的 **分支對話**（分支圖示）會把到這則回覆為止的對話複製成新對話，讓你從那裡試另一個方向，原本的對話維持不變。
- **分享**：分享整段對話，或到某位 agent 某則回覆為止的內容，不含工具呼叫與思考過程：可以複製成 Markdown，或建立公開連結，打開是和聊天室一樣的頁面，附上 Harness Relay 的名稱與 logo，可以連到它的網站（用你的 GitHub CLI 建立 secret gist，透過 gistpreview.github.io 顯示）。回覆連結的檔案不限種類（文字檔、PDF、簡報、圖片…，每個最多 50 MB），可以挑選後放進另一個 secret gist，有連結的人都能下載。**設定 → 分享的對話** 會列出所有連結，可以移除不要的（兩個 gist 都會刪除）。
- **狀態一目了然**：側邊欄會標示需要你處理、正在回覆或有新回覆的對話；切換到其他對話時，原本的對話會繼續執行。
- **群組與搜尋**：在側邊欄建立群組，把對話拖進去；首席 agent 會依新對話的第一則訊息把它放進最適合的群組（都不適合就留在 **其他**）。群組裡的分支會列在它分支出來的對話底下，換群組時整串一起移動。搜尋可以用對話裡寫過的任何內容找到對話。
- **工具庫：MCP 伺服器、skill 與記憶**：在設定裡設定一次，不管成員跑在哪個 CLI 都能用，而且加在各 CLI 自己的設定之外。每一項可以給所有成員，或只給某幾種 CLI 的成員；記憶分成所有成員共用和各 CLI 專屬；也能針對單一成員調整。token 存在系統的金鑰儲存區。
- **在 AgentsView 中檢視 agent 的 session（選用）**：讓各 CLI 在 Harness Relay 中使用自己的資料夾（例如 `~/.relay-agents`），和你平常直接使用時分開；並在 [AgentsView](https://www.agentsview.io) 中把每個對話看成一個 thread，底下是各 agent 自己的 session（工具呼叫、token 與成本）。兩者都是設定，所以在 macOS、Linux、Windows 上都照常用 `npm start`。見[使用者說明](docs/user-guide.zh-TW.md#agent-的-session各-cli-自己的資料夾與-agentsview)。
- **瀏覽工作目錄**：對話上方的 **檔案** 會列出工作目錄（平行模式下也可以看某位成員的 worktree），並預覽程式碼（附行號和語法上色）、Markdown、圖片與影片；任何檔案都可以下載，任何資料夾（包括目前所在的資料夾）也可以下載成 ZIP 檔。
- **設定與登入頁**：分別登入各個 CLI（裝置碼、瀏覽器、貼上授權碼），設定 API key、執行檔路徑、預設模型與推理強度，以及首席 agent，也能查看各 CLI 自己載入的 skill、MCP 伺服器與它們的工具、內建工具、hook、subagent、plugin、指示與記憶，並讓 Harness Relay 執行時整類或逐項不載入。
- **回報問題**：側邊欄「設定」旁的圖示會用你的郵件程式或 Gmail 寫信給開發者，回報內容與版本、系統資訊都已填好；截圖可以拖進信裡，或用 `gh` 上傳成 secret gist 讓信裡附上連結，再寄出。
- **English 與繁體中文**：介面跟著瀏覽器的語言（可在設定頁切換）；第一次開啟時會有使用導覽介紹主要功能。
- **完全在本機**：所有資料存在單一 SQLite 檔案；伺服器只監聽 `127.0.0.1`。
- **手機也能用**：用 `tailscale serve` 分享到你的 [Tailscale](https://tailscale.com) tailnet（HTTPS，只有你的裝置連得到），就能用手機打開，也能加到主畫面，iOS 與 Android 都可以。詳見[用手機連線](docs/remote-access.zh-TW.md)。
- **桌面 app（選用）**：在 macOS、Windows、Linux 上不用開終端機也能執行：對話在它自己的視窗裡；關掉視窗時，選單列或系統匣的圖示會讓伺服器繼續執行（所以手機照常能用），可以登入時自動啟動、不讓電腦睡著，一鍵分享到手機。詳見[桌面 app](#桌面-app)。

## 需求

- Node.js **22.13 以上**（使用內建的 `node:sqlite`）
- 想使用的 agent CLI，已安裝且在 `PATH` 中：
  - [Claude Code](https://docs.claude.com/en/docs/claude-code)（`claude`）
  - [Codex CLI](https://github.com/openai/codex)（`codex`）
  - [Grok CLI](https://github.com/xai-org/grok-build)（`grok`）

不需要三個都裝；任何組合都能用，也可以在設定頁登入。

語音輸入是選用的，開啟時會自動安裝：macOS 需要 [Homebrew](https://brew.sh)；Linux 的預先編譯引擎需要 glibc 2.34 以上（Ubuntu 22.04、Debian 12 或更新）。

把對話分享成連結也是選用的：需要 [GitHub CLI](https://cli.github.com)（`gh`）2.66.0 以上並用 `gh auth login` 登入，附上檔案時還需要 `git`。

## 快速開始

```bash
git clone https://github.com/Agentic-System-Lab/harness-relay
cd harness-relay
npm install
npm run build
npm start
```

打開 `npm start` 在終端機印出的登入連結（`http://127.0.0.1:8787/#code=…`；Harness Relay 只接受登入過的瀏覽器，見[安全性](#安全性)），先到「**設定與登入**」確認每個 agent 都已登入，再點「**新對話**」，選好工作目錄與權限，直接提出第一個問題：首席 agent 會先為它組隊。

`git pull` 之後，請重新執行 `npm install` 和 `npm run build`，再執行 `npm start`。

要用手機或其他裝置使用，把它分享到你的 tailnet：詳見[用手機連線（Tailscale）](docs/remote-access.zh-TW.md)。

要開發 Harness Relay 本身？改用 `npm run dev`：改程式時伺服器會自動重啟、介面會自動重新載入，網址是 <http://localhost:5173>。詳見[開發者說明](docs/developer-guide.zh-TW.md)。

## 桌面 app

不想一直開著終端機？桌面 app 會在背景執行同一個伺服器，並在它自己的視窗裡顯示已登入的對話，沒有網址列。關掉視窗後，伺服器會繼續執行，選單列（macOS）或系統匣（Windows、Linux）留著一個圖示，所以手機照常能用；它的選單也能在瀏覽器打開對話。它會像終端機一樣找到 agent 的 CLI，可以登入時自動啟動、不讓電腦睡著，選單裡一個步驟就能透過 Tailscale 分享到手機。有新的版本（包括候選版本）時，它的選單會提供它，app 會自己更新。它需要 agent 的 CLI（編輯與平行模式還需要 Git），但不需要 Node.js。

從[網站](https://agentic-system-lab.github.io/harness-relay/zh-TW/)（提供最新的正式版本，不提供候選版本）或 [Releases](https://github.com/Agentic-System-Lab/harness-relay/releases) 下載你系統的安裝檔：macOS 是 `.dmg`（Apple Silicon；Intel Mac 請改從原始碼執行），Windows 是 `.exe`，Linux 是 `.AppImage`（Windows 與 Linux 都有 x64 與 Arm64）。安裝檔還沒有為發佈簽章，所以第一次開啟時系統會警告；詳見使用說明的[桌面 app](docs/user-guide.zh-TW.md#桌面-app)。要自己建置，在快速開始的 `npm install` 之後，於 clone 下來的資料夾執行（安裝檔會放在 `desktop/release/`）：

```bash
npm install --prefix desktop
npm run desktop:dist
```

`npm start` 和 `npm run dev` 照舊可用。

## 文件

| | English | 繁體中文 |
| --- | --- | --- |
| 使用者說明 | [docs/user-guide.md](docs/user-guide.md) | [docs/user-guide.zh-TW.md](docs/user-guide.zh-TW.md) |
| 架構 | [docs/architecture.md](docs/architecture.md) | [docs/architecture.zh-TW.md](docs/architecture.zh-TW.md) |
| 開發者說明 | [docs/developer-guide.md](docs/developer-guide.md) | [docs/developer-guide.zh-TW.md](docs/developer-guide.zh-TW.md) |
| 用手機連線（Tailscale） | [docs/remote-access.md](docs/remote-access.md) | [docs/remote-access.zh-TW.md](docs/remote-access.zh-TW.md) |
| 各平台的作業系統沙箱 | [docs/sandboxing.md](docs/sandboxing.md) | [docs/sandboxing.zh-TW.md](docs/sandboxing.zh-TW.md) |
| 提案（尚未實作） | [docs/proposals/README.md](docs/proposals/README.md) | [docs/proposals/README.zh-TW.md](docs/proposals/README.zh-TW.md) |
| ↳ 排程與事件觸發的執行 | [docs/proposals/triggers.md](docs/proposals/triggers.md) | [docs/proposals/triggers.zh-TW.md](docs/proposals/triggers.zh-TW.md) |
| ↳ agent 之間共用的記憶 | [docs/proposals/shared-memory.md](docs/proposals/shared-memory.md) | [docs/proposals/shared-memory.zh-TW.md](docs/proposals/shared-memory.zh-TW.md) |
| ↳ 網站預覽與 Generative UI | [docs/proposals/preview-and-generative-ui.md](docs/proposals/preview-and-generative-ui.md) | [docs/proposals/preview-and-generative-ui.zh-TW.md](docs/proposals/preview-and-generative-ui.zh-TW.md) |

## 安全性

agent 會以你為對話選擇的檔案權限執行（**唯讀**、**可編輯**或**完全存取**）。完全存取會讓 agent 不經詢問就執行任何指令，請只在你信任的目錄使用。在完全存取以外的權限，每個 agent 的指令都在它那個 CLI 的作業系統沙箱中執行，只能寫入工作目錄與暫存資料夾；Codex 的沙箱也讓指令無法連網，Claude Code 的沙箱會在指令要連到每個主機時詢問你。Grok 的沙箱只在 Linux 上擋得了網路，所以在可編輯模式下，Grok 執行的專案程式碼仍能連網：測試、建置和專案腳本執行的都是 agent 能修改的程式碼，所以不信任的程式碼或指示請用唯讀。在原生 Windows 上只有 Codex 有沙箱（見[各平台的作業系統沙箱](docs/sandboxing.zh-TW.md)）。沙箱也讓 agent 碰不到你瀏覽器的資料夾與 Harness Relay 的資料庫；工作目錄包含 Harness Relay 本身、你的家目錄或 CLI 自己的資料夾時，則會拒絕可編輯模式。伺服器只綁定 `127.0.0.1`、拒絕跨站請求，並且只接受你登入過的瀏覽器：用它啟動時印出的連結、`npm run login`，或已登入瀏覽器產生的代碼（給手機用）登入。所以你電腦上的其他程式，包括 agent 執行的程式碼，都無法透過它操作 agent，除非它們讀得到你瀏覽器的資料，或寫得到 Harness Relay 的 `data/` 資料夾（見[登入](docs/architecture.zh-TW.md#登入)）。只透過 `tailscale serve` 分享到你的 tailnet；請不要用其他方式開放它（見[用手機連線](docs/remote-access.zh-TW.md#安全性)）。詳見[架構 → 安全性](docs/architecture.zh-TW.md#安全性)。

在設定頁儲存的 API key，以及工具庫裡 MCP 伺服器環境變數與標頭的值，會放在作業系統的金鑰儲存區（macOS 鑰匙圈、Windows 認證管理員，或 Linux 的 Secret Service，例如 GNOME Keyring、KWallet），而不是資料庫。只有在沒有這類儲存區的系統（例如沒有桌面環境的 Linux 伺服器）上，才會留在只有你的帳號能讀取的 `data/relay.db`；若想避免，可以不在設定頁儲存，改在啟動 Harness Relay 前設定 `ANTHROPIC_API_KEY` / `XAI_API_KEY`。

## 指令

| 指令 | 說明 |
| --- | --- |
| `npm run dev` | 開發用：API 伺服器（port 8789，自動重啟）+ Vite 開發伺服器（port 5173），所以能和使用 8787 的桌面 app，或另一個 checkout 的 `npm start` 同時執行（一個資料夾只能有一個伺服器：和同一個 checkout 的 `npm start` 一起時會拒絕啟動） |
| `npm run build` | 把網頁介面建置到 `dist/web` |
| `npm start` | 由單一程序在 http://127.0.0.1:8787 提供建置好的介面與 API |
| `npm run login` | 印出一次性的登入連結（與代碼），用在 `npm start` 印出的那個已經用過或過期時 |
| `npm run typecheck` | 型別檢查伺服器、前端與測試 |
| `npm test` | 執行測試（Vitest） |
| `npm run site:preview` | 在 http://127.0.0.1:4180 預覽網站（`site/`） |
| `npm run icons` | 重新畫出 `src/web/public/` 的主畫面圖示與 web app manifest |
| `npm run demo` | 用真正的 CLI 重錄兩種語言的示範影片，並更新影片、截圖與網站的章節 |
| `npm run desktop` | 建置桌面 app 並直接執行，不安裝（先執行 `npm install --prefix desktop`） |
| `npm run desktop:dist` | 為目前的系統建置桌面 app 的安裝檔，放在 `desktop/release/` |

每個 pull request 與每次推送到 `main` 都會在 GitHub Actions 上執行型別檢查、測試與建置（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）。[網站](https://agentic-system-lab.github.io/harness-relay/zh-TW/)是 [`site/`](site/) 裡的靜態頁面，由 [`.github/workflows/pages.yml`](.github/workflows/pages.yml) 發佈到 GitHub Pages。

## 參與開發

歡迎回報問題、提出想法或送出 pull request。[CONTRIBUTING.zh-TW.md](CONTRIBUTING.zh-TW.md) 說明怎麼回報問題、建立開發環境與準備修改；所有給使用者看的文字與文件都要同時有 English 與繁體中文。

## 授權

本專案的程式碼以 [Apache License 2.0](LICENSE) 授權。
