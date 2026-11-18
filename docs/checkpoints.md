# Talk checkpoints

A checkpoint identifies the source you can open and edit in the browser IDE. The hosted controller selects the agent that will receive the next alarm. The two choices are independent. Opening S3 leaves the live selection alone.

The public map in `talk/checkpoints.json` records the six annotated Git tags and their **peeled commits**, the commits the tags point to. Use the map from maintained `main`. It is recorded separately from the tagged commits so it can identify all six, including S5. The private session index identifies the actual prepared case, candidate and result for each entry. See [talk preparation](preparation.md) and [cleanup](cleanup.md).

| Stage | What you open | What you do |
| --- | --- | --- |
| S0 | Instrumented faulty agent | Inspect or edit the source. Separately select the deployed faulty agent for a genuine alarm. |
| S1 | Captured incident, case draft and case tools | Review and freeze a case, then inspect the prepared suite. |
| S2 | Faulty candidate and the recorded denial execution | Run the checks and open the actual advisory judgment and source review. |
| S3 | Repaired prompt and captured execution runner | Edit and execute directly, or explicitly start from the faulty prompt for the live repair. |
| S4 | Native Strands experiment | Run the saved workspace candidate or explicitly use the immutable candidate captured by S3. |
| S5 | Qualified repaired source on `demo-deploy` | Push the rehearsed regression and inspect the gate and serving publication. |

S0–S4 start at the mapped commits. S5 has both a frozen reference and an editable checkout on the long-lived release branch. Its current qualified starting commit can be newer than the S5 tag. After a rejected push, preserve the result, revert the specific regression on that branch and follow the normal package review and publication before preparing another S5.

## Check the published generation

Run from the maintained repository after fetching the new generation. The fetch below allows new tags. If a local tag conflicts with its remote counterpart, stop and inspect the discrepancy. A clean clone gives an independent comparison.

```sh
git fetch origin 'refs/tags/talk/v1/*:refs/tags/talk/v1/*'
python3 - <<'PY'
import json
import subprocess
from pathlib import Path

stages = json.loads(Path("talk/checkpoints.json").read_text())["checkpoints"]
if set(stages) != {f"S{n}" for n in range(6)}:
    raise SystemExit("The map must identify all six stages.")
for stage, source in sorted(stages.items()):
    ref = "refs/tags/" + source["tag"]
    def git(*args):
        return subprocess.check_output(["git", *args], text=True).strip()
    actual = git("rev-parse", "--verify", f"{ref}^{{commit}}")
    remote = git("ls-remote", "--exit-code", "origin", f"{ref}^{{}}").split()
    if git("cat-file", "-t", ref) != "tag" or actual != source["commit"] or remote != [actual, ref + "^{}"]:
        raise SystemExit(f"{stage}: local tag, remote tag and reviewed map must agree")
    print(stage, source["tag"], actual)
PY
```

## Maintain a generation

Keep one reviewed set of candidate commits. Check each stage's default prompt, locked dependencies, executable commands and private input references before freezing it. Keep raw captures, scores, credentials and user edits outside the public Git objects. S5's commit comes from the successful repaired publication. Inspect the package and review for that exact revision.

In the repository’s **Settings → Rules → Rulesets**, check the active tag rules for `refs/tags/talk/v*/*`. The rules restrict updates and deletions and allow creating new generation tags. Confirm that no routine bypass applies. Create annotated tags for the reviewed commits and push the six explicit refs together with `git push --atomic`. Verify all six peeled identities from another clone. Record the reviewed mapping on maintained `main`.

Use a new generation name for changed checkpoint source. Preserve older maps through Git history. Rehearsals use the existing checkpoints and retain the two deployed endpoints. A rehearsal source edit or a recorded eval does not change either publication.
