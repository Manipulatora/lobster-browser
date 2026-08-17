-- Email verification.
-- Existing accounts are left NULL (unverified) rather than back-dated as verified: claiming an
-- address was proven when it never was would defeat the point of adding the check.
ALTER TABLE "users" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);

CREATE TABLE "email_verifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_verifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_verifications_tokenHash_key" ON "email_verifications"("tokenHash");
CREATE INDEX "email_verifications_userId_idx" ON "email_verifications"("userId");

ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
