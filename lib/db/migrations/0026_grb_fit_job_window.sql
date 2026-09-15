-- 0026_grb_fit_job_window.sql
-- Adds an explicit time-integrated fit window to core.grb_fit_jobs.
--
-- WHY THE WORKER CANNOT DERIVE THIS ITSELF
-- ----------------------------------------
-- A time-integrated spectral fit is defined over an interval. The pipeline
-- refuses to run without one: extract_tintegrated_spectra() raises
-- "t1/t2 not set", and GRBContext.__post_init__ leaves both None when neither
-- a window nor slice boundaries are supplied.
--
-- For the eight curated bursts in the pipeline's own grb_config catalog the
-- window is hand-picked and travels with the catalog row. Every real GCN burst
-- arrives with no catalog entry, so the window has to come from somewhere else.
-- The obvious source is the burst's own duration — [0, t90] — but t90 is
-- populated on ZERO of the 222 GRB rows in this archive, so deriving the window
-- from it would fail for every job that will ever be enqueued today.
--
-- The alternative — quietly defaulting to some plausible-looking interval like
-- [0, 10] — is the failure this codebase exists to prevent. A fit run over an
-- invented window produces real-looking parameters for an interval nobody
-- chose, and nothing downstream would record that the window was a guess.
--
-- So the window becomes an explicit, nullable, auditable property of the JOB:
--
--   t1/t2 set    -> fit exactly that interval, and store it on the fit row
--   t1/t2 NULL   -> the worker falls back to [0, t90] if the event has a t90,
--                   and otherwise FAILS the job with a stated reason rather
--                   than inventing an interval.
--
-- This is also the column Phase 4's "re-fit with different settings" endpoint
-- needs: asking for a different window is the most natural re-fit there is.
--
-- Idempotent: safe to re-run.

ALTER TABLE core.grb_fit_jobs
  ADD COLUMN IF NOT EXISTS t1 double precision;
--> statement-breakpoint
ALTER TABLE core.grb_fit_jobs
  ADD COLUMN IF NOT EXISTS t2 double precision;
--> statement-breakpoint
DO $$
BEGIN
  -- Both or neither: half a window is not a window, and silently treating a
  -- lone t1 as "from t1 to whenever" would invent the other end.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_grb_fit_job_window_complete') THEN
    ALTER TABLE core.grb_fit_jobs ADD CONSTRAINT chk_grb_fit_job_window_complete
      CHECK ((t1 IS NULL AND t2 IS NULL) OR (t1 IS NOT NULL AND t2 IS NOT NULL));
  END IF;

  -- A non-positive-length window is not a short fit, it is a crash inside
  -- heapy's spectrum extraction minutes after the job was claimed.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_grb_fit_job_window_ordered') THEN
    ALTER TABLE core.grb_fit_jobs ADD CONSTRAINT chk_grb_fit_job_window_ordered
      CHECK (t1 IS NULL OR t2 > t1);
  END IF;
END $$;
--> statement-breakpoint
COMMENT ON COLUMN core.grb_fit_jobs.t1 IS
  'Start of the time-integrated fit window, seconds relative to trigger. NULL '
  'means "not specified": the worker then uses [0, t90] if the event has a t90, '
  'and fails the job with a stated reason if it does not — it never invents an '
  'interval, because a fit over a guessed window yields real-looking parameters '
  'for an interval nobody chose.';
