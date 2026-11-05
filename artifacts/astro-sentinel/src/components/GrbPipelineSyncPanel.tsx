import { useEffect, useState } from "react";
import {
  AlertTriangle,
  GitBranch,
  Loader2,
  RotateCcw,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/AuthContext";

/**
 * GrbPipelineSyncPanel
 * ─────────────────────
 * Lets a signed-in user ask the worker to sync a new `fermi-gbm-analysis`
 * commit at runtime, or roll back to an earlier one, without an image
 * rebuild. The API only ever writes a request row; the worker (the only
 * process with git, the dependency stack and the data volume) is what
 * actually performs the sync. See backend/grb_fit_worker/pipeline_sync.py.
 *
 * Rendering nothing for a signed-out visitor matches the rest of this
 * dashboard's write surfaces (re-fit form, notes) — this panel only offers
 * actions, with no read-only content worth showing to an anonymous visitor.
 */

interface PendingRequest {
  id: string;
  action: "sync" | "rollback";
  requestedBy: string;
  requestedAt: string;
}

interface LastFinished {
  id: string;
  action: "sync" | "rollback";
  status: string;
  fromSha: string | null;
  toSha: string | null;
  message: string | null;
  finishedAt: string | null;
}

interface PipelineStatus {
  currentSha: string | null;
  pending: PendingRequest | null;
  lastFinished: LastFinished | null;
  knownShas: string[];
}

const NEEDS_REBUILD_STATUSES = new Set(["needs_image_rebuild"]);
const CONTRACT_WARNING_STATUSES = new Set([
  "contract_check_missing",
  "contract_check_failed",
]);

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 8) : "unset";
}

export function GrbPipelineSyncPanel() {
  const { token } = useAuth();

  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRollback, setConfirmingRollback] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const poll = () => {
      fetch("/api/grb-pipeline/status")
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
        .then((d: PipelineStatus) => {
          if (!cancelled) {
            setStatus(d);
            setFailed(false);
          }
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    };
    poll();
    const interval = window.setInterval(poll, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [token, reload]);

  if (!token) return null;

  async function requestSync() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/grb-pipeline/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setReload((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  async function requestRollback() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/grb-pipeline/rollback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setConfirmingRollback(false);
      setReload((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  const pending = status?.pending ?? null;
  const lastFinished = status?.lastFinished ?? null;

  return (
    <div className="rounded border border-border/50 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
          <GitBranch className="w-3.5 h-3.5" />
          GRB pipeline sync
        </p>
        <span className="font-mono text-xs text-muted-foreground">
          active: {shortSha(status?.currentSha ?? null)}
        </span>
      </div>

      {failed && (
        <p className="text-xs text-amber-500/80">
          Pipeline sync status could not be loaded.
        </p>
      )}

      {pending && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" />
          {pending.action} requested by {pending.requestedBy} — waiting on the worker.
        </p>
      )}

      {!pending && lastFinished && NEEDS_REBUILD_STATUSES.has(lastFinished.status) && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2">
          <p className="flex items-center gap-2 text-xs font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5" />
            Needs an image rebuild
          </p>
          <p className="text-xs text-amber-800/90 dark:text-amber-200/70 mt-1">
            {lastFinished.message ?? "The fetched commit changes pinned dependencies this image does not have."}
          </p>
        </div>
      )}

      {!pending && lastFinished && CONTRACT_WARNING_STATUSES.has(lastFinished.status) && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2">
          <p className="flex items-center gap-2 text-xs font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5" />
            Contract check failed
          </p>
          <p className="text-xs text-amber-800/90 dark:text-amber-200/70 mt-1">
            {lastFinished.message ?? "The fetched commit failed its contract check."}
          </p>
        </div>
      )}

      {!pending && lastFinished && !NEEDS_REBUILD_STATUSES.has(lastFinished.status)
        && !CONTRACT_WARNING_STATUSES.has(lastFinished.status) && (
        <p className="text-xs text-muted-foreground">
          last {lastFinished.action}: {lastFinished.status}
          {lastFinished.toSha && ` -> ${shortSha(lastFinished.toSha)}`}
        </p>
      )}

      {error && (
        <p className="flex items-start gap-2 text-xs text-red-700 dark:text-red-400">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          {error}
        </p>
      )}

      <div className="flex gap-2 pt-1">
        <Button
          variant="outline"
          size="sm"
          className="text-xs"
          disabled={busy || !!pending}
          onClick={requestSync}
        >
          {busy && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
          <RefreshCw className="w-3 h-3 mr-1.5" />
          Sync
        </Button>

        {!confirmingRollback && (
          <Button
            variant="outline"
            size="sm"
            className="text-xs"
            disabled={busy || !!pending}
            onClick={() => setConfirmingRollback(true)}
          >
            <RotateCcw className="w-3 h-3 mr-1.5" />
            Roll back
          </Button>
        )}

        {confirmingRollback && (
          <>
            <Button
              variant="destructive"
              size="sm"
              className="text-xs"
              disabled={busy}
              onClick={requestRollback}
            >
              {busy && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
              Confirm rollback
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              disabled={busy}
              onClick={() => setConfirmingRollback(false)}
            >
              Cancel
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
