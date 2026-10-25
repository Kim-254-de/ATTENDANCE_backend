import { AppError, ErrorCode } from '../../common/errors/index.js';
import { hashPassword } from '../../common/utils/password.js';
import { generateToken, hashToken } from '../../common/utils/tokens.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { transaction } from '../../db/database.js';
import { auditService } from '../audit/index.js';
import { notificationService } from '../notification/index.js';
import * as repo from './auth.invitation.repository.js';
import type { InvitationScope, InvitedRole, OfficerRow } from './auth.invitation.repository.js';
import type { RegistrationContext } from './auth.service.js';
import { smartttAccountsEnabled } from './auth.smarttt.js';

/**
 * Accounts nobody registers themselves: administrators, management,
 * department officers and QA officers. There is nothing to verify such a
 * person against (no ERP staff record, no SMARTTT account), so an
 * administrator vouches for them by inviting them (src/modules/admin).
 *
 * The invitation creates the account at once, scoped and PENDING_VERIFICATION
 * with no usable password, and emails a single-use link. Following it, the
 * invitee chooses their own password and the account becomes ACTIVE. No
 * password is ever chosen, seen or sent by anyone else.
 *
 * Callers check who may invite whom before calling in.
 */

export interface Inviter {
  userId: string | null;
  fullName: string | null;
}

export interface InvitationResult {
  userId: string;
  /** False when the account was created but the email could not be sent; re-send it. */
  emailSent: boolean;
}

const ROLE_LABEL: Record<InvitedRole, string> = {
  ADMIN: 'an administrator',
  MANAGEMENT: 'a member of management',
  DEPARTMENT: 'department officer',
  QA: 'quality assurance officer',
  TIMETABLING: 'a member of the timetabling office (the Timetable Generator)',
};

/** Only these domains may be invited, when OFFICER_EMAIL_DOMAINS lists any. */
export function assertAllowedEmail(email: string): void {
  const allowed = env.OFFICER_EMAIL_DOMAINS;
  if (allowed.length === 0) return;
  const domain = email.slice(email.lastIndexOf('@') + 1);
  if (!allowed.includes(domain)) {
    throw AppError.badRequest(`Invitations can only be sent to ${allowed.map((d) => `@${d}`).join(' or ')} addresses.`);
  }
}

/**
 * Invites someone. A deactivated account of the same role with this email is
 * re-opened (the person is returning to the post) rather than refused;
 * any other existing account is a 409.
 */
const ADMINS_IN_SMARTTT =
  'Administrators sign in with their SMARTTT account. Give the person staff status in SMARTTT (a non-teaching account), and they can sign in here straight away.';

/**
 * With SMARTTT accounts on, administrators are SMARTTT's administrators
 * (auth.smarttt.ts signInAdministrator): none is invited, re-invited or set
 * up with a password here. Management, department and QA officers still are.
 */
function assertInvitable(role: string): void {
  if (role === 'ADMIN' && smartttAccountsEnabled()) {
    throw new AppError(409, ErrorCode.ACCOUNTS_MANAGED_BY_SMARTTT, ADMINS_IN_SMARTTT);
  }
}

export async function invite(
  args: { email: string; fullName: string; scope: InvitationScope; scopeName: string | null },
  inviter: Inviter,
  context: RegistrationContext,
  /**
   * For the command-line bootstrap only (src/cli/invite-admin.ts), so an
   * operator without an email provider can still hand over the link. Never
   * wired to an HTTP response.
   */
  onLink?: (url: string) => void,
): Promise<InvitationResult> {
  assertInvitable(args.scope.role);
  assertAllowedEmail(args.email);

  const existing = await repo.findAccountByEmail(args.email);
  if (existing && !(existing.role === args.scope.role && existing.status === 'DEACTIVATED')) {
    throw AppError.conflict(
      existing.status === 'PENDING_VERIFICATION' && existing.role === args.scope.role
        ? 'This person has already been invited. Re-send the invitation instead.'
        : 'Someone already has an account with this email address.',
      ErrorCode.ACCOUNT_ALREADY_EXISTS,
    );
  }

  const token = generateToken();
  const userId = await transaction(async (client) => {
    const id = existing
      ? (await repo.reopenInvitedAccount(client, { userId: existing.userId, fullName: args.fullName, scope: args.scope }), existing.userId)
      : await repo.createInvitedAccount(client, { email: args.email, fullName: args.fullName, scope: args.scope });
    await repo.issueInvitation(client, { userId: id, tokenHash: token.tokenHash, expiresAt: expiry(), invitedByUserId: inviter.userId });
    await auditService.recordInTransaction(client, {
      action: 'OFFICER_INVITED',
      outcome: 'SUCCESS',
      userId: id,
      subjectEmail: args.email,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { ...args.scope, invitedByUserId: inviter.userId, reopened: Boolean(existing) },
    });
    return id;
  });

  onLink?.(invitationUrl(token.token));
  const emailSent = await sendInvitation({ to: args.email, fullName: args.fullName, token: token.token, role: args.scope.role, scopeName: args.scopeName, inviter });
  return { userId, emailSent };
}

