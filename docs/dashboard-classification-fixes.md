# Dashboard Event-Type Labels and GRB Classification

Status as of **2026-09-15**: two labelling defects fixed and the label logic
consolidated, on `feature/astro-colibri-v2`. This note records what changed and,
more importantly, what was found and deliberately left alone, so those
follow-ups survive beyond the session they were found in.

---

## 1. What was fixed

| Commit | Kind | Files |
|---|---|---|
| `b6150e8` | fix | `components/BasicInfo.tsx`, `components/DerivedParameters.tsx` |
| `ac95066` | refactor | the two above, plus `lib/formatters.ts` |

All paths are under `artifacts/astro-sentinel/src/`. Both rows live in Mission
Control's Basic Info tab, the only place either component renders.

### 1.1 Every unrecognised event type was labelled "Fast radio burst"

BasicInfo's **Type** row and DerivedParameters' **Classification** row both fell
through to `"Fast radio burst"` for anything other than GRB or GW. The generated
`AstroEvent` enum lists only `GRB | GW | FRB`, but `core.events.event_type` also
holds `EP`, `NU` and `OTHER` — so **66 of 313 events** (52 Einstein Probe,
9 neutrino, 5 unclassified) were shown as radio bursts.

| `event_type` | Type row | Classification row |
|---|---|---|
| `GRB` | Gamma-ray burst | Short GRB · Long GRB · GRB — long/short unknown (no T90) |
| `GW` | Gravitational wave | Compact binary |
| `FRB` | Fast radio burst | Fast radio burst |
| `EP` | X-ray transient | X-ray transient |
| `NU` | Neutrino candidate | Neutrino candidate |
| `OTHER` | Unclassified | Unclassified |
| anything else | Unclassified (TYPE) | Unclassified (TYPE) |

The rows serve different purposes: Type names the kind of event, Classification
narrows it. They differ only where a finer class exists (GRB, GW).

### 1.2 GRBs were split long/short on fluence

The old rule was `fluence > 1e-5 ? "Long GRB" : "Short GRB"`, with a missing
fluence falling through to Short. Only 5 of 222 GRBs carry a fluence and none
exceeds 1e-5, so **every GRB rendered as "Short GRB"**.

The class is now defined by T90, per **Kouveliotou et al. 1993, ApJ 413, L101**:
T90 < 2 s is short, T90 ≥ 2 s is long. A missing, non-finite or non-positive T90
shows `GRB — long/short unknown (no T90)`.

**There is deliberately no fluence fallback.** Substituting a different quantity
for the missing one is the defect that was removed. `t90` is NULL on all 313
events as of this note, so every GRB currently shows the unknown state — that is
correct, not a regression.

### 1.3 One source of truth for type labels

`typeLabel(eventType: string)` in `lib/formatters.ts` now holds the labels.
BasicInfo calls it directly; `getClassification` keeps only its GRB and GW cases
and delegates every other type to it, so the two rows cannot drift apart.

---

## 2. Open follow-ups — found, not fixed

None of these is blocking today. Each was left out of scope on purpose.

| # | Item | Where | Risk today |
|---|---|---|---|
| 1 | **Sidebar and event header show raw codes.** `dashboard.tsx` has its own `typeLabel` that knows only GRB/GW/FRB and returns `"EP"`, `"NU"`, `"OTHER"` verbatim — not wrong, but inconsistent with §1.1. | `pages/dashboard.tsx`, local `typeLabel` | Cosmetic. Fix: import the shared helper. |
| 2 | **Fit job status is invisible.** `GET /events/:id/spectral-fits` returns completed fits only, so pending, running, failed and never-queued all render as the same empty state. | `artifacts/api-server/src/routes/grbFits.ts` | A fit that fails after minutes is never reported in the UI. |
| 3 | **Fits are not re-evaluated when checks are added.** `checks_run` is written once, at fit time; a later check leaves older fits with a stale list that still looks current. | `backend/grb_fit_worker/db.py`, `record_success` | Grows as the validation engine evolves. Needs a re-evaluation pass and a check-set version. |
| 4 | **Every GW is classified "Compact binary".** Correct for both GW events in the database — each carries a chirp mass, which only a compact-binary search reports — but unconditional, so a Burst-pipeline alert would be mislabelled. | `components/DerivedParameters.tsx`, `getClassification` GW case | Latent until a burst-search alert is ingested. |
| 5 | **Einstein Probe events stored as `GRB`.** Live EP alerts are ingested as `event_type='GRB'` (`backend/app/gcn/topics.py`, `TOPIC_METADATA`), while the archive importer stores the same mission as `EP` (`ingest_gcn_archive.py`). A live EP X-ray transient carrying a T90 would get the gamma-ray long/short split, whose 2 s boundary is BATSE-derived. | ingest paths above | Moot while `t90` is NULL everywhere. |

Also noted, lower priority:

- **The T90 row rounds to one decimal** (`event.t90.toFixed(1)` in
  `DerivedParameters.tsx`). A T90 of 1.999 s displays as `2.0 s` beside
  `Short GRB` — the classification is right, the pair reads as contradictory.
  A T90 of 0 displays as `0.0 s` beside the unknown state.
- **The upstream pipeline's own T90 gate** in `fermi-gbm-analysis` was left
  untouched: it is vendored at a pinned SHA and belongs upstream.

**Items 2 and 3 refer to the GRB spectral-fit integration** (the fit worker,
`routes/grbFits.ts`, migrations 0025–0027, `SpectralFitPanel.tsx`), which was
still uncommitted in the working tree when this note was written.
