import { fakeVerifyPassword, verifyPassword } from '../../common/utils/password.js';
import { env } from '../../config/env.js';
import { queryOne } from '../../db/database.js';
import type { AccountStatus } from '../../db/types.js';
import { auditService } from '../audit/index.js';
import { normaliseIdentifier } from './auth.login.service.js';
import * as repo from './auth.session.repository.js';
import type { RegistrationContext } from './auth.service.js';

/**
 * Sign-in for the Timetable Generator. The timetabling office (role
 * TIMETABLING) is invited by an administrator here like any other officer and
 * chooses a password from the invitation; the Generator asks here whether a
 * login is right and whether the account is still the timetabling office's,
 * the way it used to ask SMARTTT (POST /integrations/generator/authenticate,
 * GET .../identity, X-API-Key = GENERATOR_API_KEY).
 *
 * The same rules as attendance's own sign-in (auth.login.service.ts): the
 * same failure count and lock, the same answer for an unknown account and a
 * wrong password, and only ACTIVE accounts. Any active officer's correct
 * password is "authenticated", with `timetabling_office` saying whether they
 * may use the Generator, so the Generator can tell them why not.
 */

export interface GeneratorIdentity {
  account: { id: string; full_name: string; email: string; university_id: null };
  timetabling_office: boolean;
}

export type GeneratorAuthentication = ({ authenticated: true } & GeneratorIdentity) | { authenticated: false };

const identityOf = (u: { id: string; fullName: string; email: string; role: string }): GeneratorIdentity => ({
  account: { id: u.id, full_name: u.fullName, email: u.email, university_id: null },
  timetabling_office: u.role === 'TIMETABLING',
});

export async function authenticate(identifier: string, password: string, context: RegistrationContext): Promise<GeneratorAuthentication> {
  const id = normaliseIdentifier(identifier);
  const audit = { subjectEmail: id.includes('@') ? id : null, ipAddress: context.ipAddress, userAgent: context.userAgent, requestId: context.requestId };
  const fail = async (reason: string, userId?: string): Promise<GeneratorAuthentication> => {
    await auditService.record({ ...audit, userId: userId ?? null, action: 'LOGIN_FAILED', outcome: 'FAILURE', reason, metadata: { via: 'GENERATOR' } });
    return { authenticated: false };
  };

  const user = await repo.findAccountForLogin(id);
  if (!user) {
    await fakeVerifyPassword();
    return fail('unknown account');
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) return fail('account locked', user.id);
  if (!(await verifyPassword(password, user.passwordHash))) {
    const { lockedUntil } = await repo.recordFailedLogin(user.id, env.LOGIN_MAX_FAILED_ATTEMPTS, env.LOGIN_LOCKOUT_MINUTES);
    return fail(lockedUntil ? 'wrong password; account locked' : 'wrong password', user.id);
  }
  if (user.status !== 'ACTIVE') return fail(`account not active: ${user.status}`, user.id);

  await repo.recordSignInElsewhere(user.id);
  await auditService.record({ ...audit, subjectEmail: user.email, userId: user.id, action: 'LOGIN_SUCCEEDED', outcome: 'SUCCESS', metadata: { via: 'GENERATOR' } });
  return { authenticated: true, ...identityOf(user) };
}

/** Whether the account still may use the Generator: null once it is gone or no longer active. */
export async function identity(accountId: string): Promise<GeneratorIdentity | null> {
  const row = await queryOne<{ id: string; full_name: string; email: string; role: string; status: AccountStatus }>(
    `SELECT id, full_name, email, role, status FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [accountId],
  );
  if (!row || row.status !== 'ACTIVE') return null;
  return identityOf({ id: row.id, fullName: row.full_name, email: row.email, role: row.role });
}
