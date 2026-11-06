import json
import subprocess
import sys
from pathlib import Path

import pytest

from grb_fit_worker import pipeline_sync as ps

_PASSING_CONTRACT = """\
import json
print(json.dumps({"ok": True}))
"""

_FAILING_CONTRACT = """\
import sys
sys.exit(1)
"""

_BAKED_PINS = "bayspec==0.3.14\nastropy==6.0.0\n"


def _run_git(args, cwd):
    subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True)


def _init_bare_repo(tmp_path):
    bare = tmp_path / "pipeline.git"
    bare.mkdir()
    _run_git(["init", "--bare", "--initial-branch=main", str(bare)], tmp_path)
    return bare


def _commit_to_repo(bare, work, *, requirements=None, contract_script=None, extra_files=None, remove=None):
    if not work.exists():
        work.mkdir(parents=True)
        _run_git(["clone", str(bare), str(work)], work.parent)
        _run_git(["config", "user.email", "test@example.com"], work)
        _run_git(["config", "user.name", "Test"], work)

    for path in remove or []:
        target = work / path
        if target.exists():
            target.unlink()

    if requirements is not None:
        (work / "requirements.txt").write_text(requirements, encoding="utf-8")
    if contract_script is not None:
        scripts_dir = work / "scripts"
        scripts_dir.mkdir(exist_ok=True)
        (scripts_dir / "check_integration.py").write_text(contract_script, encoding="utf-8")
    for relpath, content in (extra_files or {}).items():
        full = work / relpath
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(content, encoding="utf-8")

    _run_git(["add", "-A"], work)
    _run_git(["commit", "--allow-empty", "-m", "commit"], work)
    _run_git(["push", "origin", "HEAD:main"], work)
    sha = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=str(work), check=True, capture_output=True, text=True
    ).stdout.strip()
    return sha


@pytest.fixture
def env(tmp_path, monkeypatch):
    releases = tmp_path / "releases"
    baked = tmp_path / "baked"
    baked.mkdir()
    (baked / "requirements.txt").write_text(_BAKED_PINS, encoding="utf-8")
    scripts_dir = baked / "scripts"
    scripts_dir.mkdir()
    (scripts_dir / "check_integration.py").write_text(_PASSING_CONTRACT, encoding="utf-8")

    bare = _init_bare_repo(tmp_path)
    work = tmp_path / "work"
    _commit_to_repo(
        bare, work,
        requirements=_BAKED_PINS,
        contract_script=_PASSING_CONTRACT,
    )

    monkeypatch.setenv("GRB_PIPELINE_RELEASES_DIR", str(releases))
    monkeypatch.setenv("GRB_PIPELINE_BAKED_DIR", str(baked))
    monkeypatch.setenv("GRB_PIPELINE_REPO_URL", str(bare))
    monkeypatch.setenv("GRB_PIPELINE_REF", "main")
    monkeypatch.setenv("GRB_PIPELINE_VERSION", "f" * 40)
    monkeypatch.delenv("GRB_PIPELINE_GIT_TOKEN", raising=False)
    monkeypatch.delenv("GRB_PIPELINE_ALLOW_NO_CONTRACT", raising=False)

    return {"releases": releases, "baked": baked, "bare": bare, "work": work}


def test_sync_success_activates_fetched_commit(env):
    sha = _commit_to_repo(
        env["bare"], env["work"],
        requirements=_BAKED_PINS, contract_script=_PASSING_CONTRACT,
    )
    result = ps.sync_pipeline()
    assert result.status == ps.STATUS_ACTIVATED
    assert result.to_sha == sha
    assert ps.get_active_sha() == sha


def test_bootstrap_happens_automatically_before_first_sync(env):
    assert not ps.current_symlink().exists()
    ps.sync_pipeline()
    assert ps.current_symlink().is_symlink()


