# Technology reproduction

Use this route to implement or reproduce an unfamiliar technology as a sequence of observable, reversible steps.

## Define the target

Choose the smallest vertical slice that demonstrates the mechanism, not a production clone. Specify:

- input and expected output;
- reference behavior or metric;
- supported platform and resource ceiling;
- features deliberately excluded;
- the command, test, trace, or artifact that proves completion.

When following a paper, reproduce one selected claim before attempting the headline benchmark.

## Intake external materials safely

Before running downloaded code, inspect its license, revision, dependency manifests and lockfiles, build and install scripts, Git hooks, notebooks, container definitions, model or data downloaders, expected network access, and write locations. Prefer a disposable container or virtual environment. Do not run opaque binaries, remote shell pipelines, privileged installers, or code requiring production credentials.

Record URLs, commit IDs, checksums, dataset versions and splits, checkpoint identity, and any local patch. Pin dependencies when practical; otherwise record the resolver output exactly.

## Build in stages

1. Verify the runtime with a trivial smoke test.
2. Run one known example from the authoritative source without modification.
3. Create a tiny independent fixture or synthetic case that exposes the core mechanism.
4. Establish the simplest baseline and confirm the metric or assertion itself is trustworthy.
5. Implement or adapt one component at a time, keeping intermediate outputs observable.
6. Test the selected target claim.
7. Only then evaluate sensitivity, scale, performance, or additional features.

For ML work, record seeds, determinism settings, hardware, driver and framework versions, precision or dtype, preprocessing, data split hashes, checkpoint hashes, batch size, evaluation mode, and wall-clock or accelerator use. Report variation across runs when a single seed is not meaningful.

## Diagnose discrepancies

When behavior differs from the reference, list competing hypotheses and run the cheapest discriminating check. Common sources include version drift, data or preprocessing differences, hidden defaults, nondeterminism, metric mismatch, train/eval mode, checkpoint conversion, numerical precision, hardware kernels, and undocumented post-publication changes.

Do not tune until a result matches without recording each change and its rationale. Do not discard a failed run that changes the conclusion.

## Complete the reproduction

The reproduction is complete when a fresh reader can use `LAB.md` to identify the exact source and environment, run the minimal path, observe the result, compare it with the reference, and understand every material deviation. If the target cannot be reproduced within the boundary, finish with a narrowed cause, preserved failure evidence, and the next experiment most likely to resolve it.
