process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/grb_pipeline_route_test";

import { describe, it, expect } from "vitest";
import { requireAuth } from "../middlewares/auth.js";

const { syncRouteHandlers, rollbackRouteHandlers } = await import("./grbPipeline.js");

describe("grbPipeline route wiring", () => {
  it("requires auth on sync", () => {
    expect(syncRouteHandlers[0]).toBe(requireAuth);
  });

  it("requires auth on rollback", () => {
    expect(rollbackRouteHandlers[0]).toBe(requireAuth);
  });

  it("rejects a request with no Authorization header", () => {
    const req = { headers: {} } as import("express").Request;
    let statusCode: number | undefined;
    let body: unknown;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    } as unknown as import("express").Response;
    const next = () => {
      throw new Error("next() should not be called");
    };

    requireAuth(req, res, next);
    expect(statusCode).toBe(401);
    expect(body).toEqual({ error: "Unauthorized" });
  });

  it("rejects a non-Bearer Authorization header", () => {
    const req = { headers: { authorization: "Basic abc123" } } as import("express").Request;
    let statusCode: number | undefined;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json() {
        return this;
      },
    } as unknown as import("express").Response;
    let nextCalled = false;
    const next = () => {
      nextCalled = true;
    };

    requireAuth(req, res, next);
    expect(statusCode).toBe(401);
    expect(nextCalled).toBe(false);
  });
});
