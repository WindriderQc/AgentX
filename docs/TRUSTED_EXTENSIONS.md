# Current extension boundary

Core can load explicitly configured local extension modules through
`trustedExtensionLoader` and its injected contracts. It is disabled by default.
The built-in surfaces (Household, PsyX, Data Toolbox) do not depend on it: Core
registers them directly for the `full` profile. The loader is a seam for
instance-specific modules, not a reason to keep product code in another
repository. See [ARCHITECTURE.md](ARCHITECTURE.md) for ownership.