def test_sync_twice_is_up_to_date_second_time(env):
    ps.sync_pipeline()
    second = ps.sync_pipeline()
    assert second.status == ps.STATUS_UP_TO_DATE


def test_pin_change_is_refused_as_needs_image_rebuild(env):
    _commit_to_repo(
        env["bare"], env["work"],
        requirements="bayspec==0.4.0\nastropy==6.0.0\n",
        contract_script=_PASSING_CONTRACT,
    )
    with pytest.raises(ps.SyncError) as excinfo:
        ps.sync_pipeline()
    assert excinfo.value.status == ps.STATUS_NEEDS_IMAGE_REBUILD
    assert excinfo.value.details["changed_pins"]["bayspec"] == {"baked": "0.3.14", "fetched": "0.4.0"}


def test_contract_check_failure_is_refused(env):
    _commit_to_repo(
        env["bare"], env["work"],
        requirements=_BAKED_PINS, contract_script=_FAILING_CONTRACT,
    )
    with pytest.raises(ps.SyncError) as excinfo:
        ps.sync_pipeline()
    assert excinfo.value.status == ps.STATUS_CONTRACT_CHECK_FAILED


def test_contract_check_missing_is_refused_by_default(env):
    _commit_to_repo(
        env["bare"], env["work"],
        requirements=_BAKED_PINS,
        extra_files={"scripts/.gitkeep": ""},
        remove=["scripts/check_integration.py"],
    )
    with pytest.raises(ps.SyncError) as excinfo:
        ps.sync_pipeline()
    assert excinfo.value.status == ps.STATUS_CONTRACT_CHECK_MISSING


def test_contract_check_missing_allowed_with_override(env, monkeypatch):
    monkeypatch.setenv("GRB_PIPELINE_ALLOW_NO_CONTRACT", "1")
    sha = _commit_to_repo(
        env["bare"], env["work"],
        requirements=_BAKED_PINS,
        extra_files={"scripts/.gitkeep": ""},
        remove=["scripts/check_integration.py"],
    )
    result = ps.sync_pipeline()
    assert result.status == ps.STATUS_ACTIVATED
    assert result.to_sha == sha


def test_failure_leaves_current_and_store_untouched(env):
    ps.sync_pipeline()
    before = ps.get_active_sha()
    before_known = ps.known_shas()
    _commit_to_repo(
        env["bare"], env["work"],
        requirements="bayspec==0.4.0\nastropy==6.0.0\n",
        contract_script=_PASSING_CONTRACT,
    )
    with pytest.raises(ps.SyncError):
        ps.sync_pipeline()
    assert ps.get_active_sha() == before
    assert ps.known_shas() == before_known


def test_rollback_to_previous(env):
    first = ps.sync_pipeline().to_sha
    _commit_to_repo(env["bare"], env["work"], requirements=_BAKED_PINS, contract_script=_PASSING_CONTRACT)
    ps.sync_pipeline()
    result = ps.rollback()
    assert result.status == ps.STATUS_ROLLED_BACK
    assert result.to_sha == first
    assert ps.get_active_sha() == first


def test_rollback_to_explicit_known_sha(env):
    first = ps.sync_pipeline().to_sha
    _commit_to_repo(env["bare"], env["work"], requirements=_BAKED_PINS, contract_script=_PASSING_CONTRACT)
    ps.sync_pipeline()
    result = ps.rollback(target_sha=first)
    assert result.to_sha == first


def test_rollback_to_unknown_sha_is_rejected(env):
    ps.sync_pipeline()
    with pytest.raises(ps.SyncError) as excinfo:
        ps.rollback(target_sha="a" * 40)
    assert excinfo.value.status == ps.STATUS_UNKNOWN_SHA


def test_rollback_with_no_previous_release_is_rejected(env):
    ps.resolve_active_release()
    with pytest.raises(ps.SyncError) as excinfo:
        ps.rollback()
    assert excinfo.value.status == ps.STATUS_NO_PREVIOUS_RELEASE


