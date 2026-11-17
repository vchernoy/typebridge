import { describe, expect, it } from 'vitest';
import { groupSharedDocuments, searchSharedGroups, sharedVariantHints, type ReceivedDocument } from './shared-groups';
import type { SharedDocument } from './share-link';
function received(id: string, fields: Partial<SharedDocument> = {}, opened = 1, created = 1): ReceivedDocument {
  return { item: { id, digest: id, payload: 'original-' + id, bytes: 10, createdAt: created, lastOpenedAt: opened },
    document: { title: 'Loan', text: 'Authored source', format: 'markdown', view: 'rendered', edit: false, ...fields } };
}
describe('exact received-document groups', () => {
  it('keeps input/presentation variants together and preserves every original link and object', () => {
    const records = [received('a'), received('b', { view: 'source', edit: true, heading: false, inputs: { version: 1, values: [['rate', 7]] } })];
    const before = structuredClone(records);
    const groups = groupSharedDocuments(records);
    expect(groups).toHaveLength(1); expect(groups[0].variants).toHaveLength(2);
    expect(groups[0].variants.map(v => v.item.payload)).toEqual(['original-a', 'original-b']);
    expect(groups[0].variants[0].document).toBe(records[0].document);
    expect(groups[0].variants[1].item).toBe(records[1].item);
    expect(records).toEqual(before);
  });
  it.each([
    { title: 'Loan ' }, { title: 'loan' }, { title: 'Loan\n' },
    { text: 'Authored source ' }, { text: 'Authored  source' }, { text: 'Authored source.' },
    { format: 'plain' }, { format: 'future-format' },
  ])('does not normalize distinct grouping fields: %j', fields => {
    expect(groupSharedDocuments([received('a'), received('b', fields)])).toHaveLength(2);
  });
  it('does not collide on delimiters or normalize Unicode/empty titles', () => {
    const records = [received('a', { title: 'a\nb', text: 'c' }), received('b', { title: 'a', text: 'b\nc' }),
      received('c', { title: '' }), received('d', { title: ' ' }),
      received('e', { title: 'é' }), received('f', { title: 'e\u0301' })];
    expect(groupSharedDocuments(records)).toHaveLength(records.length);
  });
  it('preserves unknown formats and groups only the same exact unknown format', () => {
    const groups = groupSharedDocuments([received('a', { format: 'future' }), received('b', { format: 'future' }), received('c', { format: 'other' })]);
    expect(groups.find(g => g.format === 'future')?.variants).toHaveLength(2);
    expect(groups).toHaveLength(2);
  });
  it('orders by recency while ordinals remain based on creation and stable identity', () => {
    const old = received('a', {}, 50, 1), newer = received('b', {}, 100, 2), other = received('c', { title: 'Other' }, 75, 0);
    const groups = groupSharedDocuments([other, newer, old]);
    expect(groups.map(g => g.title)).toEqual(['Loan', 'Other']);
    expect(groups[0].variants.map(v => [v.item.id, v.ordinal])).toEqual([['b', 2], ['a', 1]]);
    const reopened = groupSharedDocuments([{ ...old, item: { ...old.item, lastOpenedAt: 150 } }, newer, other]);
    expect(reopened[0].variants.map(v => [v.item.id, v.ordinal])).toEqual([['a', 1], ['b', 2]]);
  });
  it('resolves all ties deterministically regardless of incoming order', () => {
    const records = [received('b'), received('a'), received('z', { title: 'Another' })];
    expect(groupSharedDocuments(records)).toEqual(groupSharedDocuments([...records].reverse()));
    expect(groupSharedDocuments(records)[1].variants.map(v => v.item.id)).toEqual(['a', 'b']);
  });
  it('accepts empty collections without phantom groups', () => expect(groupSharedDocuments([])).toEqual([]));
});
describe('incoming-only group search', () => {
  const records = [received('a', { inputs: { version: 1, values: [['rate', 0.05], ['seed', 7]] } }),
    received('b', { view: 'source', edit: true, heading: false, inputs: { version: 1, values: [['rate', 0.07], ['seed', 11]] } }),
    received('c', { title: 'Other', text: 'Other source', format: 'plain', inputs: { version: 1, values: [] } })];
  it('finds all variants on title/source/format matches, including case-insensitive search', () => {
    for (const query of ['', 'LOAN', 'Authored source', 'MARKDOWN']) {
      const found = searchSharedGroups(groupSharedDocuments(records), query);
      expect(found[0].variants).toHaveLength(2);
    }
  });
  it('filters parameter-only matches without turning a multi-variant group into a singleton', () => {
    const groups = groupSharedDocuments(records);
    const found = searchSharedGroups(groups, 'SEED = 11');
    expect(found).toHaveLength(1); expect(found[0].group).toBe(groups[0]);
    expect(found[0].group.variants).toHaveLength(2);
    expect(found[0].variants.map(v => [v.item.id, v.ordinal])).toEqual([['b', 2]]);
    expect(searchSharedGroups(groups, '0.05')[0].variants[0].item.id).toBe('a');
  });
  it('searches displayed presentation/default labels, but never payloads or item metadata', () => {
    const groups = groupSharedDocuments(records);
    expect(searchSharedGroups(groups, 'heading hidden')[0].variants[0].item.id).toBe('b');
    expect(searchSharedGroups(groups, 'editing allowed')[0].variants[0].item.id).toBe('b');
    expect(searchSharedGroups(groups, 'Authored defaults')[0].group.title).toBe('Other');
    expect(searchSharedGroups(groups, 'original-a')).toEqual([]);
    expect(searchSharedGroups(groups, 'not a match')).toEqual([]);
  });
  it('does not search extra recipient-local properties or read any application state', () => {
    const withLocal = { ...records[0], localInputs: [['privateSearchMarker', 999]] };
    expect(searchSharedGroups(groupSharedDocuments([withLocal]), 'privateSearchMarker')).toEqual([]);
    expect(searchSharedGroups(groupSharedDocuments([withLocal]), '999')).toEqual([]);
  });
  it('does not mutate frozen records, groups or search results', () => {
    const groups = groupSharedDocuments(records);
    for (const group of groups) { Object.freeze(group.variants); Object.freeze(group); }
    Object.freeze(groups);
    expect(() => searchSharedGroups(groups, 'seed')).not.toThrow();
    expect(groups[0].variants).toHaveLength(2);
  });
  it('uses old-link heading defaults and literal matching rather than regular expressions', () => {
    expect(sharedVariantHints(records[0].document)).toBe('Rendered · Read only · Heading shown');
    expect(searchSharedGroups(groupSharedDocuments(records), '.*')).toEqual([]);
  });
});
