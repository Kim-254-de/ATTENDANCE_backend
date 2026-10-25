import type { PoolClient } from 'pg';
import { query, queryOne, type Queryable, pool } from '../../db/database.js';

/**
 * All SQL for a department's teaching. Every query is parameterised.
 *
 * A term's teaching is small (hundreds of units at most), so the service reads
 * the whole term at once (`loadTerm`) and works out the board, the publishing
 * checks and the Generator's submissions in memory, the way the Allocator did.
 * Writes run inside a transaction that first takes `lockTerm`, so two officers
 * of one department never interleave (and a publish never races an edit).
 */

export type EmploymentType = 'full_time' | 'part_time';
export type RoomType = 'lecture_hall' | 'lab' | 'seminar';

export interface CourseRow {
  id: string;
  departmentId: string;
  /** compact(departments.code): 'DCOMP'. Empty for a department with no code. */
  departmentCode: string;
  programme: string;
  year: number;
  semester: number;
  subClass: string;
  students: number;
}

export interface MemberRow {
  courseId: string;
  /** This course's share when it is split between groups, else null (the whole course). */
  students: number | null;
}

export interface GroupRow {
  id: string;
  label: string;
  lecturerId: string | null;
  lectureHours: number | null;
  practicalHours: number | null;
  cfHours: number | null;
  members: MemberRow[];
}

export interface UnitRow {
  id: string;
  departmentId: string;
  departmentCode: string;
  code: string;
  codeKey: string;
  title: string;
  weeklyHours: number;
  classLength: number;
  roomType: RoomType;
  publishedSignature: string | null;
  enteredByName: string;
  courseIds: string[];
  groups: GroupRow[];
}

export interface LecturerRow {
  id: string;
  departmentId: string;
  title: string;
  fullName: string;
  staffNumber: string | null;
  employmentType: EmploymentType;
  phone: string;
  email: string;
  maxWeeklyHours: number | null;
  active: boolean;
}

export interface PublicationRow {
  id: string;
  departmentId: string;
  publishedByName: string;
  publishedAt: Date;
  unitCount: number;
  groupCount: number;
  reopenedAt: Date | null;
  reopenedByName: string | null;
}

export interface TermData {
  courses: CourseRow[];
  units: UnitRow[];
  /** Every lecturer a group of the term names, plus every department list asked for. */
  lecturers: Map<string, LecturerRow>;
}

