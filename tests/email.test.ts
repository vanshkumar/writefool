import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Highlight } from '../shared/contracts';
import { deliverEmail, renderDigest, signUnsubscribeToken, verifyUnsubscribeToken } from '../worker/email';

const highlight: Highlight = { id: 'id/1', bookId: 'book', title: 'A <Book>', author: 'Author', text: '<script>bad</script>\nAn original quotation & thought.', note: 'My <note>', location: '123', hidden: false, lastSentAt: null, importedAt: '2026-09-08' };
afterEach(() => vi.unstubAllGlobals());
describe('email rendering and delivery', () => {
  it('preserves original text in plain text and escapes HTML without trackers', () => {
    const preview = renderDigest([highlight], 'https://example.com', 'https://example.com/unsubscribe?token=a');
    expect(preview.text).toContain(highlight.text);
    expect(preview.html).toContain('&lt;script&gt;bad&lt;/script&gt;');
    expect(preview.html).not.toContain('<script>');
    expect(preview.html).not.toContain('<img');
    expect(preview.html).toContain('https://example.com/library?highlight=id%2F1');
    expect(preview.html).toContain('href="https://example.com/settings"');
    expect(preview.text).toContain('Email settings: https://example.com/settings');
  });
  it('rejects changed unsubscribe tokens and secrets', async () => {
    const env = { AUTH_SECRET: 'a strong local test secret' };
    const token = await signUnsubscribeToken(env, 'user-1');
    expect(await verifyUnsubscribeToken(env, token)).toBe('user-1');
    expect(await verifyUnsubscribeToken(env, `x${token}`)).toBeNull();
    expect(await verifyUnsubscribeToken({ AUTH_SECRET: 'wrong key' }, token)).toBeNull();
  });
  it('supplies the fixed provider idempotency key and reports ambiguity', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: 'message-1' }));
    vi.stubGlobal('fetch', fetcher);
    const payload = { from: 'me@example.com', to: 'me@example.com', subject: 'Hello', html: 'Hello', text: 'Hello', headers: {}, tags: [] };
    await expect(deliverEmail({ RESEND_API_KEY: 'test' }, payload, 'digest/1')).resolves.toBe('message-1');
    expect(fetcher.mock.calls[0][1].headers['Idempotency-Key']).toBe('digest/1');
    fetcher.mockRejectedValue(new Error('timeout'));
    await expect(deliverEmail({ RESEND_API_KEY: 'test' }, payload, 'digest/1')).rejects.toMatchObject({ ambiguous: true, retryable: true });
  });
});
