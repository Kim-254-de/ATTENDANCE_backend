import { AppError } from '../../common/errors/index.js';
import { isUniqueViolation } from '../../db/database.js';
import * as evaluationRepository from './evaluation.repository.js';
import type { CreateRoundInput, SubmitEvaluationInput, UpdateRoundInput } from './evaluation.schema.js';

/**
 * Student course evaluations: the QA directorate's other core activity next
 * to audits. QA opens a round (questions plus a window); students rate each
 * unit they are on, once; QA sees every result, a faculty officer its
 * faculty's, a department officer its department's.
 *
 * Two anonymity rules hold everywhere here:
 * - A unit's results (ratings and comments) are hidden until it has the
 *   round's `minResponses` responses, so a class of two cannot be read off.
 * - Nothing returned to anyone links a response to a student.
 */

export type RoundStatus = 'UPCOMING' | 'OPEN' | 'CLOSED';

const statusOf = (round: { opensAt: Date; closesAt: Date }, now = new Date()): RoundStatus =>
  now < round.opensAt ? 'UPCOMING' : now < round.closesAt ? 'OPEN' : 'CLOSED';

export interface RoundDto {
  id: string;
  title: string;
  instructions: string | null;
  opensAt: string;
  closesAt: string;
  status: RoundStatus;
  minResponses: number;
  questionCount: number;
  responseCount: number;
  createdAt: string;
}

const toRoundDto = (r: evaluationRepository.RoundRow): RoundDto => ({
  id: r.id,
  title: r.title,
  instructions: r.instructions,
  opensAt: r.opensAt.toISOString(),
  closesAt: r.closesAt.toISOString(),
  status: statusOf(r),
  minResponses: r.minResponses,
  questionCount: r.questionCount,
  responseCount: r.responseCount,
  createdAt: r.createdAt.toISOString(),
});

export interface RoundDetailDto extends RoundDto {
  questions: evaluationRepository.QuestionRow[];
  /** False once any student has answered: the questions are then fixed. */
  questionsEditable: boolean;
}

/** Default minimum responses before a unit's results are shown. */
const DEFAULT_MIN_RESPONSES = 3;

/** GET /quality-assurance/evaluations */
export async function listRounds(): Promise<RoundDto[]> {
  return (await evaluationRepository.listRounds()).map(toRoundDto);
}

/** Rounds an officer may read results of: any that has opened. */
export async function listStartedRounds(): Promise<RoundDto[]> {
  return (await evaluationRepository.listRounds({ startedOnly: true })).map(toRoundDto);
}

async function requireRound(roundId: string): Promise<evaluationRepository.RoundRow> {
  const round = await evaluationRepository.findRound(roundId);
  if (!round) throw AppError.notFound('No such evaluation round.');
  return round;
}

/** GET /quality-assurance/evaluations/:id */
export async function getRound(roundId: string): Promise<RoundDetailDto> {
  const round = await requireRound(roundId);
  const [questions, submissions] = await Promise.all([
    evaluationRepository.listQuestions(roundId),
    evaluationRepository.countSubmissions(roundId),
  ]);
  return { ...toRoundDto(round), questions, questionsEditable: submissions === 0 };
}

/** POST /quality-assurance/evaluations */
export async function createRound(input: CreateRoundInput, userId: string): Promise<RoundDetailDto> {
  const id = await evaluationRepository.createRound(
    {
      title: input.title,
      instructions: input.instructions || null,
      opensAt: input.opensAt,
      closesAt: input.closesAt,
      minResponses: input.minResponses ?? DEFAULT_MIN_RESPONSES,
    },
    input.questions,
    userId,
  );
  return getRound(id);
}

/**
 * PATCH /quality-assurance/evaluations/:id
 *
 * Details may change at any time (extending a window is normal). Questions
 * may only be replaced while nobody has answered, since changing a question
 * would change what earlier answers mean.
 */
export async function updateRound(roundId: string, input: UpdateRoundInput): Promise<RoundDetailDto> {
  const round = await requireRound(roundId);
  const opensAt = input.opensAt ?? round.opensAt;
  const closesAt = input.closesAt ?? round.closesAt;
  if (closesAt <= opensAt) throw AppError.badRequest('The round must close after it opens.');
  const result = await evaluationRepository.updateRound(
    roundId,
    {
      title: input.title,
      instructions: input.instructions === undefined ? undefined : input.instructions || null,
      opensAt: input.opensAt,
      closesAt: input.closesAt,
      minResponses: input.minResponses,
    },
    input.questions,
  );
  if (result === 'ANSWERED') {
    throw AppError.conflict('Students have already answered this round, so its questions can no longer change.');
  }
  return getRound(roundId);
}

