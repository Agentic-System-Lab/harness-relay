[English](README.md) | **繁體中文**

# Harness Relay

一個類似 ChatGPT 的群組聊天室，讓 **Claude Code、Codex 和 Grok** 一起處理你的程式碼或任何問題，並且彼此溝通。

每次對話開始前，你先設計這個團隊：替每個 coding agent 決定定位（架構師、實作者、審查者、魔鬼代言人……）、選擇模型與推理強度，以及他們輪流發言的方式。Harness Relay 會在你的電腦上驅動真正的 CLI，把每個 agent 還沒看過的訊息交給它，並把所有內容即時串流到同一個聊天畫面。

## 功能

- **三個 coding agent 同一個聊天室**：直接使用你已安裝的 `claude`、`codex`、`grok` CLI，保有它們各自的工具、session 與登入狀態。
- **每個對話各自設計團隊**：角色、模型、推理強度、發言順序；內建五個範本（寫程式與一般問題），也能儲存自己的範本。對話中也能隨時修改角色。
- **自動組隊**：讓首席 agent 讀你的第一個問題，挑選範本或設計更適合的團隊；它設計的團隊可以存成範本。
- **agent 之間互相溝通**，三種對話模式：
  - **圓桌**：依序發言、互相接續，最多 N 輪；所有人都回覆 `[PASS]` 時提前結束。
  - **平行**：每一輪大家各自獨立回答；下一輪才看得到彼此的答案。
  - **接力**：一次一位發言；agent 用 `@名稱` 把棒子交給隊友。
- **`@` 指定成員**：只有被 @ 的 agent 會回覆。
- **用 git 安全地改檔**：工作目錄會自動成為 git repository；每則回覆都會列出該 agent 改了哪些檔案並可查看 diff。平行模式中每個 agent 在自己的 git worktree 工作，再由你選擇要套用哪一份結果。
- **即時串流**：回覆文字與工具動作（改檔、執行指令）即時顯示；隨時可以停止或讓團隊繼續。被拒絕或失敗的工具呼叫會顯示原因。
- **在對話中核准**：權限（唯讀 / 可編輯 / 完全存取）決定 agent 不必詢問就能做哪些事；超出範圍的動作會在對話中詢問你：允許一次、本對話都允許，或拒絕並附上說明。
- **看見 agent 的思考與動作**：推理過程、計畫 / 待辦清單，以及每個工具的輸出都會即時串流到對話中。
- **複製、編輯與重試**：把任何一則訊息或整段對話複製成 Markdown；編輯自己的某則訊息，或重試某個 agent 的回覆，團隊就會從那裡重新回答。
- **狀態一目了然**：側邊欄會標示需要你處理、正在回覆或有新回覆的對話；切換到其他對話時，原本的對話會繼續執行。
- **設定與登入頁**：分別登入各個 CLI（裝置碼、瀏覽器、貼上授權碼），設定 API key、執行檔路徑、預設模型與推理強度，以及首席 agent。
- **English 與繁體中文**：介面跟著瀏覽器的語言（可在設定頁切換）；第一次開啟時會有使用導覽介紹主要功能。
- **完全在本機**：所有資料存在單一 SQLite 檔案；伺服器只監聽 `127.0.0.1`。

## 需求

- Node.js **22.13 以上**（使用內建的 `node:sqlite`）
- 想使用的 agent CLI，已安裝且在 `PATH` 中：
  - [Claude Code](https://docs.claude.com/en/docs/claude-code)（`claude`）
  - [Codex CLI](https://github.com/openai/codex)（`codex`）
  - Grok CLI（`grok`）

不需要三個都裝；任何組合都能用，也可以在設定頁登入。

## 快速開始

```bash
npm install
npm run dev
```

打開 **http://localhost:5173**，先到「**設定與登入**」確認每個 agent 都已登入，再點「**新對話**」、挑一個範本，就可以開始對話。

以單一伺服器方式執行（正式環境）：

```bash
npm run build
npm start          # 在 http://127.0.0.1:8787 同時提供介面與 API
```

## 文件

| | English | 繁體中文 |
| --- | --- | --- |
| 使用者說明 | [docs/user-guide.md](docs/user-guide.md) | [docs/user-guide.zh-TW.md](docs/user-guide.zh-TW.md) |
| 架構 | [docs/architecture.md](docs/architecture.md) | [docs/architecture.zh-TW.md](docs/architecture.zh-TW.md) |
| 開發者說明 | [docs/developer-guide.md](docs/developer-guide.md) | [docs/developer-guide.zh-TW.md](docs/developer-guide.zh-TW.md) |

## 安全性

agent 會以你為對話選擇的檔案權限執行（**唯讀**、**可編輯**或**完全存取**）。完全存取會讓 agent 不經詢問就執行任何指令，請只在你信任的目錄使用。伺服器只綁定 `127.0.0.1` 並拒絕跨站請求，但任何能存取你電腦 localhost 的人都能操作這些 agent。詳見[架構 → 安全性](docs/architecture.zh-TW.md#安全性)。

## 指令

| 指令 | 說明 |
| --- | --- |
| `npm run dev` | API 伺服器（port 8787，自動重啟）+ Vite 開發伺服器（port 5173） |
| `npm run build` | 把網頁介面建置到 `dist/web` |
| `npm start` | 由單一程序提供建置好的介面與 API |
| `npm run typecheck` | 型別檢查伺服器、前端與測試 |
| `npm test` | 執行測試（Vitest） |
