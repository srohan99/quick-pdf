/**
 * Pre-resizes embedded base64 images inside an HTML string BEFORE it
 * reaches Puppeteer. This is the actual root-cause fix for slow
 * image-heavy PDF generation:
 *
 * Without this: Chromium decodes every image at full source resolution
 * (e.g. 3000px/1MB) just to paint it at maybe 500px wide, and if you
 * then run Ghostscript compression afterward, it decodes and
 * recompresses the SAME pixels a second time.
 *
 * With this: images are resized/recompressed ONCE, upfront, using
 * `sharp` (built on libvips, a highly optimized native C library — not
 * JS pixel processing). Chromium then decodes far less data, and the
 * output is usually already small enough that post-hoc compression
 * isn't needed at all.
 *
 * Uses sharp — a real third-party dependency, added deliberately here.
 * Fast native image resizing isn't something worth reimplementing from
 * scratch; unlike the PDF rendering engine itself, this is a narrow,
 * well-bounded problem where a native library is the right call.
 */

let sharp = null;
function getSharp() {
  if (!sharp) {
    try {
      sharp = require('sharp');
    } catch (e) {
      throw new Error(
        'Image optimization requires the "sharp" package. Run `npm install sharp`, ' +
        'or pass `optimizeImages: false` to skip this step.'
      );
    }
  }
  return sharp;
}

let sharpAvailable = null;
/**
 * Non-throwing check, used only by generatePdf's AUTO-detection path —
 * so upgrading quick-pdf doesn't suddenly break existing image-heavy PDF
 * generation for anyone who hasn't run `npm install sharp` yet. Explicit
 * `optimizeImages: true` still throws a clear error via getSharp() if
 * sharp is genuinely missing, since that's a deliberate ask.
 */
function isSharpAvailable() {
  if (sharpAvailable !== null) return sharpAvailable;
  try {
    require.resolve('sharp');
    sharpAvailable = true;
  } catch (e) {
    sharpAvailable = false;
  }
  return sharpAvailable;
}

