import { describe, expect, it } from 'vitest';
import { AUTOSAVE_OFF, CONFLICT_COPY, SAVE_FAILED, type RiskInputs } from '../editor/status';
import { createStatusLine } from './status-line';

function fakeElement(): HTMLElement {
  const classes = new Set<string>();
  return {
    textContent: '',
    classList: { toggle: (name: string, on?: boolean) => { if (on) classes.add(name); else classes.delete(name); return !!on; }, contains: (name: string) => classes.has(name) },
  } as unknown as HTMLElement;
}

function setup(risk: Partial<RiskInputs> = {}) {
  const inputs: RiskInputs = { storageProblem: '', dirty: false, blocked: false, saveFailed: false, autosaveOn: true, ...risk };
  const conflictNotice = fakeElement();
  const status = fakeElement();
  const line = createStatusLine({
    conflictNotice, statusSep: fakeElement(), status,
    afterRender: () => {}, risk: () => inputs, editBlock: () => '', quietReader: () => false,
  });
  return { line, inputs, conflictNotice, status };
}

describe('status line', () => {
  it('keeps the at-risk warning on action feedback', () => {
    const { line, status } = setup({ dirty: true, autosaveOn: false });
    line.announceAction('Copied.');
    expect(status.textContent).toBe('Copied. ' + AUTOSAVE_OFF);
    expect(line.kind()).toBe('progress');
    line.announceAction('Copied.', { omitRisk: true });
    expect(status.textContent).toBe('Copied.');
    expect(line.kind()).toBe('action');
  });

  it('shows save progress that never hides a failed save', () => {
    const { line, inputs, status } = setup();
    line.showSaving();
    expect(status.textContent).toBe('Saving…');
    expect(status.classList.contains('status--announced-only')).toBe(true);
    inputs.saveFailed = true;
    line.showSaveState();
    expect(status.textContent).toBe(SAVE_FAILED);
    expect(line.kind()).toBe('failure');
  });

  it('re-announces an identical conflict on a later microtask', async () => {
    const { line, conflictNotice } = setup();
    line.setConflict(CONFLICT_COPY);
    expect(conflictNotice.textContent).toBe(CONFLICT_COPY);
    line.setConflict(CONFLICT_COPY, true);
    expect(conflictNotice.textContent).toBe('');
    await Promise.resolve();
    expect(conflictNotice.textContent).toBe(CONFLICT_COPY);
    // An action clears the conflict, including one still waiting to re-announce.
    line.setConflict(CONFLICT_COPY, true);
    line.announceAction('Done');
    await Promise.resolve();
    expect(conflictNotice.textContent).toBe('');
    expect(line.message().conflict).toBe('');
  });
});
