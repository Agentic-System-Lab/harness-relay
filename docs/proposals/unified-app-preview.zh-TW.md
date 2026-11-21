[English](unified-app-preview.md) | **繁體中文**

# 每種應用程式都用同一種方式預覽

**狀態。** 尚未開始。它依賴的三個機制已在真實的引擎上試過（見下方「試過的部分」）。它延伸[應用程式預覽的執行環境](app-preview-runtime.zh-TW.md)，原有的靜態與 npm 路徑維持不變。

## 現在有什麼、缺什麼

目前 **預覽應用程式** 能開三種專案：靜態 HTML（不需要 Docker）、需要建置的 npm 前端，以及只有一個 HTTP 入口的 Node.js 後端。npm 路徑很嚴格：Relay 在主機上依公開 registry 的 SHA-512 核對每個鎖定的套件，容器全程沒有網路。正因為有這個保證，它只做得到 npm。

agent 做出來的東西遠不只這些。實際的對話裡有三個缺口：

- **其他語言。** Flask 或 FastAPI 應用程式、Go 或 Rust 伺服器、Spring 應用程式、PHP 網站。每種生態系鎖定套件的方式都不同，有幾種根本沒有含雜湊值的 lockfile。
- **不只一個程序。** 有自己資料庫的應用程式。促成這份提案的 todo app 就是 React 前端、Express API，加上 `docker-compose.yml` 裡的 PostgreSQL。現在只能預覽前端，而它的 API 沒有資料庫可連。
- **沒有網頁的應用程式。** 命令列工具、終端機介面（TUI）、文字遊戲、REPL。它們從終端機讀輸入、往終端機寫輸出，框架裡沒有東西可以顯示。

## 約定

**應用程式就是一個容器。它提供 HTTP，或在終端機上互動，或兩者都有。** 這個約定適用於每種語言，因為怎麼建置、怎麼執行，是專案自己說的，不是 Relay 猜的：

| 專案裡有 | Relay 執行 |
| --- | --- |
| `compose.yaml` 或 `docker-compose.yml` | 它的各個服務，依 Relay 的規則改寫（見下方），放在一個自己的、無法對外連線的網路上。 |
| `Dockerfile` | 從它建置出的一個容器。 |
| npm 專案，沒有 `Dockerfile` | 現在核對過、離線的 npm 路徑，不變。 |
| 只有 HTML | 現在的靜態預覽，不需要 Docker。 |

專案自己宣告的做法優先於 Relay 的推測：有 `Dockerfile` 的 npm 專案會用 `Dockerfile` 執行。資料夾裡這些都沒有時，面板會說明，並提供一份給回覆作者的草稿：「請加上 `Dockerfile`（需要資料庫時再加上 `compose.yaml`），讓這個應用程式可以預覽。」agent 的說明也會多一行，寫的是同一個約定，這樣不論 agent 選了哪種語言，它做的網頁應用程式或工具從一開始就能預覽。

## 一種執行環境，兩種畫面

每個容器預覽都讓主程序跑在終端機（TTY）上。面板一開始顯示這個終端機：先是建置紀錄，接著是應用程式自己的輸出。如果應用程式開始在它的 HTTP port 接受連線，面板就切到網頁，終端機留在旁邊的分頁，顯示伺服器的紀錄。如果一直沒有，那它就是終端機應用程式，終端機就是預覽：使用者在裡面輸入、調整大小，看 TUI 畫出的畫面。

這些都不需要事先宣告。網頁伺服器的紀錄和命令列工具的提示都出現在終端機上，只靠「port 有沒有開」來分辨。程序結束時，面板會顯示結束代碼，並提供 **再執行一次**、給命令列工具用的參數欄，以及 **開啟 shell**：用同一個映像開一個新容器，給需要反覆呼叫的工具使用。**將錯誤加入訊息** 除了網頁的錯誤，也會帶上終端機的最後幾行，放在 agent 已經當成資料看待的同一個 `<preview_console>` 區塊裡。

HTTP port 是映像用 `EXPOSE` 宣告的那一個（剛好宣告一個時），否則就是 `PORT`（4173），Relay 會像現在一樣把它設在環境變數裡。在 compose 檔裡，它是網頁服務 `ports` 項目中容器那一側的 port，Relay 絕不會把它發布到主機上。

桌面 GUI 應用程式（用 Tk、Qt 或 Electron 畫視窗的）不在範圍內。之後也許可以在面板裡放遠端桌面。

## 建置

