/** Keep fraction fences at least as tall as their enclosed layout boxes.
 * Native MathML engines can choose a variant shorter than the fraction's
 * layout box. Use MathML's own minimum size,
 * leaving glyph selection and stretching to the engine. */
export function fitFractionFences(root: ParentNode = document.body, owned = new WeakSet<Element>()): void {
  // Inner groups must settle before an outer group is measured.
  for (const row of Array.from(root.querySelectorAll('math mrow')).reverse()) {
    const children = Array.from(row.children);
    if (!row.querySelector('mfrac')) continue;
    const fences = children.filter(node => node.localName === 'mo' && node.getAttribute('fence') === 'true');
    const content = children.filter(node => !fences.includes(node));
    if (!fences.length || !content.length) continue;
    const rects = content.map(node => node.getBoundingClientRect());
    const height = Math.ceil(Math.max(...rects.map(rect => rect.bottom)) - Math.min(...rects.map(rect => rect.top)));
    if (height <= 0) continue;
    for (const fence of fences) {
      // Respect explicit sizes emitted for authored constructs such as \bigl.
      if (fence.hasAttribute('maxsize') || (fence.hasAttribute('minsize') && !owned.has(fence))) continue;
      const minimum = `${height}px`;
      if (fence.getAttribute('minsize') !== minimum) fence.setAttribute('minsize', minimum);
      owned.add(fence);
    }
  }
}
