import { describe, expect, it } from 'vitest';
import config from '../vite.config';

describe('deployment configuration', () => {
  it('uses the site root (custom domain) for assets', () => {
    expect(config.base).toBe('/');
  });
});
