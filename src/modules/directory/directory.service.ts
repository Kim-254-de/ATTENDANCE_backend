import { AppError, ErrorCode } from '../../common/errors/index.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { isUniqueViolation, transaction } from '../../db/database.js';
import * as smartttDirectory from '../../integrations/smarttt/smarttt.directory.js';
import * as repo from './directory.repository.js';

/**
 * Departments belong to SMARTTT (db/migrations/037_smarttt_directory.sql);
 * faculties play no part (039_no_faculties.sql). Each has a name and a code
 * ("DCOMP") unique across the university, which is how the Timetable
 * Allocator and Generator know it.
 *
 * Attendance keeps a copy, linked by SMARTTT's id, because its officers,
 * terminals, course offerings and oversight hang off local rows:
 *
 *  - reading: SMARTTT's list is pulled into the copy (syncFromSmarttt), at
 *    most every SMARTTT_DIRECTORY_SYNC_SECONDS, whenever the admin lists
 *    them or the timetabling systems read them. A local row with the same
 *    name and no link yet is linked rather than duplicated; SMARTTT's name
 *    and code win.
 *  - creating: an administrator's new department is created in SMARTTT
 *    first, then here, linked (createDepartment).
 *  - correcting: an administrator's change to a department's name or code
 *    is made in SMARTTT first, then here (editDepartment). The Timetable
 *    Generator takes the new name and code at its next read.
 *  - rows that only exist here (made before this change) are sent to SMARTTT
 *    when an administrator asks (sendLocalToSmarttt); nothing is sent
 *    unasked.
 *
 * With SMARTTT off (SMARTTT_BASE_URL unset, development), everything stays
 * local, as before.
 */

export interface SyncReport {
  departments: { linked: number; created: number };
  /** SMARTTT rows that could not be brought in, and why (a name or code already used by another department here). */
  skipped: string[];
}

export interface SendReport {
  departments: number;
  /** Local rows that could not be sent, and why. */
  skipped: string[];
}

export const smartttDirectoryEnabled = (): boolean => !!env.SMARTTT_BASE_URL;

let lastSync = 0;
let inFlight: Promise<SyncReport> | null = null;

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const sameCode = (a: string | null, b: string | null) => !!a && !!b && a.trim().toUpperCase() === b.trim().toUpperCase();

/**
 * Pulls SMARTTT's departments into the copy. Throttled unless `force`;
 * throws only when forced (an administrator asked), otherwise a failure is
 * logged and the copy is used as it is.
 */
export async function syncFromSmarttt(options: { force?: boolean } = {}): Promise<SyncReport | null> {
  if (!smartttDirectoryEnabled()) return null;
  if (!options.force && Date.now() - lastSync < env.SMARTTT_DIRECTORY_SYNC_SECONDS * 1000) return null;
  if (inFlight) return inFlight;

  lastSync = Date.now();
  inFlight = pull().finally(() => {
    inFlight = null;
  });
  try {
    return await inFlight;
  } catch (error) {
    if (options.force) throw error;
    logger.error({ err: error }, 'directory: could not read departments from SMARTTT; using the copy here');
    return null;
  }
}

