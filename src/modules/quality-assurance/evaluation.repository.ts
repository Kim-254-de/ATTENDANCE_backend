import type { PoolClient } from 'pg';
import { query, queryOne, transaction } from '../../db/database.js';

/**
 * All SQL for student course evaluations. Every value is parameterised.
 *
 * Anonymity is structural (`db/migrations/035_qa_course_evaluations.sql`):
 * `qa_evaluation_submissions` knows who has evaluated a unit, the response
 * tables know what was said, and nothing here ever joins the two. Keep it
 * that way: no query in this file may read a submission and a response
 * together, and comments are returned in alphabetical order, never in the
 * order they were written.
 */

export type QuestionKind = 'RATING' | 'TEXT';

export interface QuestionInput {
  prompt: string;
  kind: QuestionKind;
  required: boolean;
}

export interface QuestionRow {
  id: string;
  position: number;
  prompt: string;
  kind: QuestionKind;
  required: boolean;
}

export interface RoundRow {
  id: string;
  title: string;
  instructions: string | null;
  opensAt: Date;
  closesAt: Date;
  minResponses: number;
  createdAt: Date;
  questionCount: number;
  responseCount: number;
}

interface RoundDbRow {
  id: string;
  title: string;
  instructions: string | null;
  opens_at: Date;
  closes_at: Date;
  min_responses: number;
  created_at: Date;
  question_count: number;
  response_count: number;
}

const ROUND_SELECT = `
  SELECT ro.id, ro.title, ro.instructions, ro.opens_at, ro.closes_at, ro.min_responses, ro.created_at,
         (SELECT COUNT(*) FROM qa_evaluation_questions q WHERE q.round_id = ro.id)::int AS question_count,
         (SELECT COUNT(*) FROM qa_evaluation_responses r WHERE r.round_id = ro.id)::int AS response_count
    FROM qa_evaluation_rounds ro`;

const toRound = (r: RoundDbRow): RoundRow => ({
  id: r.id,
  title: r.title,
  instructions: r.instructions,
  opensAt: r.opens_at,
  closesAt: r.closes_at,
  minResponses: r.min_responses,
  createdAt: r.created_at,
  questionCount: r.question_count,
  responseCount: r.response_count,
});

/** Every round, newest window first. `openOnly` keeps those open now; `startedOnly` drops ones not yet open. */
export async function listRounds(options: { openOnly?: boolean; startedOnly?: boolean } = {}): Promise<RoundRow[]> {
  const { rows } = await query<RoundDbRow>(
    `${ROUND_SELECT}
      WHERE (NOT $1::boolean OR (ro.opens_at <= NOW() AND ro.closes_at > NOW()))
        AND (NOT $2::boolean OR ro.opens_at <= NOW())
      ORDER BY ro.opens_at DESC, ro.title`,
    [options.openOnly ?? false, options.startedOnly ?? false],
  );
  return rows.map(toRound);
}

export async function findRound(roundId: string): Promise<RoundRow | null> {
  const row = await queryOne<RoundDbRow>(`${ROUND_SELECT} WHERE ro.id = $1`, [roundId]);
  return row ? toRound(row) : null;
}

export async function listQuestions(roundId: string): Promise<QuestionRow[]> {
  const { rows } = await query<QuestionRow>(
    `SELECT id, position, prompt, kind, required FROM qa_evaluation_questions WHERE round_id = $1 ORDER BY position`,
    [roundId],
  );
  return rows;
}

async function insertQuestions(client: PoolClient, roundId: string, questions: QuestionInput[]): Promise<void> {
  for (const [index, q] of questions.entries()) {
    await query(
      `INSERT INTO qa_evaluation_questions (round_id, position, prompt, kind, required) VALUES ($1, $2, $3, $4, $5)`,
      [roundId, index + 1, q.prompt, q.kind, q.required],
      client,
    );
  }
}

export async function createRound(
  input: { title: string; instructions: string | null; opensAt: Date; closesAt: Date; minResponses: number },
  questions: QuestionInput[],
  createdByUserId: string,
): Promise<string> {
  return transaction(async (client) => {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO qa_evaluation_rounds (title, instructions, opens_at, closes_at, min_responses, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [input.title, input.instructions, input.opensAt, input.closesAt, input.minResponses, createdByUserId],
      client,
    );
    if (!row) throw new Error('qa_evaluation_rounds insert returned no row');
    await insertQuestions(client, row.id, questions);
    return row.id;
  });
}

/**
 * Updates a round's details, and replaces its questions when `questions` is
 * given. The service has already checked that nobody has answered yet; the
 * submissions count is re-checked here under a row lock so a student
 * submitting at the same moment cannot answer questions that then vanish.
 */
