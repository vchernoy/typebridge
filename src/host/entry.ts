/**
 * Host page entry. `/` forwards pre-cutover editor links to /editor.html (inline script in
 * index.html); the host must not start windows, layout or the service worker on the way out.
 */
if (document.documentElement.dataset.forwarding !== '1') {
  void import('./main');
}
