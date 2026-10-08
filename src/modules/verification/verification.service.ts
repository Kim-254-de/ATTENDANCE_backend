import { AppError, ErrorCode } from '../../common/errors/index.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { attendanceService } from '../attendance/index.js';
import { auditService } from '../audit/index.js';
import { sessionService } from '../session/index.js';
import * as faceClient from './face.client.js';
import type { EmbeddedFace } from './face.client.js';
import { bestMatch, minPairwiseSimilarity, roundScore, type Vector } from './face.match.js';
import { issueMatchToken, verifyMatchToken } from './face.token.js';
import * as verificationRepository from './verification.repository.js';
import type { StudentCard } from './verification.repository.js';

/**
 * Face check-in: QR's fallback, and QR is face's. See docs/face-recognition.md.
 *
 *   consent   - the student opts in from their own app
 *   enroll    - the lecturer photographs them from the unit's roster
 *   identify  - the lecturer's terminal photographs a student; the best match
 *               among the unit's enrolled students comes back with a signed,
 *               short-lived match token. Nothing is recorded.
 *   confirm   - the lecturer taps Confirm; the token is checked and the
 *               attendance module records the student as FACE.
 *
 * face-service only turns photos into templates. Which students may match,
 * the thresholds and the stored templates all live here.
 */

export type RequestContext = sessionService.RequestContext;

const UNAVAILABLE_MESSAGE = 'Face recognition is unavailable right now. Students can scan the QR code instead.';

// --- Student: consent -------------------------------------------------------

export interface MyFaceStatus {
  consentGiven: boolean;
  consentedAt: string | null;
  enrolled: boolean;
  enrolledAt: string | null;
}

export async function getMyFaceStatus(studentUserId: string): Promise<MyFaceStatus> {
  const status = await verificationRepository.findFaceStatus(studentUserId);
  return {
    consentGiven: status.consentedAt !== null,
    consentedAt: status.consentedAt?.toISOString() ?? null,
    enrolled: status.enrolledAt !== null,
    enrolledAt: status.enrolledAt?.toISOString() ?? null,
  };
}

export async function giveConsent(studentUserId: string, context: RequestContext): Promise<MyFaceStatus> {
  const before = await verificationRepository.findFaceStatus(studentUserId);
  await verificationRepository.giveConsent(studentUserId);
  if (before.consentedAt === null) {
    await auditService.record({ action: 'FACE_CONSENT_GIVEN', outcome: 'SUCCESS', userId: studentUserId, ...fingerprint(context) });
  }
  return getMyFaceStatus(studentUserId);
}

/** Withdraws consent and deletes the student's face templates. They can still check in by QR. */
export async function withdrawConsent(studentUserId: string, context: RequestContext): Promise<MyFaceStatus> {
  const before = await verificationRepository.findFaceStatus(studentUserId);
  const hadTemplates = await verificationRepository.withdrawConsent(studentUserId);
  if (before.consentedAt !== null || hadTemplates) {
    await auditService.record({
      action: 'FACE_CONSENT_WITHDRAWN',
      outcome: 'SUCCESS',
      userId: studentUserId,
      ...fingerprint(context),
      metadata: { templatesDeleted: hadTemplates },
    });
  }
  return getMyFaceStatus(studentUserId);
}

// --- Lecturer: enrollment ---------------------------------------------------

export interface EnrollmentResult {
  studentUserId: string;
  enrolledAt: string;
  /** True when this replaced an earlier enrollment. */
  replaced: boolean;
}

/**
 * Enrolls a student from photos taken on the lecturer's phone. The lecturer
 * must teach the unit, the student must be ACTIVE on it and have consented.
 * The photos must each show exactly one usable face, agree with each other,
 * and not match any other enrolled student (which would mean the wrong person
 * is in front of the camera, or one person is being enrolled twice).
 */
