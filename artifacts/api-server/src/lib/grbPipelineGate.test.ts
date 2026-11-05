import { describe, it, expect } from "vitest";
import {
  resolveRollbackTarget,
  knownShasFromRows,
  buildPipelineStatus,
  type PipelineSyncRow,
} from "./grbPipelineGate.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

function row(partial: Partial<PipelineSyncRow>): PipelineSyncRow {
  return {
    id: 1,
    action: "sync",
    requestedBy: "user@example.com",
    requestedAt: new Date("2026-01-01T00:00:00Z"),
    status: "activated",
    fromSha: null,
    toSha: null,
    message: null,
    finishedAt: new Date("2026-01-01T00:01:00Z"),
    ...partial,
  };
}

describe("resolveRollbackTarget", () => {
  it("defaults to the previous release when no sha is given", () => {
    expect(resolveRollbackTarget(undefined, new Set([SHA_A]))).toEqual({ ok: true, targetSha: null });
    expect(resolveRollbackTarget(null, new Set([SHA_A]))).toEqual({ ok: true, targetSha: null });
    expect(resolveRollbackTarget("", new Set([SHA_A]))).toEqual({ ok: true, targetSha: null });
  });

  it("accepts a known SHA and normalises to lowercase", () => {
    const result = resolveRollbackTarget(SHA_A.toUpperCase(), new Set([SHA_A]));
    expect(result).toEqual({ ok: true, targetSha: SHA_A });
  });

  it("rejects a non-string sha", () => {
    const result = resolveRollbackTarget(12345, new Set([SHA_A]));
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed sha", () => {
    const result = resolveRollbackTarget("not-a-sha", new Set([SHA_A]));
    expect(result.ok).toBe(false);
  });

  it("rejects a well-formed but unknown sha", () => {
    const result = resolveRollbackTarget(SHA_B, new Set([SHA_A]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(SHA_B);
    }
  });
});

describe("knownShasFromRows", () => {
  it("collects from_sha and to_sha of successful rows", () => {
    const rows = [
      row({ status: "activated", fromSha: SHA_A, toSha: SHA_B }),
      row({ status: "rolled_back", fromSha: SHA_B, toSha: SHA_A }),
    ];
    expect(knownShasFromRows(rows)).toEqual(new Set([SHA_A, SHA_B]));
  });

  it("excludes to_sha of a refused request", () => {
    const rows = [row({ status: "needs_image_rebuild", fromSha: SHA_A, toSha: null })];
    expect(knownShasFromRows(rows)).toEqual(new Set([SHA_A]));
  });
});

describe("buildPipelineStatus", () => {
  it("reports the most recent successful to_sha as current", () => {
    const rows = [
      row({ status: "activated", toSha: SHA_C, requestedAt: new Date("2026-01-03T00:00:00Z") }),
      row({ status: "activated", toSha: SHA_B, requestedAt: new Date("2026-01-02T00:00:00Z") }),
    ];
    expect(buildPipelineStatus(rows).currentSha).toBe(SHA_C);
  });

  it("surfaces a pending request", () => {
    const rows = [row({ status: "pending", id: 7, requestedBy: "a@b.com" })];
    const status = buildPipelineStatus(rows);
    expect(status.pending).toEqual({
      id: 7,
      action: "sync",
      requestedBy: "a@b.com",
      requestedAt: rows[0].requestedAt,
    });
  });

  it("has no pending request when none is queued", () => {
    const rows = [row({ status: "activated" })];
    expect(buildPipelineStatus(rows).pending).toBeNull();
  });

  it("surfaces the last finished request", () => {
    const rows = [row({ status: "contract_check_failed", message: "boom" })];
    expect(buildPipelineStatus(rows).lastFinished?.message).toBe("boom");
  });
});
