import { Webhook } from 'svix';
import type { DigestPreview, Highlight } from '../shared/contracts';

export interface FrozenEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
  tags: { name: string; value: string }[];
}

const escape = (text: string) => text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function signingKey(secret: string) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signUnsubscribeToken(env: Pick<Env, 'AUTH_SECRET'>, userId: string): Promise<string> {
  const payload = base64url(new TextEncoder().encode(JSON.stringify({ userId, purpose: 'unsubscribe' })));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(env.AUTH_SECRET), new TextEncoder().encode(payload));
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

export async function verifyUnsubscribeToken(env: Pick<Env, 'AUTH_SECRET'>, token: string): Promise<string | null> {
  try {
    if (token.length > 2048) return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return null;
    const valid = await crypto.subtle.verify('HMAC', await signingKey(env.AUTH_SECRET), fromBase64url(signature), new TextEncoder().encode(payload));
    if (!valid) return null;
    const decoded: unknown = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
    if (typeof decoded !== 'object' || decoded === null || !('purpose' in decoded) || decoded.purpose !== 'unsubscribe' || !('userId' in decoded) || typeof decoded.userId !== 'string') return null;
    return decoded.userId;
  } catch { return null; }
}

export function renderDigest(highlights: Highlight[], appUrl: string, unsubscribeUrl?: string): DigestPreview {
  const subject = `Your ${highlights.length} Kindle highlight${highlights.length === 1 ? '' : 's'}`;
  const base = appUrl.replace(/\/$/, '');
  const text = [
    subject,
    ...highlights.map(h => [h.text, h.note ? `Your note: ${h.note}` : '', `${h.title} — ${h.author}${h.location ? ` · Location ${h.location}` : ''}`, `${base}/library?highlight=${encodeURIComponent(h.id)}`].filter(Boolean).join('\n')),
    `Email settings: ${base}/settings`,
    unsubscribeUrl ? `Pause these emails: ${unsubscribeUrl}` : '',
  ].filter(Boolean).join('\n\n---\n\n');
  const body = highlights.map(h => `<div style="margin:32px 0"><blockquote style="margin:0 0 16px;font:20px/1.6 Georgia,serif;white-space:pre-wrap">${escape(h.text)}</blockquote>${h.note ? `<p style="font:16px/1.6 Arial,sans-serif;white-space:pre-wrap;color:#555">Your note: ${escape(h.note)}</p>` : ''}<p style="font:14px/1.5 Arial,sans-serif;color:#777">${escape(h.title)} — ${escape(h.author)}${h.location ? ` · Location ${escape(h.location)}` : ''}<br><a style="color:#625d4d" href="${escape(`${base}/library?highlight=${encodeURIComponent(h.id)}`)}">View highlight</a></p></div>`).join('<hr style="border:0;border-top:1px solid #e7e2d9">');
  const footer = `<p style="font:14px/1.6 Arial,sans-serif;margin-top:40px"><a href="${escape(`${base}/settings`)}" style="color:#625d4d">Email settings</a>${unsubscribeUrl ? `<br><a href="${escape(unsubscribeUrl)}" style="color:#625d4d">Pause these emails</a>` : ''}</p>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#faf8f2;color:#282820"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#faf8f2"><tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:580px"><tr><td style="padding:36px 24px"><p style="font:14px Arial,sans-serif;letter-spacing:2px;color:#777">WRITEFOOL</p>${body}${footer}</td></tr></table></td></tr></table></body></html>`;
  return { highlights, subject, html, text };
}

export async function freezeEmail(env: Env, userId: string, recipient: string, digestId: string, highlights: Highlight[]): Promise<FrozenEmail> {
  const token = await signUnsubscribeToken(env, userId);
  const base = env.APP_URL.replace(/\/$/, '');
  const unsubscribeUrl = `${base}/unsubscribe?token=${encodeURIComponent(token)}`;
  const preview = renderDigest(highlights, base, unsubscribeUrl);
  return {
    from: env.EMAIL_FROM, to: recipient, subject: preview.subject, html: preview.html, text: preview.text,
    headers: { 'List-Unsubscribe': `<${base}/api/unsubscribe?token=${encodeURIComponent(token)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    tags: [{ name: 'digest_id', value: digestId }],
  };
}

export class EmailSendError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly ambiguous: boolean) { super(message); }
}

export async function deliverEmail(env: Pick<Env, 'RESEND_API_KEY'>, payload: FrozenEmail, idempotencyKey: string): Promise<string> {
  if (!env.RESEND_API_KEY) throw new EmailSendError('Email sending is not configured', false, false);
  let response: Response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000),
    });
  } catch { throw new EmailSendError('Email provider response was not received', true, true); }
  const result: unknown = await response.json().catch(() => null);
  if (response.ok && result && typeof result === 'object' && 'id' in result && typeof result.id === 'string') return result.id;
  const name = result && typeof result === 'object' && 'name' in result && typeof result.name === 'string' ? result.name : '';
  const retryable = response.ok || response.status === 429 || response.status >= 500 || name === 'concurrent_idempotent_requests';
  throw new EmailSendError(`Email provider error (${response.status}${name ? `: ${name}` : ''})`, retryable, response.ok || response.status >= 500);
}

export interface ResendEvent {
  type: string;
  created_at?: string;
  data: { email_id: string; tags?: Record<string, string> | { name: string; value: string }[]; bounce?: { type?: string } };
}

export async function verifiedEvent(env: Pick<Env, 'RESEND_WEBHOOK_SECRET'>, request: Request): Promise<{ id: string; event: ResendEvent; raw: string } | null> {
  if (!env.RESEND_WEBHOOK_SECRET) return null;
  try {
    const raw = await request.text();
    const id = request.headers.get('svix-id') || '';
    new Webhook(env.RESEND_WEBHOOK_SECRET).verify(raw, { 'svix-id': id, 'svix-timestamp': request.headers.get('svix-timestamp') || '', 'svix-signature': request.headers.get('svix-signature') || '' });
    const verified: unknown = JSON.parse(raw);
    if (!verified || typeof verified !== 'object' || !('type' in verified) || typeof verified.type !== 'string' || !('data' in verified) || !verified.data || typeof verified.data !== 'object' || !('email_id' in verified.data) || typeof verified.data.email_id !== 'string') return null;
    return { id, event: verified as ResendEvent, raw };
  } catch { return null; }
}
