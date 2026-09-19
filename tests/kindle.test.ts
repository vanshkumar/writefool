// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertNotebook, notebookUrl, parseAnnotations, parseLibrary } from '../extension/parser';

const html = (value: string) => new DOMParser().parseFromString(value, 'text/html');
const library = readFileSync('tests/fixtures/kindle-library.html', 'utf8');
const annotations = readFileSync('tests/fixtures/kindle-annotations.html', 'utf8');
const libraryEnd = readFileSync('tests/fixtures/kindle-library-end.html', 'utf8');

describe('Kindle notebook parser (synthetic fixtures)', () => {
  it('enumerates books with source ASINs and the next library cursor', () => {
    const result = parseLibrary(html(library));
    expect(result.books).toHaveLength(2);
    expect(result.books[0]).toMatchObject({ sourceId: 'B000000001', title: 'A Room of One’s Own', author: 'Virginia Woolf' });
    expect(result.nextToken).toBe('library-page-2&next=yes');
  });
  it('recognizes validated library cards without the legacy class and deduplicates overlapping matches', () => {
    const result = parseLibrary(html(`<div id="kp-notebook-library"><div id="layout-wrapper">
      <div id="B000000003"><h2>A third book</h2><p>By: A Writer</p></div>
      <article id="card-wrapper" data-asin="B000000004"><h2>A fourth book</h2><p>Author: Another Writer</p></article>
      <div class="kp-notebook-library-each-book" id="B000000005" data-asin="B000000005"><h2>A fifth book</h2></div>
      <div id="B000000005"><h2>A fifth book</h2></div>
    </div></div>`));
    expect(result.books.map((book) => book.sourceId)).toEqual(['B000000003', 'B000000004', 'B000000005']);
    expect(result.books[1]).toMatchObject({ title: 'A fourth book', author: 'Another Writer' });
  });
  it('rejects missing identifiers, malformed fallback identifiers, and unrelated library wrappers', () => {
    for (const markup of [
      '<div><h2>A title without an ID</h2></div>',
      '<div id="invalid-id"><h2>An invalid card</h2></div>',
      '<div data-asin="../bad-id"><h2>An invalid card</h2></div>',
      '<div id="library-wrapper"><h2>A section heading</h2></div>',
      '<div id="B000000003"><p>A valid ID without a title</p></div>',
    ]) expect(() => parseLibrary(html(`<div id="kp-notebook-library">${markup}</div>`))).toThrow('layout');
  });
  it('uses the latest library token, including a final empty token and live input-property changes', () => {
    const document = html(library + '<input class="kp-notebook-library-next-page-start" value="latest-page">');
    expect(parseLibrary(document).nextToken).toBe('latest-page');
    const finalToken = [...document.querySelectorAll<HTMLInputElement>('.kp-notebook-library-next-page-start')].at(-1)!;
    finalToken.value = '';
    expect(parseLibrary(document).nextToken).toBeNull();
    expect(finalToken.getAttribute('value')).toBe('latest-page');
  });
  it('recognizes cursor-only library pages only when following pagination', () => {
    expect(() => parseLibrary(html(libraryEnd))).toThrow('layout');
    expect(parseLibrary(html(libraryEnd), { pagination: true })).toEqual({ books: [], nextToken: null });
    expect(parseLibrary(html(libraryEnd.replace('value=""', 'value="continue-page"')), { pagination: true })).toEqual({ books: [], nextToken: 'continue-page' });
    expect(parseLibrary(html('<div><span class="kp-notebook-library-next-page-start"><input value=""></span></div>'), { pagination: true })).toEqual({ books: [], nextToken: null });
  });
  it('does not mistake missing cursor values, blank responses, or changed layouts for the end of the library', () => {
    for (const markup of [
      '',
      '<div class="kp-notebook-library-next-page-start"></div>',
      '<div class="kp-notebook-library-next-page-start"><input value=""><article>Unexpected book content</article></div>',
      libraryEnd + '<div>A book in an unknown layout</div>',
      libraryEnd + '<article data-asin="B000000001"></article>',
      libraryEnd + '<a href="/notebook?asin=B000000001"><img src="cover.jpg"></a>',
      libraryEnd + '<h2></h2>',
    ]) expect(() => parseLibrary(html(markup), { pagination: true })).toThrow('layout');
    expect(() => parseLibrary(html(libraryEnd + '<form name="signIn"></form>'), { pagination: true })).toThrow('Sign in');
  });
  it('preserves original passage breaks, notes, locations, and annotation IDs', () => {
    const result = parseAnnotations(html(annotations), 'B000000001');
    expect(result.highlights).toHaveLength(2);
    expect(result.highlights[0]).toMatchObject({ sourceId: 'annotation-one', text: 'One cannot think well,\nlove well, sleep well, if one has not dined well.', note: 'A note for later.\nRemember this.', location: '10-12' });
    expect(result.highlights[1].sourceId).toBe('annotation-two');
    expect(result.nextToken).toBe('annotations-page-2');
    expect(result.contentLimitState).toBe('state&encoded');
  });
  it('has stable fallback identities across repeat imports and note changes', () => {
    const withoutIds = annotations.replace('id="annotation-one"', '').replace('data-annotation-id="annotation-two"', '');
    const first = parseAnnotations(html(withoutIds), 'B000000001');
    const second = parseAnnotations(html(withoutIds.replace('A note for later.', 'A changed note.')), 'B000000001');
    expect(second.highlights.map((item) => item.sourceId)).toEqual(first.highlights.map((item) => item.sourceId));
    expect(second.highlights[0].note).toContain('A changed note.');
  });
  it('prefers the note body over the labeled wrapper, preserving notes that themselves begin with Note:', () => {
    const wrapped = annotations.replace('<span id="note">A note for later.<br>Remember this.</span>', '<div class="kp-notebook-note"><span>Note:</span><span id="note">Note: keep this wording.<br>Second line.</span></div>')
      .replace('<span id="note"></span>', '<div class="kp-notebook-note"><span>Note:</span><span id="note"></span></div>');
    const result = parseAnnotations(html(wrapped), 'B000000001');
    expect(result.highlights[0].note).toBe('Note: keep this wording.\nSecond line.');
    expect(result.highlights[1].note).toBeNull();
    expect(parseAnnotations(html(annotations.replace('id="note"', 'class="kp-notebook-note"')), 'B000000001').highlights[0].note).toBe('A note for later.\nRemember this.');
  });
  it('recognizes sign-in and CAPTCHA pages without touching their forms', () => {
    expect(() => assertNotebook(html('<form name="signIn"><input id="ap_email"></form>'))).toThrow('Sign in');
    expect(() => assertNotebook(html('<input id="captchacharacters">'))).toThrow('Amazon needs your attention');
    expect(() => assertNotebook(html(''), 'https://www.amazon.com/ap/signin')).toThrow('Sign in');
  });
  it('distinguishes a truly empty notebook from unrecognized markup', () => {
    expect(parseLibrary(html('<div id="kp-notebook-library-empty">No books</div>')).books).toEqual([]);
    expect(() => parseLibrary(html('<div id="kp-notebook-library"><div class="new-layout">A book</div></div>'))).toThrow('layout');
    expect(() => parseAnnotations(html('<div id="kp-notebook-annotations"><div class="new-layout">A passage</div></div>'), 'B000000001')).toThrow('layout');
    expect(parseAnnotations(html('<div id="kp-notebook-empty">No highlights</div>'), 'B000000001').highlights).toEqual([]);
  });
  it('warns for export limits and treats blank pagination tokens as complete', () => {
    const result = parseAnnotations(html(annotations.replace('value="annotations-page-2"', 'value=""') + '<p>You reached the export limit.</p>'), 'B000000001');
    expect(result.nextToken).toBeNull();
    expect(result.warnings).toHaveLength(1);
  });
  it('does not mistake passage text, attached notes, or hidden templates for an Amazon export-limit notice', () => {
    const content = annotations.replace('A small synthetic passage.', 'A publisher can set an export limit.').replace('A note for later.', 'Remember the clipping limit.')
      + '<template>Export limit reached.</template><script>const message = "export limit";</script><p hidden>Export limit</p><p aria-hidden="true">Export limit</p><p style="display:none">Export limit</p>';
    expect(parseAnnotations(html(content), 'B000000001').warnings).toEqual([]);
    expect(parseAnnotations(html(content + '<p>You reached the export limit.</p>'), 'B000000001').warnings).toHaveLength(1);
  });
  it('uses final annotation pagination values without reviving stale tokens or limit state', () => {
    const document = html(annotations + '<div class="kp-notebook-annotations-next-page-start"><input value="next-page"></div><input class="kp-notebook-content-limit-state" value="latest-state">');
    expect(parseAnnotations(document, 'B000000001')).toMatchObject({ nextToken: 'next-page', contentLimitState: 'latest-state' });
    document.body.insertAdjacentHTML('beforeend', '<input class="kp-notebook-annotations-next-page-start" value=""><input class="kp-notebook-content-limit-state" value="">');
    expect(parseAnnotations(document, 'B000000001')).toMatchObject({ nextToken: null, contentLimitState: '' });
  });
  it('only builds same-origin notebook URLs and safely encodes pagination tokens', () => {
    const url = new URL(notebookUrl('annotations', 'a&b=#?', 'B000000001', 'state&value'));
    expect(url.origin).toBe('https://read.amazon.com');
    expect(url.searchParams.get('token')).toBe('a&b=#?');
    expect(url.searchParams.get('contentLimitState')).toBe('state&value');
    expect(() => notebookUrl('annotations', '', '../../evil')).toThrow('identifier');
    expect(new URL(notebookUrl('library', 'next')).searchParams.get('library')).toBe('list');
  });
});
