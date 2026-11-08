[English](shared-memory.md) | **繁體中文**

# agent 之間共用的記憶

> **狀態：提案，尚未實作。** 見[提案](README.zh-TW.md)。

讓一個 agent 學到的東西能傳給其他 agent 和之後的對話，並由使用者決定留下什麼。

## 現在有什麼

Harness Relay 的 agent 有三層記憶：

1. **對話。** 每個 agent 每回合都接續自己的 CLI session（`agent_sessions`），所以記得這個聊天裡看過的東西。重試或編輯訊息會讓每個 agent 用剩下的歷史重新開始。
2. **工具庫的記憶。** 使用者在設定裡寫的文字：一份給所有 agent（`all`），每個 CLI 各一份（`src/shared/types.ts` 的 `MemoryScope`）。它在每個對話、每個回合都會放進每個 agent 的 briefing（`src/server/prompt.ts` 的 `toolSections()`）。agent 無法修改。
3. **各 CLI 自己記住的東西**，因為它在工作目錄裡執行：

   | CLI | 指令檔（人寫的） | CLI 自己寫的筆記 |
   | --- | --- | --- |
   | Claude Code | `CLAUDE.md`、`CLAUDE.local.md`、`.claude/rules/`，在它的設定資料夾，以及從資料夾往上各層 | auto memory，`~/.claude/projects/<folder>/memory/`；預設開啟 |
   | Codex | `AGENTS.override.md` 或 `AGENTS.md`，在 `CODEX_HOME`，以及從 repository 根目錄往下各層 | memories，`~/.codex/memories/`；預設關閉（`codex features list`） |
   | Grok | `AGENTS.md`（和 `CLAUDE.md`），只在信任的資料夾 | 跨 session 記憶，`~/.grok/memory-v2/`；實驗功能，預設關閉（`[memory] enabled`） |

   設定裡每個 CLI 的卡片會列出它的指令檔和記憶檔（`src/server/native.ts`），只有 Grok 的記憶筆記沒有：`grok inspect` 只回報指令檔。

## 缺什麼

- agent 無法增加其他 agent 會拿到的東西。Claude Code 存進 auto memory 的，Codex 和 Grok 永遠看不到；工具庫的記憶只有使用者編輯時才會變。
- 工具庫的記憶是全域的：關於某個 repository 的筆記，會放進每個資料夾、每個對話的 briefing。
- 一個對話的結論，要使用者自己複製，才會帶到下一個對話。
- Grok 的記憶筆記沒有列在它的卡片上。

## 目標

- agent 可以**建議**要記住的東西，由使用者決定。記憶會放進之後每個對話、每個 agent 的 briefing，份量跟使用者自己的指令一樣。agent 寫的東西——或它讀到的網頁、issue、webhook 事件——沒有使用者同意都不能進去。
- 依專案分的記憶。
- 三個 CLI 都一樣。
- briefing 保持精簡，也不會在沒告知的情況下被截掉。
- Harness Relay 從不寫入 CLI 自己的記憶資料夾。

## 設計

### 1. 記憶建議

briefing 告訴 agent：學到隊友或之後的對話應該知道、而且會長期有效的事——慣例、決定、某樣東西放在哪、有效的指令——就放在回覆最後：

```text
<remember scope="project">
Run `npm run build` before `npm test`: the tests read dist/web.
</remember>
```

`scope` 是 `project`（預設）、`all`，或 agent 自己的 CLI。

- 解析器放在 `src/shared/remember.ts`，是純函式、伺服器和前端共用，跟 `src/shared/ask.ts` 一樣：回覆串流時 UI 會把區塊藏起來，程式碼裡的區塊不算（跟 `@mention` 一樣只看 Markdown 內文）。
- 回合結束時，伺服器把區塊從回覆文字中拿掉，並在訊息上加一個 `memory` part：`{ text, scope, state: 'pending' }`，跟核准 part 一樣存成 JSON。每則回覆最多 3 個，每個 500 字元；多的會丟掉，並在 part 裡註明。
- UI 在回覆下方顯示卡片：*@Builder 建議為這個專案記住……*，有**儲存**、**編輯**、**略過**。儲存會把文字當成一行加到選定的記憶，並把 part 標成 `saved`。其他 agent 從下一回合起就會在 briefing 裡拿到。
- 因為區塊已從文字中拿掉，它不會當成聊天內容轉給隊友。

### 2. 專案記憶

每個專案一份新的記憶，以**專案根目錄**為鍵：對話工作目錄所在 git repository 的根目錄，不在 repository 裡就是該目錄的實際路徑（跟 Grok 判斷信任的規則一樣；`src/server/native.ts` 已經有 `gitRoot()`）。平行模式的 worktree 算是它所屬對話的專案。

