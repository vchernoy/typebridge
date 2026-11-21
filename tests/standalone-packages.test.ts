import { expect, it } from 'vitest';
// Build-only JavaScript helper; not imported by the browser application.
// @ts-expect-error The build script has no TypeScript declaration file.
import { bundledPackageRoot } from '../scripts/standalone-packages.mjs';

it('retains nested package roots and distinct installed versions', () => {
  const roots = new Set([
    '/project/node_modules/escape-string-regexp/index.js',
    '/project/node_modules/mdast-util-find-and-replace/node_modules/escape-string-regexp/index.js',
    '/project/node_modules/mdast-util-find-and-replace/node_modules/escape-string-regexp/other.js',
  ].map(bundledPackageRoot));
  expect([...roots]).toEqual([
    '/project/node_modules/escape-string-regexp',
    '/project/node_modules/mdast-util-find-and-replace/node_modules/escape-string-regexp',
  ]);
});

it('handles scoped, pnpm-style and Windows-normalized module paths', () => {
  expect(bundledPackageRoot('/project/node_modules/@scope/outer/node_modules/@other/pkg/lib/a.js')).toBe('/project/node_modules/@scope/outer/node_modules/@other/pkg');
  expect(bundledPackageRoot('/project/node_modules/.pnpm/pkg@2/node_modules/pkg/index.js')).toBe('/project/node_modules/.pnpm/pkg@2/node_modules/pkg');
  expect(bundledPackageRoot('C:\\project\\node_modules\\@scope\\pkg\\index.js')).toBe('C:/project/node_modules/@scope/pkg');
  expect(bundledPackageRoot('/project/src/index.ts')).toBeUndefined();
  expect(bundledPackageRoot('\0/project/node_modules/pkg/virtual')).toBeUndefined();
});
