import { betterAuth } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
import { APIError } from 'better-auth/api';
import { getCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { ensurePreferences, hash, type UserRow } from './db';

export function isLocalDevelopment(env: Pick<Env, 'ENVIRONMENT'>, url: string): boolean {
  const host = new URL(url).hostname;
  return env.ENVIRONMENT === 'development' && ['localhost', '127.0.0.1', '[::1]'].includes(host);
}
export function configured(env: Env): boolean {
  return !!(env.AUTH_SECRET?.length >= 32 && env.RESEND_API_KEY && env.EMAIL_FROM && env.APP_URL && env.OWNER_EMAIL);
}
export async function ensureOwner(env: Env, timezone?: string): Promise<UserRow> {
  const email = env.OWNER_EMAIL.trim().toLowerCase();
  if (!email) throw new Error('The owner email is not configured');
  const now = Date.now();
  await env.DB.prepare('INSERT OR IGNORE INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,0,?,?)').bind(crypto.randomUUID(), email.split('@')[0], email, now, now).run();
  const user = await env.DB.prepare('SELECT id,email,name FROM user WHERE email=?').bind(email).first<UserRow>();
  if (!user) throw new Error('Could not initialize the owner');
  await ensurePreferences(env.DB, user.id, timezone);
  return user;
}
export function createAuth(env: Env) {
  return betterAuth({
    database: env.DB,
    baseURL: env.APP_URL,
    secret: env.AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    emailAndPassword: { enabled: false },
    logger: { disabled: true },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    databaseHooks: { user: { create: { before: async user => {
      if (user.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) throw new APIError('FORBIDDEN', { message: 'This is a private account' });
      return { data: user };
    } } } },
    plugins: [magicLink({
      disableSignUp: true,
      storeToken: 'hashed',
      expiresIn: 600,
      sendMagicLink: async ({ email, url }) => {
        if (email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) throw new APIError('FORBIDDEN', { message: 'This is a private account' });
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: env.EMAIL_FROM, to: email, subject: 'Your Writefool sign-in link', text: `Sign in to Writefool:\n\n${url}\n\nThis link expires in 10 minutes and can be used once. If you did not request it, ignore this email.` }),
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new APIError('SERVICE_UNAVAILABLE', { message: 'Could not send the sign-in link. Please try again.' });
      },
    })],
  });
}
export async function developmentUser<E extends { Bindings: Env }>(c: Context<E>): Promise<UserRow | null> {
  if (isLocalDevelopment(c.env, c.req.url)) {
    const token = getCookie(c, 'wf_dev');
    if (token) {
      const user = await c.env.DB.prepare('SELECT u.id,u.email,u.name FROM dev_sessions s JOIN user u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').bind(await hash(token), new Date().toISOString()).first<UserRow>();
      if (user) return user;
    }
  }
  return null;
}
export async function currentUser<E extends { Bindings: Env }>(c: Context<E>): Promise<UserRow | null> {
  const local = await developmentUser(c);
  if (local) return local;
  if (!configured(c.env)) return null;
  const result = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!result || result.user.email.toLowerCase() !== c.env.OWNER_EMAIL.trim().toLowerCase()) return null;
  return { id: result.user.id, email: result.user.email, name: result.user.name };
}
