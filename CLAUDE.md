# weborder_ai

Replenishment allocation pipeline for Earthbound Trading Co. - see `docs/README.md` first,
it indexes the full project context (`overview.md`, `data-sources.md`, `business-rules.md`,
`open-questions.md`, `progress-log.md`). That folder is the source of truth; don't duplicate
its content here.

## Keeping in sync

Netto and Wesley both work in this repo, from separate machines. Whichever of them you're
working with, commit and push meaningful changes promptly, and in any case at least once a
week, so both copies stay in sync. Update `docs/progress-log.md` (append, don't rewrite) as
part of any session where something meaningful got built or decided.

## Working with Wesley

Wesley runs the weekly replenishment process manually today and is the primary source of
truth for business rules. If something in `docs/open-questions.md` needs a business-rule
answer (e.g. in-transit quantity source, on-hand source confirmation), it's fine to ask him
directly - don't guess. When a data point really is missing, pick a reasonable placeholder,
flag it clearly (in code comments and in `open-questions.md`), and keep moving rather than
blocking on an answer.
