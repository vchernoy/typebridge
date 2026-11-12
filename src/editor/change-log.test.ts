import { describe, expect, it } from 'vitest';
import { TITLE_ONLY_CHANGE, applyChange, changeBetween, replayText, type ChangeRecord, type TextChange } from './change-log';

const DOC = 'doc-1';

/** Deterministic pseudo-random numbers, so a failing case can be reproduced from its seed. */
function rng(seed: number) {
  let state = seed;
  return (n: number) => { state = (state * 48271) % 2147483647; return state % n; };
}
const PIECES = ['а', 'Ё', 'щ', 'b', ' ', '\n', '🙂', 'é', 'é', '👩‍💻', 'Привет'];
const TITLES = ['Заметка', 'Письмо', 'Черновик', 'Untitled document', 'Имя 🙂'];

/** A random edit of `text`: insert, delete or replace a random range (may split surrogate pairs). */
function randomEdit(text: string, next: (n: number) => number): string {
  const start = next(text.length + 1);
  const end = Math.min(text.length, start + next(6));
  let inserted = '';
  for (let i = next(4); i > 0; i--) inserted += PIECES[next(PIECES.length)];
  return text.slice(0, start) + inserted + text.slice(next(3) === 0 ? start : end);
}

type Session = { snapshots: { text: string; upTo: number }[]; records: ChangeRecord[]; texts: string[] };

/**
 * Simulate an editing run the way the app will: each edit appends a record; a snapshot is
 * sometimes taken (text + upTo). `texts[seq]` is the true text after change `seq`.
 * When `withTitles` is true, some edits are title-only or also set a title (#37 R2c 2d-1).
 */
function simulate(seed: number, edits: number, initial = 'Начало\n', withTitles = false): Session {
  const next = rng(seed);
  let text = initial;
  const texts = [initial];
  const records: ChangeRecord[] = [];
  const snapshots = [{ text, upTo: 0 }];
  for (let seq = 1; seq <= edits; seq++) {
    const kind = withTitles ? next(5) : 0; // 0–2 text, 3 title-only, 4 text+title
    if (kind === 3) {
      const title = TITLES[next(TITLES.length)]! + String(seq);
      records.push({ documentId: DOC, seq, run: 'run-a', change: TITLE_ONLY_CHANGE, length: text.length, title });
    } else {
      let after = randomEdit(text, next);
      if (after === text) after = text + 'x';
      const change = changeBetween(text, after)!;
      text = after;
      const record: ChangeRecord = { documentId: DOC, seq, run: 'run-a', change, length: after.length };
      if (kind === 4) record.title = TITLES[next(TITLES.length)]! + String(seq);
      records.push(record);
    }
    texts.push(text);
    if (next(5) === 0) snapshots.push({ text, upTo: seq });
  }
  return { snapshots, records, texts };
}

describe('changeBetween / applyChange', () => {
  it('round-trips random edits exactly, including emoji and combining marks', () => {
    const next = rng(11);
    let text = 'Ёлка 🙂 é';
    for (let i = 0; i < 2_000; i++) {
      const after = randomEdit(text, next);
      const change = changeBetween(text, after);
      if (after === text) { expect(change).toBeUndefined(); continue; }
      expect(applyChange(text, change!)).toBe(after);
      text = after;
    }
  });

  it('refuses a change whose deleted text is not at its position', () => {
    expect(applyChange('abc', [1, 'x', 'y'])).toBeUndefined();
    expect(applyChange('abc', [4, '', 'y'])).toBeUndefined();
    expect(applyChange('abc', [1, 'b', 'Б'])).toBe('aБc');
  });
});

describe('replayText: snapshot plus a cut log equals the text at the cut', () => {
  it('for random sessions, every snapshot and every crash point', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const { snapshots, records, texts } = simulate(seed, 80);
      for (let cut = 0; cut <= records.length; cut++) {
        // A crash after `cut` changes reached storage: the log holds 1..cut, the latest snapshot ≤ cut.
        const stored = records.slice(0, cut);
        const snapshot = snapshots.filter(s => s.upTo <= cut).at(-1)!;
        const result = replayText(DOC, snapshot.text, snapshot.upTo, stored);
        expect(result, `seed ${seed}, cut ${cut}`).toEqual({ text: texts[cut], lastSeq: cut, applied: cut - snapshot.upTo });
      }
    }
  });

  it('ignores records already in the snapshot and works on records in any order', () => {
    const { records, texts } = simulate(3, 30);
    const shuffled = [...records].reverse();
    expect(replayText(DOC, texts[10]!, 10, shuffled)).toEqual({ text: texts[30], lastSeq: 30, applied: 20 });
  });

  it('a snapshot newer than the log (its records already cleaned up) replays nothing', () => {
    const { records, texts } = simulate(4, 20);
    expect(replayText(DOC, texts[20]!, 20, records.slice(0, 15))).toEqual({ text: texts[20], lastSeq: 20, applied: 0 });
  });
});

