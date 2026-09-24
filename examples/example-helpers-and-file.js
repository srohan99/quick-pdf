const fs = require('fs');
const path = require('path');
const { generatePdf, registerHelper, closeBrowser } = require('../src/index');

// Register custom helpers BEFORE the first generatePdf() call that uses
// them — registration is global, and compiled templates are cached, so
// a helper registered after a template's first render won't apply to
// that already-cached compile.
registerHelper('ifEquals', function (operand1, operator, operand2, options) {
  const operators = {
    '===': (l, r) => l === r,
    '!==': (l, r) => l !== r,
    '>=': (l, r) => l >= r,
    '<': (l, r) => l < r,
  };
  const result = operators[operator](operand1, operand2);
  return result ? options.fn(this) : options.inverse(this);
});

// You can pass a .handlebars/.hbs file path directly — quick-pdf-gen detects
// it by extension + existence on disk, reads it, and caches the
// compiled version by path (so repeated calls with the same path only
// compile once).
const templatePath = path.join(__dirname, 'invoice.handlebars');

// Write a small sample .handlebars file for this example to point at
if (!fs.existsSync(templatePath)) {
  fs.writeFileSync(
    templatePath,
    `<html><body>
      <h1>Invoice #{{invoiceNumber}}</h1>
      {{#ifEquals riskScore '>=' 8}}
        <p style="color:red">HIGH PRIORITY</p>
      {{else}}
        <p>Standard</p>
      {{/ifEquals}}
    </body></html>`
  );
}

const data = { invoiceNumber: '1042', riskScore: 9 };

(async () => {
  const base64Pdf = await generatePdf(templatePath, data);
  fs.writeFileSync('output-from-file.pdf', Buffer.from(base64Pdf, 'base64'));
  console.log('PDF from .handlebars file generated -> output-from-file.pdf');

  await closeBrowser();
})();
