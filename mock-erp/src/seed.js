import { pool, query, migrate } from './db.js';

const students = [
  ['SC211/0001/2022', 'Amina Wanjiku Kamau',   'BSc Computer Science',        3, 'active'],
  ['SC211/0002/2022', 'Brian Otieno Odhiambo', 'BSc Computer Science',        3, 'active'],
  ['SC211/0003/2023', 'Cynthia Achieng Ouma',  'BSc Information Technology',  2, 'active'],
  ['SC211/0004/2023', 'David Mwangi Njoroge',  'BSc Information Technology',  2, 'active'],
  ['SC211/0005/2024', 'Esther Naliaka Wekesa', 'BSc Software Engineering',    1, 'active'],
  ['SC211/0006/2021', 'Felix Kiprono Rotich',  'BSc Computer Science',        4, 'active'],
  ['SC211/0007/2020', 'Grace Mutheu Musyoka',  'BSc Computer Science',        4, 'graduated'],
  ['SC211/0008/2022', 'Hassan Abdi Mohamed',   'BSc Software Engineering',    3, 'deferred'],
  ['SC211/0009/2023', 'Irene Chebet Koech',    'BSc Information Technology',  2, 'discontinued'],
  ['SC211/0010/2024', 'James Kamau Mwaura',    'BSc Software Engineering',    1, 'active'],
];
// [staff_number, full_name, email, department, faculty, title, status]
// Email is left NULL on some rows on purpose: the API only compares it when the ERP holds one.
const staff = [
  ['STF/0001', 'Peter Kamami',    'peter.kamami@uni.ac.ke',  'Computer Science',       'School of Computing', 'Dr.',   'active'],
  ['STF/0002', 'Mary Atieno',     null,                      'Information Technology', 'School of Computing', 'Prof.', 'active'],
  ['STF/0003', 'John Mutua',      null,                      'Software Engineering',   'School of Computing', 'Mr.',   'active'],
  ['STF/0004', 'Lucy Njeri',      null,                      'Computer Science',       'School of Computing', 'Ms.',   'active'],
  ['STF/0005', 'Samuel Kiptoo',   null,                      'Information Technology', 'School of Computing', 'Dr.',   'left'],
  ['STF/0006', 'Naomi Wambui',    null,                      'Software Engineering',   'School of Computing', 'Dr.',   'suspended'],
];

// [code, name, staff_number, day_of_week, start_time, end_time, status]
// day_of_week 0=Sun..6=Sat. COSC 205 spans the whole day so local dev/demo
// always finds it "in session", the same trick units-attendance.test.ts and
// mocks/handlers.ts use for their own schedules.
const courses = [
  ['COSC 205', 'Data Structures and Algorithms', 'STF/0001', new Date().getDay(), '00:00', '23:59', 'active'],
  ['COSC 310', 'Database Systems',               'STF/0002', 2,                   '14:00', '16:00', 'active'],
  ['COSC 415', 'Software Engineering Principles', null,      3,                   '09:00', '11:00', 'active'],
];

// [course_code, reg_number] — the registrar's real class list. A unit's
// roster is synced from these rows (unit.service.ts listStudents) instead of
// a lecturer adding students or a student self-enrolling.
const enrollments = [
  ['COSC 205', 'SC211/0001/2022'],
  ['COSC 205', 'SC211/0002/2022'],
  ['COSC 205', 'SC211/0006/2021'],
  ['COSC 310', 'SC211/0003/2023'],
  ['COSC 310', 'SC211/0004/2023'],
];

// Inserts sample data only into EMPTY tables, so edits made through the admin UI survive restarts.
export async function seedErp() {
  const out = { students: 0, staff: 0, courses: 0, enrollments: 0 };
  const { rows: [{ n: ns }] } = await query('SELECT count(*)::int AS n FROM erp_students');
  if (ns === 0) {
    for (const r of students) await query('INSERT INTO erp_students (reg_number, full_name, programme, year_of_study, status) VALUES ($1,$2,$3,$4,$5)', r);
    out.students = students.length;
  }
  const { rows: [{ n: nf }] } = await query('SELECT count(*)::int AS n FROM erp_staff');
  if (nf === 0) {
    for (const r of staff) await query('INSERT INTO erp_staff (staff_number, full_name, email, department, faculty, title, status) VALUES ($1,$2,$3,$4,$5,$6,$7)', r);
    out.staff = staff.length;
  }
  const { rows: [{ n: nc }] } = await query('SELECT count(*)::int AS n FROM erp_courses');
  if (nc === 0) {
    for (const r of courses) await query('INSERT INTO erp_courses (code, name, staff_number, day_of_week, start_time, end_time, status) VALUES ($1,$2,$3,$4,$5,$6,$7)', r);
    out.courses = courses.length;
  }
  const { rows: [{ n: ne }] } = await query('SELECT count(*)::int AS n FROM erp_enrollments');
  if (ne === 0) {
    for (const r of enrollments) await query('INSERT INTO erp_enrollments (course_code, reg_number) VALUES ($1,$2)', r);
    out.enrollments = enrollments.length;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await migrate();
  console.log('Seeded mock ERP (empty tables only):', await seedErp());
  await pool.end();
}
