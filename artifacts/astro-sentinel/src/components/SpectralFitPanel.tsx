import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Info,
  Loader2,
  RefreshCw,
  ShieldCheck,
  ShieldQuestion,
  Sigma,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/AuthContext";
import { UNKNOWN_LABEL, formatExp, formatMeasured } from "@/lib/formatters";

/**
 * SpectralFitPanel
 * ────────────────
 * An INDEPENDENT re-fit of the raw Fermi GBM data, shown beside what the GCN
 * notice reported. The point is the comparison: `core.events` stores fluence
 * and t90 as the notice stated them and derives no spectral shape, so a fitted
 * Ep is the only thing here that can disagree with the notice.
 *
 * THREE THINGS THIS LAYOUT REFUSES TO DO
 * ──────────────────────────────────────
 *   1. Sum an asymmetric error into a bound. The pipeline emits OFFSETS
 *      (alpha_low is a distance below alpha, not a lower limit) and the API
 *      deliberately passes them through un-combined. Rendering "±" over a
 *      posterior whose two sides differ by a factor of twenty would be a
 *      fabricated symmetry, so both offsets are always shown.
 *   2. Render a missing beta as 0. The CPL family has no high-energy index at
 *      all; null means "this model has no such parameter", and a zero there
 *      would read as a measured spectral index.
 *   3. Show an unconstrained Ep as a plain number. When epConstrained is false
 *      the posterior ran into its prior edge, so the quoted Ep is an artefact
 *      of the prior rather than a measurement. That caveat travels WITH the
 *      number, not in a tooltip below it.
 *
 * ABSENCE OF A VALIDATION FLAG IS NOT A PASS
 * ──────────────────────────────────────────
 * A passing check writes no row, so flag count alone cannot separate "every
 * check ran and none objected" from "nothing has ever looked". The API resolves
 * this with `evaluated` (from the fit's recorded evaluated_at) plus `checksRun`,
 * and this panel draws all three states distinctly:
 *
 *   not evaluated            neutral, "not yet validated" — never a checkmark
 *   evaluated, flags         the findings, by severity
 *   evaluated, zero flags    the only state that may read as reassurance, and
 *                            it names how many checks ran to earn it
 */

// ─── Wire types (Phase 4 response shapes) ────────────────────────────────────

interface EpPrior {
  oneSigmaMin: number | null;
  oneSigmaMax: number | null;
  priorLo: number | null;
  priorHi: number | null;
}

interface SpectralFit {
  id: string;
  eventId: string;
  jobId: string | null;
  model: string;
  detectorCfg: string;
  mode: string;
  fitDets: string[];
  includeBgo: boolean;
  nlive: number;
  t1: number | null;
  t2: number | null;
  alpha: number;
  alphaLow: number;
  alphaHigh: number;
  /** null = the fitted model has no high-energy index. NOT zero. */
  beta: number | null;
  betaLow: number | null;
  betaHigh: number | null;
  epBest: number;
  epLow: number;
  epHigh: number;
  amplitude: number;
  vfvBest: number | null;
  vfvLow: number | null;
  vfvHigh: number | null;
  /** false = ran into a prior edge. null = the model has no Ep parameter. */
  epConstrained: boolean | null;
  logEpHitsPriorLow: boolean | null;
  logEpHitsPriorHigh: boolean | null;
  epPrior: EpPrior;
  hdf5Key: string;
  fitFingerprint: string | null;
  pipelineVersion: string | null;
  fitTimestamp: string | null;
  createdAt: string;
}

interface ValidationFlag {
  id: string;
  checkName: string;
  severity: "critical" | "warning" | "info";
  message: string;
  referenceUrl: string | null;
  createdAt: string;
}

interface ValidationResponse {
  fitId: string | null;
  fitCreatedAt: string | null;
  /**
   * Proof that checks ran, from the fit's recorded evaluated_at — NOT inferred
   * from whether flags exist. This is what makes "validated, nothing objected"
   * distinguishable from "never looked at".
   */
  evaluated: boolean;
  evaluatedAt: string | null;
  /** Which checks executed. Skipped checks are absent, not listed as passing. */
  checksRun: string[];
  flags: ValidationFlag[];
  counts: { critical: number; warning: number; info: number };
}

