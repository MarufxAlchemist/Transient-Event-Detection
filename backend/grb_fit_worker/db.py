"""Postgres access for the GRB fit worker.

psycopg2, not asyncpg: it is the client every other Python process in this repo
already uses (backend/scripts/*.py), and the worker is deliberately
single-concurrency around a CPU-bound, blocking sampler, so an async driver
would add a dependency and buy nothing.
"""

from __future__ import annotations

import os
from pathlib import Path

import psycopg2
import psycopg2.extras


def load_database_url() -> str:
    """Environment first, repo-root .env second — as backend/scripts/ do."""
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if env_path.is_file():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            if line.startswith("DATABASE_URL="):
                return line.split("=", 1)[1].strip()
    raise SystemExit("DATABASE_URL not set and not found in repo-root .env")


def connect():
    conn = psycopg2.connect(load_database_url())
    conn.autocommit = False
    return conn


# ── Claiming ────────────────────────────────────────────────────────────────
#
# The claim is an UPDATE whose target is chosen by a SELECT ... FOR UPDATE SKIP
# LOCKED subquery. Two properties matter:
#
#   * SKIP LOCKED means a second worker steps over a row already being claimed
#     instead of blocking on it, so adding workers never serialises on the head
#     of the queue.
#   * The lock is taken ONLY on core.grb_fit_jobs. An earlier draft joined
#     core.events into the locking query to fetch RA/Dec in one round trip;
#     that would have taken row locks on core.events and let a slow claim block
#     the live ingestion upsert path. The event is read separately, unlocked,
#     immediately afterwards.
#
# The claim commits before the fit starts. Holding the transaction open across
# a multi-minute MultiNest run would keep the row locked and invisible as
# 'running', and would pin a Postgres backend for the duration.

_CLAIM_SQL = """
UPDATE core.grb_fit_jobs AS j
   SET status     = 'running',
       started_at = now(),
       attempts   = j.attempts + 1
 WHERE j.id = (
       SELECT id
         FROM core.grb_fit_jobs
        WHERE status = 'pending'
        ORDER BY requested_at, id
          FOR UPDATE SKIP LOCKED
        LIMIT 1
       )
RETURNING j.id, j.event_pk, j.event_id, j.grb_name, j.model,
          j.detector_cfg, j.nlive, j.t1, j.t2, j.attempts
"""

_EVENT_SQL = """
SELECT e.id,
       e.event_id,
       e.ra,
       e.dec,
       e.t90,
       to_char(e.detection_time AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS') AS utc
  FROM core.events e
 WHERE e.id = %s
"""


def claim_job(conn) -> dict | None:
    """Claim one pending job and mark it running. Commits."""
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute(_CLAIM_SQL)
        row = cur.fetchone()
        conn.commit()
        return dict(row) if row else None


def load_event(conn, event_pk: int) -> dict | None:
    """Read the event a job points at. No lock: ingestion must not be blocked.

    The trigger time is formatted to the pipeline's expected UTC string in SQL
    rather than in Python, so the conversion cannot drift with the process
    timezone.
    """
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute(_EVENT_SQL, (event_pk,))
        row = cur.fetchone()
        conn.commit()
        return dict(row) if row else None


# ── Completion ──────────────────────────────────────────────────────────────

_INSERT_FIT_SQL = """
INSERT INTO core.grb_spectral_fits (
    event_pk, event_id, job_id, model, detector_cfg, mode,
    fit_dets, include_bgo, nlive, t1, t2,
    alpha, alpha_low, alpha_high,
    beta, beta_low, beta_high,
    ep_best, ep_low, ep_high,
    amplitude,
    vfv_best, vfv_low, vfv_high,
    ep_constrained, log_ep_hits_prior_low, log_ep_hits_prior_high,
    hdf5_path, hdf5_key, fit_dir, fit_fingerprint, extraction_fingerprint,
    pipeline_version, raw_params, fit_timestamp
) VALUES (
    %(event_pk)s, %(event_id)s, %(job_id)s, %(model)s, %(detector_cfg)s, %(mode)s,
    %(fit_dets)s, %(include_bgo)s, %(nlive)s, %(t1)s, %(t2)s,
    %(alpha)s, %(alpha_low)s, %(alpha_high)s,
    %(beta)s, %(beta_low)s, %(beta_high)s,
    %(ep_best)s, %(ep_low)s, %(ep_high)s,
    %(amplitude)s,
    %(vfv_best)s, %(vfv_low)s, %(vfv_high)s,
    %(ep_constrained)s, %(log_ep_hits_prior_low)s, %(log_ep_hits_prior_high)s,
    %(hdf5_path)s, %(hdf5_key)s, %(fit_dir)s, %(fit_fingerprint)s,
    %(extraction_fingerprint)s,
    %(pipeline_version)s, %(raw_params)s, now()
)
RETURNING id
"""

