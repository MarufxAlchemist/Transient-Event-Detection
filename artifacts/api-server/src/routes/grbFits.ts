/**
 * grbFits.ts — GRB spectral re-fit routes.
 *
 * Conventions here are taken from the existing router, not invented:
 *   • Scientific reads on an event are unauthenticated and use `:id`, matching
 *     /events/:id/revisions, /circulars, /correlations and /localizations.
 *     Writes use requireAuth, matching every other write in this router
 *     (requireAdmin is reserved for team/membership management).
 *   • `GetEventParams.safeParse(req.params)` then parseInt, exactly as
 *     /events/:id/revisions does.
 *   • Request bodies are validated inline, as notes.ts / discussions.ts do.
 *     The generated api-zod schemas are orval output marked "do not edit
 *     manually", and most routes in this server are not declared in
 *     openapi.yaml at all (only /events/stats, /events/{id} and
 *     /events/{id}/localizations are).
 *   • Reads return a bare array; the POST returns 201 with a named key.
 *
 * WHY THE POST IS THE PRIMARY PATH, NOT A FALLBACK
 * ────────────────────────────────────────────────
 * Phase 3's auto-enqueue gate only fires when an event carries a usable fit
 * window, and `t90` is NULL on all 313 events in this database. Until a
 * duration source exists, this endpoint is how fit jobs actually get created,
 * so it validates the caller's window properly rather than treating it as an
 * optional override.
 */

import { Router } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  eventsTable,
  grbFitJobs,
  grbSpectralFits,
  grbValidationFlags,
  GRB_DETECTOR_CFGS,
  type GrbDetectorCfg,
} from "@workspace/db";
import { GetEventParams } from "@workspace/api-zod";

import { requireAuth } from "../middlewares/auth.js";

const router = Router();

/**
 * bayspec additive models the pipeline can actually fit — the keys of
 * MODEL_COLS in pipeline/constants.py. Validated here so an unknown model
 * returns 400 immediately instead of failing inside the worker minutes later,
 * after the job has been claimed and the archive downloaded.
 */
const FITTABLE_MODELS = [
  "cpl", "band", "bpl", "pl", "sbpl", "cband",
  "dband", "hlecpl", "hleband", "grbm", "cutoffpl",
] as const;

function parseEventId(rawParams: unknown): number | null {
  const parsed = GetEventParams.safeParse(rawParams);
  if (!parsed.success) return null;
  const id = parseInt(parsed.data.id, 10);
  return isNaN(id) || id <= 0 ? null : id;
}

/**
 * Shape one fit row for the wire.
 *
 * The three Ep prior diagnostics are top-level, not buried in raw_params: the
 * Phase 6 validation rules key off them, and a client must be able to tell an
 * unconstrained fit from a measured one without a second request or a JSON
 * dig. `epPrior` carries the numbers that EXPLAIN those flags — the 1-sigma
 * log-Ep interval and the prior bounds it may have hit — which exist only in
 * raw_params. The full raw_params is returned as well, so nothing the pipeline
 * produced is withheld.
 *
 * Error fields are asymmetric OFFSETS, as stored: the interval is
 * [value - low, value + high]. They are deliberately not pre-summed into
 * bounds here; doing that in one place and not another is how a factor of two
 * gets into a published error bar.
 */
function formatFit(row: typeof grbSpectralFits.$inferSelect) {
  const raw = (row.rawParams ?? {}) as Record<string, unknown>;
  const num = (k: string): number | null => {
    const v = raw[k];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };

  return {
    id:            String(row.id),
    eventId:       row.eventId,
    jobId:         row.jobId != null ? String(row.jobId) : null,
    model:         row.model,
    detectorCfg:   row.detectorCfg,
    mode:          row.mode,
    fitDets:       row.fitDets,
    includeBgo:    row.includeBgo,
    nlive:         row.nlive,
    // Fit window, seconds relative to trigger.
    t1:            row.t1 ?? null,
    t2:            row.t2 ?? null,

    alpha:         row.alpha,
    alphaLow:      row.alphaLow,
    alphaHigh:     row.alphaHigh,
    // null = the fitted model has no high-energy index (the CPL family),
    // NOT that beta is zero.
    beta:          row.beta ?? null,
    betaLow:       row.betaLow ?? null,
    betaHigh:      row.betaHigh ?? null,
    epBest:        row.epBest,
    epLow:         row.epLow,
    epHigh:        row.epHigh,
    amplitude:     row.amplitude,
    vfvBest:       row.vfvBest ?? null,
    vfvLow:        row.vfvLow ?? null,
    vfvHigh:       row.vfvHigh ?? null,

    // ── Ep prior diagnostics, front and centre ──────────────────────────────
    // false = the 1-sigma log-Ep interval reached a prior edge, so epBest is an
    // artefact of the prior rather than a measurement. null = the model has no
    // Ep parameter at all, which is not the same thing.
    epConstrained:       row.epConstrained ?? null,
    logEpHitsPriorLow:   row.logEpHitsPriorLow ?? null,
    logEpHitsPriorHigh:  row.logEpHitsPriorHigh ?? null,
    epPrior: {
      oneSigmaMin: num("log_Ep_1sigma_min"),
      oneSigmaMax: num("log_Ep_1sigma_max"),
      priorLo:     num("log_Ep_prior_lo"),
      priorHi:     num("log_Ep_prior_hi"),
    },

    hdf5Path:              row.hdf5Path ?? null,
    hdf5Key:               row.hdf5Key,
    fitDir:                row.fitDir ?? null,
    fitFingerprint:        row.fitFingerprint ?? null,
    extractionFingerprint: row.extractionFingerprint ?? null,
    pipelineVersion:       row.pipelineVersion ?? null,

    /** The complete extract_params() row, verbatim. */
    rawParams:     raw,
    fitTimestamp:  row.fitTimestamp ? row.fitTimestamp.toISOString() : null,
    createdAt:     row.createdAt.toISOString(),
  };
}

