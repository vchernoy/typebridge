/** Preferred readable spellings; reverse conversion is not uniquely invertible. */
const latin: Record<string, string> = {
  а:'a', б:'b', в:'v', г:'g', д:'d', е:'e', ё:'yo', ж:'zh', з:'z', и:'i',
  й:'j', к:'k', л:'l', м:'m', н:'n', о:'o', п:'p', р:'r', с:'s', т:'t',
  у:'u', ф:'f', х:'kh', ц:'ts', ч:'ch', ш:'sh', щ:'shch', ъ:'#', ы:'y',
  ь:"'", э:'je', ю:'yu', я:'ya'
};
export function cyrillicToLatin(text: string): string {
  return Array.from(text, char => {
    const lower = char.toLowerCase();
    const converted = latin[lower];
    if (!converted) return char;
    return char !== lower ? converted[0].toUpperCase() + converted.slice(1) : converted;
  }).join('');
}
