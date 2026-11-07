# Same-Bot parallel tasks (personal fork)

The fork owner requested a Bot that keeps accepting messages: corrections join the
matching task, independent requests run concurrently. This intentionally changes
the upstream single-private-worker design for this fork. No DSH patch is used.

## Dispatch

The bundle enables `parallelTasks: true`; setting it to false restores ordinary
private-chat execution. Groups and local-agent CLI Bots keep their existing flow.
The private chat is a short-lived dispatcher, using the same configured model.
It reads the task ledger, acknowledges new work, and returns without waiting.
Tool-based work runs in ordinary DSH root Sessions belonging to the same Bot.
Simple conversational replies remain in the private chat. Ambiguous references
must be clarified. Semantic classification is model-driven, not a guarantee.

Tools: start_bot_task, update_bot_task, list_bot_tasks, stop_bot_task. Task workers
cannot recursively dispatch. Admissions are serialized per Bot, execution is not.
Four tasks may be active per Bot. Stable request_id prevents identical start retries
from duplicating work and rejects changed payloads under the same id.

A worker inherits identity, permission preset, capability scope, model/effort and
working folder. Its initial message includes bounded recent conversational context
and durable image/file references. Task conversations remain separate; corrections
use Agent.steer at the next step boundary, not cancellation. Results return to the
main chat, whose acknowledgement must distinguish finished, failed and interrupted.

## Visibility and lifecycle

The composer dock lists active tasks and five recent closed tasks, with navigation
into the original DSH transcript, return to the main chat and individual/all-task
stop. The main chat's existing stop button stops its own turn only; Stop all tasks
in the task dock stops workers. Saying stop is routed by the dispatcher.
Task records and ownership are saved before initial dispatch. On restart, active
records are marked interrupted; no tool work is automatically replayed by this
module. A user may inspect and explicitly continue a task. Bot deletion includes
task sessions. Updates to Bot model/permission also cover task sessions.

## Boundaries

Files, browser profiles and desktop resources are shared by identity. The dispatcher
must not launch conflicting writes simultaneously; task prompts require distinct
outputs and prohibit overwriting another task's changes. This is not filesystem
isolation. Short consecutive messages are interpreted together when present in the
same dispatch turn; later details are steered into the matching task. No artificial
batching delay is introduced. There is no new polling loop: task changes use Session
events and the existing team-state refresh.

Use the existing mock model, isolated DSH_HOME and free ports to test. Never use
user conversations as a test bench. Validate concurrent execution, correction
routing, duplicate start, stop, permission inheritance, failure and restart, then
inspect the task dock on the real mock-backed UI.
