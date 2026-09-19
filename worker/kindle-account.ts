import { ImportError } from './import';
import type { KindleAccount } from '../shared/contracts';

export async function kindleAccount(db: D1Database, userId: string): Promise<KindleAccount> {
  await db.prepare('INSERT OR IGNORE INTO kindle_accounts(user_id,salt) VALUES (?,?)').bind(userId, crypto.randomUUID()).run();
  const row = await db.prepare('SELECT salt,fingerprint FROM kindle_accounts WHERE user_id=?').bind(userId).first<KindleAccount>();
  if (!row) throw new Error('Kindle account settings could not be loaded');
  return row;
}

export async function confirmKindleAccount(db: D1Database, userId: string, fingerprint: string): Promise<KindleAccount> {
  await kindleAccount(db, userId);
  const result = await db.prepare('UPDATE kindle_accounts SET fingerprint=?,confirmed_at=COALESCE(confirmed_at,?) WHERE user_id=? AND (fingerprint IS NULL OR fingerprint=?)')
    .bind(fingerprint, new Date().toISOString(), userId, fingerprint).run();
  if (!result.meta.changes) throw new ImportError('This library is locked to another Amazon account. Switch back to the connected Kindle account.', 409);
  return kindleAccount(db, userId);
}
