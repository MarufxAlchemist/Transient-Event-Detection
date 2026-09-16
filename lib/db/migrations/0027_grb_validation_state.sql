-- 0027_grb_validation_state.sql
-- Records WHICH validation checks ran against a fit, not merely which ones fired.
--
-- WHY THE FLAG TABLE ALONE CANNOT ANSWER THIS
-- -------------------------------------------
-- A validation check that passes writes no row. So core.grb_validation_flags
-- can say "something objected" but never "nothing objected" — an empty flag
-- list is indistinguishable from a fit nothing has ever looked at.
--
-- The API had to infer `evaluated` from `flags.length > 0`, which collapses two
-- opposite meanings into one:
--
--   no flags, never evaluated   -> "we have no idea whether this fit is sound"
--   no flags, fully evaluated   -> "every check ran and none objected"
--
-- The first must not render as a clean bill of health, and the second must not
-- be permanently unreachable. The frontend already draws three distinct states
-- and the third one could never appear while `evaluated` was derived from flag
-- count alone.
--
-- WHAT IS STORED, AND WHY BOTH COLUMNS
-- ------------------------------------
-- `evaluated_at` answers "has validation run?". `checks_run` answers "which
-- checks, exactly?" — which matters because the set grows over time: a fit
-- evaluated by three checks in this release is not equivalent to one evaluated
-- by five in the next, and without the names there is no way to tell them apart
-- or to know a re-evaluation is due. Storing only a boolean would lose that.
--
-- A check is listed in `checks_run` whether or not it produced a flag. Checks
-- that were SKIPPED (not applicable to this model, or missing an input) are
-- deliberately NOT listed — "did not apply" is not "ran and found nothing".
--
-- Idempotent: safe to re-run.

ALTER TABLE core.grb_spectral_fits
  ADD COLUMN IF NOT EXISTS checks_run text[];
--> statement-breakpoint
ALTER TABLE core.grb_spectral_fits
  ADD COLUMN IF NOT EXISTS evaluated_at timestamptz;
--> statement-breakpoint
DO $$
BEGIN
  -- The two travel together: a timestamp with no check names claims an
  -- evaluation happened but cannot say what it consisted of, and a list of
  -- names with no timestamp cannot say when — or whether — it was current.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_grb_fit_validation_state') THEN
    ALTER TABLE core.grb_spectral_fits ADD CONSTRAINT chk_grb_fit_validation_state
      CHECK (
        (evaluated_at IS NULL AND checks_run IS NULL)
        OR (evaluated_at IS NOT NULL AND checks_run IS NOT NULL)
      );
  END IF;
END $$;
--> statement-breakpoint
COMMENT ON COLUMN core.grb_spectral_fits.checks_run IS
  'Names of the validation checks that actually EXECUTED against this fit, '
  'whether or not each produced a flag. Checks that were skipped (inapplicable '
  'to the model, or missing an input) are omitted — "did not apply" is not '
  '"ran and found nothing". NULL = validation has never run.';
--> statement-breakpoint
COMMENT ON COLUMN core.grb_spectral_fits.evaluated_at IS
  'When the validation engine last ran for this fit. NULL means it never has, '
  'which is why an empty core.grb_validation_flags list for this fit must NOT '
  'be rendered as "no issues found".';
