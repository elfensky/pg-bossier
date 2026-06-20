## My position changes (or doesn't) since Round 1

I'm moving on A1: I previously said "route through `recordTerminalDetail`" but Opus's argument for a dedicated `recordDeadLetter` method is structurally correct, and I'll explain why below. Decisions B, C, and Decision A's overall approach (application-layer opt-in, no schema change) are unchanged — the four-of-four agreement on trigger limitations is solid and I have nothing to revise there.

## Open question A1 — Writer or document?

**My answer:** Ship the writer. Gemini and Codex's "document the gap" position was correct when we thought detection was the only path; now that Opus has proposed a clean application-layer API that costs nothing at the schema level, the cost/benefit flips. The gap is real but a writer API makes it bridgeable. If descent-app's DLQ handler knows both IDs (it does — the DLQ worker receives the DLQ job and can look up the source by its own bookkeeping or the `data` shape), calling one method is not a burden. Silent absence of the link is worse than opting in consciously.

**Naming if writing:** `recordDeadLetter` as a **new sibling method**, not an extension of `recordTerminalDetail`. Here's why this matters concretely: `recordTerminalDetail` requires `attempt` as a key and enforces `class` on `failed` state. `recordDeadLetter` needs a different key (`sourceJobId`, `dlqJobId`) and a different storage address — it should UPDATE `terminal_detail` on the source's last `failed` row by job-id alone, without the caller being forced to track the attempt number. Forcing `deadLetteredAs` into `recordTerminalDetail` means the caller must supply `attempt`, which they almost certainly don't have at DLQ-handler time. That friction alone kills adoption. Opus is right: `recordDeadLetter({ sourceJobId, dlqJobId })` matches the naming convention and keeps the call site clean.

**Counter to the other camp:** Gemini and Codex say "defer until a real consumer request lands." The counter is that descent-app *is* the real consumer, and once it processes DLQ jobs it will immediately want to answer "what original job is this?" A method that takes 30 lines to implement now saves a raw-SQL workaround later. I was already in the "ship" camp; I'm just sharpening the method boundary.

## Open question A2 — Ship findDeadLetterSource read?

**My answer:** Yes, ship it in the same PR as the writer.

**Why:** The writer and the read are one unit of utility. Without `findDeadLetterSource(dlqJobId)`, the only way to use `recordDeadLetter`'s output is to write a raw GIN-path query against `pgbossier.record`. The descent-app forensic use-case is: "we received job X from the DLQ queue — what failed job originated it, and what was its full retry history?" That's one call to `findDeadLetterSource(dlqJobId)` to get `sourceJobId`, then `getRetryHistory(sourceJobId)`. The `record_terminal_detail_gin` index already exists; the implementation is a two-line WHERE clause. Not shipping the read in the same PR leaves the feature half-usable.

## Open question A3 — Reserved data-key convention

**My answer:** Reject it.

**Why:** Gemini's `_pgbossier_source_id` convention pollutes the job's `data` payload with infrastructure bookkeeping. The `data` field is the consumer's application payload — pg-boss reserves the right to evolve its schema; consumers may validate or transform it. More importantly, it creates a trigger-time dependency on a convention the trigger enforces: if the trigger tries to promote `_pgbossier_source_id` from `NEW.data` into a `source_id` column, it is reading from a JSONB field that no pg-boss column contract defines, and it fires on every INSERT — including inserts that have nothing to do with DLQ lineage. The trigger is already doing enough work. The writer API (`recordDeadLetter`) is cleaner: it is explicit, it is opt-in, it does not contaminate the application payload, and it is testable in isolation.

## Open question B1 — Capture singleton_key column

**My answer:** Yes, but in a separate issue.

**Why:** The capture trigger reading `singleton_key` from `pgboss.job` is a legitimate transitional-tier column (it's a top-level column, not a JSONB value). Adding it to `pgbossier.record` as a nullable text column is a non-breaking schema addition that earns its keep for exactly the forensic pattern Codex named: "correlate by `singletonKey`." But it is unrelated to Goal 3's core questions (supersession doesn't exist; DLQ lineage is the main deliverable). KISS says: don't stretch this PR. Open a narrow issue for `singleton_key` capture, add `COMPATIBILITY.md` coverage noting it as a transitional read, and merge it independently.

## Open question C1 — Skip housekeeping UPDATEs

**My answer:** Separate issue.

**Why:** It's a genuine trigger optimization but it touches trigger logic that is not scoped to Goal 3. Adding `keepuntil`/`expireat`-only skip logic mid-PR introduces a new correctness surface (what else might be housekeeping-only?) and needs its own test coverage. Track it independently.

## Anything I want to flag that the synthesis must not lose

- `recordDeadLetter({ sourceJobId, dlqJobId })` must NOT require `attempt` from the caller. It should resolve the last `failed` attempt for `sourceJobId` internally (a simple `ORDER BY attempt DESC LIMIT 1` subquery in the UPDATE). Callers at DLQ-handler time never have the attempt count.
- The writer must be fail-open (log, don't throw) consistent with Goal 1's audit-write semantics. If the UPDATE matches zero rows (wrong `sourceJobId`, or source row was purged), silent no-op is correct behavior — document it loudly.
- Gemini's `pgbossier.link` table idea (a separate link relation) is more infrastructure than this problem warrants. `terminal_detail` JSONB on the source row is the right location — one row, one place, GIN-indexed already.
