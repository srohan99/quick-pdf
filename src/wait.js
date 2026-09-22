/**
 * Waits for every <img> on the page to finish loading (or fail) before
 * printing, plus web fonts, plus a short settle delay. This exists
 * because waitUntil strategies ('networkidle0'/'networkidle2') are not
 * fully reliable signals for "every image is actually painted" —
 * networkidle can resolve while a slow image (e.g. a large S3-hosted
 * photo) is still decoding, producing a PDF with blank image boxes.
 *
 * Each image gets its own failsafe timeout so one slow/broken image
 * URL can't hang the whole PDF generation — it just gets skipped (and
 * reported) after its own timeout expires, same as the others.
 *
 * This function's body runs *inside* the browser page (via
 * page.evaluate), not in Node — it only has access to the DOM, not to
 * anything in this file's closure.
 */
function waitForImagesInPage(perImageTimeoutMs) {
  return new Promise((resolve) => {
    const images = Array.from(document.images);
    if (images.length === 0) {
      resolve({ total: 0, loaded: 0, failed: 0 });
      return;
    }

    let settled = 0;
    let failed = 0;
    const total = images.length;

    const done = () => {
      settled++;
      if (settled === total) resolve({ total, loaded: total - failed, failed });
    };

    images.forEach((img) => {
      if (img.complete) {
        done();
        return;
      }
      const timer = setTimeout(() => {
        failed++;
        done();
      }, perImageTimeoutMs);

      img.addEventListener('load', () => { clearTimeout(timer); done(); }, { once: true });
      img.addEventListener('error', () => { clearTimeout(timer); failed++; done(); }, { once: true });
    });
  });
}

/**
 * Runs the image wait, a font-ready wait, and an optional settle delay,
 * all against an already-loaded page. Call after page.setContent().
 *
 * @param {import('puppeteer').Page} page
 * @param {object} [opts]
 * @param {number} [opts.imageTimeout=90000] - Max ms to wait per individual image
 * @param {number} [opts.settleDelay=0] - Extra ms to wait after everything settles,
 *   for last-moment layout/paint (e.g. web fonts causing reflow after loading)
 * @returns {Promise<{total: number, loaded: number, failed: number}>}
 */
async function waitForImagesAndFonts(page, opts = {}) {
  const imageTimeout = opts.imageTimeout ?? 90000;
  const settleDelay = opts.settleDelay ?? 0;

  const result = await page.evaluate(waitForImagesInPage, imageTimeout);

  // document.fonts may not exist in very old rendering paths; guard it.
  await page.evaluate(() => (document.fonts && document.fonts.ready) || Promise.resolve()).catch(() => {});

  if (settleDelay > 0) {
    await new Promise((resolve) => setTimeout(resolve, settleDelay));
  }

  return result;
}

module.exports = { waitForImagesAndFonts };
