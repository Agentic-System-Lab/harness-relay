[English](CONTRIBUTING.md) | **繁體中文**

# 參與 Harness Relay 開發

謝謝你願意幫忙。回報問題、提出想法、修正程式、改善文件與翻譯都很歡迎。這份文件說明怎麼回報問題、怎麼建立開發環境，以及一個修改在合併前需要做到哪些事。

想了解程式怎麼運作，請讀[架構](docs/architecture.zh-TW.md)與[開發者說明](docs/developer-guide.zh-TW.md)。coding agent 依照 [AGENTS.md](AGENTS.md) 工作，裡面是同一套規則的精簡版。

## 回報問題

請開一個 issue，並附上：

- 你做了什麼、預期會發生什麼，以及實際發生了什麼；
- 作業系統、Node.js 版本（`node --version`）與 Harness Relay 的 commit（`git rev-parse --short HEAD`）；
- 用到的 agent CLI 與版本（`claude --version`、`codex --version`、`grok --version`）；
- 對話的模式（圓桌、平行或接力）、權限（唯讀、可編輯或完全存取），以及是否直接採用首席 agent 組的團隊；
- 訊息上顯示的錯誤（裡面附有 CLI stderr 的最後一段），以及同一時間 `npm run dev` 輸出中的 `[server]` 行。

貼上 log 或截圖之前，請先移除 API key、token，以及專案中任何你不想公開的內容。請不要附上 `data/relay.db`：裡面有你的對話紀錄；在沒有作業系統金鑰儲存區的系統上，也存著你的 API key。

## 回報安全性問題

