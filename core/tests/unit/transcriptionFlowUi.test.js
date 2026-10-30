'use strict';
const flow = require('../../public/js/transcription-flow');
const now = Date.parse('2030-01-01T12:00:00Z');
const active = { state: 'running', stage: 'transcribing', queueId: 'queue-1', updatedAt: '2030-01-01T11:59:59Z' };
it('keeps actual ordering and makes exports an on-demand read, not another queued job', () => {
  expect(flow.steps.map(row => row[0])).toEqual(['request','admission','download','decode','whisper','save','read']);
  expect(flow.steps[1][3]).toContain('précède le téléchargement');
  expect(flow.steps[6][3]).toContain('à votre demande');
});
it('animates only recent receipt activity; historical, stale, uncertain and cancellation states remain still', () => {
  expect(flow.project(active, null, now)).toMatchObject({ mode: 'live', index: 4, animate: true });
  expect(flow.project({ ...active, updatedAt: '2029-01-01' }, null, now)).toMatchObject({ mode: 'stale', animate: false });
  for (const state of ['completed','failed','cancelled','uncertain']) {
    expect(flow.project({ ...active,state }, null, now).animate).toBe(false);
  }
  expect(flow.project({ ...active,stage:'cancelling' }, null, now)).toMatchObject({ index:-1,animate:false });
  expect(flow.project(null, null, now)).toMatchObject({ mode:'explanation',animate:false });
});
it('observes a fresh native receipt and stops if a newer native observation no longer lists this job', () => {
  const service = { service:{ activity:{ observedAt:'2030-01-01T12:00:00Z',jobs:[{id:'queue-1',stage:'decoding'}] } } };
  expect(flow.project(active,service,now)).toMatchObject({ mode:'live',index:3 });
  service.service.activity.jobs=[];
  expect(flow.project(active,service,now)).toMatchObject({ mode:'stale',animate:false });
  service.service.activity.observedAt='2030-01-01T11:59:58Z';
  expect(flow.project(active,service,now).animate).toBe(true);
});
it('explains schedule, expired window, missing observation and resource quarantine without inventing an ETA', () => {
  const queued={state:'queued',planning:{available:true,state:'reserved',scheduleState:'upcoming',earliestStartAt:'2030-01-01T13:00:00Z'}};
  expect(flow.project(queued,null,now).message).toContain('heure autorisée');
  queued.planning.scheduleState='expired';
  expect(flow.project(queued,null,now).message).toContain('expiré');
  expect(flow.project({state:'queued'},null,now).message).toContain('à vérifier');
  queued.planning.scheduleState='open';queued.planning.earliestStartAt='2030-01-01T11:00:00Z';
  expect(flow.waitReason(queued,{coordination:{blockers:[{uncertain:true}]}},now)).toContain('réconciliation');
});
