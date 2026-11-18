import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { guardGlobs, guardedNow, isGuarded, sandboxGuardGlobs, sandboxRegexLength, writeGuard } from '../src/server/writeGuard';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-guard-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('write guard', () => {
  it('is made only when the list protects something', () => {
    expect(writeGuard(undefined, [dir], 'darwin')).toBeUndefined();
    expect(writeGuard({ commitPattern: '^x' }, [dir], 'darwin')).toBeUndefined();
    expect(writeGuard({ protectedPaths: ['../out'] }, [dir], 'darwin')).toBeUndefined();
    expect(writeGuard({ protectedPaths: ['.env'] }, [], 'darwin')).toBeUndefined();
    expect(writeGuard({ protectedPaths: ['.env', './.env', 'a\\b'] }, [dir, dir], 'darwin')).toEqual({
      dirs: [dir],
      patterns: ['.env', 'a/b'],
    });
  });

  it('tells a protected path in any working directory, also one not made yet and one reached through a link', () => {
    const other = join(dir, 'other');
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    mkdirSync(other);
    const g = writeGuard({ protectedPaths: ['.env', '*.pem', 'config/prod.yml', 'secrets/'] }, [join(dir, 'a'), other], 'darwin')!;
    expect(isGuarded(g, join(dir, 'a', '.env'))).toBe(true);
    expect(isGuarded(g, join(dir, 'a', 'b', 'new', 'key.pem'))).toBe(true);
    expect(isGuarded(g, join(other, 'config', 'prod.yml'))).toBe(true);
    expect(isGuarded(g, join(other, 'b', 'config', 'prod.yml'))).toBe(false);
    expect(isGuarded(g, join(dir, 'a', 'secrets', 'x', 'y.txt'))).toBe(true);
    expect(isGuarded(g, join(dir, 'a', 'readme.md'))).toBe(false);
    expect(isGuarded(g, join(dir, '.env'))).toBe(false);
    // A link to a working directory (on Windows, links need rights a test may not have).
    if (process.platform !== 'win32') {
      symlinkSync(join(dir, 'a'), join(dir, 'link'));
      expect(isGuarded(g, join(dir, 'link', '.env'))).toBe(true);
    }
    expect(isGuarded(undefined, join(dir, 'a', '.env'))).toBe(false);
  });

  it('gives absolute globs: anchored patterns at each folder, the others at any depth, and what is under each', () => {
    const g = writeGuard({ protectedPaths: ['.env', 'config/prod.yml', 'secrets/'] }, [dir], 'darwin')!;
    const d = dir.split('\\').join('/');
    expect(guardGlobs(g).sort()).toEqual(
      [
        `${d}/.env`,
        `${d}/.env/**`,
        `${d}/**/.env`,
        `${d}/**/.env/**`,
        `${d}/config/prod.yml`,
        `${d}/config/prod.yml/**`,
        `${d}/secrets`,
        `${d}/secrets/**`,
        `${d}/**/secrets`,
        `${d}/**/secrets/**`,
      ].sort(),
    );
  });

  it('lists what matches now, leaving out .git and node_modules, within its limits', () => {
    mkdirSync(join(dir, 'sub', 'secrets'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.env'), 'x');
    writeFileSync(join(dir, 'sub', 'a.pem'), 'x');
    writeFileSync(join(dir, 'sub', 'secrets', 'k'), 'x');
    writeFileSync(join(dir, 'node_modules', 'x', 'b.pem'), 'x');
    writeFileSync(join(dir, '.git', 'c.pem'), 'x');
    const g = writeGuard({ protectedPaths: ['.env', '*.pem', 'secrets/'] }, [dir], 'darwin')!;
    expect(guardedNow(g).sort()).toEqual([join(dir, '.env'), join(dir, 'sub', 'a.pem'), join(dir, 'sub', 'secrets')].sort());
    // Worked out once for a guard; a new one looks again, within its limit.
    expect(guardedNow(g)).toBe(guardedNow(g));
    expect(guardedNow(writeGuard({ protectedPaths: ['.env', '*.pem', 'secrets/'] }, [dir], 'darwin')!, 1)).toHaveLength(1);
  });

  it("gives sandbox-runtime's globs: the folder's own wildcards as sets of one, `**` in a name as `*`, no negated set, none too long", () => {
    const g = { dirs: ['/w/a[1]*?'], patterns: ['.env', 'config/*.yml', 'x**y', '[!a].txt', `${'n'.repeat(950)}`] };
    expect(sandboxGuardGlobs(g)).toEqual([
      '/w/a[[]1][*][?]/.env',
      '/w/a[[]1][*][?]/.env/**',
      '/w/a[[]1][*][?]/**/.env',
      '/w/a[[]1][*][?]/**/.env/**',
      '/w/a[[]1][*][?]/config/*.yml',
      '/w/a[[]1][*][?]/config/*.yml/**',
      '/w/a[[]1][*][?]/x*y',
      '/w/a[[]1][*][?]/x*y/**',
      '/w/a[[]1][*][?]/**/x*y',
      '/w/a[[]1][*][?]/**/x*y/**',
    ]);
  });

  it('is none on native Windows, and names a folder reached through a link both ways', () => {
    expect(writeGuard({ protectedPaths: ['.env'] }, [dir], 'win32')).toBeUndefined();
    if (process.platform === 'win32') return;
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    expect(writeGuard({ protectedPaths: ['.env'] }, [join(dir, 'link')], 'darwin')!.dirs).toEqual([join(dir, 'link'), join(dir, 'real')]);
  });

  it('reads a set a regular expression refuses as text: matched as such, and in no glob', () => {
    const g = writeGuard({ protectedPaths: ['app/[user-id]/route.ts', '.env'] }, [dir], 'darwin')!;
    expect(isGuarded(g, join(dir, 'app', '[user-id]', 'route.ts'))).toBe(true);
    expect(isGuarded(g, join(dir, 'app', 'u', 'route.ts'))).toBe(false);
    expect(guardGlobs(g).some((x) => x.includes('user-id'))).toBe(false);
    expect(sandboxGuardGlobs(g).some((x) => x.includes('user-id'))).toBe(false);
    expect(guardGlobs(g)).toContain(`${dir.split('\\').join('/')}/.env`);
  });

  it.skipIf(process.platform === 'win32')('leaves out a link that leads nowhere, and dependency folders', () => {
    symlinkSync(join(dir, 'missing'), join(dir, '.env'));
    mkdirSync(join(dir, '.venv', 'lib'), { recursive: true });
    writeFileSync(join(dir, '.venv', 'lib', 'k.pem'), 'x');
    writeFileSync(join(dir, 'a.pem'), 'x');
    expect(guardedNow(writeGuard({ protectedPaths: ['.env', '*.pem'] }, [dir], 'darwin')!)).toEqual([join(dir, 'a.pem')]);
  });

  it("counts sandbox-runtime's regex for a glob high, and leaves out a glob whose regex Seatbelt would refuse", () => {
    expect(sandboxRegexLength('/a/**/b')).toBeGreaterThanOrEqual('^/a/(.*/)?b(/.*)?$'.length);
    expect(sandboxRegexLength('/a/*.p?m')).toBeGreaterThanOrEqual('^/a/[^/]*\\.p[^/]m(/.*)?$'.length);
    const heavy = `${'?'.repeat(240)}`;
    expect(sandboxGuardGlobs({ dirs: ['/w'], patterns: [heavy] })).toEqual([]);
  });
});
