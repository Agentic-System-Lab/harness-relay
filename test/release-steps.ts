import { readFileSync } from 'node:fs';

// The Release workflow's steps, for the tests that run them (test/desktop-update.test.ts,
// test/codespaces-release.test.ts).

/** The Release workflow, as written. */
export const releaseWorkflow = (): string => readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

/** A step's `run:` script in the Release workflow, as the runner gets it. */
export function releaseStep(name: string): string {
  const workflow = releaseWorkflow();
  const from = workflow.indexOf(`- name: ${name}\n`);
  if (from < 0) throw new Error(`no step ${name}`);
  const run = workflow.indexOf('run: |\n', from);
  const lines = workflow.slice(run + 'run: |\n'.length).split('\n');
  const indent = /^ */.exec(lines[0]!)![0].length;
  const body: string[] = [];
  for (const line of lines) {
    if (line.trim() && line.length - line.trimStart().length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}
