import { hash, verify, Algorithm } from '@node-rs/argon2';
import { env } from '../../config/env.js';

/**
 * Argon2id password hashing (README section 4.1: never store plaintext).
 *
 * @node-rs/argon2 ships prebuilt binaries, so there is no node-gyp/C++ build
 * toolchain requirement on developer machines or in CI.
 */

const options = {
  algorithm: Algorithm.Argon2id,
  memoryCost: env.ARGON2_MEMORY_COST,
  timeCost: env.ARGON2_TIME_COST,
  parallelism: env.ARGON2_PARALLELISM,
};

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, options);
}

export async function verifyPassword(plaintext: string, passwordHash: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plaintext, options);
  } catch {
    // A malformed or truncated hash must read as "wrong password", not as a
    // server error that would tell an attacker the record is corrupt.
    return false;
  }
}

/**
 * Burn roughly the same CPU as a real verification. Called on sign-in when the
 * account does not exist, so response timing does not reveal which emails are
 * registered.
 */
export async function fakeVerifyPassword(): Promise<void> {
  await hash('timing-equalisation-placeholder', options);
}
