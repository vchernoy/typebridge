import { describe, expect, it } from 'vitest';
import { Editor } from './editor';

/** Minimal input stand-in — unit tests stay node-only (no happy-dom). */
function makeField(initial = ''): HTMLInputElement {
  const listeners = new Map<string, Set<EventListener>>();
  let value = initial;
  let selectionStart = initial.length;
  let selectionEnd = initial.length;
  const field = {
    get value() { return value; },
    set value(next: string) { value = next; },
    get selectionStart() { return selectionStart; },
    get selectionEnd() { return selectionEnd; },
    selectionDirection: 'none' as const,
    readOnly: false,
    addEventListener(type: string, listener: EventListener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },
    setSelectionRange(start: number, end: number) {
      selectionStart = start;
      selectionEnd = end;
    },
    focus() { /* no-op */ },
    dispatchEvent(event: Event) {
      for (const listener of listeners.get(event.type) ?? []) {
        (listener as EventListener).call(field, event);
      }
      return true;
    },
  };
  return field as unknown as HTMLInputElement;
}

describe('Editor.syncFromField IME (#264 P0)', () => {
  it('invalidates composition so compositionend after restore cannot rebuild private history', () => {
    const field = makeField('SECRET');
    const editor = new Editor(field);
    field.dispatchEvent(new Event('compositionstart'));
    expect(editor.composing).toBe(true);

    // Privacy/document restore replaces the composing private query with the public value.
    field.value = 'public';
    field.setSelectionRange(6, 6);
    editor.syncFromField();
    expect(editor.composing).toBe(false);

    field.dispatchEvent(new Event('compositionend'));
    const history = editor.exportHistory();
    expect(history.undo).toEqual([]);
    expect(history.redo).toEqual([]);
    expect(history.current).toBe('public');
    expect(JSON.stringify(history)).not.toContain('SECRET');
  });

  it('clears undo stacks together with the composition snapshot', () => {
    const field = makeField('public');
    const editor = new Editor(field);
    field.dispatchEvent(new Event('compositionstart'));
    field.value = 'SECRET';
    field.setSelectionRange(6, 6);
    // External restore while composing.
    field.value = 'public';
    editor.syncFromField();
    field.dispatchEvent(new Event('compositionend'));
    // A later Undo must not reintroduce the private query (stack stays empty).
    expect(editor.canUndo).toBe(false);
    expect(editor.exportHistory().undo).toEqual([]);
  });
});
