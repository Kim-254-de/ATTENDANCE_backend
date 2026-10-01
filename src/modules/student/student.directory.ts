import { erpClient } from '../../integrations/erp/index.js';
import { smartttClient } from '../../integrations/smarttt/index.js';

/**
 * The student directory a registration is checked against: SMARTTT first
 * when it is configured (it is where rosters come from too), with the ERP
 * (today mock-erp/) as the fallback — when SMARTTT is off, can't be reached,
 * or doesn't list the number. A student SMARTTT reports as no longer current
 * is refused without asking the ERP.
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
  if (!smartttClient.enabled) return lookupInErp(registrationNumber);

  const smarttt = await lookupInSmarttt(registrationNumber);
  if (smarttt.status === 'FOUND' || smarttt.status === 'INACTIVE') return smarttt;

  const erp = await lookupInErp(registrationNumber);
  // Fail closed: "not found" is only definitive when both directories could
  // answer. If SMARTTT was down and the ERP doesn't list the number, SMARTTT
  // might have, so the student is asked to retry rather than refused.
  if (erp.status === 'NOT_FOUND' && smarttt.status === 'UNAVAILABLE') return smarttt;
  return erp;
}

async function lookupInSmarttt(registrationNumber: string): Promise<DirectoryLookup> {
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

async function lookupInErp(registrationNumber: string): Promise<DirectoryLookup> {
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
