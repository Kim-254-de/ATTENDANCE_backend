import type { PoolClient } from 'pg';
import { query, type Queryable, pool } from '../../db/database.js';
import { compact } from './teaching.repository.js';

/**
 * All SQL for departments' exam papers, practicals and invigilators
 * (exams.service.ts, invigilation.service.ts). Every query is parameterised.
 * Like teaching, a term's exam data is read whole and worked out in memory.
 */

/** Who sits a paper: the unit's regular classes, or its ODEL and part-time ones. */
export type Sitting = 'regular' | 'odel';

export interface PaperRow {
  id: string;
  departmentId: string;
  /** compact(departments.code). */
  departmentCode: string;
  title: string;
  sitting: Sitting;
  examinerId: string | null;
  notes: string;
  publishedSignature: string | null;
  unitIds: string[];
  /** A listed paper's codes as uploaded ("BITE 131", "COSC 130"); empty for one built from units. */
  codes: string[];
  /** A listed paper's class rows and students (from SMARTTT, or set by the department). */
  rows: ListedRow[];
}

export interface ListedRow {
  id: string;
  programme: string;
  year: number;
  semester: number;
  stream: string;
  students: number;
  /** SMARTTT's count when last read; null for a row the department added. */
  smartttStudents: number | null;
  /** The department set the number (or added the row): a fresh SMARTTT count leaves it. */
  edited: boolean;
}

export type ListedRowValues = Omit<ListedRow, 'id'>;

export interface PracticalRow {
  id: string;
  departmentId: string;
  unitId: string;
  /** 'YYYY-MM-DD'. */
  date: string;
  /** 'HH:MM'. */
  startTime: string;
  endTime: string;
}

export interface InvigilationRow {
  id: string;
  paperId: string;
  room: string;
  lecturerId: string;
}

export interface ExamData {
  papers: PaperRow[];
  /** Units marked as having no written exam. */
  noWrittenExam: Set<string>;
  practicals: PracticalRow[];
  invigilations: InvigilationRow[];
}

export async function loadExams(termId: string, client: Queryable = pool): Promise<ExamData> {
  const papers = await query<{
    id: string; department_id: string; department_code: string | null; title: string; sitting: Sitting; examiner_id: string | null;
    notes: string; published_signature: string | null; unit_ids: string[] | null; codes: string[] | null;
  }>(
    `SELECT p.id, p.department_id, d.code AS department_code, p.title, p.sitting, p.examiner_id, p.notes, p.published_signature,
            ARRAY(SELECT pu.unit_id::text FROM teaching_exam_paper_units pu WHERE pu.paper_id = p.id) AS unit_ids, p.codes
       FROM teaching_exam_papers p JOIN departments d ON d.id = p.department_id
      WHERE p.generator_term_id = $1`,
    [termId],
    client,
  );
  const listed = await query<{
    id: string; paper_id: string; programme: string; year: number; semester: number; stream: string; students: number;
    smarttt_students: number | null; edited: boolean;
  }>(
    `SELECT r.id, r.paper_id, r.programme, r.year, r.semester, r.stream, r.students, r.smarttt_students, r.edited
       FROM teaching_exam_paper_rows r JOIN teaching_exam_papers p ON p.id = r.paper_id
      WHERE p.generator_term_id = $1
      ORDER BY r.programme, r.year, r.semester, r.stream`,
    [termId],
    client,
  );
  const rowsOf = new Map<string, ListedRow[]>();
  for (const r of listed.rows) {
    const list = rowsOf.get(r.paper_id) ?? [];
    list.push({
      id: r.id, programme: r.programme, year: r.year, semester: r.semester, stream: r.stream, students: r.students,
      smartttStudents: r.smarttt_students, edited: r.edited,
    });
    rowsOf.set(r.paper_id, list);
  }
  const marked = await query<{ unit_id: string }>(
    `SELECT n.unit_id FROM teaching_no_written_exams n JOIN teaching_units u ON u.id = n.unit_id WHERE u.generator_term_id = $1`,
    [termId],
    client,
  );
  const practicals = await query<{ id: string; department_id: string; unit_id: string; date: string; start_time: string; end_time: string }>(
    `SELECT id, department_id, unit_id, to_char(date, 'YYYY-MM-DD') AS date,
            to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time
       FROM teaching_practicals WHERE generator_term_id = $1
      ORDER BY date, start_time`,
    [termId],
    client,
  );
  const invigilations = await query<{ id: string; paper_id: string; room: string; lecturer_id: string }>(
    `SELECT i.id, i.paper_id, i.room, i.lecturer_id FROM teaching_invigilations i
       JOIN teaching_exam_papers p ON p.id = i.paper_id WHERE p.generator_term_id = $1`,
    [termId],
    client,
  );
  return {
    papers: papers.rows.map((p) => ({
      id: p.id,
      departmentId: p.department_id,
      departmentCode: compact(p.department_code),
      title: p.title,
      sitting: p.sitting,
      examinerId: p.examiner_id,
      notes: p.notes,
      publishedSignature: p.published_signature,
      unitIds: p.unit_ids ?? [],
      codes: p.codes ?? [],
      rows: rowsOf.get(p.id) ?? [],
    })),
    noWrittenExam: new Set(marked.rows.map((r) => r.unit_id)),
    practicals: practicals.rows.map((r) => ({
      id: r.id, departmentId: r.department_id, unitId: r.unit_id, date: r.date, startTime: r.start_time, endTime: r.end_time,
    })),
    invigilations: invigilations.rows.map((r) => ({ id: r.id, paperId: r.paper_id, room: r.room, lecturerId: r.lecturer_id })),
  };
}

