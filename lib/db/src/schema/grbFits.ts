/**
 * grbFits.ts — GRB spectral re-fitting domain (migration 0025)
 * ---------------------------------------------------------------------------
 * `core.events` stores `fluence` and `t90` exactly as the GCN notice reported
 * them. It does not derive spectral shape. These tables hold an INDEPENDENT
 * re-fit of the raw Fermi GBM data through the `fermi-gbm-analysis` pipeline
 * (heapy extraction + bayspec PGSTAT + MultiNest nested sampling), so a fitted
 * Ep can be compared against what the notice claimed rather than trusted.
 *
 * Every column here was verified against a real end-to-end fit of GRB150514A
 * (2026-09-09), not against the integration brief's placeholder names — several
 * of which did not exist. The pipeline's actual `extract_params()` output is
 * the source of truth for `raw_params`, and the notes below record where it
 * differs from what one would assume.
 *
 * Invariants encoded here and enforced by CHECK constraints in the migration:
 *
 *   1. NULL is UNKNOWN or NOT-APPLICABLE, never zero. `beta` is absent for the
 *      CPL family by construction (see below); a zero there would read as a
 *      measured spectral index of 0, which is not a thing the fit said.
 *   2. A fit row is the record of one fit RUN. Re-fitting appends a row; it
 *      never mutates the previous one, so a parameter that moved between runs
 *      stays visible — the same rule `core.event_revisions` applies to notices.
 *   3. The typed columns are a queryable projection, NOT the record. The full
 *      `extract_params()` row is kept verbatim in `raw_params`, so a value the
 *      schema does not model is preserved rather than dropped.
 */

import {
  bigserial,
  bigint,
  integer,
  text,
  boolean,
  doublePrecision,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { coreSchema, events } from "./events.js";

// ─── Shared vocabularies ─────────────────────────────────────────────────────

/**
 * Lifecycle of a queued fit.
 *
 * No `retrying` state: v1 does not retry automatically. A failed fit stays
 * `failed` with its error text until a human re-enqueues it through the API —
 * a spectral fit costs minutes of CPU and an archive download, so silently
 * looping on a burst whose data is genuinely unfittable is worse than stopping.
 */
export const GRB_FIT_JOB_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
] as const;

export type GrbFitJobStatus = (typeof GRB_FIT_JOB_STATUSES)[number];

/**
 * Which detectors enter the spectral fit.
 *
 * The pipeline defaults to NaI only (`include_bgo=False`): BGO is kept in the
 * catalog detector set and used for geometry, but excluded from the fit unless
 * asked for. Confirmed in `pipeline/detectors.py::fit_detectors` — the
 * GRB150514A run carried `sel_dets=['b0','n3','n6','n7']` and fitted
 * `['n3','n6','n7']`.
 */
export const GRB_DETECTOR_CFGS = ["nai_only", "nai_bgo"] as const;

export type GrbDetectorCfg = (typeof GRB_DETECTOR_CFGS)[number];

/**
 * Time-integrated (one spectrum over the whole burst window) vs time-resolved
 * (one per slice).
 *
 * Only `tintegrated` is produced today — it is the pipeline's default stage
 * set. The column exists because ONE HDF5 file holds both kinds for a GRB, and
 * without it a row's meaning would depend on parsing `hdf5_key`'s prefix.
 */
export const GRB_FIT_MODES = ["tintegrated", "tresolved"] as const;

export type GrbFitMode = (typeof GRB_FIT_MODES)[number];

/**
 * Spectral models that carry a high-energy index `beta`.
 *
 * From `pipeline/constants.py::MODEL_COLS`. The CPL family
 * (`cpl`, `hlecpl`, `cutoffpl`) has only `alpha`, `log_Ep`, `log_A` — there is
 * no beta to store, and `beta IS NULL` on those rows means exactly that.
 */
export const GRB_BAND_FAMILY_MODELS = [
  "band",
  "bpl",
  "sbpl",
  "cband",
  "dband",
  "hleband",
  "grbm",
] as const;

export type GrbBandFamilyModel = (typeof GRB_BAND_FAMILY_MODELS)[number];

/** Severity of a validation finding. Ordering is informational → blocking. */
export const GRB_VALIDATION_SEVERITIES = ["info", "warning", "critical"] as const;

export type GrbValidationSeverity = (typeof GRB_VALIDATION_SEVERITIES)[number];

