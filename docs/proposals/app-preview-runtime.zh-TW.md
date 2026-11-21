[English](app-preview-runtime.md) | **繁體中文**

# App 預覽的執行環境

**實作狀態。** 在回覆或「檔案」按一下預覽，Relay 就會辨識專案類型並開啟靜態 HTML、建置 npm 前端或執行具單一 HTTP 入口的 Node.js 後端。需要 Docker 時，面板會協助設定。下方保留設計時評估的平台和驗收項目。實際操作方式與限制請見[使用者說明](../user-guide.zh-TW.md#預覽應用程式)、[架構](../architecture.zh-TW.md#應用程式預覽)和[開發者說明](../developer-guide.zh-TW.md#應用程式預覽執行環境)。

已在 Apple Silicon 的 macOS 主機上測試打包版 Electron，以及 OrbStack 的 Linux Docker 引擎。瀏覽器測試使用測試用的 HTTPS 設定。Linux CI 會測試實際的前端建置、SQLite 後端和聊天面板。Windows Docker Desktop 與實機手機使用萬用字元 TLS 的驗收仍待各自測試。原先規劃的 generative UI 則見[互動式回覆提案](preview-and-generative-ui.zh-TW.md)。

## 第一版能試用什麼

| 使用者打開的專案 | 按下「預覽」後 | 驗收範例 |
| --- | --- | --- |
| 靜態網站，或已建置的前端 | Relay 從指定的公開輸出資料夾取一份快照，直接提供靜態檔案。這條路徑不需要 Docker。 | 從某位 agent 的回覆打開 `site/index.html`，頁面的圖片、CSS 和 JavaScript module 都能載入。 |
| 需要建置的前端 | 在拋棄式容器中安裝相依套件、執行 build，再把指定的公開產物移交給靜態預覽。 | 從只有原始碼與 lockfile 的 React/Vite 專案打開頁面，切換畫面並做一次互動。 |
| 有後端 API 的 app | 在預覽專屬容器啟動 app。瀏覽器透過同一個預覽網址看前端、呼叫它自己的 API。 | 在 Node.js + SQLite 的待辦 app 新增一筆，重新整理後仍看得到，停止預覽後資料回收。 |

建議第一個 runtime 支援 Node.js 和 npm lockfile，一次對瀏覽器提供一個 HTTP 入口。前後端可以共用一個 process，也可以在容器裡透過 loopback 互連。這能涵蓋實際的全端流程，並讓第一版的安裝與驗收有明確範圍。其他語言、需要外部 API 金鑰或另外啟動資料庫服務的專案，面板應指出缺少哪項能力。

## 程式在哪裡寫、在哪裡跑

agent 在既有工作的 worktree 編輯，繼續使用該回合的 CLI 帳號與權限。使用者按下「預覽」時，面板顯示來源成員、資料夾及要執行的專案 script。Relay 只複製這次需要的檔案，包含尚未 commit 的修改；來源根目錄由對話與成員決定。複製時套用 Files 已有的根目錄與受限檔案檢查，另排除 `.git`、`.env*`、套件管理器憑證、已安裝的相依套件與連結，並限制檔案數和總大小。靜態模式只發布選定的公開資產，全端模式的原始碼和資料庫屬於後端。[現有檔案邊界](../../src/server/files.ts)

建置與執行都會跑到專案提供的程式。Relay 的預覽管理程序控制 Docker，指定固定 digest 的映像、非 root 使用者、唯讀系統檔案與有大小限制的可寫暫存空間，移除 Linux capabilities，禁止提升權限，限制 CPU、記憶體、程序數與執行時間。容器只取得快照、必要的工具和明列的環境變數。Docker socket、家目錄、主機 worktree、Relay 資料和 CLI 憑證都留在容器外。Linux 優先用 rootless Docker。動態預覽缺少可用 runtime 時，面板說明原因並保留靜態入口。[Docker Engine 安全性](https://docs.docker.com/engine/security/) · [Rootless Docker](https://docs.docker.com/engine/security/rootless/) · [資源限制](https://docs.docker.com/engine/containers/resource_constraints/)

把下載套件與執行套件腳本分開。由受控的下載程序依 lockfile 從允許的 registry 取得並核對套件，拒絕任意 URL、Git 或外部檔案來源。專案的安裝腳本、build 與後端都在離線容器執行。建議先驗證的連線方式是讓後端只聽容器內的一個固定 port，由 Relay 透過 Docker exec 的標準輸入輸出轉送到它；容器只需自己的 loopback。轉送目標綁定這次的容器 ID，不接受頁面或啟動紀錄指定的主機或 port。[Docker 的 none 網路](https://docs.docker.com/engine/network/drivers/none/)

## 瀏覽器和 Relay 的邊界

容器包住的是建置工具和後端。頁面裡的 JavaScript 仍在使用者的瀏覽器執行。每次預覽使用專屬 hostname 和 origin，與 Relay 的登入 cookie 分開；只換 port，瀏覽器仍可能把同一主機的 cookie 送到預覽的 `/api` 路徑。預覽代理只轉送 app 需要的標頭，Relay 的 cookie、登入用的 header、預覽通行憑證都在代理終止。控制 API 精確核對 Relay 介面的 origin。本機先驗證含子網域的 loopback 名稱；手機則要用裝置能解析、帶有效 TLS 的預覽主機名稱，單獨轉送 Relay 的 port 不足以完成配對。[現有 API 與登入行為](../../src/server/app.ts) · [RFC 6265 §8.5](https://www.rfc-editor.org/rfc/rfc6265#section-8.5)

只有已登入的使用者能建立或停止預覽。代理核對綁定這次預覽且可撤銷的憑證，適用於文件、資產和 API 請求。面板使用 sandbox iframe，CSP 限制資源、表單及資料連線的目的地，且只允許 Relay 嵌入。這些限制與後端的離線網路分別驗證。面板只接受當前 iframe 和 origin 傳回的限量錯誤文字；使用者可編輯後再交給 agent。切換專案會取得新的 origin，隔開前一次的瀏覽器儲存空間。

## 三個桌面平台的可行性

靜態快照在三個系統上都可由 Relay 直接提供。需要建置或後端的專案則以能在 Linux 執行的 Web app 為前提。建議發布 `linux/amd64` 與 `linux/arm64` 兩個映像版本，在草案中指定的 digest 固定整個映像索引。含原生模組的相依套件要在對應架構的容器內安裝及驗收。[Docker 多平台映像](https://docs.docker.com/build/building/multi-platform/)

| Relay 主機 | 建議驗收環境 | 平台特有條件 |
| --- | --- | --- |
| Windows | x64 優先，Docker Desktop 搭配 WSL 2，以 Linux 容器模式啟動 | 需要啟用硬體虛擬化。Windows on Arm 的 Docker Desktop 目前標為 Early Access，單列實驗性驗收。測試從含空白與中文的 Windows 路徑建立快照，並確認 junction 無法把範圍帶出工作目錄。[Windows 安裝條件](https://docs.docker.com/desktop/setup/install/windows-install/) |
| macOS | Apple Silicon 上的 Relay 桌面版與 Docker Desktop | 驗收以 Docker Desktop 支援的 macOS 版本為準。Docker 也提供 Intel 版，但 Relay 現有的 Mac 桌面安裝包只發 Apple Silicon。[Mac 安裝條件](https://docs.docker.com/desktop/setup/install/mac-install/) · [Relay 桌面版發行範圍](../../desktop/README.md) |
| Linux | x64 和 arm64 的 Docker Engine，優先使用 rootless 模式 | rootless 的 CPU、記憶體與程序數限制需要 cgroup v2、systemd 和相應 controller 的委派。啟用動態預覽前，先驗證這個帳號的限制確實生效；缺少時仍可使用靜態預覽。[Rootless Docker 的資源限制](https://docs.docker.com/engine/security/rootless/tips/#limiting-resources) |

以上是可行性評估。每個列為支援的組合都要用封裝後的桌面版走完「打開靜態頁 → 建置 Vite → 呼叫 API 寫入 SQLite → 停止並回收」，並從 Electron 和支援的外部瀏覽器驗證預覽 hostname、登入隔離與錯誤回報。

## 交付順序與驗收

1. **先驗證兩條邊界。** 在 macOS、Linux 與使用 Linux 容器的 Windows 上驗證容器的離線連線轉送、資源限制與停止行為。在瀏覽器驗證 Relay 的登入憑證、其他預覽的資料和工作目錄外的檔案都無法被預覽讀取。手機另驗證名稱解析、TLS 及 iframe 內的授權。
2. **接上靜態頁與前端建置。** 從回覆與檔案面板選到正確成員的快照。用表格裡的前兩個範例驗收，另測 Docker 未啟動、缺少 lockfile、建置失敗及同名檔案來自不同 worktree。agent 有新修改時，使用者按「重建預覽」取新快照。
3. **接上後端並驗收整個第一版。** 跑完表格裡的 SQLite 流程。容器無法讀取主機憑證、連到主機上的 Relay 或改動原始碼。測試啟動逾時、重複按啟動、停止、閒置、刪除對話及 Relay 異常退出後重啟；回收該次容器、暫存資料，並撤銷舊網址。runtime 檢查或啟動失敗時顯示原因與有長度限制的紀錄。

## 為什麼選 Docker

對本機單人使用，Docker 提供可重現的建置環境，也將後端可讀寫的檔案縮到一份快照。代價是需要容器引擎，首次使用要取得映像。直接沿用 Relay 的 OS sandbox 可以省掉 Docker 安裝，但目前各平台支援不同，長時間服務也要另外驗證。若將來要讓互不信任的使用者上傳並執行專案，建議另評估每個預覽一台 microVM，以獨立核心隔離租戶。把 agent CLI 本身也放進容器會牽涉登入、工具與審批，屬於另一項產品決策。[Relay 的平台沙箱](../sandboxing.zh-TW.md) · [Docker Engine 安全性](https://docs.docker.com/engine/security/) · [Firecracker microVM](https://firecracker-microvm.github.io/)
