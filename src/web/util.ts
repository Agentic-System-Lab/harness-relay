import type { AgentConfig, Mode, Permission, Provider } from '../shared/types';

export const PROVIDER_COLOR: Record<Provider, string> = {
  claude: 'var(--claude)',
  codex: 'var(--codex)',
  grok: 'var(--grok)',
};

export const MODE_INFO: Record<Mode, { label: string; hint: string }> = {
  roundtable: { label: '圓桌', hint: '依序發言，後面的人看得到前面說了什麼；可設定多輪，全部 [PASS] 時提前結束。' },
  parallel: { label: '平行', hint: '每一輪大家同時、獨立回答；下一輪才看得到彼此的答案。' },
  relay: { label: '接力', hint: '一次一位發言；被 @ 的隊友接棒，沒人被 @ 就交還給你。' },
};

export const PERMISSION_INFO: Record<Permission, { label: string; hint: string }> = {
  'read-only': { label: '唯讀', hint: '只能讀檔與分析，不會修改任何檔案。' },
  edit: { label: '可編輯', hint: '可以在工作目錄內修改檔案。' },
  full: { label: '完全存取', hint: '可修改檔案並執行任何指令，不再詢問。請只在可信任的目錄使用。' },
};

const EFFORT_LABEL: Record<string, string> = {
  none: '無',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
  ultra: 'Ultra',
};

export function effortLabel(e: string): string {
  const zh = EFFORT_LABEL[e];
  return zh ? `${zh}（${e}）` : e;
}

export function newAgent(provider: Provider, taken: string[]): AgentConfig {
  const base = { claude: 'Claude', codex: 'Codex', grok: 'Grok' }[provider];
  let name = base;
  for (let i = 2; taken.some((t) => t.toLowerCase() === name.toLowerCase()); i++) name = `${base}${i}`;
  return { id: crypto.randomUUID(), name, provider, role: '' };
}

export function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

export function formatTokens(n?: number): string {
  if (n === undefined) return '';
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

export function relativeTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return '剛剛';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分鐘前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小時前`;
  return new Date(ts).toLocaleDateString();
}

export function initials(name: string): string {
  return [...name][0]?.toUpperCase() ?? '?';
}
