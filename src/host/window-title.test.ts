import { describe, expect, it } from 'vitest';
import { displayTitle, moveHandleLabel } from './window-title';

describe('displayTitle', () => {
  it('shows the trimmed title, or Untitled document when blank', () => {
    expect(displayTitle('  Письмо ')).toBe('Письмо');
    expect(displayTitle('   ')).toBe('Untitled document');
    expect(displayTitle('')).toBe('Untitled document');
  });
});

describe('moveHandleLabel', () => {
  it('describes moving and resizing for the layout', () => {
    expect(moveHandleLabel('w1', 'Письмо', 'free')).toBe('Move window w1: Письмо (arrow keys; Ctrl/⌘+Shift+arrows to resize)');
    expect(moveHandleLabel('w1', 'Письмо', 'stacked')).toBe('Move window w1: Письмо (Ctrl/⌘+Shift+Up/Down to resize height)');
  });
});
