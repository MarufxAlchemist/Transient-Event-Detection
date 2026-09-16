/**
 * grbFitGate.ts — decides whether an ingested event can have a spectral re-fit.
 *
 * Pure, and separate from the insert in grbFitEnqueue.ts so the rule can be
 * unit-tested without a database, per this package's vitest convention.
 *
 * WHY THIS IS NOT THE GATE THE BRIEF SPECIFIED
 * ────────────────────────────────────────────
 * The integration brief gated on `fluence != null && t90 != null`. Both halves
 * were wrong for this database:
 *
 *   • `t90` is NULL on all 313 events, every messenger type. Real-time GCN
 *     notices do not carry a burst duration. `normalizer.py` looks for one
 *     under t90/T90/duration/burst_duration and finds nothing, and it
 *     deliberately refuses to map Fermi's `Trig_Timescale` onto t90 — that is
 *     the detector's trigger integration window, and reporting it as a burst
 *     duration would be a fabricated measurement.
 *   • `fluence` has no bearing on whether a fit can run. A fit needs a time
 *     window, a sky position and a trigger time — not an energy fluence.
 *     Requiring it would exclude 217 of the 222 GRBs here for no reason
 *     connected to feasibility.
 *
 * No honest window source exists elsewhere in the ingested data: core.events
 * has no duration column besides t90 and no t_start/t_stop; `derived.restFrame`
 * records t90Rest as an explicit UNKNOWN; core.event_revisions.snapshot carries
 * no timing fields; the GCN Circular extraction schema has no duration field;
 * and no raw notice payload is persisted on core.events at all.
 *
 * So the gate asks the only question that matters — can this fit actually
 * run? — and today the answer is always no, because nothing populates t90.
 * That is deliberate. Enqueueing anyway would fill the queue with hundreds of
 * `failed` rows meaning "we never had the data" and paint a red failure badge
 * on every GRB in the UI, which reads as a broken pipeline rather than an
 * absent input.
 *
 * This is live logic, not disabled code: the moment a duration source is wired
 * up — a notice type reporting T90, or a circular extraction gaining a duration
 * field — auto-enqueueing starts on its own with no change here.
 */

/** The fields of an ingested event this decision depends on. */
export interface GrbFitCandidate {
  id: bigint | number;
  eventId: string;
  eventType: string;
  ra: number | null;
  dec: number | null;
  t90: number | null;
  isRetraction: boolean | null;
  revisionCount: number;
}

export type EnqueueDecision =
  | { enqueue: true; t1: number; t2: number }
  | { enqueue: false; reason: string };

/**
 * Every condition is a real precondition of the worker succeeding, not a
 * quality heuristic:
 *   - GRB, first notice, not a retraction — the brief's original scope.
 *   - RA/Dec — the pipeline selects detectors by angle to the source and
 *     generates the detector response at that position. Without it, the
 *     worker's run_fit raises FitInputError.
 *   - t90 > 0 — the only honest fit window available. It becomes [0, t90].
 */
export function decideGrbFitEnqueue(event: GrbFitCandidate): EnqueueDecision {
  if (event.eventType !== "GRB") {
    return { enqueue: false, reason: "not a GRB" };
  }
  if (event.isRetraction) {
    return { enqueue: false, reason: "retraction" };
  }
  if (event.revisionCount !== 0) {
    return { enqueue: false, reason: "not the first notice" };
  }
  if (event.ra == null || event.dec == null) {
    return {
      enqueue: false,
      reason: "no sky position — cannot select detectors or build a response",
    };
  }
  if (event.t90 == null || !(event.t90 > 0)) {
    // The common case today, and the reason nothing is auto-enqueued yet.
    return {
      enqueue: false,
      reason: "no burst duration — no honest fit window exists for this event",
    };
  }
  // The window is written onto the JOB rather than left for the worker to
  // re-derive, so the interval a fit used is recorded where it was decided.
  return { enqueue: true, t1: 0, t2: event.t90 };
}