async function pull(): Promise<SyncReport> {
  const answer = await smartttDirectory.listDirectory();
  if (answer.status !== 'FOUND') {
    throw new AppError(503, ErrorCode.SMARTTT_UNAVAILABLE, answer.status === 'UNAVAILABLE' ? answer.reason : 'SMARTTT is not connected.');
  }

  return transaction(async (tx) => {
    const report: SyncReport = { departments: { linked: 0, created: 0 }, skipped: [] };
    const departments = await repo.listDepartments(tx);

    /** SMARTTT's code, unless another department here already holds it (then the one here keeps its own). */
    const codeFor = (sd: smartttDirectory.SmartttDepartment, selfId: string | null): string | null => {
      const holder = departments.find((d) => d.id !== selfId && sameCode(d.code, sd.code));
      if (!holder) return sd.code;
      report.skipped.push(`Department "${sd.name}": its code ${sd.code} is used by "${holder.name}" here.`);
      return null;
    };

    for (const sd of answer.departments) {
      const linked = departments.find((d) => d.smartttId === sd.id);
      const byName = departments.find((d) => sameName(d.name, sd.name));
      if (linked) {
        if (byName && byName.id !== linked.id) report.skipped.push(`Department "${sd.name}": the name is used by another department here.`);
        else if (linked.name !== sd.name || !sameCode(linked.code, sd.code)) {
          const code = codeFor(sd, linked.id);
          await repo.linkDepartment(tx, linked.id, sd.id, sd.name, code);
          linked.name = sd.name;
          linked.code = code ?? linked.code;
        }
      } else if (byName && byName.smartttId === null) {
        const code = codeFor(sd, byName.id);
        await repo.linkDepartment(tx, byName.id, sd.id, sd.name, code);
        byName.smartttId = sd.id;
        byName.code = code ?? byName.code;
        report.departments.linked += 1;
      } else if (byName) {
        report.skipped.push(`Department "${sd.name}": another SMARTTT department here already has this name.`);
      } else {
        const code = codeFor(sd, null);
        const id = await repo.insertDepartment(tx, sd.name, code, sd.id);
        departments.push({ id, name: sd.name, code, smartttId: sd.id });
        report.departments.created += 1;
      }
    }

    if (report.departments.linked + report.departments.created > 0) {
      logger.info(report, 'directory: departments brought in line with SMARTTT');
    }
    return report;
  });
}

/** How many departments exist only here, not yet in SMARTTT. */
export async function unlinkedCounts(): Promise<{ departments: number }> {
  const departments = await repo.listDepartments();
  return { departments: departments.filter((d) => d.smartttId === null).length };
}

/**
 * Sends the departments that only exist here to SMARTTT (one that SMARTTT
 * already has by name is linked to it instead), after reading SMARTTT's list
 * so nothing it already has is sent twice.
 */
export async function sendLocalToSmarttt(): Promise<SendReport> {
  if (!smartttDirectoryEnabled()) throw new AppError(503, ErrorCode.SMARTTT_UNAVAILABLE, 'SMARTTT is not connected.');
  await syncFromSmarttt({ force: true });
  const report: SendReport = { departments: 0, skipped: [] };

  for (const department of (await repo.listDepartments()).filter((d) => d.smartttId === null)) {
    const answer = await smartttDirectory.createDepartment(department.name, department.code);
    if (answer.status === 'CREATED') {
      await repo.setDepartmentSmartttId(department.id, answer.record.id, answer.record.code);
      report.departments += 1;
    } else if (answer.status === 'NAME_TAKEN') {
      await repo.setDepartmentSmartttId(department.id, answer.id, null);
      report.departments += 1;
    } else {
      report.skipped.push(`Department "${department.name}": ${refusal(answer)}`);
    }
  }
  return report;
}

function refusal(answer: { status: 'REFUSED'; message: string } | { status: 'UNAVAILABLE'; reason: string } | { status: 'DISABLED' }): string {
  if (answer.status === 'REFUSED') return answer.message;
  if (answer.status === 'UNAVAILABLE') return answer.reason;
  return 'SMARTTT is not connected.';
}

function createFailed(answer: { status: 'REFUSED'; message: string } | { status: 'UNAVAILABLE'; reason: string } | { status: 'DISABLED' }): AppError {
  if (answer.status === 'REFUSED') return AppError.conflict(`SMARTTT refused it: ${answer.message}`);
  return new AppError(503, ErrorCode.SMARTTT_UNAVAILABLE, `${refusal(answer)} The department was not created; try again in a minute.`);
}

const nameTaken = (name: string) =>
  AppError.conflict(`A department named "${name}" already exists.`, ErrorCode.CONFLICT, {
    details: [{ field: 'name', message: 'This department name is already in use.' }],
  });

const codeTaken = (code: string, holder: string) =>
  AppError.conflict(`The code ${code} is already used by ${holder}.`, ErrorCode.CONFLICT, {
    details: [{ field: 'code', message: 'This department code is already in use.' }],
  });

/**
 * A new department, by an administrator: in SMARTTT first, then here,
 * linked. 409 when the name or code is taken in either.
 */
