"""
test_openai_extraction.py
-------------------------
The OpenAI extraction is the only code path in this repository that can spend
money. These tests exist mainly to prove it cannot spend any by accident.

NO TEST HERE MAKES A NETWORK CALL. The single test that exercises the enabled
path replaces `circular_parser.parse_circular` with a stub, exactly as
circular-extraction-agent.test.ts mocks its Gemini provider on the Node side.
"""

from __future__ import annotations

import sys

import pytest

from app.gcn import openai_extraction
from app.gcn.openai_extraction import (
    ENABLED_ENV_VAR,
    extract_circular,
    openai_extraction_enabled,
)


# ── The flag itself ──────────────────────────────────────────────────────────


def test_disabled_when_unset(monkeypatch):
    monkeypatch.delenv(ENABLED_ENV_VAR, raising=False)
    assert openai_extraction_enabled() is False


@pytest.mark.parametrize(
    "value",
    ["", "false", "False", "0", "1", "yes", "TRUE ", " true", "no", "enabled"],
)
def test_only_the_exact_string_true_enables_it(monkeypatch, value):
    """
    Deliberately strict. "1" and "yes" look like an operator meant to enable
    this, but guessing at intent is how a machine starts billing by accident.
    Only the exact token the documentation specifies counts.
    """
    monkeypatch.setenv(ENABLED_ENV_VAR, value)
    assert openai_extraction_enabled() is False


def test_true_enables_it(monkeypatch):
    monkeypatch.setenv(ENABLED_ENV_VAR, "true")
    assert openai_extraction_enabled() is True


# ── THE SAFETY PROPERTY ──────────────────────────────────────────────────────


