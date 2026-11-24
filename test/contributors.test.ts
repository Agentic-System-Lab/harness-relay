import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  avatarUrl,
  END,
  escapeHtml,
  parseList,
  PER_ROW,
  pickLogins,
  READMES,
  renderTable,
  replaceSection,
  START,
  type ApiContributor,
  type Person,
} from '../scripts/contributors';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

const user = (login: string, contributions = 1): ApiContributor => ({ login, type: 'User', contributions });
const person = (login: string, name = login): Person => ({ login, name, avatar: 'https://avatars.githubusercontent.com/u/1?v=4' });

describe("the READMEs' contributors", () => {
  it('lists GitHub’s contributors in its order, without bots and those left out, then the people added, each once', () => {
    const contributors = [
      user('cyyeh', 312),
      user('claude', 16),
      { login: 'dependabot[bot]', type: 'Bot', contributions: 4 },
      user('Someone', 2),
    ];
    expect(pickLogins(contributors, { add: ['davidho27941', 'someone', 'CYYEH'], leaveOut: ['Claude'] })).toEqual([
      'cyyeh',
      'Someone',
      'davidho27941',
    ]);
    expect(pickLogins([], { add: [], leaveOut: [] })).toEqual([]);
  });

  it('reads the hand-kept list, and refuses one that is not logins', () => {
    expect(parseList('{"add": ["davidho27941"], "leaveOut": ["claude"]}')).toEqual({ add: ['davidho27941'], leaveOut: ['claude'] });
    expect(parseList('{}')).toEqual({ add: [], leaveOut: [] });
    for (const bad of ['{"add": "x"}', '{"add": [1]}', '{"add": ["a b"]}', '{"add": ["-x"]}', '{"leaveOut": ["<b>"]}']) {
      expect(() => parseList(bad), bad).toThrow(/GitHub logins/);
    }
  });

  it("the repository's list adds davidho27941 and leaves the claude and cyyeh accounts out", () => {
    const list = parseList(read('.github/contributors.json'));
    expect(list.add).toContain('davidho27941');
    expect(list.leaveOut).toEqual(expect.arrayContaining(['claude', 'cyyeh']));
  });

  it('draws each person as their avatar and name, linking to their profile, a row at a time', () => {
    const table = renderTable([person('cyyeh', 'Chih-Yu Yeh'), person('davidho27941', 'Ta Wei (David) Ho')]);
    expect(table).toBe(
      [
        '<table>',
        '  <tr>',
        '    <td align="center" valign="top" width="120"><a href="https://github.com/cyyeh"><img src="https://avatars.githubusercontent.com/u/1?v=4&amp;s=128" width="64" height="64" alt=""><br><sub><b>Chih-Yu Yeh</b></sub></a></td>',
        '    <td align="center" valign="top" width="120"><a href="https://github.com/davidho27941"><img src="https://avatars.githubusercontent.com/u/1?v=4&amp;s=128" width="64" height="64" alt=""><br><sub><b>Ta Wei (David) Ho</b></sub></a></td>',
        '  </tr>',
        '</table>',
      ].join('\n'),
    );
    const many = renderTable(Array.from({ length: PER_ROW + 1 }, (_, i) => person(`p${i}`)));
    expect(many.match(/<tr>/g)).toHaveLength(2);
  });

  it('escapes a name for HTML, and takes avatars from GitHub only', () => {
    expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;');
    expect(renderTable([person('x', '<img src=x onerror=alert(1)>')])).toContain('<b>&lt;img src=x onerror=alert(1)&gt;</b>');
    expect(avatarUrl('https://avatars.githubusercontent.com/u/9?v=4')).toBe('https://avatars.githubusercontent.com/u/9?v=4&s=128');
    expect(() => avatarUrl('https://example.com/u/9')).toThrow(/not a GitHub avatar/);
    expect(() => avatarUrl('https://avatars.githubusercontent.com.example.com/u/9')).toThrow(/not a GitHub avatar/);
  });

  it('replaces only what is between the markers, the same way each time', () => {
    const readme = `# Title\n\n${START}\nold\n${END}\n\n## License\n`;
    const once = replaceSection(readme, '<table></table>');
    expect(once).toBe(`# Title\n\n${START}\n<table></table>\n${END}\n\n## License\n`);
    expect(replaceSection(once, '<table></table>')).toBe(once);
    expect(replaceSection(`${START}${END}`, 'x')).toBe(`${START}\nx\n${END}`);
    for (const bad of ['no markers', `${END}${START}`, `${START}${START}${END}`, `${START}${END}${END}`]) {
      expect(() => replaceSection(bad, 'x'), bad).toThrow(/once each/);
    }
  });

  it.each(READMES)('%s has the section, between its markers, before the License', (name) => {
    const text = read(name);
    expect(() => replaceSection(text, 'x')).not.toThrow();
    const section = text.slice(text.indexOf(START), text.indexOf(END));
    expect(section).toContain('https://github.com/davidho27941');
    expect(section).not.toContain('https://github.com/claude"');
    expect(text.indexOf(END)).toBeLessThan(text.search(/^## (License|授權)$/m));
  });
});
