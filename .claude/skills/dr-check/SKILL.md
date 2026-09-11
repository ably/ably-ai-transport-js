---
name: dr-check
description: Gate an AIT Decision Record on whether it is reviewable and implementable — checks specificity, problem-before-mechanism ordering, undecided content inside the proposal, internal and cross-DR consistency, directional dependencies, adoption cost, and grounds the implementability and current-behaviour claims against the actual code in local git checkouts. Read-only; halts with an access report if it cannot reach a repository or document it needs, and never edits the DR or any repo.
---

# DR Check

Assess whether an AIT Decision Record is **reviewable by a human** and
**implementable without further significant decisions**.

This is a gate, not a style review. It answers one question: if this DR were
approved as written, could an engineer implement it — and could a reviewer hold
it in their head long enough to disagree with it?

"Implementable" is judged against the code, not against the document's own
account of the code. A DR reads as complete far more often than it is, because
the symbols it leans on are ones the reader is assumed to know. Resolving them
is what separates a specific DR from a fluent one.

## Scope, and what runs this instead

The shared Ably `decision-record` skill is the canonical DR workflow and the
mandated pass before human review. It covers house style, the Confluence
template, product-principle questions, and the voice/anti-pattern rubric. **Do
not reimplement any of that here.**

This skill adds the checks that skill does not make: mechanical completeness, a
size gate with a hard fail, ordering, decision leakage, consistency, dependency
direction, derivability of an implementation plan, and verification against the
repositories the decision lands in.

Run both. The clearest evidence that the canonical pass has not happened is a
DR-index comment from automation asking for it — look for one, and say so in
the report rather than inferring it from leftover placeholders.

## Inputs

A DR identifier (`AITDR-019`), a Confluence page ID, or a URL. Given only a
bare identifier, locate the page with `confluenceSearchPages` or
`confluenceSearchUsingCql` (`title ~ "AITDR-" AND space = "AI"`); space keys are
case-sensitive. Run the same sweep to enumerate siblings — checks 6 and 10 need
them.

Fetch, via `callAblyTool`:

- `confluenceGetPage`, **including raw HTML**. The rendered view is not
  sufficient: an `<ac:placeholder>` renders as plausible prose, `<br/>` and
  `<code>` boundaries look like missing spaces, and unrendered markdown in the
  storage format can leave a load-bearing rule unreadable on the page. Work
  from the storage format and quote from it.
- `confluenceGetPageInlineComments` and `confluenceGetPageFooterComments`.

This skill is read-only, on Confluence and on every repository it opens. Do not
create, update, label, or comment on the page. Do not write, stage, commit,
fetch, pull, check out, switch branches, or stash in any repository — including
the one the session is running in.

## Code access preflight

Run this **before any check**. It decides whether the run can happen at all.

### 1. Enumerate the code surfaces the decision lands on

Read the proposal and list every place a change would have to be made: named
repositories, package names, exported symbols, types, wire headers, message
names, HTTP endpoints, config flags, and any platform behaviour the DR asserts
or requires. Map each to a repository.

Two surfaces are easy to miss and both routinely decide the verdict:

- **The platform.** A DR that requires the server to do something new — attach
  from a serial, persist a value, page a backlog — depends on the platform
  repository whether or not it names it.
- **Adopters.** A DR that changes a public surface has a cost in whatever
  consumes it. Check 8 cannot be answered from the SDK repo alone.

### 2. Resolve each repository to a local checkout

The repository the session is running in is always available; take its root from
`git rev-parse --show-toplevel`.

For any other repository named `X` (as `ably/X`), search candidate roots in
order: each directory obtained by walking up from the current repository root
(up to three levels), then any path in `$ABLY_REPO_ROOTS` if it is set. In each
root accept, in order:

- `X` — a non-bare working copy; or
- `X.git` — a bare repository with linked worktrees, in which case use
  `git -C <path> worktree list` and take the worktree on the default branch.

Confirm each candidate with `git -C <path> rev-parse HEAD` and record the SHA.
Carry it into the evidence for any finding made against that repository —
`name@<short SHA>:path/to/file.ts:line` — so the finding can be reproduced, and
so a reader can tell it has expired once the code moves. Do not collect the SHAs
into a provenance section at the end (see the report rules).

Note, do not correct, two states:

- **Off the default branch.** Use it as found. Do not switch — the checkout may
  be someone's live work. Name the branch on each finding drawn from it, since
  the code a reviewer of the DR would see is the default branch's.