// ─── core.grb_fit_jobs ───────────────────────────────────────────────────────

export const grbFitJobs = coreSchema.table(
  "grb_fit_jobs",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),

    /**
     * FOREIGN KEY, NOT A SERIAL. `bigserial` on a foreign key carries a
     * DEFAULT nextval() that silently invents a reference for any INSERT that
     * omits the column — the bug documented on core.event_annotations.
     */
    eventPk: bigint("event_pk", { mode: "bigint" })
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),

    /** GCN string id, denormalised so the queue is readable without a join. */
    eventId: text("event_id").notNull(),

    /**
     * The GRB name handed to the pipeline, e.g. "GRB150514A".
     *
     * Usually spelled like `event_id` — core.events normalises to the unspaced
     * form ("GRB260609A"; verified across all 222 GRB rows), which is also how
     * the pipeline catalog spells names. GCN's own spaced rendering
     * ("GRB 260211A") survives on core.event_circulars.gcn_event_id, not here.
     *
     * A separate column all the same, because matching spelling is not the
     * constraint that matters: `GRBContext.from_name()` resolves ONLY the eight
     * curated bursts in the pipeline's `grb_config.py` catalog, which carry the
     * hand-picked detector sets and time windows a fit needs. A live GCN burst
     * is not in that catalog under any spelling, so it arrives here as NULL and
     * the worker must construct a GRBContext from the event's own RA/Dec/
     * trigger time instead. NULL records that difference rather than implying a
     * catalog entry exists.
     */
    grbName: text("grb_name"),

    /** bayspec additive model name, e.g. "cpl" | "band". */
    model: text("model").notNull().default("cpl"),
    detectorCfg: text("detector_cfg")
      .notNull()
      .default("nai_only")
      .$type<GrbDetectorCfg>(),
    /** MultiNest live points. 200 is a smoke-test value; 1000 is production. */
    nlive: integer("nlive").notNull().default(1000),

    /**
     * Explicit time-integrated fit window, seconds relative to trigger
     * (migration 0026).
     *
     * A tint fit is defined over an interval and the pipeline refuses to run
     * without one. The curated catalog bursts carry a hand-picked window; a
     * live GCN burst does not, so it has to be stated here. NULL means "not
     * specified" — the worker then falls back to [0, t90] if the event has a
     * t90, and FAILS the job with a stated reason if it does not. It never
     * defaults to a plausible-looking interval: a fit over a guessed window
     * produces real-looking parameters for an interval nobody chose.
     */
    t1: doublePrecision("t1"),
    t2: doublePrecision("t2"),

    status: text("status").notNull().default("pending").$type<GrbFitJobStatus>(),
    attempts: integer("attempts").notNull().default(0),
    /** Exception text from the failed attempt. NULL while the job is healthy. */
    error: text("error"),

    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Set when a worker claims the row. NULL = never started. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    /** Set on success OR failure. NULL = still queued or still running. */
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    // The worker's claim query: SELECT ... WHERE status = 'pending'
    // ORDER BY requested_at FOR UPDATE SKIP LOCKED. Partial, so the index
    // holds only the queue rather than every fit ever run, and includes
    // requested_at because the claim is ordered by it.
    index("grb_fit_jobs_pending_idx")
      .on(t.status, t.requestedAt)
      .where(sql`${t.status} = 'pending'`),
    index("grb_fit_jobs_event_idx").on(t.eventPk, t.requestedAt),
  ],
);

export type GrbFitJob = typeof grbFitJobs.$inferSelect;
export type InsertGrbFitJob = typeof grbFitJobs.$inferInsert;

// ─── core.grb_spectral_fits ──────────────────────────────────────────────────

