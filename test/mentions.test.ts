import { describe, expect, it } from 'vitest';
import { mentionsInMarkdown, unknownMentions } from '../src/shared/mentions';

describe('unknownMentions', () => {
  it('finds names the message @mentions that are not on the team, once each, in order', () => {
    expect(unknownMentions('@dddd 看一下昨天的 PR', ['Alice'])).toEqual(['dddd']);
    expect(unknownMentions('@alice and @Bob, then @bob again', ['Alice'])).toEqual(['Bob']);
    expect(unknownMentions('@Reviewer @Writer', [])).toEqual(['Reviewer', 'Writer']);
    expect(unknownMentions('nobody here', ['Alice'])).toEqual([]);
  });

  it('reads names as @mentions do: Chinese text right after a known name, and longer words', () => {
    expect(unknownMentions('@Builder請實作', ['Builder'])).toEqual([]);
    expect(unknownMentions('@Builder請實作', [])).toEqual(['Builder']); // an ASCII name ends where its letters do
    expect(unknownMentions('@小明請看', ['小明'])).toEqual([]);
    expect(unknownMentions('@小明 請看', [])).toEqual(['小明']);
    expect(unknownMentions('@Bobby', ['Bob'])).toEqual(['Bobby']); // not @Bob
    expect(mentionsInMarkdown('@Bobby', ['Bob'])).toEqual([]);
  });

  it('takes package scopes and decorators for code, and finds names in any prose', () => {
    expect(unknownMentions('Upgrade @angular/core and @types/node; keep @Component(…) and @Input()', [])).toEqual([]);
    expect(unknownMentions('@Alice and @Zed', ['Alice'])).toEqual(['Zed']);
    expect(unknownMentions('# @Head\n\n**@Bold** _@em_\n\n| a |\n|---|\n| @Cell |', [])).toEqual(['Head', 'Bold', 'em', 'Cell']);
    expect(unknownMentions('@Bob- and @Bob_', ['Bob'])).toEqual(['Bob-', 'Bob_']); // as routing reads them: not @Bob
  });

  it('looks at prose only: not code, links or e-mail addresses', () => {
    expect(unknownMentions('`@code` [@link](https://example.com) mail me@example.com\n\n```\n@block\n```', [])).toEqual([]);
    expect(unknownMentions('@ alone, or @', [])).toEqual([]);
  });
});
