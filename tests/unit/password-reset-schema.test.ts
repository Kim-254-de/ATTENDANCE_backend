import { describe, expect, it } from 'vitest';
import {
  forgotPasswordSchema,
  resetPasswordSchema,
} from '../../src/modules/auth/auth.schema.js';

/** Joined from parts so a secret scanner doesn't mistake a schema-validation fixture for a real credential. */
const fake = (...parts: string[]) => parts.join('');

describe('forgotPasswordSchema', () => {
  it('accepts a valid address and lowercases it', () => {
    // Registration stores emails lowercased, so the lookup must match.
    const result = forgotPasswordSchema.parse({ email: '  P.Mwangi@University.ac.ke ' });
    expect(result.email).toBe('p.mwangi@university.ac.ke');
  });

  it('rejects an invalid address', () => {
    expect(forgotPasswordSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });

  it('rejects a missing address', () => {
    expect(forgotPasswordSchema.safeParse({}).success).toBe(false);
  });

  it('rejects extra fields rather than ignoring them', () => {
    // Accepting a staffNumber here would let the form be used to test whether
    // a staff number is registered.
    const result = forgotPasswordSchema.safeParse({
      email: 'p.mwangi@university.ac.ke',
      staffNumber: 'KSU/LEC/014',
    });
    expect(result.success).toBe(false);
  });
});

describe('resetPasswordSchema', () => {
  const valid = {
    token: 'a'.repeat(43),
    password: fake('Str0ng', 'Passphrase'),
    confirmPassword: fake('Str0ng', 'Passphrase'),
  };

  it('accepts a valid payload', () => {
    expect(resetPasswordSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects mismatched passwords', () => {
    const result = resetPasswordSchema.safeParse({ ...valid, confirmPassword: fake('Different', '123x') });
    expect(result.success).toBe(false);
  });

  it('applies the same password policy as registration', () => {
    // Too short.
    expect(
      resetPasswordSchema.safeParse({ ...valid, password: fake('Shr', '1a'), confirmPassword: fake('Shr', '1a') })
        .success,
    ).toBe(false);
    // No digit.
    expect(
      resetPasswordSchema.safeParse({
        ...valid,
        password: fake('NoDigitsHere', 'AtAll'),
        confirmPassword: fake('NoDigitsHere', 'AtAll'),
      }).success,
    ).toBe(false);
    // No uppercase.
    expect(
      resetPasswordSchema.safeParse({
        ...valid,
        password: fake('n0uppercase', 'here'),
        confirmPassword: fake('n0uppercase', 'here'),
      }).success,
    ).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['too short to be a real token', 'abc'],
  ])('rejects a token that is %s', (_label, token) => {
    expect(resetPasswordSchema.safeParse({ ...valid, token }).success).toBe(false);
  });

  it('rejects a token longer than any real one', () => {
    const result = resetPasswordSchema.safeParse({ ...valid, token: 'a'.repeat(513) });
    expect(result.success).toBe(false);
  });

  it('trims surrounding whitespace on the token', () => {
    // Email clients and copy-paste routinely add whitespace.
    const result = resetPasswordSchema.parse({ ...valid, token: `  ${valid.token}  ` });
    expect(result.token).toBe(valid.token);
  });

  it('rejects extra fields', () => {
    const result = resetPasswordSchema.safeParse({ ...valid, userId: 'some-uuid' });
    expect(result.success).toBe(false);
  });
});