伺服器可以讓 agent 以寫入權限操作你的檔案，所以安全性問題很重要。請不要在公開的 issue 裡寫出細節。請開一個只說明「有安全性問題要回報」的 issue，維護者會安排私下傳送的方式。現有的防護措施請見[架構 → 安全性](docs/architecture.zh-TW.md#安全性)。

## 提出功能建議

請開一個 issue，先描述你想解決的問題，再談解法。比小修正更大的改動（新的對話模式、新的 agent CLI、schema 變更、新的設定）請先在 issue 中討論再動手寫程式，讓這份工作能符合整體設計。

## 建立開發環境

需要 Node.js **22.13 以上**。agent CLI（`claude`、`codex`、`grok`）只有在手動試用 app 時才需要；測試從不執行它們。

```bash
git clone https://github.com/Agentic-System-Lab/harness-relay.git
cd harness-relay
npm install
npm run dev        # API 在 :8787（檔案變更時重啟）+ 介面在 http://localhost:5173
```

`npm run dev` 會在伺服器檔案變更時重啟伺服器，重啟會中止正在執行的 agent 回合。執行時的資料放在 `data/`（已被 git 忽略）；想讓測試用的設定和自己的對話分開，可以設定 `RELAY_DATA_DIR`。其他環境變數列在[開發者說明](docs/developer-guide.zh-TW.md#執行)。

## 進行修改

先 fork 這個 repository（有寫入權限的話也可以直接開分支），從 `main` 開出新分支，每個 pull request 只做一件事。以下是審查時最常檢查的規則。

### 程式碼

- 使用 strict TypeScript 與 ES modules。共用型別只放在 `src/shared/types.ts`。
- 子程序一律透過 `src/server/process.ts` 啟動，這樣才會被追蹤並在關閉時結束。
- CLI 輸出的 parser 保持純函式（輸入一行行文字，輸出 `AgentEvent`），方便用錄下來的輸出測試。
- 測試在沒有 DOM 的 Node 環境執行。想測試的前端邏輯請放在一般模組（例如 `src/web/chat.ts`），不要寫在元件裡。
- `node:sqlite` 無法綁定 `undefined`：選填值請經過 `nul()`，多個寫入敘述請包在 `transaction(db, fn)` 裡。

### 安全性

- 新的路由放在 `/api/` 底下，才會經過 Host/Origin 檢查、寫入請求的 JSON content-type 檢查、登入檢查，並取得請求的語言。請不要放寬這些檢查。只有瀏覽器自己載入的唯讀路由（圖片、下載連結）可以只憑 cookie、不帶金鑰（`src/server/app.ts` 的 `BROWSER_LOADS`）。
- 絕不把機密傳給前端。API key 放在作業系統的金鑰儲存區（`src/server/secrets.ts`），不放在資料庫。
- 伺服器只綁定 `127.0.0.1`，而且 agent 的回覆不能讓瀏覽器載入遠端內容（圖片以連結顯示；本機媒體要經過媒體端點的路徑檢查）。

### 資料庫

要修改 schema，請在 `src/server/db.ts` 的 `MIGRATIONS` 最後新增一段 SQL；不要修改已發布的遷移。接著更新 `store.ts` / `settings.ts` 中的資料列型別與查詢，以及 `test/store.test.ts` 的測試。

### 語言

Harness Relay 是雙語的：每一段給使用者看的文字都有繁體中文（`zh-TW`）與英文（`en`）。

- **介面**：先在 `src/web/locales/zh-TW.ts` 加上 key（它定義了 `Messages` 的結構），再加到 `en.ts`。
- **伺服器訊息**：在 `src/server/i18n.ts` 加上兩種翻譯，並在產生文字的地方呼叫 `t()`。
- **內建範本**：`src/server/presets.ts`，兩種語言都要有。
- **給 agent 的 prompt**（簡報、回合 prompt、首席 agent 的 prompt）維持英文；agent 會用使用者的語言回答。

如果你只會寫其中一種語言，還是歡迎送出 pull request，並在說明中註明；維護者會協助補上另一種。

### 文件

文件成對存在：`README.md` / `README.zh-TW.md`、`CONTRIBUTING.md` / `CONTRIBUTING.zh-TW.md`，以及 `docs/<name>.md` / `docs/<name>.zh-TW.md`。當修改影響到行為、HTTP API、schema、設定、環境變數或測試清單時，請在同一個 pull request 中更新兩種語言。開發者說明列出了每一條 HTTP 路由與每個測試檔涵蓋的內容，請保持這些清單是最新的。

`site/` 裡的網站有英文與中文兩個頁面。修改前請先讀 [`site/DESIGN-GUIDELINES.md`](site/DESIGN-GUIDELINES.md)，兩個頁面一起改，並用 `npm run site:preview` 預覽。

### 測試

每個行為上的改變都要新增或更新測試。測試保持離線：不執行真正的 CLI、不連網路，也不使用真正的金鑰儲存區。請沿用現有的做法：

- 把假的 runner 換進 `runners`（`test/orchestrator.test.ts`）；
- 轉接器用錄下來的 CLI 訊息；
- `workspace.ts` 用真正的暫存 git repository；
- HTTP API 用 `app.request()`；
- 把假的 keyring 傳給 `SettingsStore`。

## 開 pull request 之前

請執行和 CI 一樣的檢查：

```bash
npm run typecheck
npm test
npm run build
```

[CI](.github/workflows/ci.yml) 會在每個 pull request 與每次推送到 `main` 時，以 Node 22 與 24 執行這些檢查。

如果你的修改會影響 agent 看到或做的事，也請在 app 中用至少一個真正的 CLI 試過，並說明用了哪些。

## Commit 訊息

commit 訊息請用英文撰寫。

- **標題**：一句祈使句，說明使用者得到什麼，例如 `Let agents ask the user before answering, and wait for the answer`。
- **內文**：簡短的條列項目；一個 commit 涵蓋好幾個部分時，用小標題分組。說明改了什麼與原因，有 schema 版本變更時要提到，並列出更新了哪些文件與語系檔。

## Pull request

請在說明中寫出：

- 這個修改做了什麼、為什麼，並附上相關 issue 的連結；
- 你怎麼測試（新增了哪些測試，以及用哪些 CLI 實際跑過）；
- 更新了哪些文件與語系檔，或為什麼不需要更新；
- 介面上的修改請附截圖或短片；有改到文字時兩種語言都要，有改到版面時也附上手機尺寸的畫面。

每個 pull request 都會經過維護者審查。可能會有提問或修改要求，目的是讓這個修改融入專案，不是針對你。

## 搭配 coding agent

歡迎用 Claude Code、Codex、Grok 或其他 agent 來寫你的修改，也可以直接在 Harness Relay 裡進行。[AGENTS.md](AGENTS.md) 提供它們需要的指令、專案結構與規則，[CLAUDE.md](CLAUDE.md) 則替 Claude Code 匯入這份文件。成果仍由你負責：請讀過 diff、跑過檢查，並確認說明中的每一句都是事實。

修改適用於所有人的規則時，請同時更新 AGENTS.md 與這份文件（兩種語言）。

## 授權

Harness Relay 以 [Apache License 2.0](LICENSE) 授權。除非你另外聲明，你提交的任何貢獻都以相同條款授權，如授權條款第 5 節所述。
