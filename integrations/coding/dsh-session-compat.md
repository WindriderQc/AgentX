# Pinned DSH legacy-session read compatibility

`dsh-session-compat.py` is an explicit operator installer for
`@deepseek-ai/dsh-session-format-v0-to-v1@0.2.0-rc.2`, targeting only
`lib/index.js`. It uses a bundled, hash-pinned replacement artifact. It does not
run from either DSH launcher.

The compatibility change admits the known legacy descriptor-v2 shape while
preserving its version and fields. It does not promote that descriptor to v3
or establish that a legacy subagent can resume. Unknown fields, unsupported
values and unsupported versions retain their validation failures. Original
session files remain untouched; the derived session-search index remains
upstream's responsibility.

Pass the package directory explicitly. A package-directory link, such as pnpm's
link under `node_modules`, is resolved once. The package manifest, `lib`
directory and target file must be real files/directories inside that resolved
package directory.

```sh
python3 integrations/coding/dsh-session-compat.py \
  --package-root /path/to/dsh/node_modules/@deepseek-ai/dsh-session-format-v0-to-v1 \
  --check
```

`--check` prints a JSON plan and writes nothing. Only the exact upstream source
or exact already-patched source is accepted. A different package version,
source hash, bundled artifact, symlinked target or unsupported path refuses.
`state: compatible` describes source compatibility, not an installed-runtime
qualification.

For an approved maintenance operation, stop processes that use or modify this
package and retain the original package/install receipt outside Git. Keep the
instance's native queue and maintenance ownership. Then use the same command
with `--apply`. The installer never stops or starts processes and never invokes
a model. Reinstallation or an upstream upgrade requires a fresh explicit check;
there is no automatic repatching.

Apply holds an advisory source lock, stages the complete result in the target
directory, preserves the original file mode and ownership, rechecks the
manifest and source identity/bytes, and publishes using atomic replacement.
Only the reviewed replacement bytes change; upstream license text is retained.
The lock coordinates this installer, so unrelated package writers must remain
stopped during the final compare and rename. The installer does not claim an
atomic compare-and-swap against writers that ignore its lock.

Repeating either mode against the exact patched source returns
`state: already_applied` without replacing it. `APPLY_OUTCOME_UNKNOWN` means the
replacement occurred but its durability receipt was lost: reconcile with
`--check` before deciding what to do next. Unexpected drift is never repaired
automatically. This command neither reads nor rewrites native histories,
settings, session indexes, coordination records or queues.

Disposable installer regressions require Python's standard library only:

```sh
python3 -m unittest discover -s integrations/coding/tests \
  -p test_dsh_session_compat.py -v
```

The synthetic migration qualifier needs an existing DSH 0.2.0-rc.2 runtime and
Node.js 24. It copies only the target package's manifest and source into a new
temporary directory, applies this installer there, and resolves the remaining
read-only dependencies from the supplied runtime. It tests the complete v0→v4
chain, retained parent discovery, strict malformed/unknown refusals and current
v3 behavior. It also verifies that the retained v2 descriptor still produces no
current runtime identity. Its fixtures contain no native sessions.

```sh
node integrations/coding/dsh-session-compat-semantics.mjs \
  --runtime-root /path/to/dsh
```

Source checks establish installer behavior. Native cold-read/search acceptance
and runtime activation are separate operator steps with private receipts.
