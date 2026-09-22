# quick-pdf

Give it an HTML template + data → get back a PDF as base64 (or write
straight to disk for large files). One shared Puppeteer browser instance
is reused across every call, so you don't pay the browser-launch cost
per request.

## Install

```bash
npm install quick-pdf
```
`puppeteer` and `handlebars` are installed automatically as dependencies
— no separate install step needed.

## Usage

```js
const { generatePdf, closeBrowser } = require('quick-pdf');

const html = `<h1>Hello {{name}}</h1>`;
const base64Pdf = await generatePdf(html, { name: 'John' });

// e.g. write to disk:
fs.writeFileSync('out.pdf', Buffer.from(base64Pdf, 'base64'));
```

Call `closeBrowser()` once when your app shuts down (not after every PDF):
```js
process.on('SIGTERM', async () => {
  await closeBrowser();
  process.exit(0);
});
```

## Template modes (auto-detected, no config)

```js
generatePdf('<h1>{{name}}</h1>', data)                    // Handlebars string
generatePdf((data) => `<h1>${data.name}</h1>`, data)       // native JS function — fastest
generatePdf(path.join(__dirname, 'invoice.handlebars'), data) // .handlebars/.hbs file path
generatePdf('<h1>Fixed content</h1>')                      // static HTML, no data needed
```

- **Function** — fastest, no parsing/compiling at all.
- **.handlebars/.hbs file path** — detected by extension + the file
  actually existing on disk. Read and compiled once, then cached by
  path for repeated calls.
- **String with `{{...}}`** — compiled with Handlebars, cached by the
  exact string.
- **Plain string with no `{{`** — returned as-is, zero processing.

## Custom Handlebars helpers

No helpers are registered by default — this is intentionally left to
you, since helper needs are entirely project-specific.

```js
const { registerHelper, registerPartial } = require('quick-pdf');

registerHelper('ifEquals', function (a, operator, b, options) {
  const ops = { '===': (l, r) => l === r, '>=': (l, r) => l >= r /* ... */ };
  return ops[operator](a, b) ? options.fn(this) : options.inverse(this);
});
// template: {{#ifEquals status '===' "active"}}...{{/ifEquals}}

registerPartial('footer', '<div>{{companyName}}</div>');
// template: {{> footer}}
```

**Register helpers once at startup**, before any `generatePdf()` call
that needs them — ideally in one dedicated file you `require()` first:

```js
// helpers.js — side-effect import, registers everything
const { registerHelper } = require('quick-pdf');
registerHelper('ifEquals', function (a, b, options) { /* ... */ });
module.exports = {};
```
```js
// main.js
require('./helpers'); // must come first
const { generatePdf } = require('quick-pdf');
```

Compiled templates are cached, so a helper registered *after* a
template's first render won't retroactively apply to that cached
version — always register before first use.

## Dynamic footer, header & margins

```js
const footerTemplate = `
  <div style="font-size:10px; width:100%; text-align:center; color:#888;">
    {{companyName}} · Page <span class="pageNumber"></span> of <span class="totalPages"></span>
  </div>
`;

const base64Pdf = await generatePdf(htmlTemplate, data, {
  footerTemplate,
  headerTemplate: '<div style="font-size:9px;">{{customerName}}</div>',
  pdf: {
    margin: { top: '80px', bottom: '70px', left: '30px', right: '30px' },
  },
});
```

- `footerTemplate`/`headerTemplate` accept the same three template modes
  as the main body (string/Handlebars/function/file), and use the same
  `data`, plus Puppeteer's built-in classes: `pageNumber`, `totalPages`,
  `date`, `title`, `url`.
- If you set a header/footer, margin space (60px top/bottom) is
  auto-reserved so text doesn't get clipped — override via `pdf.margin`.
- Margins accept any CSS unit: `'20px'`, `'1in'`, `'10mm'`, `'2cm'`.

## Automatic image optimization (the real fix for slow image-heavy PDFs)

The actual bottleneck in image-heavy PDF generation usually isn't
Chromium or Ghostscript individually — it's that **both** end up
decoding the same full-resolution source images: Chromium to paint
them, then Ghostscript again to compress them afterward. `quick-pdf`
fixes this at the root by resizing/recompressing embedded base64 images
**before** Chromium ever sees them, using `sharp` (built on `libvips`,
a fast native C library).

