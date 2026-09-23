import { queryOne } from '../../db/database.js';

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