---
name: docs
description: Write or improve markdown documentation for the AI Transport SDK. Follows the project's doc principles (atomic pages, problem-first framing, one path then depth) and the established style from the docs that received positive feedback.
---

# Writing Documentation

Write markdown documentation for the AI Transport SDK. This skill covers
creating new doc pages, improving existing ones, and reviewing docs for
consistency with the project's principles and voice.

## Before writing

1. **Read the source code** for whatever you're documenting. Never document
   from memory or assumption — read the implementation, the types, and the
   tests. The code is the source of truth.

2. **Read related existing docs** in `docs/` to understand what's already
   covered and avoid contradictions. Check for pages that should
   cross-reference the new content.

3. **Identify the single intent** of the page. Each page answers one question
   or enables one task. If the page covers two distinct developer intents,
   it should be two pages.

## Doc principles

These principles come from the project's documentation strategy. Follow them
in every page you write.

### Problem recognition is the entry point

Open feature pages with brief problem framing — "without a durable session
layer, this is hard because..." This is not marketing. It orients the
developer and explains why the capability exists. Keep it to 1-2 sentences.

### One path, then depth

Default to the most common choice at every decision point. Don't present two
equal options where one should be the default. Show the recommended approach
first, then mention alternatives below. The developer who just wants to get
it working should never have to choose between equal-looking options.

### Atomic pages, duplication is fine

Each page has one clear focus. Cancel, barge-in, steer, and double-text are
separate pages even though they share underlying technology. Duplication across
pages is preferred over forcing developers to mentally unpack a page covering
multiple concepts. When you duplicate, keep the duplicated content minimal and
focused on the current page's intent.

### Client and server are distinct concerns

Feature pages should show code for both sides. Use clear section headers
(not tabs — this is markdown). Server code and client code are separate
concerns and should be presented separately with their own context.

### Honest about status

Be explicit about what's supported, what's partial, and what's planned.
Never claim a feature works if the implementation is incomplete. Mark
unimplemented features clearly.

### It's a tool, not a task

Frame everything as "you have this problem, and it disappears." The developer
is not learning a new thing — they're solving a problem they already have.
AI Transport is infrastructure you don't want to think about.

## Voice and style

These patterns are derived from the documentation that received positive
feedback. They are not guidelines — they are the voice of this project's docs.

### Opening sentence

The first sentence of every page defines the concept or capability in one
direct, declarative statement. No preamble, no "In this guide, we'll..."

```markdown
<!-- Good -->
Cancellation in `@ably/ai` is a channel-level operation — the client publishes
a cancel signal on the Ably channel, the server receives it and aborts the
matching turns.

<!-- Good -->
Barge-in is when a user sends a new message while the AI is still streaming
a response.

<!-- Bad -->
In this guide, we'll explore how to cancel streaming responses in your
AI application.

<!-- Bad -->
This page covers the cancellation feature of the AI Transport SDK.
```

### Tone

- **Confident and direct.** State what happens, not what "should" or "might"
  happen. "The stream closes" not "the stream should close."
- **Technical but accessible.** Assume the reader is a competent developer
  but not an Ably expert. Explain Ably-specific concepts briefly on first use.
- **No marketing language.** No "powerful", "seamless", "easy-to-use",
  "robust." The technical explanation IS the value proposition.
- **No hedging.** Don't say "you may want to" or "consider using." Say
  "use X when Y."

### Structure patterns

Feature pages follow this flow:

1. **Opening definition** — one sentence that defines what this is
2. **Problem framing** — 1-2 sentences: "without X, this is hard because..."
3. **Mechanism** — how it works (brief, conceptual)
4. **Server code** — complete but minimal, under a "Server" or "Server side" header
5. **Client code** — complete but minimal, under a "Client" or "Client side" header
6. **Variants/options** — alternative approaches, configuration options
7. **Edge cases** — what happens in non-obvious situations
8. **Wire sequence** (if applicable) — ASCII diagram showing the message flow
9. **Cross-references** — inline links to related feature pages and the reference

Concept pages follow this flow:

1. **Opening definition** — what this abstraction is and why it exists
2. **Architecture** — how the pieces fit together (ASCII diagrams)
3. **Data flow** — what happens when, step by step
4. **Key details** — the things developers need to know to use it correctly

Quickstart pages follow this flow:

1. **Opening sentence** — what you'll build and which integration path
2. **Prerequisites** — what you need before starting
3. **Numbered steps** — each step is a file to create, with complete code
4. **"What's happening"** — brief explanation linking to concept pages
5. **Next steps** — links to feature pages for adding capabilities

Framework guide pages follow this flow:

1. **Opening sentence** — what the framework provides and what AIT adds
2. **Comparison table** — capabilities with and without AIT
3. **Integration paths** — recommended approach first, alternatives below
4. **When to use which** — decision table for choosing between paths
5. **Server side** — server code is the same for all client paths
6. **Codec details** — how the codec maps between framework types and Ably

Reference pages follow this flow:

