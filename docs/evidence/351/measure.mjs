import { chromium, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
const browser = await chromium.launch();
const evidence = [];
try {
  for (const [width, height] of [
    [320, 568],
    [320, 800],
    [1440, 800],
  ])
    for (const view of ["source", "rendered"]) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height } });
      await context.addInitScript(() =>
        Object.defineProperty(globalThis.navigator, "clipboard", { value: { writeText: async () => {} } }),
      );
      const page = await context.newPage();
      await page.goto("https://typebridge.vchernoy.xyz/editor.html");
      await expect(page.locator("#editor")).toBeEnabled();
      await page
        .locator("#editor")
        .fill("# Share flow fixture\n\n```calc\ninput x = 2\ny = x * 3\n```\n\n:input[x] :value[y]");
      await page.locator("#doc-menu-open").click();
      await page.locator("#document-format").selectOption("markdown");
      await page.locator("#doc-menu-open").click();
      if (view === "rendered") {
        await page.locator("#document-view-preview").click();
        await expect(page.locator("#rendered-document input")).toBeVisible();
      }
      const metrics = async (selector) =>
        page.locator(selector).evaluate((el) => {
          const r = el.getBoundingClientRect();
          return {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            inViewport: r.top >= 0 && r.bottom <= globalThis.innerHeight,
            scrollY: globalThis.scrollY,
            scrollAncestors: Array.from(
              (function* (e) {
                for (; e; e = e.parentElement) yield e;
              })(el),
            )
              .filter((e) => e.scrollHeight > e.clientHeight)
              .map((e) => ({
                tag: e.tagName,
                id: e.id,
                scrollTop: e.scrollTop,
                scrollHeight: e.scrollHeight,
                clientHeight: e.clientHeight,
              })),
          };
        });
      await page.locator("#doc-menu-open").click();
      const shareBefore = await metrics("#share-link");
      await page.locator("#share-link").click();
      const sheet = page.getByRole("dialog", { name: "Share link", exact: true });
      await expect(sheet.locator("#share-url")).not.toHaveValue("");
      const copyBefore = await metrics("#share-copy");
      await page.screenshot({ path: `/tmp/351-${width}-${height}-${view}.png`, fullPage: true });
      await page.locator("#share-copy").click();
      await expect(sheet.locator(".share-status")).toHaveText("Link copied.");
      await page.keyboard.press("Escape");
      await expect(page.locator("#doc-menu-open")).toBeFocused();
      evidence.push({
        width,
        height,
        view,
        actionsToCopy: 3,
        shareBefore,
        copyBefore,
        escapeReturnsFocus: true,
        clipboard: "isolated success stub; no OS clipboard claim",
      });
      await context.close();
    }
  await writeFile("/tmp/351-measurements.json", JSON.stringify(evidence, null, 2));
  globalThis.console.log("Six production flows measured; synthetic clipboard success and Escape focus return passed.");
} finally {
  await browser.close();
}