/** 'COSC 103' -> 'COSC103': codes compared without spaces or punctuation, in upper case. */
export const compact = (value: string | null | undefined): string => (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const num = (value: string | null): number | null => (value === null ? null : Number(value));

const LECTURER_COLUMNS = `l.id, l.department_id, l.title, l.full_name, l.staff_number, l.employment_type,
  l.phone, l.email, l.max_weekly_hours, l.active`;

interface LecturerDbRow {
  id: string;
  department_id: string;
  title: string;
  full_name: string;
  staff_number: string | null;
  employment_type: EmploymentType;
  phone: string;
  email: string;
  max_weekly_hours: number | null;
  active: boolean;
}

const toLecturer = (r: LecturerDbRow): LecturerRow => ({
  id: r.id,
  departmentId: r.department_id,
  title: r.title,
  fullName: r.full_name,
  staffNumber: r.staff_number,
  employmentType: r.employment_type,
  phone: r.phone,
  email: r.email,
  maxWeeklyHours: r.max_weekly_hours,
  active: r.active,
});

/** Everything entered for a term, every department's. `departmentIds`' lecturer lists are included whole. */
export async function loadTerm(termId: string, departmentIds: string[] = [], client: Queryable = pool): Promise<TermData> {
  const courses = await query<{
    id: string; department_id: string; department_code: string | null; programme: string;
    year: number; semester: number; sub_class: string; students: number;
  }>(
    `SELECT c.id, c.department_id, d.code AS department_code, c.programme, c.year, c.semester, c.sub_class, c.students
       FROM teaching_courses c JOIN departments d ON d.id = c.department_id
      WHERE c.generator_term_id = $1
      ORDER BY c.programme, c.year, c.semester, c.sub_class`,
    [termId],
    client,
  );
  const units = await query<{
    id: string; department_id: string; department_code: string | null; code: string; code_key: string; title: string;
    weekly_hours: number; class_length: number; room_type: RoomType; published_signature: string | null; entered_by_name: string;
  }>(
    `SELECT u.id, u.department_id, d.code AS department_code, u.code, u.code_key, u.title, u.weekly_hours,
            u.class_length, u.room_type, u.published_signature, u.entered_by_name
       FROM teaching_units u JOIN departments d ON d.id = u.department_id
      WHERE u.generator_term_id = $1
      ORDER BY u.code_key`,
    [termId],
    client,
  );
  const links = await query<{ unit_id: string; course_id: string }>(
    `SELECT uc.unit_id, uc.course_id FROM teaching_unit_courses uc
       JOIN teaching_units u ON u.id = uc.unit_id WHERE u.generator_term_id = $1`,
    [termId],
    client,
  );
  const groups = await query<{
    id: string; unit_id: string; label: string; lecturer_id: string | null;
    lecture_hours: string | null; practical_hours: string | null; cf_hours: string | null;
  }>(
    `SELECT g.id, g.unit_id, g.label, g.lecturer_id, g.lecture_hours, g.practical_hours, g.cf_hours
       FROM teaching_groups g JOIN teaching_units u ON u.id = g.unit_id
      WHERE u.generator_term_id = $1
      ORDER BY g.label`,
    [termId],
    client,
  );
  const members = await query<{ group_id: string; course_id: string; students: number | null }>(
    `SELECT m.group_id, m.course_id, m.students FROM teaching_group_members m
       JOIN teaching_groups g ON g.id = m.group_id
       JOIN teaching_units u ON u.id = g.unit_id
      WHERE u.generator_term_id = $1`,
    [termId],
    client,
  );
  const lecturers = await query<LecturerDbRow>(
    `SELECT ${LECTURER_COLUMNS} FROM teaching_lecturers l
      WHERE l.department_id = ANY($2::uuid[])
         OR l.id IN (SELECT g.lecturer_id FROM teaching_groups g JOIN teaching_units u ON u.id = g.unit_id
                      WHERE u.generator_term_id = $1 AND g.lecturer_id IS NOT NULL)
      ORDER BY l.full_name`,
    [termId, departmentIds],
    client,
  );

  const membersByGroup = new Map<string, MemberRow[]>();
  for (const m of members.rows) {
    const list = membersByGroup.get(m.group_id) ?? [];
    list.push({ courseId: m.course_id, students: m.students });
    membersByGroup.set(m.group_id, list);
  }
  const groupsByUnit = new Map<string, GroupRow[]>();
  for (const g of groups.rows) {
    const list = groupsByUnit.get(g.unit_id) ?? [];
    list.push({
      id: g.id,
      label: g.label,
      lecturerId: g.lecturer_id,
      lectureHours: num(g.lecture_hours),
      practicalHours: num(g.practical_hours),
      cfHours: num(g.cf_hours),
      members: membersByGroup.get(g.id) ?? [],
    });
    groupsByUnit.set(g.unit_id, list);
  }
  const coursesByUnit = new Map<string, string[]>();
  for (const l of links.rows) {
    const list = coursesByUnit.get(l.unit_id) ?? [];
    list.push(l.course_id);
    coursesByUnit.set(l.unit_id, list);
  }
  return {
    courses: courses.rows.map((c) => ({
      id: c.id,
      departmentId: c.department_id,
      departmentCode: compact(c.department_code),
      programme: c.programme,
      year: c.year,
      semester: c.semester,
      subClass: c.sub_class,
      students: c.students,
    })),
    units: units.rows.map((u) => ({
      id: u.id,
      departmentId: u.department_id,
      departmentCode: compact(u.department_code),
      code: u.code,
      codeKey: u.code_key,
      title: u.title,
      weeklyHours: u.weekly_hours,
      classLength: u.class_length,
      roomType: u.room_type,
      publishedSignature: u.published_signature,
      enteredByName: u.entered_by_name,
      courseIds: coursesByUnit.get(u.id) ?? [],
      groups: groupsByUnit.get(u.id) ?? [],
    })),
    lecturers: new Map(lecturers.rows.map((r) => [r.id, toLecturer(r)])),
  };
}

/**
 * Serialises writes to one department's teaching for one term (and the
 * publish that locks it). Held until the transaction ends.
 */
export async function lockTerm(client: PoolClient, termId: string, departmentId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('teaching'), hashtext($1 || '/' || $2))`, [termId, departmentId]);
}

// -- departments ---------------------------------------------------------------------------------

export interface DepartmentRow {
  id: string;
  name: string;
  code: string | null;
}

export async function listDepartments(): Promise<DepartmentRow[]> {
  const { rows } = await query<DepartmentRow>(`SELECT id, name, code FROM departments ORDER BY name`);
  return rows;
}

export async function findDepartment(departmentId: string): Promise<DepartmentRow | null> {
  return queryOne<DepartmentRow>(`SELECT id, name, code FROM departments WHERE id = $1`, [departmentId]);
}

/** The signed-in officer's name, as the allocation form's "Prepared by" and the audit trail print it. */
export async function findUserName(userId: string): Promise<string> {
  const row = await queryOne<{ full_name: string | null; email: string }>(`SELECT full_name, email FROM users WHERE id = $1`, [userId]);
  return row?.full_name?.trim() || row?.email || 'A department officer';
}

// -- publications --------------------------------------------------------------------------------

const PUBLICATION_COLUMNS = `id, department_id, published_by_name, published_at, unit_count, group_count, reopened_at, reopened_by_name`;

interface PublicationDbRow {
  id: string;
  department_id: string;
  published_by_name: string;
  published_at: Date;
  unit_count: number;
  group_count: number;
  reopened_at: Date | null;
  reopened_by_name: string | null;
}

const toPublication = (r: PublicationDbRow): PublicationRow => ({
  id: r.id,
  departmentId: r.department_id,
  publishedByName: r.published_by_name,
  publishedAt: r.published_at,
  unitCount: r.unit_count,
  groupCount: r.group_count,
  reopenedAt: r.reopened_at,
  reopenedByName: r.reopened_by_name,
});

/** Each department's latest publication for the term, standing or reopened. */
export async function latestPublications(termId: string, client: Queryable = pool): Promise<Map<string, PublicationRow>> {
  const { rows } = await query<PublicationDbRow>(
    `SELECT DISTINCT ON (department_id) ${PUBLICATION_COLUMNS}
       FROM teaching_publications WHERE generator_term_id = $1
      ORDER BY department_id, published_at DESC`,
    [termId],
    client,
  );
  return new Map(rows.map((r) => [r.department_id, toPublication(r)]));
}

export async function latestPublication(termId: string, departmentId: string, client: Queryable = pool): Promise<PublicationRow | null> {
  const row = await queryOne<PublicationDbRow>(
    `SELECT ${PUBLICATION_COLUMNS} FROM teaching_publications
      WHERE generator_term_id = $1 AND department_id = $2 ORDER BY published_at DESC LIMIT 1`,
    [termId, departmentId],
    client,
  );
  return row ? toPublication(row) : null;
}

export async function insertPublication(
  client: PoolClient,
  p: { termId: string; departmentId: string; userId: string; name: string; unitCount: number; groupCount: number },
): Promise<void> {
  await client.query(
    `INSERT INTO teaching_publications (generator_term_id, department_id, published_by_user_id, published_by_name, unit_count, group_count)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [p.termId, p.departmentId, p.userId, p.name, p.unitCount, p.groupCount],
  );
}

