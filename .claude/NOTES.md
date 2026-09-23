# Session notes (portable across devices)

This file holds context about *how the user works on this repo* that doesn't belong in
`CLAUDE.md`/`PLAN.md` (architecture/roadmap) but should still travel with the repo via git,
not live only in one machine's local Claude memory. Read this alongside `CLAUDE.md`.

## How the user works

- Gives short directives ("do all", "you can decide", "yes", "continue") and expects sensible
  calls to be made without re-litigating settled decisions - see `PLAN.md`'s own "Decisions
  already made" section.
- Wants real verification, not just unit tests: a real Chromium Playwright run is mandatory for
  anything touching workers/SAB/`eval` before calling a phase done (see `CLAUDE.md`'s
  "Verifying").
- For a big, multi-piece task (e.g. Phase 7's fetcher worker / OPFS persistence / real npm), ask
  once which piece to start with rather than assuming - the user has consistently picked the
  smaller, more self-contained piece first over the largest one.
- No Claude/AI attribution anywhere in this repo's git history - see `CLAUDE.md`'s Conventions
  section. This was already enforced once by rewriting history; don't reintroduce it.

## Where things stand (update this section as work progresses)

Phase 7 (`PLAN.md`): Fetcher Worker and OPFS persistence are done. Real npm is not started - see
`PLAN.md`'s own "Real npm: feasibility findings" subsection under Phase 7 for the investigation
(missing `zlib`/`crypto` bindings, no real internet access from wcvm's virtual `net`/`http`, but
guest scripts already have real `fetch`/`CompressionStream`/`crypto.subtle` as globals). Pick up
there before writing any real-npm code.

The playground (`examples/playground`) has a small interactive demo wired up
(`src/exampleServer.ts`): a real Node http server, spawned on click, shown live in the existing
preview pane.
