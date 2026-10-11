# Reading operational screens

AgentX shows the observation, the next action and the supporting evidence in
its existing operational screens. A green connection badge, a saved profile and
a completed coding task answer different questions. None substitutes for a
runtime restoration, a deployment receipt or device acceptance.

## Pipeline and Planning

Open `/pipeline` and use **Needs attention** to find tasks requiring a decision.
Its header separates the known total, the rows loaded in the browser and the
page shown; **Previous** and **Next** reach every item ten at a time, in Core's
next-action order. **Engineering** is the default queue; **Private lanes** is a
separate queue for personal, family, household and secretary work, never mixed
into the engineering list. The board's service, lane, status, group and search
filters narrow the queue before paging. When the bounded scan cannot see every
open task, the header shows a lower bound and says the total is unknown. A
refresh that observes the same state changes nothing on screen; only an
actionable item that was not in the previous observation is announced and
marked **New**.
The Pipeline state strip uses that engineering queue's current filtered count:
an exact total when coverage is complete, a lower bound when it is partial,
or "unknown" when the read failed or the private queue is selected. It does
not treat the browser's loaded task rows as the full attention queue.
Open a task dossier to read its **Next action**, current ownership and audit
trail. Planning references link to the same dossier and display Core's same
next-action projection.

**Why can this task start, or why is it waiting?** expands two read-only views:

- **Manual worker queue**: queued/unassigned state, earliest start time and scoped
  dependency completion.
- **Coding Team**: those conditions plus structured automation intent, low-risk
  policy, remaining attempt budget and availability of the shared automation slot.

The panel refreshes observations when expanded or when **Refresh conditions** is
selected. It consumes neither a slot nor an attempt. Missing policy, unknown
dependencies, failed reads and stale timestamps stay explicit. Private task
lanes have no coding eligibility view; dependency content stays within its
existing scope. Launch, selection and atomic claim revalidate current state.
Runtime bridge availability and its own admission remain separate launch checks.

An old, missing or future heartbeat does not prove a worker stopped. An expired
automation lease is shown as **Automation lease expired · worker state unknown**:
Core refuses late results from that lease, yet expiry proves no stop either.
Inspect ownership and recorded effects before releasing or re-queuing it. Human review,
merge, deployment and device acceptance remain separate decisions and receipts.

**Why tasks are not advancing**, under **Needs attention**, lists active engineering tasks (private lanes excluded)
that wait on a recovery, an unknown state, a human decision or a dependency.
Each row names the category, the owner of the next step, the action and the
missing evidence; selecting it opens the dossier. In the dossier, **Why is this
task not advancing?** shows the same read-only diagnosis for one task. An
ambiguous case shows **New escalation** the first time this browser session sees
its key and **Escalated earlier — not repeated** on later refreshes. The panels
offer no repair: corrections use the existing guarded task actions. Failed or
malformed reads keep the last observation and say so.

**Evidence references** in a coding dossier lists, per attempt, copyable
references: task, attempt (`task-0307/attempt-2`), launch request id, lease
fingerprint, worker receipt fingerprint and pull request. **Copy attempt link**
gives `/pipeline?task=0307&attempt=2`, which opens that attempt's references;
**Show attempt dossier** moves to its recorded evidence. A PR appears as a link
only when the delivery observation names the same attempt and its gate proved the
exact PR, exact head and sealed receipt (`receiptBinding`, kept after merge).
Product PRs and unproven bindings are shown as unproven, without a link. A receipt of another attempt is never substituted, and missing,
malformed or colliding values stay unknown. A launch request absent from every
attempt is shown without attributing an attempt to it. References grant no
action: the lease appears only as a one-way fingerprint, and lease ids, tokens,
epochs, release bodies and machine paths are not shown.

The **Timeline** view lists recorded status transitions such as
`Status review -> queued (requeued) · declared by reviewer`. "Declared by" is
the name the caller sent, not a verified identity. A task created before
transitions were recorded shows no invented status history; its earlier states
remain unknown.

A task with a plan shows **Plan revision N** in its dossier: mode, author,
text, steps, scope and fingerprint. A decision is optional; **Approve revision
N** or **Request changes** applies to that revision only and starts no work.
A newer revision says the earlier decision does not carry over. When the task
request or scope changed after a decision, the dossier shows it as no longer
current. A task without a plan shows no plan section.