export async function enrollFace(
  unitId: string,
  studentUserId: string,
  lecturerUserId: string,
  images: string[],
  context: RequestContext,
): Promise<EnrollmentResult> {
  const target = await requireRosterStudent(unitId, studentUserId, lecturerUserId);
  if (!target.consentedAt) {
    throw new AppError(
      409,
      ErrorCode.FACE_CONSENT_REQUIRED,
      `${target.fullName ?? 'This student'} has not turned on face check-in in their app yet. Ask them to, then try again.`,
    );
  }

  const templates: Vector[] = [];
  let model: string | null = null;
  for (const [index, image] of images.entries()) {
    const embedded = await embedOrThrow(image, { photo: index + 1 });
    const face = usableFace(embedded, { allowOthersInFrame: false, photo: index + 1 });
    templates.push(face.embedding);
    model = embedded.model;
  }
  if (!model) throw new Error('enrollment produced no templates');

  const reject = async (reason: string, metadata: Record<string, unknown>) =>
    auditService.record({
      action: 'FACE_ENROLLMENT_REJECTED',
      outcome: 'FAILURE',
      userId: lecturerUserId,
      reason,
      ...fingerprint(context),
      metadata: { unitCode: target.unitCode, studentUserId, ...metadata },
    });

  const agreement = minPairwiseSimilarity(templates);
  if (agreement < env.FACE_MATCH_THRESHOLD) {
    await reject('PHOTOS_INCONSISTENT', { agreement: roundScore(agreement) });
    throw new AppError(
      422,
      ErrorCode.FACE_PHOTOS_INCONSISTENT,
      "The photos don't look like the same person. Retake all three, with only the student in frame.",
    );
  }

  // Any other student's best template against any of these photos.
  const others = await verificationRepository.findOtherEnrollments(studentUserId, model);
  for (const probe of templates) {
    const clash = bestMatch(probe, others, { threshold: env.FACE_MATCH_THRESHOLD, margin: 0 });
    if (clash.result === 'MATCH') {
      // The other student is named in the audit trail only: telling the
      // lecturer would reveal another student's enrollment.
      await reject('MATCHES_ANOTHER_STUDENT', { otherStudentUserId: clash.studentUserId, score: roundScore(clash.score) });
      throw new AppError(
        409,
        ErrorCode.FACE_MATCHES_ANOTHER_STUDENT,
        'This face is already registered to another student. Check the student ID card. If it is right, ask an administrator to look into it.',
      );
    }
  }

  const saved = await verificationRepository.upsertEnrollment({
    studentUserId,
    model,
    embeddings: templates,
    enrolledByUserId: lecturerUserId,
  });
  await auditService.record({
    action: 'FACE_ENROLLED',
    outcome: 'SUCCESS',
    userId: lecturerUserId,
    ...fingerprint(context),
    metadata: { unitCode: target.unitCode, studentUserId, model, photos: templates.length, replaced: saved.replaced, agreement: roundScore(agreement) },
  });
  return { studentUserId, enrolledAt: saved.enrolledAt.toISOString(), replaced: saved.replaced };
}

/** Removes a student's enrollment (e.g. a bad one, to redo it). Their consent stays. */
export async function removeEnrollment(
  unitId: string,
  studentUserId: string,
  lecturerUserId: string,
  context: RequestContext,
): Promise<{ removed: boolean }> {
  const target = await requireRosterStudent(unitId, studentUserId, lecturerUserId);
  const removed = await verificationRepository.deleteEnrollment(studentUserId);
  if (removed) {
    await auditService.record({
      action: 'FACE_ENROLLMENT_REMOVED',
      outcome: 'SUCCESS',
      userId: lecturerUserId,
      ...fingerprint(context),
      metadata: { unitCode: target.unitCode, studentUserId },
    });
  }
  return { removed };
}

// --- Lecturer: the terminal -------------------------------------------------

export type IdentifyResult =
  | {
      result: 'MATCH';
      student: StudentCard;
      score: number;
      /** Already recorded for this session (by QR or face). No token is issued. */
      alreadyCheckedIn: boolean;
      matchToken: string | null;
      expiresAt: string | null;
      facesInFrame: number;
      enrolledOnUnit: number;
    }
  | { result: 'NO_MATCH' | 'AMBIGUOUS'; facesInFrame: number; enrolledOnUnit: number };

/**
 * Who the student in front of the terminal is, among the unit's enrolled
 * students. Writes no attendance: the lecturer confirms first.
 *
 * Other faces in the frame are tolerated (the queue behind the student); the
 * largest face is the one matched, and the lecturer sees who it was matched to.
 */
export async function identifyFace(
  sessionId: string,
  lecturerUserId: string,
  image: string,
  context: RequestContext,
): Promise<IdentifyResult> {
  const session = await sessionService.getLiveOwnedSession(sessionId, lecturerUserId, 'FACE');
  const embedded = await embedOrThrow(image);
  const face = usableFace(embedded, { allowOthersInFrame: true });

  const candidates = await verificationRepository.findUnitCandidates(session.unitId, embedded.model);
  const outcome = bestMatch(face.embedding, candidates, {
    threshold: env.FACE_MATCH_THRESHOLD,
    margin: env.FACE_MATCH_MARGIN,
  });
  const counts = { facesInFrame: embedded.faceCount, enrolledOnUnit: candidates.length };

  if (outcome.result !== 'MATCH') {
    await auditService.record({
      action: 'ATTENDANCE_FACE_NOT_MATCHED',
      outcome: 'FAILURE',
      userId: lecturerUserId,
      reason: outcome.result,
      ...fingerprint(context),
      metadata: {
        sessionId: session.id,
        unitCode: session.unitCode,
        score: outcome.score === null ? null : roundScore(outcome.score),
        runnerUpScore: outcome.result === 'AMBIGUOUS' ? roundScore(outcome.runnerUpScore) : null,
        ...counts,
      },
    });
    return { result: outcome.result, ...counts };
  }

  const student = await verificationRepository.findStudentCard(session.unitId, outcome.studentUserId);
  if (!student) throw new Error(`matched student ${outcome.studentUserId} has no user row`);
  const score = roundScore(outcome.score);
  const alreadyCheckedIn = await verificationRepository.hasAlreadyCheckedIn(session.id, student.studentUserId);
  const token = alreadyCheckedIn
    ? null
    : issueMatchToken(
        { sessionId: session.id, studentUserId: student.studentUserId, score },
        session.secret,
        env.FACE_MATCH_TOKEN_TTL_SECONDS,
      );

  return {
    result: 'MATCH',
    student,
    score,
    alreadyCheckedIn,
    matchToken: token?.token ?? null,
    expiresAt: token?.expiresAt.toISOString() ?? null,
    ...counts,
  };
}

