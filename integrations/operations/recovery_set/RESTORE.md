# Restore a native recovery generation

This directory contains private data and credentials. Verify every artifact
against `manifest.private.json` before import. `recovery-config.private.json`
identifies original homes, repositories, services and external credential targets.
Its paths describe the source installation; adapt them to a fresh destination.
Keep the sibling `source-releases/` receipts with the generation. They preserve
the exact operator terminal receipt and Core acknowledgment produced after capture;
use their original identities through the native owner when reconciling a restored
Core queue. They do not authorize replaying the work.

Restore only into empty homes and isolated databases. A client-only reinstall
reconnects to the existing Core instead of importing duplicate notes or personas.

1. Restore the bundled source revisions and installed patches. The OpenClaw
   package archive freezes the installed runtime; rebuild Hermes dependencies
   from its frozen source. Preserve the original paths as relocation metadata.
2. Use native `hermes import --force <profile.zip>` with `HERMES_HOME` pointing
   at a new home. Restore separately captured credential targets and profile
   links from `hermes-links.private.json`. Keep identities and profiles distinct.
3. Use native `openclaw backup restore openclaw-portable.tar.gz --target <new
   staging> --json`. Its payload contains the original private staging path;
   relocate that state root to the destination home. The unmodified source
   configuration is in `openclaw-original-config.private.json`. Rebase paths in
   a copy and recreate reviewed links using `openclaw-links.private.json`.
   Historical archives are separate from the active home. Native cache, lease,
   process and queued-delivery exclusions remain in effect.
4. Restore `instance-private.tar.gz` to private staging, then map external keys,
   environments, RAG originals and service definitions to the new installation.
   Its absolute source paths are archive member names, not permission to
   overwrite destination files. No service starts automatically from extraction.
5. If Core itself needs recovery, import `mongo.archive.gz` into an empty
   isolated MongoDB, and start an isolated Qdrant with `--storage-snapshot
   <qdrant-full-storage.snapshot>`. Both must have no access to live cluster
   services. Never merge an old dump over current owner data. Full storage
   includes private recall collections as well as document embeddings.
6. Compare durable files, validity/provenance, personality versions and vectors;
   inspect `restore-validation.private.json` for the received import evidence.
   Qualify native prompt loading before activating the intended agents. Expired
   provider credentials require their provider's native login flow.

A capture spans a recorded window of native per-store snapshots, not a global
Mongo/Qdrant transaction. The recurring job rejects observed critical-source
changes and rejects any RAG vector/payload mismatch in its isolated restoration.
Later writes belong to a later generation. Historical coordination records,
write plans and old queued deliveries are never instructions to replay effects.

The restoration check starts no agent, model, mail action, calendar action or
cluster controller. It restores data into empty isolated destinations, then
removes only those disposable homes/containers. Service activation remains a
separate operational step.
