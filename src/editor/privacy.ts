/**
 * Private mode (#257 step 1): a document is private when the global private session is on,
 * or when the document record itself is marked private. Anything typed while private must
 * not be written.
 */
import { autosaveEnabled, setAutosaveEnabled } from './drafts';

/**
 * Last successfully observed Private session value. When localStorage throws after the
 * session was on, fail closed to this instead of opening mayWrite (#257 P0).
 */
let lastKnownPrivateSessionOn = false;

/** Global private session: the existing `typebridge.autosave.v1` preference when off. */
export function privateSessionOn(): boolean {
  try {
    const on = !autosaveEnabled();
    lastKnownPrivateSessionOn = on;
    return on;
  } catch {
    return lastKnownPrivateSessionOn;
  }
}

/** Persist the global private session (writes `typebridge.autosave.v1`). */
export function setPrivateSessionOn(on: boolean): void {
  setAutosaveEnabled(!on);
  lastKnownPrivateSessionOn = on;
}

/**
 * True when nothing about this document's text/title/undo may be written.
 * `sessionOn` defaults to reading the preference so call sites can pass a cached value.
 */
export function privateNow(
  doc?: { private?: boolean } | null,
  sessionOn: boolean = privateSessionOn(),
): boolean {
  return sessionOn || doc?.private === true;
}

/** Per-document Autosave checkbox: checked means this document may save. */
export function documentAutosaveChecked(
  doc?: { private?: boolean } | null,
  sessionOn: boolean = privateSessionOn(),
): boolean {
  return !privateNow(doc, sessionOn);
}

export const PRIVATE_SWITCH_SAVE_FAILED =
  "Your last changes before going private couldn't be saved.";

export const PRIVATE_SWITCH_FLAG_FAILED =
  "Your last changes before going private couldn't be saved, and this document may not reopen as private.";
