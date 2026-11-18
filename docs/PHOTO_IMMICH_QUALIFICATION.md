# Isolated Immich relocation qualification (not executed)

This is an operator qualification checklist, not a launch script or permission
to touch a live instance. The read-only code review of Immich 3.4.0 identifies
these configuration controls: `machineLearning.enabled`,
`machineLearning.availabilityChecks.enabled`, `machineLearning.clip.enabled`,
`machineLearning.duplicateDetection.enabled`,
`machineLearning.facialRecognition.enabled`, `machineLearning.ocr.enabled`,
`library.scan.enabled` and `library.watch.enabled`. Their existence is not
proof that all jobs are suppressed in a running instance.

## Isolation before startup

- Use a separate project, database, Redis, data volumes and internal network.
- Pin the reviewed server/database images, never copy production environment,
  credentials, database, volumes, mounts or configuration files.
- Generate small fictional raster images and synthetic XMP/metadata in the test
  directory. Do not use household photos, names, locations or descriptions.
- Do not start a machine-learning service. Disable the ML controls, availability
  checks, automatic library scan and watcher before first asset admission.
- Make the server inaccessible outside the test harness; no public ports or
  mounts of host media. Any necessary local port must bind loopback only.
- Verify the rendered configuration and actual mounts/network before use.
- Reserve shared compute through the normal queue before any resource-heavy
  qualification; do not compete with the live photo frame.

## Explicit scenarios

1. Import one synthetic external image/XMP pair, record all API-observable
   fields and associations, and observe every generated job until drained.
2. Add only fictional metadata: description, dates/timezone, location, tags,
   rating, favorite and an unshared test album. Confirm XMP round-trip and
   identify fields that remain database-only.
3. Record identities, move the synthetic pair within the sandbox, explicitly
   scan only its isolated library, and observe the old/new external asset IDs.
4. Exercise association restoration with every `/assets/copy` boolean specified.
   Use `sidecar:false`, `sharedLinks:false`, `stack:false` unless testing their
   precise isolated behavior; never infer all metadata was copied.
5. Verify each original metadata field and relation after restoration. Preserve
   unsupported metadata in an export; report it as not restored, never omit it.
6. Qualify interrupted indexing, timeout after an effect, changed target XMP,
   occupied original path and rollback while preserving newer human edits.
7. Verify that no model calls or uncontrolled scans occurred and that permissions
   did not widen. An empty ML service list alone does not prove no queued jobs.
8. Save a generic evidence matrix; destroy only this independently identified
   synthetic test project after validating all target paths and volumes.

## Limits

No isolated Immich stack is launched by this document or by the relocation
preflight. Filesystem/in-memory fault tests do not qualify database restoration,
Immich rebind, ACLs, backup restoration or model-job behavior. The live frame and
its paused photo processing remain outside this work.
