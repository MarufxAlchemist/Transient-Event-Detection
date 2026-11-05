-- Provenance: the git SHA of the pipeline release a fit job actually ran against.
ALTER TABLE core.grb_fit_jobs ADD COLUMN IF NOT EXISTS pipeline_sha text;
COMMENT ON COLUMN core.grb_fit_jobs.pipeline_sha IS
  'Full git SHA of the fermi-gbm-analysis release this job was claimed against (see backend/grb_fit_worker/pipeline_sync.py).';

-- Queue of worker-side pipeline sync/rollback requests. The API only ever
-- inserts a 'pending' row here; the worker (which owns the git checkout and
-- the release store volume) claims it and performs the actual sync.
CREATE TABLE IF NOT EXISTS core.grb_pipeline_syncs (
  id bigserial PRIMARY KEY,
  action text NOT NULL DEFAULT 'sync',
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending',
  from_sha text,
  to_sha text,
  message text,
  finished_at timestamptz
);

COMMENT ON TABLE core.grb_pipeline_syncs IS
  'Requests to sync or roll back the grb-fit-worker pipeline release at runtime. Written by the API, claimed and resolved by the worker.';
COMMENT ON COLUMN core.grb_pipeline_syncs.to_sha IS
  'For a pending/running row: the explicit rollback target requested (null = previous release, or n/a for a sync). For a finished row: the SHA actually activated.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_grb_pipeline_syncs_action'
  ) THEN
    ALTER TABLE core.grb_pipeline_syncs
      ADD CONSTRAINT chk_grb_pipeline_syncs_action
      CHECK (action IN ('sync', 'rollback'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_grb_pipeline_syncs_status'
  ) THEN
    ALTER TABLE core.grb_pipeline_syncs
      ADD CONSTRAINT chk_grb_pipeline_syncs_status
      CHECK (status IN (
        'pending', 'running',
        'activated', 'rolled_back', 'up_to_date',
        'needs_image_rebuild', 'contract_check_missing', 'contract_check_failed',
        'fetch_failed', 'unknown_sha', 'no_previous_release', 'config_error',
        'sync_failed', 'busy', 'failed'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS grb_pipeline_syncs_pending_idx
  ON core.grb_pipeline_syncs (status, requested_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS grb_pipeline_syncs_requested_at_idx
  ON core.grb_pipeline_syncs (requested_at DESC, id DESC);
