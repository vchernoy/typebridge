import { describe, expect, it } from 'vitest';
import { createPreferenceWarning, preferenceWarningText } from './preference-warning';

describe('preferenceWarningText', () => {
  it('is empty when every preference saved', () => {
    expect(preferenceWarningText([])).toBe('');
  });
  it('names one or several failed preferences', () => {
    expect(preferenceWarningText(['appearance'])).toBe('Could not save the appearance setting; it may reset on reload.');
    expect(preferenceWarningText(['appearance', 'Autosave'])).toBe('Could not save the appearance and Autosave settings; they may reset on reload.');
  });
});

describe('createPreferenceWarning', () => {
  it('keeps a failure until that preference saves', () => {
    const element = { textContent: '', hidden: true } as unknown as HTMLElement;
    const preferenceSaved = createPreferenceWarning(element);
    preferenceSaved('appearance', false);
    preferenceSaved('Autosave', false);
    expect(element.hidden).toBe(false);
    preferenceSaved('Autosave', true);
    expect(element.textContent).toBe('Could not save the appearance setting; it may reset on reload.');
    preferenceSaved('appearance', true);
    expect(element.textContent).toBe('');
    expect(element.hidden).toBe(true);
  });
});
