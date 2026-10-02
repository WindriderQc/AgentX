'use strict';

const { createFaceUnlock, FaceUnlockError } = require('../../src/services/faceUnlockService');

// Synthetic frames: a JPEG marker followed by a tag the fake recognizer reads.
const frame = tag => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(tag)]).toString('base64')}`;
const vector = value => Array.from({ length: 128 }, () => value);
const faces = {
  'adult-front': [{ width: 160, yaw: 0.02, descriptor: vector(0.1) }],
  'adult-front-2': [{ width: 170, yaw: -0.05, descriptor: vector(0.11) }],
  'adult-left': [{ width: 160, yaw: 0.34, descriptor: vector(0.105) }],
  'adult-right': [{ width: 160, yaw: -0.33, descriptor: vector(0.1) }],
  'adult-slight-left': [{ width: 160, yaw: 0.15, descriptor: vector(0.1) }],
  'adult-far': [{ width: 40, yaw: 0, descriptor: vector(0.1) }],
  'child-front': [{ width: 150, yaw: 0, descriptor: vector(0.2) }],
  'two-people': [{ width: 150, yaw: 0, descriptor: vector(0.1) }, { width: 150, yaw: 0, descriptor: vector(0.2) }],
  empty: []
};

function fixture({ direction = 'left', at = { now: 1000 } } = {}) {
  let stored = [];
  const recognizer = { analyze: jest.fn(async image => faces[image.subarray(2).toString()]) };
  const store = { load: async () => stored, save: async next => { stored = next; }, erase: async () => { stored = []; } };
  const face = createFaceUnlock({ recognizer, store, now: () => at.now, pickDirection: () => direction });
  return { face, recognizer, stored: () => stored };
}

async function enroll(face) {
  for (const tag of ['adult-front', 'adult-front-2', 'adult-front']) expect((await face.addSample(frame(tag))).added).toBe(true);
}

describe('face unlock enrollment', () => {
  test('keeps frontal, single, near descriptors of one person and refuses the rest', async () => {
    const { face, stored } = fixture();
    expect(await face.addSample(frame('empty'))).toMatchObject({ added: false, hint: 'no_face', samples: 0 });
    expect(await face.addSample(frame('two-people'))).toMatchObject({ added: false, hint: 'many_faces' });
    expect(await face.addSample(frame('adult-far'))).toMatchObject({ added: false, hint: 'closer' });
    expect(await face.addSample(frame('adult-left'))).toMatchObject({ added: false, hint: 'look_straight' });
    expect(await face.addSample(frame('adult-front'))).toMatchObject({ added: true, samples: 1, ready: false });
    expect(await face.addSample(frame('child-front'))).toMatchObject({ added: false, hint: 'different_person' });
    await face.addSample(frame('adult-front-2'));
    expect(await face.addSample(frame('adult-front'))).toMatchObject({ added: true, samples: 3, ready: true });
    expect(stored()).toHaveLength(3);
    await face.erase();
    expect(await face.status()).toEqual({ samples: 0, required: 3, ready: false });
  });

  test('rejects anything that is not a bounded JPEG before analysis', async () => {
    const { face, recognizer } = fixture();
    for (const image of [undefined, 42, 'not-base64-jpeg', `data:image/jpeg;base64,${Buffer.alloc(500 * 1024, 0xff).toString('base64')}`]) {
      await expect(face.addSample(image)).rejects.toMatchObject({ status: 400, code: 'FACE_IMAGE_INVALID' });
    }
    expect(recognizer.analyze).not.toHaveBeenCalled();
  });
});

describe('face unlock challenge', () => {
  test('needs an enrollment before issuing a challenge', async () => {
    const { face } = fixture();
    await expect(face.challenge()).rejects.toBeInstanceOf(FaceUnlockError);
  });

  test('passes only after a straight frame then a turn to the requested side', async () => {
    const { face } = fixture({ direction: 'left' });
    await enroll(face);
    const { challengeId, direction } = await face.challenge();
    expect(direction).toBe('left');
    // A turned head before the straight frame does not count.
    expect(await face.submit(challengeId, frame('adult-left'))).toEqual({ step: 'front', hint: 'look_straight' });
    expect(await face.submit(challengeId, frame('adult-front'))).toEqual({ step: 'turn', direction: 'left' });
    expect(await face.submit(challengeId, frame('adult-right'))).toMatchObject({ step: 'turn', hint: 'turn_more' });
    expect(await face.submit(challengeId, frame('adult-slight-left'))).toMatchObject({ step: 'turn', hint: 'turn_more' });
    expect(await face.submit(challengeId, frame('adult-left'))).toEqual({ done: true });
    // A challenge unlocks once.
    await expect(face.submit(challengeId, frame('adult-left'))).rejects.toMatchObject({ status: 410 });
  });

  test('a flat photo keeps its yaw and never completes the turn', async () => {
    const { face } = fixture({ direction: 'right' });
    await enroll(face);
    const { challengeId } = await face.challenge();
    await face.submit(challengeId, frame('adult-front'));
    for (let i = 0; i < 5; i += 1) expect((await face.submit(challengeId, frame('adult-front'))).done).toBeUndefined();
  });

  test('rejects another person after three mismatches', async () => {
    const { face } = fixture();
    await enroll(face);
    const { challengeId } = await face.challenge();
    expect(await face.submit(challengeId, frame('child-front'))).toEqual({ step: 'front', hint: 'not_recognized' });
    expect(await face.submit(challengeId, frame('child-front'))).toEqual({ step: 'front', hint: 'not_recognized' });
    expect(await face.submit(challengeId, frame('child-front'))).toEqual({ rejected: true });
    await expect(face.submit(challengeId, frame('adult-front'))).rejects.toMatchObject({ status: 410 });
  });

  test('expires by time and by frame count', async () => {
    const at = { now: 1000 };
    const { face } = fixture({ at });
    await enroll(face);
    const timed = await face.challenge();
    at.now += 45001;
    await expect(face.submit(timed.challengeId, frame('adult-front'))).rejects.toMatchObject({ code: 'FACE_CHALLENGE_EXPIRED' });
    const counted = await face.challenge();
    for (let i = 0; i < 24; i += 1) await face.submit(counted.challengeId, frame('empty'));
    await expect(face.submit(counted.challengeId, frame('adult-front'))).rejects.toMatchObject({ code: 'FACE_CHALLENGE_EXPIRED' });
    await expect(face.submit('unknown', frame('adult-front'))).rejects.toMatchObject({ status: 410 });
  });
});
