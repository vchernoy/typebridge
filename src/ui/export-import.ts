/**
 * Export (TXT, TypeBridge JSON) and Import of one document. The file formats and checks are
 * pure functions; `setupExportImport` wires the Documents menu buttons. Saving an import and
 * opening it stay with the caller (`importDocument`), which owns storage and switching.
 */

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const TITLE_MAX = 150;

/** A file-system-safe name from a title: control and reserved characters become '-'. */
export function safeFilename(title: string): string {
  return (title.trim().split('').map(char => char.charCodeAt(0) < 32 || '/\\\\:*?"<>|'.includes(char) ? '-' : char).join('').slice(0, 80) || 'document');
}

/** The TypeBridge JSON export of one document. */
export function exportJson(title: string, text: string): string {
  const draft = { title, text };
  return JSON.stringify({ format: 'typebridge-draft', version: 1, draft }, null, 2);
}

/**
 * Read an import file: `.txt` is the text with the file name as title; `.typebridge.json` (or
 * `.json`) must be a version 1 TypeBridge export. Throws with a user-facing reason otherwise.
 */
export function parseImportFile(name: string, content: string): { title: string; text: string } {
  let title = name.replace(/(\.typebridge)?\.(json|txt)$/i, '');
  let text = content;
  if (/\.json$/i.test(name)) {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || !('format' in parsed) || parsed.format !== 'typebridge-draft' || !('version' in parsed) || parsed.version !== 1 || !('draft' in parsed) || !parsed.draft || typeof parsed.draft !== 'object' || !('title' in parsed.draft) || typeof parsed.draft.title !== 'string' || !('text' in parsed.draft) || typeof parsed.draft.text !== 'string') throw new Error('Not a supported TypeBridge document');
    title = parsed.draft.title;
    text = parsed.draft.text;
  } else if (!/\.txt$/i.test(name)) throw new Error('Choose a .txt or .typebridge.json file');
  return { title: title.trim().slice(0, TITLE_MAX) || 'Imported document', text };
}

function downloadText(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type ExportImportDeps = {
  /** Title (or the Untitled default) and text currently shown. */
  exportSurface: () => { title: string; text: string };
  announce: (text: string, options?: { keepConflict?: boolean }) => void;
  isViewMode: () => boolean;
  /** Ask before importing; resolves false to cancel. */
  confirmImport: () => Promise<boolean>;
  /** Save the import as a new document and open it; throws when it cannot be saved. */
  importDocument: (doc: { title: string; text: string }) => Promise<{ opened: boolean; conflict: boolean }>;
};

export function setupExportImport(deps: ExportImportDeps): void {
  document.querySelector<HTMLButtonElement>('#export-txt')!.addEventListener('click', () => {
    const { title, text } = deps.exportSurface();
    downloadText(safeFilename(title) + '.txt', text, 'text/plain;charset=utf-8');
    deps.announce('Text exported');
  });
  document.querySelector<HTMLButtonElement>('#export-json')!.addEventListener('click', () => {
    const { title, text } = deps.exportSurface();
    downloadText(safeFilename(title) + '.typebridge.json', exportJson(title, text), 'application/json;charset=utf-8');
    deps.announce('Document exported');
  });
  const importFile = document.querySelector<HTMLInputElement>('#import-file')!;
  document.querySelector<HTMLButtonElement>('#import-draft')!.addEventListener('click', () => { if (!deps.isViewMode()) importFile.click(); });
  importFile.addEventListener('change', async () => {
    if (deps.isViewMode()) { importFile.value = ''; return; }
    const file = importFile.files?.[0];
    importFile.value = '';
    if (!file) return;
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error('File exceeds 5 MB');
      const doc = parseImportFile(file.name, await file.text());
      if (!await deps.confirmImport()) return;
      const switched = await deps.importDocument(doc);
      // Always confirm the import; keep a conflict notice that the switch flush created.
      deps.announce(
        switched.opened ? 'Imported as a new document' : 'Import saved in Documents; current text was kept',
        { keepConflict: switched.conflict },
      );
    } catch (error) {
      deps.announce('Import failed: ' + (error instanceof Error ? error.message : String(error)));
    }
  });
}
