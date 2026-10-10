import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { toAuthenticatedAccount, toLecturerUnits, toStaffRecord, toStudentRecord, toStudentUnits } from './smarttt.mapper.js';
import type {
  SmartttAuthenticateResult,
  SmartttLecturerUnitsResult,
  SmartttStaffLookupResult,
  SmartttStudentLookupResult,
  SmartttStudentUnitsResult,
} from './smarttt.types.js';

/**
 * HTTP client for SMARTTT, the university timetable system.
 *
 * Same contract as the ERP client: a business answer (not found) is a
 * returned status; a transport fault, a bad key or an unreadable payload is
 * UNAVAILABLE. Callers decide whether that fails open or closed: the unit
 * sync fails soft (the lecturer sees the last synced units), student
 * registration fails closed (nothing is created unverified), and so does
 * sign-in (nobody is let in on an unanswered password check).
 *
 * No retries: a person is waiting on each call, and a sleeping Render
 * instance is better waited on once than hammered.
 */

type RawResult =
  | { status: 'OK'; body: unknown }
  | { status: 'NOT_FOUND' }
  | { status: 'UNAVAILABLE'; reason: string };

export class SmartttHttpClient {
  get enabled(): boolean {
    return !!env.SMARTTT_BASE_URL;
  }

  async listLecturerUnits(staffNumber: string, fullName: string | null): Promise<SmartttLecturerUnitsResult> {
    if (!env.SMARTTT_BASE_URL) return { status: 'DISABLED' };
    const params: Record<string, string> = { staff_number: staffNumber.trim().toUpperCase() };
    if (fullName?.trim()) params['name'] = fullName.trim();

    const result = await this.get(env.SMARTTT_LECTURER_UNITS_PATH, params, { staffNumber });
    if (result.status !== 'OK') return result;

    const mapped = toLecturerUnits(result.body);
    if (!mapped) {
      logger.error({ staffNumber, body: result.body }, 'smarttt: lecturer units could not be mapped');
      return { status: 'UNAVAILABLE', reason: 'The timetable system returned an unexpected response.' };
    }
    return { status: 'FOUND', ...mapped };
  }

  /** The student with this registration number, for checking a student registration. */
  async lookupStudent(registrationNumber: string): Promise<SmartttStudentLookupResult> {
    if (!env.SMARTTT_BASE_URL) return { status: 'DISABLED' };
    const normalised = registrationNumber.trim().toUpperCase();

    const result = await this.get(
      env.SMARTTT_STUDENT_LOOKUP_PATH,
      { registration_number: normalised },
      { registrationNumber: normalised },
    );
    if (result.status !== 'OK') return result;

    const record = toStudentRecord(result.body);
    if (!record) {
      logger.error({ registrationNumber: normalised, body: result.body }, 'smarttt: student could not be mapped');
      return { status: 'UNAVAILABLE', reason: 'The timetable system returned an unexpected response.' };
    }
    return { status: 'FOUND', record };
  }

  /** The member of staff with this staff number, for checking a lecturer registration. */
  async lookupStaff(staffNumber: string): Promise<SmartttStaffLookupResult> {
    if (!env.SMARTTT_BASE_URL) return { status: 'DISABLED' };
    const normalised = staffNumber.trim().toUpperCase();

    const result = await this.get(env.SMARTTT_STAFF_LOOKUP_PATH, { staff_number: normalised }, { staffNumber: normalised });
    if (result.status !== 'OK') return result;

    const record = toStaffRecord(result.body);
    if (!record) {
      logger.error({ staffNumber: normalised, body: result.body }, 'smarttt: staff member could not be mapped');
      return { status: 'UNAVAILABLE', reason: 'The timetable system returned an unexpected response.' };
    }
    return { status: 'FOUND', record };
  }

