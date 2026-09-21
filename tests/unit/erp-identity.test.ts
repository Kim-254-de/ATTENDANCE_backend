import { describe, expect, it } from 'vitest';
import { compareIdentity, namesMatch } from '../../src/integrations/erp/erp.identity.js';
import { toStaffRecord } from '../../src/integrations/erp/erp.mapper.js';
import type { ErpStaffRecord } from '../../src/integrations/erp/erp.types.js';

function record(overrides: Partial<ErpStaffRecord> = {}): ErpStaffRecord {
  return {
    erpStaffId: 'ERP-1',
    staffNumber: 'KSU/LEC/014',
    fullName: 'Peter Kamau Mwangi',
    email: 'p.mwangi@university.ac.ke',
    isActive: true,
    department: 'Computer Science',
    faculty: 'Science',
    title: 'Dr',
    raw: {},
    ...overrides,
  };
}

describe('namesMatch', () => {
  it('accepts an exact match', () => {
    expect(namesMatch('Peter Kamau Mwangi', 'Peter Kamau Mwangi')).toBe(true);
  });

  it('ignores case and surrounding whitespace', () => {
    expect(namesMatch('PETER KAMAU MWANGI', '  peter kamau mwangi  ')).toBe(true);
  });

  it('ignores honorifics held by the ERP', () => {
    expect(namesMatch('Dr. Peter Kamau Mwangi', 'Peter Kamau Mwangi')).toBe(true);
    expect(namesMatch('Prof Peter Mwangi', 'Peter Mwangi')).toBe(true);
  });

  it('tolerates a dropped middle name', () => {
    expect(namesMatch('Peter Kamau Mwangi', 'Peter Mwangi')).toBe(true);
  });

  it('tolerates reordered names', () => {
    expect(namesMatch('Mwangi Peter Kamau', 'Peter Kamau Mwangi')).toBe(true);
  });

  it('ignores accents and punctuation', () => {
    expect(namesMatch("Peter O'Brien-Mwangí", 'Peter OBrien Mwangi')).toBe(false);
    expect(namesMatch('Peter Mwangí', 'Peter Mwangi')).toBe(true);
  });

  it('rejects a different person who shares a surname', () => {
    expect(namesMatch('Peter Kamau Mwangi', 'James Otieno Mwangi')).toBe(false);
  });

  it('rejects a single shared token as too weak', () => {
    expect(namesMatch('Peter Kamau Mwangi', 'Mwangi Otieno')).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(namesMatch('', 'Peter Mwangi')).toBe(false);
    expect(namesMatch('Peter Mwangi', '   ')).toBe(false);
  });
});

describe('compareIdentity', () => {
  it('reports no mismatch when name and email agree', () => {
    const result = compareIdentity(record(), {
      fullName: 'Peter Kamau Mwangi',
      email: 'p.mwangi@university.ac.ke',
    });
    expect(result).toEqual([]);
  });

  it('flags a mismatched email', () => {
    const result = compareIdentity(record(), {
      fullName: 'Peter Kamau Mwangi',
      email: 'someone.else@university.ac.ke',
    });
    expect(result).toEqual(['email']);
  });

  it('flags a mismatched name', () => {
    const result = compareIdentity(record(), {
      fullName: 'James Otieno',
      email: 'p.mwangi@university.ac.ke',
    });
    expect(result).toEqual(['fullName']);
  });

  it('does not flag email when the ERP holds none', () => {
    const result = compareIdentity(record({ email: null }), {
      fullName: 'Peter Kamau Mwangi',
      email: 'anything@university.ac.ke',
    });
    expect(result).toEqual([]);
  });
});

describe('toStaffRecord', () => {
  it('maps a flat payload', () => {
    const mapped = toStaffRecord(
      {
        id: 4021,
        staffNumber: 'KSU/LEC/014',
        fullName: 'Peter Kamau Mwangi',
        email: 'P.Mwangi@University.ac.ke',
        isActive: true,
        department: 'Computer Science',
      },
      'KSU/LEC/014',
    );

    expect(mapped).toMatchObject({
      erpStaffId: '4021',
      staffNumber: 'KSU/LEC/014',
      fullName: 'Peter Kamau Mwangi',
      email: 'p.mwangi@university.ac.ke',
      isActive: true,
    });
  });

  it('unwraps a data envelope', () => {
    const mapped = toStaffRecord(
      { data: { staff_id: 7, name: 'Jane Wanjiru', staff_number: 'KSU/LEC/020' } },
      'KSU/LEC/020',
    );
    expect(mapped?.fullName).toBe('Jane Wanjiru');
    expect(mapped?.erpStaffId).toBe('7');
  });

  it('composes a name from parts', () => {
    const mapped = toStaffRecord({ firstName: 'Jane', lastName: 'Wanjiru' }, 'KSU/LEC/020');
    expect(mapped?.fullName).toBe('Jane Wanjiru');
  });

  it('reads an inactive status string', () => {
    const mapped = toStaffRecord({ name: 'Jane Wanjiru', status: 'RETIRED' }, 'KSU/LEC/020');
    expect(mapped?.isActive).toBe(false);
  });

  it.each(['left', 'suspended', 'discontinued'])('treats status "%s" as no longer serving', (status) => {
    const record = toStaffRecord({ staffNumber: 'STF/0005', fullName: 'Samuel Kiptoo', status }, 'STF/0005');
    expect(record?.isActive).toBe(false);
  });

  it('maps the mock ERP payload (bare record, title kept separate from the name)', () => {
    const record = toStaffRecord(
      { staffNumber: 'STF/0001', fullName: 'Peter Kamami', email: 'peter.kamami@uni.ac.ke', department: 'Computer Science', faculty: 'School of Computing', title: 'Dr.', status: 'active' },
      'STF/0001',
    );
    expect(record).toMatchObject({ fullName: 'Peter Kamami', isActive: true, department: 'Computer Science', faculty: 'School of Computing', title: 'Dr.' });
  });

  it('treats a missing status as active', () => {
    const mapped = toStaffRecord({ name: 'Jane Wanjiru' }, 'KSU/LEC/020');
    expect(mapped?.isActive).toBe(true);
  });

  it('returns null when there is no usable name', () => {
    expect(toStaffRecord({ id: 9 }, 'KSU/LEC/020')).toBeNull();
    expect(toStaffRecord('not json at all', 'KSU/LEC/020')).toBeNull();
  });
});
