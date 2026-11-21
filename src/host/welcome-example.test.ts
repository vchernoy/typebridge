import { describe, expect, it } from 'vitest';
import { renderActive } from '@vchernoy/remark-active';
import exampleSource from './welcome-example.md?raw';

describe('first-run welcome example (#390)', () => {
  it('renders without problems and is interactive', () => {
    const result = renderActive(exampleSource);
    expect(result.messages).toEqual([]);
    expect(result.html).toContain('data-active-input="gb"');
    expect(result.html).toContain('Which phone plan is cheaper?');
  });

  it('does not tell a reader to paste it into TypeBridge', () => {
    expect(exampleSource).not.toContain('Paste this document');
  });
});
