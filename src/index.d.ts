export type HtmlTemplate = string | ((data: Record<string, any>) => string);

export type CompressQuality = 'screen' | 'standard' | 'printer' | 'prepress';

export interface CompressOptions {
  preset?: CompressQuality;
  /** DPI override — takes precedence over the preset's default. */
  resolution?: number;
  /** Convert to grayscale for extra size reduction. */
  grayscale?: boolean;
  extraArgs?: string[];
}

export interface LaunchOptions extends Record<string, any> {
  /** Raises Chromium's V8 heap ceiling (e.g. 4096) for pages with huge DOMs/many images. */
  maxOldSpaceSizeMb?: number;
  /** Default: 0 (unlimited) — bounded instead by GeneratePdfOptions.timeout. */
  protocolTimeout?: number;
}

export interface GeneratePdfOptions {
  pdf?: Record<string, any>;
  headerTemplate?: HtmlTemplate;
  footerTemplate?: HtmlTemplate;
  /** Coarse first-pass signal only — the automatic per-image wait (see waitForImages)
   *  is what actually guarantees images are loaded, so this rarely needs changing. */
  waitUntil?: 'domcontentloaded' | 'load' | 'networkidle0' | 'networkidle2';
  /** Max ms for page.setContent() AND page.pdf(). Raise for large/slow (e.g. S3-heavy) pages. */
  timeout?: number;
  /** Default true. Automatically waits for every <img> to load/error (each with its own
   *  failsafe) plus document.fonts.ready, after setContent resolves. Set false to skip. */
  waitForImages?: boolean;
  /** Max ms to wait for any single image before moving on (default 90000). */
  imageTimeout?: number;
  /** Extra ms to wait after images/fonts settle, for last-moment reflow (default 0). */
  settleDelay?: number;
  /** Off by default. `true` = 'standard' preset (recommended, no visible quality loss).
   *  Requires Ghostscript installed. */
  compress?: boolean | CompressQuality | CompressOptions;
  /** Auto-enabled when estimated embedded-image weight exceeds ~5MB AND "sharp" is
   *  installed (gracefully skipped otherwise — never breaks existing installs).
   *  Resizes/recompresses embedded base64 images BEFORE Chromium renders them —
   *  usually eliminates the need for `compress` entirely. Pass `false` to force off,
   *  `true` to force on (throws if sharp isn't installed), or an object for control. */
  optimizeImages?: boolean | {
    maxWidthPx?: number;
    quality?: number;
    /** Optional byte ceiling per optimized image; lowers quality/resolution as needed. */
    maxOutputBytes?: number;
    /** Default true. Retains natural image layout dimensions after resizing. */
    preserveDimensions?: boolean;
    /** Print per-image and total before/after byte sizes during optimization. Default false. */
    log?: boolean;
    /** Download http(s) <img> sources (including public or presigned S3 URLs) before optimizing. Default false. */
    remote?: boolean;
    /** Maximum remote images downloaded per PDF. Default 100. */
    maxRemoteImages?: number;
    /** Maximum bytes accepted from one remote image. Default 100 KB. Remote sources are only read, never modified. */
    maxRemoteImageBytes?: number;
  };
  /** Write directly to this file path instead of returning base64. REQUIRED for large
   *  PDFs (roughly >300-400MB) — base64 can exceed Node's max string length outright. */
  outputPath?: string;
  launch?: LaunchOptions;
}

export function generatePdf(
  htmlTemplate: HtmlTemplate,
  data?: Record<string, any>,
  options?: GeneratePdfOptions
): Promise<string | { path: string; bytes: number }>;

export function closeBrowser(): Promise<void>;

export function compressPdf(
  pdfBuffer: Buffer,
  quality?: CompressQuality | CompressOptions
): Promise<Buffer>;

export function compressFile(
  inputPath: string,
  outputPath: string,
  quality?: CompressQuality | CompressOptions
): Promise<{ path: string; bytes: number }>;

/**
 * Register a custom Handlebars helper. Call once at startup, before any
 * generatePdf() call that uses the helper.
 *
 *   registerHelper('ifEquals', function (a, b, options) {
 *     return a === b ? options.fn(this) : options.inverse(this);
 *   });
 *
 * Loosely typed (no @types/handlebars dependency required) — `this` and
 * `options.fn`/`options.inverse` are available at runtime as usual for
 * Handlebars block helpers, just not statically typed here.
 */
export function registerHelper(name: string, fn: (...args: any[]) => any): void;

/**
 * Register a Handlebars partial (reusable sub-template), referenced via
 * {{> name}} in your .handlebars templates.
 */
export function registerPartial(name: string, partialTemplateStr: string): void;

/**
 * Access the shared Handlebars instance directly — for SafeString,
 * Utils, or anything else registerHelper/registerPartial don't cover.
 */
export function getHandlebarsInstance(): any;

export interface BatchMeta {
  pageOffset: number;
  totalPages: number;
  chunkIndex: number;
  totalChunks: number;
}

export interface GeneratePdfBatchedOptions {
  /** Explicit override. If omitted, computed dynamically from CPU cores and free memory. */
  concurrency?: number;
  /** Ceiling for the dynamic concurrency calc (default 8). */
  maxConcurrency?: number;
  /** Assumed memory cost per concurrent chunk in MB, used by the dynamic calc (default 300). */
  memPerChunkMb?: number;
  /** CPU cores left free for the OS/Node, used by the dynamic calc (default 1). */
  reserveCores?: number;
  /** Items per chunk; default splits evenly based on the resolved concurrency. */
  chunkSize?: number;
  outputPath?: string;
  generateOptions?: GeneratePdfOptions;
  /**
   * Defaults to automatic physical-page numbering when generateOptions has a
   * headerTemplate or footerTemplate. Set false to retain legacy per-chunk
   * numbering.
   */
  physicalPageNumbers?: boolean;
  /** Data supplied when rendering the final header/footer pagination stamp. */
  paginationData?: Record<string, any>;
}

/**
 * Render a large item-based document as multiple smaller PDFs in
 * parallel (dynamic concurrency based on CPU/memory by default), then
 * merge with qpdf. Requires qpdf installed on the system. See README
 * for the page-numbering caveat (one item must render as exactly one page).
 */
export function generatePdfBatched(
  items: any[],
  renderChunk: (chunkItems: any[], meta: BatchMeta) => HtmlTemplate,
  options?: GeneratePdfBatchedOptions
): Promise<Buffer | { path: string; bytes: number; concurrencyUsed: number }>;

export interface GenerateChunkedPdfConfig extends GeneratePdfBatchedOptions {
  template: HtmlTemplate;
  data: Record<string, any>;
  /** Array field name/path, or array field names/paths to split into chunks.
   *  Nested fields use dot paths (e.g. `chapter17Photo.Hull`). Fields are
   *  equal-length fields stay synchronized; fields with different lengths
   *  are rendered as consecutive sections in the supplied key order. */
  chunkKey: string | string[];
  /** Extra fields merged into every chunk's data, computed once. */
  extraChunkData?: Record<string, any>;
}

/**
 * Lowest-code chunked PDF generation: pass a template, your full data,
 * and which array field(s) to split — chunk-data construction
 * (isFirstChunk/isLastChunk/pageOffset/totalPages, array slicing) is
 * handled automatically. See README "Multiple arrays" section for the
 * single-key vs multi-key usage.
 */
export function generateChunkedPdf(
  config: GenerateChunkedPdfConfig
): Promise<Buffer | { path: string; bytes: number; concurrencyUsed: number }>;
