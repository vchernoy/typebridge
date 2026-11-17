/** Derived received-link groups only. No decoding, sidecar reads, storage or rendering. */
import type { SharedItem } from './shared-library';
import type { SharedDocument } from './share-link';

export type ReceivedDocument = { readonly item: Readonly<SharedItem>; readonly document: Readonly<SharedDocument> };
export type SharedVariant = ReceivedDocument & { readonly ordinal: number };
export type SharedGroup = {
  readonly title: string; readonly text: string; readonly format: string;
  readonly variants: readonly SharedVariant[];
};
export type SharedGroupMatch = { readonly group: SharedGroup; readonly variants: readonly SharedVariant[] };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Already validated/decoded records from the bounded library; references stay unchanged. */
export function groupSharedDocuments(records: readonly ReceivedDocument[]): SharedGroup[] {
  const groups: { title: string; text: string; format: string; variants: SharedVariant[] }[] = [];
  for (const record of records) {
    const { title, text, format } = record.document;
    // Full equality avoids delimiter/hash collisions and title/source normalization.
    // The library is bounded to 100 items; no duplicate full-source key is needed.
    let group = groups.find(g => g.title === title && g.text === text && g.format === format);
    if (!group) { group = { title, text, format, variants: [] }; groups.push(group); }
    group.variants.push({ ...record, ordinal: 0 });
  }
  for (const group of groups) {
    group.variants.sort((a, b) => a.item.createdAt - b.item.createdAt || compare(a.item.id, b.item.id));
    group.variants = group.variants.map((variant, index) => ({ ...variant, ordinal: index + 1 }));
    group.variants.sort((a, b) => b.item.lastOpenedAt - a.item.lastOpenedAt
      || b.item.createdAt - a.item.createdAt || compare(a.item.id, b.item.id));
  }
  return groups.sort((a, b) => b.variants[0].item.lastOpenedAt - a.variants[0].item.lastOpenedAt
    || compare(a.title, b.title) || compare(a.text, b.text) || compare(a.format, b.format));
}

/** Labels describe incoming intent, never the recipient's accepted/local numeric state. */
export function sharedVariantHints(document: Readonly<SharedDocument>): string {
  return [document.view === 'rendered' ? 'Rendered' : 'Source', document.edit ? 'Editing allowed' : 'Read only',
    document.heading === false ? 'Heading hidden' : 'Heading shown'].join(' · ');
}

/** Match immutable incoming fields only; retain original group membership and ordinals. */
export function searchSharedGroups(groups: readonly SharedGroup[], query: string): SharedGroupMatch[] {
  const needle = query.toLowerCase();
  const matches = (value: string) => value.toLowerCase().includes(needle);
  return groups.flatMap(group => {
    // Test fields independently: separators must not create cross-field matches.
    const wholeGroup = [group.title, group.text, group.format].some(matches);
    const variants = wholeGroup ? group.variants : group.variants.filter(({ document }) => {
      const pairs = document.inputs?.values ?? [];
      return matches(sharedVariantHints(document)) || (pairs.length === 0 && matches('Authored defaults'))
        || pairs.some(([name, value]) => matches(name) || matches(String(value)) || matches(`${name} = ${value}`));
    });
    return variants.length ? [{ group, variants }] : [];
  });
}
