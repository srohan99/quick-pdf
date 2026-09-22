const fs = require('fs');
const { generatePdfBatched, registerHelper } = require('../src/index');

// Full pipeline for the "170-180 pages, ~300MB, image-heavy" case:
// 1. generatePdfBatched splits the work across parallel Puppeteer pages
//    (dynamic concurrency based on your machine's CPU/memory)
// 2. Each chunk's generatePdf() call automatically pre-resizes embedded
//    images via sharp BEFORE Chromium renders them (if sharp is
//    installed — auto-detected, gracefully skipped otherwise)
// 3. Because images are already small after step 2, auto-compress
//    usually doesn't even trigger — nothing left worth shrinking
// 4. outputPath is used throughout, so nothing this large ever needs
//    to become a single in-memory base64 string

registerHelper('ifEquals', function (a, operator, b, options) {
  const ops = { '>=': (l, r) => l >= r, '===': (l, r) => l === r };
  return ops[operator](a, b) ? options.fn(this) : options.inverse(this);
});

// Simulate 180 report sections, each with one embedded image
const sections = Array.from({ length: 180 }, (_, i) => ({
  id: i + 1,
  title: `Section ${i + 1}`,
  // In real use: base64 image data from your actual photos (700KB-1MB each)
  imageBase64: '', // placeholder — plug in your real base64 image data here
}));

function buildChunkHtml(chunkItems, meta) {
  const pages = chunkItems
    .map((item, i) => {
      const absolutePageNumber = meta.pageOffset + i + 1;
      const img = item.imageBase64
        ? `<img src="data:image/jpeg;base64,${item.imageBase64}" style="width:500px;" />`
        : '';
      return `
        <div style="page-break-after: always; padding: 40px; font-family: Arial;">
          <h1>${item.title}</h1>
          ${img}
          <p style="position:fixed; bottom:20px; font-size:10px;">
            Page ${absolutePageNumber} of ${meta.totalPages}
          </p>
        </div>
      `;
    })
    .join('');
  return `<html><body>${pages}</body></html>`;
}

(async () => {
  const start = performance.now();

  const result = await generatePdfBatched(sections, buildChunkHtml, {
    outputPath: '/tmp/large-optimized-report.pdf',
    // concurrency omitted — computed dynamically from CPU/memory
    generateOptions: {
      // optimizeImages/compress/timeout all omitted too — auto-detected
      // per chunk based on that chunk's actual image content
    },
  });

  const elapsed = ((performance.now() - start) / 1000).toFixed(1);
  console.log('Written to:', result.path);
  console.log('Size:', (result.bytes / 1024 / 1024).toFixed(1), 'MB');
  console.log('Concurrency used:', result.concurrencyUsed);
  console.log('Total time:', elapsed, 's');
})();
