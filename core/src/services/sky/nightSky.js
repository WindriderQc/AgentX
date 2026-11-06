'use strict';

// Where the Moon, the bright planets and the brightest stars stand in the sky above an
// observer, for a picture of the real night sky. Low-precision formulas, no dependency:
//   Sun and Moon: the Astronomical Almanac's low-precision series (Moon about 0.3°).
//   Planets: JPL's approximate Keplerian elements (Standish, valid 1800–2050), a few arcminutes.
//   Stars: J2000 positions; precession since then (well under 1°) is ignored.
// Good for drawing and naming what is up tonight; not for pointing a telescope.

const RAD = Math.PI / 180;
const sin = deg => Math.sin(deg * RAD), cos = deg => Math.cos(deg * RAD);
const norm = deg => ((deg % 360) + 360) % 360;
const atan2 = (y, x) => Math.atan2(y, x) / RAD;
const asin = value => Math.asin(Math.max(-1, Math.min(1, value))) / RAD;

const daysSinceJ2000 = date => date.getTime() / 86400000 + 2440587.5 - 2451545.0;
const obliquity = d => 23.439 - 0.0000004 * d;

function eclipticToEquatorial(lambda, beta, d) {
  const e = obliquity(d);
  const ra = atan2(sin(lambda) * cos(e) - Math.tan(beta * RAD) * sin(e), cos(lambda));
  return { raDeg: norm(ra), decDeg: asin(sin(beta) * cos(e) + cos(beta) * sin(e) * sin(lambda)) };
}

function sunPosition(d) {
  const g = norm(357.528 + 0.9856003 * d), L = norm(280.460 + 0.9856474 * d);
  const lambda = norm(L + 1.915 * sin(g) + 0.020 * sin(2 * g));
  return { lambda, distanceAu: 1.00014 - 0.01671 * cos(g) - 0.00014 * cos(2 * g), ...eclipticToEquatorial(lambda, 0, d) };
}

function moonPosition(d) {
  const T = d / 36525;
  const lambda = norm(218.32 + 481267.881 * T + 6.29 * sin(135.0 + 477198.87 * T) - 1.27 * sin(259.3 - 413335.36 * T)
    + 0.66 * sin(235.7 + 890534.22 * T) + 0.21 * sin(269.9 + 954397.74 * T) - 0.19 * sin(357.5 + 35999.05 * T)
    - 0.11 * sin(186.5 + 966404.03 * T));
  const beta = 5.13 * sin(93.3 + 483202.02 * T) + 0.28 * sin(228.2 + 960400.89 * T) - 0.28 * sin(318.3 + 6003.15 * T)
    - 0.17 * sin(217.6 - 407332.21 * T);
  const parallax = 0.9508 + 0.0518 * cos(135.0 + 477198.87 * T) + 0.0095 * cos(259.3 - 413335.36 * T)
    + 0.0078 * cos(235.7 + 890534.22 * T) + 0.0028 * cos(269.9 + 954397.74 * T);
  return { lambda, beta, parallax, ...eclipticToEquatorial(lambda, beta, d) };
}

// a (AU), e, I, L, long. perihelion, long. node (degrees), each with its rate per century.
const ELEMENTS = {
  earth: [[1.00000261, 0.00000562], [0.01671123, -0.00004392], [-0.00001531, -0.01294668], [100.46457166, 35999.37244981], [102.93768193, 0.32327364], [0, 0]],
  venus: [[0.72333566, 0.00000390], [0.00677672, -0.00004107], [3.39467605, -0.00078890], [181.97909950, 58517.81538729], [131.60246718, 0.00268329], [76.67984255, -0.27769418]],
  mars: [[1.52371034, 0.00001847], [0.09339410, 0.00007882], [1.84969142, -0.00813131], [-4.55343205, 19140.30268499], [-23.94362959, 0.44441088], [49.55953891, -0.29257343]],
  jupiter: [[5.20288700, -0.00011607], [0.04838624, -0.00013253], [1.30439695, -0.00183714], [34.39644051, 3034.74612775], [14.72847983, 0.21252668], [100.47390909, 0.20469106]],
  saturn: [[9.53667594, -0.00125060], [0.05386179, -0.00050991], [2.48599187, 0.00193609], [49.95424423, 1222.49362201], [92.59887831, -0.41897216], [113.66242448, -0.28867794]]
};
// Brightness at 1 AU from both Sun and Earth, ignoring phase and rings: enough to rank them.
const PLANETS = [
  { id: 'venus', name: 'Vénus', base: -4.4 },
  { id: 'mars', name: 'Mars', base: -1.5 },
  { id: 'jupiter', name: 'Jupiter', base: -9.4 },
  { id: 'saturn', name: 'Saturne', base: -8.9 }
];

