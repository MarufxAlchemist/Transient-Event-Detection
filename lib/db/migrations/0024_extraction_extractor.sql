-- 0024_extraction_extractor.sql
-- Routes an extraction row to the worker that owns it.
--
-- WHY A ROUTING COLUMN AT ALL
-- ---------------------------
-- Priority #8 adds a SECOND, independent extraction alongside the Gemini one:
-- astro-colibri-circular-parser's OpenAI photometry extraction. Both write to
-- core.circular_extractions, and they coexist without conflict because
-- content_hash already includes the model name, so the two rows for one
-- circular hash differently.
--
-- What they cannot share is a queue. extractionWorker.ts claims rows with
-- `WHERE status = 'pending'` and nothing else, then drains them SEQUENTIALLY.
-- The OpenAI provider's worst case is retries+1 attempts x timeout per model —
-- 366 s on the package's defaults, against Gemini's 45 s timeout. A shared
-- claim query would let one OpenAI job stall every Gemini job behind it in the
-- same batch. So each extractor gets its own worker, its own poll cadence, and
-- its own claim query filtered on this column.
--
-- `provider` could not be reused for this: it records what actually RAN and is
-- NULL on pending rows, which is precisely the state a claim query must filter.
--
-- WHY A CHECK CONSTRAINT, NOT BARE TEXT
-- -------------------------------------
-- A free-text column risks a typo silently creating a third, unclaimed queue:
-- 'astro-colibri-openia' inserts without error, no worker's claim query ever
-- matches it, and the row sits pending forever with nothing to indicate why.
-- A checked enum fails loudly at insert instead — the same protection
-- chk_extraction_status (migration 0019, widened in 0023) gives the status
-- column.
--
-- WHY DEFAULT 'gemini'
-- --------------------
-- Every existing row was produced by the Gemini path, which is the only
-- extractor that has ever run here, so the default backfills them correctly.
-- The default is for those historical rows only: enqueueExtraction sets
-- `extractor` explicitly from today on, because a default that happens to be
-- right is a landmine the day a third extractor is added and nobody updates it.
--
-- Idempotent: safe to re-run.

ALTER TABLE core.circular_extractions
  ADD COLUMN IF NOT EXISTS extractor text DEFAULT 'gemini' NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_extraction_extractor') THEN
    ALTER TABLE core.circular_extractions ADD CONSTRAINT chk_extraction_extractor
      CHECK (extractor IN ('gemini', 'astro-colibri-openai'));
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS circular_extractions_extractor_due_idx
  ON core.circular_extractions (extractor, status, next_attempt_at, created_at)
  WHERE status IN ('pending', 'processing');
--> statement-breakpoint
COMMENT ON COLUMN core.circular_extractions.extractor IS
  'Which extractor owns this row, and therefore which worker claims it: '
  '"gemini" (services/ai/circular-extraction-agent.ts) or '
  '"astro-colibri-openai" (the Python parse_circular endpoint). Constrained by '
  'chk_extraction_extractor so a typo cannot create an unclaimed queue.';
