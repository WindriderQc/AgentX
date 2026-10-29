'use strict';
const { resolve } = require('../../public/js/transcription-time');
it('converts the chosen timezone independently of the browser timezone', () => {
  expect(resolve('2027-01-15T10:30', 'America/Toronto')).toBe('2027-01-15T15:30:00.000Z');
  expect(resolve('2027-07-15T10:30', 'America/Toronto')).toBe('2027-07-15T14:30:00.000Z');
  expect(resolve('2027-01-15T10:30', 'Asia/Kathmandu')).toBe('2027-01-15T04:45:00.000Z');
});
it('refuses nonexistent and ambiguous DST wall times and invalid dates', () => {
  expect(() => resolve('2027-03-14T02:30', 'America/Toronto')).toThrow('n’existe pas');
  expect(() => resolve('2027-11-07T01:30', 'America/Toronto')).toThrow('deux fois');
  expect(() => resolve('2027-02-30T10:00', 'UTC')).toThrow();
  expect(() => resolve('2027-01-15T10:00', 'invalid')).toThrow();
});
