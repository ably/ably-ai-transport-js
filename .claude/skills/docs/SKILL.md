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
   from memory or assumption - read the implementation, the types, and the
   tests. The code is the source of truth.

2. **Read related existing docs** in `docs/` to understand what's already
   covered and avoid contradictions. Check for pages that should
   cross-reference the new content.

3. **Identify the single intent** of the page. Each page answers one question
   or enables one task. If the page covers two distinct developer intents,
   it should be two pages.

4. **Read `docs/internals/glossary.md`** before writing any internals page.
   Use glossary links for Ably-specific or architecture terms at first
   mention rather than re-explaining them inline.

## Doc principles

These principles come from the project's documentation strategy. Follow them
in every page you write.

### Problem recognition is the entry point

Open feature pages with brief problem framing - "without a durable session
layer, this is hard because..." This is not marketing. It orients the
developer and explains why the capability exists. Keep it to 1-2 sentences.

### One path, then depth

Default to the most common choice at every decision point. Don't present two
equal options where one should be the default. Show the recommended approach
first, then mention alternatives below. The developer who just wants to get
it working should never have to choose between equal-looking options.

### Atomic pages, duplication is fine

Each page has one clear focus. Cancel, interruption, steer, and double-text are
separate pages even though they share underlying technology. Duplication across
pages is preferred over forcing developers to mentally unpack a page covering
multiple concepts. When you duplicate, keep the duplicated content minimal and
focused on the current page's intent.

### Client and server are distinct concerns

Feature pages should show code for both sides. Use clear section headers
(not tabs - this is markdown). Server code and client code are separate
concerns and should be presented separately with their own context.

### Honest about status

Be explicit about what's supported, what's partial, and what's planned.
Never claim a feature works if the implementation is incomplete. Mark
unimplemented features clearly.

### It's a tool, not a task

Frame everything as "you have this problem, and it disappears." The developer
is not learning a new thing - they're solving a problem they already have.
AI Transport is infrastructure you don't want to think about.

## Voice and style

These patterns are derived from the documentation that received positive
feedback. They are not guidelines - they are the voice of this project's docs.

### Opening sentence

The first sentence of every page defines the concept or capability in one
direct, declarative statement. No preamble, no "In this guide, we'll..."

```markdown
<!-- Good -->
Cancellation in `@ably/ai` is a channel-level operation - the client publishes
a cancel signal on the Ably channel, the server receives it and aborts the
matching turns.

<!-- Good -->
Interruption is when a user sends a new message while the AI is still streaming
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
- **Use hyphens, not em-dashes.** Use ` - ` (space-hyphen-space) for
  parenthetical asides, not `—`. This applies to prose, code comments,
  and table cells.

### Inline code formatting

Use backticks for anything that references code - variable names, function
names, header names, enum values, type names, file paths. Do not use backticks
for plain-English concept names.

- **Concept names** are plain text: "message ID", "turn", "cancel signal"
- **Variable/field names** are backticked: `msgId`, `turnId`, `serial`
- **Header names** are backticked: `x-ably-msg-id`, `x-ably-turn-id`
- **Functions** always include parentheses: `send()`, `cancel()`, not `send` or `cancel`
- **Types and interfaces** are backticked: `ClientTransport`, `Codec<TEvent, TMessage>`
- **Enum values** are backticked: `streaming`, `finished`, `aborted`

```markdown
<!-- Good -->
The message ID is available as `msg.id`. Call `transport.send()` to publish,
which sets the `x-ably-msg-id` header.

