import { exportStandalone } from './document';
const source = document.querySelector<HTMLTextAreaElement>('#source')!;
const title = document.querySelector<HTMLInputElement>('#title')!;
const format = document.querySelector<HTMLSelectElement>('#format')!;
const status = document.querySelector<HTMLElement>('#status')!;
const binary = atob(document.querySelector('#template')!.textContent!);
const template = new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
source.value = '# Offline calculator\n\n```calc\ninput x = 2 in 0..10\ny = x * 3\n```\n\n:slider[Amount]{input=x step=1}\n\nResult: :value[y]\n\n$y={{y}}$\n\nUnicode: café 日本語 🖥️';
document.querySelector('#download')!.addEventListener('click', () => {
  try {
    if (format.value !== 'plain' && format.value !== 'markdown') throw new Error('Invalid format');
    const html = exportStandalone(template, { title: title.value, text: source.value, format: format.value });
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'document.html'; link.click();
    // Give the browser its normal download turn before retiring this URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = 'Downloaded one self-contained HTML. Its controls start at source defaults.';
  } catch {
    status.textContent = 'Could not export: check the title (150 characters) and document size (2 MB).';
  }
});
