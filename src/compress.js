const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');

/**
 * Compression uses Ghostscript (the "gs" binary) as an external process.
 * This is a deliberate choice, not a shortcut:
 *
 * - Puppeteer's page.pdf() has no compression option at all — none of the
 *   popular html-to-pdf npm wrappers (html-pdf-node, puppeteer-html-pdf,
 *   pdf-puppeteer) offer one either.
 * - "Lossless" PDF libraries (pdf-lib, qpdf) can only strip metadata and
 *   re-flate streams. Tested against a real image-heavy PDF: qpdf shaved
 *   off <1% because the streams were already compressed. It does not
 *   recompress the embedded images, which is where PDF size actually
 *   comes from — only Ghostscript does that.
 *
 * The flag layout below follows the well-known shrinkpdf.sh approach
 * (github.com/aklomp/shrinkpdf): pass -dPDFSETTINGS=/screen as a *baseline*
 * for its compression filters, then explicitly override the image
 * resolution/downsampling afterward. Ghostscript applies flags in order,
 * so later flags win — this gives real control over output quality
 * instead of being stuck with whatever DPI a preset macro hardcodes
 * internally.
 */

// DPI targets per preset. 'standard' is the recommended default: it
// downsamples large embedded images (which is where PDF size actually
// comes from) while staying well above the point where compression
// artifacts become visible on screen or in print.
const RESOLUTION_BY_PRESET = {
  screen: 72,     // smallest file, visible quality loss — email/preview only
  standard: 150,  // recommended default — no visible quality loss for typical reports/invoices
  printer: 300,   // high quality, still downsamples oversized source images
};

let gsAvailable = null; // cached after first check

function checkGhostscript() {
  if (gsAvailable !== null) return Promise.resolve(gsAvailable);
  return new Promise((resolve) => {
    const proc = spawn('gs', ['--version']);
    proc.on('error', () => {
      gsAvailable = false;
      resolve(false);
    });
    proc.on('exit', (code) => {
      gsAvailable = code === 0;
      resolve(gsAvailable);
    });
  });
}

/**
 * Reads the PDF version straight from the file header (e.g. "%PDF-1.7")
 * so Ghostscript's output stays compatible with whatever produced the
 * input, instead of a hardcoded guess. Falls back to '1.5' if unreadable,
 * matching shrinkpdf.sh's own fallback. Only reads the first 1024 bytes —
 * safe even on multi-GB files.
 */
async function detectPdfVersion(filePath) {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await fh.read(buf, 0, 1024, 0);
    const header = buf.subarray(0, bytesRead).toString('latin1');
    const match = header.match(/%PDF-(\d\.\d)/);
    return match ? match[1] : '1.5';
  } finally {
    await fh.close();
  }
}

function buildArgs({ preset, resolution, grayscale, compatibilityLevel, extraArgs, outputPath, inputPath }) {
  const args = [
    '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER',
    '-sDEVICE=pdfwrite',
    `-dCompatibilityLevel=${compatibilityLevel}`,
  ];

  if (preset === 'prepress') {
    // Print-shop quality: use the macro as-is, no forced downsampling.
    // Minimal size reduction — only for when quality must stay untouched.
    args.push('-dPDFSETTINGS=/prepress');
  } else {
    const dpi = resolution || RESOLUTION_BY_PRESET[preset] || RESOLUTION_BY_PRESET.standard;
    args.push(
      '-dPDFSETTINGS=/screen', // baseline filter behavior; resolution overridden below
      '-dEmbedAllFonts=true',
      '-dSubsetFonts=true',
      '-dAutoRotatePages=/None',
      '-dColorImageDownsampleType=/Bicubic',
      `-dColorImageResolution=${dpi}`,
      '-dGrayImageDownsampleType=/Bicubic',
      `-dGrayImageResolution=${dpi}`,
      '-dMonoImageDownsampleType=/Subsample',
      `-dMonoImageResolution=${dpi}`,
    );
    if (grayscale) {
      args.push('-sProcessColorModel=DeviceGray', '-sColorConversionStrategy=Gray', '-dOverrideICC');
    }
  }

  args.push(`-sOutputFile=${outputPath}`, ...(extraArgs || []), inputPath);
  return args;
}

