# DataX, DiskX and Janitor

On a full-profile private instance, **Data Toolbox** at `/data-toolbox` exposes
configured Data capabilities through Core. Data owns the indexes, stored
reports and review decisions. DiskX presents the existing data. Use the owner
session for file names and duplicate evidence. Keep paths on the private surface.

## Retrieve a dated report

1. Discover owner `janitor_report_view` and call it with `{}`. It reads the
   latest stored shared-drive strategy. Its optional `group` takes one SHA-256
   from the report. The tool has no date-search argument. If it is absent on an
   authorized full-profile operator session, open `/data-toolbox#janitor` for
   the stored report. On a restricted family device stop at the access boundary.
2. Require `available` and compare `generatedAt` with the requested date in
   the user's time zone. Give the source date and `ageMs`, verified groups and
   files, candidate counts separately, and `provenSavingsBytes` as **logical**
   duplicate bytes. Physical space freed is unmeasured. No stored report,
   missing date and Data unavailable are three different answers.
3. Return its dated `link` (or use the returned `screenPage` in Nestor).
   DiskX's `report=<UTC timestamp>` pins the **latest** report by equality.
   To check the projection, read
   `GET /api/diskx/presentation?report=<encoded generatedAt>` on that Core,
   optionally with the same `group`. Match the report date and group. A 409
   `JANITOR_REPORT_CHANGED` means another report replaced it. Reread the summary
   and disclose the change. If the requested version differs, report the
   available date and the historical lookup gap. Never substitute today's
   report or regenerate one. Distinguish a link supplied, a snapshot read and
   a page actually displayed.

## Other Data reads and actions

- Find indexed names with owner `find_files` (query, optional extension/root,
  bounded limit). Use its freshness and scope. General `storage_summary` and
  `network_devices` read inventories. None requires starting a scan.
- For a human review of verified duplicates use `/data-toolbox#janitor`.
  Keep the policy's proposed survivor, stored decision, fresh preview and
  separately authorized cleanup distinct. A saved decision records intent.
  A graphical presentation or logical savings count proves no file operation.
- Data is an optional private instance service. Missing full profile, closed
  access, absent index, unavailable renderer or missing Data have different
  effects. Report the last successful read even if the view cannot open.
  A request to inspect a report needs no scan, generation, approval or mutation.

Maintained guides in a matching checkout: `docs/OPERATOR_UI.md` (Janitor
duplicate review), `docs/OPERATIONS.md` (DiskX and owner tools).
