# Paper study

Use this route to turn a paper into a testable mental model rather than a prose summary.

## Establish the source

- Locate the canonical paper, version and date, authors, DOI or archive identifier, supplementary material, corrections, datasets, and official code when available.
- Record the exact version studied. Note when a repository or blog post targets a different revision.
- Prefer the paper and primary artifacts over secondary explanations. Use secondary sources to find critiques or alternative interpretations, then verify their claims.

## Read in layers

1. Identify the problem, claimed contribution, comparison point, and intended operating conditions.
2. Extract the mechanism: inputs, outputs, objective, assumptions, algorithm, architecture, data path, and computational requirements.
3. Inspect evaluation design: datasets and splits, baselines, metrics, ablations, sample counts, uncertainty, leakage risks, hardware, and reported resource cost.
4. Record limitations, negative results, threats to validity, and claims that the evidence does not directly test.

Translate important equations or procedures into plain-language invariants and small executable checks. Preserve symbols and units where ambiguity would matter.

## Build a claim ledger

Add a table to `LAB.md` with these columns:

| Claim | Source location | Evidence offered | Conditions and assumptions | Confidence | Reproduction target |
|---|---|---|---|---|---|

Classify each entry as:

- **reported**: the source states it;
- **derived**: it follows from cited evidence or mathematics;
- **interpreted**: it is your reading of the source;
- **hypothesized**: it still needs a test.

Select only the claims needed for the learning objective. Do not reproduce an entire paper merely because it is available.

## Compare paper and implementation

Map each selected claim to the relevant code entry point, configuration, preprocessing, data split, checkpoint, metric implementation, and test. Record divergences such as undocumented defaults, changed dependencies, missing preprocessing, different seeds, or evaluation code that postdates the paper.

Treat agreement between prose and code as consistency, not independent confirmation. Prefer an observable invariant or controlled experiment for validation.

## Complete the study

The paper-study route is complete when `LAB.md` contains:

- a concise mechanism model;
- a bounded claim ledger with source locations;
- assumptions and validity limits;
- at least one observable check for every selected claim;
- explained gaps between paper, code, and observed behavior;
- remaining uncertainty and the next discriminating experiment.
