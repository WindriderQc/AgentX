# Documentation reviews with saved coverage

Use this procedure for a requested documentation audit or review report against
source code. Ordinary documentation edits keep their requested scope. The task
specification defines the deliverable and scope; this procedure does not authorize
source changes, live tests, publication or another worker execution.

## Establish the checkpoint

Record the source revision, requested file scope and permitted report location.
For repository-wide Markdown reviews, inventory tracked Markdown once, including
archived/generated documents when requested. Listing a file is not reviewing it.
Use one coverage table with a row per scoped path: pending, partial or reviewed,
the concrete source evidence checked, and unresolved checks.

When an operator supplies an existing checkpoint, read it before starting new
research. Preserve its findings and coverage; check which source revision they
describe. Revalidate affected claims when the snapshot changes. A failed write
argument or a session narrative is not a saved report. If recovery is authorized,
save the supplied content at the current permitted output path and verify it.

## Review and save one group at a time

Choose a related document group that fits the remaining budget: for example one
component and its guide, or a section of a large operations manual. Batch relevant
document/source reads instead of making a separate model turn for every search.
Save the first verified findings before expanding to the rest of the inventory.

For each finding, record its category (obsolete information, inaccuracy or gap),
impact/severity, document path/line, supporting source path/line and proposed
correction. Merge duplicate findings. Support a contradiction with evidence;
wording preferences and ambiguous counts alone do not establish a defect. If a
targeted check stays unresolved, record the uncertainty and continue with other
requested checks instead of repeating the same search without new evidence.

Before opening the next group, save the findings and coverage table, recompute
all summary counts from that table, and read back the saved checkpoint. Keep
partially checked documents distinct from reviewed ones. Record the next group
and its unresolved checks so another authorized execution can continue without
rebuilding the inventory or rediscovering completed work. A failed save requires
reporting the exact error and stopping; do not narrate an unsaved checkpoint as
delivered work.

## Finish within the current execution

Reserve calls and time to save, verify and summarize the report. Follow the
runner's current budget advisory; it grants no extra calls or time. When few
calls remain, stop opening new groups and finish an honest partial report with
pending scope and the next group explicit. A full requested review remains
incomplete until every scoped document has the required evidence; delivering a
partial checkpoint for review does not complete or narrow the original task.

For the native private report profile, a normal worker return lets the harness
offer the saved report through Core for independent review. A budget stop may
leave only private output. File presence, registered delivery, human acceptance
and task completion are separate facts. For location and execution controls,
read `integrations/coding/README.md` in the product checkout.

A later execution needs the existing authorization, queue/admission and native
receipt checks. Resolve uncertain original outcomes through their owner first.
These instructions do not provide automatic continuation or budget increases.
