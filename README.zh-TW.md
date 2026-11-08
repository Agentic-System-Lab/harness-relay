[English](README.md) | **繁體中文**

# Harness Relay

[![CI](https://github.com/Agentic-System-Lab/harness-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/Agentic-System-Lab/harness-relay/actions/workflows/ci.yml)

**網站：** https://agentic-system-lab.github.io/harness-relay/zh-TW/

一個在本機執行的群組聊天室，讓真正的 **Claude Code、Codex 和 Grok** CLI 組成團隊：替每個 agent 安排角色、決定輪流發言的方式，它們就會處理你的程式碼或任何問題，並且互相回應。

每次對話開始前，你先設計這個團隊：每個 agent 的定位（架構師、實作者、審查者、魔鬼代言人……）、模型與推理強度，以及對話模式（圓桌、平行或接力），也可以交給首席 agent 替你設計。Harness Relay 會用你自己的登入與工具執行 `claude`、`codex`、`grok`，把每個 agent 還沒看過的訊息交給它，並把所有內容即時串流到同一個聊天畫面。

## 示範

[![Harness Relay 示範：新增群組並描述需求，首席 agent 把對話歸進群組並設計團隊，確認後 Claude Code、Codex 與 Grok 閱讀程式碼並回答，接著在檔案瀏覽器裡看它們討論到的程式碼，最後用搜尋找回對話](docs/media/demo-zh-TW.webp)](docs/media/demo-zh-TW.mp4)

先新增群組，再在這個 repository 上使用自動組隊：描述需求後，首席 agent 依第一則訊息把對話歸進群組，並以「三方辯論」範本調整出三人團隊、說明原因。確認團隊後再提問，Claude Code、Codex 與 Grok 以圓桌方式輪流閱讀程式碼並回答兩輪，每位都接續並挑戰前面的說法，它們的思考與工具呼叫會即時出現在聊天中；Grok 想實際執行指令驗證時超出唯讀權限，便以核准卡片詢問你（agent 工作的片段已加速）。接著打開**檔案**，直接在對話的工作目錄裡看它們討論到的 `orchestrator.ts` 交棒程式碼；最後用搜尋，依 agent 寫下的內容找回這段對話。[觀看完整畫質影片（MP4）](docs/media/demo-zh-TW.mp4)。

## 功能

- **三個 coding agent 同一個聊天室**：直接使用你已安裝的 `claude`、`codex`、`grok` CLI，保有它們各自的工具、session 與登入狀態。
- **每個對話各自設計團隊**：角色、模型、推理強度、發言順序；可以從空白團隊自行設計，也能從五個內建範本（寫程式與一般問題）或自己存的範本開始。對話中也能隨時修改角色。
- **附加檔案**：直接貼上截圖、拖曳檔案或按 📎；每個 agent 都拿得到檔案，圖片也會直接交給三種 CLI 看。
- **語音輸入（選用）**：在輸入框按 🎙 說話，由你電腦上的 [whisper.cpp](https://github.com/ggml-org/whisper.cpp) 轉成文字，錄音不會離開這台電腦。不需要就不會安裝：第一次按下時會先說明要下載什麼，再於背景安裝引擎與模型（進度、換模型與移除都在設定頁）。支援 macOS（Homebrew、Metal GPU）、Linux 與 Windows（x64 / arm64）。
- **自動組隊**：描述你的需求，首席 agent 會讀它與所有範本的完整內容，再決定直接套用範本、依範本調整，或從頭設計新團隊，並說明原因；你確認團隊後再開始提問；它設計或調整的團隊可以存成範本。
- **agent 之間互相溝通**，三種對話模式：
  - **圓桌**：依序發言、互相接續，最多 N 輪；所有人都回覆 `[PASS]` 時提前結束。
  - **平行**：每一輪大家各自獨立回答；下一輪才看得到彼此的答案。
  - **接力**：一次一位發言；agent 用 `@名稱` 把棒子交給隊友。
- **`@` 指定成員**：只有被 @ 的 agent 會回覆。
- **用 git 安全地改檔**：工作目錄會自動成為 git repository；每則回覆都會列出該 agent 改了哪些檔案並可查看 diff。平行模式中每個 agent 在自己的 git worktree 工作，再由你選擇要套用哪一份結果。
- **即時串流**：回覆文字與工具動作（改檔、執行指令）即時顯示；隨時可以停止或讓團隊繼續。被拒絕或失敗的工具呼叫會顯示原因。Mermaid 程式碼區塊會畫成圖表，agent 存在工作目錄裡的圖片與影片也會直接顯示在聊天室。
- **在對話中核准**：權限（唯讀 / 可編輯 / 完全存取）決定 agent 不必詢問就能做哪些事；超出範圍的動作會在對話中詢問你：允許一次、本對話都允許，或拒絕並附上說明。
- **回覆中也能插話**：團隊回覆時送出的訊息會先停在輸入框上方，在下一位 agent 發言前送到（@ 了成員的訊息會等該成員發言）；送到之前可以撤回或編輯，也可以按 ⌘/Ctrl+Enter 停止團隊、立刻改問這個。
- **先問你，不亂猜**：好答案取決於只有你知道的事時，agent 會先問你，團隊停下來等；你回覆後，提問的 agent 先依你的回答給出完整答案，其他成員再接著往下。
- **看見 agent 的思考與動作**：推理過程、計畫 / 待辦清單，以及每個工具的輸出都會即時串流到對話中。
- **複製、編輯與重試**：把任何一則訊息或整段對話複製成 Markdown；編輯自己的某則訊息，或重試某個 agent 的回覆，團隊就會從那裡重新回答。
- **狀態一目了然**：側邊欄會標示需要你處理、正在回覆或有新回覆的對話；切換到其他對話時，原本的對話會繼續執行。
- **群組與搜尋**：在側邊欄建立群組，把對話拖進去；首席 agent 會依新對話的第一則訊息把它放進最適合的群組（都不適合就留在 **其他**）。搜尋可以用對話裡寫過的任何內容找到對話。
- **工具庫：MCP 伺服器、skill 與記憶**：在設定裡設定一次，不管成員跑在哪個 CLI 都能用，而且加在各 CLI 自己的設定之外。每一項可以給所有成員，或只給某幾種 CLI 的成員；記憶分成所有成員共用和各 CLI 專屬；也能針對單一成員調整。token 存在系統的金鑰儲存區。
- **在 AgentsView 中檢視 agent 的 session（選用）**：讓各 CLI 在 Harness Relay 中使用自己的資料夾（例如 `~/.relay-agents`），和你平常直接使用時分開；並在 [AgentsView](https://www.agentsview.io) 中把每個對話看成一個 thread，底下是各 agent 自己的 session（工具呼叫、token 與成本）。兩者都是設定，所以在 macOS、Linux、Windows 上都照常用 `npm start`。見[使用者說明](docs/user-guide.zh-TW.md#agent-的-session各-cli-自己的資料夾與-agentsview)。
- **瀏覽工作目錄**：對話上方的 **檔案** 會列出工作目錄（平行模式下也可以看某位成員的 worktree），並預覽程式碼（附行號和語法上色）、Markdown、圖片與影片。
- **設定與登入頁**：分別登入各個 CLI（裝置碼、瀏覽器、貼上授權碼），設定 API key、執行檔路徑、預設模型與推理強度，以及首席 agent，也能查看各 CLI 自己載入的 skill、MCP、hook、subagent、plugin 與記憶，並讓 Harness Relay 執行時不載入其中任何一項。
- **English 與繁體中文**：介面跟著瀏覽器的語言（可在設定頁切換）；第一次開啟時會有使用導覽介紹主要功能。
- **完全在本機**：所有資料存在單一 SQLite 檔案；伺服器只監聽 `127.0.0.1`。
- **手機也能用**：用 `tailscale serve` 分享到你的 [Tailscale](https://tailscale.com) tailnet（HTTPS，只有你的裝置連得到），就能用手機打開，也能加到主畫面，iOS 與 Android 都可以。詳見[用手機連線](docs/remote-access.zh-TW.md)。

## 需求

- Node.js **22.13 以上**（使用內建的 `node:sqlite`）
- 想使用的 agent CLI，已安裝且在 `PATH` 中：
  - [Claude Code](https://docs.claude.com/en/docs/claude-code)（`claude`）
  - [Codex CLI](https://github.com/openai/codex)（`codex`）
  - [Grok CLI](https://github.com/xai-org/grok-build)（`grok`）

不需要三個都裝；任何組合都能用，也可以在設定頁登入。

語音輸入是選用的，開啟時會自動安裝：macOS 需要 [Homebrew](https://brew.sh)；Linux 的預先編譯引擎需要 glibc 2.34 以上（Ubuntu 22.04、Debian 12 或更新）。

## 快速開始

```bash
git clone https://github.com/Agentic-System-Lab/harness-relay
cd harness-relay
npm install
npm run build
npm start
```

打開 **http://127.0.0.1:8787**，先到「**設定與登入**」確認每個 agent 都已登入，再點「**新對話**」，選自動組隊、自行設計或挑一個範本，就可以開始對話。

`git pull` 之後，請重新執行 `npm install` 和 `npm run build`，再執行 `npm start`。

要用手機或其他裝置使用，把它分享到你的 tailnet：詳見[用手機連線（Tailscale）](docs/remote-access.zh-TW.md)。

要開發 Harness Relay 本身？改用 `npm run dev`：改程式時伺服器會自動重啟、介面會自動重新載入，網址是 http://localhost:5173。詳見[開發者說明](docs/developer-guide.zh-TW.md)。

## 文件

| | English | 繁體中文 |
| --- | --- | --- |
| 使用者說明 | [docs/user-guide.md](docs/user-guide.md) | [docs/user-guide.zh-TW.md](docs/user-guide.zh-TW.md) |
| 架構 | [docs/architecture.md](docs/architecture.md) | [docs/architecture.zh-TW.md](docs/architecture.zh-TW.md) |
| 開發者說明 | [docs/developer-guide.md](docs/developer-guide.md) | [docs/developer-guide.zh-TW.md](docs/developer-guide.zh-TW.md) |
| 用手機連線（Tailscale） | [docs/remote-access.md](docs/remote-access.md) | [docs/remote-access.zh-TW.md](docs/remote-access.zh-TW.md) |
| 提案（尚未實作） | [docs/proposals/README.md](docs/proposals/README.md) | [docs/proposals/README.zh-TW.md](docs/proposals/README.zh-TW.md) |
| ↳ 排程與事件觸發的執行 | [docs/proposals/triggers.md](docs/proposals/triggers.md) | [docs/proposals/triggers.zh-TW.md](docs/proposals/triggers.zh-TW.md) |
| ↳ agent 之間共用的記憶 | [docs/proposals/shared-memory.md](docs/proposals/shared-memory.md) | [docs/proposals/shared-memory.zh-TW.md](docs/proposals/shared-memory.zh-TW.md) |

## 安全性

agent 會以你為對話選擇的檔案權限執行（**唯讀**、**可編輯**或**完全存取**）。完全存取會讓 agent 不經詢問就執行任何指令，請只在你信任的目錄使用。可編輯模式也不會把專案程式碼關進沙箱：測試、建置和專案腳本執行的都是 agent 能修改的程式碼，所以不信任的程式碼或指示請用唯讀。伺服器只綁定 `127.0.0.1` 並拒絕跨站請求，但任何能存取你電腦 localhost 的人都能操作這些 agent。用 `tailscale serve` 分享到 tailnet 後，tailnet 裡的每台裝置也都能操作；請不要用其他方式開放它（見[用手機連線](docs/remote-access.zh-TW.md#安全性)）。詳見[架構 → 安全性](docs/architecture.zh-TW.md#安全性)。

在設定頁儲存的 API key，以及工具庫裡 MCP 伺服器環境變數與標頭的值，會放在作業系統的金鑰儲存區（macOS 鑰匙圈、Windows 認證管理員，或 Linux 的 Secret Service，例如 GNOME Keyring、KWallet），而不是資料庫。只有在沒有這類儲存區的系統（例如沒有桌面環境的 Linux 伺服器）上，才會留在只有你的帳號能讀取的 `data/relay.db`；若想避免，可以不在設定頁儲存，改在啟動 Harness Relay 前設定 `ANTHROPIC_API_KEY` / `XAI_API_KEY`。

## 指令

| 指令 | 說明 |
| --- | --- |
| `npm run dev` | 開發用：API 伺服器（port 8787，自動重啟）+ Vite 開發伺服器（port 5173） |
| `npm run build` | 把網頁介面建置到 `dist/web` |
| `npm start` | 由單一程序在 http://127.0.0.1:8787 提供建置好的介面與 API |
| `npm run typecheck` | 型別檢查伺服器、前端與測試 |
| `npm test` | 執行測試（Vitest） |
| `npm run site:preview` | 在 http://127.0.0.1:4180 預覽網站（`site/`） |
| `npm run icons` | 重新畫出 `src/web/public/` 的主畫面圖示與 web app manifest |

每個 pull request 與每次推送到 `main` 都會在 GitHub Actions 上執行型別檢查、測試與建置（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）。[網站](https://agentic-system-lab.github.io/harness-relay/zh-TW/)是 [`site/`](site/) 裡的靜態頁面，由 [`.github/workflows/pages.yml`](.github/workflows/pages.yml) 發佈到 GitHub Pages。

## 參與開發

歡迎回報問題、提出想法或送出 pull request。[CONTRIBUTING.zh-TW.md](CONTRIBUTING.zh-TW.md) 說明怎麼回報問題、建立開發環境與準備修改；所有給使用者看的文字與文件都要同時有 English 與繁體中文。

## 授權

本專案的程式碼以 [Apache License 2.0](LICENSE) 授權。
