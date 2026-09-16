"""Invoke the fermi-gbm-analysis pipeline for one job.

This module owns everything that knows about the pipeline's real API, which was
established by reading its source and running it end to end (Phase 0), not from
documentation:

  * ``GRBPipelineRunner(n_workers, model_name, nlive, fixed_params, force,
    include_bgo)`` — ``.run()`` returns the MUTATED ``GRBContext``, not a
    results object. Stage names (geometry / spectra_tint / fit_tint / params)
    are arguments, not attributes of a return value.
  * Fit products land on disk under a fingerprinted directory tree; the fitted
    parameters are read back by calling ``extract_params(ctx, ...)`` separately,
    which returns a one-row DataFrame AND appends it to the shared per-GRB HDF5
    file.
  * ``extract_params`` emits asymmetric error OFFSETS (``alpha_low`` is a
    distance below ``alpha``, not a bound) and no ``log_likelihood``.

Non-catalog bursts
------------------
``GRBContext.from_name()`` resolves only the eight curated bursts in the
pipeline's ``grb_config.py``. Every real GCN burst is built here instead by
constructing ``GRBContext`` directly from RA/Dec/UTC with ``det_mode='auto'``,
which routes detector selection through ``suggest_detectors()`` — ranking all
14 detectors by angle to the source and taking the closest NaI pair plus the
closest BGO.
"""

from __future__ import annotations

import math
import os
from typing import Any


class FitInputError(Exception):
    """The job cannot be fitted as specified, and no retry would help."""


def _clean(value: Any) -> Any:
    """NaN/inf -> None, numpy scalar -> Python float.

    pandas represents a missing parameter as NaN, which is NOT None: it would
    pass an ``IS NOT NULL`` check, fail the schema's numeric CHECK constraints
    in confusing ways, and — worst — serialise into ``raw_params`` as the bare
    token ``NaN``, which is not valid JSON and which Postgres rejects on insert.
    Every value leaving this module goes through here.
    """
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return value
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def _opt_bool(row: dict, key: str) -> bool | None:
    """Pipeline flag -> tri-state boolean.

    The pipeline writes these as 1.0/0.0 floats. Absent is NOT False: a model
    with no Ep parameter emits no ``ep_constrained`` at all, and recording that
    as False would assert the fit hit a prior edge it never had.
    """
    value = _clean(row.get(key))
    return None if value is None else bool(value)


def build_context(
    *,
    name: str,
    ra: float,
    dec: float,
    utc: str,
    t1: float,
    t2: float,
    data_base: str | None = None,
):
    """A GRBContext for a burst the pipeline's catalog has never heard of.

    ``det_mode='auto'`` is the whole point: the curated catalog rows carry
    hand-picked ``sel_dets``, and a live burst has none, so detectors must be
    selected geometrically from the spacecraft attitude at trigger time.

    ``data_base`` goes through the constructor so ``__post_init__`` builds the
    PathLayout from it; setting it afterwards would leave paths pointing at the
    import-time default.
    """
    from pipeline.constants import DATA_BASE
    from pipeline.context import GRBContext

    return GRBContext(
        name=name,
        ra=float(ra),
        dec=float(dec),
        utc=utc,
        det_mode="auto",
        t1=float(t1),
        t2=float(t2),
        data_base=data_base or DATA_BASE,
    )


def resolve_window(job: dict, event: dict) -> tuple[float, float]:
    """Decide the time-integrated fit window, or refuse.

    Order: the job's explicit window, else [0, t90], else fail. There is no
    third fallback on purpose — fitting a guessed interval would produce
    real-looking parameters for a window nobody chose.
    """
    if job.get("t1") is not None and job.get("t2") is not None:
        return float(job["t1"]), float(job["t2"])

    t90 = event.get("t90")
    if t90 is not None and float(t90) > 0:
        return 0.0, float(t90)

    raise FitInputError(
        "No fit window: job has no t1/t2 and event "
        f"{event.get('event_id')!r} has no t90. A time-integrated fit is "
        "defined over an interval; refusing to invent one."
    )


