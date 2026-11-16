import { rememberShared, readerStorageAllowed, rememberPreference, setRememberPreference, REMEMBER_SHARED_KEY, sharedRemovalToken } from '../editor/shared-library';
import { AUTOSAVE_PREF_KEY } from '../editor/drafts';
import { installStorageClearReload, takeClearedNotice } from '../ui/storage-clear-reload';
/** One page's remembering lifecycle. Never resume automatic writes from a cleared/opted-out mount. */
export function setupRememberShared(stopRenderer: () => void) {
  const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Local shared library';
  const label = document.createElement('label'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.id = 'remember-shared'; checkbox.checked = rememberPreference();
  label.append(checkbox, ' Remember shared documents on this device');
  const explanation = document.createElement('p'); explanation.textContent = 'Valid opened links are remembered on this browser/device unless Private session is on. Nothing is uploaded. Reader inputs remain temporary. Remove received items from Documents → Shared with me; editable copies stay separate.';
  const status = document.createElement('p'); status.id = 'shared-memory-status'; status.setAttribute('role', 'status');
  const remember = document.createElement('button'); remember.type = 'button'; remember.textContent = 'Remember this document';
  details.append(summary, label, explanation, remember, status); document.querySelector('.read-main')!.append(details);
  let generation = 0; let ended = false; let automatic = true; let payload: string | undefined; let removalToken = sharedRemovalToken();
  try { if (takeClearedNotice(sessionStorage)) automatic = false; } catch { automatic = false; }
  const invalidate = () => { generation++; automatic = false; };
  installStorageClearReload({ stop: () => { ended = true; invalidate(); stopRenderer(); } });
  async function save(explicit: boolean): Promise<void> {
    if (ended || !payload || (!explicit && !automatic)) return;
    const started = generation; const value = payload;
    const current = () => !ended && generation === started && payload === value;
    try {
      const result = await rememberShared(value, current, () => { ended = true; invalidate(); }, { token: explicit ? sharedRemovalToken() : removalToken });
      if (!current()) return;
      status.textContent = result === 'remembered' ? 'Remembered in Shared with me on this device.' : result === 'full'
        ? 'Shared library is full. This link was not remembered; remove an old item and try again.' : result === 'cancelled'
          ? 'Remembering cancelled because the library changed. Use Remember to save this link again.' : 'Not remembered. Private session or remembering is off.';
    } catch { if (current()) status.textContent = 'Could not remember this link. You can still read it.'; }
  }
  remember.addEventListener('click', () => { void save(true); });
  checkbox.addEventListener('change', () => {
    invalidate();
    try { setRememberPreference(checkbox.checked); status.textContent = 'Preference saved. Use Remember to save this link; previous private changes are not saved.'; }
    catch { checkbox.checked = rememberPreference(); status.textContent = 'Could not save this preference.'; }
  });
  window.addEventListener('storage', event => {
    if (event.key === null || event.key === REMEMBER_SHARED_KEY || event.key === AUTOSAVE_PREF_KEY) { checkbox.checked = rememberPreference(); invalidate(); }
  });
  window.addEventListener('pagehide', () => { invalidate(); });
  return {
    show(value?: string) { if (!value) removalToken = sharedRemovalToken(); generation++; payload = value; remember.disabled = !value; status.textContent = ''; if (value) {
      if (!readerStorageAllowed()) { automatic = false; status.textContent = 'Not remembered. Private session or remembering is off.'; }
      else void save(false);
    } },
  };
}
