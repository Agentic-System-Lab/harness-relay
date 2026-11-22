/**
 * A Postgres address for a test, its made-up password put in as the test runs. Written out in the source
 * (`postgresql://todo:pw@ep-1.neon.tech/…`), GitHub's secret scanning reports it as a leaked connection string.
 */
export const pgUri = (password: string, host: string, path = '/todo?sslmode=require'): string =>
  `postgresql://todo:${password}@${host}${path}`;
