import { describe, expect, it } from 'vitest';
import { exportJson, parseImportFile, safeFilename } from './export-import';

describe('export/import formats', () => {
  it('makes file-system-safe names and keeps Cyrillic', () => {
    expect(safeFilename('Русский пост')).toBe('Русский пост');
    expect(safeFilename(' a/b\\c:d*e?f"g<h>i|j ')).toBe('a-b-c-d-e-f-g-h-i-j');
    expect(safeFilename('tab\there')).toBe('tab-here');
    expect(safeFilename('   ')).toBe('document');
    expect(safeFilename('x'.repeat(100))).toHaveLength(80);
  });

  it('round-trips a TypeBridge JSON export', () => {
    const json = exportJson('Заметка', 'Привет, мир!\nВторая строка.');
    expect(JSON.parse(json)).toEqual({ format: 'typebridge-draft', version: 1, draft: { format: 'plain', title: 'Заметка', text: 'Привет, мир!\nВторая строка.' } });
    expect(parseImportFile('backup.typebridge.json', json)).toEqual({ format: 'plain', title: 'Заметка', text: 'Привет, мир!\nВторая строка.' });
  });

  it('keeps Markdown and treats old JSON as plain', () => {
    expect(parseImportFile('x.json', exportJson('T', '# title', 'markdown'))).toEqual({ title: 'T', text: '# title', format: 'markdown' });
    expect(parseImportFile('x.json', JSON.stringify({ format: 'typebridge-draft', version: 1, draft: { title: 'Old', text: 'old' } }))).toEqual({ title: 'Old', text: 'old', format: 'plain' });
  });

  it('imports .txt with the file name as title', () => {
    expect(parseImportFile('Пост.txt', 'текст 🙂')).toEqual({ format: 'plain', title: 'Пост', text: 'текст 🙂' });
    expect(parseImportFile('  .txt', 'x').title).toBe('Imported document');
    expect(parseImportFile('a'.repeat(200) + '.txt', 'x').title).toHaveLength(150);
  });

  it('rejects other files and foreign JSON', () => {
    expect(() => parseImportFile('notes.md', 'x')).toThrow('Choose a .txt or .typebridge.json file');
    expect(() => parseImportFile('x.json', '{"format":"other"}')).toThrow('Not a supported TypeBridge document');
    expect(() => parseImportFile('x.json', JSON.stringify({ format: 'typebridge-draft', version: 2, draft: { title: 't', text: 'x' } }))).toThrow('Not a supported');
    expect(() => parseImportFile('x.json', 'not json')).toThrow();
  });
});
