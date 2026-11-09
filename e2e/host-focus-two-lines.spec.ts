import { expect, test, type FrameLocator, type Page } from "@playwright/test";

/**
 * Host Focus takes two lines (#175 follow-up): the focused window's title bar carries the
 * brand, title, ✎, the shared Latin/Кириллица switch and ⚙ Settings; the window shows one
 * ▾ / Saved / Exit row. The host toolbar, move grip and × hide; the switch and Settings
 * return to the host toolbar on exit.
 */

async function openHost(page: Page, width = 1280): Promise<FrameLocator> {
  await page.setViewportSize({ width, height: 800 });
  await page.addInitScript(() => {
    localStorage.setItem("typebridge.host.layoutMode.v1", "free");
  });
  await page.goto("/");
  const main = page.frameLocator('.host-window[data-window-id="main"] iframe');
  await expect(main.locator("#editor")).toBeEnabled({ timeout: 30_000 });
  return main;
}

async function enterFocus(page: Page, frame: FrameLocator): Promise<void> {
  await frame.locator("#focus-mode").evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator("body")).toHaveClass(/host-focus-mode/);
  await expect(frame.locator("#exit-focus")).toBeVisible();
}

test("host Focus shows the title bar and one control row, with Settings as an icon", async ({ page }) => {
  const main = await openHost(page);
  await enterFocus(page, main);
  const shell = page.locator('.host-window[data-window-id="main"]');
  const titleBar = shell.locator(".host-window-titlebar");

  await expect(page.locator("#host-toolbar")).toBeHidden();
  await expect(titleBar.locator(".brand")).toBeVisible();
  await expect(titleBar.locator(".host-window-title")).toBeVisible();
  await expect(titleBar.locator(".host-window-rename")).toBeVisible();
  await expect(titleBar.locator("#host-enabled")).toBeVisible();
  const settings = titleBar.getByRole("button", { name: "Settings" });
  await expect(settings).toBeVisible();
  await expect(settings.locator(".btn-text")).toHaveCSS("position", "absolute");
  await expect(titleBar.locator(".host-window-move")).toBeHidden();
  await expect(titleBar.locator(".host-window-close")).toBeHidden();

  // Everything sits on one row in the title bar, and the window has one control row.
  const rows = await Promise.all(
    [".brand", ".host-window-title", "#host-enabled", "#settings-open"].map(async (sel) => {
      const box = await titleBar.locator(sel).boundingBox();
      return Math.round(box!.y + box!.height / 2);
    }),
  );
  for (const y of rows) expect(Math.abs(y - rows[0]!)).toBeLessThanOrEqual(4);
  const controls = await Promise.all(
    ["#doc-menu-open", "#save-indicator", "#exit-focus"].map(async (sel) => {
      const box = await main.locator(sel).boundingBox();
      return Math.round(box!.y + box!.height / 2);
    }),
  );
  for (const y of controls) expect(Math.abs(y - controls[0]!)).toBeLessThanOrEqual(6);
  await expect(main.locator("#exit-focus")).toHaveAccessibleName("Exit focus (Esc)");
  // The text box has no dead resize corner; the window sizes it.
  await expect(main.locator("#editor")).toHaveCSS("resize", "none");

  // Settings opens over Focus, and the shared switch still works there.
  await settings.click();
  await expect(page.locator("#settings-panel")).toBeVisible();
  await page.locator("#settings-close").click();
  await expect(main.locator("#enabled")).toBeChecked();
  await titleBar.locator("#host-enabled").click({ force: true });
  await expect(main.locator("#enabled")).not.toBeChecked();

  await main.locator("#exit-focus").click();
  await expect(page.locator("body")).not.toHaveClass(/host-focus-mode/);
  const toolbar = page.locator("#host-toolbar");
  await expect(toolbar).toBeVisible();
  await expect(toolbar.locator(".brand")).toBeVisible();
  await expect(toolbar.locator("#host-enabled")).toBeVisible();
  await expect(toolbar.locator("#settings-open")).toBeVisible();
  await expect(titleBar.locator(".host-window-move")).toBeVisible();
  await expect(titleBar.locator(".host-window-close")).toBeVisible();
});

test("host Focus moves its title bar chrome with F6 and keeps it after closing the window", async ({ page }) => {
  await openHost(page);
  await page.getByRole("button", { name: "New window" }).click();
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator("#editor")).toBeEnabled({ timeout: 30_000 });
  await enterFocus(page, second);
  const secondBar = page.locator('.host-window[data-window-id="w2"] .host-window-titlebar');
  await expect(secondBar.locator("#settings-open")).toBeVisible();

  await second.locator("#editor").focus();
  await page.keyboard.press("F6");
  const mainBar = page.locator('.host-window[data-window-id="main"] .host-window-titlebar');
  await expect(mainBar.locator("#settings-open")).toBeVisible();
  await expect(mainBar.locator(".brand")).toBeVisible();
  await expect(secondBar.locator("#settings-open")).toHaveCount(0);

  // Closing the focused window exits Focus; the shared controls are not lost with it.
  // × is hidden in Focus; send its click directly to cover any other close path.
  await mainBar.locator(".host-window-close").dispatchEvent("click");
  await expect(page.locator(".host-window")).toHaveCount(1);
  await expect(page.locator("body")).not.toHaveClass(/host-focus-mode/);
  await expect(page.locator("#host-toolbar #settings-open")).toBeVisible();
  await expect(page.locator("#host-toolbar #host-enabled")).toBeVisible();
  await expect(page.locator("#host-toolbar .brand")).toBeVisible();
});

test("host Focus on a phone keeps the title bar to one line", async ({ page }) => {
  const main = await openHost(page, 390);
  await enterFocus(page, main);
  const titleBar = page.locator('.host-window[data-window-id="main"] .host-window-titlebar');
  await expect(titleBar.locator("#settings-open")).toBeVisible();
  await expect(titleBar.locator("#host-enabled")).toBeVisible();
  const bar = await titleBar.boundingBox();
  expect(bar!.height).toBeLessThan(56);
  await expect(main.locator("#exit-focus")).toBeVisible();
  await expect(main.locator(".focus-exit-hint")).toBeHidden();
});

test('after a reload in host Focus, the Latin and Кириллица words still choose the mode', async ({ page }) => {
  const main = await openHost(page);
  await enterFocus(page, main);
  await page.reload();
  const restored = page.frameLocator('.host-window[data-window-id="main"] iframe');
  await expect(page.locator('body')).toHaveClass(/host-focus-mode/, { timeout: 30_000 });
  await expect(restored.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  const titleBar = page.locator('.host-window[data-window-id="main"] .host-window-titlebar');
  const sides = titleBar.locator('.mode-switch .mode-side');
  await expect(page.locator('#host-enabled')).toBeChecked();
  await sides.first().click();
  await expect(page.locator('#host-enabled')).not.toBeChecked();
  await sides.last().click();
  await expect(page.locator('#host-enabled')).toBeChecked();
  await sides.last().click();
  // Clicking Кириллица again keeps Cyrillic (it chooses, not toggles).
  await expect(page.locator('#host-enabled')).toBeChecked();
});