// -- papers --------------------------------------------------------------------------------------

export interface PaperValues {
  title: string;
  sitting: Sitting;
  examinerId: string | null;
  notes: string;
  unitIds: string[];
}

export async function insertPaper(client: PoolClient, termId: string, departmentId: string, v: PaperValues): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO teaching_exam_papers (generator_term_id, department_id, title, sitting, examiner_id, notes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [termId, departmentId, v.title, v.sitting, v.examinerId, v.notes],
  );
  const id = rows[0]!.id;
  await setPaperUnits(client, id, v.unitIds, v.sitting);
  return id;
}

export async function updatePaper(client: PoolClient, paperId: string, v: PaperValues): Promise<void> {
  await client.query(
    `UPDATE teaching_exam_papers SET title = $2, sitting = $3, examiner_id = $4, notes = $5 WHERE id = $1`,
    [paperId, v.title, v.sitting, v.examinerId, v.notes],
  );
  await setPaperUnits(client, paperId, v.unitIds, v.sitting);
}

async function setPaperUnits(client: PoolClient, paperId: string, unitIds: string[], sitting: Sitting): Promise<void> {
  await client.query(`DELETE FROM teaching_exam_paper_units WHERE paper_id = $1 AND NOT (unit_id = ANY($2::uuid[]))`, [paperId, unitIds]);
  await client.query(`UPDATE teaching_exam_paper_units SET sitting = $2 WHERE paper_id = $1`, [paperId, sitting]);
  await client.query(
    `INSERT INTO teaching_exam_paper_units (paper_id, unit_id, sitting) SELECT $1, u, $3 FROM unnest($2::uuid[]) AS u
     ON CONFLICT (paper_id, unit_id) DO NOTHING`,
    [paperId, unitIds, sitting],
  );
}

// -- listed papers (uploaded as the department's exam list) ---------------------------------------

export interface ListedPaperValues {
  codes: string[];
  title: string;
  sitting: Sitting;
  examinerId: string | null;
  notes: string;
}

export async function insertListedPaper(client: PoolClient, termId: string, departmentId: string, v: ListedPaperValues): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO teaching_exam_papers (generator_term_id, department_id, title, sitting, examiner_id, notes, codes)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [termId, departmentId, v.title, v.sitting, v.examinerId, v.notes, v.codes],
  );
  return rows[0]!.id;
}

