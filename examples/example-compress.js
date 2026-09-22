const fs = require('fs');
const { generatePdf, closeBrowser } = require('../src/index');

const htmlTemplate = (data) => `
  <html>
    <body style="font-family: Arial, sans-serif; padding: 40px;">
      <h1>Report: ${data.title}</h1>
      ${data.images.map((src) => `<img src="${src}" style="width:500px; display:block; margin-bottom:20px;" />`).join('')}
    </body>
  </html>
`;

(async () => {
  const data = {
    title: 'Monthly Photo Report',
    images: [
      // In real use these would be your actual base64 images or file:// / https:// paths
    ],
  };

  // Requires Ghostscript installed: apt-get install ghostscript / brew install ghostscript
  const base64Compressed = await generatePdf(htmlTemplate, data, {
    compress: 'standard', // or `true` (same thing), or 'screen' for smaller/lower quality
  });

  const buffer = Buffer.from(base64Compressed, 'base64');
  fs.writeFileSync('output-compressed.pdf', buffer);
  console.log('Compressed PDF written -> output-compressed.pdf');
  console.log('Size:', buffer.length, 'bytes');

  // You can also compress a PDF you already generated elsewhere:
  // const { compressPdf } = require('../src/index');
  // const smaller = await compressPdf(existingPdfBuffer, 'standard');

  await closeBrowser();
})();