function heliocentric(id, T) {
  const [a, e, I, L, peri, node] = ELEMENTS[id].map(([value, rate]) => value + rate * T);
  const M = norm(L - peri) * RAD, w = peri - node;
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 8; i += 1) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  return {
    x: (cos(w) * cos(node) - sin(w) * sin(node) * cos(I)) * xp + (-sin(w) * cos(node) - cos(w) * sin(node) * cos(I)) * yp,
    y: (cos(w) * sin(node) + sin(w) * cos(node) * cos(I)) * xp + (-sin(w) * sin(node) + cos(w) * cos(node) * cos(I)) * yp,
    z: sin(w) * sin(I) * xp + cos(w) * sin(I) * yp
  };
}

function planetPosition(id, d) {
  const T = d / 36525, planet = heliocentric(id, T), earth = heliocentric('earth', T);
  const x = planet.x - earth.x, y = planet.y - earth.y, z = planet.z - earth.z;
  const distanceAu = Math.hypot(x, y, z), sunAu = Math.hypot(planet.x, planet.y, planet.z);
  const lambda = norm(atan2(y, x)), beta = atan2(z, Math.hypot(x, y));
  return { lambda, beta, distanceAu, sunAu, ...eclipticToEquatorial(lambda, beta, d) };
}

// Name, right ascension (hours), declination (degrees), magnitude. The brightest stars seen
// from southern Quebec, plus the stars that draw a few well-known figures.
const STARS = [
  ['Sirius', 6.7525, -16.716, -1.46], ['Arcturus', 14.2611, 19.182, -0.05], ['Véga', 18.6156, 38.784, 0.03],
  ['Capella', 5.2781, 45.998, 0.08], ['Rigel', 5.2422, -8.202, 0.13], ['Procyon', 7.6550, 5.225, 0.34],
  ['Bételgeuse', 5.9195, 7.407, 0.5], ['Altaïr', 19.8464, 8.868, 0.77], ['Aldébaran', 4.5987, 16.509, 0.85],
  ['Antarès', 16.4901, -26.432, 0.96], ['Spica', 13.4199, -11.161, 0.97], ['Pollux', 7.7553, 28.026, 1.14],
  ['Fomalhaut', 22.9608, -29.622, 1.16], ['Deneb', 20.6905, 45.280, 1.25], ['Régulus', 10.1395, 11.967, 1.35],
  ['Adhara', 6.9771, -28.972, 1.5], ['Castor', 7.5767, 31.888, 1.58], ['Shaula', 17.5601, -37.104, 1.63],
  ['Bellatrix', 5.4189, 6.350, 1.64], ['Elnath', 5.4382, 28.608, 1.65], ['Alnilam', 5.6036, -1.202, 1.69],
  ['Alnitak', 5.6793, -1.943, 1.77], ['Alioth', 12.9005, 55.960, 1.77], ['Dubhe', 11.0621, 61.751, 1.79],
  ['Mirfak', 3.4054, 49.861, 1.79], ['Wezen', 7.1399, -26.393, 1.83], ['Alkaid', 13.7923, 49.313, 1.86],
  ['Menkalinan', 5.9921, 44.948, 1.9], ['Alhena', 6.6285, 16.399, 1.93], ['Polaris', 2.5302, 89.264, 1.98],
  ['Mirzam', 6.3783, -17.956, 1.98], ['Alphard', 9.4598, -8.659, 1.98], ['Hamal', 2.1196, 23.462, 2.0],
  ['Mirach', 1.1622, 35.621, 2.05], ['Saiph', 5.7959, -9.670, 2.06], ['Alphératz', 0.1398, 29.091, 2.06],
  ['Rasalhague', 17.5822, 12.560, 2.08], ['Kochab', 14.8451, 74.156, 2.08], ['Algol', 3.1361, 40.956, 2.1],
  ['Almach', 2.0650, 42.330, 2.1], ['Dénébola', 11.8177, 14.572, 2.14], ['Sadr', 20.3705, 40.257, 2.23],
  ['Alphecca', 15.5781, 26.715, 2.23], ['Mintaka', 5.5334, -0.299, 2.23], ['Schédar', 0.6751, 56.537, 2.24],
  ['Eltanin', 17.9434, 51.489, 2.24], ['Caph', 0.1530, 59.150, 2.28], ['Merak', 11.0307, 56.382, 2.37],
  ['Enif', 21.7364, 9.875, 2.39], ['Scheat', 23.0629, 28.083, 2.42], ['Phecda', 11.8972, 53.695, 2.44],
  ['Navi', 0.9451, 60.717, 2.47], ['Gienah', 20.7702, 33.970, 2.48], ['Markab', 23.0794, 15.205, 2.49],
  ['Ruchbah', 1.4303, 60.235, 2.68], ['Algénib', 0.2206, 15.184, 2.83], ['Fawaris', 19.7496, 45.131, 2.87],
  ['Albiréo', 19.5120, 27.960, 3.08], ['Megrez', 12.2571, 57.033, 3.31], ['Segin', 1.9066, 63.670, 3.37],
  ['Mizar', 13.3988, 54.925, 2.27]
];
const FIGURES = [
  { name: 'Grande Ourse', lines: [['Dubhe', 'Merak'], ['Merak', 'Phecda'], ['Phecda', 'Megrez'], ['Megrez', 'Dubhe'], ['Megrez', 'Alioth'], ['Alioth', 'Mizar'], ['Mizar', 'Alkaid']] },
  { name: 'Orion', lines: [['Bételgeuse', 'Bellatrix'], ['Bellatrix', 'Mintaka'], ['Bételgeuse', 'Alnitak'], ['Mintaka', 'Alnilam'], ['Alnilam', 'Alnitak'], ['Mintaka', 'Rigel'], ['Alnitak', 'Saiph'], ['Saiph', 'Rigel']] },
  { name: 'Cassiopée', lines: [['Caph', 'Schédar'], ['Schédar', 'Navi'], ['Navi', 'Ruchbah'], ['Ruchbah', 'Segin']] },
  { name: 'Cygne', lines: [['Deneb', 'Sadr'], ['Sadr', 'Albiréo'], ['Gienah', 'Sadr'], ['Sadr', 'Fawaris']] },
  { name: 'Pégase', lines: [['Alphératz', 'Scheat'], ['Scheat', 'Markab'], ['Markab', 'Algénib'], ['Algénib', 'Alphératz']] }
];

