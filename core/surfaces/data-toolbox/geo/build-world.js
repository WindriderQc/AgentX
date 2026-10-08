'use strict';

// Rebuilds public/geo/world-110m.json, the country outlines drawn by the
// Toolbox world map, from world-atlas' countries-110m.json (TopoJSON of
// Natural Earth 1:110m admin-0 countries). Run by hand when the upstream file
// changes; nothing runs it at build, test or start time:
//
//   node core/surfaces/data-toolbox/geo/build-world.js path/to/countries-110m.json
//
// The page needs plain rings, not a topology, so the arcs are stitched here
// and the page ships no TopoJSON decoder. Coordinates are rounded to a tenth
// of a degree and stored as integers (tenths), longitude then latitude.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const UPSTREAM = Object.freeze({
  package: 'world-atlas',
  version: '2.0.2',
  file: 'countries-110m.json',
  sha256: '2516c915867c7baf18ddec727aec46c315541a07cfb3d79a6559b05d5e94eee8'
});
const SCALE = 10; // stored units per degree
const OUTPUT = path.join(__dirname, '..', 'public', 'geo', 'world-110m.json');

// TopoJSON arcs are delta-encoded integer positions; the transform turns them
// into degrees.
function decodeArcs(topology) {
  const [sx, sy] = topology.transform.scale;
  const [tx, ty] = topology.transform.translate;
  return topology.arcs.map((arc) => {
    let x = 0; let y = 0;
    return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * sx + tx, y * sy + ty]; });
  });
}

// A ring lists arc indexes; a negative index ~i is arc i walked backwards.
// Consecutive arcs share their joining point, which is kept once.
function stitchRing(arcs, indexes) {
  const points = [];
  for (const index of indexes) {
    const arc = index < 0 ? [...arcs[~index]].reverse() : arcs[index];
    points.push(...(points.length ? arc.slice(1) : arc));
  }
  return points;
}

function ringArea(flat) {
  let twice = 0;
  for (let i = 0; i < flat.length; i += 2) {
    const j = (i + 2) % flat.length;
    twice += flat[i] * flat[j + 1] - flat[j] * flat[i + 1];
  }
  return Math.abs(twice) / 2;
}

// Rounds a ring, drops repeated points and a closing point (a stored ring is
// implicitly closed). A ring that collapses to nothing returns null.
function compactRing(points) {
  const flat = [];
  for (const [lon, lat] of points) {
    const x = Math.round(lon * SCALE); const y = Math.round(lat * SCALE);
    if (flat.length && flat.at(-2) === x && flat.at(-1) === y) continue;
    flat.push(x, y);
  }
  if (flat.length >= 4 && flat[0] === flat.at(-2) && flat[1] === flat.at(-1)) flat.length -= 2;
  return flat.length >= 6 && ringArea(flat) > 0 ? flat : null;
}

// Keeps the part of a ring on one side of a meridian (Sutherland–Hodgman).
// Where the ring leaves and re-enters, the pieces are joined along the
// meridian itself, which adds no area.
function clipAtMeridian(points, meridian, keepWest) {
  const inside = ([lon]) => keepWest ? lon <= meridian : lon >= meridian;
  const out = [];
  points.forEach((point, index) => {
    const previous = points[(index + points.length - 1) % points.length];
    if (inside(point) !== inside(previous)) {
      const t = (meridian - previous[0]) / (point[0] - previous[0]);
      out.push([meridian, previous[1] + t * (point[1] - previous[1])]);
    }
    if (inside(point)) out.push(point);
  });
  return out;
}

