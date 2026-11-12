import { describe, expect, it } from 'vitest';
import { TITLE_ONLY_CHANGE, replayText, type ChangeRecord } from '../editor/change-log';
import { createChangeWriter } from './change-writer';

/** A fake shown document and store: what the saver and storage would see. */
function harness(stored = { text: 'Сохранено', title: 'Заметка', upTo: 0 }) {
  const env = {
    id: 'doc', generation: 1, text: stored.text, title: stored.title, autosave: true,
    row: { text: stored.text, title: stored.title, upTo: stored.upTo },
    records: [] as ChangeRecord[],
    failNext: 0,
    runs: 0,
  };
  const writer = createChangeWriter({
    mayRecord: () => env.autosave,
    shown: () => ({ id: env.id, generation: env.generation }),
    text: () => env.text,
    title: () => env.title,
    append: async record => {
      await Promise.resolve();
      if (env.failNext > 0) { env.failNext--; throw new Error('quota'); }
      env.records = env.records.filter(r => r.seq !== record.seq).concat(record);
    },
    newRunId: () => `run-${++env.runs}`,
  });
  const type = (text: string) => { env.text = text; writer.edit(); };
  const rename = (title: string) => { env.title = title; writer.edit(); };
  /** The commit transaction: the row, then the cleanup it does. */
  const commit = (log: ReturnType<typeof writer.upToForSave>, text: string, title = env.title) => {
    env.records = env.records.filter(r => r.run === log.keepRun && r.seq > log.upTo);
    env.row = { text, title, upTo: log.upTo };
  };
  /** A full save the way the saver does it: wait for queued records, take text + title + upTo, commit, report. */
  const save = async (ok = true) => {
    await writer.idle();
    const log = writer.upToForSave(env.id, env.text, env.title);
    if (ok) commit(log, env.text, env.title);
    writer.saved(log.keepRun, ok);
    return log;
  };
  /** What crash recovery would rebuild now: the stored row plus the log. */
  const recovered = async () => {
    await writer.idle();
    return replayText(env.id, env.row.text, env.row.upTo, env.records);
  };
  return { env, writer, type, rename, save, commit, recovered };
}

