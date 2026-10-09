# World map geometry

`world-110m.json` holds the country outlines drawn by the Data Toolbox world
map. It is the only third-party material of this surface; its licences apply
independently of the repository's MIT code licence.

| | |
| --- | --- |
| Data | [Natural Earth](https://www.naturalearthdata.com/) Admin 0 – Countries, 1:110m small scale (version 4.1.0 according to the world-atlas README). Public domain. |
| Packaging | [world-atlas](https://github.com/topojson/world-atlas) 2.0.2, file `countries-110m.json` (TopoJSON), sha256 `2516c915867c7baf18ddec727aec46c315541a07cfb3d79a6559b05d5e94eee8`. ISC licence, below. |
| Shipped file | `world-110m.json`: 177 countries, about 98 KB. |

## How the file is produced

`core/surfaces/data-toolbox/geo/build-world.js` rebuilds it from the upstream
file and refuses any other input than the one whose checksum is above:

```bash
npm pack world-atlas@2.0.2 && tar -xzf world-atlas-2.0.2.tgz package/countries-110m.json
node core/surfaces/data-toolbox/geo/build-world.js package/countries-110m.json
```

The script is run by hand when the source changes. Nothing downloads the
upstream file at install, build, test, start or page load.

It changes the upstream data in four ways:

- the TopoJSON arcs are stitched into plain rings, so the page needs no decoder;
- coordinates are rounded to a tenth of a degree and stored as integers
  (tenths of a degree, longitude then latitude), a ring being implicitly closed;
- the rings that upstream runs through the antimeridian (Fiji, Russia) are cut
  at ±180° into separate polygons, and Antarctica's ring around the pole is
  closed along latitude −90°;
- countries are sorted by name.

Country names, the numeric ISO 3166-1 identifiers and the boundaries
themselves, disputed ones included, are those of the upstream file. Three
entries have no identifier there (Kosovo, N. Cyprus, Somaliland).

## world-atlas licence (ISC)

Copyright 2013-2019 Michael Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
