import type { AstroEvent } from "@workspace/api-client-react";
import { BarChart2 } from "lucide-react";

/**
 * SpectralFit — the Science panel's "Spectral Fit" tab.
 *
 * WHAT THIS USED TO DO, AND WHY IT WAS REMOVED
 * ────────────────────────────────────────────
 * Until 2026-09-10 this rendered a hardcoded `MODELS` table keyed only on
 * `event.eventType`, so EVERY GRB displayed the same invented figures — Band
 * function, Ep 300 keV, Alpha −0.8, Beta −2.4, flux and fluence — followed by
 * an equally invented fit quality block: χ²/d.o.f. 1.04 / 118, "p-value 0.38
 * (good)" in green, and a 72% confidence bar. GW and FRB events had their own
 * fabricated parameter sets. None of it was connected to any fit, any pipeline
 * or the event being viewed.
 *
 * It carried a disclaimer — "Mock fit — real pipeline pending" — but at 9px and
 * 60% opacity it was the least prominent thing on the panel, under numbers
 * styled exactly like measurements. A reader scanning the tab saw a spectral
 * fit with a good p-value; the caveat was the easiest element to miss.
 *
 * That is the failure this codebase's validation work exists to prevent: a
 * fabricated quantity rendered as though it were observed. An empty panel is
 * strictly more informative than a confident wrong one, so the numbers are gone
 * and nothing has replaced them.
 *
 * NOTHING IS WIRED IN HERE ON PURPOSE. Real fitted spectra live in
 * SpectralFitPanel on the event detail page, which reads actual results from
 * core.grb_spectral_fits. This tab is left honestly empty rather than being
 * quietly pointed at that data as a side effect of deleting the mock.
 */

interface Props { event: AstroEvent; }

export function SpectralFit({ event }: Props) {
  void event; // Intentionally unused: nothing here is derived from the event.

  return (
    <div className="flex flex-col h-full items-center justify-center p-6 text-center gap-2">
      <BarChart2 className="w-8 h-8 text-muted-foreground/30" />
      <div className="text-sm text-muted-foreground">No spectral fit available</div>
      <div className="text-[10px] font-mono text-muted-foreground/70 max-w-[22rem]">
        No spectral fit has been computed for this event.
      </div>
    </div>
  );
}
