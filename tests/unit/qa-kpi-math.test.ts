import { describe, expect, it } from 'vitest';
import { averageScore, fallbackScoreFor } from '../../src/modules/quality-assurance/kpi.service.js';

describe('fallbackScoreFor', () => {
  it('maps each rating to its fallback score', () => {
    expect(fallbackScoreFor('COMPLIANT')).toBe(100);
    expect(fallbackScoreFor('PARTIAL')).toBe(50);
    expect(fallbackScoreFor('NON_COMPLIANT')).toBe(0);
  });

  it('has no fallback for NOT_APPLICABLE -- callers must exclude it before averaging', () => {
    expect(fallbackScoreFor('NOT_APPLICABLE')).toBeNull();
  });
});

describe('averageScore', () => {
  it('is null for an empty list', () => {
    expect(averageScore([])).toBeNull();
  });

  it('uses each finding\'s own recorded score over the rating fallback', () => {
    expect(averageScore([{ rating: 'COMPLIANT', score: 60 }])).toBe(60);
  });

  it('falls back to the rating-implied score when none was recorded', () => {
    expect(averageScore([{ rating: 'COMPLIANT', score: null }, { rating: 'NON_COMPLIANT', score: null }])).toBe(50);
  });

  it('rounds to one decimal place', () => {
    // (100 + 50 + 0) / 3 = 50.0 exactly; pick values that do not divide evenly to prove rounding.
    const result = averageScore([
      { rating: 'COMPLIANT', score: null },
      { rating: 'COMPLIANT', score: null },
      { rating: 'NON_COMPLIANT', score: null },
    ]);
    expect(result).toBeCloseTo(66.7, 1);
  });

  it('a NOT_APPLICABLE finding mixed in has no fallback and is excluded from the average, not counted as 0', () => {
    const withNA = averageScore([
      { rating: 'COMPLIANT', score: null },
      { rating: 'NOT_APPLICABLE', score: null },
    ]);
    const withoutNA = averageScore([{ rating: 'COMPLIANT', score: null }]);
    expect(withNA).toBe(withoutNA);
    expect(withNA).toBe(100);
  });
});