/** Sends a pending invitation again with a fresh link; the old link stops working. */
export async function resend(officer: OfficerRow, inviter: Inviter, context: RegistrationContext): Promise<InvitationResult> {
  assertInvitable(officer.role);
  if (officer.status !== 'PENDING_VERIFICATION') {
    throw AppError.conflict(
      officer.status === 'ACTIVE' ? 'This person has already accepted their invitation.' : 'This account has been deactivated. Invite them again instead.',
    );
  }
  const token = generateToken();
  await transaction(async (client) => {
    await repo.issueInvitation(client, { userId: officer.userId, tokenHash: token.tokenHash, expiresAt: expiry(), invitedByUserId: inviter.userId });
    await auditService.recordInTransaction(client, {
      action: 'OFFICER_INVITATION_RESENT',
      outcome: 'SUCCESS',
      userId: officer.userId,
      subjectEmail: officer.email,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { invitedByUserId: inviter.userId },
    });
  });
  const emailSent = await sendInvitation({
    to: officer.email,
    fullName: officer.fullName,
    token: token.token,
    role: officer.role,
    scopeName: officer.departmentName,
    inviter,
  });
  return { userId: officer.userId, emailSent };
}

export type BootstrapOutcome = 'ADMIN_EXISTS' | 'INVITED' | 'RESENT' | 'INVITATION_PENDING' | 'EMAIL_FAILED' | 'MANAGED_BY_SMARTTT';

/**
 * Invites the first administrator from BOOTSTRAP_ADMIN_EMAIL / _NAME, for
 * hosts with no shell to run `npm run admin:invite` on (Render's free plan).
 *
 * Runs at every boot (server.ts), so it must be safe to repeat: it does
 * nothing once any administrator is ACTIVE, nor while the invitation it sent
 * is still usable, so a free instance waking every few minutes sends no mail.
 * An expired invitation is re-sent at the next boot, and one whose email
 * failed is withdrawn so the next boot tries again.
 */
export async function bootstrapAdmin(email: string, fullName: string): Promise<BootstrapOutcome> {
  // Administrators come from SMARTTT: the first one simply signs in.
  if (smartttAccountsEnabled()) return 'MANAGED_BY_SMARTTT';
  if (await repo.hasActiveAdmin()) return 'ADMIN_EXISTS';

  const inviter: Inviter = { userId: null, fullName: null };
  const context: RegistrationContext = { ipAddress: null, userAgent: 'boot/bootstrap-admin', requestId: `boot-${Date.now()}` };
  const existing = await repo.findAccountByEmail(email);

  let result: InvitationResult;
  let outcome: 'INVITED' | 'RESENT';
  if (existing?.role === 'ADMIN' && existing.status === 'PENDING_VERIFICATION') {
    const [pending] = await repo.listOfficers({ roles: ['ADMIN'], userId: existing.userId });
    if (!pending) throw new Error(`pending administrator ${existing.userId} not found`);
    if (pending.invitationExpiresAt && pending.invitationExpiresAt > new Date()) return 'INVITATION_PENDING';
    result = await resend(pending, inviter, context);
    outcome = 'RESENT';
  } else {
    // A new account, or a deactivated administrator re-opened. Any other
    // account holding this email is refused by invite() with a 409.
    result = await invite({ email, fullName, scope: { role: 'ADMIN' }, scopeName: null }, inviter, context);
    outcome = 'INVITED';
  }

  if (!result.emailSent) {
    await repo.withdrawInvitations(result.userId);
    return 'EMAIL_FAILED';
  }
  return outcome;
}

/** Removes an officer's access at once: signed out everywhere, any pending invitation withdrawn. */
export async function deactivate(officer: OfficerRow, actorUserId: string, context: RegistrationContext): Promise<void> {
  if (officer.userId === actorUserId) throw AppError.badRequest('You cannot remove your own access.');
  if (!(await repo.deactivateAccount(officer.userId))) throw AppError.conflict('This account is already deactivated.');
  await auditService.record({
    action: 'OFFICER_DEACTIVATED',
    outcome: 'SUCCESS',
    userId: officer.userId,
    subjectEmail: officer.email,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { role: officer.role, actorUserId },
  });
}

