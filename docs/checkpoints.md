# Talk checkpoints

A checkpoint identifies the source you can open and edit in the browser IDE. The hosted controller selects the agent that will receive the next alarm. The two choices are independent. Opening S3 leaves the live selection alone.

The public map in `talk/checkpoints.json` records the six intended tag names and
their **peeled commits**, the commits the tags point to. Use the map from
maintained `main`. A map entry is a source identity, not proof that its tag has
been published or that the source is a qualified release. The private session
index identifies the actual prepared case, candidate and result for each entry.
See [talk preparation](preparation.md) and [cleanup](cleanup.md).

| Stage | What you open | What you do |
| --- | --- | --- |
| S0 | Instrumented faulty agent | Inspect or edit the source. Separately select the deployed faulty agent for a genuine alarm. |
| S1 | Captured incident, case draft and case tools | Review and freeze a case, then inspect the prepared suite. |
| S2 | Faulty candidate and the recorded denial execution | Run the checks and open the actual advisory judgment and source review. |
| S3 | Repaired prompt and captured execution runner | Edit and execute directly, or explicitly start from the faulty prompt for the live repair. |
| S4 | Native Strands experiment | Run the saved workspace candidate or explicitly use the immutable candidate captured by S3. |
| S5 | Repaired source on `demo-deploy` | Push the rehearsed regression and inspect the gate and serving publication. The source tag and live qualification are separate identities. |

S0–S4 start at the mapped commits. S5 has both a frozen source reference and an
editable checkout on the long-lived release branch. Its current qualified
starting commit can be newer than the S5 tag; a source checkpoint never replaces
the separate live qualification binding. After a rejected push, preserve the
result, revert the specific regression on that branch and follow the normal
package review and publication before preparing another S5.

Before the maintainer publishes a generation, check only the map's shape and
commit identities. Do not create, push, or claim the tags from a presenter or
from a preparation checkout:

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

Run from the maintained repository only after the checkpoint maintainer has
published the generation. The fetch below allows new tags. If a local tag
conflicts with its remote counterpart, stop and inspect the discrepancy. A clean
clone gives an independent comparison.

```sh
export PHASE22_GENERATION="${PHASE22_GENERATION:?set the map generation, for example talk/v2}"
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

The corrected checkpoint set uses `talk/v2`; `talk/v1` remains immutable
historical evidence. The v2 map keeps S0, S1, S2 and the qualified S5 source
identities unchanged, and carries the corrected local-capture runner through
the repaired S3 and S4 checkpoints. S3 fixes the stale development manifest
binding; S4 uses the same runner so its candidate baseline remains comparable.
The S5 source keeps its historical v1-S2 regression helper; the v2 S2 tag must
therefore be byte-equivalent to the v1 S2 peeled commit before publishing the
new generation.

## Maintain a generation

Keep one reviewed set of candidate commits. Check each stage's default prompt,
locked dependencies, executable commands and private input references before
freezing it. Keep raw captures, scores, credentials and user edits outside the
public Git objects. S5's tag is a source checkpoint; its qualified starting
commit and publication come from the successful repaired release and its
separate live binding. Inspect the package and review for that exact revision.

In the repository’s **Settings → Rules → Rulesets**, check the active tag rules
for `refs/tags/talk/v*/*`. The rules restrict updates and deletions and allow
creating new generation tags. Confirm that no routine bypass applies. Only the
checkpoint maintainer, after the source and S5 live binding are approved, should
create annotated tags and push the six explicit refs with `git push --atomic`.
Verify all six peeled identities from another clone, then record the reviewed
mapping on maintained `main`.

Use a new generation name for changed checkpoint source. Preserve older maps through Git history. Rehearsals use the existing checkpoints and retain the two deployed endpoints. A rehearsal source edit or a recorded eval does not change either publication.
