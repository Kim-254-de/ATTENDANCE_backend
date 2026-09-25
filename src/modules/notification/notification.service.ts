import { logger } from '../../config/logger.js';
import { env, isProduction } from '../../config/env.js';

/**
 * Outbound notifications (README section 6: "Notification module").
 *
 * No email provider is wired up yet. Until one is chosen, delivery is logged
 * rather than sent, and the verification link is printed in non-production so
 * the registration flow is testable end to end.
 *
 * To go live, implement `deliver()` against the chosen provider (SMTP via
 * Nodemailer, SendGrid, SES...). Nothing else in the codebase changes.
 */

export interface EmailVerificationMessage {
  to: string;
  fullName: string;
  /** Plaintext token. Only ever leaves the system inside this email. */
  token: string;
}

interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
}

export async function sendEmailVerification(message: EmailVerificationMessage): Promise<void> {
  const verificationUrl = buildVerificationUrl(message.token);

  await deliver({
    to: message.to,
    subject: 'Confirm your Smart Attendance account',
    text: [
      `Hello ${message.fullName},`,
      '',
      'Your lecturer account has been created and your staff number has been verified',
      'against the institutional staff records.',
      '',
      'Confirm your email address to continue:',
      verificationUrl,
      '',
      'If you did not request this account, you can ignore this message.',
    ].join('\n'),
  });
}

export interface PasswordResetMessage {
  to: string;
  fullName: string;
  /** Plaintext token. Only ever leaves the system inside this email. */
  token: string;
  expiresInMinutes: number;
}

export async function sendPasswordReset(message: PasswordResetMessage): Promise<void> {
  await deliver({
    to: message.to,
    subject: 'Reset your Smart Attendance password',
    text: [
      `Hello ${message.fullName},`,
      '',
      'We received a request to reset the password on your Smart Attendance account.',
      '',
      'Choose a new password here:',
      buildResetUrl(message.token),
      '',
      `This link expires in ${message.expiresInMinutes} minutes and can only be used once.`,
      '',
      'If you did not request this, you can ignore this message - your password has',
      'not changed, and nobody can use the link without access to this mailbox.',
    ].join('\n'),
  });
}

export interface PasswordChangedMessage {
  to: string;
  fullName: string;
}

/**
 * Sent after a successful reset. This is how an account holder learns that
 * somebody else reset their password, so it goes out even though the user who
 * performed the reset already knows.
 */
export async function sendPasswordChanged(message: PasswordChangedMessage): Promise<void> {
  await deliver({
    to: message.to,
    subject: 'Your Smart Attendance password was changed',
    text: [
      `Hello ${message.fullName},`,
      '',
      'Your password has just been changed and you have been signed out on every device.',
      '',
      'If this was you, nothing further is needed.',
      '',
      'If it was NOT you, contact the ICT office immediately - somebody else has',
      'access to this mailbox or to your account.',
    ].join('\n'),
  });
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface UnitVerificationRequestMessage {
  to: string;
  adminName: string;
  unitCode: string;
  unitName: string;
  lecturerName: string;
  /** The unit's issued weekly meeting slot. 0=Sunday..6=Saturday, matches JS Date#getDay(). */
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

/**
 * A lecturer added a unit whose code exists on the issued timetable (checked
 * automatically against the ERP), but the timetable does not list this
 * lecturer as the one assigned to teach it — so an administrator is asked to
 * confirm the lecturer-unit assignment by hand before it can be used to
 * activate a class (unit.service.ts createUnit / session.service.ts createSession).
 */
export async function sendUnitVerificationRequest(message: UnitVerificationRequestMessage): Promise<void> {
  await deliver({
    to: message.to,
    subject: `Confirm lecturer assignment: ${message.unitCode}`,
    text: [
      `Hello ${message.adminName},`,
      '',
      `${message.lecturerName} added a unit that exists on the timetable, but the timetable`,
      "does not list them as its assigned lecturer. Please confirm they're allocated to teach it:",
      '',
      `  ${message.unitCode} — ${message.unitName}`,
      `  ${DAY_NAMES[message.dayOfWeek]} ${message.startTime}–${message.endTime}`,
      '',
      'No classes can be activated for this unit until the assignment is confirmed.',
    ].join('\n'),
  });
}

function buildResetUrl(token: string): string {
  const base = env.APP_PUBLIC_URL;
  return `${base.replace(/\/+$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
}

function buildVerificationUrl(token: string): string {
  const base = env.APP_PUBLIC_URL;
  return `${base.replace(/\/+$/, '')}/verify-email?token=${encodeURIComponent(token)}`;
}

async function deliver(email: OutboundEmail): Promise<void> {
  if (isProduction) {
    // Fail loudly rather than silently dropping mail in production.
    throw new Error(
      'No email provider is configured. Implement deliver() in notification.service.ts.',
    );
  }

  logger.info(
    { to: email.to, subject: email.subject },
    'email not sent (no provider configured) - body follows',
  );
  logger.debug({ body: email.text }, 'outbound email body');
  return Promise.resolve();
}
