import { describe, expect, it } from 'vitest';
import { applyChange, changeBetween, fieldRecord, replayDocument, type ChangeRecord } from './change-log';
import { DOCUMENT_FIELDS, documentFields, type DocumentFields } from './document-fields';

const DOC = 'doc-1';
const initial = { text: 'Начало\n', title: 'Заметка', find: '', replace: '', format: 'plain' as const };
function rng(seed: number) {
  let state = seed;
  return (n: number) => { state = (state * 48271) % 2147483647; return state % n; };
}
const PIECES = ['а', 'Ё', 'щ', 'b', ' ', '\n', '🙂', 'é', '👩‍💻', 'Привет', 'z'.repeat(300)];
function randomEdit(text: string, next: (n: number) => number): string {
  const start = next(text.length + 1);
  const end = Math.min(text.length, start + next(6));
  return text.slice(0, start) + PIECES[next(PIECES.length)] + text.slice(end);
}
function simulate(seed: number) {
  const next = rng(seed);
  const fields = { ...initial };
  const states = [{ ...fields }];
  const records: ChangeRecord[] = [];
  for (let seq = 1; seq <= 80; seq++) {
    const field = (['text', 'title', 'find', 'replace'] as const)[next(4)];
    const after = randomEdit(fields[field], next);
    records.push(fieldRecord({ documentId: DOC, seq, run: 'run-a', field }, fields[field], after));
    fields[field] = after;
    states.push({ ...fields });
  }
  return { states, records };
}

describe('changeBetween / applyChange', () => {
  it('round-trips random UTF-16 edits, including emoji and combining marks', () => {
    const next = rng(11);
    let text = 'Ёлка 🙂 é';
    for (let i = 0; i < 2_000; i++) {
      const after = randomEdit(text, next);
      const change = changeBetween(text, after);
      if (after === text) expect(change).toBeUndefined();
      else expect(applyChange(text, change!)).toBe(after);
      text = after;
    }
  });
  it('refuses wrong deleted text or an out-of-bounds offset', () => {
    expect(applyChange('abc', [1, 'x', 'y'])).toBeUndefined();
    expect(applyChange('abc', [4, '', 'y'])).toBeUndefined();
    expect(applyChange('abc', [1, 'b', 'Б'])).toBe('aБc');
  });
});

