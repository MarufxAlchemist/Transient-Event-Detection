/**
 * grbPipelineGate.ts — pure decision logic for the GRB pipeline sync routes.
 *
 * Mirrors the existing grbFitGate.ts / grbFitEnqueue.ts split: every function
 * here is DB-free and unit-testable without a database, and the route layer
 * (routes/grbPipeline.ts) is the only place that touches Drizzle. The API
 * never performs a sync itself — it only records a request row and reports
 * back what the worker (which owns git, the dependency stack and the data
 * volume) wrote to it. See backend/grb_fit_worker/pipeline_sync.py.
 */

export const GRB_PIPELINE_SUCCESS_STATUSES = [
  "activated",
  "rolled_back",
  "up_to_date",
] as const;

export const GRB_PIPELINE_TERMINAL_STATUSES = [
  ...GRB_PIPELINE_SUCCESS_STATUSES,
  "needs_image_rebuild",
  "contract_check_missing",
  "contract_check_failed",
  "fetch_failed",
  "unknown_sha",
  "no_previous_release",
  "config_error",
  "sync_failed",
  "busy",
  "failed",
] as const;

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

export interface PipelineSyncRow {
  id: number;
  action: string;
  requestedBy: string;
  requestedAt: Date;
  status: string;
  fromSha: string | null;
  toSha: string | null;
  message: string | null;
  finishedAt: Date | null;
}

export interface PipelineSyncSummary {
  id: number;
  action: string;
  requestedBy: string;
  requestedAt: Date;
  status: string;
  fromSha: string | null;
  toSha: string | null;
  message: string | null;
  finishedAt: Date | null;
}

export interface PipelinePendingSummary {
  id: number;
  action: string;
  requestedBy: string;
  requestedAt: Date;
}

export interface PipelineStatus {
  currentSha: string | null;
  pending: PipelinePendingSummary | null;
  lastFinished: PipelineSyncSummary | null;
  knownShas: string[];
}

/** Every SHA this worker has ever activated or rolled back to, from the history rows. */
export function knownShasFromRows(rows: readonly PipelineSyncRow[]): Set<string> {
  const shas = new Set<string>();
  for (const row of rows) {
    if (row.fromSha) shas.add(row.fromSha);
    if (row.toSha && GRB_PIPELINE_SUCCESS_STATUSES.includes(row.status as never)) {
      shas.add(row.toSha);
    }
  }
  return shas;
}

/** Build the status snapshot the frontend polls, from the full request history (newest first). */
export function buildPipelineStatus(rows: readonly PipelineSyncRow[]): PipelineStatus {
  const pendingRow = rows.find((r) => r.status === "pending" || r.status === "running");
  const lastFinished = rows.find((r) => r.finishedAt !== null) ?? null;

  const currentSha =
    rows.find((r) => GRB_PIPELINE_SUCCESS_STATUSES.includes(r.status as never))?.toSha ?? null;

  return {
    currentSha,
    pending: pendingRow
      ? {
          id: pendingRow.id,
          action: pendingRow.action,
          requestedBy: pendingRow.requestedBy,
          requestedAt: pendingRow.requestedAt,
        }
      : null,
    lastFinished: lastFinished
      ? {
          id: lastFinished.id,
          action: lastFinished.action,
          requestedBy: lastFinished.requestedBy,
          requestedAt: lastFinished.requestedAt,
          status: lastFinished.status,
          fromSha: lastFinished.fromSha,
          toSha: lastFinished.toSha,
          message: lastFinished.message,
          finishedAt: lastFinished.finishedAt,
        }
      : null,
    knownShas: Array.from(knownShasFromRows(rows)).sort(),
  };
}

export type RollbackTargetDecision =
  | { ok: true; targetSha: string | null }
  | { ok: false; error: string };

/**
 * Validate a requested rollback target BEFORE any insert.
 *
 * null/undefined/"" -> roll back to the previous release (worker decides which).
 * Anything else must be a full 40-character SHA this worker is already known
 * to have held — rollback never fetches, so an unknown SHA is refused here
 * rather than queued for the worker to reject later.
 */
export function resolveRollbackTarget(
  requestedSha: unknown,
  knownShas: ReadonlySet<string>,
): RollbackTargetDecision {
  if (requestedSha === undefined || requestedSha === null || requestedSha === "") {
    return { ok: true, targetSha: null };
  }
  if (typeof requestedSha !== "string") {
    return { ok: false, error: "sha must be a full 40-character lowercase git SHA" };
  }
  const normalized = requestedSha.toLowerCase();
  if (!FULL_SHA_RE.test(normalized)) {
    return { ok: false, error: "sha must be a full 40-character lowercase git SHA" };
  }
  if (!knownShas.has(normalized)) {
    return { ok: false, error: `${normalized} is not a pipeline SHA this worker has recorded holding` };
  }
  return { ok: true, targetSha: normalized };
}
