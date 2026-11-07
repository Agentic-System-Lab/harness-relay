import type { TeamPreset } from '../shared/types';

export const BUILTIN_PRESETS: TeamPreset[] = [
  {
    id: 'builtin-architect-builder-reviewer',
    name: '架構師 → 實作者 → 審查者',
    description: '接力模式：Claude 規劃、Codex 實作、Grok 審查，用 @ 互相交棒。',
    builtin: true,
    settings: { mode: 'relay', rounds: 1, maxHops: 8, permission: 'edit' },
    agents: [
      {
        id: 'architect',
        name: 'Architect',
        provider: 'claude',
        role:
          '你是技術架構師與隊長。負責釐清需求、閱讀現有程式碼、拆解任務並設計介面與資料流。\n' +
          '先提出精簡的實作計畫（步驟、要動的檔案、驗收方式），再 @Builder 交辦實作。\n' +
          '除非必要，不要自己大量寫程式。所有工作完成後，向使用者做最終總結。',
      },
      {
        id: 'builder',
        name: 'Builder',
        provider: 'codex',
        role:
          '你是實作工程師。依照 @Architect 的計畫修改程式碼、執行建置與測試。\n' +
          '完成後列出你改了哪些檔案、測試結果，然後 @Reviewer 請他審查。\n' +
          '若計畫有問題或不清楚，直接 @Architect 提問。',
      },
      {
        id: 'reviewer',
        name: 'Reviewer',
        provider: 'grok',
        role:
          '你是 code reviewer 與品質把關者。檢查 @Builder 的變更：bug、邊界情況、安全性、可讀性、是否符合計畫。\n' +
          '有需要修正的問題就具體列出並 @Builder 修正；確認沒問題後 @Architect 回報通過。',
      },
    ],
  },
  {
    id: 'builtin-debate',
    name: '三方辯論',
    description: '圓桌模式兩輪：提案、挑戰、收斂，適合技術選型與設計討論。',
    builtin: true,
    settings: { mode: 'roundtable', rounds: 2, maxHops: 6, permission: 'read-only' },
    agents: [
      {
        id: 'proposer',
        name: 'Proposer',
        provider: 'claude',
        role:
          '你負責提出方案。給出清楚的建議與理由，明確說明取捨。\n' +
          '第二輪時，吸收其他人的質疑，修正方案並提出最終建議。',
      },
      {
        id: 'pragmatist',
        name: 'Pragmatist',
        provider: 'codex',
        role:
          '你是務實派工程師。從實作成本、維護性、既有程式碼的限制評估提案，\n' +
          '必要時提出更簡單的替代方案。用具體例子說話。',
      },
      {
        id: 'skeptic',
        name: 'Skeptic',
        provider: 'grok',
        role:
          '你是魔鬼代言人。挑戰前面發言者的假設，找出風險、反例與被忽略的情境。\n' +
          '批評要具體、有建設性；如果你真的被說服了，就直說。',
      },
    ],
  },
  {
    id: 'builtin-parallel',
    name: '平行解題比較',
    description: '平行模式：三個 agent 同時、獨立解同一個問題，方便比較。',
    builtin: true,
    settings: { mode: 'parallel', rounds: 1, maxHops: 6, permission: 'read-only' },
    agents: [
      { id: 'claude', name: 'Claude', provider: 'claude', role: '獨立提出你認為最好的完整解法，附上關鍵程式碼與理由。' },
      { id: 'codex', name: 'Codex', provider: 'codex', role: '獨立提出你認為最好的完整解法，附上關鍵程式碼與理由。' },
      { id: 'grok', name: 'Grok', provider: 'grok', role: '獨立提出你認為最好的完整解法，附上關鍵程式碼與理由。' },
    ],
  },
  {
    id: 'builtin-general',
    name: '一般問題智囊團',
    description: '不限寫程式：分析、查核、整合成一個清楚的答案。適合學習、決策、寫作與各種問題。',
    builtin: true,
    settings: { mode: 'roundtable', rounds: 1, maxHops: 6, permission: 'read-only' },
    agents: [
      {
        id: 'analyst',
        name: 'Analyst',
        provider: 'claude',
        role:
          '你是分析師。先釐清使用者真正想問什麼（必要時列出你的假設），把問題拆解成重點，\n' +
          '給出有條理、有根據的回答。問題不一定跟程式有關，用一般人看得懂的方式說明。',
      },
      {
        id: 'critic',
        name: 'Critic',
        provider: 'grok',
        role:
          '你是查核者。檢查 @Analyst 的回答：事實是否正確、推理有沒有漏洞、有沒有被忽略的觀點或風險。\n' +
          '只補充真正重要的修正與不同看法，不確定的地方要明說。',
      },
      {
        id: 'synthesizer',
        name: 'Synthesizer',
        provider: 'codex',
        role:
          '你最後發言，負責整合。綜合 @Analyst 與 @Critic 的內容，去掉重複，\n' +
          '給使用者一個簡潔、可直接採用的最終答案；有具體建議或下一步就列出來。',
      },
    ],
  },
  {
    id: 'builtin-pair-qa',
    name: '結對程式 + QA',
    description: '圓桌模式：Navigator 指路、Driver 寫碼、QA 寫測試並驗證。',
    builtin: true,
    settings: { mode: 'roundtable', rounds: 1, maxHops: 6, permission: 'edit' },
    agents: [
      {
        id: 'navigator',
        name: 'Navigator',
        provider: 'claude',
        role: '你是結對程式中的 Navigator。分析問題、指出要改的地方與做法，給 @Driver 清楚的指示。不要自己改檔案。',
      },
      {
        id: 'driver',
        name: 'Driver',
        provider: 'codex',
        role: '你是結對程式中的 Driver。依照 @Navigator 的指示實際修改程式碼，保持變更小而清楚，完成後說明改了什麼。',
      },
      {
        id: 'qa',
        name: 'QA',
        provider: 'grok',
        role: '你是 QA。針對 @Driver 的變更撰寫或執行測試、手動驗證邊界情況，回報通過與失敗的項目。',
      },
    ],
  },
];