/**
 * One row per completed fit.
 *
 * TWO TIERS, deliberately:
 *
 *   - Typed columns for what the API filters, sorts and renders, and for what
 *     Phase 6's validation rules must evaluate in SQL.
 *   - `raw_params` holds the entire `extract_params()` row verbatim, so the
 *     max-likelihood values, `sigma_Ep`, `sigma_vFv` and anything a future
 *     model emits survive without a migration.
 *
 * The pipeline's real output columns (verified on a live fit, not assumed):
 *   alpha, alpha_low, alpha_high, alpha_ml, A, A_ml,
 *   Ep_best, Ep_low, Ep_high, Ep_ml, sigma_Ep,
 *   vFv_best, vFv_low, vFv_high, sigma_vFv,
 *   ep_constrained, log_Ep_hits_prior_low, log_Ep_hits_prior_high,
 *   log_Ep_1sigma_min, log_Ep_1sigma_max, log_Ep_prior_lo, log_Ep_prior_hi,
 *   include_bgo
 *
 * There is NO `log_likelihood` column — `get_model_params()` drops it for every
 * model in MODEL_COLS — and no `beta`/`norm`/`E_peak_keV`. Errors are
 * ASYMMETRIC and stored as offsets from the central value, not as bounds:
 * the 1-sigma interval is [value - low, value + high].
 */
export const grbSpectralFits = coreSchema.table(
  "grb_spectral_fits",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),

    eventPk: bigint("event_pk", { mode: "bigint" })
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),

    /**
     * The job that produced this fit. UNIQUE so a retried or double-delivered
     * worker cannot write two fit rows for one claim; NULL for a fit
     * backfilled or inserted outside the queue (Postgres permits many NULLs
     * in a unique index, which is the behaviour wanted here).
     * ON DELETE SET NULL: pruning the job queue must not delete science.
     */
    jobId: bigint("job_id", { mode: "bigint" }).references(() => grbFitJobs.id, {
      onDelete: "set null",
    }),

    model: text("model").notNull(),
    detectorCfg: text("detector_cfg").notNull().$type<GrbDetectorCfg>(),
    mode: text("mode").notNull().default("tintegrated").$type<GrbFitMode>(),

    /**
     * Detectors actually used in the fit, e.g. {n3,n6,n7} — the resolved set
     * after the NaI/BGO policy, which is not the same as the catalog's
     * `sel_dets`. Empty array would be a lie; a fit needs >= 2 detectors.
     */
    fitDets: text("fit_dets").array().notNull(),
    includeBgo: boolean("include_bgo").notNull(),
    nlive: integer("nlive").notNull(),

    /**
     * Time-integrated fit window in seconds relative to the trigger, as the
     * pipeline resolved it (GRB150514A: 0.0 → 11.3). Needed to compare against
     * a literature value, which is always quoted over a stated interval.
     */
    t1: doublePrecision("t1"),
    t2: doublePrecision("t2"),

    // ── Fitted parameters (asymmetric 1-sigma offsets) ────────────────────
    /** Low-energy photon index. */
    alpha: doublePrecision("alpha").notNull(),
    alphaLow: doublePrecision("alpha_low").notNull(),
    alphaHigh: doublePrecision("alpha_high").notNull(),

    /**
     * High-energy photon index — Band-family models ONLY.
     *
     * NULL means the fitted model has no such parameter (the CPL family), NOT
     * that beta is zero and NOT that it was unconstrained. Phase 6's Band
     * closure check (alpha > beta) must therefore skip NULL rows rather than
     * treat them as violations.
     */
    beta: doublePrecision("beta"),
    betaLow: doublePrecision("beta_low"),
    betaHigh: doublePrecision("beta_high"),

    /** Peak energy of the vFv spectrum [keV] — the pipeline's `Ep_best`. */
    epBest: doublePrecision("ep_best").notNull(),
    epLow: doublePrecision("ep_low").notNull(),
    epHigh: doublePrecision("ep_high").notNull(),

    /** Model amplitude — the pipeline's `A` (normalisation at the pivot). */
    amplitude: doublePrecision("amplitude").notNull(),

    /** Peak vFv flux [erg cm^-2 s^-1] — the pipeline's `vFv_best`. */
    vfvBest: doublePrecision("vfv_best"),
    vfvLow: doublePrecision("vfv_low"),
    vfvHigh: doublePrecision("vfv_high"),

    // ── Ep prior diagnostics (typed because Phase 6 queries them) ──────────
    /**
     * Whether the 1-sigma log-Ep interval stays clear of the prior edges.
     *
     * FALSE means Ep is unconstrained — the posterior ran into the prior
     * boundary, so the quoted Ep is an artefact of the prior, not a
     * measurement, and must not be compared against literature or displayed as
     * a result without saying so. NULL means the model has no Ep parameter at
     * all (e.g. a power law), which is not the same as "not constrained".
     */
    epConstrained: boolean("ep_constrained"),
    logEpHitsPriorLow: boolean("log_ep_hits_prior_low"),
    logEpHitsPriorHigh: boolean("log_ep_hits_prior_high"),

    // ── Provenance / reproducibility ──────────────────────────────────────
    /**
     * The per-GRB HDF5 file. NOT unique to this fit: one file holds every
     * result for the burst — each model, and both time-integrated and
     * time-resolved. `hdf5_key` is what identifies the row inside it.
     */
    hdf5Path: text("hdf5_path"),
    /**
     * The key inside that file, e.g. "tint_cpl_GRB150514A".
     *
     * Its FORMAT VARIES, which is why it is stored rather than derived:
     * `extract_params()` writes `tint_{model}_{name}` for a canonical fit but
     * `tint_{model}_{fit_fp}_{name}` when the fit landed in a versioned
     * directory, and time-resolved results key on the bare model name.
     */
    hdf5Key: text("hdf5_key").notNull(),
    /**
     * Directory holding the raw MultiNest products (`1-post_equal_weights.dat`,
     * posterior stats, plots). The canonical `.../bayspec/{model}` on a first
     * run, `.../bayspec/{model}/versions/{fit_fp}` when the fingerprint differs.
     * A later `force=True` rerun OVERWRITES the canonical directory, so this
     * path locates the products but does not by itself prove they still
     * correspond to this row — `fit_fingerprint` is what pins the configuration.
     */
    fitDir: text("fit_dir"),
    /**
     * MD5 (first 8 hex chars) over {extraction fingerprint, model,
     * fixed_params, nlive, spec_rebn, fit_dets} — the pipeline's content
     * address for this fit configuration. GRB150514A/cpl/nlive=200: "eb5fa839".
     */
    fitFingerprint: text("fit_fingerprint"),
    /** Same idea for the upstream spectral extraction. GRB150514A: "cb5756cd". */
    extractionFingerprint: text("extraction_fingerprint"),
    /** Commit SHA of the fermi-gbm-analysis checkout that produced the fit. */
    pipelineVersion: text("pipeline_version"),

    /**
     * The complete `extract_params()` row, verbatim. The typed columns above
     * are a projection of this; anything not projected (the `*_ml`
     * max-likelihood values, `sigma_Ep`, `sigma_vFv`, the log-Ep prior bounds)
     * is preserved here rather than discarded.
     */
    rawParams: jsonb("raw_params").notNull().$type<Record<string, unknown>>(),

    // ── Validation state (migration 0027) ─────────────────────────────────
    /**
     * Names of the validation checks that actually EXECUTED against this fit,
     * whether or not each produced a flag.
     *
     * A passing check writes no row to core.grb_validation_flags, so the flag
     * table alone cannot distinguish "every check ran and none objected" from
     * "nothing has ever looked at this fit". This column is what makes that
     * difference expressible. Checks that were SKIPPED — inapplicable to the
     * fitted model, or missing an input — are deliberately omitted, because
     * "did not apply" is not "ran and found nothing".
     */
    checksRun: text("checks_run").array(),
    /** When validation last ran. NULL = it never has. */
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),

    /** When the fit itself was produced, as distinct from when it was stored. */
    fitTimestamp: timestamp("fit_timestamp", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("grb_spectral_fits_job_uniq").on(t.jobId),
    // "fits for an event, newest first" — the Phase 4 list endpoint.
    index("grb_spectral_fits_event_idx").on(t.eventPk, t.createdAt),
    index("grb_spectral_fits_model_idx").on(t.model, t.createdAt),
  ],
);

