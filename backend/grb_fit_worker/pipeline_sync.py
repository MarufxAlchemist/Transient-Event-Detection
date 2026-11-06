"""pipeline_sync.py — runtime sync of the fermi-gbm-analysis pipeline.

THE PROBLEM
───────────
``Dockerfile.grb-fit-worker`` bakes the pipeline in at build time, pinned to
``GRB_PIPELINE_SHA``. Picking up a new commit of the pipeline has meant a
full image rebuild — ~13 minutes of heapy/bayspec/MultiNest layers nothing
about the pipeline change touches. This module lets the WORKER pull a new
commit into a release store on its own data volume and switch to it without
a rebuild, while keeping the rollback and provenance guarantees a pinned
image gave for free.

WHY THE WORKER DOES THIS, NOT THE API
──────────────────────────────────────
The worker is the only process with git, the scientific dependency stack, and
the persistent data volume. The API has none of the three. So the API only
ever writes a request row (``core.grb_pipeline_syncs``) and reads back the
worker's status; every actual filesystem and git operation below runs inside
the worker process, between fit jobs (see ``__main__.py``'s poll loop), which
is also what guarantees a sync never runs concurrently with a fit — the loop
is single-threaded and sequential, so a sync is only ever attempted in an
iteration where no fit job was claimed.

RELEASE STORE LAYOUT
─────────────────────
    $GRB_PIPELINE_RELEASES_DIR/            (default /workspace/pipeline-releases)
        releases/
            <full-sha>/                    one checkout per synced commit
            <full-sha>.tmp/                 being verified; never activated
        current -> releases/<full-sha>      swapped with os.replace(), never edited in place
        .activations.json                  ordered log of every sha this store has activated
        .baked_pins.json                   the dependency-pin snapshot the IMAGE was built with

On first run (no ``current`` symlink yet) the store is bootstrapped from the
image's own baked-in checkout at ``/opt/fermi-gbm-analysis`` (see
``Dockerfile.grb-fit-worker``), so a worker that has never synced still has a
well-formed release store pointing at the pipeline it shipped with.

THE ATOMIC SWAP
────────────────
``current`` is never edited in place. A fresh symlink is created under a
throwaway name and then moved onto ``current`` with ``os.replace()``, which
is an atomic rename on POSIX — any reader (a job calling
``resolve_active_release()``) sees either the old target or the new one,
never a half-written symlink. The release directory itself is populated
under a ``.tmp`` suffix and only ``os.rename()``'d into its final
``releases/<sha>`` name after every check below has passed, so a release
directory under its real name is, by construction, one that was fully
verified.

SYNC = FETCH -> VERIFY -> ACTIVATE, ALL OR NOTHING
────────────────────────────────────────────────────
  (a) fetch ``GRB_PIPELINE_REF`` to a temp checkout, resolve the full SHA.
  (b) already a release under that SHA -> "already up to date", no-op.
  (c) dependency-pin gate: the fetched checkout's own pin manifest is diffed
      against the snapshot the running image was built with. A changed pin
      means the new commit needs dependencies this image does not have, and
      no amount of worker-side cleverness substitutes for an image rebuild —
      refuse with ``needs_image_rebuild`` and name exactly what changed.
  (d) contract check: ``python scripts/check_integration.py --json`` is run
      as a SUBPROCESS from inside the fetched checkout, never imported into
      this process — the fetched code is untrusted until it has passed this
      check, so it never runs inside the worker's own interpreter before
      that. Missing the script refuses the sync (``contract_check_missing``)
      unless ``GRB_PIPELINE_ALLOW_NO_CONTRACT=1``.
  (e) only once (c) and (d) both pass does the atomic swap happen. Any
      failure before that point leaves ``current`` untouched and deletes the
      temp checkout — the store is always left exactly as it was found.

PROVENANCE
──────────
``resolve_active_release()`` / ``activate_for_job()`` are the only sanctioned
way the rest of the worker learns which pipeline is active — read fresh at
JOB START, not at import time, so a sync that landed between two jobs takes
effect on the very next claim without a process restart. Cached
``pipeline.*`` submodules are evicted from ``sys.modules`` before each job so
a changed release is actually re-imported rather than silently reusing
whatever an earlier job happened to load first.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

LOG = logging.getLogger("grb-fit-worker.pipeline_sync")

_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
_PIN_RE = re.compile(r"^\s*([A-Za-z0-9_.\-]+)\s*==\s*([A-Za-z0-9_.\-+]+)\s*$")
_PIN_MANIFEST_CANDIDATES = ("requirements.txt", "environment.yml", "pyproject.toml")

CONTRACT_SCRIPT_RELPATH = ("scripts", "check_integration.py")

# ── Statuses a SyncResult / SyncError can carry ──────────────────────────────
STATUS_ACTIVATED = "activated"
STATUS_ROLLED_BACK = "rolled_back"
STATUS_UP_TO_DATE = "up_to_date"
STATUS_NEEDS_IMAGE_REBUILD = "needs_image_rebuild"
STATUS_CONTRACT_CHECK_MISSING = "contract_check_missing"
STATUS_CONTRACT_CHECK_FAILED = "contract_check_failed"
STATUS_FETCH_FAILED = "fetch_failed"
STATUS_UNKNOWN_SHA = "unknown_sha"
STATUS_NO_PREVIOUS_RELEASE = "no_previous_release"
STATUS_CONFIG_ERROR = "config_error"
STATUS_SYNC_FAILED = "sync_failed"


# ── Config (env only — see Part 2 of the design) ────────────────────────────


def releases_dir() -> Path:
    return Path(os.environ.get("GRB_PIPELINE_RELEASES_DIR", "/workspace/pipeline-releases"))


def _baked_pipeline_dir() -> Path:
    # Overridable only so tests can point it at a fixture; never meant to
    # change in production, where the image always bakes it at this path.
    return Path(os.environ.get("GRB_PIPELINE_BAKED_DIR", "/opt/fermi-gbm-analysis"))


def _repo_url() -> str | None:
    return os.environ.get("GRB_PIPELINE_REPO_URL") or None


def _ref() -> str:
    return os.environ.get("GRB_PIPELINE_REF", "main")


def _token() -> str | None:
    # Read fresh every time, never cached on an object that might get logged
    # or serialised by accident.
    return os.environ.get("GRB_PIPELINE_GIT_TOKEN") or None


def _keep_count() -> int:
    try:
        return max(int(os.environ.get("GRB_PIPELINE_KEEP", "5")), 0)
    except ValueError:
        return 5


def _allow_no_contract() -> bool:
    return (os.environ.get("GRB_PIPELINE_ALLOW_NO_CONTRACT") or "").strip() in ("1", "true", "True", "yes")


def _contract_timeout_seconds() -> float:
    try:
        return float(os.environ.get("GRB_PIPELINE_CONTRACT_TIMEOUT_SECONDS", "60"))
    except ValueError:
        return 60.0


def _fetch_timeout_seconds() -> float:
    try:
        return float(os.environ.get("GRB_PIPELINE_FETCH_TIMEOUT_SECONDS", "120"))
    except ValueError:
        return 120.0


def current_symlink(base: Path | None = None) -> Path:
    return (base or releases_dir()) / "current"


def _releases_root(base: Path) -> Path:
    return base / "releases"


def _activation_log_path(base: Path) -> Path:
    return base / ".activations.json"


def _baked_pins_snapshot_path(base: Path) -> Path:
    return base / ".baked_pins.json"


# ── Token redaction — never let a secret reach a log line or an exception ───


def _redact(text: str | None, token: str | None) -> str:
    """Strip a known secret out of a string before it is logged or raised.

    Applied to every piece of subprocess output and every exception message
    that could possibly have touched an authenticated URL. The token itself
    is never written to the release store, never included in a SyncResult,
    and never passed to a child process via its environment (see
    ``_subprocess_env``) — only embedded transiently into the URL argv of the
    one `git` invocation that needs it.
    """
    if not text:
        return text or ""
    if token:
        text = text.replace(token, "***REDACTED***")
    return text


def _subprocess_env() -> dict[str, str]:
    env = dict(os.environ)
    env.pop("GRB_PIPELINE_GIT_TOKEN", None)
    return env


def _authed_url(repo_url: str, token: str | None) -> str:
    """Embed the token into an HTTPS URL for this one `git` call only.

    Never logged, never stored — callers only ever see ``repo_url`` (the
    unauthenticated form) in SyncResult, log lines and exceptions.
    """
    if token and repo_url.startswith("https://"):
        scheme, rest = repo_url.split("://", 1)
        return f"{scheme}://x-access-token:{token}@{rest}"
    return repo_url


# ── Errors / results ──────────────────────────────────────────────────────


class SyncError(Exception):
    """A sync or rollback could not complete.

    ``status`` is the stable, machine-readable reason (one of the STATUS_*
    constants above) — the thing the API records on
    ``core.grb_pipeline_syncs.status`` and the frontend branches its message
    on. ``details`` carries structured context (e.g. the changed pins) for
    callers that want more than the string.
    """

    def __init__(self, status: str, message: str, details: dict | None = None):
        super().__init__(message)
        self.status = status
        self.details = details or {}


@dataclass(frozen=True)
class SyncResult:
    status: str
    from_sha: str | None
    to_sha: str | None
    message: str


# ── Release store primitives ─────────────────────────────────────────────


def get_active_sha(base: Path | None = None) -> str | None:
    base = base or releases_dir()
    link = current_symlink(base)
    if not link.is_symlink():
        return None
    return Path(os.readlink(link)).name


def get_active_release_dir(base: Path | None = None) -> Path | None:
    base = base or releases_dir()
    link = current_symlink(base)
    if not link.is_symlink():
        return None
    resolved = link.resolve()
    return resolved if resolved.is_dir() else None


def known_shas(base: Path | None = None) -> set[str]:
    base = base or releases_dir()
    root = _releases_root(base)
    if not root.is_dir():
        return set()
    return {p.name for p in root.iterdir() if p.is_dir() and not p.name.endswith(".tmp")}


def _read_activation_log(base: Path) -> list[dict]:
    path = _activation_log_path(base)
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def _append_activation(base: Path, sha: str) -> None:
    log = _read_activation_log(base)
    log.append({"sha": sha, "activated_at": time.time()})
    _activation_log_path(base).write_text(json.dumps(log), encoding="utf-8")


def get_previous_sha(base: Path | None = None) -> str | None:
    """The sha active immediately before the current one, or None.

    Read from the activation log rather than guessed from directory mtimes,
    so it survives a release directory being touched (e.g. by a backup tool)
    without the log itself changing.
    """
    base = base or releases_dir()
    current = get_active_sha(base)
    for entry in reversed(_read_activation_log(base)):
        sha = entry.get("sha")
        if sha and sha != current:
            return sha
    return None


def _new_tmp_symlink_path(base: Path, tag: str) -> Path:
    return base / f".current.tmp-{tag}-{os.getpid()}-{int(time.time() * 1_000_000)}"


def _swap_current(base: Path, sha: str) -> None:
    """Atomically repoint ``current`` at ``releases/<sha>``."""
    rel_target = os.path.join("releases", sha)
    tmp_link = _new_tmp_symlink_path(base, "swap")
    if tmp_link.exists() or tmp_link.is_symlink():
        tmp_link.unlink()
    os.symlink(rel_target, tmp_link)
    os.replace(str(tmp_link), str(current_symlink(base)))
    _append_activation(base, sha)


# ── Dependency-pin gate ──────────────────────────────────────────────────


def _read_pins(release_dir: Path) -> dict[str, str]:
    """Pinned ``package==version`` entries from the release's own manifest.

    Tries each candidate filename in order and stops at the first that
    exists — the pipeline repo is expected to ship exactly one of these.
    Absent any manifest, returns {} rather than guessing, which makes the
    pin gate a no-op for a release that declares no pins rather than a false
    positive.
    """
    for name in _PIN_MANIFEST_CANDIDATES:
        candidate = release_dir / name
        if candidate.is_file():
            pins: dict[str, str] = {}
            for line in candidate.read_text(encoding="utf-8", errors="replace").splitlines():
                match = _PIN_RE.match(line.split("#", 1)[0])
                if match:
                    pins[match.group(1).lower()] = match.group(2)
            return pins
    return {}


def _load_or_init_baked_pins(base: Path, baked_release_dir: Path) -> dict[str, str]:
    """The pin snapshot the running image was built with.

    Computed once, at bootstrap, from the baked checkout, and cached to disk
    so a later sync compares against what THIS image actually shipped with
    rather than re-deriving it from whatever happens to be the active release
    at comparison time (which, after a few syncs, would no longer be the
    baked one).
    """
    snapshot_path = _baked_pins_snapshot_path(base)
    if snapshot_path.is_file():
        try:
            return json.loads(snapshot_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass
    pins = _read_pins(baked_release_dir)
    snapshot_path.write_text(json.dumps(pins, sort_keys=True), encoding="utf-8")
    return pins


def _load_baked_pins(base: Path) -> dict[str, str]:
    snapshot_path = _baked_pins_snapshot_path(base)
    if not snapshot_path.is_file():
        return {}
    try:
        return json.loads(snapshot_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _diff_pins(baked: dict[str, str], fetched: dict[str, str]) -> dict[str, dict[str, str | None]]:
    """Pins that differ between the image's snapshot and the fetched release.

    Symmetric: a pin added, removed or changed in either direction is
    reported — all three mean the fetched commit's dependency needs no
    longer match what was `pip install`-ed into this image.
    """
    changed: dict[str, dict[str, str | None]] = {}
    for pkg, version in baked.items():
        fetched_version = fetched.get(pkg)
        if fetched_version != version:
            changed[pkg] = {"baked": version, "fetched": fetched_version}
    for pkg, fetched_version in fetched.items():
        if pkg not in baked:
            changed[pkg] = {"baked": None, "fetched": fetched_version}
    return changed


# ── Contract check — subprocess only, never imported ─────────────────────


def _run_contract_check(release_dir: Path, token: str | None) -> None:
    script = release_dir.joinpath(*CONTRACT_SCRIPT_RELPATH)
    if not script.is_file():
        if _allow_no_contract():
            LOG.warning(
                "contract check script missing at %s; proceeding because "
                "GRB_PIPELINE_ALLOW_NO_CONTRACT is set",
                script,
            )
            return
        raise SyncError(
            STATUS_CONTRACT_CHECK_MISSING,
            f"{'/'.join(CONTRACT_SCRIPT_RELPATH)} not found in the fetched release; "
            "refusing to activate it without a contract check. Set "
            "GRB_PIPELINE_ALLOW_NO_CONTRACT=1 to override.",
        )

    try:
        proc = subprocess.run(
            [sys.executable, str(script), "--json"],
            cwd=str(release_dir),
            capture_output=True,
            text=True,
            timeout=_contract_timeout_seconds(),
            env=_subprocess_env(),
        )
    except subprocess.TimeoutExpired as exc:
        raise SyncError(
            STATUS_CONTRACT_CHECK_FAILED,
            _redact(f"contract check timed out after {_contract_timeout_seconds():.0f}s", token),
        ) from exc

    if proc.returncode != 0:
        output = _redact((proc.stdout or "") + "\n" + (proc.stderr or ""), token).strip()
        raise SyncError(
            STATUS_CONTRACT_CHECK_FAILED,
            f"contract check exited {proc.returncode}: {output[:4000]}",
        )


# ── git fetch ──────────────────────────────────────────────────────────


def _fetch_ref(repo_url: str, ref: str, token: str | None, work_dir: Path) -> tuple[str, Path]:
    """Clone ``ref`` into a fresh checkout under ``work_dir``. Returns (sha, checkout_dir)."""
    checkout_dir = work_dir / "checkout"
    authed = _authed_url(repo_url, token)
    try:
        subprocess.run(
            [
                "git", "clone", "--quiet",
                "--branch", ref, "--single-branch", "--depth", "1",
                authed, str(checkout_dir),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=_fetch_timeout_seconds(),
            env=_subprocess_env(),
        )
    except subprocess.CalledProcessError as exc:
        raise SyncError(STATUS_FETCH_FAILED, _redact(f"git clone failed: {exc.stderr}", token)) from exc
    except subprocess.TimeoutExpired as exc:
        raise SyncError(STATUS_FETCH_FAILED, _redact("git clone timed out", token)) from exc

    try:
        rev_parse = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(checkout_dir),
            check=True,
            capture_output=True,
            text=True,
            env=_subprocess_env(),
        )
    except subprocess.CalledProcessError as exc:
        raise SyncError(STATUS_FETCH_FAILED, _redact(f"could not resolve HEAD: {exc.stderr}", token)) from exc

    sha = rev_parse.stdout.strip()
    if not _SHA_RE.match(sha):
        raise SyncError(STATUS_FETCH_FAILED, f"unexpected SHA format from git rev-parse: {sha!r}")

    # The checkout becomes a release directory; it carries no .git history —
    # releases are inert snapshots, matching how the image's own baked
    # checkout is stripped in Dockerfile.grb-fit-worker.
    shutil.rmtree(checkout_dir / ".git", ignore_errors=True)
    return sha, checkout_dir


# ── Bootstrap ──────────────────────────────────────────────────────────


def _bootstrap_if_needed(base: Path) -> None:
    """Populate the release store from the image's baked checkout, once.

    A no-op whenever ``current`` already exists — including on every call
    after the first, so this is safe to call at the top of every sync,
    rollback and job-start resolution.
    """
    _releases_root(base).mkdir(parents=True, exist_ok=True)
    link = current_symlink(base)
    if link.is_symlink() or link.exists():
        return

    baked_dir = _baked_pipeline_dir()
    if not baked_dir.is_dir():
        raise SyncError(
            STATUS_SYNC_FAILED,
            f"no release is active and the baked pipeline directory {baked_dir} "
            "does not exist — the image is missing its own pipeline checkout",
        )

    baked_sha = os.environ.get("GRB_PIPELINE_VERSION") or ""
    if not _SHA_RE.match(baked_sha):
        baked_sha = "baked-" + str(abs(hash(str(baked_dir))))[:12]

    dest = _releases_root(base) / baked_sha
    if not dest.is_dir():
        tmp_dest = _releases_root(base) / f"{baked_sha}.tmp"
        shutil.rmtree(tmp_dest, ignore_errors=True)
        shutil.copytree(baked_dir, tmp_dest)
        os.rename(tmp_dest, dest)

    _swap_current(base, baked_sha)
    _load_or_init_baked_pins(base, dest)
    LOG.info("bootstrapped pipeline release store from %s at %s", baked_dir, baked_sha)


# ── Retention ──────────────────────────────────────────────────────────


def _prune_old_releases(base: Path) -> None:
    """Delete releases beyond the last N activations — active/previous exempt."""
    root = _releases_root(base)
    if not root.is_dir():
        return

    log = _read_activation_log(base)
    most_recent_first: list[str] = []
    for entry in reversed(log):
        sha = entry.get("sha")
        if sha and sha not in most_recent_first:
            most_recent_first.append(sha)

    active = get_active_sha(base)
    previous = get_previous_sha(base)
    protected = {sha for sha in (active, previous) if sha}
    keep = set(most_recent_first[: _keep_count()]) | protected

    for child in root.iterdir():
        if not child.is_dir() or child.name.endswith(".tmp"):
            continue
        if child.name in keep:
            continue
        shutil.rmtree(child, ignore_errors=True)


# ── Job-start resolution ─────────────────────────────────────────────────


def resolve_active_release(base: Path | None = None) -> tuple[Path | None, str | None]:
    """The release a job claimed right now should run against.

    Bootstraps the store if this is the very first call. Reads ``current``
    fresh every time — callers must not cache the result across jobs.
    """
    base = base or releases_dir()
    _bootstrap_if_needed(base)
    return get_active_release_dir(base), get_active_sha(base)


def current_pipeline_sha(base: Path | None = None) -> str | None:
    """Convenience wrapper: bootstrap, then just the sha (for stamping a claimed job)."""
    _, sha = resolve_active_release(base)
    return sha


@contextmanager
def activate_for_job(base: Path | None = None) -> Iterator[str | None]:
    """Put the active release first on ``sys.path`` for the duration of one job.

    Evicts any cached ``pipeline.*`` modules first, so a release that changed
    between jobs is actually re-imported rather than silently reusing
    whatever an earlier job already loaded into ``sys.modules``. Restores
    ``sys.path`` on exit regardless of how the job ended.
    """
    release_dir, sha = resolve_active_release(base)
    if release_dir is None:
        yield None
        return

    release_str = str(release_dir)
    inserted = release_str not in sys.path
    if inserted:
        sys.path.insert(0, release_str)
    for name in list(sys.modules):
        if name == "pipeline" or name.startswith("pipeline."):
            del sys.modules[name]
    try:
        yield sha
    finally:
        if inserted:
            try:
                sys.path.remove(release_str)
            except ValueError:
                pass


# ── Sync ─────────────────────────────────────────────────────────────────


def sync_pipeline(base: Path | None = None) -> SyncResult:
    """Fetch GRB_PIPELINE_REF, verify it, and activate it. All-or-nothing.

    Raises SyncError for every refusal (already covers "nothing to do" via
    STATUS_UP_TO_DATE, which is returned as a SyncResult, not an error).
    """
    base = base or releases_dir()
    repo_url = _repo_url()
    if not repo_url:
        raise SyncError(STATUS_CONFIG_ERROR, "GRB_PIPELINE_REPO_URL is not set")
    ref = _ref()
    token = _token()

    _bootstrap_if_needed(base)
    from_sha = get_active_sha(base)

    with tempfile.TemporaryDirectory(prefix="grb-pipeline-fetch-", dir=str(base)) as tmp:
        sha, checkout_dir = _fetch_ref(repo_url, ref, token, Path(tmp))

        releases_root = _releases_root(base)
        releases_root.mkdir(parents=True, exist_ok=True)
        final_dir = releases_root / sha

        if final_dir.is_dir():
            return SyncResult(
                status=STATUS_UP_TO_DATE,
                from_sha=from_sha,
                to_sha=sha,
                message=f"{sha} is already the release at ref {ref!r}; nothing to do",
            )

        tmp_release = releases_root / f"{sha}.tmp"
        shutil.rmtree(tmp_release, ignore_errors=True)
        shutil.move(str(checkout_dir), str(tmp_release))

        try:
            baked_pins = _load_baked_pins(base)
            fetched_pins = _read_pins(tmp_release)
            changed = _diff_pins(baked_pins, fetched_pins)
            if changed:
                raise SyncError(
                    STATUS_NEEDS_IMAGE_REBUILD,
                    "fetched commit changes pinned dependencies relative to this "
                    f"image's build snapshot: {sorted(changed)}; rebuild the worker "
                    "image before activating this release",
                    details={"changed_pins": changed},
                )

            _run_contract_check(tmp_release, token)

            os.rename(tmp_release, final_dir)
            _swap_current(base, sha)
        except SyncError:
            shutil.rmtree(tmp_release, ignore_errors=True)
            raise
        except OSError as exc:
            shutil.rmtree(tmp_release, ignore_errors=True)
            raise SyncError(STATUS_SYNC_FAILED, _redact(str(exc), token)) from exc

    _prune_old_releases(base)
    return SyncResult(
        status=STATUS_ACTIVATED,
        from_sha=from_sha,
        to_sha=sha,
        message=f"activated {sha} (ref {ref!r})",
    )


# ── Rollback ────────────────────────────────────────────────────────────


def rollback(target_sha: str | None = None, base: Path | None = None) -> SyncResult:
    """Repoint ``current`` at ``target_sha``, or the previous release if None.

    Refuses any ``target_sha`` that is not a release this store already has
    on disk — rollback never fetches, it only repoints among what has already
    passed the pin gate and contract check once before.
    """
    base = base or releases_dir()
    _bootstrap_if_needed(base)
    current = get_active_sha(base)

    if target_sha is None:
        target_sha = get_previous_sha(base)
        if target_sha is None:
            raise SyncError(STATUS_NO_PREVIOUS_RELEASE, "no previous release to roll back to")
    elif target_sha not in known_shas(base):
        raise SyncError(
            STATUS_UNKNOWN_SHA,
            f"{target_sha} is not a release this worker holds locally; refusing to roll back to it",
        )

    if target_sha == current:
        return SyncResult(
            status=STATUS_UP_TO_DATE,
            from_sha=current,
            to_sha=target_sha,
            message=f"{target_sha} is already active",
        )

    _swap_current(base, target_sha)
    _prune_old_releases(base)
    return SyncResult(
        status=STATUS_ROLLED_BACK,
        from_sha=current,
        to_sha=target_sha,
        message=f"rolled back to {target_sha}",
    )


# ── Status (read-only snapshot for the worker loop / diagnostics) ────────


def status(base: Path | None = None) -> dict:
    base = base or releases_dir()
    _bootstrap_if_needed(base)
    return {
        "current_sha": get_active_sha(base),
        "previous_sha": get_previous_sha(base),
        "known_shas": sorted(known_shas(base)),
        "releases_dir": str(base),
    }
