# Talk checkpoints

A checkpoint identifies the source you can open and edit in the browser IDE. The hosted controller selects the agent that will receive the next alarm. The two choices are independent. Opening S3 leaves the live selection alone.

The [map on `main`](../talk/checkpoints.json) lists each annotated tag in `talk/v5` and the commit it points to. The private session index records the cases, candidates and results prepared for each workspace. See [talk preparation](preparation.md) and [cleanup](cleanup.md).

The READMEs at the frozen tags still describe the release gate as future work. Follow the table below for the current talk. S4 runs the development experiment. S5 qualifies the exact ZIP for release.

| Stage | Source link | What you open | What you do |
| --- | --- | --- |
| S0 | [talk/v5/S0](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S0) | Instrumented faulty agent | Inspect the source. Select the faulty endpoint in the controller to send the next alarm to that agent. |
| S1 | [talk/v5/S1](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S1) | Captured incident, case draft and case tools | Review and freeze a case, then inspect the prepared suite. |
| S2 | [talk/v5/S2](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S2) | Faulty candidate and the recorded denial execution | Run the checks, then read the judge’s reason alongside the source evidence. |
| S3 | [talk/v5/S3](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S3) | Repaired prompt and captured execution runner | Run the prepared repair, or start with the faulty prompt and make the edit live. |
| S4 | [talk/v5/S4](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S4) | Native Strands experiment | Test the prompt saved in this workspace or select the exact candidate from the S3 run. |
| S5 | [talk/v5/S5](https://github.com/guilleojeda/evaluations-ref-arch/tree/talk/v5/S5) | Release gate | Inspect the frozen gate code. Make the participant's edit in the prepared `demo-deploy` workspace. |

For the streaming IDE edit and Strands experiment, use the v5 S3 and S4 sources with their own lockfiles. Both pin `strands-agents==1.65.0`. The saved-report example on `main` uses the dependency lock from its own checkout. [S4 dependencies](https://github.com/guilleojeda/evaluations-ref-arch/blob/1f67f305104e9d9c74a7919cf0f968622d1d0c01/agent/pyproject.toml)

For S0-S4, start each workspace at its mapped commit. For S5, verify which `demo-deploy` commit supplied the repaired ZIP now serving. On November 25, 2026, that was [`52dbc79`](https://github.com/guilleojeda/evaluations-ref-arch/commit/52dbc79ea249b92c43490390a769f73a035fcdae). Read the publication again for each performance. Use the presenter workspace for the regression.

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
export PHASE22_GENERATION="${PHASE22_GENERATION:?set the map generation, for example talk/v5}"
generation="$PHASE22_GENERATION"
git fetch origin "refs/tags/${generation}/*:refs/tags/${generation}/*"
python3 - <<'PY'
import json
import os
import subprocess
from pathlib import Path

document = json.loads(Path("talk/checkpoints.json").read_text())
generation = os.environ["PHASE22_GENERATION"]
if document.get("generation") != generation:
    raise SystemExit("the map generation does not match PHASE22_GENERATION")
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

The v5 checkpoints use the US Opus 5.5 profile. S0-S2 have the opening prompt. S3 and S4 each include the development repair so you can start at either stage. S3 compares the prompts on the same captured incident. S4 tries the edited prompt across cases. Their prepared inputs select the calibrated judge, which distinguishes a metric's bucket start, observation time and availability time. For S5, verify the package and approval for the serving prompt.

The `talk/v1` and `talk/v2` tags preserve the original Sonnet sources. Use `talk/v3` for recordings made with the original Opus evaluator.

## Maintain a generation

Before freezing a generation, run each stage with its default prompt, locked dependencies and intended private inputs. Check the S5 release commit against the approved package. Keep raw captures, scores, credentials and rehearsal edits out of the public tags.

In **Settings -> Rules -> Rulesets**, check that the rules for `refs/tags/talk/v*/*` allow creation and restrict updates and deletions without a routine bypass. Once the stage sources and the S5 publication have been approved, the checkpoint maintainer creates the six annotated tags and pushes those six refs together with `git push --atomic`. Verify the commits behind all six tags from a second clone, then record the map on `main`.

Use a new generation name when the checkpoint source changes. Earlier maps remain in Git history. For repeat performances, reuse the same tags and the two prepared endpoints.