- briefing 的 `# Memory` 段落依序放：給所有人的、給這個專案的、給這個 CLI 的。
- agent 可以像其他部分一樣把它關掉：`AgentConfig.tools` 裡的例外鍵 `memory:project`。
- 存在新資料表 `project_memory`（主鍵 `root`、`text`、`updated_at`），而不是 `tool_library` 的 JSON，因為專案數量會一直增加。
- 設定 → 工具 → 記憶加上專案清單：有記憶的專案，加上預設工作目錄。對話標題列有連結可以打開該專案的記憶。

### 3. 大小

記憶每回合都跟 briefing 一起送出。設定裡會顯示每個 CLI 的 agent 會拿到多大的記憶（所有人 + 專案 + CLI），超過 8 KB 時警告。記憶從不會為了塞進去而被截掉；警告會請使用者自己刪減。

### 4. 匯入各 CLI 記住的東西

- CLI 卡片上列出的每個記憶檔都加上**複製到記憶**：打開檔案，使用者挑要留的部分，加到 `all` 或專案記憶。Harness Relay 只讀取 CLI 的記憶資料夾。它們的格式屬於各 CLI：Claude Code 有 `MEMORY.md` 索引，Grok 在筆記旁邊還有 SQLite 資料庫和搜尋索引。
- Grok 的卡片列出它的全域記憶主題（`~/.grok/memory-v2/global/topics/*.md`）。workspace 主題放在名為 `<project>-<hash>` 的資料夾，hash 的規則沒有文件，所以要等 `grok inspect` 回報它們或規則有文件之後才列出。

### 5. 把對話帶到下一次

對話上的**建議記憶**動作，會請 lead agent（自動組隊用的那個設定）用 `<remember>` 格式列出這個對話中長期有效的事。它們會像步驟 1 一樣以建議的形式出現。這也能給每次觸發都開新對話的[觸發器](triggers.zh-TW.md)使用。

## HTTP API

| 方法和路徑 | 用途 |
| --- | --- |
| `POST /api/conversations/:id/messages/:messageId/memory/:index` | `{ action: 'save' \| 'dismiss', text?, scope? }`：回應一個建議 |
| `GET /api/tools/memory/projects` | 有記憶的專案和大小 |
| `PUT /api/tools/memory/projects` | `{ root, text }`：設定某專案的記憶（空字串表示刪除） |
| `POST /api/conversations/:id/suggest-memory` | 請 lead agent 提出建議 |

## 資料庫

一個 migration：資料表 `project_memory`。建議是訊息的 part（種類 `memory`），資料以 JSON 存在 `message_parts.data`，不需要自己的資料表。

## 測試

- `src/shared/remember.ts`：找到並移除區塊、scope、忽略程式碼裡的區塊、數量和長度限制、被停止的回覆截斷的區塊。
- 用假 runner 測 orchestrator：帶區塊的回覆會有 `memory` part，文字裡的區塊被拿掉；隊友不會當成聊天收到；儲存的建議出現在每個 agent 下一次的 briefing。
- 工具庫：依根目錄的專案記憶、briefing 的順序、`memory:project` 例外、大小警告。
- 用 `app.request()` 測 HTTP API：儲存、儲存時編輯、略過、第二次回應被拒、設定和刪除專案記憶。
- `test/native.test.ts`：列出 Grok 的全域主題。

## 步驟

1. 記憶建議，存進現有的 `all` 和各 CLI 的記憶。
2. 專案記憶。
3. 從 CLI 的記憶檔複製，以及在 Grok 卡片列出主題。
4. 為整個對話建議記憶。

## 考慮過的其他做法

- **由 Harness Relay 提供 `remember` MCP 工具。** 延後：每個 CLI 都要啟動一個 server process，而且它得有辦法連到 app；Claude Code 在完整權限以下每次呼叫 MCP 工具都會詢問，所以在自動拒絕的對話裡用不了；而且工具呼叫會在使用者決定之前就回傳。文字區塊在三個 CLI 上都一樣能用，也能用純函式測試，跟 `[ASK_USER]` 一樣。之後可以在同一套建議機制上再加工具。
- **不問就儲存。** 不採用為預設：記憶會影響之後每個對話，而 agent 可能被它讀到的內容誘導。可以之後做成依 scope 的設定（待決問題）。
- **寫進各 CLI 自己的記憶。** 不採用：三種格式和索引都屬於其他程式，而且會隨版本改變；就算寫進去，CLI 之間還是沒有共用。
- **用 repository 裡的一個檔案（`AGENTS.md`）當共用記憶。** 不是取代，而是並存：Codex 和 Grok 讀 `AGENTS.md`，Claude Code 讀 `CLAUDE.md`，團隊可以把它們 commit 進去。被要求時 agent 本來就能編輯它們。專案記憶是給不該 commit 的東西，或不是 repository 的資料夾用的。

## 待決問題

- 要不要讓某些 scope 不問就儲存建議（例如依 CLI，或對信任的專案）？
- 儲存的一行要不要記住來源（對話、agent、日期），在設定裡顯示、但不放進 briefing？
- repository 搬家時專案記憶怎麼辦？設定可以列出資料夾已不存在的專案，讓使用者搬移或刪除。
