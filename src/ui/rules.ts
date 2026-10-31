import { russianPack } from '../core/russian';
import { effectivePack, exportRules, importRules, loadOverrides, saveOverrides, type Overrides } from '../core/custom-rules';
import type { Editor } from '../editor/editor';

/**
 * Transliteration rules panel: edit, save, reset, export and import custom mappings, and
 * push the effective rules to every transliterating field. `targets` is read when rules
 * change, so fields created after setup (the draft title) still receive them.
 */
export function setupRules(targets: () => Editor[]): void {
  function applyRules(): void {
    for (const target of targets()) target.setRules(overrides);
  }
  const rulesText = document.querySelector<HTMLTextAreaElement>('#rules-text')!;
  const rulesStatus = document.querySelector<HTMLElement>('#rules-status')!;
  let overrides: Overrides = loadOverrides();
  function renderRules(): void {
    rulesText.value = effectivePack(overrides).mappings.map(rule => rule.input + ' = ' + rule.output).join('\n');
  }
  function parseRules(text: string): Overrides {
    const proposed: Overrides = Object.create(null) as Overrides;
    const seen = new Set<string>();
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const match = /^\s*([^=]+?)\s*=\s*([^=]+?)\s*$/.exec(line);
      if (!match) throw new Error('Use Latin = Cyrillic, one rule per line');
      const input = match[1].trim(), output = match[2].trim();
      if (seen.has(input)) throw new Error('Duplicate rule: ' + input);
      seen.add(input);
      proposed[input] = output;
    }
    // Missing default rules retain their built-in mapping; explicit edits override it.
    const defaults = new Map(russianPack.mappings.map(rule => [rule.input, rule.output]));
    const changes: Overrides = Object.create(null) as Overrides;
    for (const [input, output] of Object.entries(proposed)) {
      if (defaults.get(input) !== output) changes[input] = output;
    }
    return changes;
  }
  document.querySelector<HTMLButtonElement>('#rules-save')!.addEventListener('click', () => {
    try {
      const next = parseRules(rulesText.value);
      saveOverrides(next);
      overrides = next;
      applyRules();
      renderRules();
      rulesStatus.textContent = 'Rules saved locally';
    } catch (error) { rulesStatus.textContent = error instanceof Error ? error.message : 'Invalid rules'; }
  });
  document.querySelector<HTMLButtonElement>('#rules-reset')!.addEventListener('click', () => {
    try { saveOverrides({}); overrides = {}; applyRules(); renderRules(); rulesStatus.textContent = 'Default rules restored'; }
    catch { rulesStatus.textContent = 'Unable to save rules'; }
  });
  document.querySelector<HTMLButtonElement>('#rules-export')!.addEventListener('click', () => {
    const blob = new Blob([exportRules(overrides)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = 'typebridge-rules.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  document.querySelector<HTMLInputElement>('#rules-import')!.addEventListener('change', async event => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > 65536) throw new Error('Rules file is too large');
      const next = importRules(await file.text());
      saveOverrides(next); overrides = next; applyRules(); renderRules();
      rulesStatus.textContent = 'Rules imported';
    } catch (error) { rulesStatus.textContent = error instanceof Error ? error.message : 'Import failed'; }
    finally { input.value = ''; }
  });
  renderRules();
}
