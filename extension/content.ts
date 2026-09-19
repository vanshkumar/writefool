import { KindleParseError } from './parser';
import { readNotebookPage } from './notebook';

chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
  if (sender.id !== chrome.runtime.id || location.origin !== 'https://read.amazon.com' || location.pathname !== '/notebook') return;
  if (!message || typeof message !== 'object') return;
  const request = message as { channel?: string; requestId?: string; kind?: string; token?: string; asin?: string; contentLimitState?: string };
  if (request.channel !== 'writefool:notebook' || typeof request.requestId !== 'string' || !/^[\w-]{10,100}$/.test(request.requestId)) return;
  if (request.kind !== 'library' && request.kind !== 'annotations') return;
  if ([request.token, request.asin, request.contentLimitState].some((field) => field !== undefined && (typeof field !== 'string' || field.length > 10000))) return;
  void (async () => {
    try {
      const data = await readNotebookPage(document, location.href, { ...request, kind: request.kind as 'library' | 'annotations' });
      reply({ requestId: request.requestId, ok: true, data });
    } catch (error) {
      const kind = error instanceof KindleParseError ? error.kind : 'error';
      reply({ requestId: request.requestId, ok: false, kind, error: error instanceof KindleParseError ? error.message : 'The Kindle page could not be loaded. Check the notebook and try again.' });
    }
  })();
  return true;
});
