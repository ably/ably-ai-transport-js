# Comments

## Prefer self-descriptive code

Lean on the code to explain itself — clear names, small functions, obvious
structure — and reserve comments for what the code cannot say on its own. A
comment should not duplicate the code, and a comment is not a substitute for
making unclear code clear. If a clear comment is hard to write, that is often a
sign the code itself needs work.

A comment earns its place when it:

- explains the non-obvious **why** — a constraint, a trade-off, a workaround;
- explains unidiomatic code that would otherwise read as a mistake;
- links to an external reference (issue, spec, article) where that helps most;
- records why a bug fix takes the shape it does;
- marks an incomplete implementation or a known gap.

**Why:** a comment that restates self-evident code adds reading cost and drifts
out of date as the code moves on; the code itself cannot. A comment that
captures intent the code can't express is worth keeping. Comments should dispel
confusion, not add it.

**How to apply:** if a comment duplicates the code, drop it and let the code
stand — or, where the code reads unclearly, improve the code rather than annotate
it. Keep the comments that carry something the code cannot. The guidance below
applies to those.

## Anchor to the present

Comments — and JSDoc, test descriptions, and documentation prose — must
describe what the code does **today**, or call out future work still needed.
They must never anchor to how the code used to be.

Avoid backward-looking phrasing:

- "Replaces the standalone `Foo` event"
- "Previously consumed `bar`"
- "Now-removed `Baz`" / "no longer does X"
- "Pre-PR-3 behaviour" / "Phase A of the migration"

**Why:** comments anchored to removed code rot. They mean nothing to a reader
who never saw the old shape, and they age into confusing noise as the code
evolves. A second source of truth for history that drifts the moment the code
moves on.

**Where migration context belongs:** the commit message and PR description, not
the code. "This replaces…", "migrated from…", and which change came before are
history — and the history is the right place for them.

**How to apply:** describe the current behaviour and the reason for it, in the
present tense, without reference to the prior design. If a behaviour deserves
narrative (e.g. "errors surface via the run-end event plus headers"), state it
as the present-day contract. The same rule applies to JSDoc, test
descriptions, and docs.
