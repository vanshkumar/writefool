import { readFile } from 'node:fs/promises';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ImportBatch } from '../shared/contracts';
import { parseClippings } from '../shared/clippings';
import { importBatch, previewClippings } from '../worker/import';

let mf: Miniflare;
let env: Pick<Env, 'DB'>;
beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'import-test', modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-09-07', d1Databases: { DB: 'import-tests' } }));
  env = { DB: await mf.getD1Database('DB') };
  for (const filename of ['0001_initial.sql', '0002_import_payload.sql', '0003_kindle_account_lock.sql']) {
    const migration = await readFile(`migrations/${filename}`, 'utf8');
    for (const statement of migration.split(';').map((value) => value.trim()).filter(Boolean)) await env.DB.prepare(statement).run();
  }
});
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM user').run();
  await env.DB.prepare("INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('u','Reader','reader@example.com',1,0,0),('v','Other','other@example.com',1,0,0)").run();
  await env.DB.prepare("INSERT INTO kindle_accounts(user_id,salt,fingerprint) VALUES('u','test-salt',?),('v','other-salt',?)").bind('a'.repeat(64),'b'.repeat(64)).run();
});

const batch = (batchId = 'first', sourceId = 'B000000001'): ImportBatch => ({ batchId, runId: 'run-1', source: 'kindle', accountFingerprint: 'a'.repeat(64), books: [{ sourceId, title: 'A Book', author: 'A Writer', highlights: [{ sourceId: 'annotation-one', text: 'An original passage.', note: 'A thought.', location: '10-12', highlightedAt: null }] }] });
const clippings = 'A Book (A Writer)\n- Your Highlight at Location 10-12 | Added on Monday, September 7, 2026\n\nAn original passage.\n==========\n';
const count = (table: string) => env.DB.prepare(`SELECT count(*) AS count FROM ${table}`).first<number>('count');