describe('change writer', () => {
  it('records each edit after a save, so the stored row plus the log is the current text', async () => {
    const { env, type, save, recovered } = harness();
    await save(); // the save that starts the run
    type('Сохранено!'); type('Сохранено! 🙂'); type('Сохра 🙂');
    expect(await recovered()).toMatchObject({ text: 'Сохра 🙂', lastSeq: 3 });
    expect(env.records.map(r => r.seq)).toEqual([1, 2, 3]);
    await save();
    expect(env.row.upTo).toBe(3);
    expect(env.records).toEqual([]);
    type('Сохра 🙂\nновая строка');
    expect(await recovered()).toMatchObject({ text: 'Сохра 🙂\nновая строка', lastSeq: 4 });
  });

  it('never starts a run from shown text: edits before the first save write nothing (#251 review)', async () => {
    // The shown text can be unsaved (a reload backup, a handoff): nothing may continue it.
    const { env, writer, type, save, recovered } = harness({ text: 'a', title: 'T', upTo: 0 });
    env.text = 'b';
    type('bc');
    await writer.idle();
    expect(env.records).toEqual([]);
    await save(false); // saving the restored text fails: still nothing continues it
    type('bcd');
    await writer.idle();
    expect(env.records).toEqual([]);
    expect((await recovered()).text).toBe('a');
    await save(); // once a save commits, the run starts from it
    type('bcde');
    expect(await recovered()).toMatchObject({ text: 'bcde', lastSeq: 1 });
  });

  it('writes nothing while Autosave is off, and after it the next save starts a new run', async () => {
    const { env, writer, type, save, recovered } = harness();
    await save();
    type('A');
    await writer.idle();
    env.autosave = false;
    type('частное'); type('частное 2');
    await writer.idle();
    expect(env.records).toHaveLength(1);
    env.autosave = true;
    await save(); // a new run: the earlier run's records are removed
    expect(env.records).toEqual([]);
    expect(env.row).toMatchObject({ text: 'частное 2', upTo: 0 });
    type('частное 2!');
    await writer.idle();
    expect(env.records).toMatchObject([{ seq: 1, run: 'run-2' }]);
    expect((await recovered()).text).toBe('частное 2!');
  });

  it('records still queued when Autosave goes off are never written (#251 review)', async () => {
    const { env, writer, type, save } = harness();
    await save();
    type('S'); type('Se');
    env.autosave = false; // before the queued writes run
    await writer.idle();
    expect(env.records).toEqual([]);
  });

  it('a document shown again records nothing until a save starts its new run', async () => {
    const { env, writer, type, save, recovered } = harness();
    await save();
    type('X');
    await writer.idle();
    env.generation = 2; // shown again (e.g. reloaded)
    type('XY');
    await writer.idle();
    expect(env.records.map(r => r.run)).toEqual(['run-1']);
    await save();
    expect(env.records).toEqual([]);
    type('XYZ');
    expect(await recovered()).toMatchObject({ text: 'XYZ', lastSeq: 1 });
  });

  it('edits made while a run-starting save is in flight continue the saved text once it commits', async () => {
    const { env, writer, type, commit, recovered } = harness({ text: 'Старое', title: 'T', upTo: 5 });
    env.text = 'Личное';
    const log = writer.upToForSave(env.id, env.text, env.title); // the save of 'Личное' is in flight
    expect(log).toMatchObject({ upTo: 0 });
    type('Личное!'); type('Личное!!');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(env.records).toEqual([]); // held until the save commits
    commit(log, 'Личное');
    writer.saved(log.keepRun, true);
    await writer.idle();
    expect(env.records.map(r => r.seq)).toEqual([1, 2]);
    expect(await recovered()).toMatchObject({ text: 'Личное!!', lastSeq: 2 });
  });

  it('records held for a save that fails are dropped (#251 review)', async () => {
    const { env, writer, type, recovered } = harness({ text: 'a', title: 'T', upTo: 0 });
    env.text = 'b';
    const log = writer.upToForSave(env.id, env.text, env.title);
    type('bc');
    writer.saved(log.keepRun, false); // the row is still 'a'
    await writer.idle();
    expect(env.records).toEqual([]);
    expect((await recovered()).text).toBe('a');
  });

  it('a save that only continues the log holds nothing', async () => {
    const { env, writer, type, save } = harness();
    await save();
    type('X');
    await writer.idle();
    writer.upToForSave(env.id, env.text, env.title); // in flight, not reported yet
    type('XY');
    await writer.idle();
    expect(env.records.map(r => r.seq)).toEqual([1, 2]);
  });

  it('a run-starting save removes a crashed run\'s longer tail (#251 review)', async () => {
    const { env, type, save, recovered } = harness({ text: 'a', title: 'T', upTo: 0 });
    env.records = [
      { documentId: 'doc', seq: 1, run: 'crashed', change: [1, '', 'b'], length: 2 },
      { documentId: 'doc', seq: 2, run: 'crashed', change: [2, '', 'c'], length: 3 },
    ];
    env.text = 'ax';
    await save();
    expect(env.records).toEqual([]);
    type('axy');
    expect(await recovered()).toMatchObject({ text: 'axy', lastSeq: 1 });
  });

  it('after a failed write it stops, and the next save covers everything and resumes', async () => {
    const { env, writer, type, save, recovered } = harness();
    await save();
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
    const { env, writer, type, save, recovered } = harness();
    await save();
    type('a'); type('ab');
    await writer.idle();
    env.failNext = 1;
    type('abc');
    type('abcd');
    // Record 3 failed and the writer stopped: record 4, queued behind it, is not written either.
    expect(await recovered()).toMatchObject({ text: 'ab', lastSeq: 2 });
    expect(env.records.map(r => r.seq)).toEqual([1, 2]);
  });

  // --- #37 R2c 2d-1: title changes in the change log (each fails on code without title support) ---

  it('title-only edits record', async () => {
    // Fails on old code: edit() ignores title, so nothing is written when only the title changes.
    const { env, writer, rename, save, recovered } = harness();
    await save();
    rename('Новое имя');
    await writer.idle();
    expect(env.records).toEqual([{
      documentId: 'doc', seq: 1, run: 'run-1', change: TITLE_ONLY_CHANGE, length: 'Сохранено'.length, title: 'Новое имя',
    }]);
    expect(await recovered()).toMatchObject({ text: 'Сохранено', lastSeq: 1, title: 'Новое имя', applied: 1 });
  });

  it('a save of a changed title with unchanged text holds later records the same way a text change does (rule 1)', async () => {
    // Fails on old code: upToForSave only compared text, so an unrecorded title change looked like
    // "log already produces the saved state" and later records were written immediately.
    const { env, writer, type, commit, save, recovered } = harness();
    await save();
    env.title = 'Переименовано'; // title changed without a log record (e.g. unrecorded edit)
    const log = writer.upToForSave(env.id, env.text, env.title);
    expect(log.upTo).toBe(0);
    type('Сохранено!');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(env.records).toEqual([]); // held until the title save commits
    commit(log, 'Сохранено', 'Переименовано');
    writer.saved(log.keepRun, true);
    await writer.idle();
    expect(env.records.map(r => r.seq)).toEqual([1]);
    expect(await recovered()).toMatchObject({ text: 'Сохранено!', lastSeq: 1 });
  });

  it('Autosave off records no title', async () => {
    // Fails on old code that recorded titles without checking mayRecord the same way, or that
    // still wrote a title record after Autosave went off.
    const { env, writer, rename, save } = harness();
    await save();
    env.autosave = false;
    rename('Секретное имя');
    await writer.idle();
    expect(env.records).toEqual([]);
  });
});
