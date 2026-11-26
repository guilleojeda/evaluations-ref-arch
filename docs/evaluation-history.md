# Historical evaluation record

These notes preserve the calibration and model comparisons behind the current judge. A repeated score on a saved report counts as another judge call on one case. A fresh agent execution counts as another run. The counts below identify which was measured.

## Metric timestamp findings

The saved overload report exposed a citation error in the original judge
result. Two metric citations used the `20:10Z` bucket start as
`evidence[].observedAt`, although the source rows were observed at
`20:12:15.471Z`. The revised native judge rejected both citations. It accepted
a copy with only those two fields corrected. A constructed pair confirmed the
same rule: the source observation time passes, while the availability time
fails when the clocks differ. The bucket start remains valid in the finding,
but not as the observation-time citation.

Nine earlier regression reports received their expected verdicts. In one older
S4 report, the judge caught an unsupported coverage claim but accepted an
ongoing assessment that relied on that claim. The categorical verdict and its
explanation required separate review.

The repaired candidate was run once on the original November 18 overload case.
It cited `20:12:15.471Z` for maximum concurrency 16 and throttle sum 112,
described the `20:10Z` measurement bucket, and recommended a trial increase
from 16 to 32. The revised judge accepted that saved run and all eight required
deterministic checks passed.

## Retained S2 and S4 records

The first frozen-case run recommended restoring Inventory access, but its
deterministic cutoff check failed on a citation beyond the reviewed time. An
earlier Haiku 4.5 run passed both historical semantic findings in two
provisional scoring attempts. Both explanations treated an empty, clipped tool
response as evidence for the full requested window.

The retained S2 execution on the same frozen case diagnosed the access denial
but recommended increasing Inventory memory from 256 MB to 512 MB. Its action,
value and cutoff checks failed. Its Inventory target check passed. The
historical Sonnet 4.6 single-verdict score stayed with its evaluator
identity and reason. It did not qualify a release or establish behavior for
the active Opus 5.5 target.

The historical browser IDE workflow included an Opus audience-case comparison
and native four-case S4 runs. The repaired denial rows passed the access action
and semantic grounding. Overload and recovery retained separate semantic
failures.

In a separate comparison of serving candidates, Sonnet and Opus chose the same action on all four reviewed cases. Each passed all eight required checks on each case (32 total). This comparison covered those four cases only.

## Calibration denominators

The original Opus rubric matched the human labels on all seven development controls and both held-out reports. One holdout report claimed a single successful checkout, which the judge accepted. The other claimed sustained coverage through `18:04:05Z`, but the last observation was at `18:02:54Z`. The judge rejected it. Two earlier attempts used a different scoring configuration and returned no result. They are excluded from the two scored holdouts. Three additional S4 calls rejudged one saved defect report. [Archived calibration results](https://github.com/guilleojeda/evaluations-ref-arch/blob/cbfc942f05d464e2e0b195f4af9f12d2a236b831/docs/evaluations.md)

Historical multi-mode records kept separate `diagnosis_support` and
`evidence_grounding` findings. The current prepared workflow uses the separate
single-mode evaluator described in the [evaluation guide](evaluations.md#active-model-target),
which returns one advisory `semantic_quality` verdict. Read the older fields using the rubric recorded with that result.
