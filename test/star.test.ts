import { describe, expect, it } from 'vitest';
import { REPO as SITE_REPO } from '../site/assets/downloads.js';
import { REPO, REPO_URL } from '../src/web/star';

describe('the star dialog’s repository', () => {
  it('is the one the landing page downloads from, on github.com', () => {
    expect(REPO).toBe(SITE_REPO);
    expect(REPO_URL).toBe(`https://github.com/${SITE_REPO}`);
  });
});
