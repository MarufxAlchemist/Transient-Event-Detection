/**
 * openaiExtractionWorker.ts — the second, independent circular extraction
 * ---------------------------------------------------------------------------
 * Drains `core.circular_extractions` rows with `extractor =
 * 'astro-colibri-openai'`, calling the Python backend's
 * /api/science/openai-circular-extraction, which wraps
 * astro-colibri-circular-parser's OpenAI photometry pipeline.
 *
 * WHY A SECOND WORKER, NOT A BRANCH INSIDE extractionWorker.ts
 * ------------------------------------------------------------
 * That worker claims a batch and drains it SEQUENTIALLY — `for (const row of
 * rows) await runOne(row)`. The OpenAI provider's worst case is
 * (retries + 1) attempts x timeout, per model: 366 s on the package's
 * defaults, against Gemini's 45 s timeout. Sharing the loop would let one
 * OpenAI job delay every Gemini job behind it by minutes. Two workers, two
 * claim queries, two cadences — neither can stall the other.
 *
 * They are peers, not primary and fallback. Both extractions of the same
 * circular are kept; `content_hash` includes the model name, so they occupy
 * distinct rows and neither overwrites the other. Where they disagree, that
 * disagreement is evidence and is preserved rather than resolved here.
 *
 * WHERE THE MONEY IS
 * ------------------
 * This is the only worker that can cause billing. It refuses to start unless
 * CIRCULAR_OPENAI_EXTRACTION_ENABLED === "true", and the Python side checks
 * the same flag independently before constructing any provider. Either check
 * alone is sufficient; both means a misconfigured Node cannot force a call
 * and a stray direct HTTP request cannot either.
 */

import { and, eq, sql } from "drizzle-orm";
import { db, circularExtractions, eventCirculars } from "@workspace/db";
import type { CircularExtractionFailureKind } from "@workspace/db";

import { logger } from "../lib/logger.js";
import { classifyFailure, decideExtractionRetry } from "./extractionRetry.js";

// ─── Configuration ───────────────────────────────────────────────────────────

/** The extractor this worker owns. Matches chk_extraction_extractor. */
export const OPENAI_EXTRACTOR = "astro-colibri-openai" as const;

/**
 * Whether this worker runs at all — and therefore whether any billing can
 * occur. Same strict form as the Python side and as
 * CIRCULAR_EXTRACTION_SKIP_NON_SCIENTIFIC: exactly "true", nothing else.
 */
export function openaiExtractionEnabled(): boolean {
  return process.env["CIRCULAR_OPENAI_EXTRACTION_ENABLED"] === "true";
}

/**
 * One at a time by default. Gemini's worker takes 3, because its jobs are
 * seconds; these are minutes, and a larger batch just holds rows in
 * 'processing' while they wait their turn in the same sequential loop.
 */
function batchSize(): number {
  const raw = Number(process.env["CIRCULAR_OPENAI_EXTRACTION_BATCH"]);
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
}

/** Slower than Gemini's 15 s: there is no point polling faster than jobs finish. */
function pollIntervalMs(): number {
  const raw = Number(process.env["CIRCULAR_OPENAI_POLL_MS"]);
  return Number.isFinite(raw) && raw >= 1000 ? raw : 60_000;
}

/**
 * Deadline for the whole call, sized against the recommended deployment
 * settings (GCN_PHOTOMETRY_AI_TIMEOUT_SECONDS=60, RETRIES=1 → ~122 s upstream)
 * plus headroom. If the upstream is left on package defaults this will fire
 * first, which is the intended behaviour: the worker's clock, not the
 * provider's, bounds how long a row stays claimed.
 */
function requestTimeoutMs(): number {
  const raw = Number(process.env["CIRCULAR_OPENAI_REQUEST_TIMEOUT_MS"]);
  return Number.isFinite(raw) && raw >= 1000 ? raw : 180_000;
}

function scienceBaseUrl(): string {
  const ws = process.env["PYTHON_BACKEND_URL"] ?? "ws://localhost:8001/api/ws";
  return ws.replace(/^ws/, "http").replace(/\/api\/ws\/?$/, "");
}

// ─── The upstream call ───────────────────────────────────────────────────────