def run_fit(*, job: dict, event: dict, data_base: str | None = None) -> dict:
    """Run one fit and return a row shaped for core.grb_spectral_fits.

    Raises FitInputError for inputs that cannot be fitted, and lets pipeline
    exceptions propagate — the caller records either as a job failure.
    """
    from pipeline.fitting import extract_params, resolve_fit_dets
    from pipeline.paths import active_fit_dir, extraction_fingerprint, fit_fingerprint
    from pipeline.runner import GRBPipelineRunner

    for field in ("ra", "dec", "utc"):
        if event.get(field) is None:
            raise FitInputError(
                f"Event {event.get('event_id')!r} has no {field}; a fit needs a "
                "sky position and a trigger time to select detectors and "
                "generate a response."
            )

    t1, t2 = resolve_window(job, event)
    model = job["model"]
    nlive = int(job["nlive"])
    include_bgo = job["detector_cfg"] == "nai_bgo"

    # The pipeline names the on-disk directory after this, so it must be stable
    # per event. The catalog name when we have one, else the GCN id.
    name = job.get("grb_name") or event["event_id"]

    ctx = build_context(
        name=name,
        ra=event["ra"],
        dec=event["dec"],
        utc=event["utc"],
        t1=t1,
        t2=t2,
        data_base=data_base,
    )

    runner = GRBPipelineRunner(
        n_workers=1,          # single concurrency by design
        model_name=model,
        nlive=nlive,
        include_bgo=include_bgo,
    )

    # load() = retrieve TTE/poshist + resolve_detectors(). With det_mode='auto'
    # this is where a non-catalog burst gets its detector set.
    ctx = runner.load(ctx)
    if not ctx.sel_dets or len(ctx.sel_dets) < 2:
        raise FitInputError(
            f"Detector auto-selection produced {ctx.sel_dets!r} for {name}; a "
            "spectral fit needs at least two."
        )

    # 'params' is deliberately omitted: run() would call extract_params and
    # discard the DataFrame, so we call it ourselves below and keep the result.
    runner.run(ctx, stages="geometry,spectra_tint,fit_tint")

    df = extract_params(
        ctx, model_name=model, mode="tintegrated", nlive=nlive, include_bgo=include_bgo
    )
    if df is None or len(df) == 0:
        raise FitInputError(
            f"extract_params returned nothing for {name}; the fit produced no "
            "posterior to summarise."
        )

    row = {k: _clean(v) for k, v in df.iloc[0].to_dict().items()}

    # Recompute the fit's on-disk identity exactly the way the pipeline does,
    # rather than reconstructing the key format by hand — extract_params
    # switches between two key spellings depending on whether the fit landed in
    # the canonical directory or a versioned one.
    fit_dets = resolve_fit_dets(ctx, include_bgo=include_bgo)
    fit_fp = fit_fingerprint(ctx, model, {}, nlive, fit_dets=fit_dets)
    model_root = os.path.join(ctx.paths.bayspec_tintegrated_path, model)
    fit_dir = active_fit_dir(model_root, fit_fp, f"canonical_fit_{model}")
    hdf5_key = (
        f"tint_{model}_{ctx.name}"
        if fit_dir == model_root
        else f"tint_{model}_{fit_fp}_{ctx.name}"
    )

    return {
        "model": model,
        "detector_cfg": job["detector_cfg"],
        "mode": "tintegrated",
        "fit_dets": list(fit_dets),
        "include_bgo": include_bgo,
        "nlive": nlive,
        "t1": t1,
        "t2": t2,
        # Asymmetric OFFSETS, stored exactly as produced. Converting these to
        # bounds would silently misstate every uncertainty downstream.
        "alpha": row.get("alpha"),
        "alpha_low": row.get("alpha_low"),
        "alpha_high": row.get("alpha_high"),
        "beta": row.get("beta"),
        "beta_low": row.get("beta_low"),
        "beta_high": row.get("beta_high"),
        "ep_best": row.get("Ep_best"),
        "ep_low": row.get("Ep_low"),
        "ep_high": row.get("Ep_high"),
        "amplitude": row.get("A"),
        "vfv_best": row.get("vFv_best"),
        "vfv_low": row.get("vFv_low"),
        "vfv_high": row.get("vFv_high"),
        "ep_constrained": _opt_bool(row, "ep_constrained"),
        "log_ep_hits_prior_low": _opt_bool(row, "log_Ep_hits_prior_low"),
        "log_ep_hits_prior_high": _opt_bool(row, "log_Ep_hits_prior_high"),
        "hdf5_path": ctx.paths.bayspec_data,
        "hdf5_key": hdf5_key,
        "fit_dir": fit_dir,
        "fit_fingerprint": fit_fp,
        "extraction_fingerprint": extraction_fingerprint(ctx),
        "pipeline_version": os.environ.get("GRB_PIPELINE_VERSION"),
        "raw_params": row,
        "sel_dets": list(ctx.sel_dets),
    }
