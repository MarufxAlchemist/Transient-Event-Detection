"""
test_grb_validation.py
----------------------
The GRB spectral-fit validation engine (Phase 6).

Two properties matter more than any individual threshold:

  1. A check that was SKIPPED is never reported as having run. `checks_run` is
     what lets the API say "evaluated, nothing objected" instead of guessing
     from an empty flag list, so listing an inapplicable check there would
     manufacture reassurance.

  2. An unconstrained Ep is flagged as such, so the physicality and literature
     checks below it cannot be misread as confirming a number the fit never
     pinned down.

Pure functions — no database, no network, no pipeline.
"""

from pathlib import Path
import sys

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from grb_fit_worker.validation import (  # noqa: E402
    CHECK_ALPHA_SYNCHROTRON,
    CHECK_BAND_CLOSURE,
    CHECK_EP_CONSTRAINED,
    CHECK_EP_RANGE,
    CHECK_LITERATURE_EP,
    validate_fit,
)


def _fit(**over):
    """A well-behaved CPL fit; override individual fields per test."""
    base = {
        "model": "cpl",
        "alpha": -1.0,
        "alpha_low": 0.05,
        "alpha_high": 0.05,
        "beta": None,
        "ep_best": 250.0,
        "ep_low": 20.0,
        "ep_high": 20.0,
        "ep_constrained": True,
        "log_ep_hits_prior_low": False,
        "log_ep_hits_prior_high": False,
        "raw_params": {},
    }
    base.update(over)
    return base


def _sev(flags, check):
    return [f["severity"] for f in flags if f["check_name"] == check]


# ── checks_run bookkeeping ───────────────────────────────────────────────────

def test_clean_cpl_fit_runs_checks_and_raises_nothing():
    flags, ran = validate_fit(_fit())
    assert flags == []
    # This is the state that lets the UI say "no issues found".
    assert CHECK_EP_RANGE in ran
    assert CHECK_ALPHA_SYNCHROTRON in ran
    assert CHECK_EP_CONSTRAINED in ran


def test_band_closure_is_skipped_not_passed_for_cpl():
    # CPL has no beta at all. Reporting the check as "run" would claim the fit
    # was tested for something that cannot apply to it.
    _, ran = validate_fit(_fit(model="cpl"))
    assert CHECK_BAND_CLOSURE not in ran


def test_band_closure_runs_for_band_family():
    _, ran = validate_fit(_fit(model="band", beta=-2.4))
    assert CHECK_BAND_CLOSURE in ran


def test_literature_check_absent_without_a_reference():
    _, ran = validate_fit(_fit(), literature=None)
    assert CHECK_LITERATURE_EP not in ran


# ── 1. Band closure (critical) ───────────────────────────────────────────────

def test_band_closure_violation_is_critical():
    flags, _ = validate_fit(_fit(model="band", alpha=-2.5, beta=-1.2))
    assert _sev(flags, CHECK_BAND_CLOSURE) == ["critical"]


def test_band_closure_satisfied_is_silent():
    flags, _ = validate_fit(_fit(model="band", alpha=-1.0, beta=-2.4))
    assert _sev(flags, CHECK_BAND_CLOSURE) == []


def test_band_closure_equal_indices_violates():
    # alpha == beta puts the break at zero energy, not merely close to it.
    flags, _ = validate_fit(_fit(model="band", alpha=-2.0, beta=-2.0))
    assert _sev(flags, CHECK_BAND_CLOSURE) == ["critical"]


# ── 2. Physicality bounds ────────────────────────────────────────────────────

def test_ep_far_above_observed_population_warns():
    flags, _ = validate_fit(_fit(ep_best=50_000.0))  # 50 MeV
    assert "warning" in _sev(flags, CHECK_EP_RANGE)


def test_ep_far_below_observed_population_warns():
    flags, _ = validate_fit(_fit(ep_best=0.05))
    assert "warning" in _sev(flags, CHECK_EP_RANGE)


def test_ep_inside_observed_population_is_silent():
    for ep in (5.0, 250.0, 14_000.0):
        flags, _ = validate_fit(_fit(ep_best=ep))
        assert _sev(flags, CHECK_EP_RANGE) == [], ep


def test_alpha_below_minus_two_is_inconsistent_with_positive_ep():
    # Ep = (2 + alpha) * E0 cannot be positive for alpha <= -2 with E0 > 0.
    flags, _ = validate_fit(_fit(alpha=-2.3))
    assert "warning" in _sev(flags, CHECK_EP_RANGE)


# ── 3. Synchrotron regime (INFO, never a defect) ─────────────────────────────

def test_alpha_above_line_of_death_is_info_not_warning():
    # alpha > -2/3 rules out synchrotron and favours a photosphere. That is a
    # statement about mechanism, so it must not be styled as a bad fit.
    flags, _ = validate_fit(_fit(alpha=-0.2))
    assert _sev(flags, CHECK_ALPHA_SYNCHROTRON) == ["info"]