export async function updateRound(
  roundId: string,
  input: { title?: string; instructions?: string | null; opensAt?: Date; closesAt?: Date; minResponses?: number },
  questions?: QuestionInput[],
): Promise<'OK' | 'ANSWERED'> {
  return transaction(async (client) => {
    await query(`SELECT 1 FROM qa_evaluation_rounds WHERE id = $1 FOR UPDATE`, [roundId], client);
    if (questions) {
      const answered = await queryOne<{ found: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM qa_evaluation_submissions WHERE round_id = $1) AS found`,
        [roundId],
        client,
      );
      if (answered?.found) return 'ANSWERED';
      await query(`DELETE FROM qa_evaluation_questions WHERE round_id = $1`, [roundId], client);
      await insertQuestions(client, roundId, questions);
    }
    await query(
      `UPDATE qa_evaluation_rounds
          SET title = COALESCE($2, title),
              instructions = CASE WHEN $3::boolean THEN $4 ELSE instructions END,
              opens_at = COALESCE($5, opens_at),
              closes_at = COALESCE($6, closes_at),
              min_responses = COALESCE($7, min_responses)
        WHERE id = $1`,
      [
        roundId,
        input.title ?? null,
        input.instructions !== undefined,
        input.instructions ?? null,
        input.opensAt ?? null,
        input.closesAt ?? null,
        input.minResponses ?? null,
      ],
      client,
    );
    return 'OK';
  });
}

/** Ends an open round now. A round that has not opened yet is closed as well, with its window collapsed to the past. */
export async function closeRound(roundId: string): Promise<void> {
  await query(
    `UPDATE qa_evaluation_rounds
        SET opens_at = LEAST(opens_at, NOW() - INTERVAL '1 second'), closes_at = NOW()
      WHERE id = $1 AND closes_at > NOW()`,
    [roundId],
  );
}

export async function countSubmissions(roundId: string): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM qa_evaluation_submissions WHERE round_id = $1`,
    [roundId],
  );
  return row?.count ?? 0;
}

export async function deleteRound(roundId: string): Promise<void> {
  await query(`DELETE FROM qa_evaluation_rounds WHERE id = $1`, [roundId]);
}

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

export interface StudentEvaluationUnitRow {
  round_id: string;
  unit_id: string;
  unit_code: string;
  unit_name: string | null;
  lecturer_name: string;
  submitted: boolean;
}

/** For each open round, the units the student is actively on and whether they have evaluated each yet. */
export async function listStudentUnitsForOpenRounds(studentUserId: string): Promise<StudentEvaluationUnitRow[]> {
  const { rows } = await query<StudentEvaluationUnitRow>(
    `SELECT ro.id AS round_id, u.id AS unit_id, u.code AS unit_code, u.name AS unit_name, lu.full_name AS lecturer_name,
            EXISTS (SELECT 1 FROM qa_evaluation_submissions sb
                     WHERE sb.round_id = ro.id AND sb.unit_id = u.id AND sb.student_user_id = $1) AS submitted
       FROM qa_evaluation_rounds ro
       JOIN unit_allocations a ON a.student_user_id = $1 AND a.status = 'ACTIVE'
       JOIN units u  ON u.id = a.unit_id
       JOIN users lu ON lu.id = u.lecturer_user_id
      WHERE ro.opens_at <= NOW() AND ro.closes_at > NOW()
      ORDER BY ro.closes_at, u.code`,
    [studentUserId],
  );
  return rows;
}

export async function isStudentOnUnit(studentUserId: string, unitId: string): Promise<boolean> {
  const row = await queryOne<{ found: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM unit_allocations WHERE student_user_id = $1 AND unit_id = $2 AND status = 'ACTIVE'
     ) AS found`,
    [studentUserId, unitId],
  );
  return row?.found ?? false;
}

export interface AnswerInput {
  questionId: string;
  rating: number | null;
  text: string | null;
}

/**
 * Records one student's evaluation of one unit. The submission row and the
 * anonymous response are written in one transaction, so a response can never
 * exist without its submission (which is what stops a second one) and the
 * submission's primary key turns a double submit into a unique violation.
 * The round row is share-locked so its questions cannot be replaced mid-submit.
 */
export async function submit(
  roundId: string,
  unitId: string,
  studentUserId: string,
  answers: AnswerInput[],
): Promise<'OK' | 'CLOSED'> {
  return transaction(async (client) => {
    const open = await queryOne<{ id: string }>(
      `SELECT id FROM qa_evaluation_rounds WHERE id = $1 AND opens_at <= NOW() AND closes_at > NOW() FOR SHARE`,
      [roundId],
      client,
    );
    if (!open) return 'CLOSED';
    await query(
      `INSERT INTO qa_evaluation_submissions (round_id, unit_id, student_user_id) VALUES ($1, $2, $3)`,
      [roundId, unitId, studentUserId],
      client,
    );
    const response = await queryOne<{ id: string }>(
      `INSERT INTO qa_evaluation_responses (round_id, unit_id, lecturer_user_id, department_id)
       SELECT $1, u.id, u.lecturer_user_id, u.department_id FROM units u WHERE u.id = $2
       RETURNING id`,
      [roundId, unitId],
      client,
    );
    if (!response) throw new Error('unit vanished while submitting an evaluation');
    for (const a of answers) {
      await query(
        `INSERT INTO qa_evaluation_answers (response_id, question_id, rating, text_answer) VALUES ($1, $2, $3, $4)`,
        [response.id, a.questionId, a.rating, a.text],
        client,
      );
    }
    return 'OK';
  });
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * Which responses a reader may see: one department (department officer),
 * or everything, optionally narrowed to a department (QA). Matched on the department that owned the unit when the
 * student answered.
 */
export interface ResultScope {
  departmentId?: string;
}

const SCOPE_FILTER = `
  AND ($2::uuid IS NULL OR r.department_id = $2)`;

const scopeParams = (roundId: string, scope: ResultScope): unknown[] => [
  roundId,
  scope.departmentId ?? null,
];

export interface UnitResultRow {
  unit_id: string;
  unit_code: string;
  unit_name: string | null;
  lecturer_user_id: string | null;
  lecturer_name: string | null;
  department_id: string | null;
  department_name: string | null;
  responses: number;
  /** Students actively on the unit now, with an account (only they can answer). */
  enrolled: number;
}

/** One row per (unit, lecturer who taught it when answered) with at least one response in scope. */
export async function listUnitResults(roundId: string, scope: ResultScope): Promise<UnitResultRow[]> {
  const { rows } = await query<UnitResultRow>(
    `SELECT u.id AS unit_id, u.code AS unit_code, u.name AS unit_name,
            r.lecturer_user_id, lu.full_name AS lecturer_name,
            d.id AS department_id, d.name AS department_name,
            COUNT(*)::int AS responses,
            (SELECT COUNT(*) FROM unit_allocations a
              WHERE a.unit_id = u.id AND a.status = 'ACTIVE' AND a.student_user_id IS NOT NULL)::int AS enrolled
       FROM qa_evaluation_responses r
       JOIN units u ON u.id = r.unit_id
  LEFT JOIN users lu ON lu.id = r.lecturer_user_id
  LEFT JOIN departments d ON d.id = r.department_id
      WHERE r.round_id = $1 ${SCOPE_FILTER}
      GROUP BY u.id, u.code, u.name, r.lecturer_user_id, lu.full_name, d.id, d.name
      ORDER BY d.name NULLS LAST, u.code`,
    scopeParams(roundId, scope),
  );
  return rows;
}

export interface RatingResultRow {
  unit_id: string;
  lecturer_user_id: string | null;
  question_id: string;
  answered: number;
  average: number;
  r1: number;
  r2: number;
  r3: number;
  r4: number;
  r5: number;
}

export async function listRatingResults(roundId: string, scope: ResultScope): Promise<RatingResultRow[]> {
  const { rows } = await query<RatingResultRow>(
    `SELECT r.unit_id, r.lecturer_user_id, an.question_id,
            COUNT(*)::int AS answered,
            AVG(an.rating)::float8 AS average,
            COUNT(*) FILTER (WHERE an.rating = 1)::int AS r1,
            COUNT(*) FILTER (WHERE an.rating = 2)::int AS r2,
            COUNT(*) FILTER (WHERE an.rating = 3)::int AS r3,
            COUNT(*) FILTER (WHERE an.rating = 4)::int AS r4,
            COUNT(*) FILTER (WHERE an.rating = 5)::int AS r5
       FROM qa_evaluation_answers an
       JOIN qa_evaluation_responses r ON r.id = an.response_id
      WHERE r.round_id = $1 AND an.rating IS NOT NULL ${SCOPE_FILTER}
      GROUP BY r.unit_id, r.lecturer_user_id, an.question_id`,
    scopeParams(roundId, scope),
  );
  return rows;
}

export interface CommentRow {
  unit_id: string;
  lecturer_user_id: string | null;
  question_id: string;
  text_answer: string;
}

/** Free-text answers, alphabetical — never in the order written, which could be matched to who submitted when. */
export async function listComments(roundId: string, scope: ResultScope): Promise<CommentRow[]> {
  const { rows } = await query<CommentRow>(
    `SELECT r.unit_id, r.lecturer_user_id, an.question_id, an.text_answer
       FROM qa_evaluation_answers an
       JOIN qa_evaluation_responses r ON r.id = an.response_id
      WHERE r.round_id = $1 AND an.text_answer IS NOT NULL ${SCOPE_FILTER}
      ORDER BY an.text_answer`,
    scopeParams(roundId, scope),
  );
  return rows;
}
