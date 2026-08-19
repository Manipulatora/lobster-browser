-- A settled deposit that is later refunded or charged back must give its Credit back.
--
-- Until now a `refunded`/`failed` IPN for a deposit that had already been credited only flipped the
-- row's status: the wallet kept the balance, so the user held both the returned crypto and the
-- Credit it minted. `reversedAt` is the exactly-once guard for the debit that undoes it, mirroring
-- `creditedAt` on the way in — the reversal claims the row by matching `reversedAt IS NULL`, so a
-- redelivered refund callback cannot debit the same wallet twice.
ALTER TABLE "deposits" ADD COLUMN "reversedAt" TIMESTAMP(3);

-- What the user asked to deposit, recorded when the address was issued. The credited amount comes
-- from the processor's payload, and without the request beside it there is nothing for a wrong
-- credit to be wrong against. NULL on existing rows, which is honest: it was never captured.
ALTER TABLE "deposits" ADD COLUMN "amountCents" INTEGER;

-- API-key authentication looks a key up by hash on every automation request; the table had an index
-- only on teamId, so each lookup — valid or sprayed — was a sequential scan.
CREATE INDEX "api_keys_hashedKey_idx" ON "api_keys"("hashedKey");
