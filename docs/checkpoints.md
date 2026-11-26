# Talk checkpoints

A checkpoint identifies the source you can open and edit in the browser IDE. The
live agent selection and the editable workspace are independent: opening S3 or
S4 does not change which candidate receives a later alarm.

The [map on `main`](../talk/checkpoints.json) lists each annotated tag in
`talk/v5` and the commit it points to. The frozen stage sources are public;
case files, trace exports, credentials, and rehearsal records are not.
Follow the public case flow in [the attendee guide](attendee-guide.md).

The READMEs at frozen tags may describe an earlier plan and are reference-only;
do not treat frozen-tag code or results as current dataset, roster, or gate
proof. In the current talk,
S1 publishes the reviewed AgentCore dataset version, S2 scores the original
trace, S3/S4 provide development feedback, and S5 qualifies the exact ZIP for
release.

| Stage | Source link | What you open | What you do |
| --- | --- | --- |
| S0 | [talk/v5/S0](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S0) | Instrumented faulty agent | Inspect the source. Select the faulty endpoint in the controller to send the next alarm to that agent. |
| S1 | [talk/v5/S1](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S1) | Native trace and dataset case | Add the trace to a fixed dataset, review the prose and typed recommendation in the draft, and create a published version. |
| S2 | [talk/v5/S2](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S2) | Published case and original report | Download `examples[0]` and score the recorded report with `Builtin.Correctness`; do not rerun the agent. |
| S3 | [talk/v5/S3](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S3) | Repaired prompt and selected case | Run a fresh candidate against the same case/evidence bridge. |
| S4 | [talk/v5/S4](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S4) | Native Strands experiment | Run the current native denial case plus four retained reviewed cases with their case/evidence bridges. |
| S5 | [talk/v5/S5](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S5) | Release gate | Run CI against the exact ZIP proposed for release. |

For the streaming IDE edit and Strands experiment, use the v5 S3 and S4 sources with their own lockfiles. Both pin `strands-agents==1.65.0`. The saved-report example on `main` uses the dependency lock from its own checkout. [S4 dependencies](https://github.com/guilleojeda/evaluations-ref-arch/blob/1f67f305104e9d9c74a7919cf0f968622d1d0c01/agent/pyproject.toml)

For S0-S4, start each workspace at its mapped commit. S5 may be newer than
the frozen tag when CI evaluates a proposed release. Keep the exact package
identity with the CI result; do not use a development trace or a later live
row as release evidence.

Before a maintainer publishes a generation, you can check the proposed map locally. This command checks that all six stages have a tag name and a commit ID. Publishing tags is a separate maintainer step.

```sh
jq -e '
  .schemaVersion == 1
  and (.generation | type == "string" and length > 0)
  and ((.checkpoints | keys) == ["S0", "S1", "S2", "S3", "S4", "S5"])
  and all(.checkpoints[]; (.tag | type == "string" and length > 0)
    and (.commit | test("^[0-9a-f]{40}$")))
' talk/checkpoints.json >/dev/null
```

## Check the published generation

After publication, run this from `main` to compare the local tags, the remote tags and the map. If a local tag conflicts with the remote, compare them from a clean clone before proceeding.

```sh
export TALK_GENERATION="${TALK_GENERATION:?set the map generation, for example talk/v5}"
generation="$TALK_GENERATION"
git fetch origin "refs/tags/${generation}/*:refs/tags/${generation}/*"
python3 - <<'PY'
import json
import os
import subprocess
from pathlib import Path

document = json.loads(Path("talk/checkpoints.json").read_text())
generation = os.environ["TALK_GENERATION"]
if document.get("generation") != generation:
    raise SystemExit("the map generation does not match TALK_GENERATION")
stages = document["checkpoints"]
if set(stages) != {f"S{n}" for n in range(6)}:
    raise SystemExit("The map must identify all six stages.")
for stage, source in sorted(stages.items()):
    ref = "refs/tags/" + source["tag"]
    if source["tag"] != f"{generation}/{stage}":
        raise SystemExit(f"{stage}: tag is outside the selected generation")
    def git(*args):
        return subprocess.check_output(["git", *args], text=True).strip()
    actual = git("rev-parse", "--verify", f"{ref}^{{commit}}")
    remote = git("ls-remote", "--exit-code", "origin", f"{ref}^{{}}").split()
    if git("cat-file", "-t", ref) != "tag" or actual != source["commit"] or remote != [actual, ref + "^{}"]:
        raise SystemExit(f"{stage}: local tag, remote tag and reviewed map must agree")
    print(stage, source["tag"], actual)
PY
```

The v5 checkpoints use the talk's selected model and lockfiles. S0-S2 retain
the opening prompt and original trace. S3 and S4 include the development
repair so either stage can be entered independently with an explicit selected
case/evidence input. S5 verifies the exact package and approval for the
proposed release.

The `talk/v1` and `talk/v2` tags preserve the original Sonnet sources. Use `talk/v3` for recordings made with the original Opus evaluator.

## Maintain a generation

Before freezing a generation, run each stage with its default prompt, locked
dependencies, and reviewed inputs. Check the S5 release commit against the
approved package. Keep raw captures, scores, credentials, and rehearsal edits
out of the public tags.

In **Settings -> Rules -> Rulesets**, check that the rules for `refs/tags/talk/v*/*` allow creation and restrict updates and deletions without a routine bypass. Once the stage sources and the S5 publication have been approved, the checkpoint maintainer creates the six annotated tags and pushes those six refs together with `git push --atomic`. Verify the commits behind all six tags from a second clone, then record the map on `main`.

Use a new generation name when the checkpoint source changes. Earlier maps
remain in Git history. A new performance can reuse the frozen stage sources,
but must use its own private case/results records.