- **Dirty working tree.** An uncommitted change can make a symbol appear to
  exist that no reviewer of the DR can see, so where a finding turns on a symbol
  the working tree modifies, say so on that finding.

### 3. Halt if anything needed is unreachable

If a repository from step 1 does not resolve, **stop and report**. Do not run a
partial set of checks, do not substitute a plausible guess for what the code
does, and do not downgrade a check to a WARN to work around missing access. A
verdict reached without the code the decision lands on is the failure mode this
gate exists to prevent, and it is more damaging than no verdict, because it
reads as authoritative.

Halt on missing information as well as missing code:

- The page, its comments, or its siblings cannot be fetched.
- The DR cites a document (RFC, DR, ticket, design note) that its rationale
  leans on and that cannot be reached.
- The DR names a repository, service or system with no local checkout.
- The DR's decision depends on a private constraint stated nowhere reachable — a
  billing model, an SLA, a customer commitment.

Halting is a normal outcome, not an error. A DR whose implementability cannot be
established without a repository nobody has to hand is itself a finding: it
means review of that DR requires more than the DR.

### The halt report

Replaces the normal report entirely. Do not also emit a verdict.

1. **Cannot complete** — one line saying so.
2. **What is needed** — a row per item: what it is, why the DR requires it
   (quote the sentence that does), and how to obtain it
   (`gh repo clone ably/<name>`, a page identifier, a person to ask).
3. **What it would have decided** — which checks are blocked, and for each, the
   specific question the missing access would have answered.
4. **What resolved** — repositories that did resolve, with SHAs, so a re-run
   after the gap is closed starts from the same ground.

## Severity

Classify every finding as **mechanical** or **substantive** before reporting it.

- **Mechanical** — minutes of work, no bearing on whether the decision is
  sound: an unfilled Approver field, undirected link labels, a missing
  identifier on a citation.
- **Substantive** — blocks implementation or defeats review: an undecided wire
  format, contradictory statements, unstated adoption cost, a false premise,
  size.

**Only a substantive finding may decide the verdict.** A well-argued short DR
can collect several mechanical FAILs; reporting it as equivalent to a document
with an undecided public surface is a distortion, and it teaches authors to
ignore the gate. The instruction below not to soften a FAIL has this
counterpart: do not inflate one either. Both defeat review.

## The checks

Run all eleven. Each reports PASS, WARN or FAIL with the evidence that decided
it — quote the offending text and say where it sits. A check with no evidence
quoted is not a finding. Where a check bundles sub-checks, the evidence line
must name which one fired. Evidence drawn from code cites
`repo:path/to/file.ts:line`, never a paraphrase of what the code does.

### 1. Header table is real, not placeholder

FAIL if Approver is empty or still an `<ac:placeholder>`, or if Impact or Driver
is unset. WARN if Contributors, Informed or Related documentation are
placeholders. Fields the template expects to be empty before the decision closes
— Outcome Summary, Outcome — are exempt while the DR is DRAFT or IN REVIEW.

Impact carries its own justification in the best DRs — a label plus why, in
terms of reversibility and cost of being wrong. Note its absence as a WARN.

Mechanical.

### 2. Size and navigability

Count **all prose outside the header table, excluding code blocks and all
tables**. Report that one number, with the excluded table and code totals
alongside so the count cannot be argued with. Do not invent an exclusion for
some tables and not others.

- WARN above 2,000 words — the team's own stated ceiling.
- FAIL above 4,000 words.

Navigability, assessed separately and reported in the same row:

- WARN at more than three levels of heading nesting **relative to the
  shallowest heading used** (Confluence pages conventionally start at `h2`, so
  absolute tag depth is not the measure). FAIL at more than three levels when
  the deepest sections carry their own problem statement, options analysis or
  open questions — a DR nested inside a DR.
- FAIL on duplicated heading text. Four sections named "Methods" leave a
  reviewer no way to cite the passage they want to argue with.

Substantive.

### 3. Problem before mechanism, and a decision to review

The first substantive section must frame the problem, and the document must
contain a decision.

- FAIL if a code block, an API table, or a heading matching
  `/proposal|design|API|mechanism/i` appears before any heading matching
  `/problem|background|context/i`. **Exclude the page's own title from this
  test** and apply it to `h2` and below — a title that names the surface being
  decided is good practice, not a defect.
