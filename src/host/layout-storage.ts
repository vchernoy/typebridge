/** Layout writes from an erased page cannot overwrite a replacement page's layout. */
import { HOST_WINDOWS_KEY } from './layout';
export const LAYOUT_EPOCH_KEY = 'typebridge.hostLayoutEpoch.v1';
export function advanceLayoutEpoch(storage: Storage): void {
  storage.setItem(LAYOUT_EPOCH_KEY, crypto.randomUUID());
}
/** Capture once at host startup. Each erasure gets a separate layout slot. */
export function captureLayoutStorage(storage: Storage): Pick<Storage, 'getItem' | 'setItem'> {
  let epoch: string | null;
  let readable = true;
  try { epoch = storage.getItem(LAYOUT_EPOCH_KEY); } catch { epoch = null; readable = false; }
  const slot = epoch ? HOST_WINDOWS_KEY + '.' + epoch : HOST_WINDOWS_KEY;
  return {
    getItem: () => readable && storage.getItem(LAYOUT_EPOCH_KEY) === epoch ? storage.getItem(slot) : null,
    setItem: (_key: string, value: string) => {
      if (!readable) throw new Error('Layout epoch unavailable');
      if (storage.getItem(LAYOUT_EPOCH_KEY) !== epoch) return;
      storage.setItem(slot, value);
      // A different page can advance the epoch between getItem and setItem.
      // Remove only our retired slot, never the replacement generation's slot.
      if (storage.getItem(LAYOUT_EPOCH_KEY) !== epoch) storage.removeItem(slot);
    },
  };
}
