import { describe, expect, it } from 'vitest';
import { classify, rateOf } from '../../src/modules/eligibility/eligibility.service.js';

describe('exam eligibility classification', () => {
  const policy = { minAttendancePercent: 75, atRiskMarginPercent: 10 };

  it('does not judge a student before any class has been held', () => {
    expect(classify(0, 0, policy)).toBe('NOT_YET_MEASURED');
  });

  it('puts exactly the minimum in at risk, not below', () => {
    expect(classify(3, 4, policy)).toBe('AT_RISK');
    expect(classify(2, 4, policy)).toBe('NOT_ELIGIBLE');
  });

  it('is eligible from minimum + margin upwards', () => {
    expect(classify(17, 20, policy)).toBe('ELIGIBLE'); // 85%
    expect(classify(16, 20, policy)).toBe('AT_RISK'); // 80%
  });

  it('compares the unrounded ratio, so 2 of 3 meets a two-thirds rule', () => {
    expect(classify(2, 3, { minAttendancePercent: 66.66, atRiskMarginPercent: 0 })).toBe('ELIGIBLE');
    expect(rateOf(2, 3)).toBe(66.7);
  });

  it('with no margin, nobody is at risk', () => {
    expect(classify(3, 4, { minAttendancePercent: 75, atRiskMarginPercent: 0 })).toBe('ELIGIBLE');
  });
});
