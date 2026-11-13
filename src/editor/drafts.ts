import type { EditorHistory } from './editor';
export type Draft = { id: string; title: string; text: string; updatedAt: number; history?: EditorHistory };
export const ACTIVE_DRAFT_KEY_BASE = 'typebridge.activeDraft.v1';
/** Shared Private session / legacy Autosave preference (`off` = private session on). */
export const AUTOSAVE_PREF_KEY = 'typebridge.autosave.v1';
const ENABLED = AUTOSAVE_PREF_KEY;

/** Default name for new documents (#108). Existing ones keep their saved title. */
export const UNTITLED_TITLE = 'Untitled document';

/** Mutable so #175 window instances can scope the active-document hint. */
let activeDraftKey = ACTIVE_DRAFT_KEY_BASE;

export function configureActiveDraftKey(key: string): void {
  activeDraftKey = key;
}

export function activeDraftStorageKey(): string {
  return activeDraftKey;
}

export function newDraft(text = '', title = UNTITLED_TITLE): Draft {
  return { id: crypto.randomUUID(), title, text, updatedAt: Date.now() };
}
export function autosaveEnabled(): boolean { return localStorage.getItem(ENABLED) !== 'off'; }
export function setAutosaveEnabled(enabled: boolean): void { localStorage.setItem(ENABLED, enabled ? 'on' : 'off'); }
export function setActiveDraftId(id: string): void { sessionStorage.setItem(activeDraftKey, id); }
export function readActiveDraftId(): string | null { return sessionStorage.getItem(activeDraftKey); }
