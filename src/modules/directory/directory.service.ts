import { AppError, ErrorCode } from '../../common/errors/index.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { isUniqueViolation, transaction } from '../../db/database.js';
import * as smartttDirectory from '../../integrations/smarttt/smarttt.directory.js';
import * as repo from './directory.repository.js';

/**
 * Faculties and departments belong to SMARTTT (db/migrations/037_smarttt_directory.sql).
 *
 * Attendance keeps a copy, linked by SMARTTT's id, because its officers,
 * terminals, course offerings and oversight hang off local rows:
 *
 *  - reading: SMARTTT's list is pulled into the copy (syncFromSmarttt), at
 *    most every SMARTTT_DIRECTORY_SYNC_SECONDS, whenever the admin or a
 *    faculty officer lists them. A local row with the same name and no link
 *    yet is linked rather than duplicated; SMARTTT's name wins.
 *  - creating: a new faculty or department is created in SMARTTT first, then
 *    here, linked (createFaculty, createDepartment).
 *  - rows that only exist here (made before this change) are sent to SMARTTT
 *    when an administrator asks (sendLocalToSmarttt); nothing is sent
 *    unasked.
 *
 * With SMARTTT off (SMARTTT_BASE_URL unset, development), everything stays
 * local, as before.
 */

export interface SyncReport {
  faculties: { linked: number; created: number };
  departments: { linked: number; created: number };
  /** SMARTTT rows that could not be brought in, and why (a name already linked to another SMARTTT row). */
  skipped: string[];
}

export interface SendReport {
  faculties: number;
  departments: number;
  /** Local rows that could not be sent, and why. */
  skipped: string[];
}

export const smartttDirectoryEnabled = (): boolean => !!env.SMARTTT_BASE_URL;

let lastSync = 0;
let inFlight: Promise<SyncReport> | null = null;

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Pulls SMARTTT's faculties and departments into the copy. Throttled unless
 * `force`; throws only when forced (an administrator asked), otherwise a
 * failure is logged and the copy is used as it is.
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
    logger.error({ err: error }, 'directory: could not read faculties and departments from SMARTTT; using the copy here');
    return null;
  }
}

async function pull(): Promise<SyncReport> {
  const answer = await smartttDirectory.listDirectory();
  if (answer.status !== 'FOUND') {
    throw new AppError(503, ErrorCode.SMARTTT_UNAVAILABLE, answer.status === 'UNAVAILABLE' ? answer.reason : 'SMARTTT is not connected.');
  }

  return transaction(async (tx) => {
    const report: SyncReport = { faculties: { linked: 0, created: 0 }, departments: { linked: 0, created: 0 }, skipped: [] };
    const faculties = await repo.listFaculties(tx);
    const facultyOf = new Map<number, string>();

    for (const sf of answer.faculties) {
      const linked = faculties.find((f) => f.smartttId === sf.id);
      const byName = faculties.find((f) => sameName(f.name, sf.name));
      if (linked) {
        facultyOf.set(sf.id, linked.id);
        if (linked.name !== sf.name) {
          if (byName && byName.id !== linked.id) report.skipped.push(`Faculty "${sf.name}": the name is used by another faculty here.`);
          else await repo.linkFaculty(tx, linked.id, sf.id, sf.name);
        }
      } else if (byName && byName.smartttId === null) {
        await repo.linkFaculty(tx, byName.id, sf.id, sf.name);
        byName.smartttId = sf.id;
        facultyOf.set(sf.id, byName.id);
        report.faculties.linked += 1;
      } else if (byName) {
        report.skipped.push(`Faculty "${sf.name}": the name is linked to another SMARTTT faculty.`);
      } else {
        const id = await repo.insertFaculty(tx, sf.name, sf.id);
        faculties.push({ id, name: sf.name, smartttId: sf.id });
        facultyOf.set(sf.id, id);
        report.faculties.created += 1;
      }
    }

    const departments = await repo.listDepartments(tx);
    for (const sd of answer.departments) {
      const facultyId = facultyOf.get(sd.facultyId) ?? null;
      const linked = departments.find((d) => d.smartttId === sd.id);
      const byName = departments.find((d) => sameName(d.name, sd.name));
      if (linked) {
        if (byName && byName.id !== linked.id) report.skipped.push(`Department "${sd.name}": the name is used by another department here.`);
        else if (linked.name !== sd.name || (facultyId && linked.facultyId !== facultyId)) {
          await repo.linkDepartment(tx, linked.id, sd.id, sd.name, facultyId);
        }
      } else if (byName && byName.smartttId === null) {
        await repo.linkDepartment(tx, byName.id, sd.id, sd.name, facultyId);
        byName.smartttId = sd.id;
        report.departments.linked += 1;
      } else if (byName) {
        // Attendance keeps department names unique across the university; SMARTTT only within a faculty.
        report.skipped.push(`Department "${sd.name}": another SMARTTT department here already has this name.`);
      } else {
        const id = await repo.insertDepartment(tx, sd.name, facultyId, sd.id);
        departments.push({ id, name: sd.name, facultyId, smartttId: sd.id });
        report.departments.created += 1;
      }
    }

    if (report.faculties.linked + report.faculties.created + report.departments.linked + report.departments.created > 0) {
      logger.info(report, 'directory: faculties and departments brought in line with SMARTTT');
    }
    return report;
  });
}

/** How many faculties and departments exist only here, not yet in SMARTTT. */
export async function unlinkedCounts(): Promise<{ faculties: number; departments: number }> {
  const [faculties, departments] = await Promise.all([repo.listFaculties(), repo.listDepartments()]);
  return {
    faculties: faculties.filter((f) => f.smartttId === null).length,
    departments: departments.filter((d) => d.smartttId === null).length,
  };
}

