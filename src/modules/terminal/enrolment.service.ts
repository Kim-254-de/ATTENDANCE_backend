import { AppError, ErrorCode } from '../../common/errors/index.js';
import { hashCardUid } from '../../common/utils/card-uid.js';
import { env } from '../../config/env.js';
import { isUniqueViolation, transaction } from '../../db/database.js';
import { auditService } from '../audit/index.js';
import { provisionStudentFromSmarttt } from '../auth/index.js';
import { departmentService } from '../department/index.js';
import * as enrolmentRepository from './enrolment.repository.js';
import type { Command, CoverageRow } from './enrolment.repository.js';
import * as terminalRepository from './terminal.repository.js';
import type { Terminal } from './terminal.repository.js';
import type { RequestContext } from './terminal.service.js';

/**
 * Fingerprint enrolment, done by the department on its own terminals
 * (docs/hardware-specs.md 6.3).
 *
 * The officer asks; the device does. An enrolment request is queued for one
 * terminal, the device picks it up when it reports in, takes the student's
 * finger into one of its own slots and sends the slot reference back. Only
 * then does the enrolment exist. Revoking queues the opposite: the device
 * frees the slot, so a revoked finger is gone from the reader too.
 *
 * No fingerprint, template or image passes through here at any point.
 */

async function departmentOf(userId: string): Promise<string> {
  return (await departmentService.getMyDepartment(userId)).departmentId;
}

// --- Department officers ----------------------------------------------------

/** GET /departments/enrolment/students */
export async function listCoverage(officerUserId: string, search: string | undefined, limit: number): Promise<CoverageRow[]> {
  return enrolmentRepository.listCoverage(await departmentOf(officerUserId), search?.trim() || null, limit);
}

/**
 * POST /departments/terminals/:terminalId/enrolments
 *
 * By registration number, so a student who has never signed in can still be
 * enrolled: their account is created from SMARTTT, as a barcode scan would.
 */
