import { query, queryOne } from '../../db/database.js';
import type { GeofenceResult, VerificationMethod } from '../../db/types.js';

/** All SQL for the attendance module. Every query is parameterised. */

export interface NewRecord {
  sessionId: string;
  unitId: string;
  studentUserId: string;
  /** How old the scanned QR code was. Null for methods without a rotating code. */
  qrAgeSeconds: number | null;
  /** What proved the student was present. */
  verificationMethod: VerificationMethod;
  geofenceResult: GeofenceResult;
  distanceMetres: number | null;
  locationAccuracyMetres: number | null;
  ipAddress: string | null;
  userAgent: string | null;
  /** FACE only: the match's cosine similarity. */
  faceScore?: number | null;
  /** FACE only: the lecturer who confirmed the match. */
  confirmedByUserId?: string | null;
}

/**
 * Writes the check-in. Throws a unique violation when the student is already
 * recorded for this session — the UNIQUE (session_id, student_user_id)
 * constraint is what stops two simultaneous scans both landing.
 */
export async function insertRecord(record: NewRecord): Promise<{ id: string; recordedAt: Date }> {
  const row = await queryOne<{ id: string; recorded_at: Date }>(
    `INSERT INTO attendance_records
       (session_id, student_user_id, allocation_id, qr_age_seconds, ip_address, user_agent,
        geofence_result, distance_m, location_accuracy_m, verification_method,
        face_score, confirmed_by_user_id)
     VALUES ($1, $2,
             (SELECT id FROM unit_allocations WHERE unit_id = $3 AND student_user_id = $2),
             $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, recorded_at`,
    [
      record.sessionId,
      record.studentUserId,
      record.unitId,
      record.qrAgeSeconds,
      record.ipAddress,
      record.userAgent,
      record.geofenceResult,
      record.distanceMetres,
      record.locationAccuracyMetres,
      record.verificationMethod,
      record.faceScore ?? null,
      record.confirmedByUserId ?? null,
    ],
  );
  if (!row) throw new Error('attendance_records insert returned no row');
  return { id: row.id, recordedAt: row.recorded_at };
}

export interface AttendeeRow {
  id: string;
  studentUserId: string;
  fullName: string;
  registrationNumber: string | null;
  recordedAt: Date;
  /** How far from the fence's centre the check-in was; null when the geofence was off. */
  distanceMetres: number | null;
  geofenceResult: GeofenceResult;
  /** What proved they were present: a scanned code, a swiped card. */
  verificationMethod: VerificationMethod;
}

/** Everyone recorded for a session, most recent first — what the lecturer watches arrive. */
export async function listRecords(sessionId: string): Promise<AttendeeRow[]> {
  const result = await query<{
    id: string;
    student_user_id: string;
    full_name: string;
    registration_number: string | null;
    recorded_at: Date;
    distance_m: number | null;
    geofence_result: GeofenceResult;
    verification_method: VerificationMethod;
  }>(
    `SELECT r.id, r.student_user_id, u.full_name, a.registration_number, r.recorded_at,
            r.distance_m, r.geofence_result, r.verification_method
       FROM attendance_records r
       JOIN users u ON u.id = r.student_user_id
       LEFT JOIN unit_allocations a ON a.id = r.allocation_id
      WHERE r.session_id = $1
      ORDER BY r.recorded_at DESC`,
    [sessionId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    studentUserId: row.student_user_id,
    fullName: row.full_name,
    registrationNumber: row.registration_number,
    recordedAt: row.recorded_at,
    distanceMetres: row.distance_m,
    geofenceResult: row.geofence_result,
    verificationMethod: row.verification_method,
  }));
}
