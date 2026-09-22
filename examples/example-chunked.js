const { generateChunkedPdf, registerHelper } = require('../src/index');
const fs = require('fs');
registerHelper('ifFirstChunk', function (options) {
  return this.isFirstChunk ? options.fn(this) : options.inverse(this);
});
registerHelper('ifLastChunk', function (options) {
  return this.isLastChunk ? options.fn(this) : options.inverse(this);
});

const template = (data) => `
  <html><body style="font-family: Arial;">
    ${data.isFirstChunk ? `<h1>${data.reportTitle}</h1><p>Crew: ${data.crewList.join(', ')}</p>` : ''}
    ${data.findings
      .map((f, i) => `
        <div style="page-break-after: always; padding: 40px;">
          <h2>${f.title}</h2>
          <img src="${data.findingImages[i] || ''}" style="width:400px;" />
          <p style="position:fixed; bottom:20px; font-size:10px;">
            Page ${data.pageOffset + i + 1} of ${data.totalPages}
          </p>
        </div>
      `)
      .join('')}
    ${data.isLastChunk ? '<div style="page-break-after: always;"><h2>Report End</h2></div>' : ''}
  </body></html>
`;

const findings = Array.from({ length: 40 }, (_, i) => ({ title: `Finding #${i + 1}` }));
const findingImages = Array.from({ length: 40 }, (_, i) => `https://example.com/photo${i + 1}.jpg`);

(async () => {
  // Single-key example — only `findings` gets split
  const result1 = await generateChunkedPdf({
    template,
    data: { reportTitle: 'Single-Key Example', findings, findingImages: [], crewList: ['A', 'B'] },
    chunkKey: 'findings',
    outputPath: '/tmp/chunked-single-key.pdf',
  });
  console.log('Single-key result:', result1);

  // Multi-key example — findings + findingImages split together, in sync
  const result2 = await generateChunkedPdf({
    template,
    data: { reportTitle: 'Multi-Key Example', findings, findingImages, crewList: ['A', 'B'] },
    chunkKey: ['findings', 'findingImages'], // sliced at identical boundaries
    outputPath: '/tmp/chunked-multi-key.pdf',
  });
  fs.writeFileSync(result2.path, Buffer.from(result2, 'base64'));
  console.log('Multi-key result:', result2);
})();