function assertKnownPreset(preset) {
  if (!RESOLUTION_BY_PRESET[preset] && preset !== 'prepress') {
    throw new Error(
      `Unknown compression quality "${preset}". Use one of: screen, standard, printer, prepress.`
    );
  }
}

function assertGhostscriptOrThrow(available) {
  if (!available) {
    throw new Error(
      'quick-pdf-gen compression requires Ghostscript ("gs") to be installed on the system.\n' +
      '  Ubuntu/Debian: sudo apt-get install ghostscript\n' +
      '  macOS:         brew install ghostscript\n' +
      '  Windows:       choco install ghostscript (or download from ghostscript.com)\n' +
      'This is a system binary, not an npm package — Puppeteer alone cannot compress PDFs.'
    );
  }
}

function runGhostscript(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('gs', args);
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Ghostscript exited with code ${code}: ${stderr}`));
    });
  });
}

/**
 * Compress a PDF file on disk, writing the result to another path on disk.
 * Neither the input nor output ever needs to be fully loaded into Node's
 * memory — Ghostscript reads/writes the files directly. This is the path
 * to use for very large PDFs (hundreds of MB to multi-GB) where holding
 * the whole file in a JS Buffer/string would be wasteful or, for base64,
 * outright impossible (see compressPdf's docs on Node's string length cap).
 *
 * @param {string} inputPath - path to the source PDF
 * @param {string} outputPath - path to write the compressed PDF to
 * @param {string|object} [quality='standard'] - see compressPdf()
 * @returns {Promise<{path: string, bytes: number}>}
 */
async function compressFile(inputPath, outputPath, quality = 'standard') {
  const available = await checkGhostscript();
  assertGhostscriptOrThrow(available);

  const opts = typeof quality === 'string' ? { preset: quality } : quality;
  const preset = opts.preset || 'standard';
  assertKnownPreset(preset);

  const compatibilityLevel = await detectPdfVersion(inputPath);
  const args = buildArgs({
    preset,
    resolution: opts.resolution,
    grayscale: opts.grayscale,
    compatibilityLevel,
    extraArgs: opts.extraArgs,
    inputPath,
    outputPath,
  });

  await runGhostscript(args);

  const [inStat, outStat] = await Promise.all([fs.stat(inputPath), fs.stat(outputPath)]);

  // Safety net: if Ghostscript's output came out larger (rare, e.g.
  // mostly-text PDFs with nothing to downsample), keep the original
  // instead of shipping a needlessly reprocessed, bigger file.
  if (outStat.size >= inStat.size) {
    await fs.copyFile(inputPath, outputPath);
    return { path: outputPath, bytes: inStat.size };
  }

  return { path: outputPath, bytes: outStat.size };
}

/**
 * Compress a PDF buffer using Ghostscript. Internally just writes the
 * buffer to a temp file and calls compressFile() — for PDFs beyond a few
 * hundred MB, prefer compressFile() directly (or generatePdf's
 * `outputPath` option) so the whole file never sits in memory as a Buffer.
 *
 * @param {Buffer} pdfBuffer - raw PDF bytes (already-generated, uncompressed)
 * @param {string|object} [quality='standard'] - 'screen' | 'standard' | 'printer' | 'prepress',
 *   or an object { preset, resolution, grayscale, extraArgs } for manual control.
 *   `resolution` (DPI) overrides the preset's default if given.
 * @returns {Promise<Buffer>} compressed PDF bytes
 * @throws if Ghostscript ("gs") is not installed on the system
 */
async function compressPdf(pdfBuffer, quality = 'standard') {
  const tmpDir = os.tmpdir();
  const id = crypto.randomBytes(8).toString('hex');
  const inputPath = path.join(tmpDir, `quick-pdf-gen-in-${id}.pdf`);
  const outputPath = path.join(tmpDir, `quick-pdf-gen-out-${id}.pdf`);

  await fs.writeFile(inputPath, pdfBuffer);
  try {
    await compressFile(inputPath, outputPath, quality);
    return await fs.readFile(outputPath);
  } finally {
    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
  }
}

module.exports = { compressPdf, compressFile, checkGhostscript, RESOLUTION_BY_PRESET };
