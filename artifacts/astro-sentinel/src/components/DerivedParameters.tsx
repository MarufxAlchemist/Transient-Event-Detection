import type { AstroEvent } from "@workspace/api-client-react";
import { typeLabel, UNKNOWN_TEXT, formatQuantity } from "@/lib/formatters";

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

function Item({ label, value, title }: { label: string; value: string; title?: string }) {
  const unknown = value === UNKNOWN_TEXT;
  return (
    <div className="flex items-baseline border-b border-border/40 py-1.5 gap-2">
      <span className="w-32 shrink-0 text-[10px] font-mono text-muted-foreground">{label}</span>
      <span
        title={title}
        className={`min-w-0 break-words text-[10px] font-mono ${unknown ? "text-amber-500/80" : "text-foreground"}`}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * A magnitude with its unit, or UNKNOWN in words.
 *
 * The unit is attached only to a real value. Appending it unconditionally is
 * how the previous version would have read "Unknown keV", which states a unit
 * for a quantity that was never measured.
 */
function withUnit(
  v: number | null | undefined,
  unit: string,
  render: (n: number) => string = formatQuantity,
): string {
  if (v == null || !Number.isFinite(v)) return UNKNOWN_TEXT;
  return unit ? `${render(v)} ${unit}` : render(v);
}

/**
 * Altitude at the event's detection time, from the configured observing site.
 *
 * This is the first row on this card sourced from `event.derived` rather than
 * a flat column. Every UNKNOWN carries the backend's own reason rather than a
 * sentence written here — the pipeline distinguishes "no site configured"
 * from "event has no sky position", and those are different problems.
 */
function observability(event: AstroEvent): { value: string; title?: string } {
  const obs = event.derived?.observability;
  if (!obs) {
    return { value: UNKNOWN_TEXT, title: "No observability block on this event." };
  }
  if (!obs.available || obs.altitudeDeg == null) {
    return { value: UNKNOWN_TEXT, title: obs.reason ?? undefined };
  }
  const alt = `${formatQuantity(obs.altitudeDeg)}°`;
  return {
    value: obs.aboveHorizon ? alt : `${alt} (below horizon)`,
    title: [obs.site?.name, obs.note].filter(Boolean).join(" — ") || undefined,
  };
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
  const ep = UNKNOWN_TEXT;
  const t90 = withUnit(event.t90, "s", (n) => n.toFixed(1));
  const fluence = withUnit(event.fluence, "erg/cm²", (n) => n.toExponential(3));
  const peakFlux = withUnit(event.peakFlux, "");
  const chirpMass = withUnit(event.chirpMass, "M☉", (n) => n.toFixed(2));
  const lumDist = withUnit(event.luminosityDistance, "Mpc", (n) => n.toFixed(0));
  const dm = withUnit(event.dm, "pc/cm³", (n) => n.toFixed(1));
  const obs = observability(event);

  return (
    <div className="rounded border border-border bg-card p-3 space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Derived parameters</div>
      {event.eventType === "GRB" && <Item label="Ep" value={ep} />}
      {event.eventType !== "GW" && <Item label="T90" value={t90} />}
      {event.eventType === "GRB" && <Item label="Fluence" value={fluence} />}
      {event.eventType !== "GW" && <Item label="Peak Flux" value={peakFlux} />}
      {event.eventType === "GW" && <Item label="Chirp Mass" value={chirpMass} />}
      {event.eventType === "GW" && <Item label="Lum. Dist" value={lumDist} />}
      {/* Dispersion measure is the defining observable of an FRB and is
          meaningless for every other type here, so it is shown for FRBs
          alone rather than for everything that is not a GW. */}
      {event.eventType === "FRB" && <Item label="DM" value={dm} />}
      <Item label="Observability" value={obs.value} title={obs.title} />
      <Item label="Classification" value={getClassification(event)} />
    </div>
  );
}