**Deliverables** in a task dossier lists the files registered for that task:
name, type, size, attempt or operator upload, SHA-256, storage, availability,
external delivery and scope. A listed file reads "digest not checked yet" until
**Verify SHA-256** recomputes it on the server. **Download** fetches the file in
the task's scope and checks the digest again in the browser when Web Crypto is
available. Missing or altered files show why and are not offered. External
delivery always reads "None": the dossier never sends a file anywhere, and
deliverables are not memory.

**Where attempt time goes**, in Coding Team history and performance, splits the
attempts of the selected window into phases (`agentx.pipeline-attempt-phases/v1`):

| Phase | Clock | Recorded source |
|---|---|---|
| Before claim | Core | Task creation (attempt 1), or the previous attempt's recorded requeue decision or release, to the claim |
| Resource wait | Core | Sum of the attempt's model-call waits before Ollama: runtime admission, host gate, retry backoff and retried calls' waits, from the inference rows attributed to the attempt. Part of the worker run, not added to it; unknown when a call carries no recorded wait, no call went through Core, or the rows expired (`INFERENCE_LOG_TTL_DAYS`) |
| Startup | none | Not instrumented: claim to worker start is not recorded |
| Recorded guarded worker run | worker | `clawdx-guarded/v1` run duration minus independent verification; inference and tool execution together |
| Verification | worker | Independent verification duration |
| Human decision | Core | Attempt end to the recorded accepted, requeued or rejected decision |

Each phase shows its median, p95 and range over observed attempts only, and its
coverage: observed, pending, unknown and clock mismatch counts. A phase is
never rebuilt from `updatedAt`, from another owner's timestamp or by subtracting
a Core time from a worker duration. A worker duration longer than the Core
attempt window (5 s tolerance), or a recorded end before its start, is shown as
a clock mismatch and excluded. The **Phases** column gives the same split per
attempt. These durations describe recorded attempts; they do not estimate a
latency gain.

## Nerve Center

Open `/nerve-center`. Each cluster host distinguishes **Ollama reachable** from
the residency of its configured pins:

| Residency label | Meaning | Next action |
|---|---|---|
| Pins fully on GPU | Every configured pin is loaded with measured full GPU residency in the current observation | Inspect residency evidence when qualifying the host |
| GPU residency degraded | A pin is partly/entirely on CPU, or fresh collector inventory reports no GPU | Inspect affected models and runtime evidence before changing the host |
| GPU residency unknown | Evidence is missing, stale or incomplete, or an operation owns the runtime | Refresh and inspect the runtime owner |
| No configured pins | No configured set exists to qualify | Use the existing pin controls if a pin policy is required |