// ─── GET /events/:id/spectral-fits ───────────────────────────────────────────
//
// Every completed fit for this event, newest first. Re-fitting appends rather
// than replacing, so this is a history: a parameter that moved between runs
// stays visible.

router.get("/events/:id/spectral-fits", async (req, res) => {
  const id = parseEventId(req.params);
  if (id === null) {
    res.status(400).json({ error: "Invalid event ID — must be a positive integer" });
    return;
  }

  const rows = await db
    .select()
    .from(grbSpectralFits)
    .where(eq(grbSpectralFits.eventPk, BigInt(id)))
    .orderBy(desc(grbSpectralFits.createdAt), desc(grbSpectralFits.id));

  res.json(rows.map(formatFit));
});

// ─── GET /events/:id/validation ──────────────────────────────────────────────
//
// Validation flags for this event's LATEST fit.
//
// `evaluated` is read from the FIT's recorded validation state (migration
// 0027), never inferred from whether any flag happens to exist.
//
// A passing check writes no row, so flag count cannot separate "every check ran
// and none objected" from "nothing has ever looked at this fit" — two opposite
// statements. `evaluated_at` answers the first question directly and
// `checksRun` says which checks that consisted of, so all three client states
// are reachable:
//
//   evaluated=false                 -> not yet validated
//   evaluated=true, flags.length>0  -> validated, findings below
//   evaluated=true, flags.length==0 -> validated, nothing objected
//
// The third was unreachable before this and is the one worth getting right: it
// is the only state that may legitimately render as reassurance.

router.get("/events/:id/validation", async (req, res) => {
  const id = parseEventId(req.params);
  if (id === null) {
    res.status(400).json({ error: "Invalid event ID — must be a positive integer" });
    return;
  }

  const [latestFit] = await db
    .select({
      id: grbSpectralFits.id,
      createdAt: grbSpectralFits.createdAt,
      checksRun: grbSpectralFits.checksRun,
      evaluatedAt: grbSpectralFits.evaluatedAt,
    })
    .from(grbSpectralFits)
    .where(eq(grbSpectralFits.eventPk, BigInt(id)))
    .orderBy(desc(grbSpectralFits.createdAt), desc(grbSpectralFits.id))
    .limit(1);

  if (!latestFit) {
    res.json({
      fitId: null,
      fitCreatedAt: null,
      evaluated: false,
      evaluatedAt: null,
      checksRun: [],
      flags: [],
      counts: { critical: 0, warning: 0, info: 0 },
    });
    return;
  }

  const flags = await db
    .select()
    .from(grbValidationFlags)
    .where(eq(grbValidationFlags.fitId, latestFit.id))
    .orderBy(desc(grbValidationFlags.createdAt), desc(grbValidationFlags.id));

  const counts = { critical: 0, warning: 0, info: 0 };
  for (const f of flags) {
    if (f.severity === "critical" || f.severity === "warning" || f.severity === "info") {
      counts[f.severity] += 1;
    }
  }

  res.json({
    fitId: String(latestFit.id),
    fitCreatedAt: latestFit.createdAt.toISOString(),
    // Proof that checks ran, not an inference from their silence.
    evaluated: latestFit.evaluatedAt != null,
    evaluatedAt: latestFit.evaluatedAt ? latestFit.evaluatedAt.toISOString() : null,
    /** Which checks executed. Skipped checks are absent, not listed as passing. */
    checksRun: latestFit.checksRun ?? [],
    flags: flags.map((f) => ({
      id:           String(f.id),
      checkName:    f.checkName,
      severity:     f.severity,
      message:      f.message,
      referenceUrl: f.referenceUrl ?? null,
      createdAt:    f.createdAt.toISOString(),
    })),
    counts,
  });
});

// ─── POST /events/:id/fit-jobs ───────────────────────────────────────────────
//
// Manually enqueue a fit. The primary way jobs are created today, because the
// automatic gate needs a t90 nothing populates.
//
// Everything the worker requires is checked HERE, so a caller learns
// immediately rather than watching a job fail minutes later for a reason that
// was knowable at request time.

