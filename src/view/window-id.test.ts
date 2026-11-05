import { describe, expect, it } from 'vitest';
import {
  isWindowId,
  parseWindowId,
  scopeSessionKey,
  writingPositionNamespace,
} from './window-id';

describe('window id', () => {
  it('accepts opaque host-assigned ids', () => {
    expect(isWindowId('a')).toBe(true);
    expect(isWindowId('window-1')).toBe(true);
    expect(isWindowId('W')).toBe(true);
    expect(isWindowId('')).toBe(false);
    expect(isWindowId('-bad')).toBe(false);
    expect(isWindowId('has space')).toBe(false);
    expect(isWindowId('x'.repeat(65))).toBe(false);
  });

  it('parses ?window= and ignores invalid values', () => {
    expect(parseWindowId('?window=alpha')).toBe('alpha');
    expect(parseWindowId('window=beta&mode=view')).toBe('beta');
    expect(parseWindowId('')).toBeUndefined();
    expect(parseWindowId('?doc=x')).toBeUndefined();
    expect(parseWindowId('?window=')).toBeUndefined();
    expect(parseWindowId('?window=bad id')).toBeUndefined();
  });

  it('scopes session keys only when a window id is present', () => {
    expect(scopeSessionKey('typebridge.activeDraft.v1', undefined)).toBe('typebridge.activeDraft.v1');
    expect(scopeSessionKey('typebridge.activeDraft.v1', 'a')).toBe('typebridge.activeDraft.v1::w:a');
    expect(scopeSessionKey('typebridge.pendingDraft.v1', 'b')).toBe('typebridge.pendingDraft.v1::w:b');
  });

  it('builds writing-position namespaces for window and viewer', () => {
    expect(writingPositionNamespace(undefined, false)).toBe('');
    expect(writingPositionNamespace(undefined, true)).toBe('view:');
    expect(writingPositionNamespace('a', false)).toBe('w:a.');
    expect(writingPositionNamespace('a', true)).toBe('w:a.view:');
  });
});
