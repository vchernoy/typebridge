import type { EditorHistory } from './editor';
export type Draft = { id: string; title: string; text: string; updatedAt: number; history?: EditorHistory };
const TAB = 'typebridge.activeDraft.v1';
const ENABLED = 'typebridge.autosave.v1';

/** Default name for new documents (#108). Existing ones keep their saved title. */
export const UNTITLED_TITLE = 'Untitled document';
export function newDraft(text = ''): Draft { return { id: crypto.randomUUID(), title: UNTITLED_TITLE, text, updatedAt: Date.now() }; }
export function autosaveEnabled(): boolean { return localStorage.getItem(ENABLED) !== 'off'; }
export function setAutosaveEnabled(enabled: boolean): void { localStorage.setItem(ENABLED, enabled ? 'on' : 'off'); }
export function setActiveDraftId(id: string): void { sessionStorage.setItem(TAB, id); }
