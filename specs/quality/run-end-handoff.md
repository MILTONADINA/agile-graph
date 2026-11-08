# Run-end next steps, re-check cycles and honest estimates

- ID: run-end-handoff
- Status: implemented
- Area: quality
- Epic: Self-improving team

## Problem

A run that ends with known fixable defects must not hand them to the person as
recommendations: the graph owns what it can fix, and only approvals,
credentials, spending and decisions belong to a person. Each re-check cycle of
a gate costs minutes, which compound when a fix surfaces another defect, and a
time estimate that does not say what remains reads as readiness. Issues #163
and #164 ask that the run record and the report make each of these visible.

## Acceptance criteria

Written in EARS form (ubiquitous, event-driven, state-driven and unwanted
behaviour clauses).

- AC1: The system shall classify every stop kind and every human-acceptance wait as one of `approval`, `credential`, `spending` or `decision`, or as `graph`, and shall hold those four person reasons as a closed set.
  - Test: packages/engine/tests/run-end-handoff.test.ts :: holds exactly the four person reasons, the last named decision
  - Test: packages/engine/tests/retro.test.ts :: classifies every stop kind as a person reason or the graph's own
- AC2: When a run ends on a stop with no reason, or with a message that names no known kind, the system shall count that stop as graph-owned and shall not count it as deferred to the person.
  - Test: packages/engine/tests/run-end-handoff.test.ts :: keeps a stop with no reason with the graph, not the person
  - Test: packages/engine/tests/run-end-handoff.test.ts :: keeps a stop whose message names no known kind with the graph
- AC3: When a run ends on a graph-owned stop that no follow-up plan names, the system shall report it as `graphOwnedWithoutFollowUp` for that run and in the totals.
  - Test: packages/engine/tests/retro.test.ts :: counts a graph-owned terminal stop with no follow-up plan as 1
- AC4: When a verification, review or security scan of a step starts after an earlier scan of the same phase and step in that run, the system shall count it as a re-check cycle.
  - Test: packages/engine/tests/run-end-handoff.test.ts :: records each re-check cycle's minutes, per phase, in order
- AC5: When a re-check cycle finishes, the system shall record its minutes in the run's retro, labelled with its phase, in the order the cycles finished.
  - Test: packages/engine/tests/run-end-handoff.test.ts :: records each re-check cycle's minutes, per phase, in order
- AC6: When a stop cuts a re-check cycle short, the system shall count the cycle and record no minutes for it.
  - Test: packages/engine/tests/run-end-handoff.test.ts :: counts a cycle a stop cut short, with no minutes
- AC7: While a worker repeats an attempt or a step's first scan runs, the system shall not count them as re-check cycles.
  - Test: packages/engine/tests/run-end-handoff.test.ts :: does not count a worker's repeated attempts or a step's first scan as re-checks
- AC8: The report shall give the re-check cycles, their total minutes and their median minutes per cycle, in the totals and in each run's retro.
  - Test: packages/engine/tests/run-end-handoff.test.ts :: totals cycles, minutes and the median minutes per cycle across runs
- AC9: When a run record was made before the re-check fields existed, the system shall read it as zero re-check cycles.
  - Test: packages/engine/tests/run-end-handoff.test.ts :: reads a record made before the field existed as zero
- AC10: When the report prints a time or effort estimate, the system shall state what is true after the step and print `after this step: N steps remain before <goal>`, where N is a whole number of zero or more.
  - Test: packages/engine/tests/run-end-handoff.test.ts :: states what is true after the step and the steps that remain before the goal
  - Test: packages/engine/tests/run-end-handoff.test.ts :: never reads as readiness: zero is printed as zero steps remaining
- AC11: If an estimate has no state, no goal or a count that is not a whole number, then the system shall refuse to print it.
  - Test: packages/engine/tests/run-end-handoff.test.ts :: refuses an estimate with no state, no goal, or a count that is not a whole number
- AC12: The report shall print each estimate it is given, and none when it is given none.
  - Test: packages/engine/tests/run-end-handoff.test.ts :: prints the estimates the report is given, and none by default

## Security considerations

The report holds counts, minutes, error kinds, run IDs and the estimate text
the caller supplies. It never holds check output, messages, paths or memory
text. Estimate text is printed as given after trimming and is not read back
into any gate.

## Non-goals

- The engine does not start follow-up plans on its own when a run ends. A
  graph-owned stop is still scheduled by hand with `graph-engine converge`;
  the retro reports the ones no follow-up names (AC3).
- The engine does not produce time estimates today. The estimate form is a
  report type with a checked text form, for the first estimate the engine
  prints.
- The rule that setup or harness work must never block product delivery is a
  process rule for how runs are queued and approved. This feature does not
  change scheduling, approval or queueing.
- No change to any gate, prompt or retry.
