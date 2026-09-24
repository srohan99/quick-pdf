const puppeteer = require('puppeteer');
const { compressPdf, compressFile } = require('./compress');
const { waitForImagesAndFonts } = require('./wait');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/**
 * Chromium flags for stable headless PDF rendering, particularly for
 * heavy/long-running pages (many images, large DOMs). Disabling
 * GPU/software-rasterizer and background throttling avoids Chromium
 * deprioritizing or stalling rendering work on a "backgrounded" headless
 * tab, which otherwise silently slows down or hangs large jobs.
 */
const STABILITY_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage', // avoid /dev/shm size limits in containers (Docker default is tiny)
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-extensions',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=IsolateOrigins,site-per-process',
];

/**
 * Singleton browser manager.
 * Puppeteer launch is the expensive part (~500ms-1s). We launch ONCE
 * per process and reuse it for every generatePdf() call, instead of
 * launching/closing on every request. This is the single biggest
 * speed win in this library.
 *
 * NOTE: launch-time options (args, protocolTimeout, memory flags) only
 * take effect on the FIRST call in a process, since the browser is
 * reused after that.
 */
let browserPromise = null;

function getBrowser(launchOptions = {}) {
  if (!browserPromise) {
    const { args: userArgs, protocolTimeout, maxOldSpaceSizeMb, ...restLaunch } = launchOptions;
    const args = [
      ...STABILITY_ARGS,
      // Default raised to 4096MB unconditionally — costs nothing on small
      // jobs, and removes the need to manually opt in for large ones.
      // Still overridable via launch.maxOldSpaceSizeMb if you need more/less.
      `--js-flags=--max-old-space-size=${maxOldSpaceSizeMb ?? 4096}`,
      ...(userArgs || []),
    ];

    browserPromise = puppeteer.launch({
      headless: 'new',
      protocolTimeout: protocolTimeout ?? 0,
      args,
      ...restLaunch,
    });

    browserPromise.then((browser) => {
      browser.on('disconnected', () => {
        browserPromise = null;
      });
    });
  }
  return browserPromise;
}

/**
 * Handlebars is a regular dependency (installed automatically with
 * `npm install quick-pdf-gen`), but still loaded lazily via require() here —
 * so processes that only ever use native JS function templates don't
 * pay any Handlebars parsing/init cost at startup.
 *
 * No helpers are registered by default — helper needs are entirely
 * project-specific. Use registerHelper() below to add your own before
 * the first generatePdf() call that needs them.
 */
let handlebars = null;
function getHandlebars() {
  if (!handlebars) {
    handlebars = require('handlebars');
  }
  return handlebars;
}

/**
 * Register a custom Handlebars helper. Call this ONCE at startup,
 * before any generatePdf() call that uses the helper — registration is
 * global, on the shared Handlebars instance, and compiled templates are
 * cached (see below), so a helper registered after a template's first
 * render won't apply to that already-cached template.
 *
 *   registerHelper('ifEquals', function (a, b, options) {
 *     return a === b ? options.fn(this) : options.inverse(this);
 *   });
 *   // template: {{#ifEquals status "active"}}...{{/ifEquals}}
 *
 * @param {string} name
 * @param {Function} fn
 */
function registerHelper(name, fn) {
  getHandlebars().registerHelper(name, fn);
}

/**
 * Register a Handlebars partial (reusable sub-template), e.g. a shared
 * header/footer block referenced from multiple templates via {{> name}}.
 *
 * @param {string} name
 * @param {string} partialTemplateStr
 */
function registerPartial(name, partialTemplateStr) {
  getHandlebars().registerPartial(name, partialTemplateStr);
}

/**
 * Access the shared Handlebars instance directly — for things
 * registerHelper/registerPartial don't cover, like Handlebars.SafeString
 * (needed when a helper returns raw HTML that shouldn't be escaped) or
 * Handlebars.Utils.
 */
function getHandlebarsInstance() {
  return getHandlebars();
}

/**
 * Compiled Handlebars templates are cached by the exact template string
 * (or, for file templates, by absolute file path). Big win for bulk jobs
 * (e.g. generating 500 invoices from the same template) — you only pay
 * the compile cost once, not per document.
 */
const compiledCache = new Map();

