import type { AstroEvent } from "@workspace/api-client-react";
import { typeLabel } from "@/lib/formatters";

interface Props {
  event: AstroEvent;
}

/**
 * Short/long GRB boundary. Kouveliotou et al. 1993, ApJ 413, L101: the BATSE
 * T90 distribution is bimodal with its minimum near 2 s, so T90 < 2 s is short
 * and T90 >= 2 s is long.
 */
const SHORT_LONG_T90_BOUNDARY_S = 2;

function getClassification(event: AstroEvent): string {
  // The generated enum lists only GRB | GW | FRB, but core.events also holds
  // EP, NU and OTHER, so switch on the runtime string.
  //
  // GRB and GW have a finer class than their type. Every other type has none,
  // so its classification IS its type label — taken from the shared helper so
  // this row and BasicInfo's Type row cannot drift apart.
  const type: string = event.eventType;
  switch (type) {
    case "GRB": {
      // This previously split on fluence > 1e-5, which is not the long/short
      // criterion — and a missing fluence fell through to "Short GRB". The
      // class is defined by T90; without a measured T90 it is UNKNOWN, not
      // guessed from another quantity. A T90 <= 0 is not a measured duration.
      const t90 = event.t90;
      if (t90 == null || !Number.isFinite(t90) || t90 <= 0) {
        return "GRB — long/short unknown (no T90)";
      }
      return t90 < SHORT_LONG_T90_BOUNDARY_S ? "Short GRB" : "Long GRB";
    }
    case "GW": return "Compact binary";
    default:   return typeLabel(type);
  }
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border/40 py-1.5 gap-2">
      <span className="text-[10px] font-mono text-muted-foreground">{label}</span>
      <span className="text-[10px] font-mono text-foreground text-right">{value}</span>
    </div>
  );
}

export function DerivedParameters({ event }: Props) {
  // Ep (spectral peak energy) is NOT reported by the current ingestion path
  // and cannot be derived from anything we store.
  //
  // This previously read `(event.snr * 9.2).toFixed(0)` — multiplying the
  // signal-to-noise ratio by a constant and labelling the result "keV".
  // There is no physical relationship between SNR and peak energy; that
  // produced an invented spectral measurement displayed as though observed
  // (e.g. SNR 14.7 -> "135 keV"). Ep must come from the spectral fit in the
  // originating notice, so until that is parsed it is UNKNOWN.
  const ep = "—";
  const t90 = event.t90 != null ? event.t90.toFixed(1) : "—";
  const fluence = event.fluence != null ? event.fluence.toExponential(3) : "—";
  const peakFlux = event.peakFlux != null ? event.peakFlux.toExponential(3) : "—";
  const chirpMass = event.chirpMass != null ? event.chirpMass.toFixed(2) : "—";
  const lumDist = event.luminosityDistance != null ? event.luminosityDistance.toFixed(0) : "—";

  return (
    <div className="rounded border border-border bg-card p-3 space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Derived parameters</div>
      {event.eventType === "GRB" && <Item label="Ep" value={`${ep} keV`} />}
      {event.eventType !== "GW" && <Item label="T90" value={`${t90} s`} />}
      {event.eventType === "GRB" && <Item label="Fluence" value={`${fluence} erg/cm²`} />}
      {event.eventType !== "GW" && <Item label="Peak Flux" value={peakFlux} />}
      {event.eventType === "GW" && <Item label="Chirp Mass" value={`${chirpMass} M☉`} />}
      {event.eventType === "GW" && <Item label="Lum. Dist" value={`${lumDist} Mpc`} />}
      <Item label="Classification" value={getClassification(event)} />
    </div>
  );
}
