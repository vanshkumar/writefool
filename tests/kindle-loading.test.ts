// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readNotebookPage, waitForLibrary } from '../extension/notebook';

const url = 'https://read.amazon.com/notebook';
const html = (value: string) => new DOMParser().parseFromString(value, 'text/html');
const library = readFileSync('tests/fixtures/kindle-library.html', 'utf8');
const annotations = readFileSync('tests/fixtures/kindle-annotations.html', 'utf8');
const response = (body: string, responseUrl = url) => {
  const result = new Response(body);
  Object.defineProperty(result, 'url', { value: responseUrl });
  return result;
};

afterEach(() => vi.useRealTimers());

describe('Kindle notebook loading', () => {
  it('waits for the initial library to render and does not refetch the unrendered shell', async () => {
    vi.useFakeTimers();
    const page = html('<div id="kp-notebook-library"></div>');
    const fetchPage = vi.fn<typeof fetch>();
    const pending = readNotebookPage(page, url, { kind: 'library', token: '' }, fetchPage);
    await vi.advanceTimersByTimeAsync(1000);
    page.body.innerHTML = library;
    await vi.advanceTimersByTimeAsync(250);
    expect((await pending)).toMatchObject({ books: [{ sourceId: 'B000000001' }, { sourceId: 'B000000002' }], nextToken: 'library-page-2&next=yes' });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('fails boundedly on a shell and exposes only structural diagnostics', async () => {
    vi.useFakeTimers();
    const page = html('<div id="kp-notebook-library"><p>Private title and passage</p></div>');
    const pending = waitForLibrary(page, url, 1000);
    const failure = expect(pending).rejects.toMatchObject({ kind: 'error', message: expect.stringContaining('library=1, cards=0,') });
    await vi.advanceTimersByTimeAsync(1000);
    await failure;
    await expect(pending).rejects.not.toThrow('Private');
  });

  it('accepts an explicit empty library immediately', async () => {
    expect(await waitForLibrary(html('<div id="kp-notebook-library-empty">No books</div>'), url, 0)).toEqual({ books: [], nextToken: null });
  });

  it('stops for a login challenge that appears while waiting', async () => {
    vi.useFakeTimers();
    const page = html('<div id="kp-notebook-library"></div>');
    const pending = waitForLibrary(page, url);
    const failure = expect(pending).rejects.toMatchObject({ kind: 'login_required' });
    page.body.innerHTML = '<input id="captchacharacters">';
    await vi.advanceTimersByTimeAsync(250);
    await failure;
  });

  it('fetches subsequent library fragments with the saved pagination token', async () => {
    const fetchPage = vi.fn<typeof fetch>().mockResolvedValue(response(library));
    const result = await readNotebookPage(html(''), url, { kind: 'library', token: 'next&value' }, fetchPage);
    expect(result).toMatchObject({ books: expect.any(Array) });
    const [requestedUrl, options] = fetchPage.mock.calls[0];
    expect(new URL(String(requestedUrl)).searchParams.get('library')).toBe('list');
    expect(new URL(String(requestedUrl)).searchParams.get('token')).toBe('next&value');
    expect(options?.credentials).toBe('same-origin');
  });

  it('accepts a cursor-only end page and preserves a nonempty continuation when one is supplied', async () => {
    const terminal = readFileSync('tests/fixtures/kindle-library-end.html', 'utf8');
    const fetchPage = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(terminal.replace('value=""', 'value="last-page"')))
      .mockResolvedValueOnce(response(terminal));
    const page = await readNotebookPage(html(''), url, { kind: 'library', token: 'saved-page-2' }, fetchPage);
    expect(page).toEqual({ books: [], nextToken: 'last-page' });
    expect(await readNotebookPage(html(''), url, { kind: 'library', token: 'last-page' }, fetchPage)).toEqual({ books: [], nextToken: null });
  });

  it('continues to fetch annotation fragments and preserve notes', async () => {
    const fetchPage = vi.fn<typeof fetch>().mockResolvedValue(response(annotations));
    const result = await readNotebookPage(html(''), url, { kind: 'annotations', asin: 'B000000001' }, fetchPage);
    expect(result).toMatchObject({ highlights: [expect.objectContaining({ sourceId: 'annotation-one', note: 'A note for later.\nRemember this.' }), expect.objectContaining({ sourceId: 'annotation-two' })] });
    expect(new URL(String(fetchPage.mock.calls[0][0])).searchParams.get('asin')).toBe('B000000001');
  });

  it('detects sign-in responses from pagination without treating them as an empty library', async () => {
    const fetchPage = vi.fn<typeof fetch>().mockResolvedValue(response('<form name="signIn"></form>', 'https://www.amazon.com/ap/signin'));
    await expect(readNotebookPage(html(''), url, { kind: 'library', token: 'next' }, fetchPage)).rejects.toMatchObject({ kind: 'login_required' });
  });

  it('distinguishes an unrecognized pagination response from the initial library without disclosing its content', async () => {
    const reply = response('<div data-asin="PRIVATE_ASIN"><h2>Private book title</h2></div><input class="kp-notebook-library-next-page-start" value="private-cursor">');
    reply.headers.set('content-type', 'text/html; charset=utf-8');
    const fetchPage = vi.fn<typeof fetch>().mockResolvedValue(reply);
    const pending = readNotebookPage(html(''), url, { kind: 'library', token: 'secret-request-token' }, fetchPage);
    await expect(pending).rejects.toMatchObject({ message: expect.stringContaining('next library page was not recognized. (HTTP 200; format=HTML; library=0, cards=0, asin-elements=1, headings=1, cursors=1,') });
    await expect(pending).rejects.not.toThrow(/Private|private|secret|PRIVATE/);
  });
});