/** What the Python endpoint returns. `available` is the load-bearing field. */
interface ExtractionResponse {
  ok?: boolean;
  available?: boolean;
  reason?: string;
  detail?: string;
  extraction?: Record<string, unknown>;
  payload?: unknown;
  consistency_issues?: unknown[];
  model?: string | null;
  ai_api?: string | null;
  event_resolved?: boolean;
}

/**
 * Reasons that will never succeed on a retry, however many times it is
 * attempted. A disabled flag or a body-less circular is a fact about the
 * configuration or the data, not a transient fault.
 */
const TERMINAL_REASONS = new Set(["not_enabled", "empty_body"]);

class TerminalExtractionError extends Error {
  readonly kind: CircularExtractionFailureKind = "configuration";
}

async function callPython(
  circular: Pick<typeof eventCirculars.$inferSelect, "subject" | "body" | "circularId" | "regexpHints">,
): Promise<ExtractionResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs());
  try {
    const res = await fetch(`${scienceBaseUrl()}/api/science/openai-circular-extraction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: circular.subject,
        body: circular.body,
        circular_number: String(circular.circularId),
        // The hints already computed and stored on the circular. The package
        // recomputes its own regardless (pipeline.py:90 offers no injection
        // point, measured at ~5 ms); sending ours lets the two be compared.
        regexp_hints: circular.regexpHints ?? null,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Python extraction endpoint returned HTTP ${res.status}`);
    }
    return (await res.json()) as ExtractionResponse;
  } finally {
    clearTimeout(timer);
  }
}

// ─── One job ─────────────────────────────────────────────────────────────────

interface ClaimedJob {
  id: bigint;
  circularPk: bigint;
  attempts: number;
}

async function runOne(job: ClaimedJob): Promise<void> {
  const [circular] = await db
    .select({
      subject: eventCirculars.subject,
      body: eventCirculars.body,
      circularId: eventCirculars.circularId,
      regexpHints: eventCirculars.regexpHints,
    })
    .from(eventCirculars)
    .where(eq(eventCirculars.id, job.circularPk))
    .limit(1);

  if (!circular) {
    // The circular was deleted between queueing and claiming. Nothing to do,
    // and nothing to retry.
    throw new TerminalExtractionError(
      `Circular ${String(job.circularPk)} no longer exists`,
    );
  }

  const result = await callPython(circular);

  if (result.available !== true) {
    const reason = result.reason ?? "unknown";
    const detail = result.detail ?? "no detail supplied";
    if (TERMINAL_REASONS.has(reason)) {
      throw new TerminalExtractionError(`${reason}: ${detail}`);
    }
    // upstream_error and anything unrecognised are treated as transient, so
    // the existing backoff policy decides whether to try again.
    throw new Error(`${reason}: ${detail}`);
  }

  await db
    .update(circularExtractions)
    .set({
      status: "completed",
      extraction: result.extraction as Record<string, unknown>,
      extractedAt: new Date(),
      provider: OPENAI_EXTRACTOR,
      modelName: result.model ?? null,
      lastError: null,
      failureKind: null,
      nextAttemptAt: null,
      updatedAt: new Date(),
    })
    .where(eq(circularExtractions.id, job.id));

  logger.info(
    {
      extractionId: String(job.id),
      circularId: Number(circular.circularId),
      model: result.model,
      // Always false by construction — the endpoint passes resolve_events=false
      // and event=null. Logged so a regression would be visible rather than
      // silently changing who decides event association.
      eventResolved: result.event_resolved === true,
      consistencyIssues: (result.consistency_issues ?? []).length,
    },
    "[circulars] OpenAI extraction completed",
  );
}

async function handleFailure(job: ClaimedJob, err: unknown): Promise<void> {
  const kind: CircularExtractionFailureKind =
    err instanceof TerminalExtractionError ? err.kind : classifyFailure(err);
  const decision = decideExtractionRetry(kind, job.attempts);
  const message = err instanceof Error ? err.message : String(err);

  await db
    .update(circularExtractions)
    .set({
      status: decision.action === "retry" ? "pending" : "failed",
      failureKind: kind,
      lastError: message.slice(0, 2000),
      nextAttemptAt: decision.nextAttemptAt ?? null,
      updatedAt: new Date(),
    })
    .where(eq(circularExtractions.id, job.id));

  logger.warn(
    { extractionId: String(job.id), kind, action: decision.action, attempts: job.attempts, err: message },
    "[circulars] OpenAI extraction attempt failed",
  );
}