def test_no_openai_client_is_constructed_when_the_flag_is_unset(monkeypatch):
    """
    The load-bearing test of this feature.

    With the flag absent, extract_circular must return without importing
    `openai` — not "without a valid key", not "with a caught error", but
    without the module ever being loaded. `from openai import OpenAI` lives
    inside OpenAIPhotometryProvider.extract, so `openai` appearing in
    sys.modules is proof that a client construction was reached.

    An OPENAI_API_KEY is deliberately set here: a machine that happens to have
    one exported for an unrelated tool must still make no call. "No key
    present" is not the safety net — the flag is.
    """
    monkeypatch.delenv(ENABLED_ENV_VAR, raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-not-a-real-key-and-must-never-be-used")
    monkeypatch.delitem(sys.modules, "openai", raising=False)

    result = extract_circular(
        subject="GRB 210822A: Swift detection of a burst with an optical afterglow",
        body="We report optical observations. R = 18.5 mag at 0.5 days.",
        circular_number="30677",
    )

    assert result["available"] is False
    assert result["reason"] == "not_enabled"
    assert "openai" not in sys.modules, (
        "The openai module was imported despite the feature being disabled — "
        "a client was constructed and a billed call may have been attempted."
    )


def test_disabled_path_never_calls_parse_circular(monkeypatch):
    """Belt and braces: the package entry point is not reached either."""
    monkeypatch.delenv(ENABLED_ENV_VAR, raising=False)
    called = []
    monkeypatch.setattr(
        "circular_parser.parse_circular",
        lambda *a, **k: called.append(1),
        raising=False,
    )
    extract_circular(subject="s", body="b", circular_number="1")
    assert called == []


# ── The body guard ───────────────────────────────────────────────────────────
#
# parse_circular() treats a missing body as "fetch the circular from
# gcn.nasa.gov yourself" (pipeline.py:73). This guard is the only thing
# between a malformed request and an unintended outbound HTTP call, so it is
# tested with the feature ENABLED — the state in which that fetch could
# actually happen.


@pytest.mark.parametrize(
    "body", [None, "", "   ", "\n\t ", 42, [], {}],
    ids=["none", "empty", "spaces", "whitespace", "int", "list", "dict"],
)
def test_empty_body_is_refused_before_parse_circular(monkeypatch, body):
    monkeypatch.setenv(ENABLED_ENV_VAR, "true")
    called = []
    monkeypatch.setattr(
        "circular_parser.parse_circular",
        lambda *a, **k: called.append(1),
        raising=False,
    )

    result = extract_circular(subject="GRB 210822A", body=body, circular_number="30677")

    assert result["available"] is False
    assert result["reason"] == "empty_body"
    assert called == [], (
        "parse_circular was called with no body — it would have fetched the "
        "circular from gcn.nasa.gov."
    )


# ── The enabled path, fully mocked ───────────────────────────────────────────


def _fake_parse_circular(**kwargs):
    """Stands in for the package. Records how it was called."""
    _fake_parse_circular.calls.append(kwargs)
    return {
        "source_name": "GRB 210822A",
        "event_resolved": False,
        "event": None,
        "regexp_hints": {"likely_optical_followup": True},
        "extraction": {
            "observations": [{"mag": 18.5, "filter": "R"}],
            "_ai_model": "gpt-5.4-mini",
            "_ai_api": "responses",
        },
        "payload": {"source_name": "GRB 210822A"},
        "consistency_issues": [],
    }


_fake_parse_circular.calls = []


def test_enabled_path_returns_the_extraction(monkeypatch):
    monkeypatch.setenv(ENABLED_ENV_VAR, "true")
    _fake_parse_circular.calls = []
    monkeypatch.setattr("circular_parser.parse_circular", _fake_parse_circular)

    result = extract_circular(
        subject="GRB 210822A: Swift detection",
        body="We report R = 18.5 mag.",
        circular_number="30677",
        regexp_hints={"likely_optical_followup": True},
    )

    assert result["available"] is True
    assert result["extraction"]["observations"][0]["mag"] == 18.5
    assert result["model"] == "gpt-5.4-mini"
    assert result["ai_api"] == "responses"
    assert result["consistency_issues"] == []


def test_event_association_is_never_delegated_to_python(monkeypatch):
    """
    Priority #5's rule, asserted rather than trusted: Python does not decide
    which event a circular belongs to. That decision is the Node api-server's,
    made deterministically against core.events. If this test fails, a second
    and possibly disagreeing association source has been introduced.
    """
    monkeypatch.setenv(ENABLED_ENV_VAR, "true")
    _fake_parse_circular.calls = []
    monkeypatch.setattr("circular_parser.parse_circular", _fake_parse_circular)

    result = extract_circular(subject="s", body="a real body", circular_number="1")

    assert len(_fake_parse_circular.calls) == 1
    call = _fake_parse_circular.calls[0]
    assert call["resolve_events"] is False
    assert call["event"] is None
    assert result["event_resolved"] is False


def test_upstream_failure_is_reported_not_raised(monkeypatch):
    """
    A provider outage, a missing key or a timeout must not raise. The caller
    is a background worker whose retry policy needs an answer, not an
    exception that loses the job.
    """
    monkeypatch.setenv(ENABLED_ENV_VAR, "true")

    def boom(**kwargs):
        raise RuntimeError("openAI_key or OPENAI_API_KEY is required")

    monkeypatch.setattr("circular_parser.parse_circular", boom)

    result = extract_circular(subject="s", body="a real body", circular_number="1")

    assert result["available"] is False
    assert result["reason"] == "upstream_error"
    assert "OPENAI_API_KEY" in result["detail"]


def test_a_missing_parser_package_degrades_rather_than_crashing(monkeypatch):
    """The import lives inside the function precisely so this is survivable."""
    monkeypatch.setenv(ENABLED_ENV_VAR, "true")
    monkeypatch.setitem(sys.modules, "circular_parser", None)

    result = extract_circular(subject="s", body="a real body", circular_number="1")

    assert result["available"] is False
    assert result["reason"] == "upstream_error"
