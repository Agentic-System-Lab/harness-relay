// What the server and the page share of a CLI's pass-through list (Settings → its card → Environment
// variables; the rest is in src/server/agentEnv.ts).

/** A variable's name as the pass-through list takes it: a letter or `_`, then letters, digits and `_`. */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** The most names a CLI's pass-through list holds. */
export const MAX_PASS_ENV = 32;