/**
 * The lecturer confirmed the match. Only a student this server matched, on
 * this session, in the last FACE_MATCH_TOKEN_TTL_SECONDS can be recorded, so
 * this cannot mark an arbitrary student present.
 */
export async function confirmFace(
  sessionId: string,
  lecturerUserId: string,
  matchToken: string,
  context: RequestContext,
): Promise<attendanceService.FaceCheckInResult & { fullName: string }> {
  const session = await sessionService.getLiveOwnedSession(sessionId, lecturerUserId, 'FACE');

  const verdict = verifyMatchToken(matchToken, session.id, session.secret);
  if (!verdict.valid) {
    if (verdict.reason === 'EXPIRED') {
      throw new AppError(410, ErrorCode.FACE_MATCH_EXPIRED, 'That match has expired. Photograph the student again.');
    }
    throw AppError.badRequest('Not a valid match. Photograph the student again.');
  }

  // Seconds have passed since identify: the student may have been dropped or withdrawn consent.
  if (!(await verificationRepository.isFaceCheckInEligible(session.unitId, verdict.studentUserId))) {
    throw AppError.forbidden('This student can no longer be checked in by face for this class. They can scan the QR code.');
  }

  const record = await attendanceService.recordFaceCheckIn({
    session,
    studentUserId: verdict.studentUserId,
    score: verdict.score,
    lecturerUserId,
    context,
  });
  const card = await verificationRepository.findStudentCard(session.unitId, verdict.studentUserId);
  return { ...record, fullName: card?.fullName ?? '' };
}

// --- Shared -----------------------------------------------------------------

/** The unit is the lecturer's and the student is ACTIVE on it. */
async function requireRosterStudent(unitId: string, studentUserId: string, lecturerUserId: string) {
  const target = await verificationRepository.findEnrollmentTarget(unitId, studentUserId);
  if (!target) throw AppError.notFound('Unit not found.');
  if (target.lecturerUserId !== lecturerUserId) throw AppError.forbidden('You do not teach this unit.');
  if (!target.onUnit) throw AppError.notFound('This student is not on the unit.');
  return target;
}

async function embedOrThrow(image: string, details?: { photo: number }) {
  const result = await faceClient.embed(image);
  switch (result.status) {
    case 'OK':
      return result;
    case 'INVALID_IMAGE':
      throw new AppError(422, ErrorCode.FACE_IMAGE_INVALID, 'The photo could not be read. Take it again.', { details });
    case 'DISABLED':
    case 'UNAVAILABLE':
      if (result.status === 'DISABLED') logger.warn('face check-in used while FACE_SERVICE_URL is unset');
      throw new AppError(503, ErrorCode.FACE_RECOGNITION_UNAVAILABLE, UNAVAILABLE_MESSAGE);
  }
}

/**
 * The face to match, or a 422 the terminal can act on. 422s are for the
 * lecturer to retake the photo; nothing about them is a refusal of the student.
 */
function usableFace(
  embedded: { faceCount: number; face: EmbeddedFace | null },
  options: { allowOthersInFrame: boolean; photo?: number },
): EmbeddedFace {
  const details = options.photo ? { photo: options.photo } : undefined;
  if (!embedded.face || embedded.faceCount === 0) {
    throw new AppError(
      422,
      ErrorCode.FACE_NOT_FOUND,
      "No face found. Hold the phone at eye level, about an arm's length from the student.",
      { details },
    );
  }
  if (embedded.faceCount > 1 && !options.allowOthersInFrame) {
    throw new AppError(422, ErrorCode.FACE_MULTIPLE, 'More than one face is in the photo. Photograph one student at a time.', {
      details,
    });
  }
  if (embedded.face.box.width < env.FACE_MIN_FACE_PX) {
    throw new AppError(422, ErrorCode.FACE_POOR_QUALITY, 'The face is too small. Move closer.', { details });
  }
  if (embedded.face.sharpness < env.FACE_MIN_SHARPNESS) {
    throw new AppError(422, ErrorCode.FACE_POOR_QUALITY, 'The photo is blurred. Hold the phone steady.', { details });
  }
  return embedded.face;
}

const fingerprint = (context: RequestContext) => ({
  requestId: context.requestId,
  ipAddress: context.ipAddress,
  userAgent: context.userAgent,
});
