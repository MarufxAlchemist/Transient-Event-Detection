"""Scientific validation of a completed spectral fit.

Runs in the worker immediately after a fit is stored. Produces zero or more
flags, plus the list of checks that actually executed.

TWO RULES THIS MODULE FOLLOWS
─────────────────────────────
1. Every numeric threshold is traceable to a cited source. Where no source
   supports a bound, the check is not implemented — a plausible-sounding cutoff
   that nobody can defend is worse than no check, because it produces
   authoritative-looking verdicts nobody can audit.

2. A check that RAN and stayed silent is recorded (in `checks_run`); a check
   that was SKIPPED is not. "Did not apply" must never read as "found nothing".

SOURCE
──────
Bing Zhang, "The Physics of Gamma-Ray Bursts" (Cambridge University Press).
Page numbers below are the book's printed page numbers.
"""

from __future__ import annotations

from typing import Any

# ── Check names (stable identifiers; stored in grb_spectral_fits.checks_run) ──
CHECK_EP_CONSTRAINED = "ep_constrained"
CHECK_BAND_CLOSURE = "band_closure"
CHECK_EP_RANGE = "ep_physical_range"
CHECK_ALPHA_SYNCHROTRON = "alpha_synchrotron_regime"
CHECK_LITERATURE_EP = "literature_ep_comparison"

# ── Model families ───────────────────────────────────────────────────────────
# From MODEL_COLS in the pipeline's constants.py: only these carry a beta.
BAND_FAMILY = {"band", "bpl", "sbpl", "cband", "dband", "hleband", "grbm"}

# ── Cited thresholds ─────────────────────────────────────────────────────────
#
# Zhang §2, p. 49, eq. (2.5): the Band function's two power-law regimes are
# split at E = (alpha - beta) * E0. That break energy is positive only when
# alpha > beta. A fit with alpha <= beta therefore does not describe a Band
# spectrum at all — the "break" sits at or below zero energy.
#
# Zhang §2, p. 49, eq. (2.6): Ep = (2 + alpha) * E0. With E0 > 0 a positive Ep
# requires alpha > -2, so alpha <= -2 alongside a positive Ep is internally
# inconsistent.
ALPHA_EP_POSITIVITY_LIMIT = -2.0

# Zhang §9, p. 446, item 12 ("distribution of Ep among GRBs"): the global Ep
# distribution runs "from several keV for GRB 060218-like X-ray flashes
# (Campana et al. 2006; Sakamoto et al. 2005) to ~15 MeV for GRB 110721A
# (Axelsson et al. 2012)". Both ends are anchored on named, real bursts.
#
# The lower bound is set at 1 keV rather than "several", deliberately looser
# than anything cited: this is a warning about values outside the observed
# population, and it should fire on the clearly-impossible, not on the merely
# soft.
EP_MIN_OBSERVED_KEV = 1.0
EP_MAX_OBSERVED_KEV = 15_000.0  # 15 MeV, GRB 110721A

# Zhang §9, p. 377: for synchrotron radiation the low-energy photon index is
# -2/3 in the slow-cooling regime and -3/2 in fast cooling, and "the observed
# typical value -1 is enclosed between (-3/2, -2/3), suggesting that synchrotron
# radiation may be a relevant mechanism".
#
# alpha > -2/3 exceeds the "synchrotron line of death" (Preece et al. 1998).
# NOTE this is NOT an error condition. Zhang §9, p. 446, item 9 is explicit:
# "A fraction of GRBs have alpha > -2/3 ... For these GRBs, the IS and ICMART
# models are ruled out, and the photosphere model is validated." So crossing it
# discriminates between emission models; it does not make a fit wrong. That is
# why this check emits INFO and says so, rather than warning about implausible
# physics.
SYNCHROTRON_SLOW_COOLING_ALPHA = -2.0 / 3.0
SYNCHROTRON_FAST_COOLING_ALPHA = -1.5

# Literature comparison. There is no physical constant governing "how far is too
# far" from a published value, so rather than invent a relative percentage this
# uses the uncertainties both sources actually report and applies the ordinary
# 3-sigma convention. The threshold is therefore a stated statistical choice,
# not a fabricated physical bound.
LITERATURE_SIGMA_THRESHOLD = 3.0


def _flag(check: str, severity: str, message: str, reference_url: str | None = None) -> dict:
    return {
        "check_name": check,
        "severity": severity,
        "message": message,
        "reference_url": reference_url,
    }


