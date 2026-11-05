import { describe, expect, it } from 'vitest';
import {
  commandAllowedOnPane,
  commandStillCurrent,
  contentCommandStillCurrent,
  isPaneId,
  isSessionId,
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
  it('keeps an in-flight save across focus changes within the same session', () => {
    const started = { sessionId: 'session-1', sessionGeneration: 3 };
    expect(sessionPersistStillCurrent(started, started)).toBe(true);
    expect(sessionPersistStillCurrent(started, { sessionId: 'session-1', sessionGeneration: 3 })).toBe(true);
    expect(sessionPersistStillCurrent(started, { sessionId: 'session-1', sessionGeneration: 4 })).toBe(false);
    expect(sessionPersistStillCurrent(started, { sessionId: 'session-2', sessionGeneration: 3 })).toBe(false);
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
