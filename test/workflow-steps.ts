import { readFileSync } from 'node:fs';

// The workflows' steps, for the tests that run them: the Release workflow's (test/desktop-update.test.ts,
// test/codespaces-release.test.ts) and the Pages workflow's (test/site-indexnow.test.ts).

const workflow = (file: string): string => readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');

/** The Release workflow, as written. */
export const releaseWorkflow = (): string => workflow('release.yml');

/** The Pages workflow, as written. */
export const pagesWorkflow = (): string => workflow('pages.yml');

/** A step's `run:` script in a workflow, as the runner gets it. */
function stepIn(text: string, name: string): string {
  const from = text.indexOf(`- name: ${name}\n`);
  if (from < 0) throw new Error(`no step ${name}`);
  const run = text.indexOf('run: |\n', from);
  const lines = text.slice(run + 'run: |\n'.length).split('\n');
  const indent = /^ */.exec(lines[0]!)![0].length;
  const body: string[] = [];
  for (const line of lines) {
    if (line.trim() && line.length - line.trimStart().length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

/** A step's `run:` script in the Release workflow. */
export const releaseStep = (name: string): string => stepIn(releaseWorkflow(), name);

/** A step's `run:` script in the Pages workflow. */
export const pagesStep = (name: string): string => stepIn(pagesWorkflow(), name);
