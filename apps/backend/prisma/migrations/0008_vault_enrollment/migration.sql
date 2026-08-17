-- Wrapped key material so a user can decrypt their own snapshots on a new machine.
--
-- The Team Data Key is stored wrapped TWICE — under an Argon2id key from the account password, and
-- under one from a printed recovery code — so the server holds no key it can open. Separate salts are
-- deliberate: a shared salt would relate the two wrapping keys, and a password change would silently
-- invalidate the recovery code.
--
-- The Argon2id cost is stored per row so parameters can be raised later without stranding anyone: an
-- unlock has to use the cost its own wrap was created with.
CREATE TABLE "vault_enrollments" (
    "userId"             TEXT NOT NULL,
    "passwordSalt"       BYTEA NOT NULL,
    "recoverySalt"       BYTEA NOT NULL,
    "wrappedByPassword"  BYTEA NOT NULL,
    "wrappedByRecovery"  BYTEA NOT NULL,
    "keyFingerprint"     TEXT NOT NULL,
    "argonMemoryKiB"     INTEGER NOT NULL,
    "argonIterations"    INTEGER NOT NULL,
    "argonParallelism"   INTEGER NOT NULL,
    "enrolledAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recoveryCodeUsedAt" TIMESTAMP(3),
    "rotatedAt"          TIMESTAMP(3),
    CONSTRAINT "vault_enrollments_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "vault_enrollments" ADD CONSTRAINT "vault_enrollments_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
