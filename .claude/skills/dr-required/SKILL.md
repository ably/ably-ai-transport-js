---
name: dr-required
description: Gate a pull request on whether it makes a decision that should have been recorded first — a wire-format change, a new public surface, a new convention, a dependency — and fail it when no Decision Record is linked in the description. A shell script finds the places a decision would leave a mark and hands them over with the PR's own description; the model answers one binary question and nothing else. Most runs cost no model tokens at all. Read-only; never edits code, the PR, or the DR.
license: proprietary
metadata:
  team: engineering
  tags: decision-record, ci, gate, pull-request
  mcp: false
allowed-tools: Bash(bash .claude/skills/dr-required/signals.sh *), Bash(gh pr view *), Bash(git rev-parse *), Bash(git merge-base *)
argument-hint: '[base-ref]  (optional; defaults to the PR target branch, else main)'
---

# DR required?

Answer one question: **does this change make a decision that should have been
recorded in a DR before the code was written, and is no DR linked?**

That is the whole scope. Whether the linked DR is any good is the `dr-check`
skill's question. Whether the code is any good is `/code-review-ci` and
`/code-review-all`. This gate reads a pull request's description and the sites
where a decision would have left a mark — never the diff.

## Step 1 — resolve the base

- If `$ARGUMENTS` names a ref, use it verbatim.
- Otherwise take the current branch's open-PR target:
  `gh pr view --json baseRefName --jq .baseRefName`.
- If there is no PR, use `main`.

In CI the base and `PR_NUMBER` are supplied explicitly; do not guess them there.

## Step 2 — collect the signals

```bash
PR_NUMBER=<n> bash .claude/skills/dr-required/signals.sh <base> [head]
```

Run it **once**. It prints the PR title, any `DRLINK` and `OVERRIDE` markers it
found in the description, one `SIGNAL<TAB>id<TAB>site<TAB>detail` record per
place a decision would leave a mark, the description itself between
`BODY-BEGIN`/`BODY-END`, and a `SUMMARY` block.

Exit 2 means it could not resolve a ref or could not read the description.
Report `VERDICT: ERROR` with the message. A description this gate cannot read is
never a pass.

## Step 3 — the free exits

Take the first that applies and stop. Each of these is settled without judging
anything, so most runs end here having spent nothing:

1. **`dr links: 1` or more** — a DR is linked. `VERDICT: PASS`. Do not assess
   whether it is the _right_ DR, whether it is approved, or whether it covers
   this change; a wrong link is a human review problem, not a gate's.
2. **`overrides: 1` or more** — the author overruled the gate on the record.
   `VERDICT: PASS`, and quote the reason so it reaches the reviewer.
3. **`signals: 0`** — the change left no mark in any of the places a decision
   leaves one. `VERDICT: PASS`.

## Step 4 — the one judgement

Only reached when signals fired and nothing is linked. Read the description
and the signal records. Answer this and nothing else.

**Write two sentences before deciding:**

- _The decision:_ what this change picks.
- _The alternative:_ what a competent engineer on this team could have defended
  instead, in review, with a straight face.

**If you cannot write the second sentence, the answer is NO.** A change with no
live alternative is an implementation, however large. This is the whole test —
signal count is not evidence, and neither is diff size. A signal is a place to
look.

If both sentences are real, the answer is YES only when all three hold:

1. **Someone outside this PR pays for it.** The choice reaches the wire, the
   public API, the error taxonomy, a dependency, or a written convention —
   somewhere a deployed client, a downstream consumer, or every future change
   inherits it. A choice whose entire cost is inside one module is reversible by
   rewriting that module, and is not a DR.
2. **It was open.** If a ticket, an existing DR, an upstream registry, a
   provider's own API, or a previous PR in the stack already settled it, this PR
   is implementing a decision rather than making one. The description usually
   says so outright — take it at its word.
3. **Reversing it later costs more than reverting the diff.**

**Default to NO.** This gate fails work that is already written, so a false
positive is expensive and a false negative is recoverable — the DR can still be
written. Where the call is genuinely arguable, it is not a DR.

### Calibration

These are NO even when signals fire heavily:

- A rename that matches an external registry, a ticket, or an upstream PR that
  already chose the names.
- Widening a peer range to admit a new major additively, where nothing had to be
  given up.
- A release bump, a demo, a test tier, CI config, docs.
- A bug fix, however subtle, that restores behaviour the code already intended.
- Deleting something that has moved elsewhere.
- A rule file edited to describe what the code now does, where the code change
  it describes is not itself a decision.

These are YES:

- A new, renamed, or removed wire header, event, or message name — a
  compatibility contract with every deployed client.
- A new entry point or codec: a new public surface with its own peer
  dependencies.
- A new public abstraction others will build on, or the removal of one.
- Moving responsibility between the layers, or adding a layer.
- A convention written into `.claude/rules/` that every future change is held
  to, where the convention itself is the choice.
- A change to the _shape_ of the error taxonomy — which failures a caller can
  distinguish — as opposed to what the codes are called.

## Step 5 — report

On NO: one line saying no decision was found and how many signals were cleared.
`VERDICT: PASS`.

On YES: the two sentences from Step 4, the signal sites that carry the decision
(not all of them), and then, verbatim:

> Link the DR in the description as `AITDR-NNN`, or overrule this gate by adding
> a line reading `No DR needed: <reason>`.

`VERDICT: FAIL`.

Say nothing else. No summary of the change, no review of the code, no opinion on
the decision itself — only whether one was made.

## What this gate does not do, and why

- **It does not read the diff.** The description and the signal sites are the
  evidence, which is what keeps the cost flat: a 7,000-line PR and a 70-line one
  cost the same. A decision that is invisible in both the description and every
  signal site is out of reach here, and that is the accepted trade.
- **It does not check the DR.** Not that it exists, not that it is approved, not
  that it covers this change. `dr-check` does that, and a person runs it.
- **It fires late.** A DR is meant to be agreed before the code is written, and
  this runs on a PR — so a FAIL means the work happened in the wrong order. That
  is worth knowing, but it makes the override load-bearing: a gate that cannot
  be overruled on a judgement call gets switched off the first time it is wrong.
