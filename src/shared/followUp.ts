import { mentionsInMarkdown, unknownMentions } from './mentions';
import type { AgentConfig, ChatMessage, Conversation } from './types';

export interface FollowUpSource {
  id: string;
  agent: AgentConfig;
  text: string;
}

export function followUpId(message?: ChatMessage): string | undefined {
  return message?.parts.find((p) => p.type === 'text')?.followUp?.replyId;
}

type History = Pick<Conversation, 'agents' | 'messages' | 'pause' | 'queue' | 'branch'>;

export function followUpSource(message: ChatMessage, agents: AgentConfig[]): FollowUpSource | undefined {
  const author = message.author;
  if (author.kind !== 'agent' || message.status !== 'done' || message.passed) return;
  const agent = agents.find((a) => a.id === author.agentId);
  const text = message.parts
    .flatMap((p) => (p.type === 'text' ? [p.text] : []))
    .join('\n')
    .trim();
  return agent && text ? { id: message.id, agent, text } : undefined;
}

/** Copied background in an independent topic cannot own a follow-up in the new topic. */
export function topicCutoff(conv: Pick<History, 'branch' | 'messages'>): number {
  return conv.branch?.independent ? conv.messages.findIndex((m) => m.id === conv.branch!.afterId) : -1;
}

/** Only infer from the latest completed exchange. Older replies can still be selected explicitly. */
export function followUpSources(conv: History): FollowUpSource[] {
  if (conv.pause || conv.queue?.length || !conv.agents.length) return [];
  const { messages } = conv;
  const start = messages.findLastIndex((m) => m.author.kind === 'user');
  const question = messages[start];
  if (!question || question.queued || question.scheduled || question.autoFix || start <= topicCutoff(conv)) return [];
  const replies = messages.slice(start + 1);
  if (replies.some((m) => m.status !== 'done' && m.author.kind === 'agent')) return [];
  return replies.flatMap((m) => followUpSource(m, conv.agents) ?? []);
}

const teamRequest =
  /\b(?:everyone|everybody|whole team|entire team|all (?:the )?(?:agents|members|of you)|both of you|each of you|you (?:both|all)|(?:can|could|would|should) the team|(?:ask|have) the team)\b|大家|全隊|所有成員|每位成員|整個團隊|各位|兩位|兩人|你們|一起回答/iu;
const followUpCue =
  /\b(?:that|those|earlier|previous(?:ly)?|you (?:said|found|reported|mentioned))\b|剛[才剛]|方才|先前|前面|上面|那(?:個|項|些|段|筆|次)|提到|提過|提及/u;
const questionCue = /[?？]|\b(?:why|what|which|how|where|when)\b|為什麼|為何|什麼|哪[裡個些]|怎麼|如何/u;
const newTask =
  /(?:^|\b(?:please|you|now|then)\s+)(?:implement|create|add|write|refactor|build|redesign)\s|(?:^|請|幫我|另外)(?:新增|實作|重寫|重構|建立)|另外|新任務/u;
const common = new Set(
  'a an the that this these those what why which how did does do is are was were will would could should i you your it its has have had about for from to of or and in on with as at by please earlier previous reported mentioned said found can tell me error message test tests failed failure issue result results'.split(
    ' ',
  ),
);

function evidence(text: string, phrases: boolean): Set<string> {
  const keys = new Set<string>();
  for (const m of text.matchAll(/[`"「“]([^`"」”\n]{3,160})[`"」”]/gu)) keys.add(m[1]!.toLowerCase());
  for (const m of text.matchAll(/\bHTTP[ -]+[1-5]\d\d\b/gi)) keys.add(m[0].toLowerCase());
  // Preserve case until codes and camelCase test names have been identified.
  for (const m of text.matchAll(/[a-zA-Z0-9]+(?:[._/-][a-zA-Z0-9]+)+|\b(?:E[A-Z]{2,}|[A-Z]+[0-9]+|[a-z]+(?:[A-Z][a-z0-9]+)+)\b/g)) {
    keys.add(m[0].toLowerCase());
  }
  if (!phrases) return keys;
  const query = text.toLowerCase();
  for (const phrase of query.matchAll(/[a-z]+(?:[ -]+[a-z]+)+/g)) {
    const words = phrase[0].split(/[ -]+/);
    for (let i = 1; i < words.length; i++) {
      if (!common.has(words[i - 1]!) && !common.has(words[i]!)) keys.add(words.slice(i - 1, i + 1).join(' '));
    }
  }
  // Han compounds have no spaces. Keep complete subjects between reference words and question cues.
  const content = query.replace(
    /剛才|剛剛|那個|那些|這個|先前|提到|提過|提及|錯誤訊息|錯誤信息|為什麼|怎麼回事|是什麼|什麼|測試|失敗|可以說明|的/g,
    ' ',
  );
  for (const m of content.matchAll(/\p{Script=Han}{4,}/gu)) keys.add(m[0]);
  return keys;
}

function containsKey(text: string, key: string): boolean {
  // A partial identifier (E123 inside E1234, say) does not identify the same issue.
  let at = text.indexOf(key);
  while (at >= 0) {
    const before = text[at - 1] ?? '';
    const after = text[at + key.length] ?? '';
    const word = /[a-z0-9_]/;
    const insidePrefix = word.test(key[0]!) && (word.test(before) || (/[.-]/.test(before) && word.test(text[at - 2] ?? '')));
    const insideSuffix =
      word.test(key.at(-1)!) && (word.test(after) || (/[./-]/.test(after) && word.test(text[at + key.length + 1] ?? '')));
    if (!insidePrefix && !insideSuffix) return true;
    at = text.indexOf(key, at + 1);
  }
  return false;
}

export function addressedFollowUp(text: string, names: string[]): boolean {
  return text.includes('@') && (mentionsInMarkdown(text, names).length > 0 || unknownMentions(text, names).length > 0);
}

/** Match the words the user refers back to. Multiple matching authors are always ambiguous. */
export function inferFollowUp(text: string, sources: FollowUpSource[]): FollowUpSource | undefined {
  if (!sources.length || text.length > 1200) return;
  const normalized = text.normalize('NFKC');
  const query = normalized.toLowerCase();
  if (teamRequest.test(query) || newTask.test(query) || (!followUpCue.test(query) && !questionCue.test(query))) return;
  const keys = [...evidence(normalized, followUpCue.test(query) || /\b(?:tests?|scenario)\b|測試|案例/.test(query))];
  if (!keys.length) return;
  let match: FollowUpSource | undefined;
  for (const source of sources) {
    const said = source.text.normalize('NFKC').toLowerCase();
    if (!keys.some((key) => containsKey(said, key))) continue;
    if (match && match.agent.id !== source.agent.id) return;
    match = source;
  }
  return match;
}
