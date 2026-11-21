// Only the disposable server in the offline PowerShell installation test loads this hook.
// Replace Microsoft's distribution at the installer's dependency boundary, keeping its
// checksum, extraction, validation and rename code in the real server.
import { register } from 'node:module';
import { isMainThread } from 'node:worker_threads';

if (isMainThread) register(import.meta.url);

export async function resolve(specifier, context, next) {
  const result = await next(specifier, context);
  const from = context.parentURL && new URL(context.parentURL).pathname;
  if (
    from?.endsWith('/src/server/connectors/teams.ts') &&
    new URL(result.url).pathname.endsWith('/src/server/connectors/teamsRuntime.ts')
  ) {
    return { url: new URL('./teams-download.mjs', import.meta.url).href, shortCircuit: true };
  }
  return result;
}
