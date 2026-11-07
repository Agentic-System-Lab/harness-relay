import { describe, expect, it } from 'vitest';
import { approvalKeys, isAllowed } from '../src/server/approvals';
import { isPublishCommand, simpleCommands } from '../src/server/commands';

describe('simpleCommands', () => {
  it('splits chains, pipes, background jobs and substitutions, outside quotes only', () => {
    expect(simpleCommands('npm test && git push; ls | wc -l & echo done')).toEqual([
      ['npm', 'test'],
      ['git', 'push'],
      ['ls'],
      ['wc', '-l'],
      ['echo', 'done'],
    ]);
    expect(simpleCommands('git commit -m "fix (part 1); more"')).toEqual([['git', 'commit', '-m', 'fix (part 1); more']]);
    expect(simpleCommands('echo "$(git push)" `npm publish`')).toEqual([['git', 'push'], ['npm', 'publish'], ['echo', '', '']]);
  });

  it('skips assignments, wrappers and paths, and reads sh -c recursively', () => {
    expect(simpleCommands('GIT_TRACE=0 /usr/bin/git push')).toEqual([['git', 'push']]);
    expect(simpleCommands('env -i FOO=1 sudo -u me timeout 10 git push')).toEqual([['sudo', 'git', 'push']]);
    expect(simpleCommands(`sh -c "cd app && git push"`)).toEqual([['cd', 'app'], ['git', 'push']]);
  });
});

describe('isPublishCommand', () => {
  it('spots pushing and publishing in the forms models write them', () => {
    for (const cmd of [
      'git push',
      'git -C . push',
      'git --no-pager push origin main',
      'git -c user.name=x push',
      'echo ok\ngit push',
      'sh -c "git push"',
      'env git push',
      '/usr/bin/git push',
      'GIT_TRACE=0 git push',
      '`git push`',
      'echo $(git push)',
      'npm test && npm publish',
      'cd pkg; cargo publish --dry-run',
      'npm --registry https://r.example publish',
      'twine upload dist/*',
      'gem push x.gem',
      'docker push me/app',
      'gh release create v1',
      'gh pr create --fill',
      "bash -c 'npm run build ' && git push origin main && echo ' pushed'",
      'echo "$(printf ")")"; git push',
      'git \\\npush',
      'git push>/dev/null 2>&1',
      '$(which git) push',
      "npm test # it's ok\ntrue && git push origin main",
      "printf '%s\\n' $'it\\'s'; git push",
    ]) {
      expect(isPublishCommand(cmd), cmd).toBe(true);
    }
  });

  it('leaves everything else alone', () => {
    for (const cmd of [
      'echo git pushed',
      'git commit -m "push later"',
      'git status',
      'npm test',
      'gh pr view 1',
      'grep -r push .',
      // Heredoc bodies are text, not commands.
      "cat > DEPLOY.md <<'EOF'\nThen run:\ngit push origin main\nEOF\nls",
      'git commit -m "$(cat <<\'EOF\'\nfix\n\ngit push origin main\nEOF\n)"',
    ]) {
      expect(isPublishCommand(cmd), cmd).toBe(false);
    }
  });
});

