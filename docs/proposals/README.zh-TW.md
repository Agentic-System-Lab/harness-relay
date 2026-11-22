[English](README.md) | **繁體中文**

# 提案

Harness Relay 還沒有的功能的設計。這個資料夾裡的東西都還沒實作，除了各提案狀態寫明已完成的部分：app 現在的樣子以[架構](../architecture.zh-TW.md)和[開發者說明](../developer-guide.zh-TW.md)為準。

| 提案 | 狀態 | 摘要 |
| --- | --- | --- |
| [排程與事件觸發的執行](triggers.zh-TW.md) | 第一步（排程）與第二步（webhook，屬於排程）已完成，第三步做成排程的選項；排程也可以追蹤目標，以及在某件事發生時啟動（新郵件、即將開始的行程、pull request 或失敗的 CI、檔案；可以等一件或好幾件；由 Harness Relay 自己檢查）；各有自己 webhook 的具名觸發器尚未開始 | 對話自己開始一輪：依排程，或在本機程式回報事件時。 |
| [用 OAuth 登入的帳號](oauth.zh-TW.md) | 核心已完成，含 Microsoft 365 與 Outlook.com 的行事曆（Graph）、Google 日曆（用權杖的 CalDAV）、Microsoft 365、Outlook.com 與 Gmail 的郵件（IMAP 與 SMTP 加上 XOAUTH2），另有各自授權的 Google Drive 讀取、Google 文件編輯，以及工具庫中遠端 MCP 伺服器自己的登入 | 這些服務與需要登入的 MCP 伺服器共用一個登入介面：權杖會自動更新並存在憑證儲存區，由行事曆與郵件工具以及郵件觸發使用，並交給每一回合的 MCP 伺服器。 |
| [agent 之間共用的記憶](shared-memory.zh-TW.md) | 尚未開始 | agent 建議要記下的筆記，由使用者決定是否加進工具庫的記憶；依專案分的記憶；匯入各 CLI 自己記住的東西。 |
| [網站預覽與 Generative UI](preview-and-generative-ui.zh-TW.md) | [應用程式預覽](app-preview-runtime.zh-TW.md)已實作，互動式回覆仍在規劃 | 在聊天旁的面板試用 agent 做的網站，並把錯誤交回給 agent；回覆裡可以有選項、表單、圖表和小型互動頁面。 |
| [agent CLI 自己的功能](agent-cli-features.zh-TW.md) | 第 1 到 8 步已完成，依各 CLI 自己的 schema、隨附程式碼與執行檔實作（還沒有實際執行過）；Cline 的 subagent 在完全存取以外也關閉；Antigravity 與 Muse Code 的背景工作沒有等待（它們不回報何時結束）；Copilot 的 AI credits 有計入但沒有顯示。第 9 步（把已檢查的版本往前移）與實際測試仍待完成 | 十二個 CLI 本身做得到、Harness Relay 還沒用上的：受管理且看得到的 subagent 與 workflow、端點模型的 context window、計畫、提問、引導執行中的回合、結構化回答與預算。 |
| [每種應用程式都用同一種方式預覽](unified-app-preview.zh-TW.md) | 第 1 到 3 步已完成（`Dockerfile` 應用程式、終端機、compose），含 agent 的說明；Relay 自己的 builder 與只允許 registry 的 proxy，以及自動產生的建置仍未完成 | 任何語言都用同一種方式預覽：專案宣告的 `Dockerfile` 或 compose 檔，應用程式提供 HTTP 時顯示網頁、沒有時顯示終端機，資料庫之類的服務放在無法對外連線的網路上。 |
| [Office 文件](office-documents.zh-TW.md) | 尚未開始；一份調查（2026-11-22） | 透過 Graph 處理 OneDrive 與 SharePoint 裡的 Word、Excel、PowerPoint，Claude 的 Microsoft 365 connector，macOS（Office for Mac、Pages、Numbers、Keynote）與 Windows 的桌面 app，以及 Linux；有哪些官方 MCP 伺服器（Work IQ、Apple 的 iWork）。 |
| [發布預覽過的應用程式](app-publish.zh-TW.md) | 第 1 與第 2 步已完成（Render 靜態網站與 web service、PostgreSQL 改用 Neon 並執行初始化腳本、更新、取消發布）；尚未用真的帳號試過；其他雲端業者未開始 | 使用者試過的預覽，用同一份快照、經由私人 GitHub 儲存庫，一鍵發布到使用者自己的 Render 與 Neon 帳號。 |
| [只有使用者能做的步驟](user-handoffs.zh-TW.md) | 已完成密鑰卡、固定指令（試跑、待送出匣、自動任務）、互動指令、交出瀏覽器（視窗、畫面串流）與只給使用者的瀏覽器、檔案面板的編輯，以及步驟卡；要一直執行的程式和接收外部 webhook 還沒做 | 用卡片提供密鑰，值不進聊天也不給 agent；Relay 帶著密鑰執行固定指令（試跑、定時執行，或在待送出匣核准後執行）；以及由使用者接手的步驟：互動指令和瀏覽器。 |

## 這個資料夾的用法

- 一個提案一個檔案，兩種語言都要有（`<name>.md` 和 `<name>.zh-TW.md`），一起修改。
- 提案要寫清楚：現在有什麼、缺什麼、建議的設計、不採用的做法和原因、還沒決定的問題。
- 提案的某一部分做出來時，在同一個 commit 裡把那部分寫進架構文件和開發者說明（兩種語言），並更新這裡的狀態。全部做完或決定不做時，刪掉該檔案，並在 commit 訊息裡說明。
