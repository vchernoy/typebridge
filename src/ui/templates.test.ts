import { describe, expect, it } from 'vitest';
import { renderActive } from '@vchernoy/remark-active';
import { DOCUMENT_TEMPLATES } from './templates';

describe('document templates (#390)', () => {
  it.each(DOCUMENT_TEMPLATES.map(template => [template.id, template] as const))('%s renders without problems and is interactive', (_id, template) => {
    expect(template.format).toBe('markdown');
    const result = renderActive(template.text);
    expect(result.messages).toEqual([]);
    expect(result.html).toContain('data-active-input=');
    expect(template.text.startsWith(`# ${template.id === 'lesson' ? 'The area of a circle' : template.title}`)).toBe(true);
  });

  it('has unique ids and titles', () => {
    expect(new Set(DOCUMENT_TEMPLATES.map(t => t.id)).size).toBe(DOCUMENT_TEMPLATES.length);
    expect(new Set(DOCUMENT_TEMPLATES.map(t => t.title)).size).toBe(DOCUMENT_TEMPLATES.length);
  });
});
