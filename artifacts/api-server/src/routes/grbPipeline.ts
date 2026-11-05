/**
 * grbPipeline.ts — GRB pipeline sync/rollback routes.
 *
 * The API never touches git or the pipeline release store itself — it has
 * neither. It only inserts a 'pending' row into core.grb_pipeline_syncs and
 * reports back what the worker (the only process with git, the dependency
 * stack and the data volume) wrote to it. See
 * backend/grb_fit_worker/pipeline_sync.py and __main__.py's poll loop.
 *
 * Status is a public read, matching the other scientific-read endpoints in
 * this router; sync and rollback are writes and require auth, matching every
 * other write here.
 */

import { Router, type Request } from "express";
import { desc } from "drizzle-orm";
import { db, grbPipelineSyncs, type GrbPipelineSyncAction } from "@workspace/db";

import { requireAuth, type AuthPayload } from "../middlewares/auth.js";
import {
  buildPipelineStatus,
  knownShasFromRows,
  resolveRollbackTarget,
  type PipelineSyncRow,
} from "../lib/grbPipelineGate.js";

const router = Router();

const HISTORY_LIMIT = 500;

function requestingUser(req: Request): string {
  const user = (req as Request & { user?: AuthPayload }).user;
  return user?.email ?? "unknown";
}

async function loadHistory(): Promise<PipelineSyncRow[]> {
  const rows = await db
    .select()
    .from(grbPipelineSyncs)
    .orderBy(desc(grbPipelineSyncs.requestedAt), desc(grbPipelineSyncs.id))
    .limit(HISTORY_LIMIT);

  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt,
    status: row.status,
    fromSha: row.fromSha,
    toSha: row.toSha,
    message: row.message,
    finishedAt: row.finishedAt,
  }));
}

function formatRequest(row: { id: number; action: string; status: string; requestedAt: Date }) {
  return {
    id: row.id,
    action: row.action,
    status: row.status,
    requestedAt: row.requestedAt,
  };
}

export async function statusHandler(_req: Request, res: import("express").Response) {
  const history = await loadHistory();
  res.json(buildPipelineStatus(history));
}

export async function syncHandler(req: Request, res: import("express").Response) {
  const history = await loadHistory();
  const alreadyPending = history.find((r) => r.status === "pending" || r.status === "running");
  if (alreadyPending) {
    res.status(409).json({ error: "a pipeline sync or rollback is already pending", request: formatRequest(alreadyPending) });
    return;
  }

  const [inserted] = await db
    .insert(grbPipelineSyncs)
    .values({
      action: "sync" satisfies GrbPipelineSyncAction,
      requestedBy: requestingUser(req),
    })
    .returning();

  res.status(201).json({ request: formatRequest(inserted) });
}

export const syncRouteHandlers = [requireAuth, syncHandler] as const;

export async function rollbackHandler(req: Request, res: import("express").Response) {
  const history = await loadHistory();
  const alreadyPending = history.find((r) => r.status === "pending" || r.status === "running");
  if (alreadyPending) {
    res.status(409).json({ error: "a pipeline sync or rollback is already pending", request: formatRequest(alreadyPending) });
    return;
  }

  const knownShas = knownShasFromRows(history);
  const decision = resolveRollbackTarget((req.body as { sha?: unknown } | undefined)?.sha, knownShas);
  if (!decision.ok) {
    res.status(400).json({ error: decision.error });
    return;
  }

  const [inserted] = await db
    .insert(grbPipelineSyncs)
    .values({
      action: "rollback" satisfies GrbPipelineSyncAction,
      requestedBy: requestingUser(req),
      toSha: decision.targetSha,
    })
    .returning();

  res.status(201).json({ request: formatRequest(inserted) });
}

export const rollbackRouteHandlers = [requireAuth, rollbackHandler] as const;

router.get("/grb-pipeline/status", statusHandler);
router.post("/grb-pipeline/sync", ...syncRouteHandlers);
router.post("/grb-pipeline/rollback", ...rollbackRouteHandlers);

export default router;
