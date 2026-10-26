# Community plugins in DSH Studio

Third-party packages stay owned by their upstream projects. Studio's runtime,
profile and model route remain instance choices; adding a UI plugin does not
replace Core inference, canonical memory or task ownership.

`prepare-dsh-community-plugin.cjs` prepares two reviewed upstream clients for
DSH `0.2.0-rc.2`: Explorer `0.1.0` uses the current icon exports and the active
conversation's explicit Session identity. Its fixed drawer is contributed by
the conversation header, rather than reading the removed global `current`
selection from the Session catalog. Open a conversation to use its file tree.
Plugin Mall
`0.4.17` registers its marketplace under a settings section and carries its RPC
over native authenticated exact Fetch routes on `/api/market/*`. The runtime's
custom-channel registration fails its WebServer injection check, so the adapter
uses the existing shared API carrier and native envelope schema. Host tools,
installation preflight, confirmation, and dispatch handlers are unchanged.
Source versions and client/host SHA-256 digests must match.
The helper copies an unpacked package into a new directory, retains upstream
licensing and writes provenance. Pack that directory and install its tarball
through the native plugin manager with install scripts disabled. Never patch
installed `node_modules`: pnpm can share those files between profiles.

```sh
node integrations/coding/prepare-dsh-community-plugin.cjs /path/to/unpacked/package /path/to/new-output
npm pack --ignore-scripts /path/to/new-output
node --test integrations/coding/prepare-dsh-community-plugin.test.cjs
```

Keep archives, lockfiles, profile snapshots and installation evidence outside
public Git. Test the assembled profile and authenticated browser before replacing
the live profile; successful package installation alone is insufficient.

For a service-managed Studio, set Plugin Mall's `allowRestart: false` in the
profile patch and restart through the service owner. Retain native install
preflight, confirmation and startup-recovery requirements. New upstream versions
need review rather than an automatic reapplication of these edits.

Upstreams: [Explorer](https://github.com/No-PRM/dsh-explorer),
[Plugin Mall](https://github.com/1e0zj/dsh-plugin-mall).