Relay 把快照（排除項目與上限都和現在一樣：沒有 `.git`、`.env*`、憑證、已安裝的相依套件或連結）以 tar 的形式從標準輸入交給 `docker build` 當作建置內容。主機上的任何東西都不會被掛載或指名。映像會加上 Relay 的擁有者標籤，預覽停止時移除；BuildKit 的快取會保留，Relay 依標籤在磁碟上限內清理。

和 npm 路徑不同，建置需要網路：`pip install`、`go mod download` 和 `cargo build` 都要下載套件，而且沒有一個地方能把它們全部核對。這是唯一真正放寬的地方，但有界線：

- 只有建置有網路，應用程式本身永遠沒有。
- 建置只看得到快照：沒有主機路徑、Docker socket、Relay 的資料、CLI 憑證，也沒有使用者的環境變數。
- 它能連到的範圍，不超過 agent 在完全存取下於主機執行 `npm install` 或 `pip install` 時，那個 todo app 的 `node_modules` 就是這樣來的。
- **第 4 步** 會再縮小：一個 Relay 自己的 BuildKit builder（buildx 的 `docker-container` driver），有 CPU 和記憶體上限，放在內部網路上，唯一的出口是只允許套件與映像 registry 的 proxy。

## 執行

每個服務都沿用現在的加固設定：去掉所有 capability、`no-new-privileges`、CPU／記憶體／程序數上限、不掛載主機路徑、沒有 Docker socket、用 Relay 的擁有者標籤清理，閒置與最長存活時間也一樣。單一容器用 `--network=none`。compose 的服務共用一個內部網路，彼此可以用名稱連線，但連不到外面。

因為映像不再由 Relay 控制，有兩點和 npm 路徑不同。映像自己決定執行的使用者，允許 root，但沒有任何 capability。它自己的檔案系統可寫入、用完即丟，而不是唯讀加上一個暫存資料夾。**重新載入** 保留執行中的容器與資料，**重建** 從新的快照重新建置，**停止** 移除容器、網路、volume 與映像。

## 連到應用程式

轉送方式不變：Relay 用 Docker exec 執行固定的轉送程式（`previewDockerWire.ts`），應用程式只需要自己的 loopback。沒有 Node.js 的映像跑不了那個轉送程式，所以它改放到 sidecar：一個用固定版本 Node 映像的容器，沒有權限、唯讀，加入應用程式容器的網路命名空間（`--network=container:<id>`）。它從 `127.0.0.1` 連到應用程式，自己沒有任何網路。compose 時，sidecar 加入網頁服務的命名空間。

網頁原有的一切都保留：獨立的 origin、由 proxy 消耗的憑證、標頭白名單、CSP 與沙箱化的框架。

## 終端機

Relay 透過 Docker Engine API 和終端機溝通，用的是它已經檢查過的同一個本機 socket 或具名管道：對已建立的容器 `attach`（在 `start` 之前，才不會漏掉第一個提示）會得到一條雙向的原始終端機位元組串流，`resize` 則把面板的大小傳過去。這裡不能用 `docker` CLI：當它自己的輸入不是終端機時，`attach` 和 `exec -t` 都會拒絕，而伺服器的輸入從來都不是。

瀏覽器透過 SSE 收到輸出，就像收到聊天的其他內容一樣，有上限、以 base64 編碼；按鍵和大小變更則用 POST 送到 `/api/`，經過一般的檢查。面板用 xterm.js 繪製，只在開啟終端機時才載入。xterm.js 只畫文字、不執行任何東西，但輸出仍是應用程式產生的：OSC 52 剪貼簿寫入保持關閉，連結只有在點擊時才會在新分頁以 `noopener` 開啟。只有開啟預覽的那個瀏覽器能在裡面輸入。

## 改寫 compose

Relay 絕不直接執行 compose 檔。它讀取正規化後的模型（`docker compose config --format json`），保留應用程式需要的、改寫會碰到主機的、拒絕其餘的：

- **保留：** `image`、`build`（建置內容在快照內）、`command`、`entrypoint`、`environment`、`depends_on`、`healthcheck`、`working_dir`、`user`、`tmpfs`。
- **改寫：** 每個網路都換成這個預覽的內部網路；`ports` 變成 sidecar 轉送的目標，絕不發布到主機。專案檔案的 bind mount 變成從快照複製的唯讀副本，todo app 的 `./db/init.sql:/docker-entrypoint-initdb.d/init.sql:ro` 就是常見的例子。具名 volume 變成這個預覽自己的 volume，**停止** 時移除。
- **拒絕，並在面板說明原因：** `privileged`、`cap_add`、`devices`、設為 `host` 的 `network_mode`、`pid` 或 `ipc`、外部網路或 volume、Docker socket，以及專案以外的 bind mount。
- **環境變數：** 只來自檔案本身，絕不取自使用者的環境變數或 `.env` 檔（快照不會帶它）。缺少的變數就是空的。

