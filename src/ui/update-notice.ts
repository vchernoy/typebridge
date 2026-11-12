/** Waiting workers activate only after an explicit, safely prepared reload. */
export function watchForUpdates(registration: ServiceWorkerRegistration, deps: {
  prepareReload: () => Promise<boolean>;
  reload: () => void | Promise<void>;
  cancelReload: () => void;
  /** sessionStorage key for dismissal (#175 window scoping). */
  dismissedKey?: string;
  /**
   * Where to mount the notice (#175 host page). When omitted, insert before
   * `main > section` as in the standalone editor.
   */
  mount?: HTMLElement;
  /**
   * Element(s) set `inert` while preparing a reload. Prefer the editor's
   * `main > section` (confirm dialogs append to `body`, so they stay usable).
   * Pass a getter for the host so surfaces are resolved inside each iframe
   * after it loads. `null` / `[]` skips freezing. Arrays cover multi-window hosts (#175).
   */
  freezeSurface?: HTMLElement | HTMLElement[] | null | (() => HTMLElement | HTMLElement[] | null);
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
  function resolveFreezeSurfaces(): HTMLElement[] {
    let value: HTMLElement | HTMLElement[] | null | undefined;
    if (typeof deps.freezeSurface === 'function') value = deps.freezeSurface();
    else if (deps.freezeSurface !== undefined) value = deps.freezeSurface;
    else value = deps.mount ?? defaultWorkspace ?? null;
    if (!value) return [];
    return Array.isArray(value) ? value.filter(Boolean) : [value];
  }
  const DISMISSED = deps.dismissedKey ?? 'typebridge.updateNotice.dismissed.v1';
  let dismissed = false;
  try { dismissed = sessionStorage.getItem(DISMISSED) === 'yes'; } catch { /* Current-page choice still works. */ }
  let waiting: ServiceWorker | null = null;
  function show(worker: ServiceWorker | null): void {
    if (dismissed || !worker || !workerContainer.controller) return;
    // Only a worker that is still waiting is an update. WebKit can deliver the
    // "installed" statechange after a first-visit worker already activated and
    // claimed this page, which showed a spurious notice (#175 / #180).
    if (worker.state !== 'installed' || registration.waiting !== worker) return;
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
  // F6 still moves between host windows (window cycling is navigation, not an action).
  notice.addEventListener('keydown', event => { if (event.key !== 'F6') event.stopPropagation(); });
  reload.addEventListener('click', async () => {
    if (!waiting) return;
    const workspaces = resolveFreezeSurfaces();
    const originalInert = workspaces.map(workspace => workspace.inert);
    for (const workspace of workspaces) workspace.inert = true;
    notice.tabIndex = -1;
    notice.focus();
    reload.disabled = dismiss.disabled = true;
    message.textContent = 'Preparing your work for reload…';
    let navigating = false;
    const restore = (): void => {
      workspaces.forEach((workspace, index) => { workspace.inert = originalInert[index] ?? false; });
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
      await deps.reload();
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
      // Reload/assert may have armed allowUpdateReload in one or more windows before throwing.
      deps.cancelReload();
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
