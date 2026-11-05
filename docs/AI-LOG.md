# AI log: what the agent got wrong

Built with a coding agent (Claude Code), as in [project 5](https://github.com/Flaviohorbach/legacy-storefront-refactor). These happened while building this project.

### 1. A connection error that would have crashed production

The agent created `pg.Pool` without an `error` listener. Neon closes idle connections, and an idle client's error with no listener ends the Node process. Unit tests never showed it, since nothing stayed idle long enough. **Caught by:** the persistence test, which passed but reported uncaught errors while its database was shutting down. A green result with errors under it is not green. **Fix:** a listener on both pools.

### 2. A node named like a state field

LangGraph refuses a node called `triage` when the state has a `triage` field, and all 12 graph tests failed while building the graph. **Caught by:** the tests. **Fix:** the node is now `classify`.

### 3. Blaming the new code for a machine problem

The first screen test hung on "Compiling", and the agent spent time removing the new API routes to find the culprit. Then a project that had built fine the day before hung the same way. Only Turbopack was affected on this machine, with little free memory, and a webpack build finished. The cause of the hang is still unknown. **Caught by:** building a known-good project as a control, which should have been the first step. **Fix:** none needed in the code. Local tests used webpack, and CI and Vercel build on their own machines.

### 4. Amounts in the wrong format

The record said "R$ 714.90", in a page where every other amount says "R$ 714,90". **Caught by:** reading the screen after the first real run. **Fix:** one shared formatter.

## What needed a human

- Choosing three agents from the start, accepting a higher cost per case in exchange for the multi-agent pattern.
- Choosing Postgres for paused cases, so an approval can arrive on another server instance.