export async function reopenPublication(client: PoolClient, publicationId: string, name: string): Promise<void> {
  await client.query(`UPDATE teaching_publications SET reopened_at = NOW(), reopened_by_name = $2 WHERE id = $1`, [publicationId, name]);
}

export async function setPublishedSignatures(client: PoolClient, signatures: Array<{ unitId: string; signature: string }>): Promise<void> {
  if (signatures.length === 0) return;
  await client.query(
    `UPDATE teaching_units u SET published_signature = s.signature
       FROM unnest($1::uuid[], $2::text[]) AS s(id, signature) WHERE u.id = s.id`,
    [signatures.map((s) => s.unitId), signatures.map((s) => s.signature)],
  );
}

// -- courses -------------------------------------------------------------------------------------

export interface CourseValues {
  programme: string;
  year: number;
  semester: number;
  subClass: string;
  students: number;
}

export async function insertCourse(client: PoolClient, termId: string, departmentId: string, v: CourseValues): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO teaching_courses (generator_term_id, department_id, programme, year, semester, sub_class, students)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [termId, departmentId, v.programme, v.year, v.semester, v.subClass, v.students],
  );
  return rows[0]!.id;
}

export async function updateCourse(client: PoolClient, courseId: string, v: CourseValues): Promise<void> {
  await client.query(
    `UPDATE teaching_courses SET programme = $2, year = $3, semester = $4, sub_class = $5, students = $6 WHERE id = $1`,
    [courseId, v.programme, v.year, v.semester, v.subClass, v.students],
  );
}

