const fs = require('fs');
const { generatePdf, closeBrowser } = require('../src/index');

// Native JS template — fastest option, no Handlebars parsing/compiling at all
const htmlTemplate = (data) => `
  <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; padding: 40px; }
        h1 { color: #2c3e50; }
      </style>
    </head>
    <body>
      <h1>Invoice #${data.invoiceNumber}</h1>
      <p>Customer: ${data.customerName}</p>
      <ul>
        ${data.items.map((item) => `<li>${item.name} - ${item.price}</li>`).join('')}
      </ul>
      <h3>Total: ${data.total}</h3>
    </body>
  </html>
`;

const data = {
  invoiceNumber: '1042',
  customerName: 'John Doe',
  items: [
    { name: 'Web Design', price: '$400' },
    { name: 'Hosting (1yr)', price: '$100' },
  ],
  total: '$500',
};

(async () => {
  const base64Pdf = await generatePdf(htmlTemplate, data);
  fs.writeFileSync('output-native.pdf', Buffer.from(base64Pdf, 'base64'));
  console.log('Native JS template PDF generated -> output-native.pdf');

  await closeBrowser();
})();
