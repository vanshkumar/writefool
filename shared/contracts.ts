export type Source = 'kindle' | 'clippings';
export interface NormalizedHighlight { sourceId: string; text: string; note?: string | null; location?: string | null; highlightedAt?: string | null }
export interface NormalizedBook { sourceId: string; title: string; author: string; highlights: NormalizedHighlight[]; targetBookId?: string }
export interface ImportBatch { batchId: string; runId: string; source: Source; books: NormalizedBook[]; complete?: boolean; warnings?: string[]; accountFingerprint?: string }
export interface KindleAccount { salt: string; fingerprint: string | null }
export interface ImportResult { imported: number; updated: number; skipped: number; books: number; warnings: string[] }
export interface Preferences { intervalDays: number; highlightCount: number; localTime: string; timezone: string; enabled: boolean; nextSendAt: string | null }
export const DEFAULT_PREFERENCES: Preferences = { intervalDays: 2, highlightCount: 5, localTime: '08:00', timezone: 'America/Los_Angeles', enabled: false, nextSendAt: null };
export interface Book { id: string; title: string; author: string; excluded: boolean; highlightCount: number; source: Source }
export interface Highlight { id: string; bookId: string; title: string; author: string; text: string; note: string | null; location: string | null; hidden: boolean; lastSentAt: string | null; importedAt: string }
export type SyncState = 'idle' | 'syncing' | 'success' | 'login_required' | 'account_required' | 'account_mismatch' | 'account_unverified' | 'error';
export interface SyncStatus { status: SyncState; lastSuccessAt: string | null; message: string | null; progress: number; connected: boolean }
export type DigestState = 'pending' | 'sending' | 'accepted' | 'delivered' | 'failed' | 'uncertain' | 'skipped' | 'cancelled' | 'bounced' | 'complained';
export interface DigestSummary { id: string; scheduledFor: string; status: DigestState; highlightCount: number; error: string | null; isTest: boolean }
export interface Dashboard { user: { id: string; email: string; name: string }; preferences: Preferences; sync: SyncStatus; totals: { books: number; highlights: number; eligible: number }; recentDigests: DigestSummary[]; extensionTokens: { id: string; createdAt: string; lastUsedAt: string | null }[] }
export interface DigestPreview { highlights: Highlight[]; html: string; text: string; subject: string }
export interface ClippingsPreview { books: NormalizedBook[]; warnings: string[]; matches: { sourceId: string; candidates: Book[] }[] }
export interface ApiError { error: string }
