[English](app-publish.md) | **繁體中文**

# 發布預覽過的應用程式

**狀態。** 第 1 與第 2 步已完成：設定裡的 Render 與 Neon、預覽面板的 **發布…**、下面五種應用程式、把 compose 檔的 PostgreSQL 換成 Neon 並執行它的初始化腳本、更新與取消發布；[使用說明](../user-guide.zh-TW.md#發布應用程式)、[架構](../architecture.zh-TW.md#發布應用程式)與[開發者說明](../developer-guide.zh-TW.md#應用程式發布)描述了它們。尚未用真的帳號對 Render 與 Neon 的 API 試過（見下方「試過什麼」）。第 3 步（其他雲端業者）尚未開始。它建立在[每種應用程式都用同一種方式預覽](unified-app-preview.zh-TW.md)之上。

## 現在有什麼、缺什麼

**預覽應用程式** 會從資料夾過濾後的快照，在沒有網路、用完即丟的容器裡執行 agent 做的東西。使用者在那裡試過之後，下一個問題就是怎麼放上網路。目前得離開 Relay：建立儲存庫、選雲端業者、寫它的設定、建立資料庫、複製連線字串，還要自己做同樣的排除（不放 `.env`、不放憑證）。

## 設計

**使用者試過的預覽，用同一份快照發布到使用者自己的帳號。** Relay 自己從不託管任何東西，在任何雲端業者都沒有自己的帳號，也從不因 agent 的要求而發布。

### 設定

設定裡新增 **發布到雲端** 卡片，放在分享的對話旁邊，因為兩者都是用使用者自己的帳號把東西放上網路：

- **Render**：一把 API 金鑰（Render 的 Account Settings），和其他金鑰一樣存在憑證儲存區。Relay 用 `GET /owners` 檢查它，並記下它能用的工作區；有好幾個時由使用者選。以及區域（奧勒岡、俄亥俄、維吉尼亞、法蘭克福、新加坡）。
- **Neon**：一把 API 金鑰，同樣保存，以及組織（`GET /users/me/organizations`），有好幾個時由使用者選。資料庫的區域跟著 Render 的（奧勒岡 → `aws-us-west-2`、法蘭克福 → `aws-eu-central-1`…），讓應用程式和資料庫靠近。
- **GitHub**：分享已經在用的 `gh` 登入，缺少時可以在卡片裡用同一種方式登入。
- **已發布的應用程式**：每個都有網址、來源、上次發布與狀態，連到 Render 的 dashboard 與它的儲存庫，以及 **取消發布**。

### 面板

預覽可以用之後，預覽面板才出現 **發布**：載入成功的靜態頁面或建置、有回應的後端、頁面已開啟的容器。它會開啟一個對話框，在動手之前說明：

- Relay 會建立什麼：一個私人 GitHub 儲存庫、一個 Render 免費靜態網站或 web service，應用程式需要時再加一個 Neon 資料庫；
- 它的網址，任何拿到網址的人都能開啟；
- 應用程式會拿到的環境變數：compose 檔設定的與資料庫的，使用者可以修改和新增；
- 免費方案的限制：免費 web service 15 分鐘沒有請求就會休眠，喚醒約需一分鐘，重新啟動時它的檔案會消失。

使用者確認它會公開，再按 **發布**。對話框顯示每個步驟（儲存庫、推送、資料庫、服務、建置、上線）與 Render 的狀態，直到應用程式上線或建置失敗，並連到 Render 上的記錄。再發布同一個資料夾會更新同一個服務：一個新的 commit，再部署那個 commit。

**發布的就是預覽過的。** 預覽會記下快照的摘要。發布時重新取一次快照，不同就拒絕：預覽之後檔案改變了，使用者要先重建預覽並試過。快照的排除和預覽相同：沒有 `.git`、`.env*`、憑證、已安裝的相依套件、連結，以及 Relay 保留的檔案。

### 從快照到 Render

Render 從 Git 儲存庫建置服務，或執行 registry 裡的映像。Relay 透過使用者自己的 `gh` 登入，把快照推送到使用者的 **私人 GitHub 儲存庫**，方式和分享時推送檔案相同：在 Relay 資料資料夾的暫存資料夾裡，用 git 的 `fast-import` 做出一個 commit（從不用工作目錄，沒有 hook、沒有簽章，只走 HTTPS），帶著快照記下的執行權限。之後由 Render 在它自己的（Linux、amd64）機器上建置。Render 透過它的 GitHub App 讀取儲存庫，所以使用者的 Render 帳號要連上 GitHub，並能存取新的儲存庫（所有儲存庫，或加入這一個）；不能時，Relay 會說明怎麼做並附上連結。

| 預覽 | 在 Render 上 |
| --- | --- |
| 靜態 HTML | 靜態網站：資料夾原樣。 |
| npm 建置（`dist/`） | 靜態網站：`npm ci` 與 `npm run build`，發布 `dist`（workspace 成員則加上 `--workspace`）。 |
| Node.js 後端 | web service，runtime `node`：`npm ci --include=dev`，然後 `npm start`，和預覽的執行方式相同。 |
| `Dockerfile` | web service，runtime `docker`，用那個 `Dockerfile`。 |
| compose 檔 | web service，runtime `docker`，用主服務的 `build`；它的 PostgreSQL 服務變成 Neon 資料庫。 |

只有 Render 免費方案能用一個服務執行的 compose 檔才會發布：一個有 `build` 的應用程式服務（context 在快照裡、Dockerfile 是檔案、沒有 build 參數、target 或內嵌 Dockerfile、沒有掛載專案檔案），它的 `command` 當作 Render 的啟動指令，旁邊可以有 PostgreSQL 服務。其他情況（第二個應用程式服務、Redis、MySQL）會在建立任何東西之前拒絕並說明原因。

### 資料庫

Render 免費的 PostgreSQL 建立 30 天後過期，再 14 天後連同資料一起刪除；Neon 的免費方案保留資料庫沒有時間限制（每個專案 1 GB、100 個專案），閒置時縮到零。所以資料庫用 Neon：

- **compose 檔的 PostgreSQL 服務** 變成一個自己的 Neon 專案，用服務的 `POSTGRES_DB` 與 `POSTGRES_USER` 當資料庫與角色（`postgres` 則用 Neon 自己的名稱），用映像的主版本（14 到 18）當 PostgreSQL 版本。在主服務的環境變數裡，主機是那個服務的 `postgres://` URL 換成 Neon 的連線字串，當作主機的服務名稱換成 Neon 的主機，它的密碼換成 Neon 的。都沒有時，應用程式會拿到 `DATABASE_URL`。
- **它的初始化腳本**（compose 檔掛載到 `/docker-entrypoint-initdb.d/` 的 `.sql` 檔，依檔名順序，和 PostgreSQL 映像執行它們的方式相同）在新資料庫上執行一次，用以 digest 固定的 PostgreSQL 官方映像裡的 `psql`（從不用 compose 檔自己的映像，那可能是 agent 指定的），在它自己的容器裡（沒有 capability、唯讀、連線資訊走 stdin，從不出現在命令列）。那個容器有網路（要連到 Neon），所以每個腳本都在一行註解之後以單一字串交給 `psql -c`，psql 會送到伺服器而不解讀其中任何 psql 自己的指令（`\!`、`\copy`…）；有以反斜線開頭的行，或有結束 transaction、無法在 transaction 裡執行的陳述式的腳本，會在建立任何東西之前拒絕。每個腳本是一個 transaction，密碼放在 psql 的環境裡，下一次只執行還沒 commit 的腳本。其他類型的腳本（`.sh`、`.sql.gz`）會在對話框列出，但不執行。
- **沒有 compose 的後端或 `Dockerfile`** 也可以勾選加上 Neon 資料庫：應用程式拿到 `DATABASE_URL`。

### 環境變數

建立服務時送到 Render，從不寫進儲存庫：compose 檔的（經過資料庫的替換）、資料庫的，以及使用者在對話框新增的（例如 `API_KEY`，總共最多 100 個）。Relay 不保存任何一個值。更新時保留 Render 上原有的設定，使用者在那裡修改（對話框有連結）。

### 取消發布

**取消發布** 會刪除 Render 服務；使用者勾選時，也刪除 Neon 專案（Neon 會保留刪除的專案 7 天）。GitHub 儲存庫會保留並附上連結：刪除儲存庫需要 `gh` 預設沒有的權限範圍，而且它記錄了發布過的內容。

## 安全性

- Render 與 Neon 的金鑰留在憑證儲存區，從不送到 UI（只有遮蔽後的）、CLI 或 agent，只經 HTTPS 送往 `api.render.com` 與 `console.neon.tech`，不跟隨重新導向，回應只讀到上限為止。
- 只有使用者的點擊會開始發布：從啟動預覽的瀏覽器的面板，經過 `/api/` 的一般檢查。agent 的工具、prompt 或回覆都不能發布、取消發布或讀取設定。
- 對話框會說明應用程式會公開，而且和預覽不同，它有網路。
- 儲存庫是私人的。放進去的只有快照，排除方式和預覽相同。
- 應用程式的環境變數不會進到儲存庫或 Relay 的資料庫。
- 初始化腳本的容器執行固定版本的官方映像，psql 把每個腳本當成一般的 SQL 在伺服器上執行，不執行它自己的任何指令；和預覽不同，它有網路。
- 端對端測試的替身（`RELAY_RENDER_API_URL`、`RELAY_NEON_API_URL`、`RELAY_PUBLISH_GIT_DIR`）只在啟動時讀取，不是指向這台電腦就拒絕。

## 沒有採用的做法

- **把映像推到 registry**（Docker Hub、GitHub 的 registry）給 Render 執行：不需要儲存庫，但需要另一個帳號和讓 Render 拉映像的權杖；在 Apple Silicon 的 Mac 上要建置 amd64（模擬，慢，部分原生套件會失敗）；映像動輒數百 MB，佔用使用者的上傳頻寬；靜態網站也會變成會休眠的 web service。
- **公開的儲存庫**：Render 不需要 GitHub App 就能部署，但應用程式的原始碼人人可讀。從不預設這樣做。
- **Render 自己的 PostgreSQL**：免費方案 30 到 44 天後連同資料刪除。
- **Render 以外的雲端業者**（Cloud Run、Cloudflare Pages、Koyeb、Zeabur）：每家各自一個 adapter；第 3 步。
- **讓 agent 發布**：agent 可能把使用者的檔案放上網路。發布和寄出訊息一樣，維持由使用者點擊。

## 未決問題

1. Render 的 API 建立服務時是否接受 `plan: free`（它的 schema 有列出；只有實際帳號能確認），以及它的 GitHub App 讀不到儲存庫時回應什麼。
2. 第一次發布之後的環境變數：在對話框裡編輯（Render 的 `PUT /env-vars`），或像現在一樣交給 Render 的 dashboard。
3. 自訂網域。
4. 其他雲端業者（第 3 步），放在同一張卡片後面：靜態網站用 Cloudflare Pages、容器用 Cloud Run。

## 交付

1. **設定與靜態網站。** 卡片、金鑰、登入、儲存庫與推送、Render 的靜態網站、清單與取消發布。
2. **服務與資料庫。** web service（`node`、`docker`）、compose、Neon 與它的初始化腳本、環境變數、更新。
3. **其他雲端業者。**

## 試過什麼

2026-11-22，離線：照 Render 與 Neon 的 API 參考文件，透過替身測試（`test/publish*.test.ts` 與端對端測試 `e2e/specs/app-publish.spec.ts`）；用真的 git 推送到本機儲存庫；初始化腳本則用 `postgres:16` 的 `psql` 對 Docker 裡的本機 PostgreSQL 執行。尚未：真的 Render 或 Neon 帳號。