describe('atomic imports against D1', () => {
  it('rejects unbound, missing, and foreign fingerprints before any import or replay', async () => {
    await importBatch(env, 'u', batch());
    for (const fingerprint of [undefined, 'b'.repeat(64)]) {
      const changed = batch('foreign-note');
      changed.accountFingerprint = fingerprint;
      changed.books[0].highlights[0].note = 'Wrong account note';
      await expect(importBatch(env, 'u', changed)).rejects.toMatchObject({ status: 409 });
      await expect(importBatch(env, 'u', { ...batch(), accountFingerprint: fingerprint })).rejects.toMatchObject({ status: 409 });
      await expect(importBatch(env, 'u', { ...changed, books: [], complete: true })).rejects.toMatchObject({ status: 409 });
    }
    expect(await count('import_batches')).toBe(1);
    expect(await env.DB.prepare('SELECT note FROM highlights').first('note')).toBe('A thought.');
    await env.DB.prepare("UPDATE kindle_accounts SET fingerprint=NULL WHERE user_id='u'").run();
    await expect(importBatch(env, 'u', batch())).rejects.toMatchObject({ status: 409 });
    expect(await count('highlights')).toBe(1);
  });
  it('replays an immutable result and never reapplies an old batch over newer notes', async () => {
    const original = batch();
    const first = await importBatch(env, 'u', original);
    expect(first).toMatchObject({ imported: 1, updated: 0, skipped: 0, books: 1 });
    const updated = batch('second');
    updated.books[0].highlights[0].note = 'A changed thought.';
    expect((await importBatch(env, 'u', updated)).updated).toBe(1);
    expect(await importBatch(env, 'u', original)).toEqual(first);
    expect(await env.DB.prepare('SELECT note FROM highlights').first('note')).toBe('A changed thought.');
    expect(await count('highlights')).toBe(1);
    expect(await count('import_batches')).toBe(2);
  });
  it('commits concurrent copies of one batch exactly once', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => importBatch(env, 'u', batch())));
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true);
    expect(await count('books')).toBe(1);
    expect(await count('highlights')).toBe(1);
    expect(await count('import_batches')).toBe(1);
  });
  it('counts concurrent distinct batch IDs against the committed rows', async () => {
    const results = await Promise.all(Array.from({ length: 3 }, (_, index) => importBatch(env, 'u', batch(`batch-${index}`))));
    expect(results.reduce((sum, result) => sum + result.imported, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.skipped, 0)).toBe(2);
    expect(await count('highlights')).toBe(1);
    expect(await count('highlight_sources')).toBe(1);
  });
  it('rolls back every write if a concurrent import wins a conflicting source mapping', async () => {
    const winner = batch('winner'); winner.books[0].highlights[0].text = 'A winning concurrent passage.';
    let injected = false;
    const racing = { DB: new Proxy(env.DB, { get(target, property) {
      if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (!injected) { injected = true; await importBatch(env, 'u', winner); }
        return target.batch(statements);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) };
    await expect(importBatch(racing, 'u', batch('loser'))).rejects.toMatchObject({ status: 409 });
    expect(await count('highlights')).toBe(1);
    expect(await count('import_batches')).toBe(1);
    expect(await env.DB.prepare('SELECT text FROM highlights').first('text')).toBe('A winning concurrent passage.');
    expect((await importBatch(env, 'u', batch('loser'))).updated).toBe(1);
    expect(await count('highlights')).toBe(1);
  });
  it('rejects a reused batch ID with changed content and leaves its result untouched', async () => {
    await importBatch(env, 'u', batch());
    const changed = batch();
    changed.books[0].highlights[0].text = 'Different content.';
    await expect(importBatch(env, 'u', changed)).rejects.toMatchObject({ status: 409 });
    expect(await env.DB.prepare('SELECT text FROM highlights').first('text')).toBe('An original passage.');
    expect(await count('import_batches')).toBe(1);
  });
  it('updates source annotations without resetting exclusion, hidden state or delivery history', async () => {
    await importBatch(env, 'u', batch());
    await env.DB.prepare("UPDATE highlights SET hidden=1,last_sent_at='2026-09-01T08:00:00.000Z'").run();
    await env.DB.prepare('UPDATE books SET excluded=1').run();
    const changed = batch('new-note');
    changed.books[0].highlights[0] = { sourceId: 'annotation-one', text: 'A corrected passage.', note: null, location: '12-14' };
    expect((await importBatch(env, 'u', changed)).updated).toBe(1);
    expect(await env.DB.prepare('SELECT text,note,location,hidden,last_sent_at FROM highlights').first()).toEqual({ text: 'A corrected passage.', note: null, location: '12-14', hidden: 1, last_sent_at: '2026-09-01T08:00:00.000Z' });
    expect(await env.DB.prepare('SELECT excluded FROM books').first('excluded')).toBe(1);
    expect(await count('highlights')).toBe(1);
  });
  it('merges unique cross-source book and passage matches but preserves different locations', async () => {
    await importBatch(env, 'u', batch());
    const imported = parseClippings(clippings);
    imported.books[0].highlights.push({ sourceId: 'another-location', text: 'An original passage.', location: '90-92' });
    const preview = await previewClippings(env, 'u', clippings);
    expect(preview.matches[0].candidates).toHaveLength(1);
    expect(await importBatch(env, 'u', { batchId: 'file', runId: 'file', source: 'clippings', books: imported.books })).toMatchObject({ imported: 1, updated: 1 });
    expect(await count('books')).toBe(1);
    expect(await count('book_sources')).toBe(2);
    expect(await count('highlights')).toBe(2);
    expect(await count('highlight_sources')).toBe(3);
  });
  it('requires a choice for ambiguous book matches and supports explicit new books', async () => {
    await importBatch(env, 'u', batch('first', 'B000000001'));
    await importBatch(env, 'u', batch('second', 'B000000002'));
    const preview = await previewClippings(env, 'u', clippings);
    expect(preview.matches[0].candidates).toHaveLength(2);
    const file: ImportBatch = { batchId: 'file', runId: 'file', source: 'clippings', books: preview.books };
    await expect(importBatch(env, 'u', file)).rejects.toMatchObject({ status: 409 });
    expect(await count('import_batches')).toBe(2);
    file.books[0].targetBookId = 'new';
    await importBatch(env, 'u', file);
    expect(await count('books')).toBe(3);
    const rePreview = await previewClippings(env, 'u', clippings);
    expect(rePreview.matches[0].candidates).toHaveLength(1);
  });
  it('continues an explicitly new clipping book across pages without permitting a matched-source remap', async () => {
    await importBatch(env, 'u', batch());
    const first: ImportBatch = { batchId: 'file-page-1', runId: 'file-run', source: 'clippings', books: parseClippings(clippings).books };
    first.books[0].targetBookId = 'new';
    await importBatch(env, 'u', first);
    const second = structuredClone(first); second.batchId = 'file-page-2';
    second.books[0].highlights = [{ sourceId: 'second-page-highlight', text: 'Another clipping.', location: '200' }];
    expect((await importBatch(env, 'u', second)).imported).toBe(1);
    expect(await count('books')).toBe(2);
    expect(await count('highlights')).toBe(3);
    const canonical = await env.DB.prepare("SELECT id FROM books WHERE source='kindle'").first<string>('id');
    const matched: ImportBatch = { batchId: 'matched-file', runId: 'matched-run', source: 'clippings', books: [{ sourceId: 'another-clipping-source', title: 'A Book', author: 'A Writer', targetBookId: canonical!, highlights: [] }] };
    await importBatch(env, 'u', matched);
    matched.batchId = 'attempted-remap'; matched.books[0].targetBookId = 'new';
    await expect(importBatch(env, 'u', matched)).rejects.toMatchObject({ status: 409 });
    expect(await count('books')).toBe(2);
  });
  it('keeps accounts isolated and rejects foreign targets and existing source remaps', async () => {
    await importBatch(env, 'u', batch());
    await importBatch(env, 'v', { ...batch(), accountFingerprint: 'b'.repeat(64) });
    expect(await count('books')).toBe(2);
    expect(await count('highlights')).toBe(2);
    const foreignId = await env.DB.prepare("SELECT id FROM books WHERE user_id='v'").first<string>('id');
    const foreign = { ...batch('foreign'), source: 'clippings' as const };
    foreign.books[0].targetBookId = foreignId!;
    await expect(importBatch(env, 'u', foreign)).rejects.toMatchObject({ status: 404 });
    const remap = batch('remap');
    remap.books[0].targetBookId = 'new';
    await expect(importBatch(env, 'u', remap)).rejects.toMatchObject({ status: 409 });
    expect(await count('books')).toBe(2);
    expect((await previewClippings(env, 'u', clippings)).matches[0].candidates).toHaveLength(1);
  });
  it('retains missing highlights across partial imports and accepts an empty completion batch', async () => {
    const first = batch();
    first.books.push({ sourceId: 'B000000002', title: 'An empty book', author: 'Writer', highlights: [] });
    await importBatch(env, 'u', first);
    const partial = batch('partial'); partial.books[0].highlights = [];
    await importBatch(env, 'u', partial);
    expect(await importBatch(env, 'u', { batchId: 'done', runId: 'run-1', source: 'kindle', accountFingerprint: 'a'.repeat(64), books: [], complete: true })).toMatchObject({ imported: 0, books: 0 });
    expect(await count('books')).toBe(2);
    expect(await count('highlights')).toBe(1);
  });
  it('chunks a full annotation page without exceeding SQLite bind limits', async () => {
    const full = batch();
    full.books[0].highlights = Array.from({ length: 200 }, (_, index) => ({ sourceId: `annotation-${index}`, text: `Passage ${index}.`, location: String(index) }));
    expect((await importBatch(env, 'u', full)).imported).toBe(200);
    expect(await count('highlights')).toBe(200);
    expect(await count('highlight_sources')).toBe(200);
  });
  it('keeps mixed import counter reads bounded in an 805-highlight library', async () => {
    const initial = batch('seed');
    initial.books[0].highlights = Array.from({ length: 50 }, (_, index) => ({
      sourceId: `annotation-${index}`, text: `Passage ${index}.`, location: String(index),
      note: null, highlightedAt: '2026-09-01T00:00:00.000Z',
    }));
    await importBatch(env, 'u', initial);
    const bookId = await env.DB.prepare("SELECT id FROM books WHERE user_id='u'").first<string>('id');
    await env.DB.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<755)
      INSERT INTO highlights(id,user_id,book_id,text,imported_at,fingerprint)
      SELECT 'unrelated-'||i,'u',?,'Unrelated passage '||i,'2026-09-01','unrelated-'||i FROM n`).bind(bookId).run();
    expect(await count('highlights')).toBe(805);

    const mixed = batch('mixed');
    mixed.books[0].highlights = Array.from({ length: 50 }, (_, index) => ({
      sourceId: `annotation-${index < 25 ? index : index + 25}`,
      text: `Passage ${index < 25 ? index : index + 25}.`,
      location: String(index < 25 ? index : index + 25),
      note: index === 0 ? 'Changed note' : null,
      // Omitting the date must preserve the existing highlighted_at and count as unchanged.
    }));
    let transactionReads = 0;
    const measured = { DB: new Proxy(env.DB, { get(target, property) {
      if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
        const results = await target.batch(statements);
        transactionReads += results.reduce((sum, result) => sum + result.meta.rows_read, 0);
        return results;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) };
    const result = await importBatch(measured, 'u', mixed);
    expect(result).toMatchObject({ imported: 25, updated: 1, skipped: 24 });
    expect(await count('highlights')).toBe(830);
    expect(await importBatch(measured, 'u', mixed)).toEqual(result);
    // Include all transaction statements, not just the counters; the old join order reads >80k.
    expect(transactionReads).toBeLessThan(2000);
  });
});
