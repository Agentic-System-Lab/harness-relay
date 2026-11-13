<!--
Thanks for the pull request! CONTRIBUTING.md says what a change needs. Write in English or 繁體中文.
謝謝你的 pull request！修改需要做到哪些事，請見 CONTRIBUTING.zh-TW.md。用中文或英文寫都可以。
-->

## What and why · 改了什麼、為什麼

<!-- What the change does and why. Link the issue it addresses, e.g. "Fixes #123". -->
<!-- 這個修改做了什麼、為什麼，並附上相關 issue 的連結，例如「Fixes #123」。 -->

## How it was tested · 怎麼測試

<!-- Tests you added or changed. If it changes what agents see or do, which real CLIs (claude, codex, grok, cursor-agent, agy, copilot, the open-source agents) you tried it with. -->
<!-- 新增或修改了哪些測試。如果會影響 agent 看到或做的事，用哪些真正的 CLI（claude、codex、grok、cursor-agent、agy、copilot、開源 agent）試過。 -->

## Docs and translations · 文件與翻譯

<!-- Which docs and locale files you updated, in both languages, or why none were needed. -->
<!-- 更新了哪些文件與語系檔（兩種語言），或為什麼不需要更新。 -->

## Screenshots · 截圖

<!-- For UI changes: screenshots or a short recording, in both languages if the text changed, and on a phone-sized window if the layout changed. Otherwise delete this section. -->
<!-- 介面上的修改請附截圖或短片：有改到文字時兩種語言都要，有改到版面時也附上手機尺寸的畫面。沒有的話請刪掉這一段。 -->

## Checklist · 檢查清單

- [ ] `npm run typecheck`, `npm test` and `npm run build` pass · 都通過
- [ ] `npm run test:e2e` passes, if I changed the UI, the HTTP API, the orchestrator or an adapter · 修改了介面、HTTP API、協調器或轉接器時，端對端測試通過
- [ ] `npm run desktop:typecheck` passes and I tried `npm run desktop`, if I changed `desktop/` · 修改了 `desktop/` 時，型別檢查通過，也用 `npm run desktop` 試過
- [ ] User-facing text and docs come in both English and 繁體中文, or I said which one I need help with · 給使用者看的文字與文件都有中英文，或我已說明需要協助的語言
- [ ] I read the whole diff, also the parts an agent wrote, and everything above is true · 我讀過整份 diff（包括 agent 寫的部分），以上所寫都是事實
