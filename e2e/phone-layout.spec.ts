import { expect, test } from "@playwright/test";

for (const width of [320, 390]) {
  test(`phone layout at ${width} px keeps every control and fits the screen (#123)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/editor.html");
    await expect(page.locator("#editor")).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    const topbar = page.locator("header.topbar");
    // Focus and Settings become icon buttons that keep their names.
    for (const name of ["Focus mode", "Settings"]) {
      const button = topbar.getByRole("button", { name, exact: true });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box!.width).toBeLessThan(60);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    // Every control stays inside the screen; at 390 px the switch, Focus and Settings
    // also share one row (at 320 px wider system fonts may wrap them, which is fine).
    for (const id of ["#enabled", "#focus-mode", "#settings-open", "#more-open"]) {
      const box = await page.locator(id).boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
    if (width >= 390) {
      const rows = await Promise.all(
        ["#enabled", "#focus-mode", "#settings-open"].map(async (id) => {
          const box = await page.locator(id).boundingBox();
          return Math.round(box!.y + box!.height / 2);
        }),
      );
      expect(Math.max(...rows) - Math.min(...rows)).toBeLessThanOrEqual(4);
    }
    await expect(
      page.getByRole("toolbar", { name: "Editing" }).getByRole("button", { name: "More actions" }),
    ).toBeVisible();
    // The editor starts high on the screen.
    expect((await page.locator("#editor").boundingBox())!.y).toBeLessThan(width < 360 ? 340 : 300);
  });
}

test("phone layout wraps instead of overflowing when text is enlarged (#123)", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  // A larger browser default font, as set in accessibility or browser settings.
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent =
        "html { font-size: 24px; } body { font-size: 1rem; } button, input, label, span, select { font-size: inherit; }";
      document.head.append(style);
    });
  });
  await page.goto("/editor.html");
  await expect(page.locator("#editor")).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  for (const id of ["#enabled", "#focus-mode", "#settings-open", "#more-open"]) {
    const box = await page.locator(id).boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  }
});