def test_alpha_softer_than_fast_cooling_is_info():
    flags, _ = validate_fit(_fit(alpha=-1.8))
    assert _sev(flags, CHECK_ALPHA_SYNCHROTRON) == ["info"]


def test_alpha_within_one_sigma_of_the_limit_is_not_flagged():
    # A REAL fit of GRB150514A returned alpha = -1.508 +0.076/-0.077. The
    # central value is 0.008 past the fast-cooling limit while the 1-sigma
    # interval straddles it, so flagging the burst as outside the synchrotron
    # range would be an artefact of treating a point estimate as exact.
    flags, ran = validate_fit(_fit(alpha=-1.5078, alpha_low=0.0773, alpha_high=0.0759))
    assert CHECK_ALPHA_SYNCHROTRON in ran      # the check ran ...
    assert _sev(flags, CHECK_ALPHA_SYNCHROTRON) == []   # ... and stayed silent


def test_barely_constrained_alpha_is_not_flagged():
    # GRB809707716's real fit: alpha = -0.094 with a 1-sigma half-width of 1.3.
    # It nominally exceeds the line of death, but an interval spanning
    # [-1.41, +1.20] cannot support any statement about emission mechanism.
    flags, _ = validate_fit(_fit(alpha=-0.0941, alpha_low=1.3121, alpha_high=1.2988))
    assert _sev(flags, CHECK_ALPHA_SYNCHROTRON) == []


def test_typical_alpha_is_silent():
    flags, _ = validate_fit(_fit(alpha=-1.0))
    assert _sev(flags, CHECK_ALPHA_SYNCHROTRON) == []


# ── 4. Unconstrained Ep ──────────────────────────────────────────────────────

def test_unconstrained_ep_is_flagged_and_says_others_are_inconclusive():
    flags, ran = validate_fit(_fit(
        ep_constrained=False,
        log_ep_hits_prior_low=True,
        log_ep_hits_prior_high=True,
        raw_params={
            "log_Ep_1sigma_min": 0.011, "log_Ep_1sigma_max": 3.987,
            "log_Ep_prior_lo": 0.0, "log_Ep_prior_hi": 4.0,
        },
    ))
    assert _sev(flags, CHECK_EP_CONSTRAINED) == ["info"]
    msg = next(f["message"] for f in flags if f["check_name"] == CHECK_EP_CONSTRAINED)
    assert "INCONCLUSIVE" in msg
    assert "lower and upper" in msg
    # The physicality check still RUNS — it is recorded, just not trusted.
    assert CHECK_EP_RANGE in ran


def test_constrained_ep_raises_no_caveat():
    flags, _ = validate_fit(_fit(ep_constrained=True))
    assert _sev(flags, CHECK_EP_CONSTRAINED) == []


# ── 5. Literature comparison ─────────────────────────────────────────────────

GRB150514A = {
    "event_name": "GRB150514A", "gcn_source": "GCN 17819",
    "gcn_url": "https://gcn.nasa.gov/circulars/17819",
    "model": "band", "e_peak_kev": 73.0, "e_peak_err": 6.0,
}


def test_literature_agreement_is_silent():
    flags, ran = validate_fit(
        _fit(model="cpl", ep_best=75.0, ep_low=5.0, ep_high=5.0), GRB150514A,
    )
    assert CHECK_LITERATURE_EP in ran
    assert _sev(flags, CHECK_LITERATURE_EP) == []


def test_literature_disagreement_beyond_three_sigma_warns():
    flags, _ = validate_fit(
        _fit(model="cpl", ep_best=400.0, ep_low=5.0, ep_high=5.0), GRB150514A,
    )
    assert _sev(flags, CHECK_LITERATURE_EP) == ["warning"]


def test_literature_flag_carries_the_citation_url():
    flags, _ = validate_fit(
        _fit(model="cpl", ep_best=400.0, ep_low=5.0, ep_high=5.0), GRB150514A,
    )
    f = next(f for f in flags if f["check_name"] == CHECK_LITERATURE_EP)
    assert f["reference_url"] == "https://gcn.nasa.gov/circulars/17819"


def test_cross_model_comparison_is_stated_not_hidden():
    # Published Band vs fitted CPL: legitimate, but part of the difference is
    # the model rather than the data, and the message has to say so.
    flags, _ = validate_fit(
        _fit(model="cpl", ep_best=400.0, ep_low=5.0, ep_high=5.0), GRB150514A,
    )
    msg = next(f["message"] for f in flags if f["check_name"] == CHECK_LITERATURE_EP)
    assert "band" in msg and "cpl" in msg


def test_wide_fit_error_absorbs_a_large_difference():
    # A fit that cannot pin Ep down should not be accused of contradicting the
    # literature — the combined uncertainty is what decides.
    flags, _ = validate_fit(
        _fit(model="cpl", ep_best=400.0, ep_low=2000.0, ep_high=2000.0), GRB150514A,
    )
    assert _sev(flags, CHECK_LITERATURE_EP) == []
