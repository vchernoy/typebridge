/** Lazy Share preparation boundary; callers must supply the captured source explicitly. */
import { renderActive } from '@vchernoy/remark-active';
import { mount } from '@vchernoy/active-runtime';
import katex from 'katex';
import { inspectInputSnapshot, type InputSnapshot } from '../editor/input-snapshot';

/** Apply supported model/control validation without mounting a visible document or touching storage. */
export function compatibleInputSnapshot(source: string, locale: string, candidate: unknown): InputSnapshot | undefined {
  const checked = inspectInputSnapshot(candidate);
  if (!checked.ok) return;
  const rendered = renderActive(source, { locale });
  if (rendered.messages.some(message => message.severity === 'error')) return;
  const root = document.createElement('div');
  // Only sanitized package output crosses this boundary; the root is never attached.
  root.innerHTML = rendered.html;
  const live = mount(root, { locale, initialInputs: new Map(checked.snapshot.values), loadKatex: async () => katex });
  try {
    const accepted = inspectInputSnapshot({ version: 1, values: [...live.session.inputValues()] });
    return accepted.ok ? accepted.snapshot : undefined;
  } finally { live.destroy(); }
}
