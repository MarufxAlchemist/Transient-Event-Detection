/**
 * grbFitEnqueue.ts — queue a GRB spectral re-fit after ingestion.
 *
 * The decision itself lives in grbFitGate.ts (pure, unit-tested without a
 * database). This module is only the write, and the guarantee that neither the
 * decision nor the write can affect ingestion.
 */

import { db, grbFitJobs } from "@workspace/db";
import { logger } from "./logger";
import { decideGrbFitEnqueue, type GrbFitCandidate } from "./grbFitGate";

export type { GrbFitCandidate } from "./grbFitGate";

/**
 * Enqueue a fit if the event qualifies. Never throws.
 *
 * Fire-and-forget by contract: a spectral fit takes minutes, and no alert,
 * broadcast or notification may ever wait on one. The queue row is the entire
 * handoff — a single INSERT, no read-back, no coordination with the worker.
 */
export async function enqueueGrbFitJob(event: GrbFitCandidate): Promise<void> {
  const decision = decideGrbFitEnqueue(event);

  if (!decision.enqueue) {
    // Debug, not info: for GRBs this fires on every burst until a duration
    // source exists, and it is a normal state rather than a fault. Logged at
    // all because silently declining to queue work is exactly the kind of
    // invisible behaviour that is hard to explain later.
    if (event.eventType === "GRB") {
      logger.debug(
        { eventId: event.eventId, reason: decision.reason },
        "[grb-fit] not enqueued",
      );
    }
    return;
  }

  try {
    await db.insert(grbFitJobs).values({
      eventPk: BigInt(event.id),
      eventId: event.eventId,
      // NULL: GRBContext.from_name() resolves only the eight curated bursts in
      // the pipeline's own catalog. A live burst is not one of them, so the
      // worker builds the context from this event's RA/Dec/trigger time.
      grbName: null,
      model: "cpl",
      detectorCfg: "nai_only",
      nlive: 1000,
      t1: decision.t1,
      t2: decision.t2,
    });
    logger.info(
      { eventId: event.eventId, t1: decision.t1, t2: decision.t2 },
      "[grb-fit] job enqueued",
    );
  } catch (err) {
    // A queueing failure must never surface as an ingestion failure. The alert
    // is already stored and broadcast; the fit is strictly additive.
    logger.error({ err, eventId: event.eventId }, "[grb-fit] enqueue failed");
  }
}