interface CreatedJob {
  id: string;
  eventId: string;
  model: string;
  detectorCfg: string;
  nlive: number;
  t1: number;
  t2: number;
  status: string;
  requestedAt: string;
}

// Mirrors the server's FITTABLE_MODELS / GRB_DETECTOR_CFGS.
const MODELS = [
  "cpl", "band", "bpl", "pl", "sbpl", "cband",
  "dband", "hlecpl", "hleband", "grbm", "cutoffpl",
];
const DETECTOR_CFGS = ["nai_only", "nai_bgo"];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * A value with its asymmetric 1-sigma offsets, never collapsed into one number.
 * The interval is [value - low, value + high].
 */
function Asym({
  value,
  low,
  high,
  digits,
  unit = "",
}: {
  value: number | null;
  low: number | null;
  high: number | null;
  digits: number;
  unit?: string;
}) {
  if (value == null || !Number.isFinite(value)) {
    return <span className="font-mono text-sm">{UNKNOWN_LABEL}</span>;
  }
  return (
    <span className="font-mono text-sm whitespace-nowrap">
      {value.toFixed(digits)}
      {low != null && high != null && (
        <span className="text-xs text-muted-foreground ml-1">
          <span className="text-emerald-600 dark:text-emerald-400/80">
            +{high.toFixed(digits)}
          </span>
          {" / "}
          <span className="text-rose-600 dark:text-rose-400/80">
            &minus;{low.toFixed(digits)}
          </span>
        </span>
      )}
      {unit && <span className="text-xs text-muted-foreground ml-1">{unit}</span>}
    </span>
  );
}

function severityClass(sev: ValidationFlag["severity"]): string {
  switch (sev) {
    case "critical": return "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/40";
    case "warning":  return "bg-amber-500/15 text-amber-800 dark:text-amber-400 border-amber-500/40";
    default:         return "bg-zinc-500/10 text-zinc-700 dark:text-zinc-400 border-zinc-500/30";
  }
}

// ─── Panel ───────────────────────────────────────────────────────────────────

interface Props {
  eventId: string;
  /** GCN-reported values, shown beside the fit for comparison. */
  fluence: number | null | undefined;
  t90: number | null | undefined;
}