def _fmt(x: float | None, digits: int = 2) -> str:
    return "unknown" if x is None else f"{x:.{digits}f}"


def validate_fit(fit: dict, literature: dict | None = None) -> tuple[list[dict], list[str]]:
    """Validate one fit.

    `fit` is the row shape produced by pipeline_runner.run_fit().
    `literature` is a core.grb_literature_refs row for this burst, or None.

    Returns (flags, checks_run). `checks_run` lists only checks that actually
    executed — a check skipped for want of an applicable model or a required
    input is left out on purpose.
    """
    flags: list[dict] = []
    ran: list[str] = []

    model = (fit.get("model") or "").lower()
    alpha = fit.get("alpha")
    beta = fit.get("beta")
    ep = fit.get("ep_best")
    ep_constrained = fit.get("ep_constrained")

    # ── 1. Is Ep constrained at all? ─────────────────────────────────────────
    # Runs first because its outcome changes how every Ep-dependent check below
    # should be read. When the posterior ran into its prior edge, Ep is an
    # artefact of the prior; a value that happens to land inside a physical
    # range has not been confirmed by anything, it simply had nowhere else to
    # go. Without this flag, a silent ep_physical_range check would look like
    # corroboration.
    if ep_constrained is not None:
        ran.append(CHECK_EP_CONSTRAINED)
        if ep_constrained is False:
            edges = []
            if fit.get("log_ep_hits_prior_low"):
                edges.append("lower")
            if fit.get("log_ep_hits_prior_high"):
                edges.append("upper")
            where = " and ".join(edges) if edges else "a"
            raw = fit.get("raw_params") or {}
            lo, hi = raw.get("log_Ep_1sigma_min"), raw.get("log_Ep_1sigma_max")
            plo, phi = raw.get("log_Ep_prior_lo"), raw.get("log_Ep_prior_hi")
            flags.append(_flag(
                CHECK_EP_CONSTRAINED,
                "info",
                f"Ep is unconstrained by this fit: the 1-sigma log-Ep interval "
                f"[{_fmt(lo, 3)}, {_fmt(hi, 3)}] reaches the {where} edge of the "
                f"prior [{_fmt(plo, 1)}, {_fmt(phi, 1)}]. The quoted Ep reflects "
                f"the prior rather than the data, so the physicality and "
                f"literature checks below are INCONCLUSIVE for this fit — "
                f"treat them as neither confirming nor refuting Ep.",
            ))

    # ── 2. Band closure ──────────────────────────────────────────────────────
    # Skipped, not passed, for models with no beta.
    if model in BAND_FAMILY and beta is not None and alpha is not None:
        ran.append(CHECK_BAND_CLOSURE)
        if alpha <= beta:
            flags.append(_flag(
                CHECK_BAND_CLOSURE,
                "critical",
                f"Band closure violated: alpha ({alpha:.3f}) <= beta ({beta:.3f}). "
                f"The Band function splits its two power laws at E = (alpha - beta) * E0 "
                f"(Zhang, The Physics of Gamma-Ray Bursts, p. 49, eq. 2.5); with "
                f"alpha <= beta that break energy is not positive, so these parameters "
                f"do not describe a Band spectrum and the fit is unreliable.",
            ))

    # ── 3. Ep within the observed GRB population ─────────────────────────────
    if ep is not None:
        ran.append(CHECK_EP_RANGE)
        if ep < EP_MIN_OBSERVED_KEV or ep > EP_MAX_OBSERVED_KEV:
            flags.append(_flag(
                CHECK_EP_RANGE,
                "warning",
                f"Ep = {ep:.2f} keV lies outside the observed GRB range "
                f"{EP_MIN_OBSERVED_KEV:.0f} keV - {EP_MAX_OBSERVED_KEV / 1000:.0f} MeV. "
                f"The population runs from several keV (GRB 060218-like X-ray "
                f"flashes) to ~15 MeV (GRB 110721A) — Zhang, The Physics of "
                f"Gamma-Ray Bursts, p. 446, item 12.",
            ))
        # Internal consistency of the parameterisation itself (eq. 2.6).
        if alpha is not None and alpha <= ALPHA_EP_POSITIVITY_LIMIT:
            flags.append(_flag(
                CHECK_EP_RANGE,
                "warning",
                f"alpha = {alpha:.3f} <= -2 alongside a positive Ep is internally "
                f"inconsistent: Ep = (2 + alpha) * E0 (Zhang, p. 49, eq. 2.6), so "
                f"alpha <= -2 cannot produce a positive peak energy with E0 > 0.",
            ))

    # ── 4. Which emission mechanism does alpha allow? ────────────────────────
    # INFO, never a warning: crossing the line of death rules models in and out,
    # it does not make a fit wrong. See the constant's citation above.
    #
    # The comparison uses alpha's OWN 1-sigma interval, not its central value.
    # A real fit of GRB150514A returned alpha = -1.508 +0.076/-0.077: the
    # central value sits 0.008 past the fast-cooling limit while the interval
    # [-1.585, -1.432] straddles it comfortably. Flagging that burst as outside
    # the synchrotron range would be an artefact of reading a point estimate as
    # if it were exact. The flag now fires only when the entire interval lies
    # beyond the limit — which also, correctly, silences the check for fits that
    # barely constrain alpha at all.
    if alpha is not None:
        ran.append(CHECK_ALPHA_SYNCHROTRON)
        a_lo = fit.get("alpha_low") or 0.0
        a_hi = fit.get("alpha_high") or 0.0
        alpha_softest = alpha - float(a_lo)   # lower edge of the 1-sigma interval
        alpha_hardest = alpha + float(a_hi)   # upper edge
        if alpha_softest > SYNCHROTRON_SLOW_COOLING_ALPHA:
            flags.append(_flag(
                CHECK_ALPHA_SYNCHROTRON,
                "info",
                f"alpha = {alpha:.3f} (+{a_hi:.3f}/-{a_lo:.3f}) is harder than -2/3 across "
                f"its whole 1-sigma interval, exceeding the synchrotron "
                f"'line of death' (Preece et al. 1998). Synchrotron models are ruled "
                f"out for this burst and a photospheric origin is favoured — this is "
                f"a statement about emission mechanism, not a defect in the fit. "
                f"Zhang, The Physics of Gamma-Ray Bursts, p. 377 and p. 446 item 9.",
            ))
        elif alpha_hardest < SYNCHROTRON_FAST_COOLING_ALPHA:
            flags.append(_flag(
                CHECK_ALPHA_SYNCHROTRON,
                "info",
                f"alpha = {alpha:.3f} (+{a_hi:.3f}/-{a_lo:.3f}) is softer than -3/2 across "
                f"its whole 1-sigma interval, below the deep fast-cooling "
                f"synchrotron limit. Observed GRB alpha typically falls within "
                f"(-3/2, -2/3) around -1 (Zhang, p. 377), so this sits outside the "
                f"usual synchrotron-consistent range.",
            ))

    # ── 5. Comparison against the published value ────────────────────────────
    if literature is not None and ep is not None:
        lit_ep = literature.get("e_peak_kev")
        lit_err = literature.get("e_peak_err")
        if lit_ep is not None:
            ran.append(CHECK_LITERATURE_EP)
            # Combine the published error with this fit's own asymmetric error
            # on the side that faces the published value.
            fit_err = fit.get("ep_low") if ep > lit_ep else fit.get("ep_high")
            fit_err = float(fit_err) if fit_err else 0.0
            lit_err_f = float(lit_err) if lit_err else 0.0
            combined = (fit_err ** 2 + lit_err_f ** 2) ** 0.5
            diff = abs(ep - float(lit_ep))

            model_note = ""
            lit_model = (literature.get("model") or "").lower()
            if lit_model and lit_model != model:
                # GRB150514A's published fit is Band while the pipeline fits CPL;
                # comparing across model families is legitimate but must be said.
                model_note = (
                    f" Note the published value is a {lit_model} fit while this is "
                    f"{model}, so part of any difference is the model, not the data."
                )

            if combined > 0 and diff > LITERATURE_SIGMA_THRESHOLD * combined:
                flags.append(_flag(
                    CHECK_LITERATURE_EP,
                    "warning",
                    f"Fitted Ep {ep:.2f} keV differs from the published "
                    f"{float(lit_ep):.2f} +/- {lit_err_f:.2f} keV "
                    f"({literature.get('gcn_source')}) by {diff:.2f} keV, more than "
                    f"{LITERATURE_SIGMA_THRESHOLD:.0f} sigma of the combined "
                    f"uncertainty ({combined:.2f} keV).{model_note}",
                    literature.get("gcn_url"),
                ))

    return flags, ran
