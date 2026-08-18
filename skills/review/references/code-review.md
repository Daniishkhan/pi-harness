# Code review checklist

Adversarial review of the implementation in the diff. Judge it against the whole codebase, not the diff in isolation.

## Correctness against intent

- Does it actually do the stated intent? Trace the main path end to end — don't trust that it works.
- Edge cases: empty input, boundary values, already-exists, not-found, concurrent calls.
- Error paths: swallowed errors, catch-and-continue, partial failure leaving bad state behind.

## Duplication (search repo-wide — this is a known pain point)

- Search the repo for the nouns and verbs in the diff. Does an existing module, helper, endpoint, or job already do this, or 80% of it? Name the path.
- Copy-pasted logic with small variations: should it be shared, or is the variation real?
- New utility that mirrors something in a shared package or sibling module?
- Near-duplicate types/interfaces/models for the same domain concept — which one is canonical now?

## Complexity & engineering load

- Abstractions with exactly one caller. Configurability nobody asked for. "Generic" code with one use case.
- What can be deleted? Dead branches, unused exports, scaffolding for a future that isn't scheduled.
- New dependency: justified, or replaceable with 20 lines of code?
- Which part will need a 10-minute explanation to a teammate in 3 months? That's the part to simplify.
- Does the diff grow a god-module, or does it put logic where a newcomer would look for it first?

## Performance

- Hot paths: work inside loops that could be hoisted or batched; unnecessary serialization of independent async work; sync I/O in async paths.
- Chatty patterns: per-item DB/HTTP calls that could be one batched call.
- Caching added without an invalidation story — or the same expensive value recomputed per request with no caching.
- Obvious waste on large data: full copies, repeated parsing, loading everything to filter in memory.

## Failure modes & integration

- External calls: timeouts set? Retries bounded and idempotent? What's the user-facing state when the dependency is down?
- New endpoints: authorization checked? Input validated at the boundary, not deep in the call stack?
- Errors surfaced to users: understandable and actionable, or raw exceptions?
