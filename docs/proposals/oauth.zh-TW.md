[English](oauth.md) | **繁體中文**

# 用 OAuth 登入的帳號

> **狀態：核心與第一批用途已完成：透過 Microsoft Graph 使用 Microsoft 365 與 Outlook.com 的行事曆、用帳號的權杖透過 CalDAV 使用 Google 日曆，以及工具庫中遠端 MCP 伺服器自己的登入（Microsoft 的登入與 Graph、Google 的登入與 CalDAV，以及 MCP 的授權，都只對替身試過，沒有對真正的服務試過）。透過 OAuth 收發郵件、把 MCP 伺服器的工具透過 gateway 轉接，以及 Harness Relay 自己註冊的 app，仍是提案。** 見[提案](README.zh-TW.md)。來自 [#90](https://github.com/Agentic-System-Lab/harness-relay/issues/90)。

## 為什麼

郵件與行事曆工具用應用程式專用密碼登入，所以不需要註冊 OAuth 用戶端，也沒有東西要送審。但這樣會漏掉：

- **Google 日曆。** 它的 CalDAV 端點只接受 OAuth 2.0。
- **Microsoft 365 與 Outlook.com 的行事曆。** 它們完全沒有 CalDAV，只有 Microsoft Graph。
- **Microsoft 365 的郵件。** Exchange Online 的 IMAP 已經不接受基本驗證，SMTP AUTH 的基本驗證也正在停用。
- **用 OAuth 登入的遠端 MCP 伺服器**（MCP 的授權規格）。工具庫目前只能手動把它們的權杖填成標頭。

應用程式專用密碼會保留：OAuth 是並列的另一種方式，每個帳號各自選擇。連接器支援的服務各有某種 OAuth 途徑，但每一種都要先由該服務註冊或核准 app，而任意的 IMAP 或 CalDAV 伺服器根本沒有這條路（有一份 IETF 草案想用動態用戶端註冊加上 PKCE 補上它）。

## 一個介面

OAuth 本身是一個介面，各個 API 則留在使用它的工具群組裡。不同服務之間的差異大多是資料，所以服務是一份描述，而不是每家一個類別：

- **服務**（`src/server/oauth/providers.ts`）：登入與權杖代理都接受的一份描述（`OAuthProvider`），帳號的服務再加上自己的部分（`AccountProvider`）：它的端點（授權、權杖，有的話還有撤銷與裝置代碼）、app 的用戶端 ID（以及 Google 的用戶端密碼）、它允許的流程（`loopback`、`device`）、每種用途要的權限範圍、存取權杖唯一會送去的主機、額外的登入參數（Google 的 `access_type=offline` 與 `prompt=consent`）、誰登入了（`whoami`）、它的行事曆與新登入會自動加入的那一個，以及 Microsoft 讓使用者移除 app 存取權的頁面。
- **帳號**（`store.ts`）：它的服務、它是誰（在服務那邊的 ID，永遠不變，以及地址與名稱）、它被用在哪裡、取得的權限範圍，以及它是已連線還是需要重新登入。更新權杖存進憑證儲存區（`oauth-<id>`），和郵件密碼一樣；存取權杖只放在記憶體。畫面只會看到「已連線為 …」，看不到任何權杖，CLI 也永遠拿不到。
- **權杖代理**（`broker.ts`）：對交給它的那些登入（`TokenGrants`：帳號，或工具庫的 MCP 伺服器，各一個權杖代理），`accessToken()` 在權杖到期前兩分鐘更新它（回合要用的 MCP 伺服器則是十分鐘），每個登入一次只更新一個；服務輪換更新權杖時（Microsoft 會）保留新的那個；遇到 `invalid_grant` 時把帳號標成需要重新登入，「設定」和行事曆工具的 `unavailable()` 都會顯示。`fetch()` 只把權杖送到該服務的主機（https，或為了替身才允許的本機純 http），從不帶著權杖跟隨重新導向，服務回 401 時更新一次再重送。
- **登入**（`signin.ts`）：見下一節。
- **連接器改為接受驗證來源。** `caldav.ts` 用密碼（Basic）或透過帳號的 fetch（Bearer）簽署請求；`graph.ts` 是新的 Graph 用戶端；`calendar.ts` 讓行事曆工具不管是哪一種都用同一個後端，agent 看不出差別。

加一個服務就是一份描述加一個測試；加一種用途就是一個向權杖代理要 fetch 的連接器。MCP 伺服器的服務也是一份描述，由它公布的內容組成（見下文）。

## 登入

登入由伺服器進行；頁面只負責開始它並顯示進度。

- **主要流程**是帶 PKCE（S256）的授權碼，並用 loopback 重新導向（RFC 8252）回到 web app 自己的頁面 `/oauth/callback`：開始登入的頁面在這台電腦上時，就用它所在的來源（`http://127.0.0.1:8787`、`http://localhost:5173`）。Microsoft 和 Google 都接受桌面 app 使用任何 loopback 連接埠。服務的登入頁面在新分頁開啟（桌面版則在系統瀏覽器開啟）。
- **在另一台電腦上的瀏覽器**（codespace、Tailscale）連不到這台電腦的 loopback：這時重新導向到 `http://localhost:<port>/oauth/callback`，頁面會顯示無法連線，使用者把它的網址貼進「設定」。只有開始這次登入的那個瀏覽器能這麼做。
- **在另一台裝置上**，只要服務允許這些權限範圍：Microsoft 的裝置代碼流程（在 Microsoft 的網址輸入代碼，伺服器持續詢問 Microsoft 直到完成）。Google 的裝置流程只接受少數幾個權限範圍，不含日曆的，所以 Google 只有 loopback 流程。

## 遠端 MCP 伺服器自己的登入

工具庫中用 OAuth 登入的 HTTP 伺服器（MCP 的授權規格，2025-06-18），可以在「設定 → 工具庫」它的那一列登入，不必把權杖手動填進標頭（`src/server/oauth/mcp.ts`）。它的服務是針對每台伺服器探索出來的，登入則和帳號一樣，經過同一套登入、回呼頁面與檢查。

- **探索。** 先不帶權杖送一個 `initialize` 給伺服器。它回 401 並附上 `WWW-Authenticate: Bearer resource_metadata="…"`（RFC 9728），否則它受保護資源的中繼資料就在 `/.well-known/oauth-protected-resource`，先帶伺服器的路徑，再不帶。屬於別的資源的中繼資料（不是它的來源，或路徑不在伺服器的路徑或其上層）會被拒絕。中繼資料列出授權伺服器；第一個的中繼資料在 `/.well-known/oauth-authorization-server`（RFC 8414，well-known 的部分插在發行者的路徑之前），否則在 OpenID 的 `/.well-known/openid-configuration`（先插在路徑之前，再接在路徑之後），而且必須寫著那個發行者。`code_challenge_methods_supported` 沒有 S256 的 PKCE：不登入。沒有 `registration_endpoint`：這個伺服器需要手動註冊的用戶端，目前還不支援，頁面會這麼說。不回 401、也沒有中繼資料的伺服器不需要登入，頁面也會這麼說。每個網址都必須是 https；純 http 只限連到這台電腦，而且只限伺服器本身就在這台電腦上時（替身）；不跟隨重新導向；每個請求最多 15 秒，最多讀 256 KB。
- **註冊**（RFC 7591）：一個名為 Harness Relay 的公用用戶端（`token_endpoint_auth_method: none`，授權類型 `authorization_code` 與 `refresh_token`，以及要的權限範圍），附上這次登入用的確切重新導向網址（頁面自己來源上的 `/oauth/callback`，和帳號一樣）。它跟著伺服器保存；登入需要它沒有的網址時，會帶著原有的網址重新註冊。授權伺服器若還是給了用戶端密碼，就存進憑證儲存區，並照它說的方式傳送（Basic，或放在表單裡）。
- **登入**要的權限範圍：401 的 challenge 寫的那些，否則是受保護資源中繼資料列出的（`scopes_supported`），否則不要任何權限範圍；授權請求與每個權杖請求（包括更新）都會指名資源（RFC 8707：中繼資料寫的 `resource`，照它寫的樣子，也就是伺服器的網址或它的上層；沒有的話，用伺服器標準化後的網址）。授權伺服器不給更新權杖也接受：這時登入只能用到存取權杖到期為止。
- **跟著伺服器保存**（`ToolLibrary`）：授權伺服器的發行者與端點、用戶端與它的重新導向網址、資源、權限範圍、權杖會送去的主機，以及它的狀態（何時登入，或需要重新登入與原因）。它的更新權杖與用戶端密碼是憑證儲存區裡的一筆，`mcp-oauth.<伺服器 ID>`（有一個點，伺服器的名稱不會有，所以永遠不會是另一台伺服器的 `mcp-<id>`）；存取權杖只放在記憶體。畫面只看到「已登入」（與時間）或「需要重新登入」，看不到任何權杖。
- **每一回合**，在 CLI 開始前，拿到這台伺服器的 agent 會在伺服器的 `Authorization` 標頭收到一個至少還能用十分鐘的存取權杖（不到十分鐘就先更新），取代手動填的同名標頭。它只送到伺服器登入時的主機，而且是 https（純 http 只限這台電腦）。它和工具庫的標頭一樣交給 CLI，所以 CLI 在這一回合拿著一個很快就到期的權杖。拿不到權杖的伺服器（更新被拒 `invalid_grant`，或現在無法更新）這一回合不會給：回覆裡會顯示給使用者的說明，agent 的說明會用英文寫明，「設定」則顯示這台伺服器需要重新登入。
- **移除伺服器、改它的網址（另一台伺服器：不只是一條斜線），或「登出」**，都會刪除它的權杖、結束進行中的登入，並在中繼資料有 `revocation_endpoint` 時，到授權伺服器撤銷它的更新權杖（沒有的話就撤銷存取權杖，RFC 7009）。改名，或改它的標頭或 CLI，都會保留它的登入。

## 回答待決問題

- **用誰的 OAuth 用戶端？** 兩者都要，以使用者自己的為先。「設定 → 工具庫」可以填用戶端 ID（加上 Microsoft 的租用戶，以及 Google 的用戶端密碼；桌面 app 的這個密碼其實不是秘密，但仍然需要）。`BUILT_IN_CLIENTS` 會放 Harness Relay 自己註冊一次、隨程式碼發布的 app，目前還沒有註冊任何一個。在 Microsoft Entra 上，那會是一個同時支援公司、學校與個人帳號的公用用戶端。Google 要求 app 為日曆的敏感權限範圍通過驗證（Gmail 的受限權限範圍還要安全評估）；使用者自己的 Google app 若還在「測試」階段，更新權杖 7 天就會失效。不管用哪一種，公司或學校的租用戶都可能需要系統管理員同意。
- **回呼的路由。** #90 列的兩個選項都不行，因為重新導向是從服務的網站發起的頂層瀏覽：工作階段的 cookie 是 `SameSite=Strict`，不會跟著來（選項 B，`BROWSER_LOADS`，行不通）；桌面版裡它還會在系統瀏覽器開啟，而系統瀏覽器從來沒有登入過（選項 A，帶金鑰回傳的頁面，也行不通）。實作的做法是：`/oauth/callback` 是 web app 的一個頁面（和所有頁面一樣在 `/api/` 之外），它把授權碼和 state 以 JSON 傳給 `POST /api/oauth/callback`。這個路由保留 Host、Origin 與 JSON 檢查，並以 state 作為證明，就像 webhook 以它的權杖作為證明：256 位元的亂數，只有服務和瀏覽器看得到，以雜湊在固定時間內比對，只屬於一次登入，只能用一次，10 分鐘內有效；沒有 PKCE 的驗證碼，授權碼毫無用處，而驗證碼從不離開伺服器。10 分鐘內有 20 次回呼都找不到對應的登入時，這個路由會暫時拒絕找不到登入的回呼（429）；帶著某次登入自己的 state 的回呼一定會通過。頁面只回傳一次（React 的 StrictMode 下也一樣），等這裡的某次登入回答後，才把授權碼和 state 從網址拿掉；這裡沒有那次登入時（是另一台電腦上的 Harness Relay 開始的），頁面會顯示網址，讓人貼到那裡。
- **一次登入給多個群組用？** 每次登入一個帳號，記下用在哪裡（`uses`，目前只有 `calendar`）。之後新增的用途會在自己的那次登入要它的權限範圍（漸進式同意），並更新同一個帳號（以它在服務那邊的 ID 找到）。郵件帳號與行事曆仍然分開（`ConnectorStore`）；透過帳號使用的行事曆會記下是哪個帳號（`CalendarAccountView.oauth`），為行事曆登入時會自動加入帳號自己的行事曆，其他行事曆則在「設定」裡列出、加入。
- **移除帳號。** 它的更新權杖和它的行事曆都會刪除。Google 的權杖會被撤銷；Microsoft 不能撤銷單一個權杖，所以「設定」會列出使用者移除 app 存取權的頁面（公司與學校帳號在 `myapps.microsoft.com`，個人帳號在 `account.live.com/consent/Manage`）。

## 設定與環境變數

- **「設定 → 工具庫 → 郵件與行事曆 → 登入的帳號」：** 每個服務要用的 app（以及 Microsoft 的 app 必須允許的重新導向網址）、「用 … 登入」、「在另一台裝置上登入」（Microsoft）、各帳號與它的狀態、它可以加入的行事曆，以及「移除」。
- **「設定 → 工具庫 → MCP 伺服器」：** 每台 HTTP 伺服器都有「登入」（會先查它是否要求登入），之後顯示它的狀態，以及「重新登入」與「登出」；進行中的登入和帳號一樣可以貼上網址。
- **`RELAY_MICROSOFT_LOGIN_URL` 與 `RELAY_MICROSOFT_GRAPH_URL`** 把 Microsoft 的登入與 Graph 指向全球雲以外的雲（例如國家雲 `https://login.microsoftonline.us` 與 `https://graph.microsoft.us`），或端對端測試中這台電腦上的替身：必須是 https，純 http 只限這台電腦。

## HTTP API

| 方法與路徑 | 用途 |
| --- | --- |
| `GET /api/oauth` | 各服務的 app（遮蔽後）與各帳號 |
| `PUT /api/oauth/clients/:provider` | 服務的 app：用戶端 ID、租用戶、密碼 |
| `POST /api/oauth/signins` | 開始登入（`provider`、頁面的 `origin`、`device`） |
| `GET /api/oauth/signins/:id` | 登入的進度，只給開始它的瀏覽器 |
| `POST /api/oauth/signins/:id/address` | 貼上服務頁面最後停在的網址 |
| `DELETE /api/oauth/signins/:id` | 取消 |
| `POST /api/oauth/callback` | 回呼頁面的授權碼與 state：不需要登入，以 state 作為證明 |
| `GET /api/oauth/accounts/:id/calendars` | 帳號的行事曆 |
| `POST /api/oauth/accounts/:id/calendars` | 把其中一個加入行事曆工具（只限它服務主機上的網址） |
| `DELETE /api/oauth/accounts/:id` | 移除它、它的權杖與它的行事曆 |
| `POST /api/tools/mcp/:name/signin` | 開始 HTTP MCP 伺服器自己的登入（頁面的 `origin`）：探索、需要時註冊，之後和上面一樣在 `/api/oauth/signins/:id` 追蹤、貼上網址與取消，在回呼完成；不要求登入的伺服器回 409（`mcp-no-sign-in`），無法登入的回 502 |
| `DELETE /api/tools/mcp/:name/signin` | 登出：刪除它的權杖，授權伺服器能撤銷時也撤銷 |

`GET /api/tools` 會說明每台 HTTP 伺服器的登入狀態（`McpServerView.oauth`）。

## 還沒有做的

依序如下，各自一個 pull request：

1. **透過 OAuth 收發郵件。** Microsoft 365 與 Gmail 透過同一套 IMAP 與 SMTP 用戶端加上 SASL XOAUTH2，或透過 Graph 與 Gmail API。Microsoft 的 IMAP 與 SMTP 權杖屬於另一個資源（`outlook.office.com`），不是 Graph 的，所以權杖代理要為每個資源各保留一個權杖。做好之後，OAuth 帳號的郵件也能啟動自動任務（[觸發](triggers.zh-TW.md)）。
2. **把已登入的 MCP 伺服器的工具透過 gateway 轉接**，讓它的權杖永遠不離開伺服器：目前每一回合是把一個很快就到期的權杖放在伺服器的標頭交給 CLI。另外，MCP 伺服器還缺：給沒有動態註冊的授權伺服器用的手動註冊用戶端（在「設定」填用戶端 ID）、2025-03-26 版規格那種沒有受保護資源中繼資料的伺服器（把它自己的來源當成授權伺服器），以及在另一台裝置上登入。
3. **Harness Relay 自己的 app**（`BUILT_IN_CLIENTS`），等有人負責這些註冊與 Google 的驗證之後。
4. **其他適合的用途**，例如 Google Drive 或 OneDrive 的檔案、待辦事項，各自有自己的工具群組與層級。

CLI 自己的登入（`login.ts`）不在範圍內；每個 CLI 保留自己的登入。

## 考慮過的其他做法

- **每個服務一個類別。** 不採用：差異都是資料，而描述更容易用替身測試。
- **在桌面版裡開一個登入視窗。** 不採用：RFC 8252 建議使用系統瀏覽器，那裡有使用者自己的登入和密碼管理工具，Harness Relay 也永遠看不到密碼；桌面版本來就會把不是它自己的頁面都送到那裡。
- **把存取權杖存進資料庫。** 不採用：它們一小時就到期，需要時再更新即可；只保留更新權杖，而且存在憑證儲存區。
- **把 MCP 伺服器的權杖當成帳號保存**（`OAuthStore`）。不採用：它們屬於伺服器（它的網址、它的用戶端），所以伺服器被移除或改掉時要跟著刪除；它們只共用登入與權杖代理。

## 測試

全部離線執行：

- `test/fake-oauth-server.ts`：Microsoft 登入與 Graph 的替身（授權、以驗證碼交換授權碼、輪換更新權杖、`invalid_grant` 與其他拒絕、給予的權限範圍、裝置代碼與它的放慢和錯誤、`/me`、`/me/calendars`、分頁的 `calendarView`、`POST …/events`），以及 Google 的替身（檢查用戶端密碼的權杖端點、撤銷、userinfo，以及只接受 Bearer 權杖的 CalDAV）；它可以扣住一個回答或丟掉一個請求，代表很慢或斷掉的網路。
- `test/oauth.test.ts`：登入（PKCE、重新導向網址、state 只能用一次且只屬於自己的登入、拒絕、到期、貼上網址、裝置代碼與它的重試、給予的權限範圍、app 改了或在任何一步取消時結束登入）、權杖代理（提早且只更新一次、輪換、需要重新登入的拒絕與不需要的錯誤、更新期間帳號被移除或重新登入、主機與 https 規則、不跟隨重新導向、被拒的權杖更新一次）、透過 Graph 與用權杖透過 Google CalDAV 的行事曆工具、Google 的撤銷，以及開啟登入時的 HTTP API（只有回呼不需要登入；它的 429；每個路由的上限與拒絕）。
- `test/oauth-web.test.ts`：頁面自己的邏輯（重新導向網址、回呼收到的內容與何時清掉網址、其中 MCP 伺服器的登入、桌面 app 中的彈出視窗訊息、MCP 伺服器那一列怎麼說明它的登入）。
- `test/fake-mcp-auth-server.ts`：一台回 401 並提供受保護資源中繼資料（在標頭說的地方，或帶或不帶路徑的 well-known 網址）的替身 MCP 伺服器，以及它的授權伺服器，發行者帶有路徑（RFC 8414 與 OpenID 的中繼資料、需要時沒有 S256 的 PKCE 或註冊、註冊、授權、檢查 PKCE、重新導向網址與 `resource` 的權杖端點、輪換更新權杖、`invalid_grant` 與其他回答、不給更新權杖、撤銷）。
- `test/mcp-oauth.test.ts`：探索（標頭、兩種 well-known 網址、OpenID 的備用網址、沒有 S256 或沒有註冊時拒絕、別的資源被拒絕、不要求登入的伺服器、連到別台電腦的純 http 被拒絕）、註冊（只在需要新的重新導向網址時重新註冊；照給的方式傳送用戶端密碼）、完整的登入、回合中伺服器標頭裡的權杖（取代手動填的）、更新（帶著資源、輪換、為回合提早更新）、`invalid_grant` 與更新失敗時不給伺服器並附上說明、沒有更新權杖、登出、移除與改網址時刪除並撤銷權杖（改名則保留）、主機規則、沒有憑證儲存區時重新啟動，以及開啟登入時的 HTTP API。
- `test/orchestrator-mcp-oauth.test.ts`：成員的執行拿到帶著權杖的伺服器；更新被拒之後，這台伺服器不會給，回覆與說明裡都會寫明。
- `e2e/specs/oauth.spec.ts`：在新分頁對替身的 Microsoft 頁面登入、回到 `/oauth/callback`、加入它的行事曆、更新被拒（需要重新登入、重新登入），然後移除帳號。
- `e2e/specs/mcp-oauth.spec.ts`：工具庫 MCP 伺服器的「登入」在新分頁對替身授權伺服器登入、回到 `/oauth/callback`、顯示已登入，假的 Claude Code 這一回合在伺服器的 `Authorization` 標頭拿到它的權杖；被撤銷後，下一則回覆的說明與「需要重新登入」；「重新登入」；「登出」。
