# DataX, DiskX and Janitor

Data owns optional inventory, collectors, telemetry and saved Janitor evidence.
The full-profile **Data Toolbox** (`/data-toolbox`) and **DiskX** (`/diskx`)
are Core surfaces. They require the private operator entry and configured
Data. DiskX also needs its configured viewer and storage roots. Family-pinned
devices cannot open these pages.

## Read the existing index

| Need | Tool or authorized Core read | Verify |
|---|---|---|
| Storage, root coverage, backups or growth | Discover `storage_summary`, or start at `GET /api/data-toolbox/storage/summary`. Use the Toolbox for storage trends and reserve/backup advice. | Use each root's scan outcome/time, collector observation, hash coverage and omissions. Advice is conditional on its evidence. |
| Locate files by name | Owner `find_files` with a bounded query and an indexed root if known. | Check the index's freshness, total/returned counts and truncation. A name match gives an indexed location. Open the content through its authorized native reader. |
| Hardware, network and sensors | `gpu_status`, `network_devices` or the Toolbox's Hardware, Network and IoT views. | Quote last observation and collector availability. Inventory can outlive a device. |
| An existing Data export | List `GET /api/data-toolbox/reports` or Toolbox → Reports. Choose a ready entry by `type`, `createdAt` and exact `filename`. | Open `GET /api/data-toolbox/reports/<filename>/download` when needed. Check record and skipped counts. A Data export is a separate artifact from a Janitor strategy. |

## Open a dated Janitor report

1. Discover owner `janitor_report_view` and call it with `{}`. Narrow to
   an exact SHA-256 `group` only if requested. Alternatively read
   `GET /api/data-toolbox/janitor/strategy/latest` or the Toolbox's
   Janitor tab. These reads reuse the last stored strategy.
2. Verify `available`, `status`, `generatedAt` (UTC), age, and the
   evidence coverage behind verified groups and candidate groups.
   Report proven **logical** savings, the survivor rule and any outstanding
   decisions. Compare the UTC generation timestamp with the requested day
   in the user's time zone. Physical freed space requires separate execution evidence.
3. Open the returned private `link` or use `screenPage` in Nestor.
   The dated view is `/diskx?janitor=latest&report=<encoded generatedAt>`.
   `GET /api/diskx/presentation?report=<encoded generatedAt>` returns the
   matching display reference, optionally with the exact group. Pass
   `data.read.id` and `data.read.revision` as `id` and `revision` to
   `read_presentation` for the bounded Core snapshot. On a report change
   (409), reread the summary. Refresh an expired reference from the view.
4. The `report` parameter binds the **latest** report to that date.
   For an earlier date, check the native job's retained
   `shared-drive-assessment-<timestamp>.json` with its authorized operator.
   The ZIP and DiskX have no arbitrary historical report lookup. If the
   archive is unavailable, report the date you can verify and the gap.

These reads neither refresh scans nor execute a survivor rule. Review
decisions record intent. Scans, report generation, approval and file actions
have distinct native controls and require applicable authorization. A paused
job, missing Data, an old report or a missing viewer leaves the corresponding
result pending or unavailable. Inspect the existing state before proposing work.

## Phone media and other storage workflows

`/diskx/phone` reads exact import receipts and verification progress.
`/diskx/photos` browses completed image proposals and owner review choices.
Check copy verification, the processing pause and the native cleanup receipt
separately. Opening these pages does not start processing. The user-selected
cleanup path revalidates source and backup bytes and requires explicit
confirmation. Use the source receipt to reconcile an uncertain dispatch.

Product references at the running revision are `data/README.md`,
`docs/OPERATIONS.md` (Data Toolbox and DiskX), `docs/PHOTO_IMPORT.md`,
`docs/PHOTO_PROCESSING.md`, and `integrations/openclaw/jobs/janitor/README.md`
for native assessment artifacts. Actual roots, schedules and retained files
belong to the private instance.
