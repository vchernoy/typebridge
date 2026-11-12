import { describe, expect, it } from 'vitest';
import { sharePreview } from './share-dialog';

describe('sharePreview', () => {
  it('shows short text whole, without trailing blank lines', () => {
    expect(sharePreview('Привет\nмир\n\n')).toBe('Привет\nмир');
    expect(sharePreview('')).toBe('');
  });
  it('cuts long text at a word boundary with an ellipsis', () => {
    const preview = sharePreview('слово '.repeat(100));
    expect(preview.endsWith('слово…')).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(281);
  });
});