export async function deleteCourse(client: PoolClient, courseId: string): Promise<void> {
  await client.query(`DELETE FROM teaching_courses WHERE id = $1`, [courseId]);
}

// -- units ---------------------------------------------------------------------------------------

export interface UnitValues {
  code: string;
  codeKey: string;
  title: string;
  weeklyHours: number;
  classLength: number;
  roomType: RoomType;
}

export async function insertUnit(client: PoolClient, termId: string, departmentId: string, v: UnitValues, enteredBy: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO teaching_units (generator_term_id, department_id, code, code_key, title, weekly_hours, class_length, room_type, entered_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [termId, departmentId, v.code, v.codeKey, v.title, v.weeklyHours, v.classLength, v.roomType, enteredBy],
  );
  return rows[0]!.id;
}

export async function updateUnit(client: PoolClient, unitId: string, v: UnitValues, enteredBy: string): Promise<void> {
  await client.query(
    `UPDATE teaching_units SET code = $2, code_key = $3, title = $4, weekly_hours = $5, class_length = $6, room_type = $7, entered_by_name = $8
      WHERE id = $1`,
    [unitId, v.code, v.codeKey, v.title, v.weeklyHours, v.classLength, v.roomType, enteredBy],
  );
}

export async function touchUnit(client: PoolClient, unitId: string, enteredBy: string): Promise<void> {
  await client.query(`UPDATE teaching_units SET entered_by_name = $2 WHERE id = $1`, [unitId, enteredBy]);
}

export async function deleteUnit(client: PoolClient, unitId: string): Promise<void> {
  await client.query(`DELETE FROM teaching_units WHERE id = $1`, [unitId]);
}

export async function setUnitCourses(client: PoolClient, unitId: string, courseIds: string[]): Promise<void> {
  await client.query(`DELETE FROM teaching_unit_courses WHERE unit_id = $1 AND NOT (course_id = ANY($2::uuid[]))`, [unitId, courseIds]);
  await client.query(
    `INSERT INTO teaching_unit_courses (unit_id, course_id) SELECT $1, c FROM unnest($2::uuid[]) AS c ON CONFLICT DO NOTHING`,
    [unitId, courseIds],
  );
}

// -- groups --------------------------------------------------------------------------------------

export interface GroupValues {
  label: string;
  lecturerId: string | null;
  lectureHours: number | null;
  practicalHours: number | null;
  cfHours: number | null;
  members: MemberRow[];
}

/**
 * The unit's groups, all at once: a group kept by label keeps its id (the
 * Generator knows it by it), new labels are added and the rest removed.
 */
