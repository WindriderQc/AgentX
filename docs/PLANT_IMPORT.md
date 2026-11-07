# Import plant photos

The parent Plants page offers **Importer depuis le dossier**. The instance
sets `HOUSEHOLD_PLANT_IMPORT_DIR` to a relative folder under its read-only
photos mount (for example `Maison/Plantes`). Compose passes the setting to
Core. Without it, the page reports that folder import is unconfigured. A missing
or unreadable folder reports unavailable. Discovery reads the folder directly;
it does not use the Data file index.

Core lists direct files, in pages of 20, within a maximum of 500 entries.
Subdirectories are excluded. When the directory exceeds that budget the page
says to reduce its contents. JPEG, PNG and WebP are detected by their bytes,
independently of the filename extension. Files must contain 1 byte to 50 MiB;
decoding is limited to 40 million pixels. HEIC/HEIF files explain that the parent
must convert them to JPEG first. Malformed images are refused. Thumbnails are
small JPEGs produced in memory; they carry no source metadata and are not cached.
Absolute paths, `..`, symlink traversal and files outside the configured folder
are refused. Import and thumbnail reads recheck the displayed SHA-256.

The parent selects one to four photos for one plant, supplies its name and
confirms its room. The first filename segment supplies a room hint, such as
`salon-fenetre-1.jpg` → `Salon`. The selection creates a draft. Core converts
display photos to JPEG, at most 1600 pixels on either side and 2 MiB, and stores
them through the existing plant-photo service. The optional image archive keeps
original bytes with `origin: uploaded`, `surface: household` and the plant id.
Without an archive the original remains in the mounted source folder. Source
files are never moved, renamed or modified.

`household_plant_imports` keeps the original hashes, group, card identity,
optional archive receipts and identification request. A unique multikey index
claims all group hashes atomically. Identical groups replay their original card;
an overlapping group refuses instead of silently moving a photo to another
plant. Removing a display photo or retiring a plant does not release the original
hash claim. Interrupted photo storage resumes against the same card identity.
The parent must replay the same group while it is incomplete. The original
selection remains available in the source folder; no household bytes belong in
Git.

Each imported group enrolls an immutable `other` heavy-work request with
`executor: { mode: "plant-identify", importId }`. The route for `plant_identify`
is resolved and stored before submission. Lost submission responses reuse that
same request key and route. An absent route, queue migration requirement or
planning failure leaves a visible parent draft and an explicit waiting state.
The queue observer retries planning under the original identity.

The native import executor reserves a five-minute slot, crosses Core's dispatch
fence and invokes the existing plant assistant through native inference
admission, with its exact queued host and model. A single durable Mongo slot
serializes all imported plants across processes, including across routing
changes. A changed route refuses launch. A reservation outside its planned
window does not launch; the operator reviews it in the existing queue UI.
Completion stores candidates on the draft and the queue waits for native runtime
release before admitting the next plant. A lost process or uncertain launch
keeps its request and global slot fenced for operator reconciliation; it never
replays inference. An operator-reconciled terminal request releases that slot.

The import action authorizes this bounded identification proposal, not
publication. Direct identification refuses while the draft's queue operation is
pending. The parent still chooses the species, reviews care and toxicity and
publishes using the existing revision-bound plant workflow. Child list, card and
photo projections expose only published plants. The importer retains the
existing parent-action access contract from #865: pinned family devices retain
parent actions; this feature does not introduce a new authentication policy.
The import UI is absent from Ma jungle.

CPU tests use synthetic temporary folders, disposable MongoDB and a fake
inference provider. They cover confinement, byte formats, decoding and size
bounds, grouping, concurrent retries, archive and display receipts, child
projection isolation, queue identities, serialization and uncertain outcomes.
These checks establish source behavior only. Instance configuration, a real
folder import, real model execution and phone acceptance require separate
owner-authorized acceptance; deployment does not follow from passing tests.