```bash
npm install sharp   # optional dependency — installs automatically with
                     # `npm install quick-pdf`, but generatePdf() gracefully
                     # skips this optimization if it's genuinely missing
```

**Auto-enabled** once estimated embedded-image weight exceeds ~5MB —
lower than `compress`'s ~20MB threshold, since resizing is fast and
usually removes the need for compression entirely (the output is
already small). If `sharp` isn't installed, this auto-path silently
skips and falls back to the old Ghostscript-only behavior — upgrading
`quick-pdf` never breaks existing PDF generation just because `sharp`
hasn't been added yet.

```js
// Defaults handle this automatically — no config needed:
const base64Pdf = await generatePdf(htmlTemplate, data);

// Force it on/off, or tune the resize target:
const base64Pdf = await generatePdf(htmlTemplate, data, {
  optimizeImages: { maxWidthPx: 600, quality: 80 }, // default: 800px / quality 80
});
const base64Pdf = await generatePdf(htmlTemplate, data, { optimizeImages: false });
```

Only affects **embedded base64 images** (`<img src="data:image/...">`)
— remote (`http`/`https`) `<img>` URLs aren't fetched/resized, since
that would add network round-trips of its own. There's a built-in
safety net too: if re-encoding an image would somehow produce a
*larger* result than the original, the original is kept unchanged.

Image proportions are always preserved. For an `<img>` with no explicit
width or height, optimization also keeps its original natural display size,
so shrinking the source does not change the PDF layout. Set
`preserveDimensions: false` if you want the resized pixel dimensions to
control its natural display size instead.

To target a maximum encoded image size, use `maxOutputBytes`. This is useful
when source photos are a few hundred KB but the PDF needs approximately 50 KB
per image:

```js
optimizeImages: {
  remote: true,        // for S3/AWS URLs
  maxWidthPx: 1200,
  quality: 80,
  maxOutputBytes: 50 * 1024, // 50 KB per image
}
```

The optimizer tries lower JPEG quality first, then reduces resolution only if
needed to meet the ceiling. The PDF layout is retained by default even when
the image pixels are reduced.


### AWS/S3 image URLs

For public or presigned AWS/S3 URLs, opt into downloading and optimizing the
remote `<img>` sources before each PDF is rendered. This works with
`generatePdf`, `generatePdfBatched`, and `generateChunkedPdf` through their
`generateOptions`.

```js
const result = await generateChunkedPdf({
  template,
  data,
  chunkKey: 'findings',
  generateOptions: {
    optimizeImages: {
      remote: true,
      maxWidthPx: 1200,
      quality: 80,
    },
  },
});
```

Remote optimization is opt-in because it makes server-side HTTP requests.
Failed, non-image, or oversized downloads keep their original URL and use the
normal browser image-loading path. The defaults allow 100 images per PDF and
25 MB per image; tune `maxRemoteImages` and `maxRemoteImageBytes` if needed.

## Automatic timeout/compress/outputPath detection

`generatePdf` scans the rendered HTML for embedded/remote images and
auto-configures three things you'd otherwise have to guess at — all
overridable by setting them explicitly:

- `timeout`: `30s + 1s per image`, capped at 10 minutes
- `compress`: auto-`'standard'` once estimated weight (after any image
  optimization above) exceeds ~20MB
- `outputPath`: auto-generates a temp file path once estimated size
  exceeds ~250MB (avoiding the base64 string-length crash entirely)

```js
// Before: manual tuning
await generatePdf(template, data, {
  timeout: 300000, outputPath: '/tmp/report.pdf', compress: 'standard',
});

// After: same result, auto-detected from actual content
await generatePdf(template, data);
```

## Automatic image & font handling

Every call automatically, no config needed:
- Waits for **every individual `<img>`** to finish loading (or fail) —
  each with its own failsafe timeout — rather than trusting a generic
  network-idle heuristic, which can resolve before slow images (e.g.
  large S3-hosted photos) have actually finished loading.
