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

/** The conditions of `when` blocks that render visible, for the example with these input defaults. */
function visibleConditions(extraPrice: number, unlimitedFee: number): string[] {
  const source = exampleSource
    .replace(/input extraPrice = 3 /, `input extraPrice = ${extraPrice} `)
    .replace(/input unlimitedFee = 25 /, `input unlimitedFee = ${unlimitedFee} `);
  const { html, messages } = renderActive(source);
  expect(messages).toEqual([]);
  return [...html.matchAll(/<div\b[^>]*\bdata-active-when="([^"]*)"[^>]*>/g)]
    .filter(([tag]) => !/\shidden(?:[\s=>])/.test(tag!))
    .map(([, condition]) => condition!.replaceAll('&#x3C;', '<').replaceAll('&lt;', '<').replaceAll('&gt;', '>'));
}

describe('the break-even explanation matches the prices (#396 review)', () => {
  it('pairs each condition with its sentence', () => {
    const html = renderActive(exampleSource).html;
    const after = (condition: string) => html.slice(html.search(new RegExp(`data-active-when="${condition.replace('<', '(?:<|&#x3C;|&lt;)').replace('>', '(?:>|&gt;)')}"`)));
    expect(after('extraPrice > 0')).toMatch(/^[^]*?Above about/);
    expect(after('extraPrice <= 0').slice(0, 400)).toContain('Extra data is free');
    expect(after('unlimitedFee <= basicFee').slice(0, 400)).toContain('Unlimited never costs more');
  });

  it.each([
    [3, 25, 'threshold'],
    [0, 25, 'free extra data'],
    [3, 10, 'Unlimited never dearer'],
    [0, 10, 'Unlimited never dearer'],
    [3, 5, 'Unlimited never dearer'],
    [0, 5, 'Unlimited never dearer'],
  ] as const)('extraPrice %d, unlimitedFee %d shows only the %s sentence', (extraPrice, unlimitedFee, expected) => {
    const visible = visibleConditions(extraPrice, unlimitedFee);
    const threshold = visible.includes('unlimitedFee > basicFee') && visible.includes('extraPrice > 0');
    const free = visible.includes('unlimitedFee > basicFee') && visible.includes('extraPrice <= 0');
    const never = visible.includes('unlimitedFee <= basicFee');
    expect({ threshold, free, never }).toEqual({
      threshold: expected === 'threshold',
      free: expected === 'free extra data',
      never: expected === 'Unlimited never dearer',
    });
  });
});
