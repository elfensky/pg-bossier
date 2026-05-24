# Round 2 — Goal 3 retry history lineage (pg-bossier)

Round 1 produced strong convergence on the *what-the-substrate-can-do* questions and surfaced one new fact that changes Decision A's framing. Read the four Round 1 answers below, then **refine your position** with the new information in mind.

## What Round 1 established (strong agreement, four-of-four)

- **Decision A (trigger detection):** the capture trigger **cannot** auto-populate a source→DLQ link using only pg-boss public columns. **New load-bearing fact from Sonnet (read out of `pg-boss/src/plans.js`):** the DLQ INSERT lives in a `dlq_jobs` CTE that runs *after* `failed_jobs` in the **same SQL statement**. So the trigger on the source's failed row fires *before* the DLQ row exists — even if we wanted to write `{ deadLetteredAs: <dlqId> }` to `terminal_detail` automatically, the trigger doesn't yet have the DLQ id.

- **Decision B (singleton):** no pg-boss 12 mechanism actually displaces an existing job. `ON CONFLICT DO NOTHING` on the `(name, singleton_on, COALESCE(singleton_key, ''))` unique index (`job_i4`) drops the **newcomer**, never the incumbent (`pg-boss/src/plans.js`). `singletonKey`, `singletonSeconds`, `singleton`, `short`, `stately`, `exclusive` all behave this way. `useSingletonQueue` is not part of the pg-boss 12 type surface.

- **Decision C (reschedule):** answer (a) — same row-version of the same id. No marker. All four agree.

## Where you may still disagree (this is where Round 2 work is)

### Open question A1 — Ship the writer API, or document the gap?

Two camps in Round 1:
- **Gemini, Codex:** Decision A = Option 4 ("do nothing"). Document the gap; defer the writer until pg-boss exposes a public source-id or a real consumer request lands.
- **Opus, Sonnet:** ship an **opt-in writer** — Opus calls it `bossier.recordDeadLetter({ sourceJobId, dlqJobId })`; Sonnet routes it through the existing `recordTerminalDetail` writer with `{ deadLetteredAs }`. Storage in `terminal_detail` on the source's last `failed` row.

**Refine:** if you're in the "document" camp, do you change position now that Opus/Sonnet have proposed a concrete writer that costs no schema change and no trigger work? If you're in the "ship the writer" camp, do you ship `recordDeadLetter` as a new sibling method, or extend `recordTerminalDetail` to accept `deadLetteredAs`? Pick one. Name it.

### Open question A2 — Reverse lookup `findDeadLetterSource(dlqJobId)`?

Both Opus and Sonnet propose a sibling read (`getDeadLetterSource` / `findDeadLetterSource`) that scans `pgbossier.record` for `terminal_detail @> '{"deadLetteredAs": <id>}'` using the existing `record_terminal_detail_gin` index. Gemini and Codex didn't address this.

**Refine:** is this read worth shipping in the same PR as the writer? What's the descent-app forensic use-case it actually solves?

### Open question B1 — Capture `singleton_key` as a plain column?

Sonnet's Round 1 bonus: "the capture trigger currently does not write `singleton_key` into `pgbossier.record`. Adding it as a plain nullable column is a small, non-breaking schema addition that would make singleton forensics (and any future supersession analysis) trivially queryable without a JSONB GIN path."

**Refine:** does this earn its keep under KISS, given Decision B = "ignore supersession"? Or is it an unrelated improvement that should live in a separate issue?

### Open question A3 — Gemini's "reserved data key" convention

Gemini's Round 1 bonus: pg-bossier documents a reserved key in the `data` payload (e.g., `_pgbossier_source_id`). If the trigger detects this key in a new INSERT, it auto-populates a `source_id` column. Enables opt-in lineage without forking.

**Refine:** is this a better shape than the writer API? It moves the consumer's bookkeeping into the `data` they already control. Critique it.

### Open question C1 — Skip housekeeping-only UPDATEs?

Gemini's Round 1 bonus: "the trigger should skip writing a new `record` row if *only* `keepuntil` or `expireat` changed." Not strictly a Goal 3 question, but if it lands the answer to Decision C should account for it.

**Refine:** scope creep or genuine improvement?

## Constraints (unchanged from Round 1, restated for completeness)

- No fork of pg-boss; public JS API + transitional reads only.
- KISS — three lines beat an abstraction.
- Fail-open writes.
- Composition not replacement.
- No backfill obligation by default.

## Response format

~600–800 words.

```
## My position changes (or doesn't) since Round 1
[2-4 sentences. If you change a position, say which decision and why. If you don't, say what you're holding firm on and why the others' arguments don't move you.]

## Open question A1 — Writer or document?
**My answer:** [pick one + 2 sentences]
**Naming if writing:** [recordDeadLetter as new sibling | extend recordTerminalDetail with deadLetteredAs field]
**Counter to the other camp:** [1-2 sentences naming the strongest opposing point and why it doesn't move you]

## Open question A2 — Ship findDeadLetterSource read?
**My answer:** [yes ship now | yes but later | no]
**Why:** [1-2 sentences, tie to descent-app use case]

## Open question A3 — Reserved data-key convention
**My answer:** [yes adopt | no reject | combine with writer]
**Why:** [1-2 sentences with concrete critique]

## Open question B1 — Capture singleton_key column
**My answer:** [yes in this PR | yes separate issue | no don't bother]
**Why:** [1-2 sentences]

## Open question C1 — Skip housekeeping UPDATEs
**My answer:** [in scope here | separate issue | reject]
**Why:** [1 sentence]

## Anything I want to flag that the synthesis must not lose
[optional, 1-3 bullets]
```

Be sharp. If you disagree with another participant's specific claim, name the participant and the claim. Don't restate everything — the synthesis will see all four answers.

---

# Round 1 answers (verbatim)

## 🟡 Gemini — Round 1

```
${GEMINI_ROUND_1}
```

## 🔴 Codex — Round 1

```
${CODEX_ROUND_1}
```

## 🟠 Sonnet — Round 1

```
${SONNET_ROUND_1}
```

## 🐙 Opus — Round 1

```
${OPUS_ROUND_1}
```
