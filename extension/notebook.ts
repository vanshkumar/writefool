import { assertNotebook, KindleParseError, notebookUrl, parseAnnotations, parseLibrary } from './parser';

export interface NotebookRequest {
  kind: 'library' | 'annotations';
  token?: string;
  asin?: string;
  contentLimitState?: string;
}

function structure(document: Document): string {
  // Fixed labels and counts only: no HTML, URLs, tokens, or library text.
  const marker = [...document.querySelectorAll('.kp-notebook-library-next-page-start')].at(-1);
  const input = marker?.tagName === 'INPUT' ? marker as HTMLInputElement : marker?.querySelector<HTMLInputElement>('input');
  const token = input?.value ?? marker?.getAttribute('value');
  const cursorState = token == null ? 'missing' : token.trim() ? 'nonempty' : 'empty';
  return `library=${Number(Boolean(document.querySelector('#kp-notebook-library')))}, cards=${document.querySelectorAll('.kp-notebook-library-each-book').length}, asin-elements=${document.querySelectorAll('[data-asin]').length}, headings=${document.querySelectorAll('h2').length}, cursors=${document.querySelectorAll('.kp-notebook-library-next-page-start').length}, highlights=${document.querySelectorAll('#highlight, .kp-notebook-highlight').length}, spinner=${Number(Boolean(document.querySelector('#kp-notebook-library-spinner')))}, cursor=${cursorState}, body-text=${Number(Boolean(document.body.textContent?.trim()))}, page=${document.readyState}`;
}

export async function waitForLibrary(document: Document, url: string, timeoutMs = 25000): Promise<ReturnType<typeof parseLibrary>> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    // Amazon populates the initial library with JavaScript after the notebook loads.
    // Parsing a fresh HTML fetch never runs those scripts; use the owned tab's DOM.
    assertNotebook(document, document.defaultView?.location.href ?? url);
    try {
      return parseLibrary(document);
    } catch (error) {
      if (!(error instanceof KindleParseError) || error.kind === 'login_required') throw error;
      if (Date.now() >= deadline) {
        // Report structure only. Never include page HTML, titles, passages, or tokens.
        throw new KindleParseError(`The initial Kindle book list did not become readable after waiting. (${structure(document)}.)`);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
    }
  }
}

export async function readNotebookPage(document: Document, url: string, request: NotebookRequest, fetchPage: typeof fetch = fetch) {
  assertNotebook(document, url);
  if (request.kind === 'library' && !request.token) return waitForLibrary(document, url);

  const response = await fetchPage(notebookUrl(request.kind, request.token, request.asin, request.contentLimitState), { credentials: 'same-origin', signal: AbortSignal.timeout(18000) });
  if (response.status === 401 || response.status === 403 || (response.redirected && new URL(response.url).origin !== new URL(url).origin)) {
    throw new KindleParseError('Sign in to your Kindle notebook in Chrome, then sync again.', 'login_required');
  }
  if (!response.ok) throw new KindleParseError(`Amazon returned ${response.status}. Sync will resume from its last saved page.`);
  const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
  assertNotebook(parsed, response.url);
  try {
    return request.kind === 'library' ? parseLibrary(parsed, { pagination: true }) : parseAnnotations(parsed, request.asin!);
  } catch (error) {
    if (!(error instanceof KindleParseError) || error.kind === 'login_required') throw error;
    const responseType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const format = responseType === 'text/html' ? 'HTML' : responseType === 'application/json' ? 'JSON' : 'other';
    throw new KindleParseError(`The Kindle ${request.kind === 'library' ? 'next library page' : 'highlights page'} was not recognized. (HTTP ${response.status}; format=${format}; ${structure(parsed)}.)`);
  }
}
