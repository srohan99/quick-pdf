const { generatePdfBatched, registerHelper } = require('../src/index');

// Example: 150 findings, one per page (page-break-after: always in CSS),
// rendered in parallel and merged. Concurrency is computed dynamically
// from CPU cores/free memory unless overridden below.

registerHelper('ifEquals', function (a, operator, b, options) {
  const ops = { '>=': (l, r) => l >= r, '===': (l, r) => l === r };
  return ops[operator](a, b) ? options.fn(this) : options.inverse(this);
});

const findings = Array.from({ length: 150 }, (_, i) => ({
  id: i + 1,
  title: `Finding #${i + 1}`,
  riskScore: (i % 10) + 1,
}));

function buildChunkHtml(chunkItems, meta) {
  const pages = chunkItems
    .map((item, i) => {
      const absolutePageNumber = meta.pageOffset + i + 1; // your own numbering, not Puppeteer's
      return `
        <div style="page-break-after: always; padding: 40px; font-family: Arial;">
          <h1>${item.title}</h1>
          <p>Risk score: ${item.riskScore}</p>
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
  const result = await generatePdfBatched(findings, buildChunkHtml, {
    outputPath: '/tmp/batched-report.pdf',
    // concurrency: 6, // uncomment to force an exact split instead of the dynamic default
    generateOptions: { compress: 'standard' },
  });

  console.log('Written to:', result.path);
  console.log('Size:', (result.bytes / 1024 / 1024).toFixed(1), 'MB');
  console.log('Concurrency used:', result.concurrencyUsed);
})();
