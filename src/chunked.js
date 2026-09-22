/**
 * The lowest-code way to generate a large, item-based PDF in parallel
 * chunks. Compare to calling generatePdfBatched directly, where YOU
 * write the chunk-data construction (spreading ...data, overriding the
 * array field, computing isFirstChunk/isLastChunk/pageOffset yourself)
 * every time. This does all of that automatically — you just point it
 * at which array field(s) to split.
 *
 * @param {object} config
 * @param {string|function} config.template - Handlebars string, .handlebars/.hbs
 *   file path, or native JS function — same rules as generatePdf's htmlTemplate.
 * @param {object} config.data - your full data object (unsplit)
 * @param {string|string[]} config.chunkKey - the key (or array of keys) in
 *   `data` holding the array(s) to split into parallel chunks, e.g.
 *   'nonComplianceList' or 'chapter17Photo.Hull', or multiple array fields.
 *   Dot paths may address nested array fields. Equal-length fields are
 *   treated as PARALLEL arrays and are sliced at identical boundaries.
 *   Fields of different lengths are rendered as consecutive sections in the
 *   order supplied by `chunkKey`, so their pages cannot interleave.
 *   Any other array in `data` NOT listed here passes through whole/unsplit
 *   in every chunk automatically.
 *   Each item is assumed to render as one physical page (see
 *   generatePdfBatched's page-numbering caveat).
 * @param {object} [config.extraChunkData] - additional fields merged into
 *   every chunk's data, computed once (not per-chunk).
 * @param {...*} rest - everything else (outputPath, concurrency, compress,
 *   generateOptions, etc.) is passed straight through to generatePdfBatched.
 * @returns {Promise<string|{path: string, bytes: number, concurrencyUsed: number}>}
 */
function createGenerateChunkedPdf(generatePdfBatched) {
  return async function generateChunkedPdf({ template, data, chunkKey, extraChunkData, ...batchOptions }) {
    if (!template) throw new Error('generateChunkedPdf: `template` is required');
    if (!data) throw new Error('generateChunkedPdf: `data` is required');
    if (!chunkKey) throw new Error('generateChunkedPdf: `chunkKey` is required (array field name, or array of names, to split)');

    const chunkKeys = Array.isArray(chunkKey) ? chunkKey : [chunkKey];

    const readPath = (source, key) => key.split('.').reduce(
      (value, part) => (value == null ? undefined : value[part]),
      source
    );
    const writePath = (target, key, value) => {
      const parts = key.split('.');
      let cursor = target;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        // Clone each parent on the path so caller-owned data is never
        // mutated and multiple nested keys can coexist in one chunk.
        cursor[part] = { ...(cursor[part] || {}) };
        cursor = cursor[part];
      }
      cursor[parts[parts.length - 1]] = value;
    };

    const lengths = chunkKeys.map((k) => {
      const arr = readPath(data, k);
      if (!Array.isArray(arr)) {
        throw new Error(`generateChunkedPdf: data.${k} must be an array (got ${typeof arr})`);
      }
      return arr.length;
    });

    // Equal-length keys are parallel records: one position represents one
    // rendered item. Unequal keys are independent sections, so flatten them
    // in caller-supplied order. This is critical for templates that render
    // findings, compliance tables, and N/A tables in separate sections: a
    // common index window would put all three sections into every chunk and
    // interleave the final PDF after qpdf merges the parts.
    const areParallel = new Set(lengths).size === 1;
    const indexDriver = areParallel
      ? Array.from({ length: lengths[0] }, (_, index) => index)
      : chunkKeys.flatMap((key) =>
          readPath(data, key).map((_, index) => ({ key, index }))
        );
    const logicalTotalPages = indexDriver.length;

    return generatePdfBatched(
      indexDriver,
      (chunkIndices, meta) => {
        const chunkData = { ...data };
        if (areParallel) {
          const start = meta.pageOffset;
          const end = start + chunkIndices.length;
          for (const k of chunkKeys) {
            writePath(chunkData, k, readPath(data, k).slice(start, end));
          }
        } else {
          const itemsByKey = new Map(chunkKeys.map((key) => [key, []]));
          for (const { key, index } of chunkIndices) {
            itemsByKey.get(key).push(readPath(data, key)[index]);
          }
          for (const k of chunkKeys) {
            writePath(chunkData, k, itemsByKey.get(k));
          }
        }

        return {
          template,
          data: {
            ...chunkData,
            isFirstChunk: meta.chunkIndex === 0,
            isLastChunk: meta.chunkIndex === meta.totalChunks - 1,
            pageOffset: meta.pageOffset,
            totalPages: logicalTotalPages,
            ...extraChunkData,
          },
        };
      },
      {
        ...batchOptions,
        // The final pagination stamp needs the original document-level data
        // (not one arbitrary chunk's sliced data) to render its header/footer.
        // An explicit caller value still wins for deliberately custom data.
        paginationData: batchOptions.paginationData || { ...data, ...extraChunkData },
      }
    );
  };
}

module.exports = { createGenerateChunkedPdf };
