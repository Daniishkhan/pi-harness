# Test & failure-handling review checklist

Adversarial review of the diff's tests and of how the feature behaves when things go wrong. Known pain point: bloated tests that cost maintenance without catching bugs.

## Bloat

- Tests asserting implementation details — internal call sequences, mock choreography — that break on any refactor without a behavior change.
- Tests of framework or library behavior (does the ORM save, does the router route, does validation library validate).
- The same behavior asserted at multiple layers (unit + integration + e2e of the identical path). Pick the cheapest layer that proves it.
- Setup ten times the size of the assertion. Snapshot tests that will be blindly regenerated on any change.
- Helper abstractions inside tests that hide what is actually being tested.

## Gaps

- Invariants that could silently corrupt data — money math, state transitions, permissions — are they tested?
- Error paths tested, or only the happy path?
- Boundary values, already-exists, and not-found cases.
- Concurrency where it matters: two simultaneous requests doing the same write.

## Reliability

- Time, randomness, execution order, shared state between tests — flakiness sources.
- Does each test name describe a behavior, and does the assertion actually match the name?

## Feature failure handling

- For each external interaction in the diff: timeout, 5xx, malformed response — is there explicit handling, and ideally a test?
- Retries: is idempotency tested, or just assumed?
- What does the user see when the feature fails halfway — and is there anything asserting that state?
