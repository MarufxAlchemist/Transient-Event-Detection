import type { AstroEvent } from "@workspace/api-client-react";

/**
 * SpectralComparison — the model-selection block of the Science panel's
 * "Spectral Fit" tab.
 *
 * WHAT THIS USED TO DO, AND WHY IT WAS REMOVED
 * ────────────────────────────────────────────
 * Until 2026-09-10 this rendered a hardcoded four-row table — Band 501,
 * CPL 515, SPL 588, BB 621 — with `Band` highlighted **BEST**. The numbers were
 * a module-level constant with no connection to the event, to any fit, or to
 * any pipeline, and unlike the mock in SpectralFit.tsx it carried **no
 * disclaimer of any kind**.
 *
 * That made it the more misleading of the two. An AIC table is not a decorative
 * placeholder: it is a model-selection verdict, and rendering one states that
 * four models were fitted to this burst and compared by information criterion.
 * Nothing of the sort had happened. It also rendered for every event type, so a
 * Fast Radio Burst's page displayed a Band-function comparison — a
 * GRB-specific concept applied to an object it cannot describe.
 *
 * Real fitted spectra live in SpectralFitPanel on the event detail page, from
 * core.grb_spectral_fits. Nothing is wired in here on purpose: the pipeline
 * currently fits ONE model per job, so it has no model comparison to show, and
 * inventing one from a single fit would recreate the bug this removes.
 */

interface Props {
  event: AstroEvent;
}

export function SpectralComparison({ event }: Props) {
  return (
    <div className="rounded border border-border bg-card p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Spectral comparison
        </div>
        <div className="text-[9px] font-mono text-muted-foreground">{event.eventType}</div>
      </div>
      <div className="text-[10px] font-mono text-muted-foreground/70">
        No model comparison available. Comparing spectral models requires
        fitting more than one to this burst; none has been run.
      </div>
    </div>
  );
}
