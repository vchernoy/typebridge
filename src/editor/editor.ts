import { createTransliterator } from '../core/transliterate';
import { russianPack } from '../core/russian';

const convert = createTransliterator(russianPack);
type Snapshot = { value: string; start: number; end: number };
export class Editor {
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private pending: { start: number; end: number; raw: string } | null = null;
  private composing = false;
  private compositionStart: Snapshot | null = null;
  private before: Snapshot | null = null;
  private nativeHistory = false;
  private known: Snapshot;
  enabled = true;
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  private notifyHistory(): void { this.field.dispatchEvent(new Event('historychange')); }
  undo(): void { this.history('undo'); }
  redo(): void { this.history('redo'); }
  constructor(readonly field: HTMLTextAreaElement) {
    this.known = this.snapshot();
    field.addEventListener('compositionstart', () => { this.composing = true; this.pending = null; this.compositionStart = this.snapshot(); });
    field.addEventListener('compositionend', () => {
      this.composing = false; this.pending = null;
      if (this.compositionStart && this.compositionStart.value !== this.field.value) this.record(this.compositionStart);
      this.compositionStart = null; this.before = null; this.known = this.snapshot();
    });
    field.addEventListener('beforeinput', event => this.beforeInput(event));
    field.addEventListener('input', event => this.onInput(event));
    field.addEventListener('keydown', event => {
      if (this.composing || event.isComposing) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'z') {
        event.preventDefault(); this.history(event.shiftKey ? 'redo' : 'undo');
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); this.history('redo'); }
    });
    field.addEventListener('paste', () => { this.pending = null; });
    field.addEventListener('cut', () => { this.pending = null; });
  }
  private snapshot(): Snapshot { return { value: this.field.value, start: this.field.selectionStart, end: this.field.selectionEnd }; }
  private record(snapshot: Snapshot): void { this.undoStack.push(snapshot); if (this.undoStack.length > 500) this.undoStack.shift(); this.redoStack = []; this.notifyHistory(); }
  private history(direction: 'undo' | 'redo'): void {
    this.nativeHistory = false;
    if (this.known.value !== this.field.value) { this.undoStack = []; this.redoStack = []; this.known = this.snapshot(); this.notifyHistory(); return; }
    const from = direction === 'undo' ? this.undoStack : this.redoStack;
    const to = direction === 'undo' ? this.redoStack : this.undoStack;
    const next = from.pop(); if (!next) return;
    to.push(this.snapshot()); this.field.value = next.value; this.field.setSelectionRange(next.start, next.end);
    this.pending = null; this.before = null; this.known = this.snapshot(); this.notifyHistory(); this.field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  private onInput(event: Event): void {
    if (this.composing || (event instanceof InputEvent && event.isComposing)) return;
    const current = this.snapshot();
    if (this.nativeHistory) { this.undoStack = []; this.redoStack = []; this.pending = null; }
    else if (current.value !== this.known.value) this.record(this.before ?? this.known);
    this.nativeHistory = false; this.before = null; this.known = current; this.notifyHistory();
  }
  private beforeInput(event: InputEvent): void {
    if (this.composing || event.isComposing || event.inputType.includes('Composition')) return;
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      if (event.cancelable) { event.preventDefault(); this.history(event.inputType === 'historyUndo' ? 'undo' : 'redo'); }
      else { this.nativeHistory = true; this.before = null; }
      return;
    }
    this.nativeHistory = false;
    if (this.known.value !== this.field.value) { this.undoStack = []; this.redoStack = []; this.known = this.snapshot(); this.notifyHistory(); }
    this.before = this.snapshot();
    const { selectionStart: start, selectionEnd: end } = this.field;
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
  clear(): void { if (!this.field.value) return; this.before = this.snapshot(); this.field.value = ''; this.pending = null; this.field.dispatchEvent(new Event('input', { bubbles: true })); }
}