// ─── The claim + drain cycle ─────────────────────────────────────────────────

export async function processDueOpenaiExtractions(now = new Date()): Promise<number> {
  const batch = batchSize();
  let rows: Record<string, unknown>[];

  try {
    const claimed = await db.execute(sql`
      UPDATE core.circular_extractions
         SET status = 'processing',
             attempts = attempts + 1,
             updated_at = ${now}
       WHERE id IN (
         SELECT id FROM core.circular_extractions
          WHERE status = 'pending'
            AND extractor = ${OPENAI_EXTRACTOR}
            AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT ${batch}
       )
       RETURNING id, circular_pk, attempts
    `);
    rows =
      ((claimed as unknown as { rows?: unknown[] }).rows as Record<string, unknown>[]) ??
      (claimed as unknown as Record<string, unknown>[]);
  } catch (err) {
    logger.error({ err }, "[circulars] OpenAI extraction claim query failed");
    return 0;
  }

  let handled = 0;
  for (const raw of rows) {
    const job: ClaimedJob = {
      id: raw["id"] as bigint,
      circularPk: raw["circular_pk"] as bigint,
      attempts: Number(raw["attempts"] ?? 1),
    };
    handled++;
    try {
      await runOne(job);
    } catch (err) {
      try {
        await handleFailure(job, err);
      } catch (bookkeepingErr) {
        logger.error(
          { err: bookkeepingErr, extractionId: String(job.id) },
          "[circulars] could not record OpenAI extraction failure",
        );
      }
    }
  }
  return handled;
}

/**
 * Return this extractor's abandoned rows to the queue.
 *
 * Scoped to `astro-colibri-openai`, and with a far longer staleness window
 * than Gemini's 10 minutes: a job legitimately in flight can run for minutes,
 * and reaping a live job would double-bill it.
 */
export async function reapStuckOpenaiJobs(
  staleAfterMs = 30 * 60_000,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - staleAfterMs);
  try {
    const reaped = await db
      .update(circularExtractions)
      .set({ status: "pending", nextAttemptAt: null, updatedAt: now })
      .where(
        and(
          eq(circularExtractions.status, "processing"),
          eq(circularExtractions.extractor, OPENAI_EXTRACTOR),
          sql`${circularExtractions.updatedAt} < ${cutoff}`,
        ),
      )
      .returning({ id: circularExtractions.id });

    if (reaped.length > 0) {
      logger.warn(
        { count: reaped.length },
        "[circulars] returned abandoned OpenAI extractions to the queue",
      );
    }
    return reaped.length;
  } catch (err) {
    logger.error({ err }, "[circulars] OpenAI stuck-job reaper failed");
    return 0;
  }
}

// ─── Background loop ─────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;

export function startOpenaiExtractionWorker(intervalMs = pollIntervalMs()): void {
  if (timer) return;

  if (!openaiExtractionEnabled()) {
    logger.info(
      "[circulars] OpenAI extraction disabled (CIRCULAR_OPENAI_EXTRACTION_ENABLED is not 'true') — " +
        "no worker started, no OpenAI call possible. This is the expected state everywhere " +
        "except the designated deployment machine.",
    );
    return;
  }

  void reapStuckOpenaiJobs().catch(() => undefined);

  timer = setInterval(() => {
    void (async () => {
      await reapStuckOpenaiJobs();
      await processDueOpenaiExtractions();
    })().catch((err) => logger.error({ err }, "[circulars] OpenAI extraction tick threw"));
  }, intervalMs);

  if (typeof timer.unref === "function") timer.unref();
  logger.warn(
    { intervalMs, batch: batchSize() },
    "[circulars] OpenAI extraction worker started — THIS DEPLOYMENT WILL INCUR OPENAI CHARGES",
  );
}

export function stopOpenaiExtractionWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
