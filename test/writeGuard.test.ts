import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { guardGlobs, guardedNow, isGuarded, sandboxGuardGlobs, writeGuard } from '../src/server/writeGuard';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-guard-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('write guard', () => {
  it('is made only when the list protects something', () => {
    expect(writeGuard(undefined, [dir])).toBeUndefined();
    expect(writeGuard({ commitPattern: '^x' }, [dir])).toBeUndefined();
    expect(writeGuard({ protectedPaths: ['../out'] }, [dir])).toBeUndefined();
    expect(writeGuard({ protectedPaths: ['.env'] }, [])).toBeUndefined();
    expect(writeGuard({ protectedPaths: ['.env', './.env', 'a\\b'] }, [dir, dir])).toEqual({ dirs: [dir], patterns: ['.env', 'a/b'] });
  });

  it('tells a protected path in any working directory, also one not made yet and one reached through a link', () => {
    const other = join(dir, 'other');
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    mkdirSync(other);
    const g = writeGuard({ protectedPaths: ['.env', '*.pem', 'config/prod.yml', 'secrets/'] }, [join(dir, 'a'), other])!;
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
    const g = writeGuard({ protectedPaths: ['.env', 'config/prod.yml', 'secrets/'] }, [dir])!;
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
    const g = writeGuard({ protectedPaths: ['.env', '*.pem', 'secrets/'] }, [dir])!;
    expect(guardedNow(g).sort()).toEqual([join(dir, '.env'), join(dir, 'sub', 'a.pem'), join(dir, 'sub', 'secrets')].sort());
    expect(guardedNow(g, 1)).toHaveLength(1);
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
});