_LITERATURE_SQL = """
SELECT event_name, gcn_source, gcn_url, model, t1, t2,
       alpha, alpha_err, beta, beta_err, e_peak_kev, e_peak_err, note
  FROM core.grb_literature_refs
 WHERE event_name = %s
 LIMIT 1
"""

_INSERT_FLAG_SQL = """
INSERT INTO core.grb_validation_flags
    (event_pk, fit_id, check_name, severity, message, reference_url)
VALUES (%(event_pk)s, %(fit_id)s, %(check_name)s, %(severity)s, %(message)s, %(reference_url)s)
"""


def load_literature(conn, event_name: str) -> dict | None:
    """Published parameters for this burst, if the curated table has any.

    Matched on the pipeline's own GRB name. Absent is the normal case: the
    table holds exactly the three bursts the pipeline documents.
    """
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute(_LITERATURE_SQL, (event_name,))
        row = cur.fetchone()
        return dict(row) if row else None


def record_success(
    conn,
    job: dict,
    fit: dict,
    flags: list[dict] | None = None,
    checks_run: list[str] | None = None,
) -> int:
    """Write the fit, its validation outcome, and mark the job succeeded.

    ONE transaction on purpose. A fit row without a succeeded job would be
    re-run forever; a succeeded job without a fit row would claim a result that
    does not exist; and a fit stored without its validation state would be
    indistinguishable from one nothing has checked — the exact ambiguity
    migration 0027 exists to remove. Either all of it lands or none does.

    `checks_run` is written even when it is empty-but-not-None: that records
    "validation ran and no check applied", which is different again from "never
    evaluated". The CHECK constraint keeps evaluated_at and checks_run in step.
    """
    params = dict(fit)
    params.pop("sel_dets", None)
    params.update(
        event_pk=job["event_pk"],
        event_id=job["event_id"],
        job_id=job["id"],
        raw_params=psycopg2.extras.Json(fit["raw_params"]),
    )
    with conn.cursor() as cur:
        cur.execute(_INSERT_FIT_SQL, params)
        fit_id = cur.fetchone()[0]

        if checks_run is not None:
            cur.execute(
                """
                UPDATE core.grb_spectral_fits
                   SET checks_run = %s, evaluated_at = now()
                 WHERE id = %s
                """,
                (list(checks_run), fit_id),
            )
        for f in flags or []:
            cur.execute(
                _INSERT_FLAG_SQL,
                {
                    "event_pk": job["event_pk"],
                    "fit_id": fit_id,
                    "check_name": f["check_name"],
                    "severity": f["severity"],
                    "message": f["message"],
                    "reference_url": f.get("reference_url"),
                },
            )

        cur.execute(
            """
            UPDATE core.grb_fit_jobs
               SET status = 'succeeded', finished_at = now(), error = NULL
             WHERE id = %s
            """,
            (job["id"],),
        )
    conn.commit()
    return fit_id


def record_failure(conn, job_id: int, message: str) -> None:
    """Mark the job failed with the reason. No automatic retry in v1.

    A spectral fit costs an archive download and minutes of CPU; looping on a
    burst whose data genuinely cannot be fitted would burn both indefinitely.
    Re-running is a deliberate act through the Phase 4 endpoint.
    """
    # Postgres rejects NUL bytes in text; pipeline tracebacks can carry them.
    cleaned = (message or "").replace("\x00", "")[:8000]
    try:
        conn.rollback()
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE core.grb_fit_jobs
                   SET status = 'failed', finished_at = now(), error = %s
                 WHERE id = %s
                """,
                (cleaned, job_id),
            )
        conn.commit()
    except psycopg2.Error:
        conn.rollback()
        raise
