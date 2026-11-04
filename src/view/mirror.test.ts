import { describe, expect, it } from 'vitest';
import { mirrorTextarea } from './mirror';

function fakeField(value = ''): HTMLTextAreaElement {
  let selectionStart = 0;
  let selectionEnd = 0;
  let selectionDirection: 'forward' | 'backward' | 'none' = 'none';
  let scrollTop = 0;
  let scrollLeft = 0;
  let text = value;
  return {
    get value() { return text; },
    set value(next: string) { text = next; },
    get selectionStart() { return selectionStart; },
    set selectionStart(n: number) { selectionStart = n; },
    get selectionEnd() { return selectionEnd; },
    set selectionEnd(n: number) { selectionEnd = n; },
    get selectionDirection() { return selectionDirection; },
    set selectionDirection(d: 'forward' | 'backward' | 'none') { selectionDirection = d; },
    get scrollTop() { return scrollTop; },
    set scrollTop(n: number) { scrollTop = n; },
    get scrollLeft() { return scrollLeft; },
    set scrollLeft(n: number) { scrollLeft = n; },
    setSelectionRange(start: number, end: number, direction?: 'forward' | 'backward' | 'none') {
      selectionStart = start;
      selectionEnd = end;
      if (direction) selectionDirection = direction;
    },
  } as HTMLTextAreaElement;
}

describe('mirrorTextarea', () => {
  it('copies source text without clobbering target scroll or clamped selection', () => {
    const source = fakeField('hello world');
    const target = fakeField('hello');
    target.selectionStart = 2;
    target.selectionEnd = 4;
    target.selectionDirection = 'forward';
    target.scrollTop = 12;
    target.scrollLeft = 3;
    mirrorTextarea(source, target);
    expect(target.value).toBe('hello world');
    expect(target.selectionStart).toBe(2);
    expect(target.selectionEnd).toBe(4);
    expect(target.scrollTop).toBe(12);
    expect(target.scrollLeft).toBe(3);
  });

  it('clamps selection when the new text is shorter', () => {
    const source = fakeField('hi');
    const target = fakeField('longer text');
    target.selectionStart = 8;
    target.selectionEnd = 10;
    mirrorTextarea(source, target);
    expect(target.value).toBe('hi');
    expect(target.selectionStart).toBe(2);
    expect(target.selectionEnd).toBe(2);
  });

  it('is a no-op when values already match', () => {
    const source = fakeField('same');
    const target = fakeField('same');
    target.selectionStart = 1;
    target.selectionEnd = 3;
    mirrorTextarea(source, target);
    expect(target.selectionStart).toBe(1);
    expect(target.selectionEnd).toBe(3);
  });
});
