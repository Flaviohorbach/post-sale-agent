# AI log: what the agent got wrong

Built with a coding agent (Claude Code), as in [project 5](https://github.com/Flaviohorbach/legacy-storefront-refactor). These happened while building this project.

### 1. A connection error that would have crashed production

The agent created `pg.Pool` without an `error` listener. Neon closes idle connections, and an idle client's error with no listener ends the Node process. Unit tests never showed it, since nothing stayed idle long enough. **Caught by:** the persistence test, which passed but reported uncaught errors while its database was shutting down. A green result with errors under it is not green. **Fix:** a listener on both pools.

### 2. A node named like a state field

LangGraph refuses a node called `triage` when the state has a `triage` field, and all 12 graph tests failed while building the graph. **Caught by:** the tests. **Fix:** the node is now `classify`.

### 3. Blaming the new code for a machine problem

The first screen test hung on "Compiling", and the agent spent time removing the new API routes to find the culprit. Then a project that had built fine the day before hung the same way. Only Turbopack was affected on this machine, with little free memory, and a webpack build finished. The cause of the hang is still unknown. **Caught by:** building a known-good project as a control, which should have been the first step. **Fix:** none needed in the code. Local tests used webpack, and CI and Vercel build on their own machines.

### 4. Amounts in the wrong format

The record said "R$ 714.90", in a page where every other amount says "R$ 714,90". **Caught by:** reading the screen after the first real run. **Fix:** one shared formatter. That fix had its own bug: the cleanup for recorded examples turned a customer's "R$ 5.000,00" into "R$ 5,000,00", and the formatter left "R$ 10999,90" without a thousands separator. **Caught by:** reading the live demo and listing every amount in the examples. **Fix:** a stricter pattern and grouped thousands.

### 5. A perfect score over an invented fact

The first evaluation scored 12 of 12, and one passing answer said the frying pan does not come in other colors, with no data on colors. The agent's rules cover actions and amounts, not every claim, and the reviewer agent approved it. **Caught by:** reading all twelve answers. **Fix:** an instruction to escalate what the data cannot answer, plus a rule for this case, and a rerun of only that case. The README says the score includes this fix made after seeing the result.

### 6. Assuming the reviewer would help

The plan treated a reviewer agent as an obvious quality gain. In this run it sent back one proposal, arguably wrongly, and missed the invented fact, at a call per case. **Caught by:** counting what it did in the results. **Fix:** kept, since the user chose three agents and one run is thin evidence, but the README reports it instead of implying it pays off.

### 7. An unexplained test failure

Test setup failed twice while the machine was busy, always before any test ran, and then passed. The timeout was raised on the likely cause, a 10-second limit on starting a database and an MCP process, but the failure's message was never captured, so the cause is not proven. **Caught by:** the test run. **Fix:** `hookTimeout`, with CI as the next check.

## What needed a human

- Choosing three agents from the start, accepting a higher cost per case in exchange for the multi-agent pattern.
- Choosing Postgres for paused cases, so an approval can arrive on another server instance.