**Residency evidence** reveals per-model observations and their time, including
embedding models. **Host details** opens runtime and telemetry details with a
keyboard-accessible button. These reads do not warm, unload or restart models.
An existing active `pin-vram-spill` incident remains separate from the current
read: silence or a stale sample cannot resolve it. See the [GPU contract and
fallback policy](OPERATIONS.md#light-task-fallback-ladder).

**Inference hosts** lists every Ollama endpoint with its residency (GPU or
CPU) and its concurrent-request limit, and registers a new one. A machine that
runs a GPU instance and a CPU instance shows two rows.

**Operations watch** shows the latest report: what the monitoring rules flag,
and whether the model or the plain rule list wrote it. "Nothing needs
attention" means the rules flag nothing; no model ran. **Check now** runs a
check at once. The switch, the interval and the report language are saved by
Core when you press **Save**; until then the line says they come from the
configuration file.

In the task routing table, a host tagged **CPU** is a slow background host, and
**Stays on this host** means the task does not follow its model to another
host: when that host is busy the task waits. Every task routed to a CPU host
stays there. The light tasks of the fallback ladder may still step down when
their host is unavailable.

## Profiler

Open Benchmark's `/profiler`. **Runtime continuity** appears above preparation
actions when journals exist or recovery evidence is unavailable. It shows host,
operation state, next safe action and expandable operation evidence. The
preparation action leads directly to that panel while continuity needs inspection.

Under **Take the controls**, the **Coverage** section lists each model pinned on
a host or routed to it in Core's task routing table, with the state of its
profile and how many catalog prompts have a scored answer. A prompt counts when
the answer was scored with the current scorer version, for the prompt as the
catalog holds it today, by the artifact the profile describes: a new artifact,
a new scorer version or an edited prompt re-opens what it affects. **Next**
says what the pair still needs, a profile first, then the benchmark. A stored
profile counts as current only when the gate every benchmark launch passes
accepts it for the artifact the host serves now; otherwise the pair shows the
gate's reason and needs a profile again.
`GET /api/benchmark/coverage` returns the same matrix.

A new scorer version declares, per prompt category, whether stored grades keep
their meaning, follow from the stored dimension scores, or need the judge
again. At startup Benchmark carries over the grades that stay valid: the row
moves to the current scorer version and quality cohort, a grade a new rule
changes is recomputed without a judge call, and what the row held before stays
in its `scorer_history`. A grade that cannot be derived from what the row
stores is left as it is and its prompt re-opens. A version that declares
nothing re-opens every prompt. `POST /api/benchmark/coverage/carry-over` runs
the same pass; with `{ "dryRun": true }` it only reports what it would carry
and why it would leave the rest.

Below the matrix, **Automatic measurement** fills it by itself, one small
measurement at a time: a standard profile, or a few missing prompts for one
model on one host. It is off until switched on. It starts a measurement only
inside the quiet hours, when no workload, maintenance or batch holds the
runtime and the household has been quiet for the set minutes, and it launches
through the same routes as an operator, so judge selection, preflight and host
claims apply unchanged. The line says why it is waiting. A pair whose
measurements end three times without progress is left alone for a day.
Conversations held through an external agent harness cannot be told apart from
that harness's scheduled jobs and do not count as activity: choose quiet hours
accordingly. A measurement in progress still yields to a household turn.
**requested first by** under a pair's **Next** means an operator or a lead
agent asked for it to be measured before the others; hover it for the reason.
It still waits for the quiet hours.

| Operation label | Meaning |
|---|---|
| Profiling prepared / in progress | The journal records recent writer activity; observe the existing operation |
| Runtime request outcome unknown | No terminal runtime receipt is recorded; an old writer does not prove termination |
| Runtime restoration pending | Terminal requests are recorded; the recovery worker reconciles under Core ownership |
| Restoration verified; release pending | Restoration evidence exists; the Core release receipt is still required |
| Runtime release recorded | The journal contains a successful release receipt; live GPU/residency acceptance remains separate |
| Journal closed; release unverified | Closure alone does not establish a successful runtime release |

**Operation evidence** shows the operation identifier, terminal-response status,
recorded pending requests and last evidence time. Browser reads exclude
coordination identities, owner epochs and release receipt bodies. The view is
bounded to 100 unresolved operations and 20 recent closed journals; overflow is
explicit and cannot establish complete recovery.

Use **Refresh preparation status** to re-read evidence. Pending operations refresh
every 15 seconds while the page is visible; returning to the page refreshes it.
No refresh restarts or replays profiling. The interrupted-operation guide in the
panel explains the inspection sequence; the exact operator endpoint and receipt
are documented in [Profiler restoration and UNKNOWN recovery](OPERATIONS.md#profiler-restoration-and-unknown-recovery).

A completed profile shows a **Pin context** block. For a pinned model with
co-resident proof it shows the current pin, the proposal, the expected VRAM and
the other residents, with **Apply** and **Keep current**. Apply takes minutes:
Core reloads the pins, verifies VRAM and short-prompt speed, and reverts on a
regression; the block then reports the speed change or the rollback. A kept
proposal stays on the model's card, with Apply only, until the pin matches or a
newer profile replaces it. Without co-resident proof the block reports the limit
as unknown and lists what to qualify; an unpinned model gets no offer.

Saved measurements are retained independently from runtime recovery. A comparison
readiness summary does not override an unresolved journal. For measured context,
capacity and recall distinctions, see [context profiles](PROFILER_CONTEXT.md).

## Data Toolbox: header, refresh and phone layout

Open `/data-toolbox` (full profile, with the optional Data service). These rules
hold on every tab.

**Header.** The box beside the title states what the last read attempt gave, in
words; its dot only repeats the state.

| Header | Meaning |
|---|---|
| **Data answering** · `last read 14:02:11` (green) | The last read succeeded at that time |
| **N of 7 Data sources unavailable** · `read …, incomplete` (amber) | The Overview was read but some sources did not answer; the Overview names them |
| **Data unreachable: no source answered** (red) | The Overview was read and no source answered |
| **N reads of this tab failed: …** (amber) | The tab drew itself with a notice in place of what could not be read |
| **Data unreachable** · `failed …: reason · last good read …` (red) | AgentX answered that Data refused or timed out |
| **AgentX unreachable from this page** (red) | The browser got no answer from AgentX itself |
| **Last read failed** (red) | Any other failed read; the reason follows the time |

The time is the time of a real read. A value kept from an earlier read never
stamps the header.

**Overview sources.** Each of the seven sources is listed by name with
**answering** or **unavailable** and its reason: the HTTP status Data returned,
`timeout`, the connection error, or the message of Data's error answer.

**Automatic refresh.** A tab refreshes only while it is open and the page is
visible; returning to the page reads at once. Each refreshing block says when it
was read.

| Tab | What refreshes | Every |
|---|---|---|
| Overview | Figures, source list, recent warnings and errors | 30 s |
| Network | Counts, collectors and device list | 60 s |
| Live Data | Feed counts and feed cards; the ISS marker | 60 s each |
| GPU | **Now** | 30 s |
| Activity | New events | 15 s |
| MQTT | Broker state and new messages | 2 s |
| Storage | A running scan or report only | while it runs |
| Files, Databases, Janitor | Nothing | **Refresh** only |

The Overview, Network and Live Data refreshes wait, and say so on their line,
while a field of the tab has the focus, a details panel is open, a device editor
is open, a typed name is not saved, or a network scan is running. They repaint
their own block in place: the search box, the scan form, the map, an open
inspector and the scroll position are left alone. A failed automatic read keeps
what is on screen, names the failure on the line and turns the header red.
**Refresh** reads the whole tab at any time.

**What the page can change.** The amber line under the header reads **No
filesystem actions. This page can send nine kinds of change to Data.** Open
**Show the list** for the nine; the Overview repeats the list in full under
**What this page can change**.

**Phone width.** At 620 px and below the header shrinks to the title and the
read state, the tab bar scrolls sideways with the open tab brought into view,
and controls are at least 40 px tall. The Network, Activity, Reports, Databases
and MQTT lists show one labelled block per row; other wide tables scroll inside
their own frame, never the page.

## Data Toolbox: Activity

Open `/data-toolbox#activity` (full profile, with the optional Data service).
The tab reads Data's activity log: what Data did or noticed, kept 30 days. It
changes nothing. The event types are listed in
[Data's README](../data/README.md#activity-log).

- **Last 24 hours**: the number of errors, warnings and information events,
  whatever the filters below, and the most recent warning or error.
- **Events**: newest first, 50 per page, each with its time, its severity in
  words, its type, one sentence and its details (the event's `meta`, shown as
  plain key and value text). Filters: the family (storage, collectors, GPU,
  network, janitor, live data, MQTT, external), the severity and the period
  (all kept, 7 days, 24 hours). **Newer** and **Older** walk the pages.
- New events are read every 15 seconds while the tab is open and the page
  visible. On the first page they are added on top, marked `new`, with a count;
  on another page a line says how many arrived. **Pause** stops the reads.

Only changes are recorded, so something that stays broken appears once. The
Overview tab shows the last four warnings and errors with a link to this tab.

## Data Toolbox: Storage scans

Open `/data-toolbox#storage` (full profile, with the optional Data service).
The tab has three views: **Inventory and scans**, **Growth** and **Reports**
(the two sections below). Under the inventory figures and the collector, the
first view asks for a scan and follows it. A scan reads the disks and refreshes Data's index, where the rows
of files no longer there are removed. It changes nothing on the disks.

- **Scan now**: one card per source Data is configured with, with its root,
  the collector that serves it and its last finished scan. The button is
  disabled, with the reason beside it, when no active collector announces the
  source or when a scan of it is already queued or running. Only the source
  name is sent: hashing follows Data's default (duplicate candidates only).
  If a scan of that source was already there, Data answers with that one and
  the page says it joined it; no second scan starts.
- **Scan in progress**: status, files seen, processed and hashed, errors, time
  elapsed and the age of the last batch received, read again every 3 seconds
  while the tab is open and the page visible. A collector sends the files it
  processes as it goes and its other totals at the end: until then they show a
  dash. A scan run by a collector cannot be stopped: Data has no stop for it.
  When the scan ends its final state stays on the page. **Partial** means the
  scan could not confirm every root (an unmounted disk reads as an empty
  folder), so Data kept the index rows it already had; **failed** means it did
  not finish and removed nothing. Both show Data's reason.
- **Scan history**: the last 12 scans started. Each one opens on its timing
  (requested, time in the queue, started, finished, duration, who ran it), its
  hashing limits and every count Data recorded.

A scan queued by someone else is not in this list until a collector starts it,
because Data lists scans by start date. Asking for the same source in that
interval joins the queued scan.

## Data Toolbox: Storage growth

Open `/data-toolbox#storage` and choose **Growth**. The view is read-only. Data
records one snapshot per root and UTC day when a scan of that root ends
`complete`, and keeps them 800 days; the view shows one block per root, for a
window of 30 days, 90 days, one year or everything kept.

- **Total size** and **Number of files**: one line chart each, with the first
  and last values in words above it and the same figures as a table under
  **The two charts as a table**. The vertical axis starts near the lowest value
  when the change is small, and the chart says so. Hovering a day shows its
  value.
- **Growth**: size and files added between the first and the last snapshot of
  the window, the average per day, and the five folders that grew the most. A
  folder that was summed with the "other folders" at the start of the window is
  left out, because its growth is not known.
- **Size by folder**: the newest snapshot, largest folder first, with size,
  share of the root and files. *Other folders, together* is what Data summed
  beyond the 40 largest folders; *Files directly in the root* are the files
  that sit in no folder. **Open** shows a folder's own size over time and its
  subfolders. Data keeps subfolders only for a root with at most five top-level
  folders: otherwise no folder can be opened, and the view says so.
- **Files walked by the collector**: a separate chart of what the collector
  counted at each completed scan. It is not the index total and has no size; it
  is never drawn with the totals.

With one snapshot the view shows the current state and says that the next point
comes with the next complete scan; with none it says why. A root with no
snapshot in the window, but some earlier, says from when to when they exist.

## Data Toolbox: Reports

Open `/data-toolbox#storage` and choose **Reports**. A report is a file Data
generates from its index and keeps in its own report store. Generating reads
the index only; the scanned disks are neither read nor changed. This view sends
two changes to Data: the generation and the deletion of a report.

- **Reports kept** and **Space used**: the current usage against Data's limits
  (20 reports, 1 GiB). Over either limit Data removes the oldest reports.
- **Generate**: a report (folder summary, statistics by extension, large files,
  media files or the full inventory) and a format (CSV or JSON; the full
  inventory exists in JSON only). Data starts it and answers at once; the list
  is read again every 3 seconds while a report is running, the tab open and the
  page visible, and the page says when it is ready or why it failed. Data
  generates at most two reports at a time and refuses a third.
- **The list**: type, file name, format, status (running, ready, failed with
  Data's reason), size, records and date. **Download** saves a ready report:
  Core passes the file through as Data sends it. **Delete** asks for
  confirmation on the row, then removes the report from Data; for a failed
  generation it only clears the line. A running report cannot be deleted.

Running and failed generations exist in Data's memory only: after a restart of
Data a running one is gone from the list, and the page says so.

## Data Toolbox: Files

Open `/data-toolbox#files`. The tab is read-only: every view reads Data's
index and nothing is deleted, moved or renamed from it. Above the views, the
index totals: files, size, extensions (Data lists the 25 largest, shown as
`25+` beyond that) and folders that hold files.

- **Files**: the list, with filters on the file name, the folder (that folder
  and below), the category, the extension, a size range in KiB, MiB or GiB and
  the presence of a hash; sorted by modification date, name or size, 25, 50 or
  100 per page. An extension takes precedence over the category.
- **Folders**: the folders under the current one with the files and size below
  each, a breadcrumb to go back up, and **Show files** to open the list
  filtered on a folder. Data records only the folders that hold files directly
  and returns the 2 000 largest under a path: when it cut its answer, the
  figures are marked `≥` and small folders may be missing; the totals of the
  current folder stay exact, and opening a folder narrows the read.
- **Duplicates**: the groups of files with equal SHA-256, largest first, ten
  per page among the 100 largest Data returns, each with its size, its number
  of copies, the space one copy would free and every path. The totals of the
  whole index are shown above. Only hashed files can be compared, so all of it
  is a lower bound. Without any current hash Data falls back to same name and
  size, and the page says these are not verified.
- **Cleanup**: Data's review suggestions (large files, old files, verified
  duplicates, duplicate candidates, empty files, files at the root of a chosen
  folder) with the sample of files behind each one. A saving Data did not
  measure is shown as not measured.

Duplicates and Cleanup take an optional folder to limit them.

## Data Toolbox: Network

Open `/data-toolbox#network` (full profile, with the optional Data service).
The tab lists the devices Data's collectors have seen on the LAN and sends two
changes: a scan request, and the edit of one device record.

- **Collectors**: an **active** collector has reported to Data in the last 90
  seconds; only an active one runs a scan. A **silent** collector is shown
  apart with the date it was last heard. Its record and the devices it
  reported are kept: nothing is deleted from this page.
  An active collector with no placement metadata configured for the instance
  is shown from its registration (host, address, registered since) and says
  that its supervisor, unit and cadence are not declared.
- **Scan now**: asks the active collector for one discovery scan of a target,
  pre-filled with the network it sweeps. The target is an IPv4 address or a
  CIDR from /16 to /32. The page follows the request every 2 seconds, then
  shows how many devices were seen, names the ones that were not in the list
  before, and reads the list again. A collector runs one scan at a time: a
  request that arrives during its own periodic sweep is skipped at that poll
  and tried again at the next ones (every 5 seconds by default). Data hands a
  request out for two minutes; one the collector could not finish in that time
  shows as **expired** and changed nothing. With no active collector the
  button is disabled and the reason is shown.
- **Find**: the search box matches the name, IP, MAC, vendor, hostname, type
  and location. The chips filter the list (all, unnamed, online now, new in the
  last 24 hours, not acknowledged) and show their count. The Device, IP, Last
  seen and First seen columns sort; IP addresses sort by value. All of it works
  on the loaded list, in the browser. A device first seen in the last 24 hours
  carries the word **new**.
- **Unnamed devices**: one card per device without a name, with its IP, MAC,
  vendor, hostname, first and last sighting and the collector that saw it.
  Type a name and press Enter (or Save): it is saved, the device leaves the
  view and the next name field takes the focus. **Mark known** acknowledges a
  device without naming it.
- **Edit**: opens an editor under the row for the name, the type (computer,
  server, phone or tablet, IoT, network equipment, media, printer, other), the
  location and the notes. Only the fields that changed are sent. A name is at
  most 80 characters, a location 80, notes 500. Type and Location appear as
  columns once a device has one. Collector sweeps do not overwrite these
  fields: a sweep only rewrites what it observed (IP, MAC, hostname, vendor,
  last sighting).

A name or the known flag acknowledges a device: Core's new-device alert no
longer reports it. A device Data holds without a MAC (usually the collector's
own address) can be named and edited, and is not part of that alert.

## Data Toolbox: GPU

Open `/data-toolbox#gpu` (full profile, with the optional Data service). The
tab is read-only and has four sections, each read separately: one that cannot
be read shows a notice in its place and the others stay on screen.

- **Now**: the last sample of each GPU host with its age. Only a **fresh** host
  shows current values. A **stale** host shows the last values received, their
  age and the collector's last error; **no data** means no sample ever arrived.
  A dash is a value the collector did not read, never a zero. This section
  refreshes every 30 seconds while the tab is open and the page visible.
- **Occupancy**: per physical GPU over 24 hours, 7 days or 30 days. Read
  **Coverage** first: it is the share of the window Data has samples for. Busy,
  utilisation and throttled figures describe that observed time only, so a GPU
  with low coverage is mostly unknown, not idle. History older than Data's
  retention (`DATA_HARDWARE_HISTORY_TTL_DAYS`) lowers the coverage of a long window.
- **Recent trend**: utilisation over the last six hours as five-minute means,
  with the mean, minimum, maximum and latest value in text.
- **Collector**: the native gpu-agent's registration and last heartbeat.

## Data Toolbox: Live Data map

Open `/data-toolbox#live-data` (full profile, with the optional Data service).
The **World map** section sits above the feed registry. It is read-only and
drawn in the page from the feeds Data stores and from country outlines shipped
with AgentX (Natural Earth 1:110m): it works with the internet down. The
projection is equirectangular and shows the whole globe. Two views:

- **Live**: the ISS as a labelled marker with its track over the last 95
  minutes (about one orbit), cut where it crosses the antimeridian and where
  points are missing for more than five minutes; the earthquakes of the current
  list as circles whose area doubles with each magnitude unit, the strongest on
  top and the three strongest labelled; the stored locations with their latest
  pressure and air quality; the MQTT sensors whose points carry coordinates.
  Satellite elements have no position and are not drawn. The ISS is read again
  every 60 seconds while the tab is open and the page visible; an ISS position
  older than five minutes is drawn as the last known one and said so.
- **By country**: countries shaded by the number of events of the earthquake
  list inside their outline, in five ranges, with the count written on each
  counted country. The outlines are coarse: an event just off a coast, or on an
  island too small for that scale, is counted in the **Offshore / no country**
  row and drawn as a small ring, never dropped.

Each view lists what it draws in tables under the map (ISS position and time,
locations and sensors, every earthquake with time, magnitude, place, depth and
type; counts and strongest magnitude per country). A feed that is off, empty or
unreadable has its own line above the map and the other layers stay drawn. If
the outlines cannot be loaded, the Live view draws the points on a plain grid
and the country view says it is unavailable.

## Data Toolbox: MQTT

Open `/data-toolbox#mqtt` (full profile, with the optional Data service). The
tab shows what Data's broker monitor receives and publishes one message by
hand. It needs `MQTT_BROKER_URL` on Data; without it the tab says so.

- **Broker**: connected or not, the broker's host and port, the number of
  messages received since Data started and the time of the last one. While the
  broker is not connected nothing is received and Send is disabled.
- **Stream**: the messages, newest first, read every 2 seconds while the tab is
  open and the page visible. The topic filter takes MQTT wildcards (`+` one
  level, `#` everything below) and is applied by Data. **Hide heartbeats**,
  ticked by default, leaves out the once-a-second `esp32/alive/#` messages of
  the ESP32 devices and shows how many were hidden; untick it to see them.
  **Pause** stops the
  reads, **Clear** empties the list on the page only. The page keeps 300
  messages and Data 500, in memory: a notice says when messages passed between
  two reads and are no longer available. A long payload opens on click; a
  payload that is not text is shown as hex.
- **Send**: a topic (pre-filled `esp32/`), a message and a **Retain** box. Any
  topic is accepted and the message goes out at once, at QoS 0: it reaches real
  devices and can switch an output or reboot one. A retained message is
  delivered again to every device that subscribes later; to remove one, send an
  empty retained message on the same topic. The outcome is shown under the
  form, and the message then appears in the stream when the broker delivers it
  back. Nothing is queued: when the broker is not connected the send is refused.

## Data Toolbox: Janitor duplicate review

Open `/data-toolbox#janitor` (full profile, with the optional Data service).
The tab shows the nightly shared-drive report; its **Duplicate review** section
is where the owner decides what he wants for each verified duplicate group.

Nothing in this tab deletes files. A stored decision records intent for a
later, separately confirmed cleanup: that cleanup still needs a current profile
run, a fresh SHA-256 preview and its own typed confirmations, none of which the
page can send.

- **Deciding**: open a group, choose the copy to keep, then **Accept for
  preview**, **Reject deletion** or **Defer**; a note is optional. The decision
  is saved to Data at once and the group says so (saved, or why it failed).
  **Undo** removes the stored decision. A group shown without all its copies
  (more than 60) cannot be decided from the page.
- **Review progress**: groups decided on the page and in the whole report, the
  count by decision, the space the accepted groups represent (not freed), and
  the stale decisions with their reasons. A decision is stale when the group
  changed since it was made (a copy gone or changed, new copies, the chosen
  copy missing); it is shown, never applied to the new copies, and deciding
  again records it on the current ones.
- **Paging**: 30 groups per page, **Previous** and **Next**, in the report's
  order. **Show only undecided groups** asks Data to skip the decided ones.
- **Policy**: the copy the policy would keep is labelled. When the owner keeps
  another one, both are shown.
- **Browser draft**: when Data cannot store decisions, they are kept in this
  browser as before. When the draft holds decisions that Data does not have,
  **Import N decisions from this browser** shows exactly what will be sent
  before sending it; a decision already stored is never replaced, and the
  draft stays in the browser, marked as imported, as a backup that **Copy
  draft**, **Download draft** and **Clear** still handle. A decision of an
  older draft whose group is no longer in the latest report cannot be imported
  and stays in the draft.

## Interaction and verification

The diagnostic panels wrap long identifiers, expose textual status and reveal
technical evidence on demand. Native disclosure controls work with Enter/Space;
visible focus identifies keyboard position. Pipeline dossiers keep Tab navigation
inside the modal and Escape returns to the opener. The existing editor has its
own dialog behavior. Reduced-motion preferences remain respected.

Local tests and disposable browser fixtures verify these product paths without
production MongoDB or Ollama. Responsive browser checks establish layout at the
tested viewport sizes, not physical touchscreen, GPU or voice acceptance. Keep
those deployment and device receipts outside Git.

## IoT devices

Open **Système → Appareils IoT** (`/data-toolbox#iot`). Data owns the MQTT
connection, device registry, readings and history. The page connects through
Core's `/api/data-toolbox/iot` relay and never connects directly to a broker.

Each device has a card with its ID, display name, location, availability,
up to four priority measurements and their ages. Every measurement stays
available in the charts. Search matches names, IDs and locations.
Choose **Voir les courbes** to select a device and check the measures to draw.
Unknown values stay unknown; a disconnected broker leaves the last known
values dated and disables commands. The workspace follows the AgentX theme.

**Superposées**, the default view, places all selected measurements on one
large chart with a shared time axis. Each curve has its own scale so volts,
temperature and signal strength remain readable together. **Axe affiché**
selects which curve's scale and unit appear on the vertical axis; the coloured
legend chooses the curves. Moving or tapping on the chart opens one comparison
with the real value, unit and observation time for each nearby sample. A series
with no nearby observation stays unknown. Left/right arrows, Home, End and
Escape provide the same inspection from the focused chart.

**Style des courbes** opens four presets (**Signature**, **Épuré**, **Aires**, **Technique**)
and per-measure controls for stroke width, solid/dashed/dotted lines, smooth,
straight or stepped curves, gradient/solid fill and its opacity, sample points
and optional glow. **Appliquer à toutes** copies the current curve's style to
the device's other measures. Settings are retained per device and measure in
this browser, remain active during live updates and never change observations
or send commands. **Signature** is the default for unsaved curves: temperature
and CPU temperature have subtle gradient areas, pressure uses a fine dotted
stroke, battery uses dashes, Wi-Fi uses steps, and altitude stays smooth and
unfilled. Other measures use fine unfilled strokes. Existing saved styles
remain active; choosing **Signature** applies the default composition to all
of the device's measures. All defaults keep points and glow off.

**Zoom vertical → Contexte** keeps a minimum viewing span in the measure's
unit and rounds the bounds, so a one-step sensor change does not fill the whole
chart. **Détail** zooms to the observed range. Context spans are viewing scales,
never valid-value limits: an outlier expands the domain, and all observations
remain unchanged. Quantized readings still show their actual repeated values.

**Par mesure** displays individual charts using the same returned readings.
The combined live chart updates in place, retaining its canvas and inspection
cursor. Both views expose full-precision tables; historical **Min–max** adds
the observed ranges to the combined chart and its scales.

- **Live** reads Data's last 60 raw points per measure. That memory buffer
  starts empty after Data restarts.
- **History** offers an hour, 24 hours, seven days, 31 days or a year, with
  automatic or explicit minute, five-minute, 30-minute, hourly, two-hour or
  daily resolution. Fine history is retained 90 days; hourly history has no
  expiry. Graphs use mean values and show their min/max ranges, real time
  spacing, gaps and partial hours. Tables expose every returned point at full
  precision.
- Cards and live graphs refresh every two seconds while the tab is visible;
  historical curves refresh every minute. Refresh waits during editing or
  while a details panel is open. Changing devices or tabs discards old answers.
- **Nom, emplacement et notes** explicitly saves those three registry fields.
- **Commandes** explicitly sends GPIO ON, GPIO OFF or reboot for the selected
  device. GPIO numbers are 0–48, matching Data's existing firmware contract.
  Commands are QoS 0, never retained or queued. A published message establishes
  publication only: it does not establish what the hardware did. A lost reply
  reports an unknown outcome and triggers no automatic retry.

The page displays measures from `sensors/<device>/<measure>` and recognized
numeric fields in legacy `esp32/alive/<device>` and `esp32/data/<device>` JSON.
Aliases such as `wifi`, `CPUtemp`, `battery` and `airHumid` become the same
canonical measures as the sensor topics. Reception time supplies timestamps;
retained bundles do not create fresh readings. For each measure and minute,
sensor topics take precedence over data bundles, then heartbeat bundles,
so duplicate representations do not inflate history. Live values prefer the
same sources while fresh and clear the ring when switching source. Strings,
configuration fields and device timestamps never become numeric telemetry.
Configured-output discovery, configuration profiles and timers are separate
from these three existing commands.
