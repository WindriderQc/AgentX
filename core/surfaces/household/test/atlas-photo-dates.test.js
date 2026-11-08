'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = name => import(path.join(__dirname, '..', 'public', 'atlas', `${name}.js`));
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DATE = '2026-11-01T12:00:00.000Z';

test('library and viewer retain a file date with its exact label and unknown capture', async () => {
  const { libraryPhoto } = await load('library'), { photoDate } = await load('gallery');
  const photo = libraryPhoto({ id: ID, takenAt: DATE, takenAtSource: 'fileCreatedAt', dateTimeOriginal: null });
  assert.equal(photo.date, '2026-11-01');
  assert.equal(photo.dateLabel, 'date du fichier');
  assert.match(photo.dateNote, /date originale EXIF inconnue/);
  assert.match(photo.dateNote, /ne confirme ni la prise de vue/);
  assert.match(photoDate(photo), /^date du fichier · /);
  assert.deepEqual(photo.eventIds, [], 'metadata dates create no event binding');
});

test('a local Immich date is not presented as original EXIF or verified capture', async () => {
  const { libraryPhoto } = await load('library'), { photoDate } = await load('gallery');
  const photo = libraryPhoto({ id: ID, takenAt: DATE, takenAtSource: 'localDateTime' });
  assert.equal(photo.dateLabel, 'date locale Immich');
  assert.match(photoDate(photo), /^date locale Immich · /);
  assert.match(photo.dateNote, /fournie par Immich ; date originale EXIF inconnue/);
});

test('EXIF metadata has an explicit label without confirming capture or people', async () => {
  const { libraryPhoto } = await load('library');
  const photo = libraryPhoto({ id: ID, takenAt: DATE, takenAtSource: 'exifInfo.dateTimeOriginal', dateTimeOriginal: DATE });
  assert.equal(photo.dateLabel, 'date originale EXIF');
  assert.match(photo.dateNote, /elle ne confirme ni la prise de vue ni la présence d’une personne/);
});

test('older Core responses retain their date without inventing its origin', async () => {
  const { libraryPhoto } = await load('library');
  const photo = libraryPhoto({ id: ID, takenAt: DATE });
  assert.equal(photo.date, '2026-11-01');
  assert.equal(photo.dateLabel, 'date de bibliothèque');
  assert.match(photo.dateNote, /origine inconnue/);
});

test('missing, cleared and invalid dates remain undated without day precision', async () => {
  const { libraryPhoto } = await load('library'), { photoDate } = await load('gallery');
  for (const takenAt of [null, undefined, '', 'not-a-date', '2025-02-29T12:00:00Z', '2025', {}]) {
    const photo = libraryPhoto({ id: ID, takenAt, takenAtSource: 'fileCreatedAt' });
    assert.equal(photo.date, null);
    assert.equal(photo.precision, 'unknown');
    assert.equal(photoDate(photo), 'Date à préciser');
    assert.match(photo.dateNote, /prise de vue inconnue/);
  }
});
