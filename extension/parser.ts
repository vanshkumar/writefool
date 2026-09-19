import { stableId } from '../shared/clippings';
import type { NormalizedBook, NormalizedHighlight } from '../shared/contracts';

export class KindleParseError extends Error {
  constructor(message: string, public kind: 'login_required' | 'error' = 'error') { super(message); }
}

const text = (element: Element | null) => {
  if (!element) return '';
  const copy = element.cloneNode(true) as Element;
  copy.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  return copy.textContent?.trim() ?? '';
};
const value = (root: { querySelector(selector: string): { getAttribute(name: string): string | null } | null }, selector: string) => root.querySelector(selector)?.getAttribute('value')?.trim() ?? '';
const lastPaginationValue = (document: Document, selector: string): string | null => {
  const element = [...document.querySelectorAll(selector)].at(-1);
  if (!element) return null;
  const input = element.tagName === 'INPUT' ? element as HTMLInputElement : element.querySelector<HTMLInputElement>('input');
  // Live notebook updates may change the input property without updating its HTML attribute.
  // An empty final token is authoritative: never fall back to an older nonempty token.
  return (input?.value ?? element.getAttribute('value'))?.trim() ?? null;
};

function isPaginationOnly(document: Document, selector: string): boolean {
  if (lastPaginationValue(document, selector) === null) return false;
  const remainder = document.body.cloneNode(true) as HTMLElement;
  if ([...remainder.querySelectorAll(selector)].some((element) => text(element))) return false;
  remainder.querySelectorAll(selector).forEach((element) => element.remove());
  // A cursor-only fragment is an empty page, but a blank response or changed book
  // layout must still fail. Ignore empty layout wrappers, never content-bearing nodes.
  return !text(remainder) && !remainder.querySelector('h1,h2,h3,h4,h5,h6,[data-asin],.kp-notebook-library-each-book,a,img,form,button,script,iframe');
}

export function assertNotebook(document: Document, url = 'https://read.amazon.com/notebook'): void {
  const parsed = new URL(url);
  if (parsed.origin !== 'https://read.amazon.com' || /\/ap\/(?:signin|cvf)|signin/i.test(parsed.pathname) || document.querySelector('#ap_email, #ap_password, form[name="signIn"]')) {
    throw new KindleParseError('Sign in to the US Kindle notebook in Chrome, then sync again.', 'login_required');
  }
  if (document.querySelector('#captchacharacters, form[action*="validateCaptcha"]')) {
    throw new KindleParseError('Amazon needs your attention. Open your Kindle notebook, complete its check, and sync again.', 'login_required');
  }
}

export function parseLibrary(document: Document, options: { pagination?: boolean } = {}): { books: NormalizedBook[]; nextToken: string | null } {
  assertNotebook(document);
  const elements = [...document.querySelectorAll('.kp-notebook-library-each-book, #kp-notebook-library [data-asin], #kp-notebook-library [id]')].filter((element) => {
    if (element.matches('.kp-notebook-library-each-book')) return true;
    // Only accept positively identified Kindle cards. Layout wrappers and unrelated headings
    // must not make an unrecognized notebook look like a successful empty/partial import.
    const sourceId = element.getAttribute('data-asin') || element.id;
    return /^[a-zA-Z0-9]{10}$/.test(sourceId) && Boolean(text(element.querySelector('h2')));
  });
  const explicitlyEmpty = document.querySelector('#kp-notebook-library-empty, .kp-notebook-library-empty') || /\bno (?:books|notes|highlights)\b/i.test(text(document.querySelector('#kp-notebook-library')));
  const emptyPage = options.pagination && isPaginationOnly(document, '.kp-notebook-library-next-page-start');
  if (!elements.length && !explicitlyEmpty && !emptyPage) {
    throw new KindleParseError('The Kindle library layout was not recognized. Saved highlights are safe; try file import while the parser is updated.');
  }
  const books = new Map<string, NormalizedBook>();
  for (const element of elements) {
    const sourceId = element.getAttribute('data-asin') || element.id;
    const title = text(element.querySelector('h2.kp-notebook-searchable, h2'));
    const author = text(element.querySelector('p.kp-notebook-searchable, p')).replace(/^(?:By|Author)\s*:?\s*/i, '');
    if (!/^[a-zA-Z0-9_-]{5,100}$/.test(sourceId) || !title) throw new KindleParseError('A Kindle book had no recognizable identifier or title.');
    books.set(sourceId, { sourceId, title, author, highlights: [] });
  }
  return { books: [...books.values()], nextToken: lastPaginationValue(document, '.kp-notebook-library-next-page-start') || null };
}