/**
 * Sends the faculties and departments that only exist here to SMARTTT (one
 * that SMARTTT already has by name is linked to it instead), after reading
 * SMARTTT's list so nothing it already has is sent twice.
 */
export async function sendLocalToSmarttt(): Promise<SendReport> {
  if (!smartttDirectoryEnabled()) throw new AppError(503, ErrorCode.SMARTTT_UNAVAILABLE, 'SMARTTT is not connected.');
  await syncFromSmarttt({ force: true });
  const report: SendReport = { faculties: 0, departments: 0, skipped: [] };

  for (const faculty of (await repo.listFaculties()).filter((f) => f.smartttId === null)) {
    const answer = await smartttDirectory.createFaculty(faculty.name);
    if (answer.status === 'CREATED' || answer.status === 'NAME_TAKEN') {
      await repo.setFacultySmartttId(faculty.id, answer.status === 'CREATED' ? answer.record.id : answer.id);
      report.faculties += 1;
    } else {
      report.skipped.push(`Faculty "${faculty.name}": ${refusal(answer)}`);
    }
  }

  const faculties = new Map((await repo.listFaculties()).map((f) => [f.id, f]));
  for (const department of (await repo.listDepartments()).filter((d) => d.smartttId === null)) {
    const smartttFacultyId = department.facultyId ? faculties.get(department.facultyId)?.smartttId : null;
    if (!smartttFacultyId) {
      report.skipped.push(`Department "${department.name}": it has no faculty in SMARTTT. Place it in a faculty first.`);
      continue;
    }
    const answer = await smartttDirectory.createDepartment(smartttFacultyId, department.name);
    if (answer.status === 'CREATED' || answer.status === 'NAME_TAKEN') {
      await repo.setDepartmentSmartttId(department.id, answer.status === 'CREATED' ? answer.record.id : answer.id);
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
  if (answer.status === 'REFUSED') return AppError.badRequest(`SMARTTT refused it: ${answer.message}`);
  return new AppError(503, ErrorCode.SMARTTT_UNAVAILABLE, `${refusal(answer)} The faculty or department was not created; try again in a minute.`);
}

const nameTaken = (what: 'faculty' | 'department', name: string) =>
  AppError.conflict(`A ${what} named "${name}" already exists.`, ErrorCode.CONFLICT, {
    details: [{ field: 'name', message: `This ${what} name is already in use.` }],
  });

/** A new faculty: in SMARTTT first, then here, linked. 409 when the name is taken in either. */
export async function createFaculty(name: string): Promise<{ id: string; name: string }> {
  if (!smartttDirectoryEnabled()) {
    try {
      return { id: await repo.insertFaculty(undefined, name, null), name };
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken('faculty', name);
      throw error;
    }
  }

  const answer = await smartttDirectory.createFaculty(name);
  if (answer.status === 'NAME_TAKEN') {
    // SMARTTT has it already: bring it in, so it can be used, but don't pretend it was created now.
    await syncFromSmarttt({ force: true });
    throw nameTaken('faculty', name);
  }
  if (answer.status !== 'CREATED') throw createFailed(answer);
  const created = answer.record;
  return transaction(async (tx) => {
    const local = (await repo.listFaculties(tx)).find((f) => f.smartttId === null && sameName(f.name, created.name));
    if (local) {
      await repo.linkFaculty(tx, local.id, created.id, created.name);
      return { id: local.id, name: created.name };
    }
    return { id: await repo.insertFaculty(tx, created.name, created.id), name: created.name };
  });
}

/** A new department in a faculty: in SMARTTT first, then here, linked. */
export async function createDepartment(facultyId: string, name: string): Promise<{ id: string; name: string }> {
  if (!smartttDirectoryEnabled()) {
    try {
      return { id: await repo.insertDepartment(undefined, name, facultyId, null), name };
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken('department', name);
      throw error;
    }
  }

  let faculty = await repo.findFaculty(facultyId);
  if (faculty && faculty.smartttId === null) {
    await syncFromSmarttt({ force: true });
    faculty = await repo.findFaculty(facultyId);
  }
  if (!faculty) throw AppError.notFound('No such faculty.');
  if (faculty.smartttId === null) {
    throw AppError.conflict(
      `${faculty.name} is not in SMARTTT yet, so its departments can't be added there. Ask an administrator to send it to SMARTTT (Faculties page).`,
    );
  }

  const answer = await smartttDirectory.createDepartment(faculty.smartttId, name);
  if (answer.status === 'NAME_TAKEN') {
    await syncFromSmarttt({ force: true });
    throw nameTaken('department', name);
  }
  if (answer.status !== 'CREATED') throw createFailed(answer);
  const created = answer.record;
  return transaction(async (tx) => {
    const local = (await repo.listDepartments(tx)).find((d) => d.smartttId === null && sameName(d.name, created.name));
    if (local) {
      await repo.linkDepartment(tx, local.id, created.id, created.name, facultyId);
      return { id: local.id, name: created.name };
    }
    return { id: await repo.insertDepartment(tx, created.name, facultyId, created.id), name: created.name };
  });
}

/** Test seam: forget the throttle between cases. */
export function resetDirectorySyncState(): void {
  lastSync = 0;
  inFlight = null;
}

/**
 * Every department, for the Timetable Generator, which takes its departments
 * from here: SMARTTT's are read in first (throttled), so one a faculty officer
 * or SMARTTT just added is included.
 */
export async function departmentsForTimetabling(): Promise<repo.DepartmentForTimetabling[]> {
  await syncFromSmarttt();
  return repo.listDepartmentsForTimetabling();
}
