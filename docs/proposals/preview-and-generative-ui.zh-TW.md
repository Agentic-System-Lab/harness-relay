[English](preview-and-generative-ui.md) | **繁體中文**

# 網站預覽與 Generative UI

> **狀態：提案，尚未實作。** 見[提案](README.zh-TW.md)。

回覆現在做不到兩件事：

1. **試用 agent 做出來的東西。** 團隊做了網站時，使用者在聊天旁的面板打開它、直接在那裡使用，在這台電腦或手機上都可以，出問題時按一下就能把錯誤交給 agent。
2. **用 UI 回覆。** agent 在回覆裡放選項、表單、圖表或小型互動頁面，使用者點選就能回答，不用打字。

兩者都會在使用者的瀏覽器裡執行 agent 寫的程式或標記，所以共用同一套安全設計：agent 的程式絕不在 app 的 origin 裡執行，預設也無法連到其他網站。

## 現在有什麼

- **回覆中連到本機檔案的連結是下載。** `[報告](out/report.pdf)` 會從 `GET /api/conversations/:id/messages/:messageId/download` 下載，一律是 `application/octet-stream` 加上 `Content-Disposition: attachment`、`nosniff` 與沙箱化的 `Content-Security-Policy`，「所以 agent 寫的 HTML 頁面或 SVG 永遠不會在 app 的 origin 裡執行」（[安全性](../architecture.zh-TW.md#安全性)）。agent 做的 `.html` 檔只能下載後自己打開。
- **檔案瀏覽器**把 `.html` 檔顯示成上色的文字（[瀏覽檔案](../architecture.zh-TW.md#瀏覽檔案)）。
- **回覆能畫出的東西**：Markdown、這台電腦上的圖片與影片（`![chart](out/chart.png)`，經媒體端點），以及 ```` ```mermaid ```` 圖表，畫成 `<img>`，裡面什麼都不會執行。回覆裡沒有任何可以互動的東西。
- **向使用者提問**：agent 在回覆結尾寫 `[ASK_USER]`（`src/shared/ask.ts`），團隊就會等（`conversation.pause`），使用者回覆後由提問的 agent 先回答。briefing 要 agent「有幫助時附上選項」，但選項只是文字，使用者讀完再自己打字回答。
- **API 的防護**：`src/server/app.ts` 的 middleware 會檢查 `Host` 與 `Origin`，每個寫入都要求 `application/json`。伺服器完全不送 CORS 標頭，所以其他 origin 的頁面讀不到回應，它的 JSON 寫入也會卡在瀏覽器的 preflight。`Origin` 檢查接受任何 port 的 localhost。
- **Process**：每個回合跑一個 CLI process（[CLI 轉接器](../architecture.zh-TW.md#cli-轉接器)）。agent 從自己的 shell 啟動的 dev server，Harness Relay 不會追蹤。伺服器只在回合被停止或逾時、以及關閉時，才會對回合的 process group 送訊號（`src/server/process.ts` 的 `killTree()`）。正常結束的回合之後，那個 dev server 不是被 CLI 收掉，就是繼續在使用者看不到的 port 上跑，app 裡也沒有地方能停掉它。
- **用手機連線**：`tailscale serve` 分享的是 port 8787；第二個 port 也能用同樣的方式分享，[用手機連線 → AgentsView](../remote-access.zh-TW.md#5-也瀏覽-agentsview選用) 就是這樣做的。

## 缺什麼

- 想看、想用 agent 做的網站，只能下載它的檔案，或在終端機裡跑它的 dev server；在手機上則完全沒辦法。
- 沒有回饋迴路：使用者在瀏覽器看到的錯誤，要自己複製才能交給 agent。
- 有選項的問題只能打字回答，表格是靜態的，agent 也無法展示任何互動的東西（計算機、可以調整的圖表、小遊戲）。

## 目標

- 在聊天旁的面板打開 agent 做的網站（靜態檔案或 dev server），在手機上也一樣。
- 按一下就把頁面的錯誤交給 agent。
- agent 可以在回覆裡放互動 UI，使用者操作它就是回答。Claude Code、Codex、Grok 用起來都一樣，唯讀對話也可以用。
- agent 寫的程式絕不在 app 的 origin 裡執行、無法呼叫 API，預設也不會從其他網站載入任何東西。

## 不在範圍內

- 部署、架站，或把預覽分享給其他人。
- 面板裡錯誤清單以外的開發者工具，以及給 agent 看的預覽截圖（見[待決問題](#待決問題)）。
- 讓 agent 自己操作預覽（點按鈕、填表單）。
- 承載 MCP Apps 或支援 AG-UI（見[考慮過的其他做法](#考慮過的其他做法)）。

## 設計

### 1. 預覽專用的 origin

如果 agent 的頁面在 app 的 origin 裡執行，它的腳本就能像介面一樣呼叫 `/api/`，開出有完整權限的 agent。經由 prompt injection 植入的頁面，例如從網站複製來的文字，也能做到。它還能讀取旁邊的檔案再送出去。所以預覽有自己的 origin。

- **第二個 listener**：在 `src/server/index.ts` 裡和 API 一起啟動，聽 `127.0.0.1:8788`（`RELAY_PREVIEW_PORT`；`off` 關閉預覽），有自己的小型 Hono app，在 `src/server/preview.ts`。不同的 port 就是不同的 origin。瀏覽器因此會阻止預覽讀取 app 的頁面或儲存空間，也無法呼叫 API：API 不送 CORS 標頭，它的 JSON 寫入又需要 preflight。多一層防護，API 的 middleware 也會拒絕 `Origin` 是預覽 port 的請求。
- **和 API 一樣的 `Host` 檢查**（localhost 名稱與 `RELAY_ALLOWED_HOSTS`），防止 DNS rebinding。
- **每個回應**都帶 `Cache-Control: no-store`（agent 會改寫檔案）、`X-Content-Type-Options: nosniff`，不帶 CORS 標頭，並帶一個 `frame-ancestors` 只列出 app 自己主機的 `Content-Security-Policy`，讓其他網站無法把預覽嵌進 frame。policy 的其餘部分見[網路](#3-網路與橋接腳本)。
- **一次一個預覽，放在預覽 origin 的根目錄。** 這樣 `/assets/app.js` 這種從根目錄開始的路徑、module script、`localStorage` 和 dev server 的熱重載，都和一般的本機伺服器一樣能用。打開另一個預覽就會取代它；還顯示舊預覽的面板會說明這件事，並提供切回去的按鈕。沒有開著的預覽時，預覽 origin 對每個路徑都回一個說明頁。
- **iframe**：`sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"`。這裡的 `allow-same-origin` 指的是預覽自己的 origin，不是 app 的。沒有 `allow-top-navigation`，頁面就無法把 app 導到別處。
- **網址**：`GET /api/preview` 告訴介面預覽的 port，介面再沿用自己的 scheme 與主機名稱。在這台電腦上是 `http://localhost:8788/`；用 `tailscale serve --bg --https=8788 8788` 分享這個 port 之後，則是 `https://my-computer.tail1234.ts.net:8788/`。[用手機連線](../remote-access.zh-TW.md) 會加上這一步，就像 AgentsView 那一步。

### 2. 可以預覽什麼

| 種類 | 內容 | 由誰提供 |
| --- | --- | --- |
| **檔案** | 工作目錄或某位成員 worktree 裡的一個資料夾（`site/`、`dist/`、根目錄）和它的入口頁（沒指定檔案就是 `index.html`） | 預覽伺服器讀取檔案 |
| **指令** | dev server：`npm run dev`、`vite`、`python -m http.server`… | 由 Harness Relay 啟動，並轉送請求 |

預覽的目標是 `{ conversationId, root: 'cwd' | <agentId>, folder, entry? | command? }`。

**檔案。**

- 路徑在資料夾內解析，規則和檔案瀏覽器相同（`src/server/files.ts` 的 `resolveInRoot()`）：跟隨符號連結之後，資料夾外和 `.git` 裡的都不提供。名稱以點開頭的檔案與資料夾（`.env`、`.claude/`）也不提供。
- `/` 提供入口頁，資料夾則提供它的 `index.html`。找不到的檔案是 404，資料夾有 `404.html` 時就用它。
- 媒體類型來自固定的對照表：HTML、CSS、JavaScript、JSON、source map、SVG 與圖片、字型、WebAssembly、音訊、影片與文字。其他一律是 `application/octet-stream`。影片和媒體端點一樣支援 byte range。

**指令。**

- **只有使用者能啟動指令，agent 不能。** 卡片會顯示指令和它執行的資料夾，加上 **啟動** 按鈕。資料夾有 `package.json` 時，卡片會提供它的 `dev`、`start`、`preview` script，用 lockfile 指出的套件管理器執行。
- **受追蹤的長時間 process**：由 `src/server/process.ts` 新增的 `startService()` 在自己的 process group 裡啟動。按 **停止**、被其他預覽取代、對話被刪除、30 分鐘沒有請求，以及伺服器關閉時（`killAll()`），都會結束整個 group。
- **環境變數**：伺服器自己的環境，但不含 Claude Code 的巢狀執行變數，也不含存起來的 API 金鑰（那是給 CLI 用的）。另外加上 `PORT`（一個空著的 port）、`HOST=127.0.0.1` 和 `BROWSER=none`。
- **找出它的網址**：取它印出的第一個 `http://localhost:N`、`127.0.0.1:N`、`0.0.0.0:N` 或 `[::1]:N`（去掉 ANSI 碼之後）。沒有的話，就等給它的 `PORT` 開始接受連線。60 秒內都沒有，預覽就算失敗，並顯示輸出的最後一段。找網址是一個只處理輸出行的純函式，用常見 dev server 錄下的輸出來測試。
- **轉送請求**：HTTP 和 WebSocket upgrade（熱重載）都轉到 `127.0.0.1:<port>`。`Host` 與 `Origin` 會改寫成 dev server 自己的，讓它的主機檢查通過（例如 Vite 的 `server.allowedHosts`）。要 HTML 時會帶 `Accept-Encoding: identity`，才能在裡面加入橋接腳本。輸出的最後 64 KB 會留給面板的 **輸出** 分頁。
- **平行模式**：指令在那位成員的 worktree 裡執行。worktree 裡沒有被忽略的檔案，例如 `node_modules/`（[已知限制](../architecture.zh-TW.md#已知限制)），所以啟動失敗時會顯示輸出，那裡通常會說要先安裝相依套件。
- **信任**：指令以使用者的權限執行專案程式碼，在任何 agent 的沙箱之外，唯讀對話也一樣。這和使用者自己在終端機裡執行相同，所以只有使用者按下按鈕才會啟動。卡片上會寫明這一點。

### 3. 網路與橋接腳本

**預設不連網。** 每個 HTML 回應都帶這個 policy：

```
default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval';
connect-src 'self' ws://<host>:<port> wss://<host>:<port>;
form-action 'self';
frame-ancestors <app 的主機>
```

- 因此預覽可以載入自己的檔案，但不能從其他網站載入腳本、樣式、字型或圖片，也不能用 `fetch` 去拿。面板會計算被擋下的請求，並提供 **允許這個預覽連網**，把來源放寬成 `*`，對這個目標有效到伺服器重啟為止。這維持了現在的規則：除非使用者自己選擇，agent 的回覆不能讓瀏覽器連到其他網站。
- **擋不住的事**：頁面把自己導到其他網站，並把資料放在網址裡。沒有 policy 能管 frame 自己的導覽。橋接腳本會回報這種導覽，面板會說明頁面已經離開預覽。「不連網」的意思是頁面不會從其他網站載入東西，並不保證能防住刻意寫來做壞事的頁面；預覽讀得到的也只有它資料夾裡的檔案。

**橋接腳本**是 `/__relay/bridge.js` 的一小段腳本，這個路徑由預覽 origin 保留。它會被加成每個 HTML 回應裡的第一個腳本，從 dev server 轉送來的也一樣。它把訊息送給上層 frame。因為 `frame-ancestors` 只允許 app 嵌入預覽，上層就是 app，而面板只接受 `event.source` 是自己 iframe 的訊息。它回報：

- 沒有被接住的錯誤和被拒絕的 promise、`console.error` 與 `console.warn`（前 200 則，每則最多 2 KB）、載入失敗的資源，以及被 policy 擋下的請求；
- 目前的路徑（給面板的網址欄），以及離開預覽的導覽。

**交給 agent**：面板的 **問題** 清單有一個按鈕，會把以下內容填進輸入框（不會直接送出）：先 @ 打開這個預覽的那則回覆的 agent（從檔案瀏覽器打開的就不 @），再接上問題：

```
@Claude
<preview_console page="/checkout">
TypeError: Cannot read properties of undefined (reading 'total') at app.js:42:17
GET /api/cart 404
</preview_console>
```

使用者可以先修改再送出。briefing 會說明 `<preview_console>` 區塊是頁面自己的輸出：是資料，不是指示。

### 4. 預覽從哪裡來

- **回覆中連到本機 `.html` 或 `.htm` 檔的連結**，例如 `[到達頁](site/index.html)`，會變成 **預覽** 連結，旁邊附下載圖示。它會打開面板，以那個檔案所在的資料夾為目標、那個檔案為入口頁。平行模式下，根目錄是回覆的 agent 工作的地方，順序和媒體端點相同（`mediaRoots()`），所以每位成員的版本都能打開。
- **給 dev server 用的 ```` ```preview ```` 區塊**：

  ````
  ```preview
  command: npm run dev
  folder: web
  ```
  ````

  它會畫成上面說的卡片。只讀 `command` 和 `folder`，各佔一行。解析不了的區塊維持程式碼區塊。
- **檔案瀏覽器**：`.html` 檔上有 **預覽**，有 `package.json` 的資料夾上有 **啟動預覽**。
- **briefing**（英文，在 `src/server/prompt.ts`）在說明媒體與下載的段落旁加兩行。一行說：由檔案組成的網站，連結它的入口頁。另一行說：dev server 的指令放在 `preview` 區塊裡，不要自己啟動，因為由使用者啟動。

### 5. 預覽面板

- 和 **檔案**（`FileBrowser`）一樣是較寬的抽屜。寬螢幕上它放在聊天旁邊，成為分割畫面；手機上則佔滿整個畫面。
- 工具列：上一頁、重新整理、預覽內的路徑、寬度（**完整**、**平板** 768 px、**手機** 390 px）、**允許連網**、在新分頁開啟、根目錄（工作目錄或某位成員的 worktree），指令預覽還有 **停止** 和 **輸出**。**問題** 的數字會打開清單。
- 面板跟著目標，不是跟著某則訊息，所以 agent 繼續修改時它也一直開著。靜態預覽按 **重新整理** 才會重新載入（見[待決問題](#待決問題)）。
- 所有字串都放進 `src/web/locales/zh-TW.ts` 與 `en.ts`；伺服器訊息（指令失敗、預覽被取代）放進 `src/server/i18n.ts`。

### 6. Generative UI：`relay-ui` 區塊

agent 用資料描述 UI，由 app 用自己的元件畫出來。不會執行任何 agent 的程式。

````
```relay-ui
{
  "title": "選一個到達頁的方向",
  "components": [
    { "type": "choice", "id": "style", "label": "風格", "options": [
      { "value": "minimal", "label": "極簡" },
      { "value": "bold", "label": "大膽", "description": "大字、強烈的顏色" }
    ] },
    { "type": "slider", "id": "budget", "label": "預算", "min": 0, "max": 10000, "step": 500, "unit": "USD" },
    { "type": "toggle", "id": "dark", "label": "也要深色模式" }
  ],
  "submit": "就用這些"
}
```
````

**元件目錄（v1）：**

| 元件 | 用途 | 欄位 |
| --- | --- | --- |
| `text` | Markdown 文字 | `text` |
| `choice` | 選一個或多個 | `id`、`label`、`options`（`value`、`label`、`description?`）、`multiple?` |
| `input` | 文字、長文字、數字、日期、時間 | `id`、`label`、`kind`、`placeholder?`、`default?`、`required?`、`min?`、`max?` |
| `select` | 很長的清單 | `id`、`label`、`options`、`default?` |
| `toggle` | 是或否 | `id`、`label`、`default?` |
| `slider` | 範圍內的數字 | `id`、`label`、`min`、`max`、`step?`、`default?`、`unit?` |
| `buttons` | 點一下就是回答 | `buttons`（`value`、`label`） |
| `table` | 資料，可依欄位排序 | `columns`、`rows` |
| `chart` | 長條圖、折線圖或圓餅圖 | `kind`、`labels`、`series`（`name`、`values`）、`unit?` |
| `steps` | 計畫的進度 | `items`（`label`、`status`：`done`、`doing`、`todo`） |

**解析**由 `src/shared/ui.ts` 裡的一個純函式負責（`parseUi(text)`）：介面用它來畫，伺服器用它來檢查回答、寫出回答的摘要。

- 只接受 JSON，用 `JSON.parse` 讀取。
- 上限：每個區塊 20 KB、40 個元件、100 個選項、表格 500 列、12 條數列且每條 200 個點。太長的字串會被截斷。
- 不認得的元件種類和欄位會被拿掉，區塊下方附一行小說明。不是有效 JSON 的區塊會顯示成程式碼並附警告。回覆串流中、區塊的 fence 還沒結束時，先顯示佔位框。
- 不能有網址：沒有圖片，也沒有連到其他網站的連結。`text` 元件照聊天室自己的 Markdown 規則處理，所以本機檔案會變成下載或預覽，網路上的圖片仍然只是連結。

**畫出來**：`src/web/components/RelayUi.tsx`，使用 app 的樣式（兩種主題都適用）、可以用鍵盤操作，app 自己的字串（例如預設的 **送出**）有兩種語言。圖表是 app 自己畫的 SVG，不需要圖表函式庫。

**回答**：

- 區塊裡只要有需要回答的東西（`choice`、`input`、`select`、`toggle`、`slider`、`buttons`），這則回覆就算在向使用者提問，就像結尾寫了 `[ASK_USER]`：回覆會標成 `asked`，團隊會等。
- 按 **送出** 會經由 `Orchestrator.send()` 送出一則一般的使用者訊息。`buttons` 的按鈕，或唯一的問題就是一個單選 `choice` 的區塊，點下去就送出。訊息的文字是用使用者語言寫的易讀摘要（`風格：極簡 · 預算：3,000 USD · 也要深色模式：是`），所以在聊天裡讀起來自然，每個 agent 也都看得懂。新欄位 `uiAnswer: { messageId, values }` 帶著實際的值。
- 伺服器會再解析一次提問那則回覆的區塊，逐一檢查每個值是否符合它的元件（id、類型、選項、範圍）。回答的對象沒有這樣的區塊、或已經被回答過，都會被拒絕。
- agent 收到的是 `<message from="user" via="form">`，裡面有摘要和一個 `<form_values>` JSON 區塊。和打字回答一樣，由提問的 agent 先回答。
- 回答之後，區塊會顯示選了什麼，不再接受輸入。改成打字回覆也一樣算回答，和現在相同。
- 其他 agent 在歷史紀錄裡看到的是區塊原本的樣子（JSON），所以讀得懂問了什麼。

**briefing** 用大約十五行說明元件目錄，也說明什麼時候適合用區塊（有選項可選、要填幾個欄位、數字畫成圖表比較清楚），什麼時候不適合（以文字為主的內容）。`[ASK_USER]` 規則裡的「有幫助時附上選項」改成指向 `choice` 區塊。

### 7. HTML 小工具

用來做元件目錄做不到的東西：互動圖表、計算機、小遊戲、附滑桿的說明頁。

- **放在回覆裡**：一個 ```` ```relay-html ```` 區塊，內含一份自成一體的 HTML 文件。唯讀對話也能用，因為不需要寫入磁碟。也可以用 `![房貸試算](out/calc.html)` 嵌入 agent 存好的 HTML 檔。圖片語法是嵌入小工具，連結語法則是打開[預覽面板](#5-預覽面板)。
- **直接畫在訊息裡**，用 `<iframe sandbox="allow-scripts" srcdoc="…">`，不加 `allow-same-origin`。小工具拿到的是 opaque origin，所以讀不到 app 和它的儲存空間。它對 API 的請求帶的是 `Origin: null`，會被 middleware 拒絕，也拿不到 CORS 標頭。它不需要第二個 port，所以手機上不用額外設定 Tailscale 就能用。
- **永遠不連網。** app 會把 `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:">` 放在文件 `<head>` 的最前面。policy 只會被後面的內容收得更緊，所以小工具自己的標記放寬不了它。沒有開關：需要連網的小工具應該做成預覽。
- **小工具的橋接腳本**放在 policy 之後，做三件事：
  - 依內容設定 iframe 的高度，最多到視窗的 80%，超過就在小工具裡捲動；
  - 用記憶體裡的 `localStorage` 與 `sessionStorage` 取代真正的那兩個，因為它們在 opaque origin 裡會丟例外；
  - 提供 `relay.send(text)`，把文字填進輸入框（最多 4 KB）。使用者還是要自己按送出，所以小工具無法自己跟 agent 對話。
- **上限**：一份文件，最多 512 KB。檔案小工具經由下載端點取得，路徑檢查相同。它裡面的相對路徑不會載入，所以 briefing 會說明：小工具是單一檔案，由多個檔案組成的網站要做成預覽。
- **滑鼠移上去時**：全螢幕、檢視原始碼，檔案小工具還有「以預覽開啟」。
- 準備文件（policy 和橋接腳本放在哪裡：`<!doctype>` 之後、`<head>` 裡面，以及大小上限）是 `src/web/widget.ts` 裡的一個純函式。

### 安全性一覽

| 程式來自 | 在哪裡執行 | 能不能呼叫 API | 網路 | 儲存空間 |
| --- | --- | --- | --- | --- |
| app | app 的 origin | 能 | — | — |
| 預覽（檔案或指令） | 預覽 origin（`:8788`） | 不能：不同的 origin、沒有 CORS，它的 `Origin` 會被拒絕 | 預設關閉；使用者可以為個別預覽開啟 | 預覽 origin 的，所有預覽共用 |
| HTML 小工具 | opaque origin（`srcdoc` 沙箱） | 不能：`Origin: null` 會被拒絕，沒有 CORS | 永遠不行 | 在記憶體裡，重新載入就沒了 |
| `relay-ui` 區塊 | 不執行任何東西：由 app 的元件畫出 | — | 永遠不行 | — |

每一步做出來時，架構文件的[安全性](../architecture.zh-TW.md#安全性)一節都會加上這些規則。

## HTTP API

| 方法與路徑 | 用途 |
| --- | --- |
| `GET /api/preview` | `{ port, active }`：預覽的 port，以及開著的預覽（`PreviewState`）或 `null` |
| `POST /api/conversations/:id/preview` | `{ root, folder, entry? }` 或 `{ root, folder, command }` → `PreviewState`：打開預覽、取代開著的那個，並啟動它的指令 |
| `PUT /api/preview/network` | `{ allow }`：開著的預覽的 **允許連網** |
| `GET /api/preview/output` | 開著的預覽的指令輸出，最後 64 KB |
| `DELETE /api/preview` | 關閉開著的預覽，並停止它的指令 |
| `GET /api/conversations/:id/files/scripts?root=&path=` | 資料夾 `package.json` 的 script，以及 lockfile 指出的套件管理器 |
| `POST /api/conversations/:id/messages` | 多接受一個選填的 `uiAnswer: { messageId, values }`（檢查方式見第 6 節的「回答」） |

`PreviewState` 是 `{ id, conversationId, root, folder, entry?, command?, status, error?, network, startedAt }`，`status` 是 `starting`、`running`、`failed` 或 `stopped`。它每次改變時，`preview` SSE 事件都會送給開著的頁面。

在預覽 origin 上，`/__relay/bridge.js` 是橋接腳本，其他路徑都屬於目標。

## 資料庫

- 在 `src/server/db.ts` 的 `MIGRATIONS` 後面加一個 migration：`messages` 上一個可為空的 `ui_answer` 欄位（JSON）。
- 預覽只存在記憶體裡。重啟會停掉它們，開著的面板就會顯示預覽已停止。**允許連網** 的選擇也只存在記憶體裡（見[待決問題](#待決問題)）。
- `RELAY_PREVIEW_PORT` 加進開發者說明的環境變數。

## 測試

全部離線。指令預覽用假的 service runner；轉送請求的測試由測試自己在隨機的本機 port 上啟動一個小型 HTTP 與 WebSocket 伺服器。

- `test/preview.test.ts`（新）：
  - 檔案：入口頁、多層資料夾、從根目錄開始的路徑、指到外面的符號連結、點開頭的檔案與 `.git`（都是 404）、媒體類型、byte range；
  - 標頭：`no-store`、`nosniff`、`frame-ancestors`、沒有 CORS、網路 policy 與它的開關，橋接腳本只加在 HTML 裡；
  - `Host` 檢查、沒有開著的預覽時的說明頁，以及預覽取代另一個預覽；
  - 從錄下的輸出找出 dev server 的網址（Vite、Next.js、Create React App、`python -m http.server`）、60 秒逾時、**停止** 和刪除對話都會結束 group、閒置停止（假計時器），以及不含存起來的 API 金鑰的環境；
  - 轉送請求：改寫過的 `Host` 與 `Origin`、WebSocket upgrade、加了橋接腳本的 HTML。
- `test/app.test.ts`：API 拒絕來自預覽 port 的 `Origin`；新路由與 `uiAnswer` 的檢查。
- `test/ui.test.ts`（新）：每種元件的 `parseUi()`、上限、不認得的欄位、無效的 JSON 與還沒結束的 fence；檢查回答；兩種語言的摘要文字。
- `test/widget.test.ts`（新）：policy 和橋接腳本放的位置（有和沒有 `<!doctype>` 與 `<head>` 時），以及大小上限。
- `test/markdown.test.ts`：`.html` 連結變成預覽，`![…](x.html)` 變成小工具；`preview`、`relay-ui`、`relay-html` 區塊；一般的 ```` ```html ```` 區塊仍是程式碼。
- `test/orchestrator.test.ts`：有 `relay-ui` 區塊的回覆會提問、團隊會等；帶 `uiAnswer` 的訊息先交給提問的 agent，並標成 `via="form"`。
- `test/prompt.test.ts`：新的 briefing 內容。`test/store.test.ts`：`ui_answer` 欄位。`test/i18n.test.ts`：兩種語言的結構一致。

## 步驟

1. **預覽 origin 與靜態預覽**：面板、附 **問題** 和 **交給 agent** 的橋接腳本、回覆裡的預覽連結，以及檔案瀏覽器的 **預覽**。同時更新架構（安全性、新的預覽一節）、開發者說明、使用說明與用手機連線，兩種語言都要。
2. **`relay-ui` 區塊**：先做 `choice`、`buttons`、`input`、`select`、`toggle` 和 `table`，以及提問與回答的流程；再做 `slider`、`chart` 和 `steps`。
3. **HTML 小工具**：`relay-html` 區塊與 `![…](x.html)`。
4. **指令預覽**：dev server、含熱重載的請求轉送，以及閒置停止。

每一步單獨就能用。步驟 2 和 3 不依賴步驟 1 的第二個 port。

## 考慮過的其他做法

- **在 app 自己的 port 上、用沙箱 iframe（opaque origin）提供預覽。** 不需要第二個 port，手機也直接能用。但儲存空間會丟例外，所以把清單存在 `localStorage` 的待辦 app 一載入就壞。module script 需要 CORS，專案檔案就得帶 `Access-Control-Allow-Origin` 提供。從根目錄開始的路徑在路徑前綴下會壞，dev server 也無法在路徑前綴下轉送。小工具採用這個做法，因為單一、自成一體的文件不需要上面那些。
- **每個預覽一個 port。** 可以同時開好幾個預覽，各有自己的儲存空間。但手機上每個 port 都要多一行 `tailscale serve`，policy 和 `Origin` 檢查要知道的主機也跟著變多。如果一次一個不夠用，之後可以再做（見[待決問題](#待決問題)）。
- **localhost 的子網域（`<id>.localhost:8788`）。** 一個 port 上可以有很多個彼此隔離的預覽。但不是每個瀏覽器都會解析 `*.localhost`，而 tailnet 的名稱也沒有子網域。
- **iframe 直接顯示 dev server 自己的 port。** 在這台電腦上最簡單，但手機上不能用。橋接腳本也加不進去，網路 policy 也套不上。
- **讓 agent 自己啟動 dev server。** 它們的背景 process 跟著 CLI 回合生滅，Harness Relay 看不到也停不了；唯讀的 agent 也會因此多一個執行程式的管道。
- **畫出每個 ```` ```html ```` 區塊。** agent 會用這個 fence 展示程式碼，範例就會變成會執行的頁面。用專屬的 fence（`relay-html`）才表示 agent 是刻意要做小工具。
- **MCP Apps、AG-UI、A2UI。** Harness Relay 不呼叫模型 API，也不是 MCP host；MCP host 是各 CLI，而它們的輸出不會把 MCP App 的 `ui://` 資源交出來，所以 Harness Relay 沒有東西可以承載。AG-UI 則預期 app 是 agent 的後端。在 briefing 裡教的文字約定，三個 CLI 都能一樣使用。`relay-ui` 的元件目錄和 A2UI 的想法相同（一組受信任的元件，不執行 agent 的程式），之後也可以對應過去。
- **`relay-ui` 用 YAML。** 模型比較好寫，但需要一個解析套件，也比較容易出現不易察覺的錯。JSON 只需要 `JSON.parse`。
- **讓小工具自己送出訊息。** 對 agent 比較簡單，但小工具就能不經使用者跟團隊對話，甚至一直來回。只填進輸入框，使用者就始終在中間把關。

## 待決問題

- 靜態預覽要不要在 agent 改了檔案時自己重新載入（監看資料夾，由橋接腳本重新載入頁面）？agent 反覆修改時很方便，但可能會丟掉使用者在頁面裡打到一半的東西。
- 目標換到另一個資料夾時，要不要清掉預覽 origin 的儲存空間（`Clear-Site-Data`）？清掉可以讓一個網站的資料不會留給下一個；留著則讓使用者回來時接著用。
- 一次一個預覽夠不夠？還是值得為了每個預覽一個 port，多做 Tailscale 設定？
- 要不要讓 agent 看到預覽的截圖？面板擷取不了其他 origin 的 frame。橋接腳本可以把頁面畫成圖片，但結果只是近似，負擔也重。
- 有預覽連結的回覆，要不要在回合結束時自動打開面板？
- `relay-ui` 的回答送出後，要不要能修改？
- **允許連網** 要不要依對話記在資料庫裡？
