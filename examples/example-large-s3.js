const { generatePdf, closeBrowser } = require('../src/index');

// Example: a large report pulling images from S3 (or any remote host).
//
// quick-pdf-gen handles remote images automatically: after the page loads,
// every <img> is individually waited on (load or error, each with its
// own failsafe timeout) rather than relying only on a generic
// network-idle heuristic — so you don't need to fiddle with waitUntil
// just to get S3 images to render reliably.
//
// Two things you still DO need to set explicitly for a genuinely large
// job like this:
//
// 1. timeout — raised well above the 30s default, since many/large
//    remote images take longer than typical local-HTML rendering.
// 2. outputPath — instead of the default base64 return. For large PDFs,
//    base64 inflates the size ~33% and can exceed Node's max string
//    length outright (crashes with "RangeError: Invalid string length").
//    outputPath writes straight to disk instead.

const htmlTemplate = (data) => `
  <html>
    <body style="font-family: Arial, sans-serif;">
      <h1>${data.title}</h1>
      ${data.imageUrls.map((url) => `<img src="${url}" style="width:100%; display:block; margin-bottom:20px;" />`).join('')}
    </body>
  </html>
`;

const data = {
  title: 'Large Photo Report',
  imageUrls: [
    // Use presigned URLs if the bucket is private — Puppeteer just needs
    // a URL it can GET, it doesn't handle AWS auth/signing itself.
    'https://your-bucket.s3.amazonaws.com/photo1.jpg',
    'https://your-bucket.s3.amazonaws.com/photo2.jpg',
    // ...potentially hundreds/thousands more for a genuinely huge report
  ],
};

(async () => {
  const result = await generatePdf(htmlTemplate, data, {
    timeout: 300000,             // 5 minutes — raise further for very many/large images
    imageTimeout: 90000,         // per-image failsafe — one slow image won't hang the whole job
    outputPath: '/tmp/large-report.pdf', // writes directly to disk, never returns base64
    compress: 'standard',        // strongly recommended at this scale — shrinks images
                                  // without visible quality loss, can cut file size 80%+
    launch: { maxOldSpaceSizeMb: 4096 }, // raises Chromium's V8 heap ceiling for huge pages
                                          // (only takes effect on the FIRST call in a process)
  });

  console.log('Written to:', result.path);
  console.log('Size:', (result.bytes / 1024 / 1024).toFixed(1), 'MB');

  await closeBrowser();
})();

// Note on true multi-GB single documents: even with outputPath, a single
// Chromium tab rendering an enormous DOM (many thousands of large images
// on one page) can hit browser-side memory limits and crash the tab
// ("Page crashed!") well before hitting any Node-side limit. If you're
// generating something in the multi-GB range, it's more reliable to
// split the content into batches (e.g. 50-100 images per PDF), generate
// each batch separately, then merge the resulting PDF files with a tool
// like `qpdf --empty --pages a.pdf b.pdf c.pdf -- merged.pdf` (qpdf is a
// system binary, same install story as Ghostscript) rather than asking
// one page.pdf() call to produce the entire multi-GB document at once.
