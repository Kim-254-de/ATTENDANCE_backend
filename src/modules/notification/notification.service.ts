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
