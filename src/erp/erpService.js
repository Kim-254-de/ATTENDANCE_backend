// ERP integration boundary.
// The rest of the app ONLY calls these functions. Today they read the mock ERP
// tables in Postgres. When real ERP access exists, replace the bodies with calls
// to the ERP and keep the same return shape:
//   { found: boolean, active: boolean, record?: { fullName, ... } }
import { query } from '../db.js';

const norm = (s) => String(s ?? '').trim();

export async function lookupStudent(regNumber) {
  const { rows: [r] } = await query('SELECT * FROM erp_students WHERE reg_number = $1', [norm(regNumber)]);
  if (!r) return { found: false, active: false };
  return {
    found: true,
    active: r.status === 'active',
    record: { regNumber: r.reg_number, fullName: r.full_name, programme: r.programme, yearOfStudy: r.year_of_study, status: r.status },
  };
}

export async function lookupStaff(staffNumber) {
  const { rows: [r] } = await query('SELECT * FROM erp_staff WHERE staff_number = $1', [norm(staffNumber)]);
  if (!r) return { found: false, active: false };
  return {
    found: true,
    active: r.status === 'active',
    record: { staffNumber: r.staff_number, fullName: r.full_name, department: r.department, status: r.status },
  };
}

// Loose name comparison: case, extra spaces and word order are ignored.
export function namesMatch(a, b) {
  const t = (s) => norm(s).toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ');
  return t(a) === t(b);
}
