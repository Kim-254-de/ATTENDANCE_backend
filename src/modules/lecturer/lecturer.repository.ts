import { queryOne } from '../../db/database.js';

export interface LecturerSummary {
  unitsAllocated: number;
  totalStudents: number;
  sessionsHeld: number;
  /** 0–100, averaged across every session's own checked-in ÷ ACTIVE-allocation rate. */
  avgAttendance: number;
}

/** The four numbers the Dashboard's stat cards and the Profile page's teaching summary both show. */
export async function getSummary(lecturerUserId: string): Promise<LecturerSummary> {
  const [units, sessions, attendance] = await Promise.all([
    queryOne<{ units_count: number; total_students: number }>(
      `SELECT COUNT(DISTINCT u.id)::int AS units_count,
              COUNT(a.id) FILTER (WHERE a.status = 'ACTIVE')::int AS total_students
         FROM units u
         LEFT JOIN unit_allocations a ON a.unit_id = u.id
        WHERE u.lecturer_user_id = $1`,
      [lecturerUserId],
    ),
    queryOne<{ sessions_held: number }>(
      `SELECT COUNT(*)::int AS sessions_held FROM attendance_sessions WHERE lecturer_user_id = $1`,
      [lecturerUserId],
    ),
    queryOne<{ avg_attendance: number }>(
      `SELECT COALESCE(AVG(rate), 0)::float8 AS avg_attendance
         FROM (
           SELECT
             (SELECT COUNT(*) FROM attendance_records r WHERE r.session_id = s.id)::numeric
             / NULLIF((SELECT COUNT(*) FROM unit_allocations a
                        WHERE a.unit_id = s.unit_id AND a.status = 'ACTIVE'), 0) * 100 AS rate
             FROM attendance_sessions s
            WHERE s.lecturer_user_id = $1
         ) per_session
        WHERE rate IS NOT NULL`,
      [lecturerUserId],
    ),
  ]);

  return {
    unitsAllocated: units?.units_count ?? 0,
    totalStudents: units?.total_students ?? 0,
    sessionsHeld: sessions?.sessions_held ?? 0,
    avgAttendance: attendance?.avg_attendance ?? 0,
  };
}

export interface LecturerProfile {
  id: string;
  role: 'lecturer';
  fullName: string;
  email: string;
  staffNumber: string;
  title: string;
  department: string;
  faculty: string;
  phone: string;
  registeredAt: Date;
}

interface LecturerProfileRow {
  id: string;
  full_name: string;
  email: string;
  staff_number: string;
  title: string | null;
  department: string | null;
  faculty: string | null;
  phone: string | null;
  created_at: Date;
}

/** Returns only an active, non-deleted lecturer registration. */
export async function findActiveLecturerProfile(userId: string): Promise<LecturerProfile | null> {
  const row = await queryOne<LecturerProfileRow>(
    `SELECT u.id, u.full_name, u.email, p.staff_number, p.title, p.department,
            p.faculty, p.phone, u.created_at
       FROM users u
       JOIN lecturer_profiles p ON p.user_id = u.id
      WHERE u.id = $1
        AND u.role = 'LECTURER'
        AND u.status = 'ACTIVE'
        AND u.deleted_at IS NULL`,
    [userId],
  );

  if (!row) return null;

  return {
    id: row.id,
    role: 'lecturer',
    fullName: row.full_name,
    email: row.email,
    staffNumber: row.staff_number,
    title: row.title ?? '',
    department: row.department ?? '',
    faculty: row.faculty ?? '',
    phone: row.phone ?? '',
    registeredAt: row.created_at,
  };
}