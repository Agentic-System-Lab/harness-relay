[English](README.md) | **繁體中文**

# 提案

Harness Relay 還沒有的功能的設計。這個資料夾裡的東西都還沒實作，除了各提案狀態寫明已完成的部分：app 現在的樣子以[架構](../architecture.zh-TW.md)和[開發者說明](../developer-guide.zh-TW.md)為準。

| 提案 | 狀態 | 摘要 |
| --- | --- | --- |
| [排程與事件觸發的執行](triggers.zh-TW.md) | 第一步（排程）與第二步（webhook，屬於排程）已完成，第三步做成排程的選項；排程也可以追蹤目標，以及在某件事發生時啟動（新郵件、即將開始的行程、pull request 或失敗的 CI、檔案；可以等一件或好幾件；由 Harness Relay 自己檢查）；各有自己 webhook 的具名觸發器尚未開始 | 對話自己開始一輪：依排程，或在本機程式回報事件時。 |
| [用 OAuth 登入的帳號](oauth.zh-TW.md) | 核心已完成，含 Microsoft 365 與 Outlook.com 的行事曆（Graph）、Google 日曆（用權杖的 CalDAV）、Microsoft 365、Outlook.com 與 Gmail 的郵件（IMAP 與 SMTP 加上 XOAUTH2），以及工具庫中遠端 MCP 伺服器自己的登入 | 給不接受應用程式專用密碼的服務，以及需要登入的 MCP 伺服器，一個共用的登入介面：權杖會自動更新並存在憑證儲存區，由行事曆與郵件工具以及郵件觸發使用，並交給每一回合的 MCP 伺服器。 |
| [agent 之間共用的記憶](shared-memory.zh-TW.md) | 尚未開始 | agent 建議要記下的筆記，由使用者決定是否加進工具庫的記憶；依專案分的記憶；匯入各 CLI 自己記住的東西。 |
| [網站預覽與 Generative UI](preview-and-generative-ui.zh-TW.md) | 尚未開始 | 在聊天旁的面板試用 agent 做的網站，並把錯誤交回給 agent；回覆裡可以有選項、表單、圖表和小型互動頁面。 |
| [agent CLI 自己的功能](agent-cli-features.zh-TW.md) | 尚未開始 | 十二個 CLI 本身做得到、Harness Relay 還沒用上的：受管理且看得到的 subagent 與 workflow、端點模型的 context window、計畫、提問、引導執行中的回合、結構化回答與預算。 |

## 這個資料夾的用法

- 一個提案一個檔案，兩種語言都要有（`<name>.md` 和 `<name>.zh-TW.md`），一起修改。
- 提案要寫清楚：現在有什麼、缺什麼、建議的設計、不採用的做法和原因、還沒決定的問題。
- 提案的某一部分做出來時，在同一個 commit 裡把那部分寫進架構文件和開發者說明（兩種語言），並更新這裡的狀態。全部做完或決定不做時，刪掉該檔案，並在 commit 訊息裡說明。