- Waits for **web fonts** (`document.fonts.ready`).

This is why remote images work reliably without you having to reason
about `waitUntil` at all. It's a no-op (instant) on pages with no images.

```js
// Defaults are usually enough — even for remote images:
const base64Pdf = await generatePdf(htmlTemplate, data);

// Tune for a genuinely large/slow job:
const base64Pdf = await generatePdf(htmlTemplate, data, {
  timeout: 300000,      // 5 min — page.setContent() AND page.pdf()
  imageTimeout: 90000,  // per-image failsafe — one slow image won't hang the job
  settleDelay: 2000,    // extra pause after everything settles, for large/complex pages
});

// Skip the automatic image wait entirely (you know there are no images):
const base64Pdf = await generatePdf(htmlTemplate, data, { waitForImages: false });
```

## Compression

None of the popular HTML-to-PDF npm packages (`html-pdf-node`,
`puppeteer-html-pdf`, `pdf-puppeteer`) offer PDF compression — Puppeteer's
`page.pdf()` doesn't have one either. quick-pdf adds it via Ghostscript,
the same engine most PDF software uses under the hood for this.
**Off by default** — pass `compress` to opt in.

**Requires Ghostscript installed on the system** (system binary, not npm):
```bash
sudo apt-get install ghostscript   # Ubuntu/Debian
brew install ghostscript           # macOS
choco install ghostscript          # Windows
```

```js
const base64Pdf = await generatePdf(htmlTemplate, data);              // default: no compression
const smaller = await generatePdf(htmlTemplate, data, { compress: true }); // 'standard' preset
const smallest = await generatePdf(htmlTemplate, data, { compress: 'screen' });

const { compressPdf } = require('quick-pdf');
const smallerBuffer = await compressPdf(existingPdfBuffer, 'standard');
```

| Preset | Image DPI | Quality | Typical use |
|---|---|---|---|
| `screen` | 72 | Visible quality loss | Email attachments, throwaway previews |
| `standard` | 150 | **No visible quality loss** — recommended default | Reports, invoices, everyday documents |
| `printer` | 300 | High quality | Documents meant to be printed |
| `prepress` | Untouched | Print-shop quality | When quality must not change at all |

