# Lawrence's questions

Standalone answers to questions Lawrence asked while reviewing this work —
each one captured as a self-contained artefact (usually a single-page HTML
explainer) so the reasoning isn't lost in chat history.

Each artefact states the original question up front, then answers it. They are
working aids, not authoritative docs — the durable conventions live in
`.claude/rules/` and the build narrative in `notes/openai-codec-build-log.md`.

| File                                     | Question                                                                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codec-body-vs-headers.html`             | Why do some codec events store the whole event in the message body and others store a subset in `extras` — and is that consistent between the OpenAI and Vercel codecs? |
| `decode-lifecycle-mid-stream-join.html`  | Is `decodeLifecycle` a small change, what does it actually do, and does the mid-stream-join repair need to synthesise both a content part and an output item?           |
