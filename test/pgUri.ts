/**
 * A Postgres address for a test, its made-up password put in as the test runs. Written out whole in the
 * source (even in a comment), GitHub's secret scanning reports it as a leaked connection string.
 */
export const pgUri = (password: string, host: string, path = '/todo?sslmode=require'): string =>
  `postgresql://todo:${password}@${host}${path}`;
