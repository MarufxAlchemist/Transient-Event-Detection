import { describe, it, expect } from "vitest";

import { decideGrbFitEnqueue, type GrbFitCandidate } from "./grbFitGate";

/**
 * The gate decides whether a spectral re-fit CAN run, not whether the burst is
 * interesting. Each rejection below corresponds to something the worker would
 * otherwise fail on minutes later, after claiming the job.
 */

const base: GrbFitCandidate = {
  id: 19670,
  eventId: "GRB809707716",
  eventType: "GRB",
  ra: 161.3833,
  dec: 57.3833,
  t90: 8.5,
  isRetraction: false,
  revisionCount: 0,
};

describe("decideGrbFitEnqueue", () => {
  it("enqueues a first-notice GRB with a position and a duration", () => {
    expect(decideGrbFitEnqueue(base)).toEqual({ enqueue: true, t1: 0, t2: 8.5 });
  });

  it("derives the window from t90 as [0, t90]", () => {
    const d = decideGrbFitEnqueue({ ...base, t90: 12.75 });
    expect(d).toEqual({ enqueue: true, t1: 0, t2: 12.75 });
  });

  // ── The condition that currently stops everything ────────────────────────
  it("refuses when t90 is absent — the real state of every event in this DB", () => {
    const d = decideGrbFitEnqueue({ ...base, t90: null });
    expect(d.enqueue).toBe(false);
    expect(d).toHaveProperty("reason", expect.stringContaining("no burst duration"));
  });

  it("refuses a non-positive t90 rather than fitting a zero-length window", () => {
    expect(decideGrbFitEnqueue({ ...base, t90: 0 }).enqueue).toBe(false);
    expect(decideGrbFitEnqueue({ ...base, t90: -1 }).enqueue).toBe(false);
  });

  // ── Worker preconditions ─────────────────────────────────────────────────
  it("refuses without a sky position — detectors are selected by angle to source", () => {
    expect(decideGrbFitEnqueue({ ...base, ra: null }).enqueue).toBe(false);
    expect(decideGrbFitEnqueue({ ...base, dec: null }).enqueue).toBe(false);
  });

  // ── Original brief scope ─────────────────────────────────────────────────
  it("ignores non-GRB events", () => {
    for (const eventType of ["GW", "FRB", "NU", "EP", "OTHER"]) {
      expect(decideGrbFitEnqueue({ ...base, eventType }).enqueue).toBe(false);
    }
  });

  it("ignores retractions", () => {
    expect(decideGrbFitEnqueue({ ...base, isRetraction: true }).enqueue).toBe(false);
  });

  it("fires only on the first notice, so revisions do not re-queue a fit", () => {
    expect(decideGrbFitEnqueue({ ...base, revisionCount: 1 }).enqueue).toBe(false);
    expect(decideGrbFitEnqueue({ ...base, revisionCount: 7 }).enqueue).toBe(false);
  });

  // ── fluence is deliberately NOT a condition ──────────────────────────────
  it("does not require fluence — it has no bearing on whether a fit can run", () => {
    // The brief gated on fluence; a fit needs a window, a position and a
    // trigger time. Requiring fluence would exclude 217 of 222 GRBs here.
    expect(decideGrbFitEnqueue(base).enqueue).toBe(true);
  });
});
