/** Waiting workers activate only after an explicit, safely prepared reload. */
export function watchForUpdates(registration: ServiceWorkerRegistration, deps: {
  prepareReload: () => Promise<boolean>;
  reload: () => void;
  cancelReload: () => void;
  /** sessionStorage key for dismissal (#175 window scoping). */
  dismissedKey?: string;
  /**
   * Where to mount the notice (#175 host page). When omitted, insert before
   * `main > section` as in the standalone editor.
   */
  mount?: HTMLElement;
  /**
   * Element set `inert` while preparing a reload. Prefer the editor's
   * `main > section` (confirm dialogs append to `body`, so they stay usable).
   * Pass a getter for the host so the surface is resolved inside the iframe
   * after it loads. `null` skips freezing.
   */
  freezeSurface?: HTMLElement | null | (() => HTMLElement | null);
}): void {
  const workerContainer = navigator.serviceWorker;
  const notice = document.createElement('div');
  notice.id = 'update-notice';
  notice.className = 'update-notice';
  notice.hidden = true;
  const message = document.createElement('span');
  message.setAttribute('role', 'status');
  const reload = document.createElement('button');
  reload.id = 'update-reload';
  reload.type = 'button';
  reload.textContent = 'Reload';
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = 'Not now';
  notice.append(message, reload, dismiss);
  const defaultWorkspace = document.querySelector<HTMLElement>('main > section');
  if (deps.mount) deps.mount.prepend(notice);
  else defaultWorkspace?.before(notice);
  function resolveFreezeSurface(): HTMLElement | null {
    if (typeof deps.freezeSurface === 'function') return deps.freezeSurface();
    if (deps.freezeSurface !== undefined) return deps.freezeSurface;
    return deps.mount ?? defaultWorkspace ?? null;
  }
  const DISMISSED = deps.dismissedKey ?? 'typebridge.updateNotice.dismissed.v1';
  let dismissed = false;
  try { dismissed = sessionStorage.getItem(DISMISSED) === 'yes'; } catch { /* Current-page choice still works. */ }
  let waiting: ServiceWorker | null = null;
  function show(worker: ServiceWorker | null): void {
    if (dismissed || !worker || !workerContainer.controller) return;
    waiting = worker;
    message.textContent = 'New version available';
    notice.hidden = false;
  }
  function watchInstalling(): void {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed') show(registration.waiting ?? installing);
    });
  }
  show(registration.waiting);
  watchInstalling();
  registration.addEventListener('updatefound', watchInstalling);
  dismiss.addEventListener('click', () => {
    dismissed = true;
    notice.hidden = true;
    try { sessionStorage.setItem(DISMISSED, 'yes'); } catch { /* Remains dismissed on this page. */ }
  });
  // Keep application shortcuts from acting behind this notice while it owns focus.
  notice.addEventListener('keydown', event => event.stopPropagation());
  reload.addEventListener('click', async () => {
    if (!waiting) return;
    const workspace = resolveFreezeSurface();
    const originalInert = workspace ? workspace.inert : false;
    if (workspace) workspace.inert = true;
    notice.tabIndex = -1;
    notice.focus();
    reload.disabled = dismiss.disabled = true;
    message.textContent = 'Preparing your work for reload…';
    let navigating = false;
    const restore = (): void => {
      if (workspace) workspace.inert = originalInert;
      reload.disabled = dismiss.disabled = false;
      reload.focus({ preventScroll: true });
    };
    try {
      if (!await deps.prepareReload()) {
        message.textContent = 'Update is waiting. Keep editing, or copy/export your work before reloading.';
        return;
      }
      message.textContent = 'Installing update…';
      await activateWaitingWorker(waiting, workerContainer);
      deps.reload();
      navigating = true;
      // If navigation was canceled or stalls, stop it before allowing new edits.
      // Successful navigation destroys this page and its timer.
      setTimeout(() => {
        window.stop();
        deps.cancelReload();
        message.textContent = 'Reload did not finish. Your text is kept; retry when ready.';
        restore();
      }, 10_000);
    } catch {
      message.textContent = 'Could not reload safely. Your text is kept; copy or export it, then retry.';
    } finally {
      if (!navigating) restore();
    }
  });
}

function activateWaitingWorker(worker: ServiceWorker, container: ServiceWorkerContainer): Promise<void> {
  if (worker.state === 'activated') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timeout);
      container.removeEventListener('controllerchange', activated);
      worker.removeEventListener('statechange', stateChanged);
    };
    const activated = (): void => { cleanup(); resolve(); };
    const stateChanged = (): void => {
      if (worker.state === 'activated') activated();
      else if (worker.state === 'redundant') { cleanup(); reject(new Error('Update became unavailable')); }
    };
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Update activation timed out')); }, 10_000);
    container.addEventListener('controllerchange', activated);
    worker.addEventListener('statechange', stateChanged);
    try { worker.postMessage({ type: 'SKIP_WAITING' }); }
    catch (error) { cleanup(); reject(error); }
  });
}
