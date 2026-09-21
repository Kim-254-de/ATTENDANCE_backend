import { pool, query, migrate } from '../db.js';

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
const staff = [
  ['STF/0001', 'Dr. Peter Kamami',      'Computer Science',        'active'],
  ['STF/0002', 'Prof. Mary Atieno',     'Information Technology',  'active'],
  ['STF/0003', 'Mr. John Mutua',        'Software Engineering',    'active'],
  ['STF/0004', 'Ms. Lucy Njeri',        'Computer Science',        'active'],
  ['STF/0005', 'Dr. Samuel Kiptoo',     'Information Technology',  'left'],
  ['STF/0006', 'Dr. Naomi Wambui',      'Software Engineering',    'suspended'],
];

// Inserts sample data only into EMPTY tables, so edits made through the admin UI survive restarts.
export async function seedErp() {
  const out = { students: 0, staff: 0 };
  const { rows: [{ n: ns }] } = await query('SELECT count(*)::int AS n FROM erp_students');
  if (ns === 0) {
    for (const r of students) await query('INSERT INTO erp_students (reg_number, full_name, programme, year_of_study, status) VALUES ($1,$2,$3,$4,$5)', r);
    out.students = students.length;
  }
  const { rows: [{ n: nf }] } = await query('SELECT count(*)::int AS n FROM erp_staff');
  if (nf === 0) {
    for (const r of staff) await query('INSERT INTO erp_staff (staff_number, full_name, department, status) VALUES ($1,$2,$3,$4)', r);
    out.staff = staff.length;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await migrate();
  console.log('Seeded mock ERP (empty tables only):', await seedErp());
  await pool.end();
}
