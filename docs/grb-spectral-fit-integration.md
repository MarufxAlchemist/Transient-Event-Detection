# GRB Spectral Fit Integration (fermi-gbm-analysis)

Status as of **2026-09-15**: complete, verified end to end, committed on
`feature/astro-colibri-v2`. This is the closeout record for the eight-phase
integration (Phases 0–7) of the
[`fermi-gbm-analysis`](https://github.com/Kamil-Nadaf/fermi-gbm-analysis) pipeline — heapy extraction, bayspec
PGSTAT, MultiNest nested sampling — into AstroSentinel.

It records where the implementation departed from the original brief and why,
the end-to-end evidence, and everything found but deliberately left unfixed, so
none of it has to be re-derived.

---

## 1. What exists now

| Layer | Files |
|---|---|
| Schema | `lib/db/migrations/0025_grb_spectral_fits.sql`, `0026_grb_fit_job_window.sql`, `0027_grb_validation_state.sql`; `lib/db/src/schema/grbFits.ts` |
| Validation engine | `backend/grb_fit_worker/validation.py`; `backend/tests/test_grb_validation.py` (23 tests) |
| Worker | `backend/grb_fit_worker/` (`__main__`, `db`, `pipeline_runner`); `Dockerfile.grb-fit-worker` |
| Ingestion trigger | `artifacts/api-server/src/lib/grbFitGate.ts` (+ 9 tests), `grbFitEnqueue.ts`; hook in `kafkaConsumer.ts` |
| API | `artifacts/api-server/src/routes/grbFits.ts` |
| Frontend | `artifacts/astro-sentinel/src/components/SpectralFitPanel.tsx` on the event detail page |
| Deployment | `grb-fit-worker` service and `grb_fit_data` volume in `docker-compose.yml` |

Four tables: `core.grb_fit_jobs` (queue), `core.grb_spectral_fits`,
`core.grb_validation_flags`, `core.grb_literature_refs` (3 seeded GCN references).

Routes:

| Method | Path | Auth |
|---|---|---|
| `GET` | `/events/:id/spectral-fits` | none |
| `GET` | `/events/:id/validation` | none |
| `POST` | `/events/:id/fit-jobs` | required; `t1`/`t2` mandatory |

Pipeline pinned at `e36c1711d939f6a3acc0cfc7ca954c3841ea2896`, with
`bayspec==0.3.14` and `heapyx==0.2.1` pinned explicitly (see §2, Phase 2b).

**The pipeline is cloned from a mirror, not upstream.** Upstream
(`github.com/Kamil-Nadaf/fermi-gbm-analysis`) stopped being publicly reachable
during this integration — see §5. The image now clones
[`MarufxAlchemist/fermi-gbm-analysis-mirror`](https://github.com/MarufxAlchemist/fermi-gbm-analysis-mirror),
which holds the author's history up to the pinned SHA exactly as authored (MIT
license unchanged, no commits added). The reasoning is in the comment block at
the top of `Dockerfile.grb-fit-worker`.

---

## 2. Divergences from the original brief

Phase 0 existed because the brief was written against an assumed API. Most of
what follows is the cost of that assumption being wrong in ways that would have
failed silently.

### Phase 0 — Repo recon

- **The runner returns a mutated context, not a result.**
  `GRBPipelineRunner.run()` returns the mutated `GRBContext`; stages are an
  argument (`stages="geometry,spectra_tint,fit_tint"`), not methods. Results are
  read back off the context and the HDF5 store.
- **Errors are asymmetric offsets, and half the brief's fields do not exist.**
  No `log_likelihood`, `beta`, `norm` or `E_peak_keV`. The real schema is
  `alpha`/`alpha_low`/`alpha_high`/`alpha_ml`, `A`, `Ep_best`/`Ep_low`/`Ep_high`/
  `sigma_Ep`, `vFv_*`, `ep_constrained` and the `log_Ep` prior flags. The
  `_low`/`_high` values are **1σ offsets**, not interval bounds — every layer
  treats them that way and the UI says so.
- **One shared HDF5 file per burst.** All fits share
  `<GRB>_bayspec_data.h5`, keyed `tint_{model}_{name}` (or
  `tint_{model}_{fp}_{name}` when versioned); the brief's `vFv_Ep_bayspec` key
  does not exist. The schema stores both `hdf5_path` and `hdf5_key`.

### Phase 1 — Schema

- **Two-tier storage**: typed columns for what is queried, `raw_params` JSONB
  for everything the extractor emitted, because the parameter set is
  model-dependent.
- **`beta` is nullable**: the CPL family has no high-energy index. The UI shows
  `N/A (cpl has no β)`, never `0`.
- **Prior-hit flags are first-class columns** (`ep_constrained`,
  `log_ep_hits_prior_low/high`), so unconstrained fits are findable in SQL.

### Phase 2 / 2b — Worker and its dependencies

- **Live bursts have no catalog entry.** `GRBContext.from_name()` resolves only
  the 8 curated bursts. Real alerts need `GRBContext(...)` built directly from
  RA/Dec/UTC with `det_mode="auto"`. This was the blocking issue, found in source
  and verified on a real event before any other Phase 2 work.
- **psycopg2, not asyncpg** — the repo's existing Python client.
- **Two undeclared hard dependencies**: `cartopy` (module-level import in
  `heapy.geos.geometry`, would have failed every job) and `ipython_genutils`
  (cold-extraction path only — invisible on a cached re-run).
- **Pinning the pipeline SHA does not pin its dependencies.** bayspec floated to
  0.4.0 and broke against arviz 1.3.0 (`module 'arviz' has no attribute 'waic'`).
- **Host hazards**: Git-Bash/MSYS rewrote `-e DATA_BASE=/workspace/data` into a
  Windows path; Python's block-buffered stdout under `docker exec | tee` made a
  working fit look hung. Neither affects the compose deployment path (re-checked
  under a true cold start).

### Phase 3 — Ingestion trigger

- **The brief's enqueue condition can never fire.** It gated on fluence and T90
  and fitted `[0, t90]`, but `t90` is NULL on every event in this database.
  Replaced with a **feasibility** gate: GRB, first notice, not a retraction,
  RA/Dec present, T90 > 0. Auto-enqueue therefore currently never happens, which
  is correct: the queue never fills with jobs guaranteed to fail.
- **An explicit fit window became a schema requirement** (migration 0026).

### Phase 4–5 — API and panel

- **`epPrior` is surfaced top-level**, and the validation route was built not to
  depend on Phase 6 existing.
- **Two live fabricated-data bugs were found and removed**: `SpectralFit.tsx` and
  `SpectralComparison.tsx` displayed invented parameters and an invented AIC
  table for every event. Both now show honest empty states, and the dashboard's
  Spectral Fit tab is gated to GRBs at the type level.

### Phase 6 — Validation engine

- **An empty flag list is ambiguous.** It cannot distinguish "checks ran and
  found nothing" from "checks never ran". Migration 0027 adds `checks_run` and
  `evaluated_at`.
- **An inapplicable check is omitted, never recorded as passed** — band closure
  for a model with no β, literature comparison without a reference.
- **The synchrotron check is INFO, not a warning**: α > −2/3 favours a
  photospheric origin; it is not a bad fit.
- **Checks compare the fit's 1σ interval, not its point estimate.** A real
  GRB150514A fit (α = −1.508 +0.076/−0.077) sat 0.008 past the fast-cooling
  limit with 1σ straddling it; flagging it would have been an artefact. Every
  numeric threshold cites its source; anything uncitable was left out.

### Phase 7 — Smoke verification

- **Two NaI detectors are not guaranteed.** Geometry selection returned one NaI
  for the test burst and the pipeline refused (`<2 detectors for tint fit`). A
  legitimate gate; the re-fit form's `nai_bgo` option is the documented remedy.

---

## 3. Phase 7 end-to-end evidence

Every job was submitted through `POST /events/2/fit-jobs` — the endpoint the
re-fit form calls — on a stack brought up from destroyed volumes. No row was
inserted by hand.

| Job | Model | Detectors | State | Wall | β stored | Checks | Outcome |
|---|---|---|---|---|---|---|---|
| 1 | cpl | nai_only | failed | 356 s | — | — | <2 NaI; error stored verbatim, no retry |
| 2 | cpl | nai_bgo | succeeded | 41 s | NULL | 3 | α = −0.437, Ep unconstrained |
| 3 | band | nai_bgo | succeeded | 42 s | −5.369 | 4 | band closure ran and passed |
| 4 | sbpl | nai_bgo | succeeded | 42 s | present | 4 | α = −0.445 |

Every real fit returned **Ep unconstrained**, and the system said so rather than
presenting 27.42 keV as a measurement. That is the behaviour the validation
engine exists for.

### Latency under worker load

| Measurement | Worker busy (~100% CPU) | Worker idle |
|---|---|---|
| event → broadcast (enqueue cost) | 0.14 µs | 0.14 µs |
| `/healthz` p50 | 7.31 ms | 9.51 ms |
| `/api/events` p50 / p95 | 13.61 / 32.55 ms | 13.69 / 26.15 ms |
| `/api/events/stats` p95 | 45.16 ms | 19.60 ms |

Medians are unaffected; only the p95 tail widens, bounded under 50 ms. The worker
holds **no locks** on `core.events` or any GRB table while fitting (claim, then
commit before the fit), so contention is host CPU only.

---

## 4. Found and not fixed

| # | Item | Status |
|---|---|---|
| 1 | **Fit job status is invisible.** `GET /events/:id/spectral-fits` returns completed fits only; pending, running, failed and never-queued render identically. Job 1 above failed after six minutes and the UI could say nothing. | Open |
| 2 | **Fits are not re-evaluated when checks are added.** `checks_run` is written once (`backend/grb_fit_worker/db.py`, `record_success`), so older fits keep a stale list that looks current. | Open |
| 3 | **The upstream pipeline's T90 gate** was left untouched on instruction — it is vendored at a pinned SHA and belongs upstream. | Open, upstream |
| 4 | **`DerivedParameters.tsx` mislabelled event types and split long/short on fluence.** | **Fixed** in `b6150e8` / `ac95066` |

Item 4's fix surfaced further follow-ups — `dashboard.tsx`'s separate type
labels, the unconditional GW "Compact binary" label, and Einstein Probe alerts
ingested as `GRB` — recorded in
[`dashboard-classification-fixes.md`](dashboard-classification-fixes.md).

---

## 5. Pre-commit re-verification (2026-09-15)

Re-run against the working tree exactly as committed, because many changes had
landed since Phase 2 was last tested.

| Check | Result |
|---|---|
| api-server tests | **278 / 278 pass**, including the 9 feasibility-gate tests |
| Backend tests | 428 pass / 18 fail. A clean worktree of the pre-integration commit gives 405 pass / **the identical 18 failures**; the +23 are the validation tests. All 18 are circular-parsing tests failing on the optional `circular_parser` package being absent from the test interpreter — pre-existing, unrelated. |
| Frontend typecheck | 17 errors — identical to the recorded baseline |
| api-server typecheck | 23 errors, **none in any integration file** — all in untouched routes, notifications and scripts |
| Library typecheck (includes the new schema) | 0 errors |
| Commit grouping | 0 forward references across the commit sequence |
| Cold `docker compose up --build` | Correct ordering, 28 migrations from zero, 4 GRB tables, 3 literature refs, `DATA_BASE=/workspace/data` uncorrupted. Worker/api-server/schema `COPY` layers hit cache — BuildKit keys those on file content, so the source is byte-identical to the Phase 7 build. |
| End-to-end fit via `POST /events/2/fit-jobs` | **Succeeded in 551 s** including a fresh HEASARC download. α = −0.350 (+1.49/−1.15), Ep = 26.6 keV unconstrained, 3 checks, one INFO flag; both GET routes reflect it. Consistent with Phase 7 (α = −0.437) within each run's 1σ — nested sampling is stochastic. |

### The upstream repository went private

A `--no-cache` rebuild of the worker resolved every scientific dependency fresh
with the same key versions (`bayspec 0.3.14`, `heapyx 0.2.1`, `arviz 1.3.0`), then
**failed cloning the pipeline**:

```
git clone https://github.com/Kamil-Nadaf/fermi-gbm-analysis.git
fatal: could not read Username for 'https://github.com': No such device or address
```

`Kamil-Nadaf/fermi-gbm-analysis` returned 404 anonymously and no longer appeared
among the account's public repositories; no renamed public copy existed. It had
been cloned successfully in Phases 0 and 7. Cached builds kept working, which is
exactly what hid it — every build since then had silently depended on a local
layer cache.

The fix follows what the Dockerfile's own comment had always named as the
mitigation — mirror, don't unpin. The Phase 0 clone (full history, `fsck` clean)
was pushed as `e36c171` to `refs/heads/main` of the public mirror
`MarufxAlchemist/fermi-gbm-analysis-mirror`: 8 commits, all by the original
author, nothing added or rewritten, MIT license intact. An anonymous clone and
checkout of the pinned SHA from the mirror yields a tree identical to the Phase 0
clone. `GRB_PIPELINE_REPO` points at the mirror; `GRB_PIPELINE_SHA` is unchanged,
so every stored fit still traces to the same code.

**Verified with a genuine cold build:** `docker compose build --no-cache
grb-fit-worker` against the mirror succeeded in 771 s with no credentials. All 15
RUN/COPY steps executed fresh — the clone step ran live from the mirror in 6 s
rather than from cache — and the image imports the pipeline and its
dependencies, reports `GRB_PIPELINE_VERSION=e36c171…`, and carries the LICENSE.

**Worth doing separately from the technical fix:** the original author, Kamil
Nadaf, appears to share a surname with this project's owner, so it may be worth
asking them directly why the repository went private — whether that was
deliberate, whether a public mirror is acceptable to them, and whether upstream
will return. The mirror solves reproducibility; it does not answer those.

---

## 6. Operating notes

- **The worker image clones the pipeline from the mirror**
  (`GRB_PIPELINE_REPO` in `Dockerfile.grb-fit-worker`). Never unpin
  `GRB_PIPELINE_SHA`; if upstream returns, change only the repo URL.
- **Compose needs `POSTGRES_PASSWORD_URLENC`** (the URL-encoded password; see
  `.env.example`) in the environment for every `docker compose` command.
- **Worker has no healthcheck by design**: no port, and a probe timing out
  mid-fit would restart the container and orphan its job as `running`.
- **`grb_fit_data` holds downloads and fit products.** Wiping it orphans
  `hdf5_path`/`fit_dir`; database rows keep their `raw_params`.
- **Manual `docker run` from Git Bash** needs `MSYS_NO_PATHCONV=1`, or
  `DATA_BASE` is rewritten into a Windows path.
- **A failed fit is never retried automatically.** Resubmit through the re-fit
  form; if the error names `<2 detectors`, choose `nai_bgo`.
- **Local host ports** (15173 / 18000 / 55432) come from a gitignored
  `docker-compose.override.yml`, not the repository.
