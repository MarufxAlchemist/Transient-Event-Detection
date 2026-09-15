-- 0025_grb_spectral_fits.sql
-- Independent GRB spectral re-fitting: job queue, fit results, validation
-- flags, and the literature reference table they are compared against.
--
-- WHY RE-FIT AT ALL
-- -----------------
-- core.events stores `fluence` and `t90` as the GCN notice reported them, and
-- derives no spectral shape. Nothing in the system can currently say whether a
-- reported Ep is consistent with the raw data. These tables hold a re-fit of
-- the Fermi GBM TTE data through the fermi-gbm-analysis pipeline (heapy
-- extraction -> bayspec PGSTAT -> MultiNest), so the fitted parameters exist
-- alongside the reported ones instead of in place of them.
--
-- COLUMN NAMES CAME FROM A REAL FIT, NOT FROM A SPEC
-- --------------------------------------------------
-- Every parameter column below was verified against an end-to-end fit of
-- GRB150514A (2026-09-09, nlive=200, cpl, dets n3/n6/n7). The pipeline's
-- extract_params() emits:
--
--   alpha, alpha_low, alpha_high, alpha_ml, A, A_ml,
--   Ep_best, Ep_low, Ep_high, Ep_ml, sigma_Ep,
--   vFv_best, vFv_low, vFv_high, sigma_vFv,
--   ep_constrained, log_Ep_hits_prior_low, log_Ep_hits_prior_high,
--   log_Ep_1sigma_min, log_Ep_1sigma_max, log_Ep_prior_lo, log_Ep_prior_hi,
--   include_bgo
--
-- It emits NO log_likelihood (get_model_params drops it for every model in
-- MODEL_COLS), no `norm`, and no `E_peak_keV`. Errors are ASYMMETRIC OFFSETS
-- from the central value, not bounds: the 1-sigma interval is
-- [value - low, value + high]. Storing them as bounds would silently halve or
-- double every published uncertainty.
--
-- WHY TYPED COLUMNS *AND* raw_params
-- ----------------------------------
-- Hardcoding one column per parameter per model does not survive contact with
-- a model registry that already has eleven entries with differing parameter
-- sets. Hardcoding nothing and keeping only JSONB makes the Phase 6 validation
-- rules and the "fits for this event" endpoint pay a JSON parse per row and
-- lose every index. So: typed columns for what is queried, filtered, sorted or
-- validated, plus raw_params holding the extract_params() row verbatim so no
-- value is lost and a new model needs no migration.
--
-- WHY beta IS NULLABLE
-- --------------------
-- MODEL_COLS (pipeline/constants.py) gives the CPL family — cpl, hlecpl,
-- cutoffpl — only alpha, log_Ep and log_A. There is no beta to store. NULL
-- there means "this model has no such parameter", never "beta is 0", and the
-- Phase 6 Band-closure check (alpha > beta) must skip those rows rather than
-- read a missing index as a violation.
--
-- WHY hdf5_path IS NOT THE IDENTIFIER
-- -----------------------------------
-- One HDF5 file per GRB holds every result for that burst: each model, and
-- both time-integrated and time-resolved. The file path therefore identifies a
-- burst, not a fit. hdf5_key is the actual pointer, and its format varies —
-- `tint_{model}_{name}` for a canonical fit, `tint_{model}_{fp}_{name}` when
-- the fit landed in a versioned directory, and the bare model name for
-- time-resolved — which is exactly why it is stored rather than reconstructed.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS core.grb_fit_jobs (
  id            bigserial PRIMARY KEY,
  event_pk      bigint NOT NULL REFERENCES core.events(id) ON DELETE CASCADE,
  event_id      text NOT NULL,
  grb_name      text,
  model         text NOT NULL DEFAULT 'cpl',
  detector_cfg  text NOT NULL DEFAULT 'nai_only',
  nlive         integer NOT NULL DEFAULT 1000,
  status        text NOT NULL DEFAULT 'pending',
  attempts      integer NOT NULL DEFAULT 0,
  error         text,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS core.grb_spectral_fits (
  id                     bigserial PRIMARY KEY,
  event_pk               bigint NOT NULL REFERENCES core.events(id) ON DELETE CASCADE,
  event_id               text NOT NULL,
  job_id                 bigint REFERENCES core.grb_fit_jobs(id) ON DELETE SET NULL,
  model                  text NOT NULL,
  detector_cfg           text NOT NULL,
  mode                   text NOT NULL DEFAULT 'tintegrated',
  fit_dets               text[] NOT NULL,
  include_bgo            boolean NOT NULL,
  nlive                  integer NOT NULL,
  t1                     double precision,
  t2                     double precision,
  alpha                  double precision NOT NULL,
  alpha_low              double precision NOT NULL,
  alpha_high             double precision NOT NULL,
  beta                   double precision,
  beta_low               double precision,
  beta_high              double precision,
  ep_best                double precision NOT NULL,
  ep_low                 double precision NOT NULL,
  ep_high                double precision NOT NULL,
  amplitude              double precision NOT NULL,
  vfv_best               double precision,
  vfv_low                double precision,
  vfv_high               double precision,
  ep_constrained         boolean,
  log_ep_hits_prior_low  boolean,
  log_ep_hits_prior_high boolean,
  hdf5_path              text,
  hdf5_key               text NOT NULL,
  fit_dir                text,
  fit_fingerprint        text,
  extraction_fingerprint text,
  pipeline_version       text,
  raw_params             jsonb NOT NULL,
  fit_timestamp          timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS core.grb_validation_flags (
  id            bigserial PRIMARY KEY,
  event_pk      bigint NOT NULL REFERENCES core.events(id) ON DELETE CASCADE,
  fit_id        bigint NOT NULL REFERENCES core.grb_spectral_fits(id) ON DELETE CASCADE,
  check_name    text NOT NULL,
  severity      text NOT NULL,
  message       text NOT NULL,
  reference_url text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS core.grb_literature_refs (
  id           bigserial PRIMARY KEY,
  event_name   text NOT NULL,
  gcn_source   text NOT NULL,
  gcn_url      text,
  model        text NOT NULL,
  t1           double precision,
  t2           double precision,
  alpha        double precision,
  alpha_err    double precision,
  beta         double precision,
  beta_err     double precision,
  e_peak_kev   double precision,
  e_peak_err   double precision,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- ── CHECK constraints ───────────────────────────────────────────────────────
-- Checked enums rather than bare text: a typo in `status` would otherwise
-- create a row no worker's claim query ever matches, sitting pending forever
-- with nothing to indicate why — the same failure chk_extraction_extractor
-- (0024) exists to prevent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_grb_fit_job_status') THEN
    ALTER TABLE core.grb_fit_jobs ADD CONSTRAINT chk_grb_fit_job_status
      CHECK (status IN ('pending', 'running', 'succeeded', 'failed'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_grb_fit_job_detector_cfg') THEN
    ALTER TABLE core.grb_fit_jobs ADD CONSTRAINT chk_grb_fit_job_detector_cfg
      CHECK (detector_cfg IN ('nai_only', 'nai_bgo'));
  END IF;

  -- MultiNest requires live points; 0 or negative is not a slow fit, it is a
  -- crash inside the sampler minutes after the job was claimed.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_grb_fit_job_nlive') THEN
    ALTER TABLE core.grb_fit_jobs ADD CONSTRAINT chk_grb_fit_job_nlive
      CHECK (nlive > 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_grb_fit_detector_cfg') THEN
    ALTER TABLE core.grb_spectral_fits ADD CONSTRAINT chk_grb_fit_detector_cfg
      CHECK (detector_cfg IN ('nai_only', 'nai_bgo'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_grb_fit_mode') THEN
    ALTER TABLE core.grb_spectral_fits ADD CONSTRAINT chk_grb_fit_mode
      CHECK (mode IN ('tintegrated', 'tresolved'));
  END IF;

  -- A spectral fit needs at least two detectors; fit_tintegrated() raises
  -- below that. An empty array here would be a fit that cannot have happened.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_grb_fit_dets_nonempty') THEN
    ALTER TABLE core.grb_spectral_fits ADD CONSTRAINT chk_grb_fit_dets_nonempty
      CHECK (array_length(fit_dets, 1) >= 2);
  END IF;

  -- Asymmetric 1-sigma offsets are distances from the central value, so they
  -- are non-negative by definition. A negative offset means the writer passed
  -- bounds where offsets were expected — a silent factor-of-two error in every
  -- error bar rendered downstream.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_grb_fit_errors_nonneg') THEN
    ALTER TABLE core.grb_spectral_fits ADD CONSTRAINT chk_grb_fit_errors_nonneg
      CHECK (
        alpha_low >= 0 AND alpha_high >= 0
        AND ep_low >= 0 AND ep_high >= 0
        AND (beta_low IS NULL OR beta_low >= 0)
        AND (beta_high IS NULL OR beta_high >= 0)
        AND (vfv_low IS NULL OR vfv_low >= 0)
        AND (vfv_high IS NULL OR vfv_high >= 0)
      );
  END IF;

  -- Ep is an energy. A non-positive peak energy is not a soft burst, it is a
  -- broken fit, and log10 of it later would be NaN rather than an error.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_grb_fit_ep_positive') THEN
    ALTER TABLE core.grb_spectral_fits ADD CONSTRAINT chk_grb_fit_ep_positive
      CHECK (ep_best > 0);
  END IF;

  -- beta and its errors travel together: a high-energy index with no
  -- uncertainty, or an uncertainty with no index, is a half-written row.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_grb_fit_beta_complete') THEN
    ALTER TABLE core.grb_spectral_fits ADD CONSTRAINT chk_grb_fit_beta_complete
      CHECK (
        (beta IS NULL AND beta_low IS NULL AND beta_high IS NULL)
        OR (beta IS NOT NULL AND beta_low IS NOT NULL AND beta_high IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_grb_validation_severity') THEN
    ALTER TABLE core.grb_validation_flags ADD CONSTRAINT chk_grb_validation_severity
      CHECK (severity IN ('info', 'warning', 'critical'));
  END IF;
END $$;
--> statement-breakpoint
-- ── Indexes ─────────────────────────────────────────────────────────────────
-- PARTIAL, on purpose. The worker claims with
--   SELECT ... WHERE status = 'pending' ORDER BY requested_at
--   FOR UPDATE SKIP LOCKED
-- so the index needs to hold only the queue, not every fit ever run, and needs
-- requested_at because the claim is ordered by it.
CREATE INDEX IF NOT EXISTS grb_fit_jobs_pending_idx
  ON core.grb_fit_jobs (status, requested_at)
  WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS grb_fit_jobs_event_idx
  ON core.grb_fit_jobs (event_pk, requested_at);
--> statement-breakpoint
-- One job may produce at most one fit: a retried or double-delivered worker
-- must not be able to write the same result twice. NULL job_id (a backfill or
-- manual insert) is exempt, which is standard unique-index behaviour.
CREATE UNIQUE INDEX IF NOT EXISTS grb_spectral_fits_job_uniq
  ON core.grb_spectral_fits (job_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS grb_spectral_fits_event_idx
  ON core.grb_spectral_fits (event_pk, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS grb_spectral_fits_model_idx
  ON core.grb_spectral_fits (model, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS grb_validation_flags_fit_idx
  ON core.grb_validation_flags (fit_id, severity);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS grb_validation_flags_event_idx
  ON core.grb_validation_flags (event_pk, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS grb_literature_refs_name_source_uniq
  ON core.grb_literature_refs (event_name, gcn_source);
--> statement-breakpoint
-- ── Literature seed ─────────────────────────────────────────────────────────
-- EXACTLY the three bursts in the pipeline's own GCN_REFS table (grb_config.py)
-- — the only ones with published values available out of the box. Nothing here
-- is inferred: each row is transcribed from the named circular, and the source
-- table's own note travels with it, caveats intact.
--
-- beta is NULL on all three rows because GCN_REFS carries no beta field. The
-- published Band beta for GRB150514A exists only inside its free-text note,
-- preserved verbatim below; lifting a number out of prose into a structured
-- measurement column is the kind of quiet fabrication this schema exists to
-- prevent. It stays a curation task for a human.
--
-- gcn_url follows the scheme already used by core.event_circulars.gcn_url
-- (https://gcn.nasa.gov/circulars/<id>), not a new invention.
INSERT INTO core.grb_literature_refs
  (event_name, gcn_source, gcn_url, model, t1, t2, alpha, alpha_err, e_peak_kev, e_peak_err, note)
VALUES
  ('GRB140606B', 'GCN 16363', 'https://gcn.nasa.gov/circulars/16363', 'cpl',
   -3.0, 12.3, -1.22, 0.04, 473.0, 82.6,
   'Burns, Fermi GBM; time-averaged CPL from T0-3.0 to T0+12.3 s; cutoff parameterized as Epeak'),
  ('GRB190829A', 'GCN 25575', 'https://gcn.nasa.gov/circulars/25575', 'cpl',
   0.0, 4.0, -1.41, 0.08, 130.0, 20.0,
   'Lesage et al., Fermi GBM; first pulse T0 to T0+4.0 s (GBM T0=2019-08-29T19:55:53.13); cutoff parameterized as Epeak. Second pulse (T0+47.1 to T0+61.4) is Band with Ep=11 keV — not this tint.'),
  ('GRB150514A', 'GCN 17819', 'https://gcn.nasa.gov/circulars/17819', 'band',
   0.0, 11.3, -1.34, 0.07, 73.0, 6.0,
   'Roberts, Zhang & Meegan, Fermi GBM; Band T0 to T0+11.3 s (alpha=-1.34+/-0.07, Ep=73+/-6, beta=-2.51+/-0.17). Konus-Wind GCN 17823 CPL on T0 to T0+8.448 s: alpha=-1.44(-0.29/+0.33), Ep=60(-14/+10) keV (90% CL).')
ON CONFLICT (event_name, gcn_source) DO NOTHING;
--> statement-breakpoint
-- ── Column documentation ────────────────────────────────────────────────────
COMMENT ON COLUMN core.grb_fit_jobs.grb_name IS
  'GRB name handed to the pipeline, e.g. "GRB150514A" — usually spelled like '
  'event_id, which core.events normalises to the unspaced form. A separate '
  'column because spelling is not the constraint: GRBContext.from_name() '
  'resolves only the eight curated bursts in the pipeline''s grb_config catalog, '
  'which carry the detector sets and time windows a fit needs. NULL means no '
  'catalog entry exists, so the worker must build a GRBContext from the event''s '
  'own RA/Dec/trigger time instead.';
--> statement-breakpoint
COMMENT ON COLUMN core.grb_spectral_fits.beta IS
  'High-energy photon index — Band-family models only (band, bpl, sbpl, cband, '
  'dband, hleband, grbm). NULL means the fitted model has no such parameter (the '
  'CPL family), NOT that beta is zero and NOT that it was unconstrained.';
--> statement-breakpoint
COMMENT ON COLUMN core.grb_spectral_fits.ep_constrained IS
  'FALSE = the 1-sigma log-Ep interval reached a prior edge, so the quoted Ep is '
  'an artefact of the prior rather than a measurement and must not be compared '
  'against literature or displayed as a result without saying so. NULL = the '
  'model has no Ep parameter at all, which is not the same as unconstrained.';
--> statement-breakpoint
COMMENT ON COLUMN core.grb_spectral_fits.alpha_low IS
  'ASYMMETRIC 1-sigma OFFSET below alpha, not a bound: the interval is '
  '[alpha - alpha_low, alpha + alpha_high]. Same convention for every *_low / '
  '*_high pair in this table.';
--> statement-breakpoint
COMMENT ON COLUMN core.grb_spectral_fits.hdf5_key IS
  'Pointer to this fit inside the shared per-GRB HDF5 file, e.g. '
  '"tint_cpl_GRB150514A". Stored rather than derived because the format varies: '
  'tint_{model}_{name} for a canonical fit, tint_{model}_{fit_fp}_{name} for a '
  'versioned one, and the bare model name for time-resolved results.';
--> statement-breakpoint
COMMENT ON COLUMN core.grb_spectral_fits.hdf5_path IS
  'The per-GRB HDF5 file. Identifies a BURST, not a fit — one file holds every '
  'model and both time-integrated and time-resolved results. Pair with hdf5_key.';
--> statement-breakpoint
COMMENT ON COLUMN core.grb_spectral_fits.raw_params IS
  'The complete extract_params() row verbatim. The typed columns are a '
  'projection of this; the *_ml max-likelihood values, sigma_Ep, sigma_vFv and '
  'the log-Ep prior bounds live here so a new model needs no migration.';
--> statement-breakpoint
COMMENT ON COLUMN core.grb_literature_refs.beta IS
  'NULL on every seeded row: the source table (grb_config.py GCN_REFS) carries '
  'no beta field. GRB150514A''s published Band beta appears only inside its '
  'free-text note; parsing prose into a structured measurement is deliberately '
  'left as human curation.';
