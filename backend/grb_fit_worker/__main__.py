"""grb-fit-worker — drains core.grb_fit_jobs, one fit at a time.

    python -m grb_fit_worker

Single concurrency by design. A fit runs MultiNest over three detectors'
spectra; it is CPU-bound and the pipeline's own parallelism (`n_workers`) is
pinned to 1 here, so the useful unit of scaling is a second container, not a
second thread in this one.

The loop never dies of a job. A job that fails is recorded as failed with its
reason and the worker goes back to polling; only a database that cannot be
reached stops it.
"""

from __future__ import annotations

import logging
import os
import signal
import sys
import time
import traceback

import psycopg2

from . import db
from .pipeline_runner import FitInputError, run_fit
from .validation import validate_fit

LOG = logging.getLogger("grb-fit-worker")

POLL_INTERVAL = float(os.environ.get("GRB_FIT_POLL_INTERVAL_SECONDS", "15"))
DATA_BASE = os.environ.get("DATA_BASE")

_shutdown = False


def _request_shutdown(signum, _frame):
    """Finish the job in hand, then stop.

    A fit is minutes of downloads and sampling; aborting mid-way would leave
    the job 'running' forever with no worker holding it. `docker compose stop`
    sends SIGTERM and waits, so the graceful path is to stop claiming NEW work.
    """
    global _shutdown
    _shutdown = True
    LOG.info("signal %s received — finishing current job, then exiting", signum)


def process_one(conn) -> bool:
    """Claim and process a single job. True if one was found."""
    job = db.claim_job(conn)
    if job is None:
        return False

    LOG.info(
        "claimed job %s (event_pk=%s event_id=%s model=%s dets=%s nlive=%s attempt=%s)",
        job["id"], job["event_pk"], job["event_id"], job["model"],
        job["detector_cfg"], job["nlive"], job["attempts"],
    )

    try:
        event = db.load_event(conn, job["event_pk"])
        if event is None:
            raise FitInputError(
                f"Event {job['event_pk']} not found — it was deleted after the "
                "job was enqueued."
            )

        started = time.monotonic()
        fit = run_fit(job=job, event=event, data_base=DATA_BASE)
        elapsed = time.monotonic() - started

        # Validation runs here, inside the same transaction as the fit, so a
        # stored fit is never briefly visible as "unevaluated" when it has in
        # fact been checked. A failure to validate must not lose the fit, so
        # the engine is defensive rather than allowed to abort the write.
        try:
            literature = db.load_literature(conn, job.get("grb_name") or event["event_id"])
            flags, checks_run = validate_fit(fit, literature)
        except Exception as exc:  # noqa: BLE001
            LOG.error("job %s: validation raised, storing fit unevaluated: %s", job["id"], exc)
            flags, checks_run = [], None

        fit_id = db.record_success(conn, job, fit, flags=flags, checks_run=checks_run)
        LOG.info(
            "job %s succeeded in %.1fs -> fit %s | dets=%s alpha=%.4g Ep=%.4g keV "
            "ep_constrained=%s key=%s | checks=%s flags=%s",
            job["id"], elapsed, fit_id, fit["fit_dets"], fit["alpha"],
            fit["ep_best"], fit["ep_constrained"], fit["hdf5_key"],
            len(checks_run) if checks_run is not None else "none",
            [f"{f['severity']}:{f['check_name']}" for f in flags],
        )
    except FitInputError as exc:
        # Expected, actionable, and not a bug: bad or missing inputs.
        LOG.warning("job %s failed: %s", job["id"], exc)
        db.record_failure(conn, job["id"], str(exc))
    except Exception as exc:  # noqa: BLE001 — the loop must survive anything
        LOG.error("job %s failed: %s", job["id"], exc)
        db.record_failure(
            conn, job["id"], f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}"
        )
    return True


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("GRB_FIT_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stdout,
    )
    signal.signal(signal.SIGTERM, _request_shutdown)
    signal.signal(signal.SIGINT, _request_shutdown)

    LOG.info(
        "starting | poll=%ss DATA_BASE=%s pipeline=%s",
        POLL_INTERVAL, DATA_BASE, os.environ.get("GRB_PIPELINE_VERSION", "unset"),
    )

    conn = db.connect()
    try:
        while not _shutdown:
            try:
                worked = process_one(conn)
            except psycopg2.Error as exc:
                # The database went away. Drop the connection and retry — this
                # is the one failure the loop cannot record anywhere.
                LOG.error("database error, reconnecting: %s", exc)
                try:
                    conn.close()
                except Exception:
                    pass
                time.sleep(POLL_INTERVAL)
                conn = db.connect()
                continue

            if not worked and not _shutdown:
                time.sleep(POLL_INTERVAL)
    finally:
        try:
            conn.close()
        except Exception:
            pass
    LOG.info("stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
