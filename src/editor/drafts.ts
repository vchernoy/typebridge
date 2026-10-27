import type { EditorHistory } from './editor';
export type Draft = { id: string; title: string; text: string; updatedAt: number; history?: EditorHistory };
const KEY = 'typebridge.drafts.v1';
const TAB = 'typebridge.activeDraft.v1';
const ENABLED = 'typebridge.autosave.v1';

function read(): Draft[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((d): d is Draft => !!d && typeof d.id === 'string' && typeof d.title === 'string' && typeof d.text === 'string' && typeof d.updatedAt === 'number');
  } catch { return []; }
}
function write(drafts: Draft[]): void { localStorage.setItem(KEY, JSON.stringify(drafts)); }
export function listDrafts(): Draft[] { return read().sort((a,b) => b.updatedAt-a.updatedAt); }
export function getDraft(id: string): Draft | undefined { return read().find(d => d.id === id); }
export function saveDraft(draft: Draft): void {
  const drafts = read().filter(d => d.id !== draft.id);
  drafts.push(draft);
  write(drafts);
}
export function deleteDraft(id: string): void { write(read().filter(d => d.id !== id)); }
export function newDraft(text = ''): Draft { return { id: crypto.randomUUID(), title: 'Untitled draft', text, updatedAt: Date.now() }; }
export function autosaveEnabled(): boolean { return localStorage.getItem(ENABLED) !== 'off'; }
export function setAutosaveEnabled(enabled: boolean): void { localStorage.setItem(ENABLED, enabled ? 'on' : 'off'); }
export function getActiveDraftId(): string | null {
  // A new tab gets its own blank draft; reload retains the current tab's draft.
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  return navigation?.type === 'reload' ? sessionStorage.getItem(TAB) : null;
}
export function setActiveDraftId(id: string): void { sessionStorage.setItem(TAB, id); }