- WARN if the first substantive section's heading matches *neither* pattern,
  and escalate to FAIL if its prose is mechanism: backticked symbols, method
  calls, type names. A section headed "Preamble" that opens on
  `transport.pipe()` is mechanism-first however it is labelled.
- FAIL if there is no Decision, Recommendation or Proposal section at all. A
  document that describes a decision taken elsewhere is a design note, and
  cannot be reviewed as a DR.
- WARN if a problem section exists but describes a whole strategic area rather
  than the constraint forcing *this* decision now.

Substantive.

### 4. No undecided content inside the decision

Scan the proposal, recommendation and any API or wire-format sections for
language that defers a decision the DR is supposed to make. These phrases are
**illustrative, not exhaustive** — the test is whether the sentence defers a
decision, and a document can defer everything without using any of them:

`still to be worked out`, `needs a decision`, `to be designed`, `TBD`, `TODO`,
`FIXME`, `could be moved`, `we may`, `might instead`, `we intend`, `is
deferred`, `open design work`, `own design work`, `cannot yet`, `not yet`, `not
yet supported`, `for now`, `interim`, `in the first instance`, `intended
replacement`, `until it lands`, `once X is available`, `pending`, `is
undecided`, `currently … but`. Also any heading beginning `Future`.

FAIL on any hit inside a section that defines a public surface or a wire
format. A wire format with an open question in it is not a decision; it is a
proposal to decide later, and every PR built on it will re-open the question.

Two extensions, both of which defeat a naive grep:

- **Deferral by reference.** When a deferral names a sibling DR — "until the
  platform can attach from a serial", "until the annotation mechanism lands" —
  follow it and scan the cited section. A decision deferred to a sibling that
  has not made it is still deferred, and this is the commonest way the check is
  evaded. Where the sibling claims something already exists, check 11 settles
  it.
- **Open questions are exempt from failing this check, but must still be
  read.** FAIL when an item in Open questions governs something the proposal
  specifies as decided — the test being "is a section elsewhere in this DR
  written as though this were settled?" A default-on mechanism whose storage
  model is an open question is the shape to catch.

Substantive.

### 5. Implementability, resolved against the code

Independent of the grep above, answer directly: **what decisions would an
engineer still have to make to implement this?** Enumerate them. For each, say
whether it is a genuine implementation detail (fine) or a choice that changes
the public surface, the wire, or the cost model (not fine).

FAIL if any listed decision is load-bearing. This is the report's most valuable
output — it is the property the DR exists to establish, and no keyword can
detect it. **Do not skip it because check 4 passed.**

**Ground every symbol.** For each type, method, field, header, message name,
option and endpoint the DR names, resolve it in the repositories from the
preflight and classify it:

- **Exists, and the DR's use matches it.** Cite the definition and move on.
- **Exists, but the DR's use disagrees with it** — a different signature, an
  extra field, a changed return type, a narrower type than the code has. FAIL:
  the DR is specifying a change it does not acknowledge as a change, so the
  reviewer cannot see the blast radius and the implementer will discover it.
- **Does not exist, and the DR specifies it fully.** The correct state for new
  work. PASS.
- **Does not exist, and the DR names it without specifying it.** FAIL,
  substantively. This is the single most common way a dense DR hides a
  load-bearing decision: a symbol used as though the reader will recognise it,
  which nobody can implement without inventing its semantics. Say what would
  have to be invented.

Then check the reverse direction: where the DR says a surface is **unchanged**,
confirm from the code that it can be. A surface whose current definition cannot
accommodate the proposal is a change whether the DR calls it one or not.

Shapes that recur, all FAIL:

- A DR that lists options and then adopts all of them.
- A DR that defers a subsystem to design work that does not yet exist.
- A symbol introduced in prose only, where the DR commits others in a code
  block. That asymmetry is where undecided semantics hide — an added option
  field whose inclusivity is never stated, for instance.
- A promised coded error with no code named. Applications switch on codes; an
  adopter cannot write the fallback path without one. Where the repository has
  an error-code enum, check the named code against it.
- A hedged interface: "likely served through an endpoint like `/api/messages`".
  If the one contract between the SDK and the adopter is illustrative, nothing
  downstream of it is decided.

Substantive.

### 6. Consistency, internal and across siblings

The highest-value defect in a dense DR, and the one no other check sees.
Contradictions are worse for an implementer than acknowledged open questions,
because both halves read as decided and each reviewer assumes they misread the
other section.