  /** The classes a student is registered for this term, for their units page. */
  async listStudentUnits(registrationNumber: string): Promise<SmartttStudentUnitsResult> {
    if (!env.SMARTTT_BASE_URL) return { status: 'DISABLED' };
    const normalised = registrationNumber.trim().toUpperCase();

    const result = await this.get(
      env.SMARTTT_STUDENT_UNITS_PATH,
      { registration_number: normalised },
      { registrationNumber: normalised },
    );
    if (result.status !== 'OK') return result;

    const mapped = toStudentUnits(result.body);
    if (!mapped) {
      logger.error({ registrationNumber: normalised, body: result.body }, 'smarttt: student units could not be mapped');
      return { status: 'UNAVAILABLE', reason: 'The timetable system returned an unexpected response.' };
    }
    return { status: 'FOUND', ...mapped };
  }

  /**
   * Checks a SMARTTT email, admission number or staff ID and password: how
   * students and lecturers sign in to attendance. The password is sent in the
   * body (never a URL) and never logged.
   */
  async authenticate(identifier: string, password: string): Promise<SmartttAuthenticateResult> {
    if (!env.SMARTTT_BASE_URL) return { status: 'DISABLED' };
    const result = await this.send(
      this.url(env.SMARTTT_AUTHENTICATE_PATH),
      { method: 'POST', body: JSON.stringify({ identifier: identifier.trim(), password }) },
      {},
    );
    // Not an answer the endpoint gives: it is missing (an older SMARTTT).
    if (result.status === 'NOT_FOUND') {
      logger.error('smarttt: no sign-in endpoint - deploy SMARTTT with apps/integrations attendance/authenticate/');
      return { status: 'UNAVAILABLE', reason: 'The timetable system cannot check sign-ins yet.' };
    }
    if (result.status !== 'OK') return result;

    const account = toAuthenticatedAccount(result.body);
    if (account === null) {
      logger.error('smarttt: sign-in answer could not be mapped');
      return { status: 'UNAVAILABLE', reason: 'The timetable system returned an unexpected response.' };
    }
    return account === false ? { status: 'INVALID_CREDENTIALS' } : { status: 'AUTHENTICATED', account };
  }

  private url(path: string, params: Record<string, string> = {}): URL {
    const base = (env.SMARTTT_BASE_URL ?? '').replace(/\/+$/, '');
    const url = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url;
  }

  /** One GET with the shared key and timeout. Never throws. */
  private get(path: string, params: Record<string, string>, logContext: Record<string, string>): Promise<RawResult> {
    return this.send(this.url(path, params), { method: 'GET' }, logContext);
  }

  /** One request with the shared key and timeout. Never throws. */
  private async send(url: URL, init: { method: 'GET' | 'POST'; body?: string }, logContext: Record<string, string>): Promise<RawResult> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'smart-attendance-backend',
          'X-API-Key': env.SMARTTT_API_KEY ?? '',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.body,
        signal: AbortSignal.timeout(env.SMARTTT_TIMEOUT_MS),
      });
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === 'TimeoutError';
      logger.warn({ err: error, ...logContext }, 'smarttt: request failed');
      return {
        status: 'UNAVAILABLE',
        reason: isTimeout ? 'The timetable system took too long to answer.' : 'The timetable system could not be reached.',
      };
    }

    if (response.status === 404) {
      logger.info(logContext, 'smarttt: not found');
      return { status: 'NOT_FOUND' };
    }
    if (response.status === 401 || response.status === 403) {
      // Never report this as NOT_FOUND: a wrong key would look like nobody exists.
      logger.error({ status: response.status }, 'smarttt: rejected our key - check SMARTTT_API_KEY / ATTENDANCE_API_KEY');
      return { status: 'UNAVAILABLE', reason: 'The timetable system rejected our credentials.' };
    }
    if (!response.ok) {
      logger.error({ status: response.status, ...logContext }, 'smarttt: unexpected status');
      return { status: 'UNAVAILABLE', reason: `The timetable system answered HTTP ${response.status}.` };
    }

    try {
      return { status: 'OK', body: await response.json() };
    } catch (error) {
      logger.error({ err: error, ...logContext }, 'smarttt: response was not JSON');
      return { status: 'UNAVAILABLE', reason: 'The timetable system returned an unexpected response.' };
    }
  }
}

export const smartttClient = new SmartttHttpClient();
