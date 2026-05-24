# Round 2 — Codex

> Session trace stripped. Tokens used: see dispatch tmp log.

## My position changes (or doesn't) since Round 1
I do not change position on the core Goal 3 decisions. Sonnet’s CTE finding makes the trigger-side impossibility stronger, not weaker, and Opus/Sonnet’s writer proposal still does not solve the hard part at the substrate boundary: who reliably knows both ids on the public pg-boss surface. That means Goal 3 should still answer the substrate question honestly and avoid promoting an application-side convention into a first-class API unless there is a concrete consumer ready to use it.

## Open question A1 — Writer or document?
**My answer:** document the gap now. The writer is technically cheap, but it is not a substrate capability; it is an opt-in application bookkeeping hook that only works if the consumer already solved the identity problem outside pg-bossier.

**Naming if writing:** `recordDeadLetter` as new sibling

**Counter to the other camp:** The strongest point from Opus/Sonnet is that the writer costs no schema change and preserves KISS. I still would not ship it in this PR because it creates a misleading sense that pg-bossier “supports DLQ lineage” when the public pg-boss contract still does not give most consumers the source↔DLQ mapping in the first place. Sonnet’s “extend `recordTerminalDetail` with `deadLetteredAs`” is especially weak to me because it overloads a generic writer with a very specific lineage semantic and makes the API shape less legible.

## Open question A2 — Ship findDeadLetterSource read?
**My answer:** no

**Why:** A reverse lookup only pays off if the writer exists and is actually used; otherwise it is just an index-backed query over mostly-empty data. The descent-app forensic use-case is real only when an operator lands on a DLQ job and needs the original failure chain, but that is the second half of an opt-in feature, not something I would ship ahead of proven writer adoption.

## Open question A3 — Reserved data-key convention
**My answer:** no reject

**Why:** Gemini’s reserved-key convention pushes lineage metadata into `data`, which is the one field consumers most reasonably treat as business payload, not substrate control plane. That leaks pg-bossier concerns into every producer, invites accidental collisions and silent drift, and still does not remove the need for disciplined application bookkeeping. It is worse than a writer API because it couples capture behavior to a magic payload key and makes provenance dependent on mutating user data shape.

## Open question B1 — Capture singleton_key column
**My answer:** yes separate issue

**Why:** Sonnet is right that a nullable plain `singleton_key` column would make singleton forensics cheaper and cleaner than JSONB-path querying, and it is a legitimate observational improvement even if “supersession” is not real. But it does not belong in this Goal 3 answer, because Decision B settled on “there is no displacement event to model,” and this column is a separate capture-surface enhancement, not part of the resolution.

## Open question C1 — Skip housekeeping UPDATEs
**My answer:** separate issue

**Why:** It may be a real signal-quality improvement, but it is not required to answer Decision C, which is about reschedule semantics, not record-volume pruning.

## Anything I want to flag that the synthesis must not lose
- Opus’s proposed writer is not wrong; it is just a different product decision. If the project wants an app-layer convenience hook, `recordDeadLetter` is the cleaner shape than smuggling `deadLetteredAs` through `recordTerminalDetail`.
- Sonnet’s new CTE fact closes the door on any “maybe the trigger can see enough within the same statement” argument. The source `failed` trigger fires before the DLQ row exists.
- Gemini’s reserved-key idea should not be framed as “free opt-in lineage.” It externalizes substrate bookkeeping into arbitrary payloads and makes the capture contract more fragile, not less.