export function SpectralFitPanel({ eventId, fluence, t90 }: Props) {
  const { token } = useAuth();

  const [fits, setFits] = useState<SpectralFit[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [validation, setValidation] = useState<ValidationResponse | null>(null);
  const [validationFailed, setValidationFailed] = useState(false);
  const [reload, setReload] = useState(0);

  // Re-fit form. t1/t2 start EMPTY on purpose: the backend requires an explicit
  // window and there is no t90 to fall back on for most events, so pre-filling
  // a plausible-looking interval would put a number the user never chose into a
  // fit that gets stored as a measurement.
  const [showForm, setShowForm] = useState(false);
  const [t1, setT1] = useState("");
  const [t2, setT2] = useState("");
  const [model, setModel] = useState("cpl");
  const [detectorCfg, setDetectorCfg] = useState("nai_only");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [queued, setQueued] = useState<CreatedJob | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFits(null);
    setFailed(false);
    fetch(`/api/events/${eventId}/spectral-fits`)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d: SpectralFit[]) => {
        if (!cancelled) setFits(d ?? []);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, reload]);

  useEffect(() => {
    let cancelled = false;
    setValidation(null);
    setValidationFailed(false);
    fetch(`/api/events/${eventId}/validation`)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d: ValidationResponse) => {
        if (!cancelled) setValidation(d);
      })
      .catch(() => {
        if (!cancelled) setValidationFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, reload]);

  async function submitRefit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    setQueued(null);
    try {
      const res = await fetch(`/api/events/${eventId}/fit-jobs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          // Sent as numbers so the server's own finite-number check is the one
          // that decides, rather than a string slipping through as NaN here.
          t1: t1.trim() === "" ? null : Number(t1),
          t2: t2.trim() === "" ? null : Number(t2),
          model,
          detectorCfg,
        }),
      });
      if (!res.ok) {
        // The server distinguishes missing/invalid window, t2<=t1, unknown
        // model, unknown detector config, a non-GRB target, an event with no
        // sky position, and a duplicate job. Each message is specific and
        // actionable, so it is shown as written instead of being flattened
        // into "request failed".
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { job: CreatedJob };
      setQueued(body.job);
      setReload((n) => n + 1);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (failed) {
    return (
      <Card className="bg-card border-border/50 shadow-none">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Sigma className="w-5 h-5 text-primary" />
            Spectral Fit
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-amber-500/80">
            The spectral fits for this event could not be loaded, so whether any
            have been produced is unknown.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (fits === null) return null;

  const latest = fits[0] ?? null;

  return (
    <Card className="bg-card border-border/50 shadow-none">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Sigma className="w-5 h-5 text-primary" />
          Spectral Fit
          {fits.length > 0 && (
            <span className="text-xs font-normal text-muted-foreground ml-1">
              {fits.length} fit{fits.length === 1 ? "" : "s"}
            </span>
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          An independent re-fit of the raw Fermi GBM data, shown beside what the
          GCN notice reported. The notice supplies no spectral shape, so the
          fitted values are the only ones here that can disagree with it.
        </p>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* ── Reported vs fitted ─────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-4 pb-4 border-b border-border">
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
              GCN-reported
            </p>
            <div className="space-y-1.5">
              <div className="flex justify-between gap-2">
                <span className="text-xs text-muted-foreground">Fluence</span>
                <span className="font-mono text-sm">
                  {formatExp(fluence, 3, " erg/cm²")}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-xs text-muted-foreground">T90</span>
                <span className="font-mono text-sm">{formatMeasured(t90, 2, " s")}</span>
              </div>
            </div>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
              Fitted {latest ? `(${latest.model})` : ""}
            </p>
            {latest ? (
              <div className="space-y-1.5">
                <div className="flex justify-between gap-2">
                  <span className="text-xs text-muted-foreground">Ep</span>
                  <Asym
                    value={latest.epBest}
                    low={latest.epLow}
                    high={latest.epHigh}
                    digits={2}
                    unit="keV"
                  />
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-xs text-muted-foreground">Window</span>
                  <span className="font-mono text-sm">
                    {latest.t1 != null && latest.t2 != null
                      ? `${latest.t1}–${latest.t2} s`
                      : UNKNOWN_LABEL}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No completed fit</p>
            )}
          </div>
        </div>

        {/* ── No fit yet ─────────────────────────────────────────────────── */}
        {!latest && (
          <div className="text-xs text-muted-foreground space-y-1">
            <p>No completed spectral fit for this event.</p>
            {/* Honest about what this panel cannot currently tell apart. The
                fits endpoint returns only COMPLETED fits, and job status is not
                exposed anywhere the client can read, so a queued, running or
                failed job is indistinguishable from no job at all. */}
            <p className="text-muted-foreground/70">
              A queued, running or failed fit would look the same here — job
              status is not currently exposed by the API.
            </p>
          </div>
        )}

        {/* ── Fitted parameters ──────────────────────────────────────────── */}
        {latest && (
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
              Parameters — 1σ offsets, not summed into bounds
            </p>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2">
              <div className="flex justify-between gap-2">
                <span className="text-xs text-muted-foreground">α</span>
                <Asym
                  value={latest.alpha}
                  low={latest.alphaLow}
                  high={latest.alphaHigh}
                  digits={3}
                />
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-xs text-muted-foreground">β</span>
                {latest.beta == null ? (
                  // Not zero: the CPL family has no high-energy index at all.
                  <span className="font-mono text-sm text-muted-foreground">
                    N/A
                    <span className="text-[10px] ml-1">({latest.model} has no β)</span>
                  </span>
                ) : (
                  <Asym
                    value={latest.beta}
                    low={latest.betaLow}
                    high={latest.betaHigh}
                    digits={3}
                  />
                )}
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-xs text-muted-foreground">Ep</span>
                <Asym
                  value={latest.epBest}
                  low={latest.epLow}
                  high={latest.epHigh}
                  digits={2}
                  unit="keV"
                />
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-xs text-muted-foreground">Amplitude</span>
                <span className="font-mono text-sm">{formatExp(latest.amplitude, 3)}</span>
              </div>
            </div>

            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-[10px] text-muted-foreground font-mono">
              <span>dets: {latest.fitDets.join(", ")}</span>
              <span>nlive: {latest.nlive}</span>
              {latest.fitFingerprint && <span>fp: {latest.fitFingerprint}</span>}
              {latest.pipelineVersion && (
                <span>pipeline: {latest.pipelineVersion.slice(0, 8)}</span>
              )}
            </div>
          </div>
        )}

        {/* ── Ep prior diagnostics ───────────────────────────────────────── */}
        {latest && latest.epConstrained === false && (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="flex items-center gap-2 text-xs font-medium text-amber-600 dark:text-amber-400">
              <AlertTriangle className="w-3.5 h-3.5" />
              Ep is not well constrained by this fit
            </p>
            {/* Theme-safe: amber-200 is legible only on a dark ground, and this
                caveat losing contrast in light mode would leave an
                unconstrained Ep looking like a plain measurement — the exact
                failure this block exists to prevent. */}
            <p className="text-xs text-amber-800/90 dark:text-amber-200/70 mt-1.5">
              The 1σ log-Ep interval reached the edge of its prior, so the quoted
              Ep reflects the prior rather than the data. It should not be
              compared against a published value as though it were a measurement.
            </p>
            <div className="mt-2 font-mono text-[10px] text-amber-800/70 dark:text-amber-200/60">
              log Ep 1σ [
              {latest.epPrior.oneSigmaMin?.toFixed(3) ?? UNKNOWN_LABEL},{" "}
              {latest.epPrior.oneSigmaMax?.toFixed(3) ?? UNKNOWN_LABEL}] vs prior [
              {latest.epPrior.priorLo?.toFixed(1) ?? UNKNOWN_LABEL},{" "}
              {latest.epPrior.priorHi?.toFixed(1) ?? UNKNOWN_LABEL}]
              {latest.logEpHitsPriorLow && <span className="ml-2">· hits lower edge</span>}
              {latest.logEpHitsPriorHigh && <span className="ml-2">· hits upper edge</span>}
            </div>
          </div>
        )}

        {latest && latest.epConstrained === true && (
          <p className="flex items-center gap-2 text-[11px] text-emerald-700 dark:text-emerald-400/80">
            <Info className="w-3 h-3" />
            Ep constrained — 1σ log-Ep interval [
            {latest.epPrior.oneSigmaMin?.toFixed(3) ?? UNKNOWN_LABEL},{" "}
            {latest.epPrior.oneSigmaMax?.toFixed(3) ?? UNKNOWN_LABEL}] clear of the
            prior edges.
          </p>
        )}

        {/* ── Validation ─────────────────────────────────────────────────── */}
        <div className="pt-4 border-t border-border">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
            Validation
          </p>

          {validationFailed && (
            <p className="text-xs text-amber-500/80">
              Validation could not be loaded, so whether this fit has been checked
              is unknown.
            </p>
          )}

          {!validationFailed && validation && !validation.evaluated && (
            // Deliberately NOT a green checkmark. No flag exists, which means no
            // check has objected — and today means no check has run.
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldQuestion className="w-3.5 h-3.5" />
              Not yet validated — no automated check has run against this fit.
            </p>
          )}

          {/* The third state, previously unreachable: checks ran and none
              objected. Only legitimate because `evaluated` now proves the
              engine executed — inferring it from an empty flag list would have
              made "nobody looked" indistinguishable from "nothing wrong". */}
          {!validationFailed && validation && validation.evaluated
            && validation.flags.length === 0 && (
            <div className="text-xs">
              <p className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                <ShieldCheck className="w-3.5 h-3.5" />
                No issues found — {validation.checksRun.length} check
                {validation.checksRun.length === 1 ? "" : "s"} ran and none objected.
              </p>
              {validation.checksRun.length > 0 && (
                <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                  {validation.checksRun.join(" · ")}
                </p>
              )}
            </div>
          )}

          {!validationFailed && validation && validation.evaluated
            && validation.flags.length > 0 && (
            <ul className="space-y-2">
              {validation.flags.map((f) => (
                <li
                  key={f.id}
                  className={`rounded border px-2.5 py-2 ${severityClass(f.severity)}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono uppercase tracking-wider">
                      {f.severity}
                    </span>
                    <span className="text-[10px] font-mono opacity-70">
                      {f.checkName}
                    </span>
                  </div>
                  <p className="text-xs mt-1 opacity-90">{f.message}</p>
                  {f.referenceUrl && (
                    <a
                      href={f.referenceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] underline opacity-70 hover:opacity-100"
                    >
                      Reference
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}

          {!validationFailed && validation && validation.evaluated
            && validation.checksRun.length > 0 && validation.flags.length > 0 && (
            <p className="mt-2 font-mono text-[10px] text-muted-foreground">
              checks run: {validation.checksRun.join(" · ")}
            </p>
          )}
        </div>

        {/* ── Re-fit ─────────────────────────────────────────────────────── */}
        {token && (
          <div className="pt-4 border-t border-border">
            {!showForm && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowForm(true)}
                className="text-xs"
              >
                <RefreshCw className="w-3 h-3 mr-1.5" />
                Request a fit
              </Button>
            )}

            {showForm && (
              <form onSubmit={submitRefit} className="space-y-3">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  Request a fit
                </p>
                {/* No default window. The server requires an explicit interval
                    and will not infer one, so neither does this form. */}
                <p className="text-xs text-muted-foreground">
                  The fit window is required and is not inferred — most events
                  carry no T90 to derive it from. Seconds relative to trigger.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-muted-foreground" htmlFor="grb-fit-t1">
                      t1 (s)
                    </label>
                    <Input
                      id="grb-fit-t1"
                      value={t1}
                      onChange={(e) => setT1(e.target.value)}
                      placeholder="e.g. 0"
                      className="h-8 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-muted-foreground" htmlFor="grb-fit-t2">
                      t2 (s)
                    </label>
                    <Input
                      id="grb-fit-t2"
                      value={t2}
                      onChange={(e) => setT2(e.target.value)}
                      placeholder="e.g. 10"
                      className="h-8 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-muted-foreground" htmlFor="grb-fit-model">
                      Model
                    </label>
                    <select
                      id="grb-fit-model"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      className="w-full h-8 rounded-md border border-input bg-background px-2 text-sm font-mono"
                    >
                      {MODELS.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-muted-foreground" htmlFor="grb-fit-dets">
                      Detectors
                    </label>
                    <select
                      id="grb-fit-dets"
                      value={detectorCfg}
                      onChange={(e) => setDetectorCfg(e.target.value)}
                      className="w-full h-8 rounded-md border border-input bg-background px-2 text-sm font-mono"
                    >
                      {DETECTOR_CFGS.map((d) => (
                        <option key={d} value={d}>{d}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {submitError && (
                  // The server's own wording, verbatim — it already worked out
                  // which precondition failed and why.
                  <p className="flex items-start gap-2 text-xs text-red-700 dark:text-red-400">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    {submitError}
                  </p>
                )}

                {queued && (
                  <p className="text-xs text-emerald-700 dark:text-emerald-400">
                    Job {queued.id} queued ({queued.status}) — {queued.model} /{" "}
                    {queued.detectorCfg}, window {queued.t1}–{queued.t2} s.
                  </p>
                )}

                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={submitting} className="text-xs">
                    {submitting && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
                    Queue fit
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-xs"
                    onClick={() => {
                      setShowForm(false);
                      setSubmitError(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}
          </div>
        )}

        {/* ── Earlier fits ───────────────────────────────────────────────── */}
        {fits.length > 1 && (
          <div className="pt-4 border-t border-border">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
              Earlier fits
            </p>
            <ul className="space-y-1">
              {fits.slice(1).map((f) => (
                <li
                  key={f.id}
                  className="flex items-center justify-between gap-2 text-xs font-mono text-muted-foreground"
                >
                  <span>
                    {f.model} · {f.fitDets.join(",")} · {f.t1}–{f.t2}s
                  </span>
                  <span className="flex items-center gap-2">
                    Ep {f.epBest.toFixed(1)} keV
                    {f.epConstrained === false && (
                      <span className="text-amber-700 dark:text-amber-400/80">unconstrained</span>
                    )}
                    <span className="opacity-60">
                      {new Date(f.createdAt).toISOString().slice(0, 16).replace("T", " ")}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