export async function updateListedPaper(client: PoolClient, paperId: string, v: ListedPaperValues): Promise<void> {
  await client.query(
    `UPDATE teaching_exam_papers SET codes = $2, title = $3, sitting = $4, examiner_id = $5, notes = $6 WHERE id = $1`,
    [paperId, v.codes, v.title, v.sitting, v.examinerId, v.notes],
  );
}

/** The listed paper's class rows, all at once: rows not given are removed. */
export async function setListedRows(client: PoolClient, paperId: string, rows: ListedRowValues[]): Promise<void> {
  await client.query(`DELETE FROM teaching_exam_paper_rows WHERE paper_id = $1`, [paperId]);
  if (rows.length === 0) return;
  await client.query(
    `INSERT INTO teaching_exam_paper_rows (paper_id, programme, year, semester, stream, students, smarttt_students, edited)
     SELECT $1, * FROM unnest($2::text[], $3::smallint[], $4::smallint[], $5::text[], $6::int[], $7::int[], $8::bool[])`,
    [
      paperId,
      rows.map((r) => r.programme),
      rows.map((r) => r.year),
      rows.map((r) => r.semester),
      rows.map((r) => r.stream),
      rows.map((r) => r.students),
      rows.map((r) => r.smartttStudents),
      rows.map((r) => r.edited),
    ],
  );
}

export async function deletePaper(client: PoolClient, paperId: string): Promise<void> {
  await client.query(`DELETE FROM teaching_exam_papers WHERE id = $1`, [paperId]);
}

export async function setNoWrittenExam(client: PoolClient, unitId: string, value: boolean): Promise<void> {
  if (value) await client.query(`INSERT INTO teaching_no_written_exams (unit_id) VALUES ($1) ON CONFLICT DO NOTHING`, [unitId]);
  else await client.query(`DELETE FROM teaching_no_written_exams WHERE unit_id = $1`, [unitId]);
}

export async function setPaperSignatures(client: PoolClient, signatures: Array<{ paperId: string; signature: string }>): Promise<void> {
  if (signatures.length === 0) return;
  await client.query(
    `UPDATE teaching_exam_papers p SET published_signature = s.signature
       FROM unnest($1::uuid[], $2::text[]) AS s(id, signature) WHERE p.id = s.id`,
    [signatures.map((s) => s.paperId), signatures.map((s) => s.signature)],
  );
}

// -- practicals ----------------------------------------------------------------------------------

export interface PracticalValues {
  unitId: string;
  date: string;
  startTime: string;
  endTime: string;
}

export async function insertPractical(client: PoolClient, termId: string, departmentId: string, v: PracticalValues): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO teaching_practicals (generator_term_id, department_id, unit_id, date, start_time, end_time)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [termId, departmentId, v.unitId, v.date, v.startTime, v.endTime],
  );
  return rows[0]!.id;
}

export async function updatePractical(client: PoolClient, practicalId: string, v: PracticalValues): Promise<void> {
  await client.query(
    `UPDATE teaching_practicals SET unit_id = $2, date = $3, start_time = $4, end_time = $5 WHERE id = $1`,
    [practicalId, v.unitId, v.date, v.startTime, v.endTime],
  );
}

export async function deletePractical(client: PoolClient, practicalId: string): Promise<void> {
  await client.query(`DELETE FROM teaching_practicals WHERE id = $1`, [practicalId]);
}

// -- invigilators --------------------------------------------------------------------------------

export async function setInvigilation(client: PoolClient, paperId: string, room: string, lecturerId: string, enteredBy: string): Promise<void> {
  await client.query(
    `INSERT INTO teaching_invigilations (paper_id, room, lecturer_id, entered_by_name) VALUES ($1, $2, $3, $4)
     ON CONFLICT (paper_id, room) DO UPDATE SET lecturer_id = EXCLUDED.lecturer_id, entered_by_name = EXCLUDED.entered_by_name`,
    [paperId, room, lecturerId, enteredBy],
  );
}

export async function clearInvigilation(client: PoolClient, paperId: string, room: string): Promise<void> {
  await client.query(`DELETE FROM teaching_invigilations WHERE paper_id = $1 AND room = $2`, [paperId, room]);
}
