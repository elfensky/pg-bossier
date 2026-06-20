# Round 1 — Adversarial spec review

You are reviewing the **Goal 2 design spec** for pg-bossier, a JS/TS library that layers on top of [pg-boss](https://github.com/timgit/pg-boss) to provide an operational data plane.

**Spec under review:**
`docs/superpowers/specs/2026-05-23-goal-2-terminal-state-detail-design.md`

**Project context (read before answering):**
- `CLAUDE.md` — project guidance, constraints, non-goals.
- `COMPATIBILITY.md` — pg-boss compatibility tier system.
- `src/record.ts`, `src/read.ts`, `src/progress.ts`, `src/client.ts` — current shape of the code Goal 2 modifies.
- Goal 2 tracking issue: [#3](https://github.com/elfensky/pg-bossier/issues/3).
- Charter: [issue #1](https://github.com/elfensky/pg-bossier/issues/1).

**Existing precedents the spec leans on:**
- Goal 6's `setProgress` pattern (`src/progress.ts`) — separate method, sole writer for `progress`.
- Goal 9's schema validation pattern — plain `Error` with prefixed messages.
- Goal 7's spec adversarial review structure — completed; see `docs/superpowers/archive/2026-05-23-goal-7-spec-adversarial-review/`.

## Your job

Read the spec critically. Identify problems that would block merge, problems that should land before merge but aren't blockers, and problems that can defer to follow-ups. Be specific — name files, sections, line numbers where you can.

Focus particularly on:

1. **Correctness gaps** — does the design ship what it promises? Are there scenarios it claims to handle that the code shape can't actually handle? Pay close attention to:
   - Race conditions between pg-boss's DELETE+INSERT retry path and `recordTerminalDetail`.
   - The single-writer convention's strength — is it really sufficient as the only enforcement?
   - The `state` parameter's redundancy with the existing row's `state` column.
   - JSONB shape assumptions vs what pg actually returns.
2. **Compatibility risks** — does Goal 2 add any pg-boss surface that's not in `COMPATIBILITY.md`'s current tier list? The spec claims zero new surfaces — challenge that.
3. **The five open questions** in the spec's "Open questions for adversarial review" section. Take a position on each. Don't just say "interesting tradeoff" — pick.
4. **Industry comparison** — is the spec's claim about industry patterns (Sentry, OTel, AWS SDK, Bull) accurate? Are there other libraries that solve this kind of problem differently in ways the spec missed?
5. **Scope creep risks** — the "out of scope" list defers six items. Are any of them actually load-bearing for v1?
6. **Type-system claims** — does the discriminated-union narrowing actually work as drawn? Is `TerminalDetailFailed & Record<string, unknown>` sound TypeScript or does it have edge cases that defeat the narrowing?
7. **Test plan adequacy** — are tests 1-10 sufficient? What scenarios are missing?

## Output format

Structure your response as:

```
## Verdict
SHIP / SHIP-WITH-NAMED-CHANGES / BLOCK-UNTIL

## Must-land changes (blockers)
1. ...
2. ...

## Should-land in v1 (not blockers, but cheap)
1. ...
2. ...

## Defer to follow-up
1. ...

## Positions on the five open questions
1. state parameter: KEEP / DROP — reasoning
2. Error class: PLAIN / TYPED — reasoning
3. Date handling: STRICT-JSON / ACCEPT-DATE — reasoning
4. Migration guide: README / NEW-FILE — reasoning
5. Idempotency: LAST-WRITER-WINS / IDEMPOTENT — reasoning

## Industry-comparison challenges
(any places where the spec's claims about Sentry/OTel/AWS SDK/Bull are wrong or oversimplified)

## Anything the spec missed entirely
```

Be concrete. "The validation is wrong" is useless; "Section A's validation accepts arrays because Array.isArray comes back as 'object' and the check uses typeof" is useful.
