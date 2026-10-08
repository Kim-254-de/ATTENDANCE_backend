import { query, queryOne } from '../../db/database.js';

/**
 * All SQL for student ID cards. Every query is parameterised.
 *
 * Cards are only ever looked up by the HMAC of their UID — the plaintext UID
 * is never stored, so there is nothing here to query it by. See
 * common/utils/card-uid.ts for why an HMAC rather than a plain hash.
 */

export interface CardHolder {
  cardId: string;
  studentUserId: string;
  /** For the terminal's display, so the student can see who was recorded. */
  fullName: string;
  registrationNumber: string | null;
}

/**
 * The student holding this card, or null.
 *
 * Only ACTIVE cards resolve: a card reported lost is REVOKED, and the row
 * stays so the attendance it already recorded keeps its meaning. A revoked
 * card is therefore indistinguishable from an unknown one at the door, which
 * is the intended answer in both cases.
 */
export async function findCardHolder(cardUidHmac: string): Promise<CardHolder | null> {
  const row = await queryOne<{
    card_id: string;
    student_user_id: string;
    full_name: string;
    registration_number: string | null;
  }>(
    `SELECT c.id AS card_id, c.student_user_id, u.full_name, p.registration_number
       FROM student_cards c
       JOIN users u            ON u.id = c.student_user_id
       LEFT JOIN student_profiles p ON p.user_id = c.student_user_id
      WHERE c.card_uid_hmac = $1
        AND c.status = 'ACTIVE'
        AND u.deleted_at IS NULL`,
    [cardUidHmac],
  );
  if (!row) return null;
  return {
    cardId: row.card_id,
    studentUserId: row.student_user_id,
    fullName: row.full_name,
    registrationNumber: row.registration_number,
  };
}

export interface EnrolCardArgs {
  studentUserId: string;
  cardUidHmac: string;
  label: string | null;
  /** The account that enrolled it, when one is signed in. */
  enrolledByUserId: string | null;
}

/**
 * Binds a card to a student.
 *
 * Throws a unique violation when the UID is already enrolled (to anyone), or
 * when the student already holds an ACTIVE card — the partial unique index
 * enforces one usable card each, so a replacement means revoking first.
 */
export async function enrolCard(args: EnrolCardArgs): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO student_cards (student_user_id, card_uid_hmac, label, status, enrolled_by_user_id)
     VALUES ($1, $2, $3, 'ACTIVE', $4)
     RETURNING id`,
    [args.studentUserId, args.cardUidHmac, args.label, args.enrolledByUserId],
  );
  if (!row) throw new Error('student_cards insert returned no row');
  return row.id;
}

/** Takes a student's current card out of use. Returns the card id, or null if they had none. */
export async function revokeActiveCard(studentUserId: string): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    `UPDATE student_cards
        SET status = 'REVOKED', revoked_at = NOW(), updated_at = NOW()
      WHERE student_user_id = $1 AND status = 'ACTIVE'
      RETURNING id`,
    [studentUserId],
  );
  return row?.id ?? null;
}

export interface CardSummary {
  id: string;
  label: string | null;
  status: 'ACTIVE' | 'REVOKED';
  issuedAt: Date;
  revokedAt: Date | null;
}

/** A student's cards, current first. The UID hash is never returned. */
export async function listCards(studentUserId: string): Promise<CardSummary[]> {
  const result = await query<{
    id: string;
    label: string | null;
    status: 'ACTIVE' | 'REVOKED';
    issued_at: Date;
    revoked_at: Date | null;
  }>(
    `SELECT id, label, status, issued_at, revoked_at
       FROM student_cards
      WHERE student_user_id = $1
      ORDER BY status = 'ACTIVE' DESC, issued_at DESC`,
    [studentUserId],
  );
  return result.rows.map((r) => ({
    id: r.id,
    label: r.label,
    status: r.status,
    issuedAt: r.issued_at,
    revokedAt: r.revoked_at,
  }));
}
