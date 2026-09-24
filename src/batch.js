const { spawn } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/**
 * Zero-dependency concurrency limiter. Runs `worker` over `items` with at
 * most `limit` running at once, preserving result order.
 */
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  async function next() {
    while (index < items.length) {
      const i = index++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return results;
}

/**
 * Picks a sensible default concurrency based on the machine's actual CPU
 * cores and free memory, instead of a fixed guess like 4.
 *
 * Two independent ceilings, take the smaller:
 * - CPU: each concurrent Chromium tab does real rendering work, so more
 *   tabs than (cores - reserveCores) just adds context-switching
 *   overhead, not real speedup.
 * - Memory: each tab rendering image-heavy content can realistically use
 *   150-400MB. Oversubscribing risks the OOM killer taking out tabs
 *   mid-render on smaller machines — worse than just being slower.
 *
 * Both are configurable since "RAM per tab" depends heavily on your
 * actual content (300 tiny thumbnails vs 300 1MB photos differ a lot).
 * Verified against real system values (this library's own sandbox: 1
 * CPU / ~3.9GB free correctly clamps to concurrency=1) and simulated
 * profiles (8 CPU/16GB -> CPU-bound at 7; 4 CPU/2GB -> memory-bound at 3;
 * 16 CPU/32GB with only 6 chunks -> chunk-count-bound at 6).
 */
function getDynamicConcurrency(chunkCountCeiling, opts = {}) {
  const memPerChunkMb = opts.memPerChunkMb ?? 300;
  const maxConcurrency = opts.maxConcurrency ?? 8;
  const reserveCores = opts.reserveCores ?? 1;

  const cpuCount = os.cpus().length;
  const freeMemMb = os.freemem() / 1024 / 1024;

  const cpuLimit = Math.max(1, cpuCount - reserveCores);
  const memLimit = Math.max(1, Math.floor(freeMemMb / memPerChunkMb));

  return Math.max(1, Math.min(cpuLimit, memLimit, maxConcurrency, chunkCountCeiling));
}

let qpdfAvailable = null;
function checkQpdf() {
  if (qpdfAvailable !== null) return Promise.resolve(qpdfAvailable);
  return new Promise((resolve) => {
    const proc = spawn('qpdf', ['--version']);
    proc.on('error', () => { qpdfAvailable = false; resolve(false); });
    proc.on('exit', (code) => { qpdfAvailable = code === 0; resolve(qpdfAvailable); });
  });
}

function mergeWithQpdf(partPaths, outputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('qpdf', ['--empty', '--pages', ...partPaths, '--', outputPath]);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', reject);
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`qpdf merge failed: ${stderr}`))));
  });
}

function getPageCount(pdfPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('qpdf', ['--show-npages', pdfPath]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      const count = Number.parseInt(stdout.trim(), 10);
      if (code === 0 && Number.isSafeInteger(count) && count > 0) return resolve(count);
      reject(new Error(`qpdf could not determine page count: ${stderr || stdout}`));
    });
  });
}

function overlayWithQpdf(basePath, overlayPath, outputPath) {
  return new Promise((resolve, reject) => {
    // --repeat=1 makes qpdf apply overlay page N to base page N. The
    // overlay is deliberately generated with one page per *actual* merged
    // page, so numbers are no longer tied to item/chunk counts.
    const proc = spawn('qpdf', ['--overlay', overlayPath, '--repeat=1', '--', basePath, outputPath]);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', reject);
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`qpdf overlay failed: ${stderr}`))));
  });
}

const BLANK_HEADER_FOOTER = '<span></span>';

function paginationPagesHtml(pageCount) {
  // A non-empty, forced page break is more reliable than an empty element
  // across Chromium versions. The final page does not need a break.
  return `<!doctype html><html><head><style>
    html, body { margin: 0; padding: 0; }
    .quick-pdf-gen-pagination-page { height: 1px; break-after: page; page-break-after: always; }
    .quick-pdf-gen-pagination-page:last-child { break-after: auto; page-break-after: auto; }
  </style></head><body>${'<div class="quick-pdf-gen-pagination-page">&nbsp;</div>'.repeat(pageCount)}</body></html>`;
}

