import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Attempt, AttemptStore } from './index.js';
import type { TransactionNonceStore } from './near.js';

/** A durable claim survives process failure, including unknown signer/submission outcomes. */
export class SqliteAttemptStore implements AttemptStore, TransactionNonceStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db = new Database(path);
    chmodSync(path,0o600);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL');
    this.db.exec('CREATE TABLE IF NOT EXISTS guard_attempts (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS guard_key_nonces (id TEXT PRIMARY KEY, nonce TEXT NOT NULL)');
  }
  reserveNonce(key: string, finalizedNonce: bigint): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT nonce FROM guard_key_nonces WHERE id=?').get(key) as {nonce:string} | undefined;
      // Never reuse a signature's nonce, even after restart or an uncertain submission.
      if (row && BigInt(row.nonce) > finalizedNonce) return false;
      this.db.prepare('INSERT INTO guard_key_nonces VALUES (?,?) ON CONFLICT(id) DO UPDATE SET nonce=excluded.nonce')
        .run(key,(finalizedNonce+1n).toString());
      return true;
    }).immediate();
  }
  async claim(attempt: Attempt): Promise<boolean> {
    return this.db.prepare('INSERT OR IGNORE INTO guard_attempts VALUES (?,?)').run(attempt.requestId,JSON.stringify(attempt)).changes === 1;
  }
  async get(id: string): Promise<Attempt | null> {
    const row = this.db.prepare('SELECT value FROM guard_attempts WHERE id=?').get(id) as {value:string} | undefined;
    return row ? JSON.parse(row.value) as Attempt : null;
  }
  async put(attempt: Attempt): Promise<void> {
    if (this.db.prepare('UPDATE guard_attempts SET value=? WHERE id=?').run(JSON.stringify(attempt),attempt.requestId).changes !== 1) throw new Error('Missing attempt claim');
  }
  async release(id: string): Promise<void> { this.db.prepare('DELETE FROM guard_attempts WHERE id=?').run(id); }
  close(): void { this.db.close(); }
}
