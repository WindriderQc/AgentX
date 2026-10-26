# DSH Studio → Coding Team

This optional DSH **0.2.0-rc.2** bundle adds a native **Travail des agents**
panel. It presents Core's engineering work index and complete task dossiers
inside Studio: specification, feedback, attempts, recorded budgets, interventions
and deliverables. Search by task number or title, filter by status and page older
work. The existing sidebar-foot link still opens the full Pipeline monitor and
its native controls in a separate tab.

Core serves `/pipeline?view=studio` and owns the shared read service used by the
panel and Nestor's existing `pipeline_tasks` tool (`view=dossier`). Long dossiers
are read completely in hash-bound pages. A changing dossier requires a fresh
read; an empty deliverable registry does not imply an absence of work.

The DSH host entry remains inert. The browser registers native main/sidebar
slots and frames only the configured Core origin. Only this dedicated Core view
admits the exact configured `DSH_STUDIO_PUBLIC_URL` as an additional frame
ancestor. Other pages keep their existing frame restrictions. No runtime
credentials, tool grants, filesystem mounts, worker dispatch or session copying
are added. Isolated worker histories remain under their native owner; this panel
does not turn them into editable Studio sessions or claim their work is accepted.

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
the embedded work panel, and plugin disable/re-enable. A source test does not prove runtime installation.

In Studio's private `$DSH_HOME/profiles/web`, use the native package procedure:

```bash
DSH_HOME=/private/studio-home /selected/dsh/node_modules/.bin/dsh plugin --profile web add \
  /private/artifacts/agentx-dsh-coding-team-0.2.0.tgz
```

Keep the profile's existing bundle declarations, dependencies and lockfile.
DSH peers are supplied by the selected runtime: disable package-manager peer
auto-install (`auto-install-peers=false` for pnpm, or `--legacy-peer-deps` when
preparing the profile with npm). No runtime upgrade is required. The bundle's
native patch inserts only its `agentx-coding-team-ui` row.

Apply the reviewed instance installation through the existing operator path.
Keep the coding worker's isolated `DSH_HOME` untouched. Native authentication
remains enabled; qualification needs no prompt or model invocation. Disabling
this bundle removes its panel and link. Retain a profile snapshot and lockfile for
rollback, and restart Studio only under its existing ownership procedure.

## Source checks

```bash
npm test --prefix integrations/dsh/coding-team
```

The CPU fixtures exercise URL rejection, native slot attachment/cleanup, wide
and collapsed presentation, lazy bundle loading, native work-panel registration, host inactivity and external
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
narrow presentation, the embedded panel, new-tab isolation, and native plugin disable/re-enable.
All model requests fail the smoke, and the temporary profile is removed afterward.