router.post("/events/:id/fit-jobs", requireAuth, async (req, res) => {
  const id = parseEventId(req.params);
  if (id === null) {
    res.status(400).json({ error: "Invalid event ID — must be a positive integer" });
    return;
  }

  const body = (req.body ?? {}) as {
    t1?: unknown; t2?: unknown; model?: unknown; detectorCfg?: unknown; detector_cfg?: unknown;
  };

  // ── Window: required, and never inferred ──────────────────────────────────
  // There is usually no t90 to fall back on, so the caller states the interval
  // or gets a 400. The worker would otherwise refuse the job for exactly this
  // reason, only asynchronously.
  const t1 = typeof body.t1 === "number" ? body.t1 : NaN;
  const t2 = typeof body.t2 === "number" ? body.t2 : NaN;
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) {
    res.status(400).json({
      error: "t1 and t2 are required and must be finite numbers (seconds relative to trigger)",
    });
    return;
  }
  // Mirrors chk_grb_fit_job_window_ordered, so a bad interval is a clean 400
  // rather than a database constraint violation surfacing as a 500.
  if (!(t2 > t1)) {
    res.status(400).json({ error: "t2 must be greater than t1" });
    return;
  }

  // ── Model / detector configuration ────────────────────────────────────────
  const model = body.model === undefined ? "cpl" : body.model;
  if (typeof model !== "string" || !FITTABLE_MODELS.includes(model as typeof FITTABLE_MODELS[number])) {
    res.status(400).json({
      error: `model must be one of: ${FITTABLE_MODELS.join(", ")}`,
    });
    return;
  }

  const rawCfg = body.detectorCfg ?? body.detector_cfg;
  const detectorCfg = rawCfg === undefined ? "nai_only" : rawCfg;
  if (
    typeof detectorCfg !== "string" ||
    !GRB_DETECTOR_CFGS.includes(detectorCfg as GrbDetectorCfg)
  ) {
    res.status(400).json({
      error: `detectorCfg must be one of: ${GRB_DETECTOR_CFGS.join(", ")}`,
    });
    return;
  }

  // ── The event, and the worker's own preconditions ─────────────────────────
  const [event] = await db
    .select({
      id:        eventsTable.id,
      eventId:   eventsTable.eventId,
      eventType: eventsTable.eventType,
      ra:        eventsTable.ra,
      dec:       eventsTable.dec,
    })
    .from(eventsTable)
    .where(eq(eventsTable.id, BigInt(id)))
    .limit(1);

  if (!event) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  if (event.eventType !== "GRB") {
    res.status(400).json({
      error: `Spectral fitting applies to GRB events; this event is ${event.eventType}`,
    });
    return;
  }

  // The pipeline selects detectors by angle to the source and generates the
  // detector response at that position — without a sky position it cannot
  // start. run_fit() raises FitInputError on exactly this.
  if (event.ra == null || event.dec == null) {
    res.status(400).json({
      error:
        "Event has no sky position (ra/dec); the fit cannot select detectors " +
        "or generate a detector response without one",
    });
    return;
  }

  // ── Don't queue the same work twice ───────────────────────────────────────
  // A repeated request with identical parameters would produce a second job
  // whose fit carries the same fingerprint as the first — the pipeline would
  // skip the computation and write a duplicate row.
  const [existing] = await db
    .select({ id: grbFitJobs.id, status: grbFitJobs.status })
    .from(grbFitJobs)
    .where(
      and(
        eq(grbFitJobs.eventPk, BigInt(id)),
        eq(grbFitJobs.model, model),
        eq(grbFitJobs.detectorCfg, detectorCfg as GrbDetectorCfg),
        inArray(grbFitJobs.status, ["pending", "running"]),
      ),
    )
    .limit(1);

  if (existing) {
    res.status(409).json({
      error: `A ${existing.status} fit job already exists for this event with the same model and detector configuration`,
      jobId: String(existing.id),
    });
    return;
  }

  const [job] = await db
    .insert(grbFitJobs)
    .values({
      eventPk:     BigInt(id),
      eventId:     event.eventId,
      // NULL: GRBContext.from_name() resolves only the eight curated bursts in
      // the pipeline's catalog, so the worker builds the context from this
      // event's RA/Dec/trigger time instead.
      grbName:     null,
      model,
      detectorCfg: detectorCfg as GrbDetectorCfg,
      nlive:       1000,
      t1,
      t2,
    })
    .returning();

  res.status(201).json({
    job: {
      id:          String(job!.id),
      eventId:     job!.eventId,
      model:       job!.model,
      detectorCfg: job!.detectorCfg,
      nlive:       job!.nlive,
      t1:          job!.t1,
      t2:          job!.t2,
      status:      job!.status,
      requestedAt: job!.requestedAt.toISOString(),
    },
  });
});

export default router;