export async function replaceGroups(client: PoolClient, unitId: string, groups: GroupValues[]): Promise<void> {
  await client.query(`DELETE FROM teaching_groups WHERE unit_id = $1 AND NOT (label = ANY($2::text[]))`, [unitId, groups.map((g) => g.label)]);
  for (const g of groups) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO teaching_groups (unit_id, label, lecturer_id, lecture_hours, practical_hours, cf_hours)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (unit_id, label) DO UPDATE SET lecturer_id = EXCLUDED.lecturer_id, lecture_hours = EXCLUDED.lecture_hours,
         practical_hours = EXCLUDED.practical_hours, cf_hours = EXCLUDED.cf_hours
       RETURNING id`,
      [unitId, g.label, g.lecturerId, g.lectureHours, g.practicalHours, g.cfHours],
    );
    await setMembers(client, rows[0]!.id, g.members);
  }
}

export async function setMembers(client: PoolClient, groupId: string, members: MemberRow[]): Promise<void> {
  await client.query(`DELETE FROM teaching_group_members WHERE group_id = $1`, [groupId]);
  if (members.length === 0) return;
  await client.query(
    `INSERT INTO teaching_group_members (group_id, course_id, students)
     SELECT $1, m.course_id, m.students FROM unnest($2::uuid[], $3::int[]) AS m(course_id, students)`,
    [groupId, members.map((m) => m.courseId), members.map((m) => m.students)],
  );
}

export async function updateGroup(
  client: PoolClient,
  groupId: string,
  v: Pick<GroupValues, 'lecturerId' | 'lectureHours' | 'practicalHours' | 'cfHours'>,
): Promise<void> {
  await client.query(
    `UPDATE teaching_groups SET lecturer_id = $2, lecture_hours = $3, practical_hours = $4, cf_hours = $5 WHERE id = $1`,
    [groupId, v.lecturerId, v.lectureHours, v.practicalHours, v.cfHours],
  );
}

// -- lecturers -----------------------------------------------------------------------------------

export interface LecturerValues {
  title: string;
  fullName: string;
  staffNumber: string | null;
  employmentType: EmploymentType;
  phone: string;
  email: string;
  maxWeeklyHours: number | null;
  active: boolean;
}

export async function listLecturers(departmentId: string, client: Queryable = pool): Promise<LecturerRow[]> {
  const { rows } = await query<LecturerDbRow>(
    `SELECT ${LECTURER_COLUMNS} FROM teaching_lecturers l WHERE l.department_id = $1 ORDER BY l.full_name`,
    [departmentId],
    client,
  );
  return rows.map(toLecturer);
}

export async function findLecturer(lecturerId: string, client: Queryable = pool): Promise<LecturerRow | null> {
  const row = await queryOne<LecturerDbRow>(`SELECT ${LECTURER_COLUMNS} FROM teaching_lecturers l WHERE l.id = $1`, [lecturerId], client);
  return row ? toLecturer(row) : null;
}

export async function insertLecturer(client: PoolClient, departmentId: string, v: LecturerValues): Promise<LecturerRow> {
  const { rows } = await client.query<LecturerDbRow>(
    `INSERT INTO teaching_lecturers AS l (department_id, title, full_name, staff_number, employment_type, phone, email, max_weekly_hours, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${LECTURER_COLUMNS}`,
    [departmentId, v.title, v.fullName, v.staffNumber, v.employmentType, v.phone, v.email, v.maxWeeklyHours, v.active],
  );
  return toLecturer(rows[0]!);
}

export async function updateLecturer(client: PoolClient, lecturerId: string, v: LecturerValues): Promise<LecturerRow> {
  const { rows } = await client.query<LecturerDbRow>(
    `UPDATE teaching_lecturers l SET title = $2, full_name = $3, staff_number = $4, employment_type = $5, phone = $6, email = $7,
            max_weekly_hours = $8, active = $9
      WHERE l.id = $1 RETURNING ${LECTURER_COLUMNS}`,
    [lecturerId, v.title, v.fullName, v.staffNumber, v.employmentType, v.phone, v.email, v.maxWeeklyHours, v.active],
  );
  return toLecturer(rows[0]!);
}

export async function deleteLecturer(client: PoolClient, lecturerId: string): Promise<void> {
  await client.query(`DELETE FROM teaching_lecturers WHERE id = $1`, [lecturerId]);
}

/** How many groups, in any term, name this lecturer. */
export async function countLecturerGroups(lecturerId: string, client: Queryable = pool): Promise<number> {
  const row = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM teaching_groups WHERE lecturer_id = $1`, [lecturerId], client);
  return row?.n ?? 0;
}