/** POST /quality-assurance/evaluations/:id/close */
export async function closeRound(roundId: string): Promise<RoundDetailDto> {
  await requireRound(roundId);
  await evaluationRepository.closeRound(roundId);
  return getRound(roundId);
}

/** DELETE /quality-assurance/evaluations/:id — only before anyone has answered; afterwards close it instead. */
export async function deleteRound(roundId: string): Promise<void> {
  await requireRound(roundId);
  if ((await evaluationRepository.countSubmissions(roundId)) > 0) {
    throw AppError.conflict('Students have already answered this round. Close it instead of deleting it.');
  }
  await evaluationRepository.deleteRound(roundId);
}

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

export interface StudentRoundDto {
  id: string;
  title: string;
  instructions: string | null;
  closesAt: string;
  questions: evaluationRepository.QuestionRow[];
  units: Array<{ unitId: string; unitCode: string; unitName: string | null; lecturerName: string; submitted: boolean }>;
}

/** GET /students/me/evaluations — open rounds, each with the student's units and which are done. */
export async function listForStudent(studentUserId: string): Promise<StudentRoundDto[]> {
  const [rounds, units] = await Promise.all([
    evaluationRepository.listRounds({ openOnly: true }),
    evaluationRepository.listStudentUnitsForOpenRounds(studentUserId),
  ]);
  const result: StudentRoundDto[] = [];
  for (const round of rounds) {
    const mine = units.filter((u) => u.round_id === round.id);
    if (mine.length === 0) continue;
    result.push({
      id: round.id,
      title: round.title,
      instructions: round.instructions,
      closesAt: round.closesAt.toISOString(),
      questions: await evaluationRepository.listQuestions(round.id),
      units: mine.map((u) => ({
        unitId: u.unit_id,
        unitCode: u.unit_code,
        unitName: u.unit_name,
        lecturerName: u.lecturer_name,
        submitted: u.submitted,
      })),
    });
  }
  return result;
}

/**
 * POST /students/me/evaluations/:roundId/units/:unitId
 *
 * Every required question must be answered, ratings only for rating questions
 * and text only for text ones. An empty optional comment is dropped rather
 * than stored. 404 for a round or unit the student cannot evaluate; 409 when
 * they already have.
 */