export interface InvitationDetails {
  fullName: string;
  email: string;
  role: Lowercase<InvitedRole>;
  scopeName: string | null;
  expiresAt: string;
  /** Where to sign in afterwards when it isn't attendance's staff page: the Generator, for the timetabling office. */
  signInUrl: string | null;
}

const invalidLink = () =>
  AppError.badRequest('This invitation link is invalid, has expired or has already been used. Ask whoever invited you to send it again.');

/** A usable invitation by its token, or the same 400 for every reason it is not. */
async function usableInvitation(token: string): Promise<repo.StoredInvitation> {
  const stored = await repo.findInvitation(hashToken(token));
  if (!stored || stored.consumedAt || stored.invalidatedAt || stored.expiresAt <= new Date() || stored.status !== 'PENDING_VERIFICATION') {
    throw invalidLink();
  }
  assertInvitable(stored.role);
  return stored;
}

/** POST /auth/invitations/lookup — who the link is for, so the page can greet them before they choose a password. */
export async function lookup(token: string): Promise<InvitationDetails> {
  const stored = await usableInvitation(token);
  return {
    fullName: stored.fullName,
    email: stored.email,
    role: stored.role.toLowerCase() as InvitationDetails['role'],
    scopeName: stored.scopeName,
    expiresAt: stored.expiresAt.toISOString(),
    // The timetabling office signs in at the Generator; the page links there once the password is set.
    signInUrl: stored.role === 'TIMETABLING' ? generatorSignInUrl() : null,
  };
}

/** POST /auth/invitations/accept — sets the password; the account is ACTIVE and can sign in. */
export async function accept(token: string, password: string, context: RegistrationContext): Promise<{ email: string }> {
  const stored = await usableInvitation(token);
  const accepted = await repo.acceptInvitation({ invitationId: stored.id, userId: stored.userId, passwordHash: await hashPassword(password) });
  if (!accepted) throw invalidLink();
  await auditService.record({
    action: 'OFFICER_INVITATION_ACCEPTED',
    outcome: 'SUCCESS',
    userId: stored.userId,
    subjectEmail: stored.email,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });
  return { email: stored.email };
}

export const officerDto = (r: OfficerRow) => ({
  userId: r.userId,
  role: r.role.toLowerCase() as Lowercase<InvitedRole>,
  fullName: r.fullName,
  email: r.email,
  status: r.status,
  departmentId: r.departmentId,
  departmentName: r.departmentName,
  invitedAt: r.invitedAt?.toISOString() ?? null,
  invitationExpiresAt: r.invitationExpiresAt?.toISOString() ?? null,
  lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
});
export type OfficerDto = ReturnType<typeof officerDto>;

export const invitationUrl = (token: string) =>
  `${env.APP_PUBLIC_URL.replace(/\/+$/, '')}/accept-invite?token=${encodeURIComponent(token)}`;

/** Where the timetabling office signs in: the Generator's web app. */
export const generatorSignInUrl = (): string | null => (env.GENERATOR_WEB_URL ?? env.GENERATOR_BASE_URL ?? null)?.replace(/\/+$/, '') ?? null;

const expiry = () => new Date(Date.now() + env.OFFICER_INVITE_TTL_HOURS * 60 * 60 * 1000);

/**
 * Sends the email. A failure leaves the account and its invitation in place
 * (the inviter re-sends), so it is reported, not thrown.
 */
async function sendInvitation(args: {
  to: string; fullName: string; token: string; role: InvitedRole; scopeName: string | null; inviter: Inviter;
}): Promise<boolean> {
  const roleDescription = args.scopeName ? `${ROLE_LABEL[args.role]} for ${args.scopeName}` : ROLE_LABEL[args.role];
  try {
    await notificationService.sendOfficerInvitation({
      to: args.to,
      fullName: args.fullName,
      token: args.token,
      roleDescription,
      invitedByName: args.inviter.fullName,
      expiresInHours: env.OFFICER_INVITE_TTL_HOURS,
      // The timetabling office signs in at the Generator, not here.
      ...(args.role === 'TIMETABLING' ? { signIn: { where: 'the Timetable Generator', url: generatorSignInUrl() } } : {}),
    });
    return true;
  } catch (error) {
    logger.error({ err: error, to: args.to }, 'invitation email failed to send');
    return false;
  }
}