1. **One section per API item** — hook, method, or error code
2. **Signature** — the TypeScript call signature
3. **Parameters table** — name, type, description for each parameter
4. **Return type** — what comes back, with property/method tables for complex returns
5. **Behavior notes** — brief description of what it does, when it updates
6. **Code example** — minimal usage (only where the signature isn't self-evident)

### Tables

Use tables for structured comparisons — filter options, event types, error
codes, phase behaviors. Tables are scannable and dense. Prefer a table over
a bullet list when comparing properties across items.

```markdown
| Filter | Effect | Use case |
|---|---|---|
| `{ own: true }` (default) | Cancel all turns started by this client | Stop button |
| `{ turnId: "abc" }` | Cancel one specific turn | Cancel a specific generation |
```

### ASCII diagrams

Use ASCII diagrams for wire sequences, architecture layers, and data flows.
Keep them minimal — show the essential interactions, not every field.

```markdown
Client                          Channel                         Server
  |                                                               |
  |-- publish(x-ably-cancel) ---------->                          |
  |-- close local stream                |                          |
  |                                    |--> cancel listener       |
```

### Code examples

- **Complete but minimal.** Every example should be copy-pasteable and
  make sense on its own. Include imports when the import path matters.
- **Show the recommended approach first.** The first code block on the page
  should be the thing most developers will actually write.
- **Real types, real methods.** Use the actual API — `transport.send()`,
  `turn.cancel()`, not pseudocode.
- **Comments explain the non-obvious.** Don't comment `// cancel the turn`
  above `turn.cancel()`. Do comment `// fire-and-forget — POST doesn't block
  the stream return`.
- **TypeScript only** for now (the SDK is TypeScript).
- **Both sides.** Feature pages show client and server code. Use section
  headers to separate them.

### Cross-references

Link to related pages with relative markdown links. Every feature page should
link to at least the relevant reference page. Use inline links, not a
"See also" section at the bottom.

```markdown
See [Cancel](../features/cancel.md) for cancellation options during barge-in.
See [React hooks reference](../reference/react-hooks.md) for the full
`useActiveTurns` API.
```

### Section headers

Use short, descriptive headers. Prefer "What happens when you cancel" over
"Cancellation behavior." Use the developer's language, not internal jargon.

Headers should work as a table of contents — a developer scanning the headers
should understand what the page covers without reading the body.

## What NOT to do

- **Don't write "Introduction" sections.** The opening paragraph IS the
  introduction.
- **Don't summarize at the end.** The page is short enough to not need it.
- **Don't explain what markdown formatting means.** No "the table below
  shows..." — just put the table there.
- **Don't add meta-commentary.** No "This is an advanced topic" or "This
  section assumes you've read X." If there's a prerequisite, link to it
  inline.
- **Don't use admonitions excessively.** A page with five "Note:" callouts
  is a page with poor structure. Restructure so the information flows
  naturally.
- **Don't document internal implementation details** unless the page is
  explicitly in the "Under the Hood" / internals section. Feature pages
  explain what happens and how to use it, not how the code is structured
  internally.
- **Don't invent API surface.** Only document methods, options, and
  behaviors that exist in the source code. Read the code first.

## File placement

Follow the existing directory structure:

```
docs/
├── index.md          # Overview — orients the developer, routes to next step
├── concepts/         # Mental models: transport architecture, turns, codec
├── get-started/      # Quickstarts — working app in minutes, per integration path
├── frameworks/       # Framework guides — why AIT + framework X, integration paths
├── features/         # Feature pages — one developer intent per page, atomic
└── reference/        # API reference — signatures, params, return types
```

**Page type by directory:**

| Directory | Page type | Pattern |
|---|---|---|
| `concepts/` | Concept page | Definition → architecture → data flow → key details |
| `get-started/` | Quickstart | Prerequisites → step-by-step → "what's happening" → next steps |
| `frameworks/` | Framework guide | What the framework provides → what's missing → how AIT fills gaps → integration paths |
| `features/` | Feature page | Definition → problem framing → mechanism → client code → server code → edge cases |
| `reference/` | Reference page | One section per API item: signature, params table, return type, example |

If a page doesn't fit these categories, discuss placement before writing.

## Review checklist

After writing a doc page, verify:

- [ ] Opening sentence defines the concept in one direct statement
- [ ] Feature pages have 1-2 sentence problem framing after the opening
- [ ] Single developer intent per page
- [ ] Code examples are copy-pasteable and use real API surface
- [ ] Code examples match current source code (read the implementation)
- [ ] Code examples have all variables defined (no undefined references)
- [ ] Import paths use real package entry points (`@ably/ably-ai-transport-js`, `/react`, `/vercel`, `/vercel/react`)
- [ ] Both client and server sides shown (for feature pages)
- [ ] No marketing language, no hedging, no meta-commentary
- [ ] Tables used for structured comparisons
- [ ] Cross-references to related pages and at least one reference page
- [ ] All cross-reference paths are correct relative paths to existing files
- [ ] Headers work as a scannable table of contents
- [ ] No undocumented or invented API surface
- [ ] Wire protocol values match source (`streaming`/`finished`/`aborted`, not `open`/`closed`)
- [ ] Chunk/event type names match the actual codec implementation