// Local horizontal position: altitude above the horizon and azimuth from north, clockwise.
function horizontal(raDeg, decDeg, lat, lon, d) {
  const lst = norm(280.46061837 + 360.98564736629 * d + lon);
  const H = norm(lst - raDeg);
  const altDeg = asin(sin(lat) * sin(decDeg) + cos(lat) * cos(decDeg) * cos(H));
  const azDeg = norm(atan2(sin(H), cos(H) * sin(lat) - Math.tan(decDeg * RAD) * cos(lat)) + 180);
  return { altDeg, azDeg };
}
// Refraction lifts objects near the horizon by about half a degree.
const refracted = alt => (alt > -1 ? alt + 1.02 / Math.tan((alt + 10.3 / (alt + 5.11)) * RAD) / 60 : alt);
const round1 = value => Math.round(value * 10) / 10;

function moonPhase(sun, moon) {
  const elongation = Math.acos(Math.max(-1, Math.min(1, sin(sun.decDeg) * sin(moon.decDeg)
    + cos(sun.decDeg) * cos(moon.decDeg) * cos(sun.raDeg - moon.raDeg)))) / RAD;
  const illumination = (1 - cos(elongation)) / 2;
  const waxing = norm(moon.lambda - sun.lambda) < 180;
  const age = norm(moon.lambda - sun.lambda) / 360; // 0 new, 0.5 full
  const name = illumination < 0.03 ? 'nouvelle lune' : illumination > 0.97 ? 'pleine lune'
    : Math.abs(illumination - 0.5) < 0.06 ? (waxing ? 'premier quartier' : 'dernier quartier')
      : illumination < 0.5 ? (waxing ? 'croissant' : 'dernier croissant') : (waxing ? 'gibbeuse croissante' : 'gibbeuse décroissante');
  return { illumination: Math.round(illumination * 100) / 100, waxing, age: Math.round(age * 1000) / 1000, name };
}

