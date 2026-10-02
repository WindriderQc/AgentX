'use strict';

// A child's optional birth date, kept by the parent on the Family page. It is
// adult-only data: the public profile projection (familyProfile) never carries
// it, and Super Dad receives only the derived age and day/month of the birthday.
const { FamilyInputError, calendarDayKey } = require('./family');

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const EARLIEST = '1900-01-01';
const MONTHS = Object.freeze(['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet',
  'août', 'septembre', 'octobre', 'novembre', 'décembre']);

// Today's date for the instance: the configured PLANNING_TIME_ZONE when one is
// set and valid, otherwise the server's local date.
function instanceToday(now = new Date(), timeZone = process.env.PLANNING_TIME_ZONE) {
  const zone = String(timeZone || '').trim();
  if (zone) {
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(now);
      return calendarDayKey(now, zone);
    } catch (_error) { /* fall back to the server's local date */ }
  }
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function realDate(value) {
  const match = DATE_ONLY.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

// null clears the date. Anything else must be a real YYYY-MM-DD date between
// 1900-01-01 and today.
function familyBirthDate(value, now = new Date()) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const date = String(value).trim();
  if (!realDate(date)) {
    throw new FamilyInputError('birthDate must be a real date as YYYY-MM-DD', 'FAMILY_PROFILE_BAD_BIRTH_DATE');
  }
  if (date < EARLIEST || date > instanceToday(now)) {
    throw new FamilyInputError('birthDate must be between 1900-01-01 and today', 'FAMILY_PROFILE_BAD_BIRTH_DATE');
  }
  return date;
}

function ageInYears(birthDate, today) {
  if (!realDate(birthDate || '') || !realDate(today || '') || birthDate > today) return null;
  const age = Number(today.slice(0, 4)) - Number(birthDate.slice(0, 4));
  return today.slice(5) < birthDate.slice(5) ? age - 1 : age;
}

// "le 1er mars", "le 14 mars": the day and month only, never the year.
function birthdayLabel(birthDate) {
  if (!realDate(birthDate || '')) return '';
  const day = Number(birthDate.slice(8, 10));
  return `${day === 1 ? '1er' : day} ${MONTHS[Number(birthDate.slice(5, 7)) - 1]}`;
}

module.exports = { ageInYears, birthdayLabel, familyBirthDate, instanceToday };