export async function createDepartment(name: string, code: string): Promise<{ id: string; name: string; code: string }> {
  // "Department of Computer Science" next to "Computer Science" is the same
  // department spelled twice; refuse it before the exact-name constraint would.
  const existing = await repo.findForName(name);
  if (existing) {
    throw AppError.conflict(`"${name}" is the same department as "${existing.name}", which already exists.`, ErrorCode.CONFLICT, {
      details: [{ field: 'name', message: `Already exists as "${existing.name}".` }],
    });
  }
  const holder = await repo.findByCode(code);
  if (holder) throw codeTaken(code, holder.name);

  if (!smartttDirectoryEnabled()) {
    try {
      return { id: await repo.insertDepartment(undefined, name, code, null), name, code };
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken(name);
      throw error;
    }
  }

  const answer = await smartttDirectory.createDepartment(name, code);
  if (answer.status === 'NAME_TAKEN') {
    // SMARTTT has it already: bring it in, so it can be used, but don't pretend it was created now.
    await syncFromSmarttt({ force: true });
    throw nameTaken(name);
  }
  if (answer.status !== 'CREATED') throw createFailed(answer);
  const created = answer.record;
  return transaction(async (tx) => {
    const local = (await repo.listDepartments(tx)).find((d) => d.smartttId === null && sameName(d.name, created.name));
    if (local) {
      await repo.linkDepartment(tx, local.id, created.id, created.name, created.code);
      return { id: local.id, name: created.name, code: created.code };
    }
    return { id: await repo.insertDepartment(tx, created.name, created.code, created.id), name: created.name, code: created.code };
  });
}

/**
 * An administrator's correction of a department's name and code: in SMARTTT
 * first when it is linked there, then here. 404 for an unknown department;
 * 409 when the name (or another spelling of it) or the code belongs to
 * another department, here or in SMARTTT; 503 when SMARTTT can't be reached,
 * and then nothing changes.
 */
export async function editDepartment(id: string, name: string, code: string): Promise<{
  before: { name: string; code: string | null };
  after: { id: string; name: string; code: string };
}> {
  const department = await repo.findDepartment(id);
  if (!department) throw AppError.notFound('No such department.');
  const before = { name: department.name, code: department.code };

  const same = await repo.findForName(name);
  if (same && same.id !== id) {
    throw AppError.conflict(`"${name}" is the same department as "${same.name}", which already exists.`, ErrorCode.CONFLICT, {
      details: [{ field: 'name', message: `Already exists as "${same.name}".` }],
    });
  }
  const holder = await repo.findByCode(code);
  if (holder && holder.id !== id) throw codeTaken(code, holder.name);

  if (smartttDirectoryEnabled() && department.smartttId !== null) {
    const answer = await smartttDirectory.updateDepartment(department.smartttId, name, code);
    if (answer.status === 'NAME_TAKEN') throw nameTaken(name);
    if (answer.status === 'NOT_FOUND') {
      throw AppError.conflict(`SMARTTT no longer has "${department.name}". Nothing was changed.`);
    }
    if (answer.status === 'REFUSED') throw AppError.conflict(`SMARTTT refused it: ${answer.message}`);
    if (answer.status !== 'UPDATED') {
      throw new AppError(503, ErrorCode.SMARTTT_UNAVAILABLE, `${refusal(answer)} The department was not changed; try again in a minute.`);
    }
    name = answer.record.name;
    code = answer.record.code;
  }

  try {
    await repo.renameDepartment(id, name, code);
  } catch (error) {
    if (isUniqueViolation(error)) throw nameTaken(name);
    throw error;
  }
  return { before, after: { id, name, code } };
}

/** Test seam: forget the throttle between cases. */
export function resetDirectorySyncState(): void {
  lastSync = 0;
  inFlight = null;
}

/**
 * Every department, for the Timetable Generator and Allocator, which take
 * their departments from here: SMARTTT's are read in first (throttled), so
 * one an administrator or SMARTTT just added is included.
 */
export async function departmentsForTimetabling(): Promise<repo.DepartmentForTimetabling[]> {
  await syncFromSmarttt();
  return repo.listDepartmentsForTimetabling();
}
