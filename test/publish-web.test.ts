import { describe, expect, it } from 'vitest';
import type { PublishPlan } from '../src/shared/types';
import {
  canPublish,
  configurable,
  databaseLines,
  databaseTicked,
  initialRows,
  publishRequest,
  renamable,
  rowsValid,
  stillPublishing,
} from '../src/web/publish';

const plan = (over: Partial<PublishPlan> = {}): PublishPlan => ({
  kind: 'compose',
  serviceType: 'web_service',
  name: 'todo-app',
  folder: '/x/todo-app',
  env: [
    { key: 'DATABASE_URL', value: '', source: 'database' },
    { key: 'PORT', value: '3000', source: 'compose' },
  ],
  databases: [{ service: 'db', database: 'todo', role: 'todo', pgVersion: 16, initScripts: ['db/init.sql'], skippedScripts: ['db/x.sh'] }],
  databaseOptional: false,
  commands: { dockerfile: 'Dockerfile' },
  missing: [],
  neonReady: true,
  github: { login: 'me' },
  region: 'oregon',
  ...over,
});

describe("the publish dialog's logic", () => {
  it("starts with the plan's variables, Neon's by name only, and sends only those the user can set", () => {
    const rows = initialRows(plan());
    expect(rows).toEqual([
      { key: 'DATABASE_URL', value: '', source: 'database' },
      { key: 'PORT', value: '3000', source: 'compose' },
    ]);
    const edited = [
      ...rows.map((r) => (r.key === 'PORT' ? { ...r, value: '8080' } : r)),
      { key: 'API_KEY', value: 'k', source: 'user' as const },
    ];
    expect(publishRequest(plan(), 'todo-app', edited, false)).toEqual({
      name: 'todo-app',
      env: [
        { key: 'PORT', value: '8080' },
        { key: 'API_KEY', value: 'k' },
      ],
      public: true,
    });
  });

  it('sends an update with neither name nor variables (Render keeps its own); a failed first try its variables, and its name until its repository exists', () => {
    const live = plan({
      existing: { id: 'a', serviceId: 'srv-1', repoUrl: 'https://github.com/me/x', databases: [] } as unknown as PublishPlan['existing'],
    });
    expect(publishRequest(live, 'other', initialRows(live), true)).toEqual({ public: true });
    const noService = plan({
      databaseOptional: true,
      env: [],
      databases: [],
      existing: {
        id: 'a',
        repoUrl: 'https://github.com/me/api',
        databases: [{ service: 'DATABASE_URL' }],
      } as unknown as PublishPlan['existing'],
    });
    expect(databaseTicked(noService)).toBe(true);
    expect([renamable(noService), configurable(noService)]).toEqual([false, true]);
    expect(publishRequest(noService, 'api', [{ key: 'API_KEY', value: 'y', source: 'user' }], true)).toEqual({
      env: [{ key: 'API_KEY', value: 'y' }],
      database: true,
      public: true,
    });
    const noRepo = plan({ existing: { id: 'a', repoUrl: '', databases: [] } as unknown as PublishPlan['existing'] });
    expect(renamable(noRepo)).toBe(true);
    expect(publishRequest(noRepo, 'renamed', [], false)).toMatchObject({ name: 'renamed', env: [] });
    expect(databaseTicked(plan())).toBe(false);
    expect(publishRequest(plan({ databaseOptional: true, env: [], databases: [] }), 'api', [], true)).toEqual({
      name: 'api',
      env: [],
      database: true,
      public: true,
    });
  });

  it('publishes only once Settings has what it needs, gh is signed in, the name and variables are valid and it was confirmed', () => {
    const rows = initialRows(plan());
    expect(canPublish(plan(), 'todo-app', rows, false, true)).toBe(true);
    expect(canPublish(plan(), 'todo-app', rows, false, false)).toBe(false);
    expect(canPublish(plan({ missing: ['neon'] }), 'todo-app', rows, false, true)).toBe(false);
    expect(canPublish(plan({ github: { problem: 'gh-signed-out' } }), 'todo-app', rows, false, true)).toBe(false);
    expect(canPublish(plan(), 'Todo App', rows, false, true)).toBe(false);
    expect(canPublish(plan(), 'todo-app', [...rows, { key: 'PORT', value: '', source: 'user' }], false, true)).toBe(false);
    expect(canPublish(plan({ databaseOptional: true, neonReady: false }), 'api', [], true, true)).toBe(false);
    expect(canPublish(plan({ databaseOptional: true, neonReady: false }), 'api', [], false, true)).toBe(true);
    // A publish of this folder still under way: its steps are shown, not a second publish.
    expect(
      canPublish(
        plan({ existing: { state: 'publishing', databases: [] } as unknown as PublishPlan['existing'] }),
        'todo-app',
        rows,
        false,
        true,
      ),
    ).toBe(false);
  });

  it('checks variable names as Render takes them', () => {
    expect(rowsValid([{ key: 'A_1', value: '', source: 'user' }])).toBe(true);
    expect(rowsValid([{ key: '', value: '', source: 'user' }])).toBe(false);
    expect(rowsValid([{ key: '9A', value: '', source: 'user' }])).toBe(false);
    expect(rowsValid(Array.from({ length: 101 }, (_, i) => ({ key: 'K' + i, value: '', source: 'user' as const })))).toBe(false);
  });

  it('says what each database is, and goes on polling only while it publishes', () => {
    expect(databaseLines(plan())).toEqual([{ service: 'db', database: 'todo', version: 16, init: 'db/init.sql', skipped: 'db/x.sh' }]);
    expect(stillPublishing(undefined)).toBe(false);
    expect(stillPublishing({ state: 'publishing' } as never)).toBe(true);
    expect(stillPublishing({ state: 'live' } as never)).toBe(false);
  });
});
