import { describe, expect, it } from 'vitest';
import { parseEmbedMode } from './embed';

describe('embed mode', () => {
  it('detects embed=1 / embed=true and ignores other values', () => {
    expect(parseEmbedMode('?embed=1')).toBe(true);
    expect(parseEmbedMode('embed=true&window=main')).toBe(true);
    expect(parseEmbedMode('')).toBe(false);
    expect(parseEmbedMode('?embed=0')).toBe(false);
    expect(parseEmbedMode('?window=main')).toBe(false);
  });
});