def test_retention_keeps_active_and_previous_even_below_keep_count(env, monkeypatch):
    monkeypatch.setenv("GRB_PIPELINE_KEEP", "1")
    first = ps.sync_pipeline().to_sha
    _commit_to_repo(env["bare"], env["work"], requirements=_BAKED_PINS, contract_script=_PASSING_CONTRACT)
    second = ps.sync_pipeline().to_sha
    known = ps.known_shas()
    assert first in known
    assert second in known


def test_retention_keeps_more_than_keep_count_when_requested(env, monkeypatch):
    monkeypatch.setenv("GRB_PIPELINE_KEEP", "5")
    shas = [ps.sync_pipeline().to_sha]
    for _ in range(3):
        _commit_to_repo(env["bare"], env["work"], requirements=_BAKED_PINS, contract_script=_PASSING_CONTRACT)
        shas.append(ps.sync_pipeline().to_sha)
    known = ps.known_shas()
    assert set(shas).issubset(known)


def test_token_never_appears_in_sync_result_or_exception(env, monkeypatch):
    token = "sekrit-token-value"
    monkeypatch.setenv("GRB_PIPELINE_GIT_TOKEN", token)
    result = ps.sync_pipeline()
    assert token not in result.message
    assert token not in (result.from_sha or "")
    assert token not in (result.to_sha or "")


def test_token_is_redacted_from_subprocess_failure_output(env, monkeypatch, tmp_path):
    token = "sekrit-token-value"
    monkeypatch.setenv("GRB_PIPELINE_GIT_TOKEN", token)
    monkeypatch.setenv("GRB_PIPELINE_REPO_URL", f"https://{tmp_path}/does-not-exist.git")
    with pytest.raises(ps.SyncError) as excinfo:
        ps.sync_pipeline()
    assert token not in str(excinfo.value)
    assert excinfo.value.status == ps.STATUS_FETCH_FAILED


def test_redact_strips_literal_token_from_text(env):
    token = "sekrit-token-value"
    text = f"failed to clone https://x-access-token:{token}@example.com/repo.git"
    redacted = ps._redact(text, token)
    assert token not in redacted
    assert "***REDACTED***" in redacted


def test_subprocess_env_never_carries_the_token(env, monkeypatch):
    monkeypatch.setenv("GRB_PIPELINE_GIT_TOKEN", "sekrit-token-value")
    sub_env = ps._subprocess_env()
    assert "GRB_PIPELINE_GIT_TOKEN" not in sub_env


def test_sync_without_repo_url_is_a_config_error(env, monkeypatch):
    monkeypatch.delenv("GRB_PIPELINE_REPO_URL", raising=False)
    with pytest.raises(ps.SyncError) as excinfo:
        ps.sync_pipeline()
    assert excinfo.value.status == ps.STATUS_CONFIG_ERROR


def test_activate_for_job_puts_release_on_sys_path_and_restores_it(env):
    ps.sync_pipeline()
    release_dir = ps.get_active_release_dir()
    with ps.activate_for_job() as sha:
        assert sha == ps.get_active_sha()
        assert str(release_dir) in sys.path
    assert str(release_dir) not in sys.path


def test_activate_for_job_evicts_cached_pipeline_modules(env):
    ps.sync_pipeline()
    sys.modules["pipeline"] = object()
    sys.modules["pipeline.fitting"] = object()
    with ps.activate_for_job():
        assert "pipeline" not in sys.modules
        assert "pipeline.fitting" not in sys.modules


def test_activate_for_job_picks_up_a_sync_between_jobs(env):
    first = ps.sync_pipeline().to_sha
    with ps.activate_for_job() as sha:
        assert sha == first
    _commit_to_repo(env["bare"], env["work"], requirements=_BAKED_PINS, contract_script=_PASSING_CONTRACT)
    second = ps.sync_pipeline().to_sha
    with ps.activate_for_job() as sha:
        assert sha == second
