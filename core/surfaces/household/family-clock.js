'use strict';
// The server's existing planning zone owns household dates, never the browser zone.
const {familyTimeZone}=require('../../src/domains/household/family');
function familyClock({now=new Date(),timeZone}={}) {
  timeZone=familyTimeZone(timeZone);
  try {
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'shortOffset'}).formatToParts(now);
    const values=Object.fromEntries(parts.map(p=>[p.type,p.value]));
    return {instant:now.toISOString(),timeZone,localDate:`${values.year}-${values.month}-${values.day}`,localTime:`${values.hour}:${values.minute}:${values.second}`,offset:values.timeZoneName};
  } catch { return null; }
}
function familyClockContext(options) {
  const clock=familyClock(options);
  return clock?'\n\nHousehold clock observed at the start of this turn: '+JSON.stringify(clock)+'. Use this dated local clock for now/today/tomorrow; do not ask the person to read their clock. For a passage delay, use the actual dated tool result and its time zone, not an invented pass or a stale assistant claim. This is a clock observation, not a scheduled reminder.':'\n\nThe household clock is unavailable for this turn. Do not invent the current local time.';
}
function familyIdentity(persona) {
  const name=String(persona?.name||'Nestor').split(/[·|]/)[0].trim().slice(0,60);
  return 'In this family conversation your display name is '+JSON.stringify(name||'Nestor')+'. The family tone below replaces every adult personality temperament. Voice selection and permissions stay unchanged.';
}
module.exports={familyClock,familyClockContext,familyIdentity};
