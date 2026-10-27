import { createTransliterator } from '../core/transliterate';
import { russianPack } from '../core/russian';

const convert = createTransliterator(russianPack);
type Snapshot = { value: string; start: number; end: number };
export class Editor {
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private pending: { start: number; end: number; raw: string } | null = null;
  private composing = false;
  enabled = true;
  constructor(readonly field: HTMLTextAreaElement) {
    field.addEventListener('compositionstart', () => { this.composing = true; this.pending = null; this.remember(); });
    field.addEventListener('compositionend', () => { this.composing = false; this.pending = null; });
    field.addEventListener('beforeinput', event => this.beforeInput(event));
    field.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'z') {
        event.preventDefault(); this.history(event.shiftKey ? 'redo' : 'undo');
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); this.history('redo'); }
    });
    field.addEventListener('paste', () => { this.pending = null; });
  }
  private snapshot(): Snapshot { return { value: this.field.value, start: this.field.selectionStart, end: this.field.selectionEnd }; }
  private remember(): void { this.undoStack.push(this.snapshot()); if (this.undoStack.length > 500) this.undoStack.shift(); this.redoStack = []; }
  private history(direction: 'undo' | 'redo'): void {
    const from = direction === 'undo' ? this.undoStack : this.redoStack;
    const to = direction === 'undo' ? this.redoStack : this.undoStack;
    const next = from.pop(); if (!next) return;
    to.push(this.snapshot()); this.field.value = next.value; this.field.setSelectionRange(next.start, next.end);
    this.pending = null; this.field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  private beforeInput(event: InputEvent): void {
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') { event.preventDefault(); this.history(event.inputType === 'historyUndo' ? 'undo' : 'redo'); return; }
    if (this.composing || event.isComposing || event.inputType.includes('Composition')) return;
    const { selectionStart: start, selectionEnd: end } = this.field;
    this.remember();
    if (this.enabled && event.inputType === 'insertText' && event.data && /^[A-Za-z'#+]$/.test(event.data) && event.cancelable) {
      event.preventDefault();
      const active = start === end && this.pending && this.pending.end === start ? this.pending : null;
      const raw = (active?.raw ?? '') + event.data;
      const begin = active?.start ?? start;
      const translated = convert(raw);
      this.field.setRangeText(translated, begin, end, 'end');
      this.pending = { start: begin, end: begin + translated.length, raw };
      this.field.dispatchEvent(new Event('input', { bubbles: true }));
    } else this.pending = null;
  }
  setEnabled(value: boolean): void { this.enabled = value; this.pending = null; }
  clear(): void { if (!this.field.value) return; this.remember(); this.field.value = ''; this.pending = null; this.field.dispatchEvent(new Event('input', { bubbles: true })); }
}
