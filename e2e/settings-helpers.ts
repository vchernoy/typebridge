import { expect, type FrameLocator, type Page } from '@playwright/test';

/**
 * Fill an embedded host-window editor.
 * Firefox: Playwright's first `fill` into a fresh iframe can no-op, and a real click
 * can time out when another host window's iframe intercepts pointer events. Setting
 * the value in-page and dispatching `input` matches what the editor listens for.
 */
export async function fillHostEditor(frame: FrameLocator, text: string, selector = '#editor'): Promise<void> {
  const field = frame.locator(selector);
  await field.evaluate((el, value) => {
    const input = el as HTMLTextAreaElement | HTMLInputElement;
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await expect(field).toHaveValue(text);
}

/** Settings live in a side panel (#123); these drive it the way a user would. */
export async function openSettings(page: Page): Promise<void> {
  const panel = page.locator('#settings-panel');
  if (await panel.isHidden()) await page.locator('#settings-open').click();
  await expect(panel).toBeVisible();
}

export async function closeSettings(page: Page): Promise<void> {
  const panel = page.locator('#settings-panel');
  if (await panel.isVisible()) await page.locator('#settings-close').click();
  await expect(panel).toBeHidden();
}

/** Open Settings, set a checkbox, and close the panel again. */
export async function setSetting(page: Page, selector: string, on: boolean): Promise<void> {
  await openSettings(page);
  const box = page.locator(selector);
  if (on) await box.check(); else await box.uncheck();
  await closeSettings(page);
}

/**
 * Per-document Autosave checkbox in the editor chrome (#257).
 * Unchecked marks the shown document private. No delete-saved-copy prompt in step 1
 * (clear local data is a later step). The optional third argument is ignored for
 * call-site compatibility with older Keep/Delete flows.
 */
export async function setAutosave(
  page: Page,
  on: boolean,
  _offChoice: 'keep' | 'delete' = 'keep',
): Promise<void> {
  void _offChoice;
  const box = page.locator('#autosave');
  await expect(box).toBeEnabled();
  if (on) await box.check();
  else await box.uncheck();
  await expect(box).toBeChecked({ checked: on });
  // Going private may briefly keep the control disabled while an in-flight save finishes.
  await expect(box).toBeEnabled({ timeout: 15_000 });
}

/**
 * Global private session in Settings (`typebridge.autosave.v1`, inverted: on = save nothing).
 * Used by standalone and host pages (#257).
 */
export async function setPrivateSession(page: Page, on: boolean): Promise<void> {
  await openSettings(page);
  const box = page.locator('#private-session');
  if (on) await box.check();
  else await box.uncheck();
  await expect.poll(async () => page.evaluate(() => {
    return localStorage.getItem('typebridge.autosave.v1') === 'off';
  })).toBe(on);
  await closeSettings(page);
}

/**
 * #175 / #257: host Settings private session. `on` true means Autosave/saving is enabled
 * (private session off), matching the historical setHostAutosave(true) meaning.
 */
export async function setHostAutosave(page: Page, on: boolean): Promise<void> {
  await openSettings(page);
  const box = page.locator('#private-session');
  // private-session checked = save nothing = historical Autosave off.
  if (on) await box.uncheck();
  else await box.check();
  await expect.poll(async () => page.evaluate(() => {
    const raw = localStorage.getItem('typebridge.autosave.v1');
    return raw !== 'off';
  })).toBe(on);
  // Confirm every live editor iframe mirrored the shared preference onto its per-doc checkbox
  // (new/non-private docs follow the session).
  await expect.poll(async () => page.evaluate(want => {
    const frames = [...document.querySelectorAll<HTMLIFrameElement>('iframe.host-editor')];
    if (frames.length === 0) return false;
    return frames.every(frame => {
      try {
        return frame.contentDocument?.querySelector<HTMLInputElement>('#autosave')?.checked === want;
      } catch {
        return false;
      }
    });
  }, on)).toBe(true);
  await closeSettings(page);
}

/** Find and Go to line open on demand (#123, step 2). */
export async function openFind(page: Page): Promise<void> {
  const bar = page.locator('#find-bar');
  if (await bar.isHidden()) await page.locator('#find-open').click();
  await expect(bar).toBeVisible();
}

export async function openGoto(page: Page): Promise<void> {
  const bar = page.locator('#goto-bar');
  if (await bar.isHidden()) await moreAction(page, '#goto-open');
  await expect(bar).toBeVisible();
}

/** The document list and its actions live in the ▾ document menu (#123, step 3). */
export async function openDocuments(page: Page): Promise<void> {
  const panel = page.locator('#doc-menu');
  if (await panel.isHidden()) await page.locator('#doc-menu-open').click();
  await expect(panel).toBeVisible();
}

export async function closeDocuments(page: Page): Promise<void> {
  const panel = page.locator('#doc-menu');
  // ▾ toggles the menu. If the app closes it between the visibility check and the click
  // (e.g. a document switch finishing), the click reopens it (#155): check and retry.
  await expect(async () => {
    if (await panel.isVisible()) await page.locator('#doc-menu-open').click();
    await expect(panel).toBeHidden({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
}

/** Open the menu, pick a document (by value or { label }), and close the menu. */
export async function selectDocument(page: Page, value: string | { label: string }): Promise<void> {
  await openDocuments(page);
  if (typeof value === 'string') {
    await page.locator('#drafts').selectOption(value);
  } else {
    // #175 step 8 labels include preview/time; match the title prefix.
    const prefix = value.label;
    const optionValue = await page.locator('#drafts option').evaluateAll((options, want) => {
      const match = options.find(option => {
        const text = option.textContent ?? '';
        return text === want || text.startsWith(`${want} (`) || text.startsWith(`${want} ·`);
      });
      return match?.getAttribute('value') ?? '';
    }, prefix);
    if (!optionValue) throw new Error(`Document option not found for ${prefix}`);
    await page.locator('#drafts').selectOption(optionValue);
  }
  await closeDocuments(page);
}

/** Open the menu and click one of its actions; the action closes the menu. */
export async function documentAction(page: Page, selector: string): Promise<void> {
  await openDocuments(page);
  await page.locator(selector).click();
}

/** Open the toolbar's ⋯ menu and choose an item (#123, step 4); the item closes the menu. */
export async function moreAction(page: Page, selector: string): Promise<void> {
  const menu = page.locator('#more-menu');
  if (await menu.isHidden()) await page.locator('#more-open').click();
  await expect(menu).toBeVisible();
  await page.locator(selector).click();
}

/** Arm before an action that opens an in-page confirmation, as with native dialog handlers. */
export async function answerNextConfirmation(page: Page, accept: boolean, delay = 0): Promise<void> {
  const dialog = page.locator('.confirm-dialog');
  await expect(dialog).toBeVisible();
  if (delay) await page.waitForTimeout(delay);
  await dialog.getByRole('button').nth(accept ? 1 : 0).click();
  await expect(dialog).toHaveCount(0);
}
