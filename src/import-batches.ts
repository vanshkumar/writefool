import type { ClippingsPreview, ImportBatch } from '../shared/contracts';

/** Freeze one import run so a retry reuses the exact payload and idempotency key. */
export function prepareClippingsBatches(preview: ClippingsPreview, choices: Record<string, string>, runId: string): ImportBatch[] {
  const batches: ImportBatch[] = [];
  const encoder = new TextEncoder();
  for (const book of preview.books) {
    if (!choices[book.sourceId]) throw new Error(`Choose where to import ${book.title}.`);
    let page: typeof book.highlights = [];
    const makeBatch = (highlights: typeof book.highlights): ImportBatch => ({
      batchId: `${runId}:${batches.length}`,
      runId,
      source: 'clippings',
      books: [{ ...book, targetBookId: choices[book.sourceId], highlights }],
      ...(batches.length === 0 ? { warnings: preview.warnings.slice(0, 100) } : {}),
    });
    for (const highlight of book.highlights) {
      const proposed = [...page, highlight];
      if (page.length && (proposed.length > 100 || encoder.encode(JSON.stringify(makeBatch(proposed))).byteLength > 3 * 1024 * 1024)) {
        batches.push(makeBatch(page));
        page = [];
      }
      page.push(highlight);
    }
    if (page.length) batches.push(makeBatch(page));
  }
  if (batches.length) batches[batches.length - 1].complete = true;
  return batches;
}