// Drawing candidates plus independent planet positions, including below the horizon.
// Angles only: the observer's place never leaves this function.
function skyView(lat, lon, date = new Date(), { minAltDeg = -1 } = {}) {
  if (![lat, lon].every(Number.isFinite)) return null;
  const d = daysSinceJ2000(date);
  const sun = sunPosition(d), moon = moonPosition(d);
  const sunHere = horizontal(sun.raDeg, sun.decDeg, lat, lon, d);
  const moonHere = horizontal(moon.raDeg, moon.decDeg, lat, lon, d);
  const moonAlt = refracted(moonHere.altDeg - moon.parallax * cos(moonHere.altDeg)); // seen from the surface
  const planets = [], planetPositions = [];
  for (const planet of PLANETS) {
    const position = planetPosition(planet.id, d);
    const here = horizontal(position.raDeg, position.decDeg, lat, lon, d);
    const altDeg = refracted(here.altDeg);
    const separation = Math.acos(Math.max(-1, Math.min(1, sin(sun.decDeg) * sin(position.decDeg)
      + cos(sun.decDeg) * cos(position.decDeg) * cos(sun.raDeg - position.raDeg)))) / RAD;
    const body = { id: planet.id, name: planet.name, altDeg: round1(altDeg), azDeg: round1(here.azDeg),
      mag: round1(planet.base + 5 * Math.log10(position.sunAu * position.distanceAu)), sunSeparationDeg: round1(separation) };
    planetPositions.push(body);
    if (altDeg >= minAltDeg) planets.push(body);
  }
  const stars = [];
  for (const [name, raHours, decDeg, mag] of STARS) {
    const here = horizontal(raHours * 15, decDeg, lat, lon, d);
    const altDeg = refracted(here.altDeg);
    if (altDeg >= minAltDeg) stars.push({ name, altDeg: round1(altDeg), azDeg: round1(here.azDeg), mag });
  }
  const up = new Set(stars.filter(star => star.altDeg > 0).map(star => star.name));
  const figures = FIGURES.filter(figure => figure.lines.every(pair => pair.every(name => up.has(name))))
    .map(figure => ({ name: figure.name, lines: figure.lines }));
  return {
    sun: { altDeg: round1(refracted(sunHere.altDeg)), azDeg: round1(sunHere.azDeg) },
    moon: { altDeg: round1(moonAlt), azDeg: round1(moonHere.azDeg), ...moonPhase(sun, moon) },
    planets, planetPositions, stars, figures
  };
}

module.exports = { skyView, sunPosition, moonPosition, planetPosition, horizontal, moonPhase, daysSinceJ2000, STARS, FIGURES };
