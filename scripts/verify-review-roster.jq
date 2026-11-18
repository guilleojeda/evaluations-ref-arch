# Both the frozen inputs and the returned reports must cover this release's suite.
($pointer[0].caseIds | sort) as $expected
| .manifestSha256 == $digest
  and ($expected | length > 0 and . == unique)
  and ([.caseIdentities[].caseId] | sort) == $expected
  and ([.reportIdentities[].caseId] | sort) == $expected
