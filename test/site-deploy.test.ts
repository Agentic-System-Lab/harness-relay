import { describe, expect, it } from 'vitest';
import { jobsIn, pagesStep, pagesWorkflow, stepsOf } from './workflow-steps';

// How the Pages workflow deploys the landing page (docs/developer-guide.md, "Website"): the site built and uploaded in
// one job, deployed in another, so that a deployment that failed runs again on its own with the site already
// uploaded; and a first try that fails tried again a minute later, since GitHub may list the upload only a while
// after it is made.

const workflow = pagesWorkflow();
const jobs = jobsIn(workflow);
/** The action a step uses, if it uses one: a key of the step's own, at its start or under it. */
const uses = (step: string) => /^(?: {8})?uses: (\S+)@/m.exec(step)?.[1];

describe('the Pages workflow', () => {
  it('builds the site in one job and deploys it in another, after it, in the github-pages environment', () => {
    expect([...jobs.keys()]).toEqual(['build', 'deploy']);
    const build = stepsOf(jobs.get('build')!).map(uses).filter(Boolean);
    const deploy = stepsOf(jobs.get('deploy')!).map(uses).filter(Boolean);
    expect(build).toEqual(['actions/checkout', 'actions/configure-pages', 'actions/upload-pages-artifact']);
    expect(deploy).toEqual(['actions/deploy-pages', 'actions/deploy-pages']);
    // The site uploaded once in a run: run again, the deploy job alone finds the one artifact deploy-pages takes.
    expect(workflow.match(/uses: actions\/upload-pages-artifact@/g)).toHaveLength(1);
    expect(workflow).not.toMatch(/uses: actions\/upload-artifact@/);
    expect(jobs.get('build')).not.toMatch(/\n {4}environment:/);
    expect(jobs.get('deploy')).toContain('\n    needs: build\n');
    expect(jobs.get('deploy')).toContain('\n    environment:\n      name: github-pages\n');
  });

  it('tries the deployment again a minute later when the first try fails, and fails only when that one does', () => {
    const [first, wait, again, ...rest] = stepsOf(jobs.get('deploy')!);
    expect(first).toMatch(/^id: deployment\n {8}uses: actions\/deploy-pages@\S+\n {8}continue-on-error: true\n/);
    expect(wait).toMatch(/^name: Wait to deploy again\n {8}if: steps\.deployment\.outcome == 'failure'\n {8}run: \|\n/);
    expect(pagesStep('Wait to deploy again')).toMatch(/^echo "::warning::.+"\nsleep 60\n/);
    expect(again).toMatch(/^id: deployment-again\n {8}if: steps\.deployment\.outcome == 'failure'\n {8}uses: actions\/deploy-pages@\S+\n/);
    // The second try may not fail quietly, and nothing else in the workflow does.
    expect(again).not.toContain('continue-on-error');
    expect(workflow.match(/continue-on-error:/g)).toHaveLength(1);
    // Both tries take the same version, and nothing of its own.
    expect(/uses: (\S+)/.exec(first!)?.[1]).toBe(/uses: (\S+)/.exec(again!)?.[1]);
    expect(first).not.toMatch(/\n {8}with:/);
    expect(again).not.toMatch(/\n {8}with:/);
    // The environment's address is the page's from whichever try deployed it.
    expect(jobs.get('deploy')).toContain(
      '\n      url: ${{ steps.deployment.outputs.page_url || steps.deployment-again.outputs.page_url }}\n',
    );
    // IndexNow is told after the deployment, by the step after the tries.
    expect(rest.map((step) => /^name: (.+)\n/.exec(step)?.[1])).toEqual(['Tell IndexNow which pages changed']);
  });

  it('gives each job a time limit', () => {
    for (const [id, job] of jobs) expect(job, id).toMatch(/\n {4}timeout-minutes: \d+\n/);
  });
});