describe('four-field records and consistent replay (#257 2a)', () => {
  it.each(DOCUMENT_FIELDS.filter((field): field is Exclude<typeof field, 'format'> => field !== 'format'))('%s uses values below 256 UTF-16 units and deltas at/above 256', field => {
    const id = { documentId: DOC, seq: 1, run: 'r', field };
    expect(fieldRecord(id, 'old', '')).toEqual({ ...id, value: '', previous: 'old' });
    expect(fieldRecord(id, '', 'x'.repeat(255))).toEqual({ ...id, value: 'x'.repeat(255), previous: '' });
    const long = fieldRecord(id, '', 'x'.repeat(256));
    expect(long).toEqual({ ...id, change: [0, '', 'x'.repeat(256)], length: 256 });
    expect(replayDocument(DOC, { ...initial, [field]: '' }, 0, [long])[field]).toBe('x'.repeat(256));
    expect(fieldRecord(id, 'x'.repeat(300), 'short')).toEqual({ ...id, change: [0, 'x'.repeat(300), 'short'], length: 5 });
  });

  it('property: every crash cut and snapshot recovers one real four-field instant', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { records, states } = simulate(seed);
      expect(records.some(r => r.change)).toBe(true);
      expect(records.some(r => r.value !== undefined)).toBe(true);
      for (let cut = 0; cut <= records.length; cut++) {
        const upTo = Math.max(0, cut - (cut % 11));
        const result = replayDocument(DOC, states[upTo], upTo, records.slice(0, cut).reverse());
        expect(result, `seed ${seed}, cut ${cut}`).toEqual({ ...states[cut], lastSeq: cut, applied: cut - upTo });
      }
    }
  });

  it('missing find/replace mean empty; a snapshot newer than the log replays nothing', () => {
    expect(documentFields({ text: 'a', title: 'T' })).toEqual({ text: 'a', title: 'T', find: '', replace: '', format: 'plain' });
    const { records, states } = simulate(4);
    expect(replayDocument(DOC, states[80], 80, records.slice(0, 70))).toEqual({ ...states[80], lastSeq: 80, applied: 0 });
  });

  const interleaved: ChangeRecord[] = [
    { documentId: DOC, seq: 1, run: 'r', field: 'text', value: 'a', previous: initial.text },
    { documentId: DOC, seq: 2, run: 'r', field: 'find', value: 'query', previous: '' },
    { documentId: DOC, seq: 3, run: 'r', field: 'title', value: 'New', previous: initial.title },
    { documentId: DOC, seq: 4, run: 'r', field: 'replace', value: 'replacement', previous: '' },
  ];
  const prefix: DocumentFields = { ...initial, text: 'a', find: 'query' };
  it('stops all fields at a gap instead of applying a later title/replace', () => {
    expect(replayDocument(DOC, initial, 0, interleaved.filter(r => r.seq !== 3))).toEqual({ ...prefix, lastSeq: 2, applied: 2, stopped: 'gap' });
    expect(replayDocument(DOC, initial, 0, interleaved.slice(1))).toMatchObject({ ...initial, applied: 0, stopped: 'gap' });
  });
  it('never crosses editing runs, even for a full value record', () => {
    expect(replayDocument(DOC, initial, 0, interleaved.map(r => r.seq === 3 ? { ...r, run: 'other' } : r))).toEqual({ ...prefix, lastSeq: 2, applied: 2, stopped: 'other-run' });
  });
  it.each([
    { change: [0, 'wrong', 'x'.repeat(300)], length: 300 },
    { change: [1, '', 'x'.repeat(300)], length: 300 },
  ])('stops every field at a mismatching long change %j', delta => {
    const records = interleaved.map(r => r.seq === 3 ? { documentId: DOC, seq: 3, run: 'r', field: 'title', ...delta } : r);
    expect(replayDocument(DOC, initial, 0, records)).toEqual({ ...prefix, lastSeq: 2, applied: 2, stopped: 'mismatch' });
  });
  it.each([
    { field: 'unknown', value: 'x' },
    { field: 'find', value: 42 },
    { field: 'find', value: 'x'.repeat(256) },
    { field: 'find', value: '', change: [0, '', ''] },
    { field: 'find', change: [-1, '', 'x'.repeat(300)], length: 300 },
    { field: 'find', change: [0, '', 'short'], length: -1 },
    { field: 'find', value: 'x', previous: 42 },
    { field: 'find', value: 'x', previous: 'x'.repeat(256) },
    { change: [0, '', ''], length: 0, title: 'old schema' },
  ])('invalid record stops the document, including an invalid tail %j', invalid => {
    const bad = { documentId: DOC, seq: 3, run: 'r', ...invalid };
    for (const records of [[...interleaved.slice(0, 2), bad], [...interleaved.slice(0, 2), bad, interleaved[3]]]) {
      expect(replayDocument(DOC, initial, 0, records)).toEqual({ ...prefix, lastSeq: 2, applied: 2, stopped: 'gap' });
    }
  });
  it('ignores other documents and unrelated malformed data', () => {
    expect(replayDocument(DOC, initial, 0, [null, 'junk', ...interleaved, { ...interleaved[0], documentId: 'other' }])).toEqual({ text: 'a', title: 'New', find: 'query', replace: 'replacement', format: 'plain', lastSeq: 4, applied: 4 });
  });
});

it.each(DOCUMENT_FIELDS.filter((field): field is Exclude<typeof field, 'format'> => field !== 'format'))('a mismatching %s predecessor stops every later field', field => {
  const record = fieldRecord({ documentId: DOC, seq: 1, run: 'r', field }, 'prior', 'next');
  const later = fieldRecord({ documentId: DOC, seq: 2, run: 'r', field: 'title' }, initial.title, 'later');
  expect(replayDocument(DOC, { ...initial, [field]: 'foreign' }, 0, [record, later])).toEqual({
    ...initial, [field]: 'foreign', lastSeq: 0, applied: 0, stopped: 'mismatch',
  });
});

it.each(DOCUMENT_FIELDS.filter((field): field is Exclude<typeof field, 'format'> => field !== 'format'))('%s long-to-short and long-to-empty deltas still fit-check and replay', field => {
  const before = 'x'.repeat(256);
  for (const after of ['x'.repeat(255), '']) {
    const record = fieldRecord({ documentId: DOC, seq: 1, run: 'r', field }, before, after);
    expect(record.change).toBeDefined();
    expect(record).not.toHaveProperty('previous');
    expect(replayDocument(DOC, { ...initial, [field]: before }, 0, [record])).toEqual({
      ...initial, [field]: after, lastSeq: 1, applied: 1,
    });
    expect(replayDocument(DOC, { ...initial, [field]: 'foreign' }, 0, [record])).toMatchObject({ applied: 0, stopped: 'mismatch' });
  }
});

it('format shares the sequence and refuses unknown format records', () => {
  const record = fieldRecord({ documentId: DOC, seq: 1, run: 'r', field: 'format' }, 'plain', 'markdown');
  expect(replayDocument(DOC, { text: 'x', title: 'T' }, 0, [record])).toEqual({ text: 'x', title: 'T', find: '', replace: '', format: 'markdown', lastSeq: 1, applied: 1 });
  expect(replayDocument(DOC, initial, 0, [{ ...record, value: 'html' }])).toMatchObject({ format: 'plain', applied: 0, stopped: 'gap' });
  expect(documentFields({ text: '', title: '', format: 'markdown' }).format).toBe('markdown');
});
