# Weborder AI - project context

This folder exists so a new Claude session (or a new person) can pick this project up
without re-deriving everything from scratch. Read these in order:

1. **`overview.md`** - what this project is, who it's for, the business process being automated.
2. **`data-sources.md`** - every table/view we rely on, in `EBTAI` (ours) and `EBT` (source), with the
   non-obvious gotchas discovered along the way (join keys, performance traps, data quirks).
3. **`business-rules.md`** - the exclusion rules and allocation math, translated from Wesley's
   Access/Excel process into SQL.
4. **`open-questions.md`** - things we don't have answers for yet. Check this before assuming
   how something should work.
5. **`progress-log.md`** - dated log of what was built/decided in each session, oldest first.
   Append to this, don't rewrite history.

## Quick facts
- Our schema/database to build in: `EBTAI` (empty when we started - now holds the tables/views
  described in `data-sources.md`).
- Read access to `EBT` (the real operational DB - 813 tables/views) and `EBTGOOGLE`. No access to
  SAP directly - everything needed is (or will be) replicated into SQL Server.
- Primary contact for business rules: Wesley (does this process manually today, every Sunday).
