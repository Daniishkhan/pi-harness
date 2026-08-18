# Database review checklist

Adversarial review of schema changes and data-access code in the diff. Read the migrations, the schema source of truth, and every query the diff adds or changes. Assume there is a data-corruption bug hiding in here and find it.

## Schema semantics

- NULL meaning per new column: is "no value" a real state, or an accident? Should it be NOT NULL with a default?
- Types: money in integer/numeric (never float), timestamps with timezone, IDs right-sized.
- Defaults: correct for existing rows after the backfill, or do old rows silently get a different meaning than new rows?

## Integrity

- Foreign keys present? Delete behavior (cascade / restrict / set null) matches ownership? Can rows be orphaned?
- Unique constraints match the business rules, or is uniqueness "handled in app code" (it isn't, under concurrency)?
- Second source of truth: is the same fact now stored in two places that can drift apart?
- State machines: all states enumerated? Any state with no exit path? Are transitions validated in the DB or only in app code?

## Indexes & queries

- Read the actual queries the diff adds. Is there an index per real query pattern? Composite columns in the right order (equality first, then range)?
- New indexes on write-hot tables: justified by a query that exists, or speculative?
- Unbounded queries: missing LIMIT/pagination, SELECT *, N+1 — read the calling code for loops with queries inside.
- Transactions: scoped as small as possible? Any external calls (HTTP, queues) made while holding a transaction open?

## Migration safety

- Does it run against realistic production data volume? Table rewrites or long locks (adding a column with a volatile default, changing a type) on big tables?
- Reversible or one-way? If one-way, is that acknowledged anywhere?
- Backfill: batched? What state are rows in while the migration is half-done?
- Deploy order: does the app code work both before and after the migration runs?

## Data operations

- Are writes idempotent? Does a retry double-apply anything (charges, counters, notifications)?
- Concurrent writers: race conditions, missing upserts, or unique constraints that should back them?
