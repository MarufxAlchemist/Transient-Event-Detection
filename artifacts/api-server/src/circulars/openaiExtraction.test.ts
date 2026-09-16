/**
 * openaiExtraction.test.ts — the gate on the only billable code path
 * ---------------------------------------------------------------------------
 * NO TEST HERE TOUCHES THE NETWORK. The unit suite runs with no database, no
 * broker and no network by design (see vitest.config.ts), so this file tests
 * the pure gate function and the extractor vocabulary — not the worker's
 * database loop, which belongs with the live-stack verify_* scripts.
 *
 * The worker module itself is NOT imported here: it imports @workspace/db,
 * which throws at module load when DATABASE_URL is unset. The gate is
 * therefore re-declared below in the exact form the worker uses, and a
 * source-level assertion pins the two together — if the worker's gate is ever
 * loosened, `the worker's gate is byte-for-byte the strict form` fails.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CIRCULAR_EXTRACTORS } from "@workspace/db/schema";

const here = dirname(fileURLToPath(import.meta.url));
const workerSource = readFileSync(join(here, "openaiExtractionWorker.ts"), "utf8");

/** The gate, exactly as openaiExtractionWorker.ts declares it. */
function openaiExtractionEnabled(env: Record<string, string | undefined>): boolean {
  return env["CIRCULAR_OPENAI_EXTRACTION_ENABLED"] === "true";
}

describe("the OpenAI extraction gate", () => {
  it("is off when the variable is absent — the state of every environment but one", () => {
    expect(openaiExtractionEnabled({})).toBe(false);
  });

  // "1" and "yes" look like an operator meant to enable this. Guessing at
  // that intent is how a machine starts billing by accident, so only the
  // documented token counts. Kept identical to the Python side, which is
  // byte-for-byte "true" for exactly this reason.
  it.each([
    { label: "empty string", value: "" },
    { label: "false", value: "false" },
    { label: "False", value: "False" },
    { label: "0", value: "0" },
    { label: "1", value: "1" },
    { label: "yes", value: "yes" },
    { label: "True (capitalised)", value: "True" },
    { label: "TRUE (upper)", value: "TRUE" },
    { label: "true with a trailing space", value: "true " },
    { label: "true with a leading space", value: " true" },
  ])("stays off for $label", ({ value }) => {
    expect(openaiExtractionEnabled({ CIRCULAR_OPENAI_EXTRACTION_ENABLED: value })).toBe(false);
  });

  it("is on only for exactly \"true\"", () => {
    expect(openaiExtractionEnabled({ CIRCULAR_OPENAI_EXTRACTION_ENABLED: "true" })).toBe(true);
  });

  it("is not enabled by the presence of an API key", () => {
    // The key is never the gate. A machine with OPENAI_API_KEY exported for
    // some unrelated tool must still make no call.
    expect(
      openaiExtractionEnabled({ OPENAI_API_KEY: "sk-whatever", CIRCULAR_OPENAI_EXTRACTION_ENABLED: undefined }),
    ).toBe(false);
  });
});

describe("the worker's own gate, asserted against its source", () => {
  it("is byte-for-byte the strict form", () => {
    expect(workerSource).toContain(
      'return process.env["CIRCULAR_OPENAI_EXTRACTION_ENABLED"] === "true";',
    );
  });

  it("refuses to start before doing anything else", () => {
    const start = workerSource.indexOf("export function startOpenaiExtractionWorker");
    const guard = workerSource.indexOf("if (!openaiExtractionEnabled())", start);
    const claim = workerSource.indexOf("setInterval", start);
    expect(guard).toBeGreaterThan(-1);
    // The guard must precede the loop that would claim and bill.
    expect(guard).toBeLessThan(claim);
  });

  it("never constructs an OpenAI client itself — the Python side owns that", () => {
    // If this worker ever gained a direct SDK dependency, the single
    // environment gate would no longer be the only thing standing between a
    // deployment and a bill.
    expect(workerSource).not.toMatch(/from ["']openai["']/);
    expect(workerSource).not.toMatch(/new OpenAI\(/);
  });

  it("scopes its claim query to its own extractor", () => {
    expect(workerSource).toContain("AND extractor = ${OPENAI_EXTRACTOR}");
  });
});

describe("extractor vocabulary", () => {
  it("matches chk_extraction_extractor (migration 0024)", () => {
    expect([...CIRCULAR_EXTRACTORS]).toEqual(["gemini", "astro-colibri-openai"]);
  });

  it("keeps the two extractors distinct, so one cannot claim the other's rows", () => {
    expect(new Set(CIRCULAR_EXTRACTORS).size).toBe(CIRCULAR_EXTRACTORS.length);
  });
});

describe("the Gemini worker is scoped too", () => {
  const geminiSource = readFileSync(join(here, "extractionWorker.ts"), "utf8");

  // Without this the original worker claims EVERY pending row, OpenAI ones
  // included, and drains them in one sequential loop — the coupling the
  // separate worker exists to prevent.
  it("claims only its own rows", () => {
    expect(geminiSource).toContain("AND extractor = 'gemini'");
  });

  it("reaps only its own abandoned rows", () => {
    expect(geminiSource).toContain('eq(circularExtractions.extractor, "gemini")');
  });
});
