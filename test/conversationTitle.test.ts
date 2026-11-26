import { describe, expect, it } from 'vitest';
import { conversationHeading, titleFrom } from '../src/shared/conversationTitle';
import type { ChatMessage } from '../src/shared/types';

const firstLine = 'https://github.com/Agentic-System-Lab/harness-relay/releases — summarize the latest changes';
const saved = 'https://github.com/Agentic-System-Lab/h…';

function user(id: string, text: string): ChatMessage {
  return { id, author: { kind: 'user' }, createdAt: 1, status: 'done', parts: [{ type: 'text', text }] };
}

describe('the question in the chat header', () => {
  it('recovers the first line of an existing chat or an automation before its first run', () => {
    const text = firstLine + '\nPut the summary in a table.';
    expect(titleFrom(text)).toBe(saved);
    expect(conversationHeading({ title: saved, messages: [user('a', '\n  ' + text)] })).toBe(firstLine);
    expect(conversationHeading({ title: saved, messages: [], schedule: { text } })).toBe(firstLine);
  });

  it('uses the first question written in this branch, even when a copied question has the same prefix', () => {
    const branch = { fromId: 'parent', fromTitle: 'Parent', afterId: 'a' };
    const copied = user('a', firstLine);
    const own = firstLine.replace('summarize the latest changes', 'compare two versions');
    expect(conversationHeading({ title: saved, branch, messages: [copied, user('b', own)] })).toBe(own);
    expect(conversationHeading({ title: saved, branch, messages: [copied] })).toBe(saved);
  });

  it('preserves the run time when an automation opens a new chat and leaves custom suffixes alone', () => {
    const question = { ...user('a', firstLine), scheduled: true };
    for (const time of ['11/26, 09:00', '11/26 09:00', '2026-11-26T01:00:00.000Z']) {
      const title = saved + ' · ' + time;
      expect(conversationHeading({ title, messages: [question] })).toBe(firstLine + ' · ' + time);
      expect(conversationHeading({ title, messages: [user('a', firstLine)] })).toBe(title);
    }
    const title = saved + ' · approved';
    expect(conversationHeading({ title, messages: [question] })).toBe(title);
  });

  it('keeps a custom name, a real ellipsis, and a title whose source is unavailable', () => {
    const messages = [user('a', firstLine)];
    for (const title of ['Release notes', 'A deliberately shortened name…', 'x'.repeat(39) + '…']) {
      expect(conversationHeading({ title, messages })).toBe(title);
    }
    expect(conversationHeading({ title: saved, messages: [user('a', saved)] })).toBe(saved);
    expect(conversationHeading({ title: saved, messages: [] })).toBe(saved);
  });

  it('recognizes an attachment-only name and a legacy name cut inside an emoji', () => {
    const name = 'inspection-photos-from-the-production-line.zip';
    const attachmentOnly = user('a', '');
    attachmentOnly.parts = [{ type: 'attachment', id: 'file', name, mimeType: 'application/zip', size: 100 }];
    expect(conversationHeading({ title: titleFrom(name), messages: [attachmentOnly] })).toBe(name);
    const question = '圖'.repeat(38) + '📚請比較兩組結果';
    expect(conversationHeading({ title: '圖'.repeat(38) + '�…', messages: [user('a', question)] })).toBe(question);
  });

  it('bounds very long questions without cutting an emoji in half', () => {
    const text = '題'.repeat(198) + '📚more';
    const heading = conversationHeading({ title: titleFrom(text), messages: [user('a', text)] });
    expect(heading).toBe('題'.repeat(198) + '…');
  });
});
