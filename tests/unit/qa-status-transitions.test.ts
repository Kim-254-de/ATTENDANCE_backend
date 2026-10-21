import { describe, expect, it } from 'vitest';
import { canTransitionAuditStatus } from '../../src/modules/quality-assurance/audit.service.js';
import { canTransitionCapaStatus } from '../../src/modules/quality-assurance/capa.service.js';

/**
 * Forward-only status machines, exhaustively checked over every (from, to)
 * pair rather than just the happy path — a skipped or backward transition is
 * exactly the kind of bug that is easy to introduce later and easy to miss
 * in an integration test that only exercises the intended sequence.
 */

describe('canTransitionAuditStatus', () => {
  const STATUSES = ['PLANNED', 'IN_PROGRESS', 'COMPLETED'] as const;
  const ALLOWED = new Set(['PLANNED->IN_PROGRESS', 'IN_PROGRESS->COMPLETED']);

  it.each(STATUSES.flatMap((from) => STATUSES.map((to) => [from, to] as const)))(
    '%s -> %s',
    (from, to) => {
      expect(canTransitionAuditStatus(from, to)).toBe(ALLOWED.has(`${from}->${to}`));
    },
  );

  it('rejects an unknown status on either side', () => {
    expect(canTransitionAuditStatus('PLANNED', 'BOGUS')).toBe(false);
    expect(canTransitionAuditStatus('BOGUS', 'PLANNED')).toBe(false);
  });
});

describe('canTransitionCapaStatus', () => {
  const STATUSES = ['OPEN', 'IN_PROGRESS', 'VERIFIED', 'CLOSED'] as const;
  const ALLOWED = new Set(['OPEN->IN_PROGRESS', 'IN_PROGRESS->VERIFIED', 'VERIFIED->CLOSED']);

  it.each(STATUSES.flatMap((from) => STATUSES.map((to) => [from, to] as const)))(
    '%s -> %s',
    (from, to) => {
      expect(canTransitionCapaStatus(from, to)).toBe(ALLOWED.has(`${from}->${to}`));
    },
  );

  it('rejects an unknown status on either side', () => {
    expect(canTransitionCapaStatus('OPEN', 'BOGUS')).toBe(false);
    expect(canTransitionCapaStatus('BOGUS', 'OPEN')).toBe(false);
  });
});
