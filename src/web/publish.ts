import type { PublishedApp, PublishEnvVar, PublishPlan, PublishRequest } from '../shared/types';

/** A row of the dialog's variables: one the compose file sets (its value editable), or one the user added. */
export interface EnvRow {
  key: string;
  value: string;
  source: PublishEnvVar['source'];
}

/** An app's name on GitHub and Render, as the server takes it (`APP_NAME` in `publish/plan.ts`). */
export const APP_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const MAX_ENV = 100;

/** The rows the dialog starts with: the plan's variables, Neon's shown by name only. */
export function initialRows(plan: PublishPlan): EnvRow[] {
  return plan.env.map((e) => ({ key: e.key, value: e.source === 'database' ? '' : e.value, source: e.source }));
}

/** Whether the rows can be sent: every name valid and used once. */
export function rowsValid(rows: EnvRow[]): boolean {
  const seen = new Set<string>();
  for (const r of rows) {
    if (!ENV_KEY.test(r.key) || seen.has(r.key)) return false;
    seen.add(r.key);
  }
  return rows.length <= MAX_ENV;
}

/** The publish request the dialog sends: the variables the user can set (never Neon's), the name of a new app. */
export function publishRequest(plan: PublishPlan, name: string, rows: EnvRow[], database: boolean): PublishRequest {
  const env = rows.filter((r) => r.source !== 'database').map(({ key, value }) => ({ key, value }));
  return {
    ...(plan.existing ? {} : { name }),
    ...(plan.existing ? {} : { env }),
    ...(plan.databaseOptional && !plan.existing ? { database } : {}),
    public: true,
  };
}

/** Whether the dialog can publish: Settings has what it needs, GitHub is signed in, the name and rows are valid, it was confirmed. */
export function canPublish(plan: PublishPlan, name: string, rows: EnvRow[], database: boolean, confirmed: boolean): boolean {
  if (plan.missing.length || plan.github.problem || !confirmed) return false;
  if (database && plan.databaseOptional && !plan.existing && !plan.neonReady) return false;
  if (!plan.existing && !APP_NAME.test(name)) return false;
  return plan.existing ? true : rowsValid(rows);
}

/** Whether the panel goes on asking how the publish goes. */
export function stillPublishing(app: PublishedApp | undefined): boolean {
  return app?.state === 'publishing';
}

/** The Neon names a database plan shows: the compose service's database and the files that run on it. */
export function databaseLines(plan: PublishPlan) {
  return plan.databases.map((d) => ({
    service: d.service,
    database: d.database,
    version: d.pgVersion,
    init: d.initScripts.join(', '),
    skipped: d.skippedScripts.join(', '),
  }));
}
