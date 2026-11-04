import { describe, expect, it } from 'vitest';
import {
  commandAllowedOnPane,
  commandStillCurrent,
  contentCommandStillCurrent,
  isPaneId,
  isSessionId,
  localPaneTransferBlock,
  paneCloseBlock,
  paneCloseDisposition,
  resolveSessionForDocument,
  sessionPersistStillCurrent,
} from './session';

const DOC = '11111111-1111-4111-8111-111111111111';

describe('pane/session ids', () => {
  it('accepts opaque pane and session ids', () => {
    expect(isPaneId('pane-a')).toBe(true);
    expect(isPaneId('pane-primary')).toBe(true);
    expect(isPaneId('editor')).toBe(false);
    expect(isSessionId('session-1')).toBe(true);
    expect(isSessionId(DOC)).toBe(false);
  });
});

describe('commandStillCurrent', () => {
  const started = {
    sessionId: 'session-1',
    paneId: 'pane-a',
    paneGeneration: 2,
    sessionGeneration: 5,
  };

  it('allows completion only for the captured routing generations', () => {
    expect(commandStillCurrent(started, started)).toBe(true);
    expect(commandStillCurrent(started, { ...started, paneGeneration: 3 })).toBe(false);
    expect(commandStillCurrent(started, { ...started, sessionId: 'session-2' })).toBe(false);
  });
});

describe('contentCommandStillCurrent', () => {
  const started = {
    sessionId: 'session-1',
    paneId: 'pane-a',
    paneGeneration: 2,
    sessionGeneration: 5,
    contentRevision: 9,
  };

  it('rejects delayed Replace/Convert after intervening edits', () => {
    expect(contentCommandStillCurrent(started, { ...started })).toBe(true);
    expect(contentCommandStillCurrent(started, { ...started, contentRevision: 10 })).toBe(false);
    expect(contentCommandStillCurrent(started, { ...started, paneGeneration: 3 })).toBe(false);
  });
});

describe('sessionPersistStillCurrent', () => {
  it('keeps an in-flight save across active-pane changes', () => {
    const started = { sessionId: 'session-1', sessionGeneration: 3 };
    expect(sessionPersistStillCurrent(started, started)).toBe(true);
    // Pane focus is not part of the persist token — only session identity/role owner.
    expect(sessionPersistStillCurrent(started, { sessionId: 'session-1', sessionGeneration: 3 })).toBe(true);
    expect(sessionPersistStillCurrent(started, { sessionId: 'session-1', sessionGeneration: 4 })).toBe(false);
    expect(sessionPersistStillCurrent(started, { sessionId: 'session-2', sessionGeneration: 3 })).toBe(false);
  });
});

describe('localPaneTransferBlock', () => {
  const clear = {
    sameSession: true,
    targetAlreadyEditable: false,
    composing: false,
    transitioning: false,
    externallyBlocked: false,
  };

  it('allows a same-session transfer when idle', () => {
    expect(localPaneTransferBlock(clear)).toBe('');
  });

  it('refuses composition, busy, external lock and wrong session', () => {
    expect(localPaneTransferBlock({ ...clear, composing: true })).toBe('composing');
    expect(localPaneTransferBlock({ ...clear, transitioning: true })).toBe('busy');
    expect(localPaneTransferBlock({ ...clear, externallyBlocked: true })).toBe('external');
    expect(localPaneTransferBlock({ ...clear, sameSession: false })).toBe('different-session');
    expect(localPaneTransferBlock({ ...clear, targetAlreadyEditable: true })).toBe('already-editable');
  });
});

describe('paneCloseBlock', () => {
  it('blocks close/transfer while composing or transitioning', () => {
    expect(paneCloseBlock({ composing: false, transitioning: false })).toBe('');
    expect(paneCloseBlock({ composing: true, transitioning: false })).toBe('composing');
    expect(paneCloseBlock({ composing: false, transitioning: true })).toBe('busy');
  });
});

describe('paneCloseDisposition', () => {
  it('transfers editable role when another pane still shows the session', () => {
    expect(paneCloseDisposition({
      remainingPanesForSession: 1, dirty: true, autosaveOn: true, saveFailed: false, wasEditable: true,
    })).toBe('transfer-editable');
    expect(paneCloseDisposition({
      remainingPanesForSession: 1, dirty: false, autosaveOn: true, saveFailed: false, wasEditable: false,
    })).toBe('detach-only');
  });

  it('asks before releasing the last dirty or private view', () => {
    expect(paneCloseDisposition({
      remainingPanesForSession: 0, dirty: true, autosaveOn: false, saveFailed: false, wasEditable: true,
    })).toBe('ask-discard');
    expect(paneCloseDisposition({
      remainingPanesForSession: 0, dirty: false, autosaveOn: true, saveFailed: false, wasEditable: true,
    })).toBe('release-clean');
  });
});

describe('resolveSessionForDocument', () => {
  it('reuses the existing session for a document already open in this tab', () => {
    expect(resolveSessionForDocument(DOC, [
      { sessionId: 'session-1', documentId: DOC },
      { sessionId: 'session-2', documentId: '22222222-2222-4222-8222-222222222222' },
    ])).toBe('session-1');
    expect(resolveSessionForDocument('nope', [{ sessionId: 'session-1', documentId: DOC }])).toBeUndefined();
  });
});

describe('commandAllowedOnPane', () => {
  it('routes mutations only to the active editable pane', () => {
    expect(commandAllowedOnPane({
      activePaneId: 'pane-a', targetPaneId: 'pane-a', role: 'editable', mutatesDocument: true,
    })).toBe(true);
    expect(commandAllowedOnPane({
      activePaneId: 'pane-a', targetPaneId: 'pane-a', role: 'readonly', mutatesDocument: true,
    })).toBe(false);
    expect(commandAllowedOnPane({
      activePaneId: 'pane-a', targetPaneId: 'pane-a', role: 'readonly', mutatesDocument: false,
    })).toBe(true);
    expect(commandAllowedOnPane({
      activePaneId: 'pane-a', targetPaneId: 'pane-b', role: 'editable', mutatesDocument: true,
    })).toBe(false);
  });
});