function getCompiled(templateStr) {
  let compiled = compiledCache.get(templateStr);
  if (!compiled) {
    compiled = getHandlebars().compile(templateStr);
    compiledCache.set(templateStr, compiled);
  }
  return compiled;
}

const TEMPLATE_FILE_EXT = /\.(handlebars|hbs)$/i;

/**
 * True if the string looks like (and actually is) a .handlebars/.hbs
 * file path, not template content. Guards against false positives on
 * short inline HTML strings by checking the extension AND that the file
 * exists — an inline string that happens to end in ".hbs" with no such
 * file on disk just falls through to normal string handling.
 */
function isTemplateFilePath(str) {
  return TEMPLATE_FILE_EXT.test(str) && !str.includes('\n') && str.length < 4096 && fsSync.existsSync(str);
}

function getCompiledFromFile(filePath) {
  let compiled = compiledCache.get(filePath);
  if (!compiled) {
    const content = fsSync.readFileSync(filePath, 'utf8');
    compiled = getHandlebars().compile(content);
    compiledCache.set(filePath, compiled);
  }
  return compiled;
}

/**
 * Render a template into an HTML string. FOUR modes, auto-detected —
 * pick whichever fits, no config needed:
 *
 * 1. FUNCTION — native JS, fastest (no parsing/compiling at all):
 *      generatePdf((data) => `<h1>${data.name}</h1>`, { name: 'John' })
 *
 * 2. .handlebars/.hbs FILE PATH — read and compiled once, then cached
 *    by path for subsequent calls:
 *      generatePdf(path.join(__dirname, 'invoice.handlebars'), data)
 *
 * 3. STRING with "{{...}}" — Handlebars, good for templates stored in
 *    a database or edited by non-devs, supports loops:
 *      generatePdf('<h1>{{name}}</h1>', { name: 'John' })
 *
 * 4. STRING with no "{{...}}" — treated as static HTML and returned
 *    as-is, zero processing. Fastest string path, useful for fixed
 *    documents (terms & conditions, certificates with no blanks).
 */
function render(htmlTemplate, data = {}) {
  if (typeof htmlTemplate === 'function') {
    return htmlTemplate(data);
  }

  if (typeof htmlTemplate === 'string') {
    if (isTemplateFilePath(htmlTemplate)) {
      return getCompiledFromFile(htmlTemplate)(data);
    }
    if (htmlTemplate.includes('{{')) {
      return getCompiled(htmlTemplate)(data);
    }
    return htmlTemplate; // static HTML, nothing to inject
  }

  throw new TypeError(
    'htmlTemplate must be a string (Handlebars/static/file path) or a function (data) => html (native JS).'
  );
}

const AUTO_BASE64_LIMIT_MB = 250; // below Node's ~350-750MB base64 string-length ceiling, with margin
const AUTO_COMPRESS_THRESHOLD_MB = 20;

/**
 * Estimates the rendering workload directly from the final HTML string
 * (after templating), so timeout/compress/outputPath can be chosen
 * automatically instead of requiring the caller to know these numbers
 * up front.
 *
 * - Embedded base64 images: exact size, decoded from the base64 length.
 * - Remote (http/https) <img> tags: size unknowable until fetched, so
 *   assumed at a conservative average — tune via `assumedRemoteImageMb`
 *   if your images run larger/smaller than 500KB on average.
 */