- **Internal.** For every method signature, wire header, and feature
  disposition stated more than once, verify the statements agree. FAIL on any
  contradiction — two primary keys for one table, a mechanism listed as
  "unchanged" in a scope table and removed in the proposal, a surface described
  one way in an overview and the opposite way in a reference section.
- **Cross-sibling.** For each sibling this DR depends on, does either assert
  something the other contradicts, or leave open something the other has
  closed? Two DRs in review concurrently that disagree about a wire format is a
  FAIL on both.

Where the code has already implemented one of two contradictory statements, say
which — it usually identifies which one the author meant.

Reviewers disputing which of two statements governs is direct evidence for this
check — treat such a comment as corroboration, not noise.

Substantive.

### 7. Directional dependencies

Every related-document link must carry a relationship: Supersedes, Superseded
by, **Depends on**, **Blocks**, or Relates to.

- FAIL if Related documentation is empty or a placeholder while any sibling
  links inbound. A parent that does not know its children is the worst
  dependency state and the cheapest to detect — count the links; zero in a long
  DR is a near-perfect proxy for "this document does not know where it sits".
- FAIL if every link is "Relates to" and the DR has more than two related
  documents — an undirected graph gives a reviewer no reading order.
- FAIL if a DR cited in the body is absent from the header table, **or cited by
  description rather than identifier** ("the subject of its own RFC", "an
  ongoing piece of design work"). A reader cannot follow a citation that names
  nothing.
- FAIL if prior art named in the comments is neither linked nor dispositioned in
  the body. A rejection that exists only in a comment thread is not a decision.

Then classify the relationship, bounding the work: follow only the links the
DR's own rationale explicitly leans on, not every link in the table. Apply the
same test to internal cross-references — section A deferring to B while B
defers back to A is the same defect one level down.

- **Mutual dependency** — each side depends on the other for a *different*
  proposition, and each proposition bottoms out in a proof made in one place.
  Legitimate, but neither DR can be reviewed alone: FAIL on the labelling only,
  and state the reading order.
- **Circular rationale** — neither side's argument bottoms out anywhere. FAIL
  substantively.
- **Chain terminating in an open question** — the DR's stated requirement is
  discharged by a sibling mechanism whose own design is undecided. Worse than
  circularity, because the safety property is proved while the liveness
  property rests on nothing. FAIL substantively and say so plainly.

Labelling failures are mechanical; the three classifications above are
substantive.

### 8. Adoption and migration cost

Required when Impact is High, or when the DR changes anything a consumer must do
to adopt it — a schema, a stored value, a persisted serial, an endpoint
contract, a durable channel's message history, or message volume that lands on
a customer's bill.

FAIL when such a change is specified and its cost to the adopter is not stated.
Unstated adoption cost is the defect most likely to stall a DR in review, so
state it as a review risk, not a formatting nit.

Three required sub-points:

- **Reachability, not just cost.** Can an application that already has data get
  onto the new model at all? A degraded fallback path is not a migration path.
- **Wire changes against durable history.** A field removed from the wire
  persists in channel history. Say what a reader does when it encounters
  messages written under both.
- **Measure the surface from the code, not the prose.** Where the DR removes or
  changes an exported symbol, find its call sites in the repositories you
  resolved — including demos, examples and tests. A DR describing a change as
  contained, whose symbol has call sites the DR does not mention, understates
  its own cost, and the count is the evidence.

Substantive.

### 9. Testing implications

WARN if nothing addresses how the decision will be verified. This repo mandates
test coverage with every change, so a DR that is silent on verification hands
the question to whoever writes the PR.

Where the design's correctness claims are timing- or ordering-sensitive, name
them and say which need the integration tier over a real channel. An exactness
invariant with no stated way to prove it is the gap worth flagging.

Where the repository has test tiers, say which tier each claim lands in and
whether that tier can express it — an assertion about real channel ordering
that only a mocked tier exists for is a gap the DR is handing forward.

Mechanical unless the DR asserts an invariant it gives no way to test.

### 10. Decomposability and external dependencies

Could this DR be turned into an ordered set of independently reviewable PRs,
each mergeable on its own?

Sketch the slices you would derive and name the first one. WARN if you cannot —
if the decision only lands as one atomic change, that is a property of the
design worth surfacing before it becomes a 200-file PR. A DR need not contain
the breakdown; it must be possible to derive one.

Name the slices in terms of the actual tree: the files and modules each one
would touch, from the repositories you resolved. A slice you cannot locate in
the code is not a slice, and two slices that turn out to touch the same file at
the same line are one PR, not two — which is the useful thing to discover now
rather than at review.

Also WARN when the DR hands questions to another team with no owner, ticket or
date while carrying its own due date. A DR that cannot be built until someone
else answers is not schedulable.

Mechanical, unless the design is genuinely indivisible.

### 11. Claims about the current state are true

A DR's argument rests on premises about what exists today — what the code does,
what it costs, what a platform supports, what an adopter must already do. Test
them.

For each premise the rationale leans on, decide:

- **Verified.** Cite the file and line. A verified premise is worth reporting:
  it is the difference between a DR a reviewer can accept and one they have to
  re-derive.
- **False.** FAIL, substantively, and quote both the claim and the code. A
  decision argued from a false premise is not a small defect — it may be the
  right decision, but the DR gives the reviewer no way to tell, and correcting
  the premise can invert the conclusion.
- **Stale.** The claim was true and the code has moved. FAIL if the argument
  turns on it; WARN otherwise. Say which commit changed it where that is cheap
  to find.
- **Unverifiable from the code** — a claim about production behaviour, cost,
  load, or a customer. WARN, and say what evidence would settle it. Do not
  treat it as false; do not treat it as established either.

Two premises to test specifically, because they are asserted more often than
checked:

- **"The platform already does X."** Resolve it in the platform repository.
  Check 4's deferral-by-reference and check 7's chain-terminating-in-an-open-
  question both dissolve into this one, and it is where a DR most often rests on
  something nobody has built.
- **"This is what we do today."** A DR describing current behaviour as a foil
  for its proposal is describing something a reader can check. When the
  description is of code the author wrote, it is usually right; when it is of
  code they did not, check it.

Substantive.

## Report

Fixed order, so reports are comparable across DRs. (On a preflight halt, emit
the halt report instead and nothing else.)

1. **Verdict** — one line: *Reviewable and implementable* / *Reviewable, not
   yet implementable* / *Not reviewable as written*. Then the single
   **substantive** defect that decided it.
2. **Decisions still open** — check 5's enumeration. Load-bearing first.
3. **Check table** — eleven rows, PASS/WARN/FAIL, severity, one-line evidence
   each.
4. **Detail** — the substantive findings first, then mechanical ones grouped and
   kept short. Each with quoted evidence and what would fix it.
5. **Already objected to** — findings a reviewer has already raised, and three
   things about each:
   - Who raised it, and whether the author engaged. **Separate automated
     DR-index comments from human review**; for a bot comment the question is
     not whether the author engaged but whether it has been **refiled**, which
     is a stronger signal than a single human comment. Check bot comments
     against the current page version before repeating them — they go stale and
     a confident false statement misleads the next reader.
   - Whether an answer given in the comments has been **folded into the
     document**. A DR whose defence lives only in its comment thread will draw
     the same objection from the next reviewer. This is a distinct defect from
     an unanswered objection and is often the most actionable finding available.
   - Which check the objection lands on. An objection against a defect this gate
     also found is the top priority regardless of severity.

Those five parts are the whole report. Add no trailing sections — no
consolidated list of fixes, no summary of what the DR gets right, no provenance
or "checked against" appendix. Each belongs inside a part above and nowhere
else:

- **A fix** belongs in part 4, on the finding it fixes. Collected into a numbered
  list at the end it loses the evidence that motivated it, duplicates every
  finding at a second length, and reads as a work plan the gate has no standing
  to set.
- **A strength** belongs in the row of the check that passed. A DR that states
  its own boundary, or cites the code it argues from, earns a PASS with that as
  the evidence; a section praising it separately makes the report longer without
  making it more useful, and it invites softening the FAILs to match.
- **Provenance** belongs on the finding, as the repository and SHA in its
  evidence (see the preflight). A finding with no code citation gains nothing
  from a list of repositories at the end, and a finding that has one does not
  need it repeated.

Report what the checks found. Do not soften a FAIL because the underlying
reasoning is good — dense, well-argued documents are exactly the ones that
defeat review, and saying so is the point of the gate. Equally, do not inflate a
good document by weighing a blank form field the same as an undecided wire
format.

Where a claim could not be settled, say it could not be settled — in the row
and detail of the check that could not settle it, naming the evidence that would.
An unverified premise reported as verified is worse than the gap it papers over,
because the next reader stops checking.