export type GrbSpectralFit = typeof grbSpectralFits.$inferSelect;
export type InsertGrbSpectralFit = typeof grbSpectralFits.$inferInsert;

// ─── core.grb_validation_flags ───────────────────────────────────────────────

/**
 * Findings from the Phase 6 validation engine, one row per triggered check.
 *
 * A check that PASSES writes no row. The absence of a critical flag therefore
 * means "no check objected", which is only meaningful alongside knowing which
 * checks ran — recorded per-fit by `check_name` on the rows that did fire.
 */
export const grbValidationFlags = coreSchema.table(
  "grb_validation_flags",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    eventPk: bigint("event_pk", { mode: "bigint" })
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    fitId: bigint("fit_id", { mode: "bigint" })
      .notNull()
      .references(() => grbSpectralFits.id, { onDelete: "cascade" }),

    /** Stable identifier of the rule, e.g. "band_closure". */
    checkName: text("check_name").notNull(),
    severity: text("severity").notNull().$type<GrbValidationSeverity>(),
    /** Human-readable explanation, including the numbers that triggered it. */
    message: text("message").notNull(),
    /**
     * Citation for the threshold this check applied — a GCN circular for a
     * literature comparison, or the reference text for a physical bound. NULL
     * when the rule is self-evident (Band closure needs no citation).
     */
    referenceUrl: text("reference_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("grb_validation_flags_fit_idx").on(t.fitId, t.severity),
    index("grb_validation_flags_event_idx").on(t.eventPk, t.createdAt),
  ],
);

