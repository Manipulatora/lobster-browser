-- Replace the password-derived key custody with a plain server-held key.
--
-- The previous design wrapped a key under an Argon2id key from the account password and again under
-- a printed recovery code, so the server could not read profile data. The cost was that a forgotten
-- password together with a lost code destroyed every profile permanently — a worse outcome than the
-- risk it avoided, for an operator running their own server, and not how comparable products behave.
--
-- Signing in is now all a user needs, and a password reset costs them nothing.
--
-- Dropped outright rather than migrated: the feature never shipped, so there is nothing enrolled to
-- preserve. (A deployment that HAD enrolled users could not migrate anyway — the server cannot
-- unwrap what it was designed not to read.)
DROP TABLE IF EXISTS "vault_enrollments";

CREATE TABLE "vault_keys" (
    "userId"    TEXT NOT NULL,
    "dataKey"   BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "vault_keys_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "vault_keys" ADD CONSTRAINT "vault_keys_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