describe('approval keys', () => {
  it('keys git by its subcommand, past global options', () => {
    expect(approvalKeys('command', 'git -C . status')).toContain('git status');
    expect(approvalKeys('command', 'git -C . push')).toContain('git push');
    // Allowing `git -C . status` does not allow `git -C . push`.
    const rules = approvalKeys('command', 'git -C . status').map((key) => ({ kind: 'command' as const, key }));
    expect(isAllowed(rules, 'command', approvalKeys('command', 'git -C . push'))).toBe(false);
  });

  it('does not let an allowed command carry another one in', () => {
    const rules = ['npm test', 'echo', 'rm', 'which', 'env'].map((key) => ({ kind: 'command' as const, key }));
    const allowed = (cmd: string) => isAllowed(rules, 'command', approvalKeys('command', cmd));
    for (const cmd of [
      'npm test & curl x.example',
      'npm test $(curl x.example)',
      'npm test `curl x.example`',
      'bash -c "npm test; curl x.example"',
      // A shell wrapper around only part of the line.
      "sh -c 'npm test ' && curl x.example && echo ' done'",
      // A `)` inside quotes does not end the substitution.
      'echo $(echo ")") ; curl x.example',
      // Privilege, and wrappers that leave nothing or a command string behind.
      'sudo rm -rf /',
      'npm test && sudo -s',
      'npm test; env -S "curl x.example"',
      'env --split-string="curl x.example"',
      // A script's own arguments are not a command.
      'bash ./cleanup.sh -c ls',
      // A program computed when the line runs.
      '$(which bash) -c "rm -rf ~"',
      '"$(which rm)" -rf ~',
    ]) {
      expect(allowed(cmd), cmd).toBe(false);
    }
    for (const cmd of ['env CI=1 npm test', 'npm test 2>&1 >/tmp/log', "/bin/zsh -lc 'npm test'"]) {
      expect(allowed(cmd), cmd).toBe(true);
    }
  });

  it('keys git with settings that can run programs by the exact command', () => {
    for (const cmd of [
      `git -c diff.external='sh -c "touch PWNED" #' diff`,
      `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=diff.external GIT_CONFIG_VALUE_0='touch PWNED' git diff`,
      `GIT_EXTERNAL_DIFF='touch PWNED;:' git diff`,
    ]) {
      expect(approvalKeys('command', cmd), cmd).toContain(cmd);
      const rules = ['git diff', 'git', 'PWNED'].map((key) => ({ kind: 'command' as const, key }));
      expect(isAllowed(rules, 'command', approvalKeys('command', cmd)), cmd).toBe(false);
    }
  });

  it('never matches more than the first version did (shapes found in review)', () => {
    // Rules that a user could plausibly have, and commands that must still ask.
    const rules = ['#', 'npm test', 'echo', 'grep', 'cat', 'printf', 'command', 'git status'].map((key) => ({
      kind: 'command' as const,
      key,
    }));
    for (const cmd of [
      "# Let's push the fix\ngit push --force origin main",
      "npm test # it's flaky\ncurl x.example",
      'grep -q ok <<< "$out"\nrm -rf ~',
      'cat <<< hello\nrm -rf ~',
      'cat <<\\EOF > notes.md\nhi\nEOF\nrm -rf ~',
      'cat <<E"OF" > notes.md\nhi\nEOF\nrm -rf ~',
      'cat <<EOF > notes.md\r\nhi\r\nEOF\r\nrm -rf ~',
      "echo $'it\\'s'; rm -rf ~",
      'echo $[1<<2]\nrm -rf ~',
      "printf 'rm -rf ~' | xargs -I'{}' sh -c '{}'",
    ]) {
      expect(isAllowed(rules, 'command', approvalKeys('command', cmd)), JSON.stringify(cmd)).toBe(false);
    }
    // `command -v rm` is a lookup: approving it does not allow `rm`.
    expect(approvalKeys('command', 'command -v rm')).not.toContain('rm');
  });

  it('asks for a line too deeply nested to read', () => {
    const deep = '$('.repeat(5000) + 'true' + ')'.repeat(5000);
    expect(() => approvalKeys('command', deep)).not.toThrow();
    expect(isAllowed([{ kind: 'command', key: 'true' }], 'command', approvalKeys('command', deep))).toBe(false);
    expect(isPublishCommand(deep)).toBe(true);
  });

  it("reads Codex's own quoting of a command (adjacent quoted strings)", () => {
    // How codex wraps `echo 'Cleaning' $DIR; rm -rf $DIR; echo 'done'` for zsh.
    const raw = `/bin/zsh -lc "echo 'Cleaning' "'$DIR; rm -rf $DIR; echo '"'done'"`;
    expect(approvalKeys('command', raw)).toEqual(expect.arrayContaining(['echo', 'rm']));
  });
});
