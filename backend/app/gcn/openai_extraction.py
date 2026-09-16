"""
openai_extraction.py
--------------------
The SECOND, independent circular extraction: astro-colibri-circular-parser's
OpenAI photometry pipeline (Priority #8).

It runs *alongside* the Gemini extraction in the Node api-server, never in
place of it. Two extractors reading the same circular and disagreeing is
useful evidence; a silent replacement would destroy that.

BILLED, AND OFF BY DEFAULT
--------------------------
This is the only code path in the repository that can spend money. It is
gated on CIRCULAR_OPENAI_EXTRACTION_ENABLED, which is absent or false in
every environment except one Mac Mini deployment, configured by hand.

The flag is checked FIRST — before ParserSettings.from_env() (which is what
reads OPENAI_API_KEY), before any provider is constructed, before anything
imports `openai`. "No API key present, so it would fail anyway" is NOT the
safety net: that is a crash, not a deliberate no-op, and a machine that
happens to have OPENAI_API_KEY exported for some unrelated tool would
quietly start billing. The flag is the gate; everything else is
defence in depth.

Measured facts behind the design (verified against the installed package,
2026-09-09):

  * `from openai import OpenAI` lives INSIDE OpenAIPhotometryProvider.extract
    (extraction.py:453), so importing this module — or even
    OpenAIPhotometryProvider itself — cannot construct a client or touch the
    network. Asserted by a test.
  * parse_circular() recomputes build_regexp_hints() unconditionally
    (pipeline.py:90) and offers no way to inject ours. Measured at ~5 ms
    against a 120 s model call, so the duplicate is accepted deliberately
    rather than reimplementing the package's payload assembly. The hints we
    already hold are still passed in, so the caller's and the package's
    views can be compared if they ever diverge.
  * resolve_events=False skips ONLY the Astro-COLIBRI catalogue lookup.
    Together with event=None this keeps Priority #5's rule intact: event
    association is the Node api-server's job, done deterministically against
    core.events, and Python never makes that decision.
  * If `body` is empty, parse_circular falls through to fetch_circular() and
    performs an outbound request to gcn.nasa.gov (pipeline.py:73). A
    malformed request must therefore never reach it — see the body guard.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

#: The one flag that permits real spending. Absent or anything but "true"
#: means this module makes no network call of any kind.
ENABLED_ENV_VAR = "CIRCULAR_OPENAI_EXTRACTION_ENABLED"


def openai_extraction_enabled() -> bool:
    """
    Whether billed OpenAI extraction is permitted in THIS environment.

    Byte-for-byte "true" and nothing else. Not trimmed, not lower-cased:
    "1", "yes", "True", "TRUE" and "true " are all FALSE.

    This is stricter than it looks like it should be, for two reasons. The
    Node worker's gate is `process.env[...] === "true"` — the same form as
    CIRCULAR_EXTRACTION_SKIP_NON_SCIENTIFIC — and if this side accepted
    "TRUE " while that side rejected it, a trailing space in one .env would
    leave the endpoint billable while no worker ran, which is the most
    confusing possible state. And a value this side cannot interpret should
    fail towards not spending money.
    """
    return os.environ.get(ENABLED_ENV_VAR) == "true"


def _unavailable(reason: str, detail: str) -> Dict[str, Any]:
    """
    Say plainly that no extraction happened, and why.

    `reason` is a stable machine-readable token the Node worker branches on
    to decide retry-or-give-up; `detail` is for a human reading a log.
    """
    return {"available": False, "reason": reason, "detail": detail}


def extract_circular(
    subject: str,
    body: str,
    circular_number: str = "",
    regexp_hints: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Run the OpenAI extraction for one circular, or explain why it did not run.

    Never raises. Every outcome is a dict the caller can record:

      {"available": False, "reason": "not_enabled"}    terminal — do not retry
      {"available": False, "reason": "empty_body"}     terminal — do not retry
      {"available": False, "reason": "upstream_error"} transient — may retry
      {"available": True, "extraction": ..., ...}      success
    """
    # ── Gate 1: the environment flag. Nothing below this line runs otherwise. ──
    if not openai_extraction_enabled():
        return _unavailable(
            "not_enabled",
            f"{ENABLED_ENV_VAR} is not 'true' in this environment; no OpenAI "
            "call was made. This is the expected state everywhere except the "
            "designated deployment machine.",
        )

    # ── Gate 2: a body must be present. ──────────────────────────────────────
    # Not a validation nicety. parse_circular() treats a missing body as
    # "fetch it from gcn.nasa.gov yourself", so an empty body here would turn
    # a malformed request into an unintended outbound HTTP call.
    if not isinstance(body, str) or body.strip() == "":
        return _unavailable(
            "empty_body",
            "No circular body supplied. Refusing to call parse_circular, which "
            "would fetch the circular from gcn.nasa.gov instead.",
        )

    subject = subject if isinstance(subject, str) else ""
    circular_number = str(circular_number or "").strip()

    try:
        # Imported here, not at module scope: this module is imported by the
        # FastAPI app on every boot, including on machines where the parser
        # package may not be installed at all.
        from circular_parser import parse_circular

        result = parse_circular(
            subject=subject,
            body=body,
            circular_number=circular_number,
            # Priority #5's rule, enforced twice: no catalogue lookup, and no
            # pre-supplied event either. Python never decides which event a
            # circular belongs to.
            resolve_events=False,
            event=None,
        )
    except Exception as exc:
        # Includes a missing API key (RuntimeError from build_ai_provider), a
        # disabled provider (ValueError), timeouts and SDK errors. All of them
        # are reported as an upstream problem rather than raised, so a failure
        # here can never take down the request or lose the circular.
        logger.warning(
            "[openai-extraction] circular %s failed: %s: %s",
            circular_number or "?",
            type(exc).__name__,
            exc,
        )
        return _unavailable("upstream_error", f"{type(exc).__name__}: {exc}")

    extraction = result.get("extraction") or {}
    return {
        "available": True,
        "extraction": extraction,
        "payload": result.get("payload"),
        "consistency_issues": result.get("consistency_issues") or [],
        # The package's own hints, returned so the caller can compare them
        # against the ones it already computed and stored on the circular.
        "regexp_hints": result.get("regexp_hints"),
        "source_name": result.get("source_name") or "",
        # Provenance. The model actually used may be the fallback rather than
        # the configured one, so it is read back from the extraction itself.
        "model": extraction.get("_ai_model"),
        "ai_api": extraction.get("_ai_api"),
        # Always false by construction — resolve_events=False, event=None.
        # Returned so a reader can see the guarantee rather than trust it.
        "event_resolved": bool(result.get("event_resolved")),
    }
