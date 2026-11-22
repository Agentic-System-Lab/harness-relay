[English](office-documents.md) | **繁體中文**

# Office 文件

> **狀態：尚未開始；一份調查，以及它建議的設計。** 見[提案](README.zh-TW.md)。

agent 能不能透過**常用 App** 處理使用者的 Word、Excel、PowerPoint 文件，以及 Apple 的 Pages、Numbers、Keynote：在 Microsoft 365（OneDrive、SharePoint）裡、在 Windows 與 macOS 的桌面 app 裡，以及 Linux 上有的東西。它們有哪些官方 MCP 伺服器，每條路又會對 Harness Relay 的防護要求什麼。

## 怎麼找到的

2026-11-22 對 Harness Relay 的程式碼，以及各廠商的文件、部落格與公開的程式碼所做的調查，再由沒參與調查的審查者檢查一次。沒有安裝、登入或執行任何東西。關於其他產品的每項發現都有標記：

- **docs**：出自廠商自己的文件、公告或公開的程式碼；
- **reported**：只見於媒體或第三方的文章；
- **unsure**：尚未確認；在據此實作之前要先查證。

關於 Harness Relay 本身的說法都註明檔案，不加標記。

## 現在有什麼

- **工作目錄裡的檔案。** agent 現在就能用自己的工具（python-docx、openpyxl、python-pptx、LibreOffice、Anthropic 的 docx、xlsx 與 pptx skill）讀寫其中的 `.docx`、`.xlsx`、`.pptx`，在每個系統上都行，不需要 Harness Relay 提供什麼。它們碰不到的，是使用者雲端裡的文件，或開在使用者 app 裡的文件。
- **用 OAuth 登入的 Microsoft 帳號**（`src/server/oauth/providers.ts` 的 `microsoftProvider()`），使用使用者自己的 Entra app：Graph 的行事曆（`calendar`）、Exchange Online 的 IMAP 與 SMTP（`mail`）、Teams 讀取（`teams`）。它的 Graph 權杖只送到 Graph 的主機（`hosts`），經過不跟隨任何重新導向的 `hostOnlyFetch()`（`src/server/oauth/broker.ts`）；郵件權杖只送到 Exchange Online 的 IMAP 與 SMTP 伺服器（`mailLogin()`）。
- **透過 Microsoft Graph PowerShell 的 Teams**（`src/server/connectors/teamsPowerShell.ts`）：`Connect-MgGraph -UseDeviceCode -TenantId organizations`，用的是 Microsoft 自己的用戶端，因此不需要使用者自己的 Entra app，但只限公司與學校帳號。
- **Google Drive 與文件**（`src/server/connectors/apps.ts`、`driveDocuments.ts`）：搜尋與讀取是 `read` 工具；建立文件或取代一段文字是 `send` 工具：待送出匣顯示提案時就固定下來的變更，只有使用者確認才會寫入，編輯還會比對提案當時的修訂版本（Google 的 `requiredRevisionId`）。它們的用途 `drive` 與 `documents` 處處都屬於 Google：`startSignIn()` 拒絕其他服務使用它們（`src/server/oauth/service.ts`），而 Drive 工具只依用途挑選帳號。
- **託管的連線**（`src/shared/apps.ts` 的 `HOSTED_APPS`、`src/server/connectors/hostedApps.ts`）：Slack，在 Claude 或 Codex 本身連結；Harness Relay 只檢查它們的狀態（`claude mcp get`；Codex 的 app server，以及透過該 app 讀取使用者自己的個人資料）。
- **目錄裡的官方遠端 MCP 伺服器**（`APP_SERVERS`）：Notion 與 Heptabase，透過工具庫的 MCP 登入（`src/server/oauth/mcp.ts`）登入，它以動態方式註冊用戶端（RFC 7591）；對 Slack 的伺服器，它只用 Slack 自己的用戶端更新先前存下的授權。不支援動態註冊的伺服器目前還不能用（[OAuth 提案](oauth.zh-TW.md#還沒有做的)第 1 項），而已登入伺服器的權杖每一回合都會放在標頭裡交給 CLI。
- **AppleScript 與 JXA** 只用在不會對其他 app 送 Apple Event 的地方：資料夾對話框的 `choose folder`（`src/server/folderPicker.ts`），以及安裝瀏覽器時的一次改名（`src/server/browser/install.ts`）。桌面 app 唯一的隱私 entitlement（`desktop/entitlements.mac.plist`）與唯一的用途說明（`desktop/electron-builder.yml`）都是麥克風的。

## 缺什麼

- Microsoft 帳號處理檔案的用途與工具：Outlook 與 Teams 用的帳號碰不到 OneDrive，也碰不到 SharePoint。
- 任何處理開在桌面 app 裡的文件的工具，以及 macOS 的桌面 app 對其他 app 送 Apple Event 所需的設定。
- 授權伺服器不支援動態註冊（Entra 就是）的目錄伺服器，以及把已登入伺服器的工具經過 gateway 轉交。

## Microsoft 365：OneDrive 與 SharePoint

Microsoft Graph 提供的（**docs**）：

| | 個人帳號（OneDrive） | 公司或學校帳號（OneDrive for Business、SharePoint） |
| --- | --- | --- |
| 搜尋、列出、下載、上傳、版本（driveItem） | 可以：`Files.Read`、`Files.ReadWrite`（與使用者共用的檔案要 `.All`） | 可以；SharePoint 網站另要 `Sites.Read.All` |
| 轉成 PDF（`?format=pdf`，來源檔最多 2 MB） | 可以 | 可以 |
| Excel 的活頁簿 API（工作表、範圍、表格、圖表；只限 `.xlsx`） | 不行：OneDrive 個人帳號「尚未支援」（2026 年 3 月[一則 Microsoft Q&A 的回答](https://learn.microsoft.com/en-us/answers/questions/5835926/microsoft-graph-api-workbook-paths-for-excel-store)也這麼說） | 可以 |
| Word 或 PowerPoint 的內容（段落、註解、投影片） | 沒有 API | 沒有 API |

- 下載（`…/content`）會以 302 轉到另一台主機上預先授權的位址（`*.files.1drv.com`，或 SharePoint 的），那裡不收權杖。`hostOnlyFetch()` 不會跟過去：伺服器要讀項目的 `@microsoft.graph.downloadUrl`，自己另外去抓，不帶權杖、只走 https，並經過瀏覽器工具用的那套位址檢查。
- 上傳是最多 250 MB 的 `PUT …/content`，或上傳工作階段（`createUploadSession`），後者的 `if-match` 有文件說明：項目的 eTag 已不是送出的那一個時回 412。`PUT …/content` 收不收 `If-Match` 是 **unsure**（它的頁面沒有列出）。
- 委派的 `Files.Read.All`、`Files.ReadWrite.All`、`Sites.Read.All` 與 `Sites.ReadWrite.All` 都不需要管理員同意（**docs**，Graph 的權限參考）；但租用戶自己的使用者同意政策仍可能拒絕。
- `Files.SelectedOperations.Selected`（只能存取選定的檔案）本身就要管理員同意，而且每個檔案都要由持有 `Sites.FullControl.All`、或持有 Selected 權限範圍加上完整控制或擁有者角色的 app，以 `POST …/permissions` 授權（**docs**）：對一個一個挑檔案的使用者沒有用。

來源：[driveItem 內容](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content)、[格式轉換](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content-format)、[上傳](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content)、[上傳工作階段](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession)、[Excel](https://learn.microsoft.com/en-us/graph/api/resources/excel)、[權限參考](https://learn.microsoft.com/en-us/graph/permissions-reference)、[選定權限](https://learn.microsoft.com/en-us/graph/permissions-selected-overview)。

## 官方 MCP 伺服器

| 伺服器 | 做什麼 | 需要什麼 | 狀態 |
| --- | --- | --- | --- |
| Microsoft 的 Work IQ MCP（`https://workiq.svc.cloud.microsoft/mcp`） | Graph 在 `/me/`、`/users/`、`/sites/` 之下的路徑（`fetch`、`create_entity`、`update_entity`…）；`fetch_blob` 以 Base64（預設上限 4 MB）或 PDF 傳回 Office 檔；寫入預設被租用戶的政策拒絕，直到管理員允許 | 需要管理員同意的委派權限範圍（其中有 `WorkIQAgent.Ask`）；由全域管理員建立它的服務主體；在 Azure 訂閱上開 Copilot Credits 計費；公司帳號（個人帳號：**unsure**，它的文件只談租用戶）。Entra 沒有動態用戶端註冊，所以工具庫要能手動輸入用戶端 ID | 宣布自 2026-06-16 起正式推出（**docs**，Microsoft 2026-06-02 的授權消息），也能透過 MCP 使用（Ignite 2026）；建立與編輯 Word、Excel、PowerPoint 內容「即將推出」（Microsoft 的 Ignite 部落格，2026-11-17） |
| Agent 365 的 Word 伺服器 | 讀取 Word 文件的文字與註解、建立文件、加註解；從不編輯內文 | 一個租用戶；Microsoft 稱這些伺服器為舊版，不建議新專案使用 | 預覽（**docs**） |
| 給桌面 Office 的 | 沒有：Windows 上的 MCP（裝置上的 agent 登錄）只有檔案總管和設定的 connector，沒有 Office 的 | — | — |
| Apple 的 Keynote、Pages 與 Numbers | 外部 agent 讀取開著的文件、編輯它們，並在 app 裡執行動作 | macOS 27 與 Apple Creator Studio 訂閱；在 app 的設定裡開啟，它會複製一個要交給 agent 的 URL；第一次連線要用 Touch ID 或密碼確認。它的傳輸方式與工具沒有公開（**unsure**） | 2026-10-27 與其他 beta 中的新 AI 功能一起發表（**docs**）；MCP 本身是否為 beta：**unsure** |
| LibreOffice | 沒有：「LibreOffice 26.8 沒有 AI」，是刻意的選擇（**reported**）；只有社群做的伺服器 | — | — |
| ONLYOFFICE 的 DocSpace MCP | DocSpace（它的雲端，或自架）裡的房間與檔案，不是桌面編輯器 | 一個 DocSpace | 官方（**docs**） |
| Microsoft 的 MarkItDown MCP | 一個工具：把檔案或 URL 轉成 Markdown，唯讀 | 它會自己抓 `http(s):` URI，繞過 Harness Relay 的位址檢查，也會讀 `file:` URI，繞過受保護的路徑 | 官方（**docs**） |

來源：[Work IQ 的工具](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/tool-reference)、[它的權限](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/permissions)、[開啟它](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/enable-work-iq)、[它的正式推出](https://microsoft.com/en-us/licensing/news/work-iq-general-availability)、[Ignite 2026](https://techcommunity.microsoft.com/blog/microsoft_365blog/whats-new-in-work-iq-at-ignite-2026-agents-that-get-work-done/4572219)、[Agent 365 的伺服器](https://learn.microsoft.com/microsoft-agent-365/tooling-servers-overview)、[Word 伺服器](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-word-tools)、[Windows 上的 MCP](https://learn.microsoft.com/en-us/windows/ai/mcp/overview)、[Apple Creator Studio](https://www.apple.com/newsroom/2026/10/apple-creator-studio-adds-powerful-new-ai-features-and-even-more-creative-tools/)、[Keynote 的外部 agent](https://support.apple.com/guide/keynote/connect-external-agents-to-keynote-tan59af18df1/16.0/mac/1.0)、[LibreOffice 26.8](https://itsfoss.com/news/libreoffice-26-8-release/)、[ONLYOFFICE](https://onlyoffice.com/mcp-server)、[MarkItDown](https://github.com/microsoft/markitdown)。

各 agent 廠商自己的，每個都會像 Slack 一樣是託管的連線：

- **Claude 的 Microsoft 365 connector**（**docs**）：在 SharePoint、OneDrive、Outlook 與 Teams 裡搜尋與讀取，開啟寫入動作後，還能在 OneDrive 與 SharePoint 建立和更新檔案。公司帳號要全域管理員同意 Anthropic 的 app；個人帳號在個人方案上可用 OneDrive 與 Outlook。Claude Code 只有在以 claude.ai 訂閱登入時才會載入 claude.ai 的 connector，而 Microsoft 365 要在 claude.ai 上連結，不能從 Claude Code 連。[connector](https://claude.com/docs/connectors/microsoft/365)、[Claude Code 的 MCP](https://code.claude.com/docs/en/mcp.md)。
- **ChatGPT 的 SharePoint app**（**docs**）：搜尋，以及在工作區管理員開啟時上傳和更新檔案（「可能」支援），限公司帳號，組織要求時需要 Entra 的管理員同意。Codex CLI 能不能用它：**unsure**。[說明頁](https://help.openai.com/en/articles/12143177-sharepoint-connectors-in-chatgpt)。
- **Work IQ 的 plugin**：有一個給 GitHub Copilot CLI（**docs**），它的儲存庫裡也有 Codex 與 Claude 的 manifest，屬於公開預覽；都需要像上面那樣設定好租用戶。
- **Claude for Word、Excel 與 PowerPoint** 是使用者自己執行的 Office 增益集：只處理開著的檔案，不提供其他程式可呼叫的東西（**docs**）。

## 桌面 app

| 系統 | App | 做法 | 深度 | 障礙 |
| --- | --- | --- | --- | --- |
| Windows | Word、Excel、PowerPoint | 從 PowerShell 7 用 COM（`New-Object -ComObject Word.Application`） | 完整的物件模型：開啟、讀、寫、儲存、匯出 | Microsoft 不支援從無人值守的用戶端自動化 Office：對話框會讓 app 卡住、除非 `AutomationSecurity` 另有設定否則會執行檔案的巨集、只有單一執行緒、要安裝 Office 且有授權（**docs**） |
| Windows | 任何 app | 裝置上的 agent 登錄（`odr.exe mcp`）、App Actions | 看 app 註冊了什麼 | Office 兩者都沒有註冊（**unsure**：沒有找到）；預覽中；正式版會要求主程式有套件身分（MSIX）（**docs**） |
| macOS | Word、Excel、PowerPoint | 透過 `osascript` 用 AppleScript 或 JXA | 不錯，依據的是很舊的字典；Anthropic 自己的「Word (By Anthropic)」與「PowerPoint (By Anthropic)」connector 走的就是這條路（2026-10，**docs**） | 每個 app 各要一次「自動化」同意（TCC）；Office 的沙箱存取其容器以外的檔案時會詢問；app 會跳到前景 |
| macOS | Pages、Numbers、Keynote | AppleScript 或 JXA；或在 macOS 27 上用它們的 MCP | 文字、儲存格、投影片、匯出成 PDF 與 Office 格式 | 同樣的同意；MCP 需要訂閱 |
| Linux | LibreOffice | `soffice --headless --convert-to`、UNO | 完整，版面是 LibreOffice 的 | 要另外安裝 |
| Windows、macOS | Word、Excel、PowerPoint | Office 增益集（Office.js） | 最深，針對開著的文件 | 只能處理開著的文件；要側載，或由管理員部署；增益集要透過 HTTPS 提供 |

在 macOS 上，Harness Relay 的桌面 app 以 hardened runtime 執行：對其他 app 送 Apple Event 需要 `com.apple.security.automation.apple-events` entitlement 和 `NSAppleEventsUsageDescription`（兩種語言，像 `desktop/macos/` 裡麥克風的說明那樣）。同意是針對負責該程序的 app 詢問（**reported**），所以在 `npm start` 之下是 Terminal。桌面 app 是 ad hoc 簽署的（`desktop/electron-builder.yml` 的 `identity: '-'`）：每次更新後 macOS 會不會再問一次是 **unsure**。

來源：[無人值守自動化](https://learn.microsoft.com/en-us/office/client-developer/integration/considerations-unattended-automation-office-microsoft-365-for-unattended-rpa)、[App Actions](https://learn.microsoft.com/en-us/windows/ai/app-actions/)、[Windows 上的 MCP 主程式](https://learn.microsoft.com/en-us/windows/ai/mcp/quickstart-mcp-host)、[Word (By Anthropic)](https://claude.com/connectors/word-by-anthropic)、[Office for Mac 的檔案存取](https://learn.microsoft.com/en-us/office/vba/office-mac/grantaccesstomultiplefiles)、[Apple Events entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.automation.apple-events)、[Office 增益集](https://learn.microsoft.com/en-us/office/dev/add-ins/overview/office-add-ins)。

## 設計

依這個順序，每一項一個 pull request。

1. **透過 Graph 的 OneDrive 與 SharePoint**，給用 OAuth 登入的 Microsoft 帳號，有自己的用途與工具群組，因為 `drive` 與 `documents` 屬於 Google：例如 `files`（搜尋與讀取，`Files.Read.All`）與 `files-write`（寫入，`Files.ReadWrite.All`），都在 Graph 的主機上，下載則如上所述另外抓。它的工具：
   - `onedrive_search`（`read`）：依名稱，在使用者的雲端硬碟以及與他共用的檔案裡；若之後的步驟需要，公司帳號的 SharePoint 網站另用 `Sites.Read.All`。
   - `onedrive_read`（`read`）：檔案的文字，由伺服器從下載的檔案做出（Word 的段落、PowerPoint 的投影片與備忘稿、Excel 的工作表逐列；在只負責寫入的 `zip.ts` 旁加一個 ZIP 讀取器，限制項目數、大小與壓縮比，讀 XML 時不接受 DTD 與實體），大小限制與 `readTool()` 相同；公司帳號的 Excel 範圍則透過活頁簿 API。
   - `onedrive_propose_upload`（`send`）：agent 在工作目錄做好的檔案，作為某個資料夾裡的新檔案，或某個檔案的新版本。提案時就複製它的位元組並算出雜湊（連結或受保護的路徑一律拒絕，`src/server/protect.ts`），上傳的正是這些位元組。待送出匣的卡片顯示帳號、位置、名稱、大小，Word 或 PowerPoint 檔還會顯示它的文字與目前版本的對照。按**上傳**會開啟一個帶著提案當時 eTag 的 `if-match` 的上傳工作階段，所以期間被改過的檔案會被拒絕，並請 agent 重新提案，和 Google 文件的編輯一樣；位元組接著送到工作階段的 `uploadUrl`，那是另一台主機上預先授權的位址，送法和抓下載一樣：不帶權杖、只走 https，並經過位址檢查。
   - `excel_update_range`（`send`，公司帳號）：卡片上顯示儲存格改前與改後，確認時寫入，並比對讀取時的值。
   agent 用自己的工具編輯文件：Harness Relay 自己從不編輯 OOXML。個人與公司帳號都能處理檔案；只有公司帳號有 Excel 的 API。
2. **把 Claude 的 Microsoft 365 connector 當成託管的連線**，像 Slack 那樣：它在常用 App 的那一列檢查 Claude Code 對它的狀態，並連到 claude.ai 去連結。CLI 會自己呼叫它，依照 CLI 自己的核准（完全存取下什麼都不問），也不經過待送出匣；那一列會說明這點，而成員有第 1 步的工具時，它的簡報會說寫入要透過那些工具提案，絕不透過其他 connector（就像它對 Google 文件與 Teams 的說法，`src/server/prompt.ts`）。Codex 的 SharePoint app 要等檢查確認 Codex CLI 能呼叫它之後才加入。
3. **在 macOS 上，透過 `osascript` 處理 Office for Mac、Pages、Numbers 與 Keynote**，由伺服器執行，和資料夾對話框一樣：固定的 JXA 文字，文件與值當作它 run handler 的參數，有時間限制，經過 `process.ts`。列出開著的文件與讀取其中一份是 `read`；把文件匯出到工作目錄是 `act`；編輯是 `send`，經過待送出匣。桌面 app 加上 entitlement 與用途說明。Apple 在 iWork 裡自己的 MCP，等它的傳輸方式與工具公開、macOS 27 也普及之後，再當成工具庫的伺服器加入。
4. **把 Work IQ 加進目錄**，等 [OAuth 提案](oauth.zh-TW.md#還沒有做的)的第 1 項完成之後：它的工具經過 gateway 轉交，所以權杖留在伺服器裡，每個工具由 Harness Relay 給一個層級（讀取是 `read`；`create_entity`、`update_entity`、`delete_entity` 與 `do_action` 是 `send`，經過待送出匣），並能手動輸入用戶端 ID；給管理員已同意並設定好計費的租用戶。
5. **在 Windows 上用 COM，先只做唯讀**：列出開著的文件、讀取其中一份、匯出成 PDF，經過像 Teams 那樣的 PowerShell 執行器，關閉巨集（`msoAutomationSecurityForceDisable`）、關閉警示、有時間限制，卡住時結束該程序。寫入要等在 Windows 上實際確認過對話框與登入提示不會讓工具卡住之後才做。
6. **在 Linux 上，就是第 1 與第 2 步。** 有安裝 LibreOffice 的地方，`soffice --headless` 也可以在每個系統上產生第 1 步的文字與 PDF（Graph 只轉換最多 2 MB 的檔案）。

## 安全

- 在第 1、3、4、5 步，權杖不會交給任何 CLI：Graph 的呼叫由伺服器發出，和行事曆一樣。下載位址（短期有效，不需權杖就能取得一個檔案）由伺服器去抓，從不給 agent 看。
- 文件的內容以資料的形式交給 agent，絕不當成指示（`readTool()` 的 `<app_data>`）；ZIP 讀取器守住它的限制，讀 XML 時不接受 DTD 與實體。
- 第 1、3、4、5 步每次寫入使用者的文件都在待送出匣等使用者，在每種權限下都一樣，包括完全存取，和 Google 文件與 Obsidian 的寫入相同，送出的正是卡片上顯示的內容。
- 固定的腳本文字：JXA 的值當作 run handler 的參數，和資料夾對話框一樣（`folderPicker.ts`）；PowerShell 的值放在環境變數裡，或以 JSON 行從 stdin 傳入，和 Teams 一樣（`teamsPowerShell.ts`）；從不放進文字（AGENTS.md 的 Code）。
- 桌面工具操作的是使用者自己正在執行的 app：在完全存取以外，除了讀取，每次呼叫都先詢問。
- 第 2 步是例外：連線在 CLI 手上，所以只有 CLI 自己的核准與簡報能管它，就像現在 Claude 或 Codex 裡的 Slack。

## 考慮過的其他做法

- **Office 增益集（Office.js）。** 編輯最深，在 Windows、Mac 和網頁上都行；但只能處理開著的文件、要透過 HTTPS 提供、要側載或由管理員部署，而它的頁面能不能連到 127.0.0.1 上的 Harness Relay 是 **unsure**。
- **WOPI。** 只給 Microsoft 雲端儲存合作夥伴計畫裡的儲存服務商。
- **在瀏覽器工具裡用網頁版 Office。** 它們的瀏覽器每個對話都從空白的設定檔開始，所以每次都要登入 Microsoft，而且頁面的版面會變。
- **處理檔案的社群 MCP 伺服器**（excel-mcp-server、GongRzhe 的 Word 與 PowerPoint 伺服器）。agent 自己的工具已經能在工作目錄裡做到；GongRzhe 的已經封存。
- **讓 agent 自己執行 `osascript` 或 PowerShell。** 沒有層級也沒有待送出匣，結果由各 CLI 的沙箱決定；第 3 與第 5 步的工具讓決定權留在 Harness Relay。
- **只等 Work IQ。** 它要管理員同意與計費，排除了個人帳號和大多數小團隊。

## 待決問題

- 先做個人帳號，還是公司帳號（Excel 的 API、SharePoint）？
- 讀取用 `Files.Read.All`，還是 `Files.Read`（只有使用者自己的檔案）？
- agent 想編輯的檔案放哪裡：工作目錄裡的一份複本（一個 `act` 工具），還是對話的附件資料夾？
- Claude 的 Microsoft 365 connector 在 `claude mcp list` 裡的名稱，`HOSTED_APPS` 需要它：在登入後檢查之前都是 **unsure**。
- 各 CLI 自己的沙箱是否允許 agent 的 `osascript` 連到其他 app，以及 ad hoc 簽署的 app 更新後 macOS 會不會再要一次「自動化」同意：**unsure**，沒有試過。
- Apple 的 iWork MCP：它的傳輸方式、它的工具，以及像 Harness Relay 這樣的本機用戶端能不能連上。
- Windows 的 agent 登錄會不會正式推出，以及 Office 會不會在裡面註冊。

## 測試

- 在 `test/fake-oauth-server.ts` 裡加一個代替 Graph 雲端硬碟的服務：搜尋、轉到下載主機的 302、帶 `if-match` 的上傳工作階段（檔案被改過時回 412）、活頁簿 API 的範圍，以及個人帳號對它的拒絕。
- 讀取工具從 `test/fixtures/` 裡的 Word、PowerPoint、Excel 檔取出的文字，以及 ZIP 讀取器的拒絕（項目太多、太大、有 DTD）。
- 待送出匣：提出上傳、以提案時複製的位元組確認、檔案被改過時被拒絕，以及連結或受保護的路徑被拒絕。
- 透過假的執行器跑 `osascript` 與 PowerShell：固定的文字、參數、時間限制；在 CI 上從不真的執行。
- 一個對代替 Microsoft 的服務的端對端 spec，像 `e2e/specs/oauth.spec.ts` 用它自己的 `fakeMicrosoft()` 對行事曆那樣。