The technique follows [shrinkpdf.sh](https://github.com/aklomp/shrinkpdf):
Ghostscript's `/screen` macro is used as a compression-filter baseline,
then the actual image resolution is explicitly overridden afterward —
real DPI control instead of a preset macro's hardcoded internal default.
Verified by measuring actual embedded-image DPI with `pdfimages -list`
on a 260-DPI test image: `screen` → exactly 72 DPI (96.6% smaller),
`standard` → exactly 150 DPI (85.1% smaller), `printer`/`prepress` left
the already-lower-than-target source untouched (0% — original returned
as-is, a built-in safety net for when compressing wouldn't help).

```js
{ compress: { preset: 'standard', grayscale: true } }  // extra size cut for B&W-fine docs
{ compress: { preset: 'standard', resolution: 120 } }   // custom DPI
```

If Ghostscript isn't installed, `compress` throws a clear error telling
you which command to run.

## Large PDFs (100s of MB to GB scale, S3-hosted images)

The default base64 return **cannot handle very large PDFs at all** —
base64 inflates a buffer by ~33%, and Node has a hard max string length
(roughly 512MB-1GB depending on version/platform). Encoding a ~1GB PDF
to base64 can throw `RangeError: Invalid string length` outright.

Use `options.outputPath` for anything large — Puppeteer writes the PDF
straight to disk, and (if `compress` is also set) Ghostscript compresses
file-to-file too, so the full PDF never has to exist as one big JS
Buffer/string in Node's memory at any point:

```js
const result = await generatePdf(htmlTemplate, data, {
  outputPath: '/tmp/report.pdf',
  timeout: 300000,
  compress: 'standard',
  launch: { maxOldSpaceSizeMb: 4096 }, // only takes effect on the FIRST call in a process
});
console.log(result); // { path: '/tmp/report.pdf', bytes: 48213000 }
```

Compress a huge PDF you already have on disk, file-to-file, without
loading it into memory:
```js
const { compressFile } = require('quick-pdf');
await compressFile('/tmp/big-input.pdf', '/tmp/big-output.pdf', 'standard');
```

**A note on true multi-GB single documents:** even with `outputPath`, a
single Chromium tab rendering an enormous DOM (thousands of large images
on one page) can hit browser-side memory limits and crash the tab
("Page crashed!") — `outputPath` protects Node's memory, not Chromium's.
For multi-GB output, split content into batches, generate each batch
separately, and merge with a system tool:
```bash
qpdf --empty --pages part1.pdf part2.pdf part3.pdf -- merged.pdf
```

See `examples/example-large-s3.js` for a full walkthrough.

## Lowest-code chunked rendering: `generateChunkedPdf`

`generatePdfBatched` above requires you to hand-write the chunk-data
construction (spreading `...data`, computing `isFirstChunk`/`pageOffset`
yourself) every time. `generateChunkedPdf` does that automatically —
point it at your template, full data, and which array field to split:

```js
const { generateChunkedPdf } = require('quick-pdf');

const result = await generateChunkedPdf({
  template: path.join(__dirname, 'report.handlebars'),
  data,                          // your FULL data object, unsplit
  chunkKey: 'nonComplianceList', // the array to auto-split
  generateOptions: { footerTemplate, headerTemplate },
});
```

`outputPath` is optional. If omitted, quick-pdf writes chunk and merge files
only to its internal temporary directory, returns the final PDF as a `Buffer`,
and removes every temporary file before the promise resolves.

### `chunkKey` is required

`chunkKey` identifies the array field (or fields) that quick-pdf should split.
Pass a string for one array or an array of strings for multiple arrays. Each
named field must exist in `data` and be an array; nested fields use dot paths.

```js
await generateChunkedPdf({
  template,
  data: { findings: [{ title: 'Missing guardrail' }] },
  chunkKey: 'findings',
});
```

If `chunkKey` is omitted, empty, or otherwise falsy, no PDF is generated and
the promise rejects with:

```text
generateChunkedPdf: `chunkKey` is required (array field name, or array of names, to split)
```

If a supplied key does not resolve to an array, it rejects with an error such
as `generateChunkedPdf: data.findings must be an array`.

Every chunk's data automatically gets: the sliced array, `isFirstChunk`,
`isLastChunk`, `pageOffset`, `totalPages` — plus everything else from
your original `data` object unchanged (other arrays/fields pass through
whole in every chunk, not split).

**Multiple arrays**, two cases:

- **Other arrays that shouldn't split** (e.g. a `crewList` reference
  table) — nothing to configure, they pass through whole automatically,
  only `chunkKey`'s array gets sliced.
- **Multiple arrays to split** — pass an array of keys. Equal-length arrays
  (e.g. `findings[i]` and `findingImages[i]`) stay aligned by index. Arrays
  with different lengths are rendered as consecutive sections in the order
  listed in `chunkKey`, avoiding interleaved report sections:
  ```js
  generateChunkedPdf({
    template, data,
    chunkKey: ['findings', 'findingImages'], // sliced at identical boundaries
    outputPath: '/tmp/report.pdf',
  });
  ```
  Nested array fields are supported with dot paths, so data shaped like
  `chapter17Photo: { Hull: [], Test: [] }` can be included directly:
  ```js
  generateChunkedPdf({
    template, data,
    chunkKey: ['complianceList', 'chapter17Photo.Hull', 'chapter17Photo.Test'],
  });
  ```
  This means unrelated collections such as a 228-item `complianceList` and
  a 9-item `chapter17Photo.Hull` can be chunked together without padding
  either collection. For unequal arrays, `pageOffset` and `totalPages` count
  the independently rendered items across all selected arrays (under the
  usual one-item/one-page convention). Put keys in the same order their
  sections appear in your template.

## Parallel batch rendering for large item-based documents

If your document is really "N items, each rendering as its own page or
section" (e.g. 150 findings in an inspection report), `generatePdfBatched`
splits the items into chunks and renders them **in parallel** across
multiple Puppeteer pages under the same shared browser, then merges the
results with `qpdf`. This is a real wall-clock speedup — it uses multiple
CPU cores instead of one page rendering everything sequentially.

Requires `qpdf` installed on the system:
```bash
sudo apt-get install qpdf   # Ubuntu/Debian
brew install qpdf           # macOS
```

```js
const { generatePdfBatched } = require('quick-pdf');

const result = await generatePdfBatched(
  data.findings, // e.g. 150 items, one per page
  (chunkItems, meta) => {
    // Build HTML for just this chunk. Use meta.pageOffset to compute
    // correct absolute page numbers yourself — see caveat below.
    return buildReportHtml({ ...data, findings: chunkItems, pageOffset: meta.pageOffset });
  },
  {
    outputPath: '/tmp/report.pdf',
    generateOptions: { compress: 'standard', timeout: 120000 },
  }
);
console.log(result); // { path, bytes, concurrencyUsed }
```

**Concurrency is dynamic by default** — computed from the machine's CPU
cores and free memory, not a fixed guess:
- CPU ceiling: `cores - reserveCores` (default reserves 1 core for Node/OS)
- Memory ceiling: `freeMemory / memPerChunkMb` (default assumes 300MB per
  concurrent chunk — raise `memPerChunkMb` if your chunks have many/large
  images, for a safer/lower number)
- The smaller of the two wins, capped by `maxConcurrency` (default 8) and
  never exceeding the number of chunks

Override with `options.concurrency` if you want an exact fixed number
instead (e.g. `{ concurrency: 6 }` for "always split into 6 parts").

**Important caveat on page numbers:** Puppeteer's built-in
`<span class="pageNumber">`/`<span class="totalPages">` footer resets
*per chunk* — chunk 2 would print "Page 1 of 25" instead of "Page 26 of
150", since each chunk is an independent `page.pdf()` call. This only
produces correct running numbers if **each item renders as exactly one
physical page** (e.g. `page-break-after: always` per item in your CSS),
because then page counts are predictable before rendering and
`meta.pageOffset` will be accurate. Use `meta.pageOffset` in your own
footer template instead of Puppeteer's built-in classes. If item height
varies and can overflow onto extra pages, the offsets will be wrong —
you'll still get a valid merged PDF, just with incorrect footer numbers.

### Accurate page numbers for variable-height chunked content

When items can flow onto more than one physical page, quick-pdf automatically
handles correct pagination whenever `generateOptions` has a header or footer.
It first renders and merges the chunks, counts the actual PDF pages, then
stamps the header/footer over the merged result. This preserves chunking while
making Chromium's built-in counters accurate:

```js
await generateChunkedPdf({
  template, data, chunkKey: 'findings',
  outputPath: '/tmp/report.pdf',
  generateOptions: {
    footerTemplate: `
      <div style="font-size:10px; width:100%; text-align:center;">
        Page <span class="pageNumber"></span> of <span class="totalPages"></span>
      </div>`,
  },
});
```

Do not print `pageOffset`/`totalPages` inside the document body when using
chunking; those values are item-based and cannot represent pages that
overflow. Header/footer templates may use normal document data (for example
`{{companyName}}`); `generateChunkedPdf` supplies the original full data to
the final stamp. With `generatePdfBatched`, pass that data as
`paginationData`.

Set `physicalPageNumbers: false` only if you intentionally need legacy
per-chunk header/footer counters.

## Speed

Three things make this fast, in order of impact:
1. **Shared browser instance** — Puppeteer launches once per process;
   only a lightweight `page` opens/closes per PDF.
2. **`domcontentloaded` by default** — correctness for images/fonts is
   handled separately and automatically (see above), so you don't need
   to tune `waitUntil` for that.
3. **Compiled-template caching** — the same Handlebars string or
   `.handlebars` file path is only compiled once, even across many calls.

## API

### `generatePdf(htmlTemplate, data?, options?)`
- `htmlTemplate` — Handlebars string, `.handlebars`/`.hbs` file path,
  static HTML string, or `(data) => html` function
- `data` — object passed into the template
- `options.pdf` — passed straight to Puppeteer's `page.pdf()`
- `options.headerTemplate` / `options.footerTemplate` — same template
  rules as `htmlTemplate`
- `options.waitUntil` — `'domcontentloaded'` (default) — coarse signal only
- `options.timeout` — max ms for `page.setContent()` and `page.pdf()` (default 30000)
- `options.waitForImages` — default `true`; set `false` to skip
- `options.imageTimeout` — max ms per image (default 90000)
- `options.settleDelay` — extra ms after images/fonts settle (default 0)
- `options.compress` — off by default; auto-enabled above ~20MB estimated weight (see Compression)
- `options.optimizeImages` — auto-enabled above ~5MB estimated weight if `sharp` is installed (see Automatic image optimization)
- `options.outputPath` — write directly to disk instead of base64 (see Large PDFs)
- `options.launch` — passed to `puppeteer.launch()`, first call only.
  `launch.maxOldSpaceSizeMb` raises Chromium's V8 heap ceiling.

Returns: `Promise<string>` (base64), or `Promise<{path, bytes}>` if `outputPath` is set

### `closeBrowser()`
Closes the shared browser. Call on graceful shutdown, not per-request.

### `compressPdf(buffer, quality?)` / `compressFile(inputPath, outputPath, quality?)`
Compress a PDF you already have. `compressFile` is file-to-file (safe
for huge files); `compressPdf` is a buffer-based convenience wrapper
around it.

### `registerHelper(name, fn)` / `registerPartial(name, template)`
Register custom Handlebars helpers/partials on the shared instance.

### `getHandlebarsInstance()`
Returns the live Handlebars module itself — for anything
`registerHelper`/`registerPartial` don't cover, most commonly
`Handlebars.SafeString` (needed when a helper returns raw HTML that
shouldn't be escaped) or `Handlebars.Utils`.

### `generatePdfBatched(items, renderChunk, options?)`
Parallel chunk-based rendering for large item-based documents, merged
with `qpdf`. See "Parallel batch rendering" above — including the
page-numbering caveat, which matters if your footer shows page counts.
Note: `renderChunk` can return a plain template, OR `{ template, data }`
when the template needs per-chunk Handlebars data injected.

### `generateChunkedPdf(config)`
Lowest-code wrapper around `generatePdfBatched` — see "Lowest-code
chunked rendering" above. Handles chunk-data construction, first/last
flags, and page offsets automatically; supports single or multiple
(parallel/synced) array fields via the required `chunkKey`. The selected
field(s) must be arrays; omitted or falsy `chunkKey` values reject before
rendering begins.

## Examples

- `examples/example-handlebars.js` — invoice using `{{ }}` string templates + footer
- `examples/example-native.js` — same invoice using a native JS template function
- `examples/example-compress.js` — generating with compression enabled
- `examples/example-large-s3.js` — large PDF with remote S3 images, `outputPath`, compression
- `examples/example-helpers-and-file.js` — custom Handlebars helper + `.handlebars` file template
- `examples/example-batched.js` — `generatePdfBatched` with dynamic concurrency
- `examples/example-chunked.js` — `generateChunkedPdf`, single-key and multi-key (parallel arrays)
- `examples/example-optimized-large.js` — full pipeline: batched + auto image optimization for large docs

## Notes

- If you deploy to serverless (AWS Lambda, Vercel, etc.), swap
  `puppeteer` for `puppeteer-core` + `@sparticuz/chromium` — full
  Puppeteer bundles a ~300MB Chromium that won't fit typical Lambda limits.
- Remote images are handled automatically (see "Automatic image & font
  handling") — you generally don't need to touch `waitUntil` at all.
- The browser launches once per process with stability flags suited to
  heavy rendering. These — and `launch.maxOldSpaceSizeMb` — only take
  effect on the *first* `generatePdf()` call, since the browser is
  reused after that.
- Handlebars has **no optional-chaining operator** (`?.`) — use plain
  dot paths (`a.b.c`); Handlebars already returns `undefined` for any
  missing intermediate property on its own.
- If a helper uses module-level mutable state (e.g. a page-index
  counter across a loop), remember the browser/process is long-lived —
  reset that state explicitly at the start of each document, or it will
  carry over incorrectly into the next `generatePdf()` call.
# quick-pdf