export async function requestEnrolment(
  officerUserId: string,
  terminalId: string,
  input: { registrationNumber: string; label?: string },
  context: RequestContext,
): Promise<{ commandId: string; studentUserId: string }> {
  const departmentId = await departmentOf(officerUserId);
  const terminal = await terminalRepository.findInDepartment(terminalId, departmentId);
  if (!terminal) throw AppError.notFound('Terminal not found.');
  if (!terminal.capabilities.includes('FINGERPRINT')) throw AppError.conflict('This terminal has no fingerprint reader.');
  if (terminal.status !== 'ACTIVE') throw AppError.conflict('Pair this terminal before enrolling on it.');

  const student = await enrolmentRepository.findDepartmentStudent(departmentId, input.registrationNumber);
  if (!student) throw AppError.notFound("No student with that number is on your department's class lists.");

  let studentUserId = student.studentUserId;
  if (!studentUserId) {
    const provisioned = await provisionStudentFromSmarttt(student.registrationNumber, context);
    if (provisioned.status === 'UNAVAILABLE') {
      throw new AppError(503, ErrorCode.SMARTTT_UNAVAILABLE, 'SMARTTT could not be reached to set up this student. Try again shortly.');
    }
    if (provisioned.status !== 'CREATED' && provisioned.status !== 'EXISTS') {
      throw AppError.conflict('This student has no attendance account, and SMARTTT could not provide one. Check their SMARTTT record.');
    }
    studentUserId = provisioned.userId;
  }

  if (await enrolmentRepository.hasActiveFingerprint(studentUserId, terminal.code)) {
    throw AppError.conflict(`This student is already enrolled on ${terminal.code}. Remove that enrolment first to redo it.`);
  }

  let commandId: string;
  try {
    commandId = await enrolmentRepository.createCommand({
      terminalId: terminal.id,
      kind: 'ENROL_FINGERPRINT',
      studentUserId,
      fingerprintId: null,
      label: input.label?.trim() || null,
      requestedByUserId: officerUserId,
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw AppError.conflict(`An enrolment for this student is already waiting on ${terminal.code}.`);
    throw error;
  }

  await auditService.record({
    action: 'FINGERPRINT_ENROLMENT_REQUESTED',
    outcome: 'SUCCESS',
    userId: officerUserId,
    subjectRegistrationNumber: student.registrationNumber,
    ...context,
    metadata: { commandId, terminalId: terminal.id, code: terminal.code, studentUserId },
  });
  return { commandId, studentUserId };
}

/** POST /departments/enrolment/commands/:commandId/cancel - only while the device has not done it. */
export async function cancelCommand(officerUserId: string, commandId: string, context: RequestContext): Promise<void> {
  const command = await enrolmentRepository.findInDepartment(commandId, await departmentOf(officerUserId));
  if (!command) throw AppError.notFound('Request not found.');
  if (!(await enrolmentRepository.finish(command.id, 'CANCELLED'))) {
    throw AppError.conflict('The terminal has already dealt with this request.');
  }
  await auditService.record({
    action: 'TERMINAL_COMMAND_CANCELLED',
    outcome: 'SUCCESS',
    userId: officerUserId,
    ...context,
    metadata: { commandId: command.id, kind: command.kind, studentUserId: command.studentUserId },
  });
}

/**
 * DELETE /departments/enrolment/fingerprints/:fingerprintId
 *
 * Stops the finger counting at once, and queues its removal from the reader.
 * A retired reader gets no command: it will never report in again.
 */
export async function revokeFingerprint(officerUserId: string, fingerprintId: string, context: RequestContext): Promise<void> {
  const fingerprint = await enrolmentRepository.findFingerprintInDepartment(fingerprintId, await departmentOf(officerUserId));
  if (!fingerprint) throw AppError.notFound('Enrolment not found.');
  if (fingerprint.status !== 'ACTIVE') throw AppError.conflict('This enrolment has already been removed.');

  await transaction(async (tx) => {
    if (!(await enrolmentRepository.revokeFingerprint(fingerprint.id, tx))) return;
    if (fingerprint.terminalStatus !== 'RETIRED') {
      await enrolmentRepository.createCommand(
        {
          terminalId: fingerprint.terminalId,
          kind: 'DELETE_FINGERPRINT',
          studentUserId: fingerprint.studentUserId,
          fingerprintId: fingerprint.id,
          label: null,
          requestedByUserId: officerUserId,
        },
        tx,
      );
    }
    await auditService.recordInTransaction(tx, {
      action: 'STUDENT_FINGERPRINT_REVOKED',
      outcome: 'SUCCESS',
      userId: officerUserId,
      ...context,
      metadata: { fingerprintId: fingerprint.id, code: fingerprint.terminalCode, studentUserId: fingerprint.studentUserId },
    });
  });
}

// --- Devices ----------------------------------------------------------------

export interface CommandDto {
  id: string;
  kind: Command['kind'];
  student: { fullName: string | null; registrationNumber: string | null };
  /** For DELETE: the enrolment whose slot to free, as the device recorded it when enrolling. */
  fingerprintId: string | null;
  label: string | null;
  createdAt: string;
}

const toDto = (c: Command): CommandDto => ({
  id: c.id,
  kind: c.kind,
  student: { fullName: c.studentName, registrationNumber: c.registrationNumber },
  fingerprintId: c.fingerprintId,
  label: c.label,
  createdAt: c.createdAt.toISOString(),
});

/** GET /terminals/commands */
export async function listCommands(terminal: Terminal): Promise<CommandDto[]> {
  return (await enrolmentRepository.listPending(terminal.id)).map(toDto);
}

export const countPending = (terminal: Terminal): Promise<number> => enrolmentRepository.countPending(terminal.id);

async function pendingCommand(terminal: Terminal, commandId: string): Promise<Command> {
  const command = await enrolmentRepository.findForTerminal(commandId, terminal.id);
  if (!command) throw AppError.notFound('Request not found.');
  if (command.status !== 'PENDING') throw AppError.conflict('This request was cancelled or has already been dealt with.');
  return command;
}

/**
 * POST /terminals/commands/:commandId/complete
 *
 * ENROL: `fingerRef` is the slot the device stored the finger in. Returns the
 * enrolment id, which the device must keep against that slot: a later DELETE
 * names the enrolment, not the slot.
 */
export async function completeCommand(
  terminal: Terminal,
  commandId: string,
  fingerRef: string | undefined,
  context: RequestContext,
): Promise<{ fingerprintId: string | null }> {
  const command = await pendingCommand(terminal, commandId);

  if (command.kind === 'DELETE_FINGERPRINT') {
    await enrolmentRepository.finish(command.id, 'DONE');
    return { fingerprintId: command.fingerprintId };
  }

  if (!fingerRef) throw AppError.badRequest('Send the slot the finger was stored in as fingerRef.');
  if (!env.FINGERPRINT_REF_SECRET) throw new AppError(409, ErrorCode.CONFLICT, 'Fingerprints are not set up on this server.');
  const secret = env.FINGERPRINT_REF_SECRET;
  const requestedBy = await enrolmentRepository.requestedBy(command.id);

  try {
    const fingerprintId = await transaction(async (tx) => {
      const id = await enrolmentRepository.insertFingerprint(
        {
          studentUserId: command.studentUserId,
          terminalCode: terminal.code,
          fingerRefHmac: hashCardUid(fingerRef, secret),
          label: command.label,
          enrolledByUserId: requestedBy,
        },
        tx,
      );
      if (!(await enrolmentRepository.finish(command.id, 'DONE', { fingerprintId: id }, tx))) {
        throw AppError.conflict('This request was cancelled while the finger was being taken. Free the slot.');
      }
      await auditService.recordInTransaction(tx, {
        action: 'STUDENT_FINGERPRINT_ENROLLED',
        outcome: 'SUCCESS',
        userId: requestedBy,
        subjectRegistrationNumber: command.registrationNumber,
        ...context,
        metadata: { fingerprintId: id, code: terminal.code, studentUserId: command.studentUserId, commandId: command.id },
      });
      return id;
    });
    return { fingerprintId };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict('That slot already belongs to another student on this reader, or this student is already enrolled here.');
    }
    throw error;
  }
}

/** POST /terminals/commands/:commandId/fail - e.g. the student could not give a usable finger. */
export async function failCommand(terminal: Terminal, commandId: string, reason: string, context: RequestContext): Promise<void> {
  const command = await pendingCommand(terminal, commandId);
  await enrolmentRepository.finish(command.id, 'FAILED', { failureReason: reason });
  await auditService.record({
    action: 'TERMINAL_COMMAND_FAILED',
    outcome: 'FAILURE',
    reason,
    ...context,
    metadata: { commandId: command.id, kind: command.kind, code: terminal.code, studentUserId: command.studentUserId },
  });
}
