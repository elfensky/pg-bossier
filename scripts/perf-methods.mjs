// perf-methods.mjs — Single source of truth for the canonical method_id
// per variant_label produced by test/perf/chronicle-scale.bench.ts.
//
// method_id is the HISTORICAL key — once a bench appends a record with a
// given method_id, it must never be renamed. variant_label may change in
// the bench file without breaking trend continuity, but adding a new bench
// or removing one requires updating this map AND documenting the
// discontinuity in PERFORMANCE.md.
//
// Imported by both scripts/perf-write.mjs (appender) and
// scripts/perf-compare.mjs (PR comparer) so the mapping never drifts
// between them.

export const METHOD_IDS = new Map([
  ['findById(known)',                'findById:known'],
  ['findById(unknown)',              'findById:unknown'],
  ['getRetryHistory(known)',         'getRetryHistory:known'],
  ['listJobs({})',                   'listJobs:default'],
  ["listJobs({state:'completed'})",  'listJobs:state-completed'],
  ["listJobs({queue:'perf-queue'})", 'listJobs:queue'],
  ["latestPerQueue(['perf-queue'])", 'latestPerQueue:single'],
  ['countByState({})',               'countByState:default'],
  ['countByQueue({})',               'countByQueue:default'],
  ['listLongRunning({900})',         'listLongRunning:900s'],
]);
