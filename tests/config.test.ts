import { describe, expect, it } from 'vitest';
import config from '../vite.config';

describe('deployment configuration', () => {
  it('uses the GitHub Pages project path for assets', () => {
    expect(config.base).toBe('/typebridge/');
  });
});