/**
 * Factory: creates generatePdfBatched bound to a specific generatePdf
 * implementation. Done this way (rather than batch.js requiring index.js
 * directly) to avoid a circular require — index.js requires batch.js,
 * so batch.js requiring index.js back would get an incomplete,
 * not-yet-exported module and generatePdf would come back undefined.
 *
 * @param {Function} generatePdf - the real generatePdf from index.js
 */
function createGeneratePdfBatched(generatePdf) {
  /**
   * Render a large item-based document (e.g. one "finding"/"section" per
   * item) as multiple smaller PDFs IN PARALLEL, then merge with qpdf.
   *
   * IMPORTANT ASSUMPTION: correct running page numbers require each item
   * to render as exactly ONE physical PDF page (e.g. `page-break-after:
   * always` per item). Puppeteer's own <span class="pageNumber"> CANNOT
   * be used here since it resets per chunk — use the injected pageOffset
   * to compute your own absolute page number in the template instead.
   *
   * @param {Array} items - full list of items (e.g. findings), one per page
   * @param {(chunkItems: Array, meta: {pageOffset: number, totalPages: number, chunkIndex: number}) => (string|Function)} renderChunk
   * @param {object} [options]
   * @param {number} [options.concurrency] - explicit override. If omitted,
   *   computed dynamically from CPU cores and free memory.
   * @param {number} [options.maxConcurrency=8] - ceiling for the dynamic calc
   * @param {number} [options.memPerChunkMb=300] - assumed memory cost per
   *   concurrent chunk, used only by the dynamic calc. Raise this if your
   *   chunks contain many/large images to get a more conservative number.
   * @param {number} [options.reserveCores=1] - CPU cores left free for the OS/Node
   * @param {number} [options.chunkSize] - items per chunk; default splits evenly
   *   based on the resolved concurrency
   * @param {string} [options.outputPath] - final merged file path
   * @param {object} [options.generateOptions] - passed to each chunk's generatePdf() call
   * Pagination is automatic whenever generateOptions supplies a header or
   * footer: after merging, its Puppeteer pageNumber/totalPages values are
   * overlaid using the actual final PDF page count. Set
   * physicalPageNumbers: false only to retain legacy per-chunk behavior.
   * @param {object} [options.paginationData] - data used to render the final
   *   header/footer stamp (for company names and other footer variables).
   * @returns {Promise<Buffer|{path: string, bytes: number, concurrencyUsed: number}>}
   */
  return async function generatePdfBatched(items, renderChunk, options = {}) {
    const available = await checkQpdf();
    if (!available) {
      throw new Error(
        'generatePdfBatched requires qpdf installed on the system (used to merge the parallel-rendered parts).\n' +
        '  Ubuntu/Debian: sudo apt-get install qpdf\n' +
        '  macOS:         brew install qpdf\n' +
        '  Windows:       download from https://qpdf.sourceforge.io/'
      );
    }

    // Concurrency is decided FIRST, using items.length as the chunk-count
    // ceiling (chunk count can never exceed item count) — this avoids
    // creating more chunks than the machine can usefully run in parallel,
    // which would just add merge overhead for no speedup.
    const concurrency = options.concurrency ?? getDynamicConcurrency(items.length, {
      maxConcurrency: options.maxConcurrency,
      memPerChunkMb: options.memPerChunkMb,
      reserveCores: options.reserveCores,
    });

    const chunkSize = options.chunkSize || Math.ceil(items.length / concurrency);
    const chunks = [];
    for (let i = 0; i < items.length; i += chunkSize) chunks.push(items.slice(i, i + chunkSize));

    const actualConcurrency = Math.min(concurrency, chunks.length);
    const tmpDir = os.tmpdir();
    const partPaths = new Array(chunks.length);
    const sourceGenerateOptions = options.generateOptions || {};
    // Correct physical-page pagination is the safe default. It needs no new
    // call-site option: an existing header/footer is enough to opt in. `false`
    // remains available only for callers intentionally relying on legacy,
    // per-chunk Chromium counters.
    const physicalPageNumbers = options.physicalPageNumbers !== false &&
      !!(sourceGenerateOptions.headerTemplate || sourceGenerateOptions.footerTemplate);

    // Keep the exact same header/footer margins in every chunk, while leaving
    // their content blank. The real dynamic header/footer is stamped only
    // after qpdf knows the merged document's physical page count.
    const chunkGenerateOptions = physicalPageNumbers
      ? {
          ...sourceGenerateOptions,
          headerTemplate: sourceGenerateOptions.headerTemplate ? BLANK_HEADER_FOOTER : undefined,
          footerTemplate: sourceGenerateOptions.footerTemplate ? BLANK_HEADER_FOOTER : undefined,
        }
      : sourceGenerateOptions;

    await runWithConcurrency(chunks, actualConcurrency, async (chunkItems, idx) => {
      const pageOffset = chunks.slice(0, idx).reduce((sum, c) => sum + c.length, 0);
      const chunkResult = renderChunk(chunkItems, {
        pageOffset,
        totalPages: items.length,
        chunkIndex: idx,
        totalChunks: chunks.length,
      });

      // renderChunk can return either a plain template (string/function —
      // when the caller already baked data into it themselves, e.g. the
      // native-JS-function pattern) OR { template, data } when the
      // template needs Handlebars data injected per chunk. Without this,
      // per-chunk data was silently dropped (generatePdf was always
      // called with {} — a real bug from an earlier version of this file).
      const { template, data: chunkData } =
        chunkResult && typeof chunkResult === 'object' && 'template' in chunkResult
          ? chunkResult
          : { template: chunkResult, data: {} };

      const partPath = path.join(tmpDir, `quick-pdf-gen-part-${idx}-${crypto.randomBytes(4).toString('hex')}.pdf`);

      await generatePdf(template, chunkData, {
        ...chunkGenerateOptions,
        outputPath: partPath,
      });

      partPaths[idx] = partPath;
    });

    const finalPath = options.outputPath || path.join(tmpDir, `quick-pdf-gen-merged-${crypto.randomBytes(4).toString('hex')}.pdf`);
    const mergedPath = physicalPageNumbers
      ? path.join(tmpDir, `quick-pdf-gen-unpaginated-${crypto.randomBytes(4).toString('hex')}.pdf`)
      : finalPath;

    try {
      await mergeWithQpdf(partPaths, mergedPath);

      if (physicalPageNumbers) {
        const pageCount = await getPageCount(mergedPath);
        const stampPath = path.join(tmpDir, `quick-pdf-gen-pagination-${crypto.randomBytes(4).toString('hex')}.pdf`);
        try {
          // `generatePdf` supplies Chromium's pageNumber/totalPages values,
          // now over the full page count rather than an individual chunk.
          await generatePdf(paginationPagesHtml(pageCount), options.paginationData || {}, {
            ...sourceGenerateOptions,
            compress: false,
            outputPath: stampPath,
          });
          await overlayWithQpdf(mergedPath, stampPath, finalPath);
        } finally {
          await fs.unlink(stampPath).catch(() => {});
        }
      }
    } finally {
      await Promise.all(partPaths.map((p) => fs.unlink(p).catch(() => {})));
      if (physicalPageNumbers) await fs.unlink(mergedPath).catch(() => {});
    }

    if (options.outputPath) {
      const stat = await fs.stat(finalPath);
      return { path: finalPath, bytes: stat.size, concurrencyUsed: actualConcurrency };
    }

    const buf = await fs.readFile(finalPath);
    await fs.unlink(finalPath).catch(() => {});
    // No caller-visible path is needed for the common case: all intermediate
    // PDFs (chunks, merged file, and pagination stamp) have been removed by
    // this point, and the final PDF is returned directly.
    return buf;
  };
}

module.exports = { createGeneratePdfBatched, runWithConcurrency, getDynamicConcurrency };
