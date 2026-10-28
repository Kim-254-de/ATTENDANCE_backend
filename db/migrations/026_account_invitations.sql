-- Invitations for accounts nobody registers themselves: administrators,
-- faculty officers and department officers (src/modules/auth/auth.invitation.ts).
--
-- The invited account is created straight away, PENDING_VERIFICATION and with
-- no usable password, so its faculty or department is fixed by whoever sent
-- the invitation. Following the emailed link sets the password and makes it
-- ACTIVE: owning the mailbox is what verifies the account. Nobody else ever
-- sees or sets the password.
--
-- As with password_reset_tokens, only the SHA-256 hash of the token is kept;
-- the plaintext exists only inside the email.
-- Apply with `npm run db:migrate`.

CREATE TABLE IF NOT EXISTS account_invitations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash          VARCHAR(64) NOT NULL UNIQUE,            -- SHA-256 hex
  invited_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  consumed_at         TIMESTAMPTZ,                            -- set when the password is chosen
  -- Set when the invitation is re-sent or withdrawn, so only the newest link works.
  invalidated_at      TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS account_invitations_user_idx
  ON account_invitations (user_id, created_at DESC);
