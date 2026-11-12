import { describe, expect, it } from 'vitest';
import { replayText, type ChangeRecord } from '../editor/change-log';
import { createChangeWriter } from './change-writer';

/** A fake shown document and store: what the saver and storage would see. */
function harness(stored = { text: 'Сохранено', upTo: 0, revision: 1 }) {
  const env = {
    id: 'doc', generation: 1, text: stored.text, autosave: true,
    row: { ...stored },
    records: [] as ChangeRecord[],
    failNext: 0,
    runs: 0,
  };
  const writer = createChangeWriter({
    mayRecord: () => env.autosave,
    shown: () => ({ id: env.id, generation: env.generation, storedText: env.row.text, upTo: env.row.upTo, revision: env.row.revision }),
    text: () => env.text,
    append: async record => {
      await Promise.resolve();
      if (env.failNext > 0) { env.failNext--; throw new Error('quota'); }
      env.records = env.records.filter(r => r.seq !== record.seq).concat(record);
    },
    newRunId: () => `run-${++env.runs}`,
  });
  const type = (text: string) => { env.text = text; writer.edit(); };
  /** A full save the way the saver does it: wait for queued records, then text + upTo together. */
  const save = async () => {
    await writer.idle();
    commit(writer.upToForSave(env.id, env.text), env.text);
  };
  /** The commit transaction: the row, then the cleanup it does. */
  const commit = (log: ReturnType<typeof writer.upToForSave>, text: string) => {
    env.records = env.records.filter(r => r.run === log.keepRun && r.seq > log.upTo);
    env.row = { text, upTo: log.upTo, revision: env.row.revision + 1 };
  };
  const recovered = async () => { await writer.idle(); return replayText(env.id, env.row.revision > 0 ? env.row.text : '', env.row.upTo, env.records); };
  return { env, writer, type, save, commit, recovered };
}

describe('change writer', () => {
  it('records each edit so the stored row plus the log is the current text', async () => {
    const { env, type, save, recovered } = harness();
    type('Сохранено!'); type('Сохранено! 🙂'); type('Сохра 🙂');
    expect((await recovered()).text).toBe('Сохра 🙂');
    expect(env.records.map(r => r.seq)).toEqual([1, 2, 3]);
    await save();
    expect(env.row.upTo).toBe(3);
    expect(env.records).toEqual([]);
    type('Сохра 🙂\nновая строка');
    expect(await recovered()).toMatchObject({ text: 'Сохра 🙂\nновая строка', lastSeq: 4 });
  });

  it('starts after the stored upTo, so a new run continues the saved text', async () => {
    const { env, writer, type, recovered } = harness({ text: 'Текст', upTo: 41, revision: 3 });
    type('Текст 2');
    await writer.idle();
    expect(env.records).toMatchObject([{ seq: 42, run: 'run-1' }]);
    expect((await recovered()).text).toBe('Текст 2');
  });

  it('a document never saved starts from empty text', async () => {
    const { env, writer, type, recovered } = harness({ text: 'ignored', upTo: 0, revision: 0 });
    type('Первое');
    await writer.idle();
    expect(env.records[0]?.change).toEqual([0, '', 'Первое']);
    expect((await recovered()).text).toBe('Первое');
  });

  it('writes nothing while Autosave is off, and after it the next save clears the old log', async () => {
    const { env, writer, type, save, recovered } = harness();
    type('A');
    await writer.idle();
    env.autosave = false;
    type('частное'); type('частное 2');
    await writer.idle();
    expect(env.records).toHaveLength(1);
    env.autosave = true;
    await save(); // no current run: this save must remove the earlier run's records
    expect(env.records).toEqual([]);
    expect(env.row).toMatchObject({ text: 'частное 2', upTo: 0 });
    type('частное 2!');
    await writer.idle();
    expect(env.records).toMatchObject([{ seq: 1, run: 'run-2' }]);
    expect((await recovered()).text).toBe('частное 2!');
  });

  it('edits made while a clearing save is in flight continue the saved text (#251 review)', async () => {
    const { env, writer, type, commit, recovered } = harness({ text: 'Старое', upTo: 5, revision: 2 });
    env.autosave = false;
    type('Личное');
    env.autosave = true;
    // The save captures text and upTo, then waits for its transaction; the user keeps typing.
    await writer.idle();
    const log = writer.upToForSave(env.id, env.text);
    expect(log).toMatchObject({ upTo: 0 });
    type('Личное!'); type('Личное!!');
    await writer.idle();
    commit(log, 'Личное');
    expect(env.records).toMatchObject([{ seq: 1 }, { seq: 2 }]);
    expect(await recovered()).toMatchObject({ text: 'Личное!!', lastSeq: 2 });
  });

  it('records still queued when Autosave goes off are never written (#251 review)', async () => {
    const { env, writer, type } = harness();
    type('S'); type('Se');
    env.autosave = false; // before the queued writes run
    await writer.idle();
    expect(env.records).toEqual([]);
  });

  it('a document shown again starts a new run; its first save clears the earlier log', async () => {
    const { env, writer, type, save } = harness();
    type('X');
    env.generation = 2; // shown again (e.g. reloaded); nothing typed yet
    expect(writer.upToForSave(env.id, env.text)).toMatchObject({ upTo: 0 });
    type('XY');
    await save();
    expect(env.records).toEqual([]);
  });

  it('the first save of a new run removes a crashed run\'s longer tail (#251 review)', async () => {
    const { env, writer, type, save, recovered } = harness({ text: 'a', upTo: 0, revision: 1 });
    // A crashed window left two records after the stored row.
    env.records = [
      { documentId: 'doc', seq: 1, run: 'crashed', change: [1, '', 'b'], length: 2 },
      { documentId: 'doc', seq: 2, run: 'crashed', change: [2, '', 'c'], length: 3 },
    ];
    type('ax');
    await writer.idle();
    await save();
    expect(env.records).toEqual([]);
    expect((await recovered()).text).toBe('ax');
    type('axy');
    expect((await recovered()).text).toBe('axy');
  });

  it('after a failed write it stops, and the next save covers everything and resumes', async () => {
    const { env, writer, type, save, recovered } = harness();
    env.failNext = 1;
    type('1'); type('12'); type('123');
    await writer.idle();
    expect(env.records).toEqual([]); // 1 failed; 2 and 3 were skipped
    type('1234'); // still stopped
    await writer.idle();
    expect(env.records).toEqual([]);
    await save();
    expect(env.row).toMatchObject({ text: '1234', upTo: 3 });
    type('12345');
    expect(await recovered()).toMatchObject({ text: '12345', lastSeq: 4 });
  });

  it('a failed write leaves a gap that replay stops at, never wrong text', async () => {
    const { env, writer, type, recovered } = harness();
    type('a'); type('ab');
    await writer.idle();
    env.failNext = 1;
    type('abc');
    type('abcd');
    // Record 3 failed and the writer stopped: record 4, queued behind it, is not written either.
    expect(await recovered()).toMatchObject({ text: 'ab', lastSeq: 2 });
    expect(env.records.map(r => r.seq)).toEqual([1, 2]);
  });
});
