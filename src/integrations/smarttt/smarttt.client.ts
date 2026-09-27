import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { toLecturerUnits } from './smarttt.mapper.js';
import type { SmartttLecturerUnitsResult } from './smarttt.types.js';

/**
 * HTTP client for SMARTTT, the university timetable system.
 *
 * Same contract as the ERP client: a business answer (lecturer not found) is
 * a returned status; a transport fault, a bad key or an unreadable payload is
 * UNAVAILABLE. Callers decide whether that fails open or closed. The unit
 * sync fails soft: the lecturer sees the last synced units.
 *
 * No retries: this runs while a lecturer waits for their units page, and a
 * sleeping Render instance is better waited on once than hammered.
 */
export class SmartttHttpClient {
  get enabled(): boolean {
    return !!env.SMARTTT_BASE_URL;
  }

  async listLecturerUnits(staffNumber: string, fullName: string | null): Promise<SmartttLecturerUnitsResult> {
    if (!env.SMARTTT_BASE_URL) return { status: 'DISABLED' };

    const base = env.SMARTTT_BASE_URL.replace(/\/+$/, '');
    const path = env.SMARTTT_LECTURER_UNITS_PATH.startsWith('/')
      ? env.SMARTTT_LECTURER_UNITS_PATH
      : `/${env.SMARTTT_LECTURER_UNITS_PATH}`;
    const url = new URL(`${base}${path}`);
    url.searchParams.set('staff_number', staffNumber.trim().toUpperCase());
    if (fullName?.trim()) url.searchParams.set('name', fullName.trim());

    const logContext = { staffNumber };
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'smart-attendance-backend',
          'X-API-Key': env.SMARTTT_API_KEY ?? '',
        },
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
      logger.info(logContext, 'smarttt: lecturer not found');
      return { status: 'NOT_FOUND' };
    }
    if (response.status === 401 || response.status === 403) {
      // Never report this as NOT_FOUND: a wrong key would look like every
      // lecturer teaching nothing.
      logger.error({ status: response.status }, 'smarttt: rejected our key - check SMARTTT_API_KEY / ATTENDANCE_API_KEY');
      return { status: 'UNAVAILABLE', reason: 'The timetable system rejected our credentials.' };
    }
    if (!response.ok) {
      logger.error({ status: response.status, ...logContext }, 'smarttt: unexpected status');
      return { status: 'UNAVAILABLE', reason: `The timetable system answered HTTP ${response.status}.` };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      logger.error({ err: error, ...logContext }, 'smarttt: response was not JSON');
      return { status: 'UNAVAILABLE', reason: 'The timetable system returned an unexpected response.' };
    }

    const mapped = toLecturerUnits(body);
    if (!mapped) {
      logger.error({ ...logContext, body }, 'smarttt: response could not be mapped');
      return { status: 'UNAVAILABLE', reason: 'The timetable system returned an unexpected response.' };
    }
    return { status: 'FOUND', ...mapped };
  }
}

export const smartttClient = new SmartttHttpClient();
