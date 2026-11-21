"""Disposable prompt/source fixtures for mixed faulty and repaired checkouts."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import uuid


def prompt_digest(agent_directory: Path) -> str:
    """Load one prompt source and return its executable SYSTEM_PROMPT digest."""

    path = agent_directory / "prompt.py"
    module_name = f"_prompt_fixture_{uuid.uuid4().hex}"
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise AssertionError(f"prompt fixture cannot be imported: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    value = getattr(module, "SYSTEM_PROMPT", None)
    if not isinstance(value, str):
        raise AssertionError(f"prompt fixture has no SYSTEM_PROMPT: {path}")
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()
    if getattr(module, "PROMPT_SHA256", None) != digest:
        raise AssertionError(f"prompt fixture digest is internally inconsistent: {path}")
    return digest


def write_coherent_manifest(agent_directory: Path) -> str:
    """Update only a disposable manifest to match its executable prompt."""

    manifest_path = agent_directory / "agent-manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    digest = prompt_digest(agent_directory)
    manifest["promptSha256"] = digest
    manifest_path.write_text(json.dumps(manifest, sort_keys=True) + "\n", encoding="utf-8")
    return digest


def materialize_faulty_source(
    source_agent: Path,
    destination_root: Path,
    historical_prompt: Path,
) -> Path:
    """Copy a source tree and install the immutable historical faulty source.

    The Phase16 baseline is intentionally faulty.  The historical prompt is a
    source-controlled copy of the exact reviewed bytes, so this helper never
    relabels a current repaired prompt as faulty and does not depend on shallow
    Git history or the current repair patch.
    """

    checkout = destination_root / "faulty-checkout"
    agent_directory = checkout / "agent"
    shutil.copytree(
        source_agent,
        agent_directory,
        ignore=shutil.ignore_patterns(".venv", "__pycache__"),
    )
    source_digest = hashlib.sha256(historical_prompt.read_bytes()).hexdigest()
    if source_digest != "3d21155b9f9465a0ac11eb9fcaf761bfd19549cf6454ae3ac20c20044d57a9eb":
        raise AssertionError("historical faulty prompt source bytes do not match the reviewed descriptor")
    shutil.copy2(historical_prompt, agent_directory / "prompt.py")
    manifest = json.loads((agent_directory / "agent-manifest.json").read_bytes())
    digest = prompt_digest(agent_directory)
    expected = "161aa4357b908cffe9691349d01da284411cd5d4689235717525d79e1073fffc"
    if digest != expected:
        raise AssertionError("historical faulty prompt digest does not match the reviewed descriptor")
    if manifest.get("promptSha256") != digest:
        manifest["promptSha256"] = digest
        (agent_directory / "agent-manifest.json").write_text(
            json.dumps(manifest, sort_keys=True) + "\n", encoding="utf-8"
        )
    return agent_directory