export interface AnnotationPage { highlights: NormalizedHighlight[]; nextToken: string | null; contentLimitState: string; warnings: string[] }

export function parseAnnotations(document: Document, bookId: string): AnnotationPage {
  assertNotebook(document);
  const nodes = [...document.querySelectorAll('#highlight, .kp-notebook-highlight')];
  const highlights = new Map<string, NormalizedHighlight>();
  const warnings: string[] = [];
  for (const node of nodes) {
    const original = text(node);
    if (!original) continue;
    const row = node.closest('[data-annotation-id], .a-row.a-spacing-base') ?? node.closest('.kp-notebook-row-separator') ?? node.parentElement;
    if (!row) throw new KindleParseError('A Kindle highlight had no annotation container.');
    const location = value(row, '#kp-annotation-location, input[name="location"]') || text(row.querySelector('#annotationHighlightHeader')).match(/(?:Location|Page)\s*:?\s*([\d,-]+)/i)?.[1] || null;
    const explicitId = row.getAttribute('data-annotation-id') || value(row, 'input[name="annotationId"], .kp-notebook-annotation-id') || (row.id && !row.id.startsWith('kp-notebook-') ? row.id : '');
    const sourceId = explicitId || `fallback:${stableId(JSON.stringify([bookId, location, original]))}`;
    // The class can identify the outer wrapper containing the "Note:" UI label.
    // A combined selector returns that ancestor first; prefer the actual note field.
    const note = row.querySelector('#note') ?? row.querySelector('.kp-notebook-note');
    highlights.set(sourceId, { sourceId, text: original, note: text(note) || null, location, highlightedAt: value(row, 'input[name="createdAt"]') || null });
  }
  const root = document.querySelector('#kp-notebook-annotations, #kp-notebook-annotations-container, #kp-notebook-highlights');
  const empty = document.querySelector('.kp-notebook-empty, #kp-notebook-empty') || /\bno (?:notes|highlights|annotations)\b/i.test(text(root));
  const noteOnly = root?.querySelector('#note, .kp-notebook-note');
  if (!nodes.length && !empty && !noteOnly) {
    throw new KindleParseError('The Kindle annotation layout was not recognized. No saved highlights were removed.');
  }
  if (!nodes.length && noteOnly) warnings.push('This page has notes without highlighted passages; standalone notes were skipped.');
  const notices = document.body.cloneNode(true) as HTMLElement;
  notices.querySelectorAll('#highlight, .kp-notebook-highlight, #note, .kp-notebook-note, script, style, template, [hidden], [aria-hidden="true"]').forEach((element) => element.remove());
  notices.querySelectorAll<HTMLElement>('[style]').forEach((element) => { if (element.style.display === 'none' || element.style.visibility === 'hidden') element.remove(); });
  const body = notices.textContent ?? '';
  if (/export limit|clipping limit|highlighting limit|limit.*publisher/i.test(body)) warnings.push('Amazon reports an export limit; some highlights may be unavailable.');
  return { highlights: [...highlights.values()], nextToken: lastPaginationValue(document, '.kp-notebook-annotations-next-page-start') || null, contentLimitState: lastPaginationValue(document, '.kp-notebook-content-limit-state') ?? '', warnings };
}

export function notebookUrl(kind: 'library' | 'annotations', token = '', asin = '', contentLimitState = ''): string {
  const url = new URL('https://read.amazon.com/notebook');
  if (kind === 'library' && token) { url.searchParams.set('library', 'list'); url.searchParams.set('token', token); }
  if (kind === 'annotations') {
    if (!/^[a-zA-Z0-9_-]{5,100}$/.test(asin)) throw new KindleParseError('Invalid Kindle book identifier.');
    url.searchParams.set('asin', asin);
    url.searchParams.set('token', token);
    url.searchParams.set('contentLimitState', contentLimitState);
  }
  return url.href;
}