上限同時適用於每個服務和整個預覽。

## 不採用的做法

- **每種生態系各做一條核對過的離線路徑**，像 npm 那樣：保證最強，但每種語言都是另外的工作，有幾種沒有含雜湊值的 lockfile，而且都涵蓋不了資料庫服務或終端機應用程式。這條路只保留給 npm。
- **以自動產生的建置為主**（Railpack、Cloud Native Buildpacks）：不需要 `Dockerfile`，但工具鏈很大，對啟動指令也有自己的猜測。專案完全沒有做法時，也許可以補上這個缺口，列在下方未決問題。
- **預覽 agent 在主機上啟動的開發伺服器：** 任何語言都行、不需要 Docker，但它以使用者自己的權限在任何隔離之外執行，agent 的回合結束時就會停止，port 也可能和別的衝突。
- **在容器裡放網頁終端機**（ttyd、gotty）：每個映像都得有那個執行檔。Engine API 不需要映像裡有任何東西。
- **終端機用 WebSocket：** 多一個相依套件，也要多設定 proxy（Vite、Tailscale Serve）。SSE 和 POST 用的是 Relay 已經有的機制。如果打字感覺慢再重新考慮。

## 未決問題

1. **第 1 到 3 步建置時的網路：** 如上所述用預設網路，還是一開始就用只允許 registry 的 proxy？
2. **容器裡的 root：** 如提案允許、但沒有 capability，還是映像沒設定非 root 的 `USER` 就拒絕？
3. **基底映像：** 任何 registry 都可以，還是只限 Docker 官方映像加上使用者維護的清單？
4. **完全沒有做法時：** 只提供給 agent 的草稿，還是另外提供一個按鈕，用自動產生的建置（Railpack）？
5. **磁碟：** 映像與建置快取保留多少，以及設定裡是否要顯示用量並提供清除按鈕。

## 交付順序

1. **`Dockerfile` 網頁應用程式。** 在回覆與「檔案」中偵測、面板裡顯示建置紀錄、sidecar 轉送、依標籤清理映像，並在 Linux CI 上用 Flask 應用程式做端對端測試。
2. **終端機。** Engine API 的 attach 與 resize、SSE 與 POST、xterm.js；面板先開終端機、port 開啟後切到網頁；結束代碼、**再執行一次**、參數與 **開啟 shell**。用終端機應用程式做端對端測試。
3. **Compose。** 正規化、改寫與拒絕、內部網路、bind mount 的副本、每個預覽自己的 volume、網頁服務的 port。以含 PostgreSQL 的 todo app 作為驗收範例。
4. **更窄的建置與更好的起點。** Relay 自己有上限的 builder 與只允許 registry 的 proxy、agent 說明裡的那一行、給 agent 的草稿，以及未決問題的決定。

npm 與靜態路徑之後也可以移進同一個面板，npm 的建置紀錄就顯示在終端機分頁。

## 試過的部分

2026-11-22，在 Apple Silicon 的 macOS 上用 OrbStack（Docker 29.8.2、buildx 0.37.2、Compose 5.5.0）：

- **`Dockerfile` 加上 sidecar。** 一個 Flask 應用程式（`FROM python:3.13-slim`，建置時 `pip install`），從標準輸入的 tar 建置內容，11 秒建好。它以 `--network=none`、唯讀、去掉所有 capability、加上一般的上限執行。一個固定版本 Node 映像的 sidecar 以 `--network=container:<app>`、使用者 1000、唯讀執行，從 `127.0.0.1:4173` 對它送出 POST 與 GET 都成功。應用程式連不到網際網路，sidecar 也解析不了任何名稱。
- **透過 Engine API 的終端機應用程式。** 用 Node.js 經 Unix socket：一個開啟 `Tty` 與 `OpenStdin` 的容器執行 Python 的 `input()` 程式，沒有網路、唯讀、使用者 1000、去掉所有 capability。在 start 之前 attach，提示有出現，輸入的回答與回顯也回來了，`resize` 成 132×40 後 `shutil.get_terminal_size()` 也拿到這個大小，`wait` 則回傳結束代碼。
- **內部網路上的 compose。** 兩個 `postgres:16` 服務放在 `internal: true` 的網路上：第二個用服務名稱連到第一個並查詢成功，查不到外部名稱，也無法連到外部位址。整個過程兩秒。

尚未試過：Windows（Engine API 的具名管道）、Docker Desktop 與 Linux 上的 Docker Engine、有上限與 proxy 的 buildx builder，以及 compose 改寫本身。
