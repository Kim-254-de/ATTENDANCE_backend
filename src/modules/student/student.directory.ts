import { erpClient, namesMatch } from '../../integrations/erp/index.js';
import { smartttClient } from '../../integrations/smarttt/index.js';

/**
 * The student directory a registration is checked against: SMARTTT when it
 * is configured (it is where rosters come from too), otherwise the ERP (today
 * mock-erp/). Same fallback as unit rosters, so a deployment has one
 * authority for who its students are.
 */

export interface DirectoryStudent {
  registrationNumber: string;
  fullName: string | null;
  /** Lower-cased. Null when the directory has none (the ERP never does). */
  email: string | null;
  programme: string | null;
  yearOfStudy: number | null;
  source: 'SMARTTT' | 'ERP';
  raw: unknown;
}

export type DirectoryLookup =
  | { status: 'FOUND'; record: DirectoryStudent }
  | { status: 'NOT_FOUND' }
  | { status: 'INACTIVE'; record: DirectoryStudent }
  | { status: 'UNAVAILABLE'; reason: string };

export async function lookupStudent(registrationNumber: string): Promise<DirectoryLookup> {
  if (smartttClient.enabled) {
    const result = await smartttClient.lookupStudent(registrationNumber);
    if (result.status === 'NOT_FOUND') return { status: 'NOT_FOUND' };
    if (result.status === 'UNAVAILABLE') return result;
    if (result.status === 'DISABLED') return { status: 'UNAVAILABLE', reason: 'The student directory is not configured.' };
    const r = result.record;
    const record: DirectoryStudent = {
      registrationNumber: r.registrationNumber,
      fullName: r.fullName,
      email: r.email,
      programme: r.programme,
      yearOfStudy: r.yearOfStudy,
      source: 'SMARTTT',
      raw: r.raw,
    };
    return r.isActive ? { status: 'FOUND', record } : { status: 'INACTIVE', record };
  }

  const result = await erpClient.lookupStudent(registrationNumber);
  if (result.status === 'NOT_FOUND' || result.status === 'UNAVAILABLE') return result;
  const r = result.record;
  const record: DirectoryStudent = {
    registrationNumber: r.registrationNumber,
    fullName: r.fullName,
    email: null,
    programme: r.programme,
    yearOfStudy: r.yearOfStudy,
    source: 'ERP',
    raw: r.raw,
  };
  return result.status === 'FOUND' ? { status: 'FOUND', record } : { status: 'INACTIVE', record };
}

/**
 * The fields that don't match the directory — empty means the person
 * registering is who the registration number belongs to. Stops someone
 * registering with a classmate's number.
 *
 * The name is always compared (formatting-forgiving: see namesMatch); the
 * email only when the directory holds one. A record with neither can't be
 * checked, so is reported as both mismatching rather than waved through.
 */
export function mismatchedIdentityFields(
  record: DirectoryStudent,
  claimed: { fullName: string; email: string },
): string[] {
  if (!record.fullName && !record.email) return ['fullName', 'email'];
  const mismatched: string[] = [];
  if (record.fullName && !namesMatch(record.fullName, claimed.fullName)) mismatched.push('fullName');
  if (record.email && record.email !== claimed.email.trim().toLowerCase()) mismatched.push('email');
  return mismatched;
}
