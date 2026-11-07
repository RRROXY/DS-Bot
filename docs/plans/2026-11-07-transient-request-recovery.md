# Bounded model-request recovery (personal fork)

The fork owner requested automatic recovery when Magpie / Command Code reports
an unavailable upstream instead of immediately ending the Bot task.

Use the documented `agent/request-error` waterfall. Delegate to native recovery
first; only when it declines, supplement transient failures with at most three
retries in the same turn and step, waiting 10, 30 and 60 seconds. The extra budget
is independent of the provider's existing native budget. Respect a longer
Retry-After within 60 seconds; decline when the requested wait exceeds that bound.

Eligible failures are server, transport, timeout and rate-limit failures, explicit
temporary-unavailable / overloaded failures, and the exact pi-ai error
`Provider finish_reason: other`. The latter is not proof of a transient fault;
it gets the same finite attempts and remains a failure if recovery is exhausted.
Never retry authentication, quota, invalid-request, context-overflow or cancelled
failures through this policy. Existing DSH context recovery remains responsible
for context errors. Non-Bot conversations are unchanged.

Record the schedule through public non-surface `llm/retry` events, flush before
waiting, and record `llm/retry-started` only if not cancelled. Read the per-step
budget from those receipts so reloads do not reset it. Retry does not resend the
user message, create a new task, replay earlier tool calls, or change prompts.
The ordinary DSH loop keeps the turn open and executes tools only from a
successful model response. Stop and plugin disposal abort pending waits.

The feature defaults on and can be disabled with Bot config `transientRetry: false`.
No DSH or Magpie code, provider settings, or user data is patched. Additional
attempts can incur provider charges. Direct side-chat / summary model streams
outside the agent loop are not covered.

Verification uses isolated mock models: policy/cancellation/durability unit tests,
real production-loop tests proving an earlier side-effect tool runs once, native
budget composition and exhaustion, and the standard isolated smoke bench.
