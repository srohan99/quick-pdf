const fs = require('fs');
const { generatePdf, closeBrowser } = require('../src/index');

const htmlTemplate = `
<html>
  <head>
    <style>
      body { font-family: Arial, sans-serif; padding: 40px; }
      h1 { color: #2c3e50; }
      table { width: 100%; border-collapse: collapse; margin-top: 20px; }
      td, th { border: 1px solid #ddd; padding: 8px; text-align: left; }
    </style>
  </head>
  <body>
    <h1>Invoice #{{invoiceNumber}}</h1>
    <p>Customer: {{customerName}}</p>
    <p>Date: {{date}}</p>
    <table>
      <tr><th>Item</th><th>Qty</th><th>Price</th></tr>
      {{#each items}}
      <tr><td>{{this.name}}</td><td>{{this.qty}}</td><td>{{this.price}}</td></tr>
      {{/each}}
    </table>
    <h3>Total: {{total}}</h3>
  </body>
</html>
`;

const footerTemplate = `
  <div style="font-size:10px; width:100%; text-align:center; color:#888;">
    {{companyName}} &middot; Page <span class="pageNumber"></span> of <span class="totalPages"></span>
  </div>
`;

const data = {
  invoiceNumber: '1042',
  customerName: 'John Doe',
  companyName: 'Acme Corp',
  date: '2026-08-20',
  items: [
    { name: 'Web Design', qty: 1, price: '$400' },
    { name: 'Hosting (1yr)', qty: 1, price: '$100' },
  ],
  total: '$500',
};

(async () => {
  const base64Pdf = await generatePdf(htmlTemplate, data);
  fs.writeFileSync('output.pdf', Buffer.from(base64Pdf, 'base64'));
  console.log('Basic PDF generated -> output.pdf');

  const base64PdfWithFooter = await generatePdf(htmlTemplate, data, {
    footerTemplate,
    pdf: {
      margin: { top: '20px', bottom: '40px', right: '20px', left: '20px' },
    },
  });
  fs.writeFileSync('output-with-footer.pdf', Buffer.from(base64PdfWithFooter, 'base64'));
  console.log('PDF with footer generated -> output-with-footer.pdf');

  await closeBrowser();
})();
