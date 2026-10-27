import { createTransliterator } from '../core/transliterate';
import { russianPack } from '../core/russian';

const convert = createTransliterator(russianPack);
type Selection = [start: number, end: number, direction: 'forward' | 'backward' | 'none'];
export type Snapshot = { value: string; start: number; end: number };
type Delta = [position: number, deleted: string, inserted: string, before: Selection, after: Selection];
type StoredHistory = { v: 1; undo: Delta[]; redo: Delta[]; current: string };
type LegacyHistory = { undo: Snapshot[]; redo: Snapshot[]; current: string };
export type EditorHistory = StoredHistory | LegacyHistory;
const LIMIT = 500;
const GROUP_MS = 800;

function selectionValid(s: unknown, length: number): s is Selection {
  return Array.isArray(s) && s.length === 3 &&
    Number.isInteger(s[0]) && Number.isInteger(s[1]) &&
    s[0] >= 0 && s[1] >= s[0] && s[1] <= length &&
    ['forward', 'backward', 'none'].includes(s[2]);
}
function deltaValid(d: unknown): d is Delta {
  return Array.isArray(d) && d.length === 5 && Number.isInteger(d[0]) && d[0] >= 0 &&
    typeof d[1] === 'string' && typeof d[2] === 'string' &&
    selectionValid(d[3], Number.MAX_SAFE_INTEGER) && selectionValid(d[4], Number.MAX_SAFE_INTEGER);
}
function diff(before: string, after: string, b: Selection, a: Selection): Delta {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let suffix = 0;
  while (suffix < before.length - p && suffix < after.length - p &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return [p, before.slice(p, before.length - suffix), after.slice(p, after.length - suffix), b, a];
}
function apply(text: string, d: Delta, reverse: boolean): string | null {
  const [p, deleted, inserted] = d;
  const from = reverse ? inserted : deleted;
  const to = reverse ? deleted : inserted;
  if (text.slice(p, p + from.length) !== from || p > text.length) return null;
  return text.slice(0, p) + to + text.slice(p + from.length);
}
function validateChain(text: string, stack: Delta[], reverse: boolean): boolean {
  let value = text;
  for (let i = stack.length - 1; i >= 0; i--) {
    const next = apply(value, stack[i], reverse);
    if (next === null) return false;
    value = next;
  }
  return true;
}
function legacyValid(s: unknown): s is Snapshot {
  if (!s || typeof s !== 'object') return false;
  const x = s as Snapshot;
  return typeof x.value === 'string' && Number.isInteger(x.start) && Number.isInteger(x.end) &&
    x.start >= 0 && x.end >= x.start && x.end <= x.value.length;
}
function migrate(stack: Snapshot[], current: Snapshot, undo: boolean): Delta[] {
  const states = undo ? [...stack, current] : [current, ...stack.slice().reverse()];
  const result: Delta[] = [];
  for (let i = 0; i < states.length - 1; i++) {
    const b = states[i], a = states[i + 1];
    result.push(diff(b.value, a.value, [b.start, b.end, 'none'], [a.start, a.end, 'none']));
  }
  return undo ? result : result.reverse();
}

export class Editor {
  private undoStack: Delta[] = [];
  private redoStack: Delta[] = [];
  private pending: { start: number; end: number; raw: string } | null = null;
  private composing = false;
  private compositionStart: { value: string; selection: Selection } | null = null;
  private before: { value: string; selection: Selection } | null = null;
  private nativeHistory = false;
  private known: { value: string; selection: Selection };
  private lastEditAt = 0;
  enabled = true;
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  exportHistory(): EditorHistory {
    return { v: 1, undo: this.undoStack.map(d => [d[0], d[1], d[2], [...d[3]], [...d[4]]] as Delta),
      redo: this.redoStack.map(d => [d[0], d[1], d[2], [...d[3]], [...d[4]]] as Delta), current: this.field.value };
  }
  restoreHistory(history?: EditorHistory): void {
    this.undoStack = []; this.redoStack = [];
    if (history && history.current === this.field.value &&
      Array.isArray(history.undo) && Array.isArray(history.redo) &&
      history.undo.length <= LIMIT && history.redo.length <= LIMIT) {
      if ('v' in history && history.v === 1 &&
        history.undo.every(deltaValid) && history.redo.every(deltaValid) &&
        validateChain(this.field.value, history.undo, true) &&
        validateChain(this.field.value, history.redo, false)) {
        this.undoStack = history.undo.map(d => [d[0], d[1], d[2], [...d[3]], [...d[4]]] as Delta);
        this.redoStack = history.redo.map(d => [d[0], d[1], d[2], [...d[3]], [...d[4]]] as Delta);
      } else if (!('v' in history) && history.undo.every(legacyValid) && history.redo.every(legacyValid)) {
        const current = this.capture();
        const s: Snapshot = { value: current.value, start: current.selection[0], end: current.selection[1] };
        const undo = migrate(history.undo, s, true), redo = migrate(history.redo, s, false);
        if (validateChain(current.value, undo, true) && validateChain(current.value, redo, false)) {
          this.undoStack = undo; this.redoStack = redo;
        }
      }
    }
    this.pending = null; this.before = null; this.known = this.capture();
    this.lastEditAt = 0; this.notifyHistory();
  }
  private notifyHistory(): void { this.field.dispatchEvent(new Event('historychange')); }
  undo(): void { this.history('undo'); }
  redo(): void { this.history('redo'); }
  constructor(readonly field: HTMLTextAreaElement) {
    this.known = this.capture();
    field.addEventListener('compositionstart', () => {
      this.composing = true; this.pending = null; this.compositionStart = this.capture();
    });
    field.addEventListener('compositionend', () => {
      this.composing = false; this.pending = null;
      if (this.compositionStart && this.compositionStart.value !== this.field.value)
        this.record(this.compositionStart, this.capture(), false);
      this.compositionStart = null; this.before = null; this.known = this.capture();
    });
    field.addEventListener('beforeinput', event => this.beforeInput(event));
    field.addEventListener('input', event => this.onInput(event));
    field.addEventListener('keydown', event => {
      if (this.composing || event.isComposing) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'z') {
        event.preventDefault(); this.history(event.shiftKey ? 'redo' : 'undo');
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'y') {
        event.preventDefault(); this.history('redo');
      }
    });
    field.addEventListener('paste', () => { this.pending = null; });
    field.addEventListener('cut', () => { this.pending = null; });
  }
  private capture(): { value: string; selection: Selection } {
    return { value: this.field.value, selection: [this.field.selectionStart, this.field.selectionEnd, this.field.selectionDirection] };
  }
  private record(b: { value: string; selection: Selection }, a: { value: string; selection: Selection }, group: boolean): void {
    if (b.value === a.value) return;
    const d = diff(b.value, a.value, b.selection, a.selection);
    const last = this.undoStack[this.undoStack.length - 1];
    const now = Date.now();
    // Merge only contiguous, collapsed-caret insertions, never pastes, replacements or deletions.
    if (group && last && !this.redoStack.length && now - this.lastEditAt < GROUP_MS &&
      !last[1] && !d[1] && last[0] + last[2].length === d[0] &&
      last[4][0] === d[3][0] && last[4][1] === d[3][1] &&
      d[3][0] === d[3][1] && d[4][0] === d[4][1]) {
      last[2] += d[2]; last[4] = d[4];
    } else {
      this.undoStack.push(d);
      if (this.undoStack.length > LIMIT) this.undoStack.shift();
    }
    this.lastEditAt = group ? now : 0;
    this.redoStack = []; this.notifyHistory();
  }
  private history(direction: 'undo' | 'redo'): void {
    this.nativeHistory = false; this.lastEditAt = 0;
    if (this.known.value !== this.field.value) {
      this.undoStack = []; this.redoStack = []; this.known = this.capture(); this.notifyHistory(); return;
    }
    const from = direction === 'undo' ? this.undoStack : this.redoStack;
    const to = direction === 'undo' ? this.redoStack : this.undoStack;
    const d = from[from.length - 1];
    if (!d) return;
    const next = apply(this.field.value, d, direction === 'undo');
    if (next === null) { this.undoStack = []; this.redoStack = []; this.notifyHistory(); return; }
    from.pop(); to.push(d);
    this.field.value = next;
    const selection = direction === 'undo' ? d[3] : d[4];
    this.field.focus({ preventScroll: true });
    this.field.setSelectionRange(selection[0], selection[1], selection[2]);
    this.revealEdit(d[0], direction === 'undo' ? d[1].length : d[2].length);
    this.pending = null; this.before = null; this.known = this.capture();
    this.notifyHistory(); this.field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  private revealEdit(position: number, length: number): void {
    // A textarea's selection may be far from the actual edit; use a temporary
    // caret at the edit to ask the browser to scroll there, then restore selection.
    const { selectionStart: start, selectionEnd: end, selectionDirection: direction } = this.field;
    const p = Math.min(position + Math.min(length, 1), this.field.value.length);
    this.field.setSelectionRange(p, p);
    this.field.setSelectionRange(start, end, direction);
    // Also reveal the editor element itself if the page is scrolled away.
    const rect = this.field.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) this.field.scrollIntoView({ block: 'nearest' });
  }
  private onInput(event: Event): void {
    if (this.composing || (event instanceof InputEvent && event.isComposing)) return;
    const current = this.capture();
    if (this.nativeHistory) { this.undoStack = []; this.redoStack = []; this.pending = null; }
    else if (current.value !== this.known.value) {
      const b = this.before ?? this.known;
      const inputType = event instanceof InputEvent ? event.inputType : '';
      // Transliteration changes earlier letters (e.g. sh -> ш); preserve its per-key undo semantics.
      const group = !this.enabled && inputType === 'insertText' && !!this.before &&
        this.before.selection[0] === this.before.selection[1];
      this.record(b, current, group);
    }
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
    if (this.known.value !== this.field.value) {
      this.undoStack = []; this.redoStack = []; this.known = this.capture(); this.notifyHistory();
    }
    this.before = this.capture();
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
  load(value: string): void {
    this.field.value = value; this.field.setSelectionRange(0, 0);
    this.undoStack = []; this.redoStack = []; this.pending = null; this.before = null;
    this.known = this.capture(); this.lastEditAt = 0; this.notifyHistory();
    this.field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  setEnabled(value: boolean): void { this.enabled = value; this.pending = null; this.lastEditAt = 0; }
  clear(): void {
    if (!this.field.value) return;
    this.before = this.capture(); this.field.value = ''; this.pending = null;
    this.field.dispatchEvent(new Event('input', { bubbles: true }));
  }
}