// world-atlas stitches rings through the antimeridian: Fiji and Russia jump
// from one edge of the map to the other, and Antarctica's ring goes around the
// pole. Drawn as they are they would streak across the map, so each such ring
// is cut at ±180° into rings that stay inside [-180, 180]. `points` is a
// closed ring; the answer is one or more rings.
function cutAtAntimeridian(points) {
  const open = points.slice(0, -1);
  let shift = 0;
  const unwrapped = open.map(([lon, lat], index) => {
    if (index) {
      const step = lon - open[index - 1][0];
      if (step > 180) shift -= 360; else if (step < -180) shift += 360;
    }
    return [lon + shift, lat];
  });
  const closing = open[0][0] - open.at(-1)[0];
  const turns = shift + (closing > 180 ? -360 : closing < -180 ? 360 : 0);
  if (turns !== 0) {
    // The ring circles a pole: it runs once from one edge of the map to the
    // other, and is closed along that pole.
    const first = unwrapped[0][0]; const last = unwrapped.at(-1)[0];
    if (Math.abs(first) !== 180 || last !== -first) throw new Error('a ring around a pole must start and end on the antimeridian');
    const pole = unwrapped.reduce((sum, point) => sum + point[1], 0) < 0 ? -90 : 90;
    return [[...unwrapped, [last, pole], [first, pole]]];
  }
  const lons = unwrapped.map(([lon]) => lon);
  const edge = Math.max(...lons) > 180 ? 180 : Math.min(...lons) < -180 ? -180 : null;
  if (edge === null) return [unwrapped];
  const within = clipAtMeridian(unwrapped, edge, edge === 180);
  const beyond = clipAtMeridian(unwrapped, edge, edge !== 180).map(([lon, lat]) => [lon - 2 * edge, lat]);
  return [within, beyond];
}

function buildWorld(topology) {
  const arcs = decodeArcs(topology);
  const countries = [];
  for (const geometry of topology.objects.countries.geometries) {
    const polygons = geometry.type === 'Polygon' ? [geometry.arcs] : geometry.arcs;
    const kept = [];
    for (const polygon of polygons) {
      // First ring is the outline, the others are holes.
      const [outline, ...holes] = polygon.map((ring) => stitchRing(arcs, ring));
      const pieces = cutAtAntimeridian(outline);
      if (pieces.length > 1 && holes.length) throw new Error(`${geometry.properties.name}: a cut polygon with holes is not handled`);
      const rings = pieces.map(compactRing).filter(Boolean);
      rings.forEach((ring, index) => kept.push(index ? [ring] : [ring, ...holes.map(compactRing).filter(Boolean)]));
    }
    if (!kept.length) throw new Error(`${geometry.properties.name} has no polygon left after rounding`);
    countries.push({ id: geometry.id ?? null, name: geometry.properties.name, polygons: kept });
  }
  // No edge may be left that spans more than half the globe, except the one
  // that closes a polar ring along the pole, on the edge of the map.
  for (const country of countries) {
    for (const ring of country.polygons.flat()) {
      for (let i = 0; i < ring.length; i += 2) {
        const j = (i + 2) % ring.length;
        const alongPole = ring[i + 1] === ring[j + 1] && Math.abs(ring[i + 1]) === 90 * SCALE;
        if (Math.abs(ring[i] - ring[j]) > 180 * SCALE && !alongPole) throw new Error(`${country.name} has an edge across the antimeridian`);
      }
    }
  }
  countries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return {
    source: `Natural Earth 1:110m admin-0 countries, from ${UPSTREAM.package} ${UPSTREAM.version} ${UPSTREAM.file}`,
    licence: 'Natural Earth: public domain. world-atlas: ISC. See CREDITS.md beside this file.',
    scale: SCALE,
    countries
  };
}

// One country per line: a later rebuild shows as a readable diff.
function serialize(world) {
  const { countries, ...head } = world;
  return `${JSON.stringify(head).slice(0, -1)},"countries":[\n${countries.map((country) => JSON.stringify(country)).join(',\n')}\n]}\n`;
}

if (require.main === module) {
  const input = process.argv[2];
  if (!input) { console.error('usage: node build-world.js path/to/countries-110m.json'); process.exit(2); }
  const raw = fs.readFileSync(input);
  const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
  if (sha256 !== UPSTREAM.sha256) {
    console.error(`unexpected input: sha256 ${sha256}, expected ${UPSTREAM.sha256} (${UPSTREAM.package} ${UPSTREAM.version}). Update UPSTREAM and CREDITS.md when changing the source.`);
    process.exit(1);
  }
  const text = serialize(buildWorld(JSON.parse(raw)));
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, text);
  console.log(`${OUTPUT}: ${Buffer.byteLength(text)} bytes`);
}

module.exports = { buildWorld, clipAtMeridian, compactRing, cutAtAntimeridian, decodeArcs, serialize, stitchRing };