export type GrbValidationFlag = typeof grbValidationFlags.$inferSelect;
export type InsertGrbValidationFlag = typeof grbValidationFlags.$inferInsert;

// ─── core.grb_literature_refs ────────────────────────────────────────────────

/**
 * Published spectral parameters, for comparison against a re-fit.
 *
 * Seeded with EXACTLY the three bursts in the pipeline's own `GCN_REFS` table
 * (`grb_config.py`) — the only ones with literature values available out of the
 * box. Growing this table is a manual curation task: every row must be
 * transcribed from a named circular, never inferred, and never produced by a
 * model.
 *
 * `model` matters as much as the numbers. GRB150514A's published fit is a Band
 * function while the pipeline fits CPL by default, so a comparison across the
 * two is a comparison across model families — legitimate for a soft-Ep,
 * steep-beta burst, but the mismatch has to be stated rather than hidden.
 */
export const grbLiteratureRefs = coreSchema.table(
  "grb_literature_refs",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    /** Pipeline-catalog spelling, e.g. "GRB150514A". */
    eventName: text("event_name").notNull(),
    /** The circular as cited in the source table, e.g. "GCN 17819". */
    gcnSource: text("gcn_source").notNull(),
    gcnUrl: text("gcn_url"),
    /** Model the published values belong to: "cpl" | "band". */
    model: text("model").notNull(),
    /** Published interval relative to trigger [s]. */
    t1: doublePrecision("t1"),
    t2: doublePrecision("t2"),

    /** Published low-energy index and its symmetric published error. */
    alpha: doublePrecision("alpha"),
    alphaErr: doublePrecision("alpha_err"),
    /**
     * Published high-energy index.
     *
     * NULL on all three seeded rows: `GCN_REFS` carries no `beta` field. For
     * GRB150514A the published Band beta exists only inside the free-text
     * `note` (transcribed verbatim below), and parsing a number out of prose to
     * present it as a structured measurement is the kind of quiet fabrication
     * this codebase refuses. It stays in the note until a human curates it.
     */
    beta: doublePrecision("beta"),
    betaErr: doublePrecision("beta_err"),

    /** Published peak energy [keV] and its symmetric published error. */
    ePeakKev: doublePrecision("e_peak_kev"),
    ePeakErr: doublePrecision("e_peak_err"),

    /** The source table's own note, verbatim — caveats included. */
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("grb_literature_refs_name_source_uniq").on(t.eventName, t.gcnSource)],
);

export type GrbLiteratureRef = typeof grbLiteratureRefs.$inferSelect;
export type InsertGrbLiteratureRef = typeof grbLiteratureRefs.$inferInsert;

// ─── Relations ───────────────────────────────────────────────────────────────

export const grbFitJobsRelations = relations(grbFitJobs, ({ one, many }) => ({
  event: one(events, { fields: [grbFitJobs.eventPk], references: [events.id] }),
  fits: many(grbSpectralFits),
}));

export const grbSpectralFitsRelations = relations(grbSpectralFits, ({ one, many }) => ({
  event: one(events, { fields: [grbSpectralFits.eventPk], references: [events.id] }),
  job: one(grbFitJobs, { fields: [grbSpectralFits.jobId], references: [grbFitJobs.id] }),
  validationFlags: many(grbValidationFlags),
}));

export const grbValidationFlagsRelations = relations(grbValidationFlags, ({ one }) => ({
  event: one(events, { fields: [grbValidationFlags.eventPk], references: [events.id] }),
  fit: one(grbSpectralFits, {
    fields: [grbValidationFlags.fitId],
    references: [grbSpectralFits.id],
  }),
}));