<!-- Bad: concept name backticked, function missing parens -->
The `message ID` is available as `msg.id`. Call `transport.send` to publish.
```

### Define jargon on first use

Every technical term that a reader might not know needs either an inline
definition or a link to the [glossary](../../docs/internals/glossary.md) at
its first mention within a page. This applies to:

- **Ably-specific terms:** serial, message actions, channel attach,
  untilAttach, message appends, extras.headers
- **Architecture terms:** transport layer vs domain layer, own turn vs
  observer turn, turn ID vs message ID
- **Protocol jargon:** terminal event, fire-and-forget, prefix-match,
  first-contact, optimistic reconciliation, serial promotion, codec key

For internals pages, prefer linking to the glossary
(`[serial](glossary.md#serial-ably)`) over repeating the definition. For
feature and concept pages aimed at external developers, prefer a brief
inline explanation on first use - don't force readers to click away.

**After writing a page, audit it for unexplained terms.** Read each
paragraph as if you don't know the codebase. Any term that would make you
pause and think "what does that mean?" needs a definition or a link.

### Structure patterns

Feature pages follow this flow:

1. **Opening definition** - one sentence that defines what this is
2. **Problem framing** - 1-2 sentences: "without X, this is hard because..."
3. **Mechanism** - how it works (brief, conceptual)
4. **Server code** - complete but minimal, under a "Server" or "Server side" header
5. **Client code** - complete but minimal, under a "Client" or "Client side" header
6. **Variants/options** - alternative approaches, configuration options
7. **Edge cases** - what happens in non-obvious situations
8. **Wire sequence** (if applicable) - ASCII diagram showing the message flow
9. **Cross-references** - inline links to related feature pages and the reference

Concept pages follow this flow:

1. **Opening definition** - what this abstraction is and why it exists
2. **Architecture** - how the pieces fit together (ASCII diagrams)
3. **Data flow** - what happens when, step by step
4. **Key details** - the things developers need to know to use it correctly

Quickstart pages follow this flow:

1. **Opening sentence** - what you'll build and which integration path
2. **Prerequisites** - what you need before starting
3. **Numbered steps** - each step is a file to create, with complete code
4. **"What's happening"** - brief explanation linking to concept pages
5. **Next steps** - links to feature pages for adding capabilities

Framework guide pages follow this flow:

1. **Opening sentence** - what the framework provides and what AIT adds
2. **Comparison table** - capabilities with and without AIT
3. **Integration paths** - recommended approach first, alternatives below
4. **When to use which** - decision table for choosing between paths
5. **Server side** - server code is the same for all client paths
6. **Codec details** - how the codec maps between framework types and Ably

Reference pages follow this flow:

1. **One section per API item** - hook, method, or error code
2. **Signature** - the TypeScript call signature
3. **Parameters table** - name, type, description for each parameter
4. **Return type** - what comes back, with property/method tables for complex returns
5. **Behavior notes** - brief description of what it does, when it updates
6. **Code example** - minimal usage (only where the signature isn't self-evident)

Internals pages follow this flow:

1. **Opening definition** - what this component is and what problem it solves
2. **Key concepts** - the mental model (data structures, state machines,
   lifecycles) needed to understand the component
3. **Operations/methods** - what you can do with it, typically as a table
4. **Algorithms/flows** - step-by-step or pseudocode for non-trivial
   processes (flatten, flush/recovery, prefix-match, etc.)
5. **Edge cases and recovery** - what happens when things go wrong
6. **Cross-references** - inline links to related internals pages, the
   glossary, and the corresponding feature/concept pages

Internals pages differ from concept pages: concept pages explain what
developers need to know to *use* the SDK. Internals pages explain how the
SDK works *internally* for contributors and curious engineers. Internals
pages can reference source file paths and internal class names.

### Tables

Use tables for structured comparisons - filter options, event types, error
codes, phase behaviors. Tables are scannable and dense. Prefer a table over
a bullet list when comparing properties across items.

```markdown
| Filter | Effect | Use case |
|---|---|---|
| `{ own: true }` (default) | Cancel all turns started by this client | Stop button |
| `{ turnId: "abc" }` | Cancel one specific turn | Cancel a specific generation |
```

### Diagrams

Use **Mermaid diagrams** (` ```mermaid `) for sequence diagrams, flowcharts,
and any multi-column or multi-participant interactions. Mermaid is rendered
by GitHub and most doc tooling, so alignment is never an issue.

```markdown
```mermaid
sequenceDiagram
    participant C as Client
    participant Ch as Channel
    participant S as Server

    C->>Ch: publish(x-ably-cancel)
    Note left of C: close local stream(s)
    Ch->>S: deliver to cancel listener
```                                        (close the code fence)
```

**When to use Mermaid vs plain text:**

- **Mermaid `sequenceDiagram`** - wire sequences, request-response flows,
  anything with multiple participants exchanging messages over time.
- **Mermaid `flowchart`** - data flow diagrams, architecture layers,
  routing logic with branching paths.
- **Plain text** - simple hierarchical trees (2-3 levels, e.g. class
  composition), pseudocode algorithms, data structure layouts. These are
  small enough that alignment is trivial.

**Do not use hand-drawn ASCII art for multi-column sequence diagrams.**
Column alignment is error-prone and breaks silently when edited. Mermaid
eliminates this class of bugs entirely.

### Code examples

- **Complete but minimal.** Every example should be copy-pasteable and
  make sense on its own. Include imports when the import path matters.
- **Show the recommended approach first.** The first code block on the page
  should be the thing most developers will actually write.
- **Real types, real methods.** Use the actual API - `transport.send()`,
  `turn.cancel()`, not pseudocode.
- **Comments explain the non-obvious.** Don't comment `// cancel the turn`
  above `turn.cancel()`. Do comment `// fire-and-forget - POST doesn't block
  the stream return`.
- **TypeScript only** for now (the SDK is TypeScript).
- **Both sides.** Feature pages show client and server code. Use section
  headers to separate them.

### Cross-references

Link to related pages with relative markdown links. Every feature page should
link to at least the relevant reference page. Use inline links, not a
"See also" section at the bottom.

**Link densely, not just at the end.** Every mention of a concept that is
explained in detail on another page should be an inline link at first mention
within the current section. Don't rely on a trailing "See also" paragraph -
readers skim, and the link needs to be where the concept appears.

```markdown
<!-- Good: inline link where the concept is mentioned -->
The [decoder](decoder.md) accumulates deltas via string concatenation and
uses [prefix-matching](decoder.md#known-serial-prefix-match) to detect
whether an update is incremental or a replacement.

<!-- Bad: concept mentioned without link, with "See also" at the bottom -->
The decoder accumulates deltas via string concatenation and uses
prefix-matching to detect whether an update is incremental or a replacement.
...
See [Decoder](decoder.md) for details.
```

For internals pages, link to specific heading anchors (e.g.
`encoder.md#recovery-mechanism`) rather than just the page. This lets
readers jump directly to the relevant section.

Feature/concept pages should link to the corresponding internals page at the
end for readers who want to go deeper (e.g. "For the internal mechanics, see
[Conversation tree](../internals/conversation-tree.md).").

### Section headers

Use short, descriptive headers. Prefer "What happens when you cancel" over
"Cancellation behavior." Use the developer's language, not internal jargon.

Headers should work as a table of contents - a developer scanning the headers
should understand what the page covers without reading the body.

## What NOT to do

- **Don't write "Introduction" sections.** The opening paragraph IS the
  introduction.
- **Don't summarize at the end.** The page is short enough to not need it.
- **Don't explain what markdown formatting means.** No "the table below
  shows..." - just put the table there.
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
- **Don't simplify interface signatures.** When showing a TypeScript
  interface or method signature, include all parameters (even optional ones)
  and mark optional fields with `?`. Omitting a parameter or showing a
  required field as optional leads to incorrect mental models.
- **Don't describe behavior without verifying the code path.** Common
  mistakes: describing which method is called in error vs success paths
  incorrectly, getting the priority order of layered operations wrong
  (e.g. header merge order), or confusing `close()` with `abort()`.
  Verify each claim against the actual implementation.
- **Don't use concepts without explaining or linking them.** Every
  technical term - Ably-specific, architecture-specific, or protocol
  jargon - must be either defined inline or linked to the glossary at
  its first mention on the page.

## File placement

Follow the existing directory structure:

```
docs/
├── index.md          # Overview - orients the developer, routes to next step
├── concepts/         # Mental models: transport architecture, turns, codec
├── get-started/      # Quickstarts - working app in minutes, per integration path
├── frameworks/       # Framework guides - why AIT + framework X, integration paths
├── features/         # Feature pages - one developer intent per page, atomic
├── reference/        # API reference - signatures, params, return types
└── internals/        # Under the hood - wire protocol, encoder, decoder, tree, etc.
    └── glossary.md   # Definitions for Ably-specific and architecture terms
```

**Page type by directory:**

| Directory | Page type | Pattern |
|---|---|---|
| `concepts/` | Concept page | Definition → architecture → data flow → key details |
| `get-started/` | Quickstart | Prerequisites → step-by-step → "what's happening" → next steps |
| `frameworks/` | Framework guide | What the framework provides → what's missing → how AIT fills gaps → integration paths |
| `features/` | Feature page | Definition → problem framing → mechanism → client code → server code → edge cases |
| `reference/` | Reference page | One section per API item: signature, params table, return type, example |
| `internals/` | Internals page | Definition → concepts → operations → algorithms → edge cases → cross-refs |

If a page doesn't fit these categories, discuss placement before writing.

## Review checklist

After writing a doc page, verify:

**Content accuracy:**

- [ ] Code examples are copy-pasteable and use real API surface
- [ ] Code examples match current source code (read the implementation)
- [ ] Code examples have all variables defined (no undefined references)
- [ ] Import paths use real package entry points (`@ably/ai-transport`, `/react`, `/vercel`, `/vercel/react`)
- [ ] Interface signatures match the source exactly - optional fields (`?`),
      parameter names, parameter order, return types
- [ ] Wire protocol values match source (`streaming`/`finished`/`aborted`, not `open`/`closed`)
- [ ] Chunk/event type names match the actual codec implementation
- [ ] No undocumented or invented API surface
- [ ] Method behavior descriptions match the actual implementation (e.g.
      which method is called in the error path - `close()` vs `abort()`)
- [ ] Priority/ordering claims match the code (e.g. header merge order)

**Structure and style:**

- [ ] Opening sentence defines the concept in one direct statement
- [ ] Feature pages have 1-2 sentence problem framing after the opening
- [ ] Single developer intent per page
- [ ] Both client and server sides shown (for feature pages)
- [ ] No marketing language, no hedging, no meta-commentary
- [ ] Tables used for structured comparisons
- [ ] Headers work as a scannable table of contents

**Diagrams:**

- [ ] Multi-column sequence diagrams and flowcharts use Mermaid, not ASCII art
- [ ] Mermaid diagrams render correctly (valid syntax, participants declared)
- [ ] Plain-text diagrams (simple trees, pseudocode) have consistent alignment

**Cross-references and definitions:**

- [ ] Cross-references to related pages and at least one reference page
- [ ] All cross-reference paths are correct relative paths to existing files
- [ ] Cross-reference anchors point to headings that actually exist
- [ ] Every concept mentioned that is explained elsewhere is linked at first
      mention (not just in a "See also" at the bottom)
- [ ] Internals pages link to specific heading anchors, not just page-level

**Concept audit (do this last):**

- [ ] Read each paragraph as an outsider - flag any term that isn't obvious
- [ ] Ably-specific terms (serial, message actions, channel attach) are
      defined or linked to the glossary at first mention
- [ ] Architecture terms (own turn, observer turn, transport layer, domain
      layer) are defined or linked at first mention
- [ ] Protocol jargon (terminal event, fire-and-forget, prefix-match,
      first-contact, optimistic reconciliation) is defined or linked at first mention
- [ ] No concept is mentioned in passing without the reader being able to
      understand it from context, an inline definition, or a link
