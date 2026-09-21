import { setTimeout as delay } from 'node:timers/promises';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { toStaffRecord } from './erp.mapper.js';
import { compareIdentity } from './erp.identity.js';
import type { ClaimedIdentity, ErpLookupResult, ErpProvider, ErpStaffRecord } from './erp.types.js';

/**
 * HTTP client for the institutional ERP.
 *
 * Contract with the rest of the app: a business outcome (missing, inactive,
 * mismatched) is a returned status. A transport or server fault becomes
 * UNAVAILABLE, and the registration service turns that into a 503 rather than
 * letting an unverified lecturer through. The gate fails CLOSED.
 */

interface CacheEntry {
  record: ErpStaffRecord;
  expiresAt: number;
}

/**
 * Only successful lookups are cached, and only briefly. A NOT_FOUND is never
 * cached: a lecturer added to the ERP moments ago must be able to register
 * without waiting for a TTL to lapse.
 */
class StaffCache {
  private readonly entries = new Map<string, CacheEntry>();

  get(staffNumber: string): ErpStaffRecord | null {
    if (env.ERP_CACHE_TTL_SECONDS === 0) return null;

    const entry = this.entries.get(staffNumber);
    if (!entry) return null;

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(staffNumber);
      return null;
    }
    return entry.record;
  }

  set(staffNumber: string, record: ErpStaffRecord): void {
    if (env.ERP_CACHE_TTL_SECONDS === 0) return;
    this.entries.set(staffNumber, {
      record,
      expiresAt: Date.now() + env.ERP_CACHE_TTL_SECONDS * 1000,
    });
  }

  clear(): void {
    this.entries.clear();
  }
}

function buildAuthHeaders(): Record<string, string> {
  switch (env.ERP_AUTH_SCHEME) {
    case 'bearer':
      return { Authorization: `Bearer ${env.ERP_API_KEY ?? ''}` };
    case 'api-key':
      return { [env.ERP_API_KEY_HEADER]: env.ERP_API_KEY ?? '' };
    case 'basic': {
      const credentials = Buffer.from(
        `${env.ERP_BASIC_USERNAME ?? ''}:${env.ERP_BASIC_PASSWORD ?? ''}`,
      ).toString('base64');
      return { Authorization: `Basic ${credentials}` };
    }
    case 'none':
      return {};
  }
}

function buildLookupUrl(staffNumber: string): string {
  const path = env.ERP_STAFF_LOOKUP_PATH.replace(
    '{staffNumber}',
    encodeURIComponent(staffNumber),
  );
  const base = env.ERP_BASE_URL.replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** 5xx and 429 are worth another attempt; 4xx are the ERP's final answer. */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

export class ErpHttpClient implements ErpProvider {
  private readonly cache = new StaffCache();

  async verifyStaffNumber(
    staffNumber: string,
    claimed: ClaimedIdentity,
  ): Promise<ErpLookupResult> {
    const normalised = staffNumber.trim().toUpperCase();

    const cached = this.cache.get(normalised);
    const record = cached ?? (await this.fetchRecord(normalised));

    // fetchRecord signals its own failure modes through these sentinels.
    if (record === 'NOT_FOUND') return { status: 'NOT_FOUND' };
    if (record === 'UNAVAILABLE') {
      return { status: 'UNAVAILABLE', reason: 'The staff directory could not be reached.' };
    }

    if (!cached) this.cache.set(normalised, record);

    if (!record.isActive) {
      return { status: 'INACTIVE', record };
    }

    if (env.ERP_ENFORCE_IDENTITY_MATCH) {
      const mismatchedFields = compareIdentity(record, claimed);
      if (mismatchedFields.length > 0) {
        return { status: 'IDENTITY_MISMATCH', record, mismatchedFields };
      }
    }

    return { status: 'VERIFIED', record };
  }

  /** Performs the request with a timeout and bounded exponential backoff. */
  private async fetchRecord(
    staffNumber: string,
  ): Promise<ErpStaffRecord | 'NOT_FOUND' | 'UNAVAILABLE'> {
    const url = buildLookupUrl(staffNumber);
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'smart-attendance-backend',
      ...buildAuthHeaders(),
    };

    let lastFailure = 'no attempt made';

    for (let attempt = 0; attempt <= env.ERP_MAX_RETRIES; attempt += 1) {
      if (attempt > 0) {
        // 200ms, 400ms, 800ms ... with jitter, so a fleet of retrying
        // instances does not hammer the ERP in lockstep.
        const backoff = 200 * 2 ** (attempt - 1);
        await delay(backoff + Math.floor(Math.random() * 100));
      }

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(env.ERP_TIMEOUT_MS),
        });

        // The definitive "this staff number is not ours".
        if (response.status === 404) {
          logger.info({ staffNumber }, 'erp lookup: staff number not found');
          return 'NOT_FOUND';
        }

        if (response.status === 401 || response.status === 403) {
          // Our credentials are wrong. This must never be reported as
          // NOT_FOUND, or a misconfiguration would silently reject every
          // legitimate lecturer.
          logger.error(
            { status: response.status, url },
            'erp lookup: rejected our credentials - check ERP_API_KEY / ERP_AUTH_SCHEME',
          );
          return 'UNAVAILABLE';
        }

        if (!response.ok) {
          lastFailure = `HTTP ${response.status}`;
          if (isRetryableStatus(response.status)) {
            logger.warn({ status: response.status, attempt, staffNumber }, 'erp lookup: retrying');
            continue;
          }
          logger.error({ status: response.status, staffNumber }, 'erp lookup: unexpected status');
          return 'UNAVAILABLE';
        }

        const body: unknown = await response.json();
        const record = toStaffRecord(body, staffNumber);

        if (!record) {
          // A 200 we cannot parse is an integration fault, not proof of
          // absence, so it must not revoke the registration.
          logger.error({ staffNumber, body }, 'erp lookup: response could not be mapped');
          return 'UNAVAILABLE';
        }

        return record;
      } catch (error) {
        const isTimeout = error instanceof Error && error.name === 'TimeoutError';
        lastFailure = isTimeout ? 'timeout' : (error as Error).message;
        logger.warn({ err: error, attempt, staffNumber }, 'erp lookup: request failed');
      }
    }

    logger.error({ staffNumber, lastFailure }, 'erp lookup: exhausted retries');
    return 'UNAVAILABLE';
  }

  /** Test seam: drops memoised lookups between cases. */
  clearCache(): void {
    this.cache.clear();
  }
}

export const erpClient = new ErpHttpClient();
