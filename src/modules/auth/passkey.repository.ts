import { query, queryOne } from '../../db/database.js';

export interface PasskeyRecord {
  credential_id: string;
  public_key: Buffer;
  counter: string;
  transports: string[];
}

export async function saveCredential(input: {
  userId: string;
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
}): Promise<void> {
  await query(
    `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.userId, input.credentialId, Buffer.from(input.publicKey), input.counter, input.transports],
  );
}

export async function findCredential(credentialId: string): Promise<(PasskeyRecord & { user_id: string }) | null> {
  return queryOne(
    `SELECT user_id, credential_id, public_key, counter, transports
       FROM webauthn_credentials WHERE credential_id = $1`,
    [credentialId],
  );
}

export async function findCredentialsForUser(userId: string): Promise<PasskeyRecord[]> {
  const result = await query<PasskeyRecord>(
    `SELECT credential_id, public_key, counter, transports
       FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
  return result.rows;
}

export async function updateCounter(credentialId: string, counter: number): Promise<void> {
  await query(
    `UPDATE webauthn_credentials SET counter = $2, last_used_at = NOW() WHERE credential_id = $1`,
    [credentialId, counter],
  );
}

export async function saveChallenge(userId: string, challenge: string, expiresAt: Date): Promise<void> {
  await query(
    `INSERT INTO webauthn_challenges (user_id, challenge, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET challenge = EXCLUDED.challenge, expires_at = EXCLUDED.expires_at`,
    [userId, challenge, expiresAt],
  );
}

export async function consumeChallenge(userId: string): Promise<string | null> {
  const result = await query<{ challenge: string }>(
    `DELETE FROM webauthn_challenges
      WHERE user_id = $1 AND expires_at > NOW()
      RETURNING challenge`,
    [userId],
  );
  return result.rows[0]?.challenge ?? null;
}
