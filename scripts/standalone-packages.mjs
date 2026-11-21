/** Retain the owning package location, including nested/scoped/versioned installs. */
export function bundledPackageRoot(id) {
  if (id.includes('\0')) return undefined;
  const path = id.replaceAll('\\', '/');
  const marker = '/node_modules/';
  const index = path.lastIndexOf(marker);
  if (index < 0) return undefined;
  const start = index + marker.length;
  const parts = path.slice(start).split('/');
  const count = parts[0]?.startsWith('@') ? 2 : 1;
  if (parts.length < count || parts.slice(0, count).some(part => !part || part === '.' || part === '..')) return undefined;
  return path.slice(0, start) + parts.slice(0, count).join('/');
}
