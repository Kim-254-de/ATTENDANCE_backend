import { describe, expect, it } from 'vitest';
import { lecturerRegistrationSchema } from '../../src/modules/auth/auth.schema.js';

/** Joined from parts so a secret scanner doesn't mistake a schema-validation fixture for a real credential. */
const fake = (...parts: string[]) => parts.join('');

const valid = {
  fullName: 'Peter Kamau Mwangi',
  email: 'P.Mwangi@University.ac.ke',
  staffNumber: 'ksu/lec/014',
  password: fake('Str0ng', 'Passphrase'),
  confirmPassword: fake('Str0ng', 'Passphrase'),
};

describe('lecturerRegistrationSchema', () => {
  it('accepts a valid payload and normalises it', () => {
    const result = lecturerRegistrationSchema.parse(valid);
    // Email lowercased and staff number uppercased, so casing cannot produce
    // two accounts for one person.
    expect(result.email).toBe('p.mwangi@university.ac.ke');
    expect(result.staffNumber).toBe('KSU/LEC/014');
  });

  it('collapses repeated whitespace in the name', () => {
    const result = lecturerRegistrationSchema.parse({ ...valid, fullName: 'Peter   Kamau  Mwangi' });
    expect(result.fullName).toBe('Peter Kamau Mwangi');
  });

  it('rejects mismatched passwords', () => {
    const result = lecturerRegistrationSchema.safeParse({ ...valid, confirmPassword: fake('Different', '123') });
    expect(result.success).toBe(false);
  });

  it('rejects a password shorter than 6 characters', () => {
    const result = lecturerRegistrationSchema.safeParse({
      ...valid,
      password: fake('Shr', '1a'),
      confirmPassword: fake('Shr', '1a'),
    });
    expect(result.success).toBe(false);
  });

  it('accepts a 6-character password with a lowercase letter, an uppercase letter and a digit', () => {
    const result = lecturerRegistrationSchema.safeParse({
      ...valid,
      password: fake('Abcde', '1'),
      confirmPassword: fake('Abcde', '1'),
    });
    expect(result.success).toBe(true);
  });

  it('rejects a password containing the staff number', () => {
    const password = fake('KSU/LEC/014aaa', 'A1');
    const result = lecturerRegistrationSchema.safeParse({
      ...valid,
      password,
      confirmPassword: password,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid email address', () => {
    expect(lecturerRegistrationSchema.safeParse({ ...valid, email: 'not-an-email' }).success).toBe(false);
  });

  it('rejects unknown fields rather than silently ignoring them', () => {
    const result = lecturerRegistrationSchema.safeParse({ ...valid, role: 'ADMIN' });
    expect(result.success).toBe(false);
  });

  it('rejects a staff number with illegal characters', () => {
    expect(lecturerRegistrationSchema.safeParse({ ...valid, staffNumber: 'KSU LEC 014' }).success).toBe(false);
  });
});
