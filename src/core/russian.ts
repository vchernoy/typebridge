import type { LanguagePack } from './language-pack';

const pairs = [
  ['a','а'],['b','б'],['v','в'],['w','щ'],['g','г'],['d','д'],['e','е'],['yo','ё'],['jo','ё'],['zh','ж'],['z','з'],['i','и'],['j','й'],['k','к'],['l','л'],['m','м'],['n','н'],['o','о'],['p','п'],['r','р'],['s','с'],['t','т'],['u','у'],['f','ф'],['h','х'],['x','х'],['kh','х'],['c','ц'],['ts','ц'],['ch','ч'],['sh','ш'],['sch','щ'],['shch','щ'],['shh','щ'],['y','ы'],["'",'ь'],['#','ъ'],['je','э'],['yu','ю'],['ju','ю'],['ya','я'],['ja','я'],['q','я'],
] as const;

export const russianPack: LanguagePack = {
  id: 'ru-informal', version: 1, sourceScript: 'Latn', targetScript: 'Cyrl', separator: '+', casePolicy: 'first-letter',
  mappings: pairs.map(([input, output]) => ({ input, output })),
};
