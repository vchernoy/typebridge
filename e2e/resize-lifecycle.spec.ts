import { expect, test } from '@playwright/test';

for (const focus of [false, true]) {
  test(`resize saves only completion and recovers capture loss (${focus ? 'Focus' : 'Normal'}, #137 U13)`, async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.addInitScript(() => {
      const writes: string[] = [];
      Object.assign(window, { resizeWrites: writes });
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === 'typebridge.editor.size.v1' || key === 'typebridge.editor.focusSize.v1') writes.push(key);
        set.call(this, key, value);
      };
    });
    await page.goto('/');
    const editor = page.locator('#editor');
    const grip = page.locator('#resize-editor');
    await expect(editor).toBeEnabled();
    if (focus) await page.locator('#focus-mode').click();
    const writes = () => page.evaluate(() => (window as unknown as { resizeWrites: string[] }).resizeWrites.length);
    const inline = () => editor.evaluate(element => ({ width: element.style.width, height: element.style.height, maxWidth: element.style.maxWidth }));
    // A different source changing the inline size must not be persisted by arbitrary clicks.
    await editor.evaluate(element => { element.style.height = '220px'; });
    await editor.click();
    expect(await writes()).toBe(0);
    const original = await inline();
    async function startDrag(): Promise<number> {
      await grip.scrollIntoViewIfNeeded();
      await expect.poll(async () => {
        const box = await grip.boundingBox();
        return box !== null && box.y > 0 && box.y + box.height < 1000;
      }).toBe(true);
      await grip.evaluate(element => element.addEventListener('pointerdown', event => {
        element.dataset.lastPointer = String((event as PointerEvent).pointerId);
      }, { once: true }));
      const box = (await grip.boundingBox())!;
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - 60, y - 40, { steps: 4 });
      await expect.poll(inline).not.toEqual(original);
      return Number(await grip.getAttribute('data-last-pointer'));
    }
    for (const reason of ['pointercancel', 'lostpointercapture']) {
      const pointer = await startDrag();
      if (reason === 'pointercancel') await grip.dispatchEvent(reason, { pointerId: pointer });
      else await grip.evaluate((element, id) => element.releasePointerCapture(id), pointer);
      // Capture loss is delivered by the browser at the next pointer update.
      await page.mouse.move(500, 250);
      await expect.poll(inline).toEqual(original);
      await page.mouse.up();
      expect(await writes()).toBe(0);
    }
    await startDrag();
    expect(await writes()).toBe(0);
    await page.mouse.up();
    await expect.poll(writes).toBe(1);
    const completed = await inline();
    const key = focus ? 'typebridge.editor.focusSize.v1' : 'typebridge.editor.size.v1';
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key)).toEqual({ width: completed.width, height: completed.height });
    await editor.click();
    expect(await writes()).toBe(1);
    await grip.focus();
    await page.keyboard.press('ArrowUp');
    await expect.poll(writes).toBe(2);
  });
}