export async function submitForStudent(
  studentUserId: string,
  roundId: string,
  unitId: string,
  input: SubmitEvaluationInput,
): Promise<void> {
  const round = await evaluationRepository.findRound(roundId);
  if (!round || statusOf(round) !== 'OPEN') throw AppError.notFound('This evaluation is not open.');
  if (!(await evaluationRepository.isStudentOnUnit(studentUserId, unitId))) {
    throw AppError.notFound('You are not on that unit.');
  }

  const questions = await evaluationRepository.listQuestions(roundId);
  const byId = new Map(questions.map((q) => [q.id, q]));
  const answers: evaluationRepository.AnswerInput[] = [];
  const seen = new Set<string>();
  for (const a of input.answers) {
    const question = byId.get(a.questionId);
    if (!question) throw AppError.badRequest('An answer names a question that is not in this evaluation.');
    if (seen.has(a.questionId)) throw AppError.badRequest('A question is answered twice.');
    seen.add(a.questionId);
    if (question.kind === 'RATING') {
      if (a.text !== undefined || a.rating === undefined) {
        throw AppError.badRequest(`"${question.prompt}" needs a rating from 1 to 5.`);
      }
      answers.push({ questionId: a.questionId, rating: a.rating, text: null });
    } else {
      if (a.rating !== undefined) throw AppError.badRequest(`"${question.prompt}" takes a written answer.`);
      if (a.text) answers.push({ questionId: a.questionId, rating: null, text: a.text });
    }
  }
  const answered = new Set(answers.map((a) => a.questionId));
  const missing = questions.find((q) => q.required && !answered.has(q.id));
  if (missing) throw AppError.badRequest(`Please answer "${missing.prompt}".`);

  try {
    const result = await evaluationRepository.submit(roundId, unitId, studentUserId, answers);
    if (result === 'CLOSED') throw AppError.notFound('This evaluation is not open.');
  } catch (error) {
    if (isUniqueViolation(error)) throw AppError.conflict('You have already evaluated this unit in this round.');
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface QuestionResultDto {
  questionId: string;
  answered: number;
  /** 1–5 to two decimals. */
  average: number;
  /** Counts of 1s, 2s, 3s, 4s and 5s. */
  distribution: [number, number, number, number, number];
}

export interface UnitResultDto {
  unitId: string;
  unitCode: string;
  unitName: string | null;
  lecturerName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  responses: number;
  enrolled: number;
  /** 0–100, one decimal; null when nobody is enrolled now. */
  responseRate: number | null;
  /** False below the round's minResponses: ratings and comments are then withheld. */
  reportable: boolean;
  ratings: QuestionResultDto[];
  comments: Array<{ questionId: string; text: string }>;
}

export interface RoundResultsDto {
  round: RoundDetailDto;
  totalResponses: number;
  /** Across every unit in scope; empty while the scope as a whole is below minResponses. */
  overall: QuestionResultDto[];
  units: UnitResultDto[];
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

function combine(rows: evaluationRepository.RatingResultRow[]): QuestionResultDto[] {
  const byQuestion = new Map<string, { answered: number; sum: number; d: [number, number, number, number, number] }>();
  for (const r of rows) {
    const acc = byQuestion.get(r.question_id) ?? { answered: 0, sum: 0, d: [0, 0, 0, 0, 0] };
    acc.answered += r.answered;
    acc.sum += r.average * r.answered;
    acc.d = [acc.d[0] + r.r1, acc.d[1] + r.r2, acc.d[2] + r.r3, acc.d[3] + r.r4, acc.d[4] + r.r5];
    byQuestion.set(r.question_id, acc);
  }
  return [...byQuestion.entries()].map(([questionId, acc]) => ({
    questionId,
    answered: acc.answered,
    average: round2(acc.sum / acc.answered),
    distribution: acc.d,
  }));
}

/**
 * Results of one round within a scope. The callers resolve the scope from
 * the signed-in officer (department, faculty) or the QA officer's filters.
 * A round that has not opened has nothing to show and is reported as not found
 * to officers outside QA, so they cannot see QA's drafts.
 */
export async function getResults(
  roundId: string,
  scope: evaluationRepository.ResultScope,
  options: { allowUnstarted?: boolean } = {},
): Promise<RoundResultsDto> {
  const detail = await getRound(roundId);
  if (!options.allowUnstarted && detail.status === 'UPCOMING') throw AppError.notFound('No such evaluation round.');

  const [units, ratings, comments] = await Promise.all([
    evaluationRepository.listUnitResults(roundId, scope),
    evaluationRepository.listRatingResults(roundId, scope),
    evaluationRepository.listComments(roundId, scope),
  ]);
  const key = (unitId: string, lecturerId: string | null) => `${unitId}:${lecturerId ?? ''}`;
  const order = new Map(detail.questions.map((q) => [q.id, q.position]));
  const byPosition = (a: { questionId: string }, b: { questionId: string }) =>
    (order.get(a.questionId) ?? 0) - (order.get(b.questionId) ?? 0);

  const totalResponses = units.reduce((n, u) => n + u.responses, 0);
  return {
    round: detail,
    totalResponses,
    overall: totalResponses >= detail.minResponses ? combine(ratings).sort(byPosition) : [],
    units: units.map((u) => {
      const reportable = u.responses >= detail.minResponses;
      const k = key(u.unit_id, u.lecturer_user_id);
      return {
        unitId: u.unit_id,
        unitCode: u.unit_code,
        unitName: u.unit_name,
        lecturerName: u.lecturer_name,
        departmentId: u.department_id,
        departmentName: u.department_name,
        responses: u.responses,
        enrolled: u.enrolled,
        responseRate: u.enrolled > 0 ? Math.round((u.responses / u.enrolled) * 1000) / 10 : null,
        reportable,
        ratings: reportable
          ? combine(ratings.filter((r) => key(r.unit_id, r.lecturer_user_id) === k)).sort(byPosition)
          : [],
        comments: reportable
          ? comments
              .filter((c) => key(c.unit_id, c.lecturer_user_id) === k)
              .map((c) => ({ questionId: c.question_id, text: c.text_answer }))
          : [],
      };
    }),
  };
}