const BASE64_IMG_RE = /data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/g;
// Support both normal quoted HTML attributes and the unquoted `src=https://…`
// form that Chromium accepts. The latter is common in older Handlebars
// templates and was previously invisible to remote optimization.
const REMOTE_IMG_TAG_RE = /<img\b[^>]*\bsrc\s*=\s*(?:(["'])(https?:\/\/[^"'\s>]+)\1|(https?:\/\/[^\s>]+))[^>]*>/gi;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatSavings(before, after) {
  const saved = before - after;
  const percent = before === 0 ? 0 : (saved / before) * 100;
  return `${formatBytes(before)} -> ${formatBytes(after)} (${formatBytes(saved)} saved, ${percent.toFixed(1)}%)`;
}

/**
 * Downloads explicitly opted-in remote images (such as public/presigned S3
 * URLs) and embeds them so the normal sharp optimization path can process
 * them before Chromium renders a PDF. Failed/oversized downloads are left as
 * their original URLs, preserving normal browser loading as a fallback.
 */
async function embedRemoteImages(html, opts = {}) {
  const noRemoteImages = { html, remote: { found: 0, downloaded: 0 } };
  if (opts.remote !== true) return noRemoteImages;
  if (typeof fetch !== 'function') {
    throw new Error('Remote image optimization requires Node.js 18+ (global fetch).');
  }

  const urls = [...html.matchAll(REMOTE_IMG_TAG_RE)].map((m) => m[2] || m[3]);
  const uniqueUrls = [...new Set(urls)].slice(0, opts.maxRemoteImages ?? 100);
  // Remote images are fetched only when they are small enough to be useful
  // inline in the generated PDF. This is a read-only GET; the S3/object-store
  // source is never modified.
  const maxBytes = opts.maxRemoteImageBytes ?? 100 * 1024;
  const replacements = new Map();
  await Promise.all(uniqueUrls.map(async (url) => {
    try {
      // Handlebars escapes query-string ampersands in HTML attributes. Browsers
      // decode them before loading an image, but fetch() receives the literal
      // source string here; decode the common forms so presigned S3 URLs keep
      // their signature intact. Keep `url` as the map key for HTML replacement.
      const fetchUrl = url.replace(/&amp;|&#x26;|&#38;/gi, '&');
      const response = await fetch(fetchUrl);
      const length = Number(response.headers.get('content-length'));
      if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('image/') ||
          (Number.isFinite(length) && length > maxBytes)) return;

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxBytes) return;
      const mimeType = response.headers.get('content-type').split(';', 1)[0].toLowerCase();
      replacements.set(url, `data:${mimeType};base64,${buffer.toString('base64')}`);
    } catch (_) {
      // Keep the remote URL so Puppeteer's existing image wait/fallback path
      // handles it exactly as it did before optimization was requested.
    }
  }));

  let result = html;
  for (const [url, dataUri] of replacements) result = result.split(url).join(dataUri);
  return { html: result, remote: { found: urls.length, downloaded: replacements.size } };
}

// An image whose size comes from its intrinsic dimensions would otherwise
// render smaller after its source is resized. Keep that layout stable by
// adding the original dimensions only when the author did not specify either
// dimension themselves. Explicit CSS/HTML sizing continues to win unchanged.
function preserveIntrinsicImageDimensions(html, dimensionsBySource) {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const source = tag.match(/\bsrc\s*=\s*(["'])(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)\1/i);
    if (!source) return tag;

    const dimensions = dimensionsBySource.get(source[2]);
    if (!dimensions || !dimensions.width || !dimensions.height) return tag;

    const hasWidthOrHeightAttribute = /\s(?:width|height)\s*=/i.test(tag);
    const style = tag.match(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/i);
    const hasWidthOrHeightStyle = style && /(?:^|;)\s*(?:width|height)\s*:/i.test(style[2]);
    if (hasWidthOrHeightAttribute || hasWidthOrHeightStyle) return tag;

    return tag.replace(/\/?\s*>$/, ` width="${dimensions.width}" height="${dimensions.height}">`);
  });
}

// Encode toward a real byte ceiling. Quality alone cannot promise a file
// size: a detailed photograph needs more bytes than a flat illustration at
// the same dimensions. After trying progressively lower quality, reduce the
// pixel dimensions too until the requested limit is met.
async function compressToTarget(sharpLib, inputBuffer, metadata, maxWidthPx, quality, maxOutputBytes) {
  const sourceWidth = metadata.width;
  const sourceHeight = metadata.height;
  let width = Math.min(sourceWidth, maxWidthPx);
  let best = null;

  while (width >= 1) {
    for (const attemptQuality of [...new Set([quality, 70, 60, 50, 40, 30].filter((q) => q <= quality))]) {
      const output = await sharpLib(inputBuffer)
        .resize({ width, withoutEnlargement: true })
        .jpeg({ quality: attemptQuality })
        .toBuffer();
      if (!best || output.length < best.length) best = output;
      if (output.length <= maxOutputBytes) return output;
    }
    // 80% is a useful compromise: few passes, but avoids a sudden severe
    // visual reduction when the image is only slightly above the target.
    width = Math.floor(width * 0.8);
  }
  return best;
}

/**
 * Resize/recompress every embedded base64 image in an HTML string.
 * Runs all images in parallel (sharp releases the event loop during
 * native processing, so this genuinely parallelizes across images).
 *
 * @param {string} html
 * @param {object} [opts]
 * @param {number} [opts.maxWidthPx=800] - images wider than this are downscaled;
 *   never upscales (withoutEnlargement)
 * @param {number} [opts.quality=80] - JPEG quality (1-100) for the re-encoded output
 * @param {number} [opts.maxOutputBytes] - optional target size per optimized image;
 *   quality and resolution are reduced as needed to reach it
 * @param {boolean} [opts.preserveDimensions=true] - keep the original rendered size
 *   for images that have no author-provided width or height
 * @param {boolean} [opts.log=false] - print before/after size details for each image
 * @returns {Promise<{html: string, imagesProcessed: number, bytesBefore: number, bytesAfter: number}>}
 */
async function optimizeHtmlImages(html, opts = {}) {
  const maxWidthPx = opts.maxWidthPx ?? 800;
  const quality = opts.quality ?? 80;
  // A remote image accepted by the 100 KB input limit is normally targeted
  // at 50 KB in the generated PDF. Callers can override this (or set it to a
  // non-positive value to use the normal quality/width-only path).
  const maxOutputBytes = opts.maxOutputBytes ?? (opts.remote === true ? 50 * 1024 : undefined);

  const embedded = await embedRemoteImages(html, opts);
  html = embedded.html;

  const matches = [...html.matchAll(BASE64_IMG_RE)];
  if (matches.length === 0) {
    return { html, imagesProcessed: 0, bytesBefore: 0, bytesAfter: 0 };
  }

  // Resolved ONCE, outside the per-image try/catch below — a missing
  // "sharp" install must throw clearly here, not get silently absorbed
  // by the try/catch that's meant only for corrupt/unprocessable image data.
  const sharpLib = getSharp();

  const dimensionsBySource = new Map();

  const replacements = await Promise.all(
    matches.map(async (m, index) => {
      const [fullMatch, , base64Data] = m;
      const inputBuffer = Buffer.from(base64Data, 'base64');

      try {
        const metadata = await sharpLib(inputBuffer).metadata();
        const outputBuffer = Number.isFinite(maxOutputBytes) && maxOutputBytes > 0
          ? await compressToTarget(sharpLib, inputBuffer, metadata, maxWidthPx, quality, maxOutputBytes)
          : await sharpLib(inputBuffer)
            .resize({ width: maxWidthPx, withoutEnlargement: true })
            .jpeg({ quality })
            .toBuffer();

        // Only use the re-encoded version if it's actually smaller —
        // a tiny already-optimized image could theoretically grow
        // slightly under re-encoding; never make things worse.
        if (outputBuffer.length < inputBuffer.length) {
          const replacement = `data:image/jpeg;base64,${outputBuffer.toString('base64')}`;
          if (opts.preserveDimensions !== false && metadata.width && metadata.height) {
            dimensionsBySource.set(replacement, { width: metadata.width, height: metadata.height });
          }
          return { index, fullMatch, replacement, beforeBytes: inputBuffer.length, afterBytes: outputBuffer.length };
        }
        return { index, fullMatch, replacement: fullMatch, beforeBytes: inputBuffer.length, afterBytes: inputBuffer.length };
      } catch (e) {
        // Unprocessable image data (corrupt, unsupported format) —
        // leave it untouched rather than failing the whole PDF.
        return { index, fullMatch, replacement: fullMatch, beforeBytes: inputBuffer.length, afterBytes: inputBuffer.length };
      }
    })
  );

  const bytesBefore = replacements.reduce((total, image) => total + image.beforeBytes, 0);
  const bytesAfter = replacements.reduce((total, image) => total + image.afterBytes, 0);

  let outputHtml = html;
  for (const { fullMatch, replacement } of replacements) {
    if (fullMatch !== replacement) {
      outputHtml = outputHtml.replace(fullMatch, replacement);
    }
  }

  if (opts.preserveDimensions !== false && dimensionsBySource.size > 0) {
    outputHtml = preserveIntrinsicImageDimensions(outputHtml, dimensionsBySource);
  }

  return { html: outputHtml, imagesProcessed: matches.length, bytesBefore, bytesAfter };
}

module.exports = { optimizeHtmlImages, isSharpAvailable };
