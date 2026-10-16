# DSH Studio → Coding Team

This optional DSH **0.2.0-rc.2** bundle adds **AgentX Coding Team** at the native
sidebar foot. It opens AgentX's `/pipeline#pipelineWorkerMonitor` in a new tab.
Pipeline remains the owner of worker status, launch and cooperative stop.

The host entry is inert. The browser registers one ordinary native slot action,
with no API requests, model tools, prompts, credentials, worker sessions or
filesystem access. DSH's Web authentication, Core's human entry and their CSP
continue to govern the two pages. This is a link, not a second worker interface.

## Build an instance artifact

The source has no host URL. Supply the private HTTPS Core origin when building:

```bash
node integrations/dsh/coding-team/scripts/package.mjs \
  --core-url https://agentx.example \
  --output /private/artifacts/dsh-coding-team
npm pack /private/artifacts/dsh-coding-team --ignore-scripts \
  --pack-destination /private/artifacts
```

The output must be a **new directory outside this repository** whose parent
already exists. The generated package contains the instance URL; keep it and its
tarball outside public Git. The builder rejects credentials, query parameters,
non-HTTPS origins and symlink destinations inside the source tree. Build again
in a new external directory when the origin changes. The package is private to
prevent accidental npm publication.

## Install only in Studio

Stage the tarball in a disposable `DSH_HOME` first, with the same selected
runtime and a dummy provider that cannot reach a live model. Verify the native
Web page at desktop and narrow widths, the accessible link, its new-tab target,
and plugin disable/re-enable. A source test does not prove runtime installation.

In Studio's private `$DSH_HOME/profiles/web`, use the native package procedure:

```bash
DSH_HOME=/private/studio-home /selected/dsh/node_modules/.bin/dsh plugin --profile web add \
  /private/artifacts/agentx-dsh-coding-team-0.1.0.tgz
```

Keep the profile's existing bundle declarations, dependencies and lockfile.
DSH peers are supplied by the selected runtime: disable package-manager peer
auto-install (`auto-install-peers=false` for pnpm, or `--legacy-peer-deps` when
preparing the profile with npm). No runtime upgrade is required. The bundle's
native patch inserts only its `agentx-coding-team-ui` row.

Apply the reviewed instance installation through the existing operator path.
Keep the coding worker's isolated `DSH_HOME` untouched. Native authentication
remains enabled; qualification needs no prompt or model invocation. Disabling
this bundle removes only the link. Retain a profile snapshot and lockfile for
rollback, and restart Studio only under its existing ownership procedure.

## Source checks

```bash
npm test --prefix integrations/dsh/coding-team
```

The CPU fixtures exercise URL rejection, native slot attachment/cleanup, wide
and collapsed presentation, lazy bundle loading, host inactivity and external
artifact containment. See [Studio setup](../../../docs/DSH_RESUMPTION.md) for
the runtime's native admission and authentication contract.

The optional native smoke uses already installed DSH and Playwright artifacts,
an isolated temporary home and a dummy provider. It never submits a prompt:

```bash
node integrations/dsh/coding-team/scripts/smoke.mjs \
  --runtime-root /selected/dsh \
  --playwright-module /test-tools/node_modules/playwright/index.mjs \
  --chromium /test-tools/chromium/chrome
```

It checks the actual packed package, native authenticated Web boot, desktop and
narrow presentation, the new-tab isolation, and native plugin disable/re-enable.
All model requests fail the smoke, and the temporary profile is removed afterward.
