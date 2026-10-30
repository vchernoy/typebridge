/** Expand replacement tokens using JavaScript String.replace capture semantics. */
export function expandReplacement(replacement: string, match: RegExpExecArray, original: string): string {
  return replacement.replace(/\$\$|\$&|\$`|\$'|\$<([^>]+)>|\$(\d{1,2})/g, (token, name: string | undefined, index: string | undefined) => {
    if (token === '$$') return '$';
    if (token === '$&') return match[0];
    if (token === '$`') return original.slice(0, match.index);
    if (token === "$'") return original.slice(match.index + match[0].length);
    if (name !== undefined) return match.groups ? match.groups[name] ?? '' : token;
    if (index !== undefined) {
      const n = Number(index);
      if (n > 0 && n < match.length) return match[n] ?? '';
      // $12 means capture 1 followed by "2" when capture 12 does not exist.
      const first = Number(index[0]);
      if (index.length === 2 && first > 0 && first < match.length) return (match[first] ?? '') + index[1];
    }
    return token;
  });
}