describe('replayText: a damaged log stops at the last consistent text', () => {
  const { records, texts } = simulate(7, 40);

  it('stops before a missing change-id', () => {
    const withGap = records.filter(r => r.seq !== 25);
    expect(replayText(DOC, texts[0]!, 0, withGap)).toEqual({ text: texts[24], lastSeq: 24, applied: 24, stopped: 'gap' });
  });

  it('stops when the first later change is not the next one', () => {
    expect(replayText(DOC, texts[10]!, 10, records.slice(12))).toEqual({ text: texts[10], lastSeq: 10, applied: 0, stopped: 'gap' });
  });

  it('never continues a crashed run with another run that started from the same snapshot', () => {
    // Run A crashed after 1..20; run B started from the original snapshot and wrote 21.. on other text.
    const runB = simulate(99, 10, texts[0]).records.map(r => ({ ...r, seq: r.seq + 20, run: 'run-b' }));
    const result = replayText(DOC, texts[0]!, 0, [...records.slice(0, 20), ...runB]);
    expect(result).toEqual({ text: texts[20], lastSeq: 20, applied: 20, stopped: 'other-run' });
  });

  it('stops at a change that does not fit the text (wrong deleted text or length)', () => {
    const wrongDeleted = records.map(r => r.seq === 15 ? { ...r, change: [r.change[0], r.change[1] + 'Ж', r.change[2]] as TextChange } : r);
    expect(replayText(DOC, texts[0]!, 0, wrongDeleted)).toEqual({ text: texts[14], lastSeq: 14, applied: 14, stopped: 'mismatch' });
    const wrongLength = records.map(r => r.seq === 15 ? { ...r, length: r.length + 1 } : r);
    expect(replayText(DOC, texts[0]!, 0, wrongLength)).toEqual({ text: texts[14], lastSeq: 14, applied: 14, stopped: 'mismatch' });
  });

  it('treats an invalid record as a gap and ignores other documents', () => {
    const damaged: unknown[] = records.map(r => r.seq === 30 ? { ...r, change: 'not a change' } : r);
    damaged.push({ ...records[0], documentId: 'other', seq: 1 }, null, 'junk', { documentId: DOC });
    expect(replayText(DOC, texts[0]!, 0, damaged)).toEqual({ text: texts[29], lastSeq: 29, applied: 29, stopped: 'gap' });
  });

  it('backstop: replaying onto unrelated text stops at the first change that does not fit', () => {
    // Lineage is ensured by upTo and run; this check only catches what they would miss.
    expect(replayText(DOC, 'совсем другой текст', 0, records).stopped).toBe('mismatch');
  });
});

describe('replayText: title changes (#37 R2c 2d-1)', () => {
  it('returns the last title set by an applied record', () => {
    // Fails on old code: ReplayResult has no title field.
    const records: ChangeRecord[] = [
      { documentId: DOC, seq: 1, run: 'run-a', change: [0, '', 'a'], length: 1 },
      { documentId: DOC, seq: 2, run: 'run-a', change: TITLE_ONLY_CHANGE, length: 1, title: 'Первое' },
      { documentId: DOC, seq: 3, run: 'run-a', change: [1, '', 'b'], length: 2, title: 'Второе' },
      { documentId: DOC, seq: 4, run: 'run-a', change: TITLE_ONLY_CHANGE, length: 2, title: 'Третье' },
    ];
    expect(replayText(DOC, '', 0, records)).toEqual({
      text: 'ab', lastSeq: 4, applied: 4, title: 'Третье',
    });
  });

  it('old records without a title still replay', () => {
    // Fails if validation rejects missing title, or if replay invents a title.
    const records: ChangeRecord[] = [
      { documentId: DOC, seq: 1, run: 'run-a', change: [0, '', 'Hi'], length: 2 },
      { documentId: DOC, seq: 2, run: 'run-a', change: [2, '', '!'], length: 3 },
    ];
    expect(replayText(DOC, '', 0, records)).toEqual({ text: 'Hi!', lastSeq: 2, applied: 2 });
    expect('title' in replayText(DOC, '', 0, records)).toBe(false);
  });

  it('a title record past a gap is not applied', () => {
    // Fails if title is taken from a record after a stop, or if title-only skips the gap check.
    const records: ChangeRecord[] = [
      { documentId: DOC, seq: 1, run: 'run-a', change: [0, '', 'a'], length: 1, title: 'A' },
      // seq 2 missing
      { documentId: DOC, seq: 3, run: 'run-a', change: TITLE_ONLY_CHANGE, length: 1, title: 'Past gap' },
    ];
    expect(replayText(DOC, '', 0, records)).toEqual({
      text: 'a', lastSeq: 1, applied: 1, title: 'A', stopped: 'gap',
    });
  });

  it('property: interleaved random title edits replay text and the last title', () => {
    // Fails on old code that ignores title fields or breaks when title-only records appear.
    for (let seed = 1; seed <= 40; seed++) {
      const { snapshots, records, texts } = simulate(seed, 60, 'Начало\n', true);
      for (let cut = 0; cut <= records.length; cut++) {
        const stored = records.slice(0, cut);
        const snapshot = snapshots.filter(s => s.upTo <= cut).at(-1)!;
        const result = replayText(DOC, snapshot.text, snapshot.upTo, stored);
        // Title is only from records applied after the snapshot, never from earlier ones.
        let expectedTitle: string | undefined;
        for (const record of stored) {
          if (record.seq > snapshot.upTo && record.title !== undefined) expectedTitle = record.title;
        }
        const expected = expectedTitle === undefined
          ? { text: texts[cut], lastSeq: cut, applied: cut - snapshot.upTo }
          : { text: texts[cut], lastSeq: cut, applied: cut - snapshot.upTo, title: expectedTitle };
        expect(result, `seed ${seed}, cut ${cut}`).toEqual(expected);
      }
    }
  });
});