function estimateWorkload(html, assumedRemoteImageMb = 0.5) {
  let embeddedBytes = 0;
  let embeddedCount = 0;
  const base64Re = /data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=]+)/g;
  let m;
  while ((m = base64Re.exec(html))) {
    embeddedBytes += Math.floor((m[1].length * 3) / 4); // base64 -> raw byte size
    embeddedCount++;
  }

  const remoteCount = (html.match(/<img[^>]+src=["']https?:\/\//gi) || []).length;
  const estimatedMB = embeddedBytes / (1024 * 1024) + remoteCount * assumedRemoteImageMb;
  const totalImageCount = embeddedCount + remoteCount;

  return { totalImageCount, estimatedMB };
}

/**
 * Fills in timeout/compress/outputPath automatically based on the
 * estimated workload, for anything the caller didn't explicitly set.
 * Explicit options always win — this only ever fills gaps.
 */
function resolveAutoOptions(html, options) {
  const { totalImageCount, estimatedMB } = estimateWorkload(html, options.assumedRemoteImageMb);

  // Base 30s + 1s per image, capped at 10 minutes — scales with the
  // amount of decode/paint work Chromium actually has to do.
  const autoTimeout = Math.min(600000, 30000 + totalImageCount * 1000);

  // Compression starts paying for itself once there's enough image
  // weight to meaningfully shrink; skip it on small/text-heavy PDFs
  // where it would just add time for no real benefit.
  const autoCompress = estimatedMB > AUTO_COMPRESS_THRESHOLD_MB ? 'standard' : false;

  // Auto-switch to disk output once the estimated size gets close to
  // where base64 becomes risky, so this can never crash with
  // "RangeError: Invalid string length" just because outputPath wasn't set.
  const autoOutputPath =
    estimatedMB > AUTO_BASE64_LIMIT_MB
      ? path.join(os.tmpdir(), `quick-pdf-gen-auto-${crypto.randomBytes(6).toString('hex')}.pdf`)
      : null;

  return { autoTimeout, autoCompress, autoOutputPath, estimatedMB, totalImageCount };
}

/**
 * Generate a PDF from an HTML template + data.
 *
 * Automatic, no-config behavior on every call (this is what makes
 * remote images like S3 reliable without tuning waitUntil):
 *   - Every <img> is individually waited on (load or error, each with
 *     its own failsafe timeout), not just a generic network-idle heuristic.
 *   - Web fonts (document.fonts.ready) are waited on too.
 *   - The browser launches with stability flags suited to heavy/long
 *     rendering jobs.
 *   - timeout, compress, and outputPath are auto-detected from the
 *     estimated image weight of the rendered HTML — set them explicitly
 *     any time to override the auto-detected value.
 *
 * @param {string|function} htmlTemplate - Handlebars string, .handlebars/.hbs
 *   file path, static HTML string, or a native JS function (data) => html.
 * @param {object} [data]
 * @param {object} [options]
 * @param {object} [options.pdf]
 * @param {object} [options.pdf.margin]
 * @param {string|function} [options.footerTemplate]
 * @param {string|function} [options.headerTemplate]
 * @param {string} [options.waitUntil='domcontentloaded']
 * @param {number} [options.timeout] - auto-detected from image count if omitted (30s-10min)
 * @param {boolean} [options.waitForImages=true]
 * @param {number} [options.imageTimeout=90000]
 * @param {number} [options.settleDelay=0]
 * @param {boolean|string|object} [options.compress] - auto-enabled ('standard') once
 *   estimated image weight exceeds ~20MB, if not explicitly set. Pass `false` to force off.
 * @param {string} [options.outputPath] - auto-set to a temp file once estimated size
 *   exceeds ~250MB (where base64 return becomes unsafe), if not explicitly set.
 * @param {number} [options.assumedRemoteImageMb=0.5] - average size assumed per remote
 *   (http/https) <img>, used only for the auto-detection estimate (their real size
 *   isn't known until fetched). Raise this if your remote images run larger than 500KB.
 * @param {object} [options.launch]
 * @returns {Promise<string|{path: string, bytes: number}>}
 */
const OPTIMIZE_THRESHOLD_MB = 5; // lower bar than compress's 20MB — resizing is cheap and helps even moderate cases

async function generatePdf(htmlTemplate, data = {}, options = {}) {
  let html = render(htmlTemplate, data);
  const preEstimate = estimateWorkload(html, options.assumedRemoteImageMb);

  // Pre-resize embedded images BEFORE Chromium ever sees them — this is
  // the actual root-cause fix for slow image-heavy rendering, and it
  // usually eliminates the need for post-hoc Ghostscript compression
  // entirely (a smaller-to-begin-with PDF has nothing left to shrink).
  // Auto-triggered at a lower threshold than compress, since resizing
  // is fast and helps even moderately image-heavy documents.
  //
  // The AUTO path only runs if "sharp" is actually installed, so
  // upgrading quick-pdf-gen never breaks existing image-heavy PDF generation
  // for anyone who hasn't added sharp yet — it just silently keeps the
  // old (Ghostscript-only) behavior. Explicit `optimizeImages: true`
  // always throws a clear error if sharp is genuinely missing, since
  // that's a deliberate ask, not an auto-detected one.
  const { isSharpAvailable } = require('./optimize');
  let shouldOptimize;
  if (options.optimizeImages === true) {
    shouldOptimize = true;
  } else if (options.optimizeImages === false) {
    shouldOptimize = false;
  } else {
    shouldOptimize = (preEstimate.estimatedMB > OPTIMIZE_THRESHOLD_MB || options.optimizeImages?.remote === true) && isSharpAvailable();
  }
  let optimizeResult = null;
  if (shouldOptimize) {
    const { optimizeHtmlImages } = require('./optimize');
    const optOpts = typeof options.optimizeImages === 'object' ? options.optimizeImages : {};
    optimizeResult = await optimizeHtmlImages(html, optOpts);
    html = optimizeResult.html;
  }

  // Re-estimate on the (possibly now much smaller) html, so
  // timeout/compress/outputPath auto-detection reflects the real
  // payload Chromium/Ghostscript will actually deal with — not the
  // pre-optimization size, which would over-trigger compress/outputPath
  // unnecessarily after images have already been shrunk.
  const auto = resolveAutoOptions(html, options);

  const timeout = options.timeout || auto.autoTimeout;
  const compressOption = options.compress !== undefined ? options.compress : auto.autoCompress;
  const outputPath = options.outputPath || auto.autoOutputPath;

  const browser = await getBrowser(options.launch);
  const page = await browser.newPage();

  try {
    page.setDefaultTimeout(timeout);
    page.setDefaultNavigationTimeout(timeout);

    await page.setContent(html, {
      waitUntil: options.waitUntil || 'domcontentloaded',
      timeout,
    });

    if (options.waitForImages !== false) {
      await waitForImagesAndFonts(page, {
        imageTimeout: options.imageTimeout ?? 90000,
        settleDelay: options.settleDelay ?? 0,
      });
    }

    const hasHeaderFooter = !!(options.headerTemplate || options.footerTemplate);


    const defaultMargin = hasHeaderFooter
      ? { top: '60px', bottom: '60px', left: '20px', right: '20px' }
      : { top: '20px', bottom: '20px', left: '20px', right: '20px' };

    const pdfCallOptions = {
      format: 'A4',
      printBackground: true,
      margin: defaultMargin,
      displayHeaderFooter: hasHeaderFooter,
      timeout,
      headerTemplate: options.headerTemplate ? render(options.headerTemplate, data) : '<span></span>',
      footerTemplate: options.footerTemplate ? render(options.footerTemplate, data) : '<span></span>',
      ...options.pdf,
      margin: { ...defaultMargin, ...(options.pdf && options.pdf.margin) },
    };

    if (outputPath) {
      if (compressOption) {
        const tmpPath = path.join(os.tmpdir(), `quick-pdf-gen-raw-${crypto.randomBytes(8).toString('hex')}.pdf`);
        await page.pdf({ ...pdfCallOptions, path: tmpPath });
        try {
          const quality = compressOption === true ? 'standard' : compressOption;
          return await compressFile(tmpPath, outputPath, quality);
        } finally {
          await fs.unlink(tmpPath).catch(() => {});
        }
      }

      await page.pdf({ ...pdfCallOptions, path: outputPath });
      const stat = await fs.stat(outputPath);
      return { path: outputPath, bytes: stat.size };
    }

    const pdfBuffer = await page.pdf(pdfCallOptions);
    let finalBuffer = Buffer.from(pdfBuffer);

    if (compressOption) {
      const quality = compressOption === true ? 'standard' : compressOption;
      finalBuffer = await compressPdf(finalBuffer, quality);
    }

    return finalBuffer;
  } finally {
    await page.close();
  }
}

/**
 * Call this on app shutdown (SIGTERM/SIGINT) to close the shared browser cleanly.
 */
async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
  }
}

// Factory pattern avoids a circular require: batch.js needs generatePdf,
// but generatePdf is defined in this file, so batch.js can't require
// index.js back (it would get an incomplete module mid-execution).
const { createGeneratePdfBatched } = require('./batch');
const generatePdfBatched = createGeneratePdfBatched(generatePdf);

const { createGenerateChunkedPdf } = require('./chunked');
const generateChunkedPdf = createGenerateChunkedPdf(generatePdfBatched);

module.exports = {
  generatePdf,
  closeBrowser,
  compressPdf,
  compressFile,
  registerHelper,
  registerPartial,
  getHandlebarsInstance,
  generatePdfBatched,
  generateChunkedPdf,
};
