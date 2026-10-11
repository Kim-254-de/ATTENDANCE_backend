/* eslint-disable no-console -- a command-line tool: the terminal is its output. */
/**
 * Invites an administrator from the command line: how the very first one is
 * created, since only an administrator can invite another in the admin console.
 *
 *   npm run admin:invite -- someone@university.ac.ke "Jane Wanjiru"      (production: after `npm run build`)
 *   npm run dev:invite-admin -- someone@university.ac.ke "Jane Wanjiru"  (development)
 *
 * It sends the same invitation email the console does (auth.invitation.ts):
 * the invitee chooses their own password, so nobody running this ever knows
 * it. Without an email provider (development only), the link is printed.
 * Safe in production — unlike the dev seed scripts, it sets no password.
 */
import { env, isProduction } from '../config/env.js';
import { closeDatabase } from '../db/database.js';
import { emailSchema, fullNameSchema } from '../modules/auth/auth.schema.js';
import { invite } from '../modules/auth/auth.invitation.js';

async function main(): Promise<number> {
  const [rawEmail, ...nameParts] = process.argv.slice(2);
  const email = emailSchema.safeParse(rawEmail ?? '');
  const fullName = fullNameSchema.safeParse(nameParts.join(' '));
  if (!email.success || !fullName.success) {
    console.error('Usage: npm run admin:invite -- <email> "<full name>"');
    if (rawEmail && !email.success) console.error(`  email: ${email.error.issues[0]?.message}`);
    if (nameParts.length > 0 && !fullName.success) console.error(`  name: ${fullName.error.issues[0]?.message}`);
    return 1;
  }

  const printLink = !isProduction && !env.RESEND_API_KEY;
  const result = await invite(
    { email: email.data, fullName: fullName.data, scope: { role: 'ADMIN' }, scopeName: null },
    { userId: null, fullName: null },
    { ipAddress: null, userAgent: 'cli/invite-admin', requestId: `cli-${Date.now()}` },
    printLink ? (url) => console.log(`No email provider configured; give ${email.data} this link:\n  ${url}`) : undefined,
  );
  console.log(
    result.emailSent
      ? `Invitation sent to ${email.data}. It expires in ${env.OFFICER_INVITE_TTL_HOURS} hours.`
      : `The account was created but the email could not be sent. Run this again later, or re-send it from the admin console.`,
  );
  return 0;
}

main()
  .then(async (code) => {
    await closeDatabase();
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await closeDatabase().catch(() => undefined);
    process.exit(1);
  });
