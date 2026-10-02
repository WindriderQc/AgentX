'use strict';

const crypto = require('node:crypto');

// Face unlock recognises the enrolled adult through the browser's camera and a
// random head-turn challenge: one frame looking straight, then one turned to
// the requested side, both matching the enrolled descriptors. The parental
// code stays the fallback and shares its failure counter with this path.
const REQUIRED_SAMPLES = 3;
const MAX_SAMPLES = 8;
const MAX_IMAGE_BYTES = 400 * 1024;
const MIN_FACE_WIDTH = 90;
const FRONT_YAW = 0.12;
const TURN_YAW = 0.25;
const CHALLENGE_TTL_MS = 45000;
const CHALLENGE_MAX_FRAMES = 24;
const CHALLENGE_MAX_MISMATCHES = 3;
const MAX_OPEN_CHALLENGES = 4;

class FaceUnlockError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function distance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

function closest(descriptor, samples) {
  return samples.reduce((best, sample) => Math.min(best, distance(descriptor, sample)), Infinity);
}

// Browsers send `canvas.toDataURL('image/jpeg')`; accept that or bare base64.
function decodeImage(value) {
  if (typeof value !== 'string' || value.length > MAX_IMAGE_BYTES * 1.4) {
    throw new FaceUnlockError(400, 'FACE_IMAGE_INVALID', 'Image invalide.');
  }
  const image = Buffer.from(value.replace(/^data:image\/jpeg;base64,/, ''), 'base64');
  if (image.length < 4 || image.length > MAX_IMAGE_BYTES || image[0] !== 0xff || image[1] !== 0xd8) {
    throw new FaceUnlockError(400, 'FACE_IMAGE_INVALID', 'Image invalide.');
  }
  return image;
}

function createFaceUnlock({ recognizer, store, maxDistance = 0.4, now = () => Date.now(),
  pickDirection = () => (crypto.randomInt(2) ? 'left' : 'right') }) {
  const challenges = new Map();

  function prune() {
    const at = now();
    for (const [id, challenge] of challenges) if (challenge.expiresAt <= at) challenges.delete(id);
  }

  async function samples() {
    return (await store.load()) || [];
  }

  async function status() {
    const count = (await samples()).length;
    return { samples: count, required: REQUIRED_SAMPLES, ready: count >= REQUIRED_SAMPLES };
  }

  // The single face in the frame, or a hint telling the person what to change.
  async function faceIn(image) {
    const faces = await recognizer.analyze(decodeImage(image));
    if (faces.length === 0) return { hint: 'no_face' };
    if (faces.length > 1) return { hint: 'many_faces' };
    if (faces[0].width < MIN_FACE_WIDTH) return { hint: 'closer' };
    return { face: faces[0] };
  }

  async function addSample(image) {
    const current = await samples();
    if (current.length >= MAX_SAMPLES) throw new FaceUnlockError(409, 'FACE_ENROLLMENT_FULL', 'Assez d’images enregistrées.');
    const { face, hint } = await faceIn(image);
    if (!face) return { added: false, hint, ...(await status()) };
    if (Math.abs(face.yaw) > FRONT_YAW) return { added: false, hint: 'look_straight', ...(await status()) };
    // Every sample must be the same person as the ones already enrolled.
    if (current.length && closest(face.descriptor, current) > maxDistance) {
      return { added: false, hint: 'different_person', ...(await status()) };
    }
    await store.save([...current, face.descriptor]);
    return { added: true, ...(await status()) };
  }

  async function erase() {
    await store.erase();
    challenges.clear();
  }

  async function challenge() {
    if (!(await status()).ready) throw new FaceUnlockError(409, 'FACE_NOT_ENROLLED', 'La reconnaissance faciale n’est pas encore configurée.');
    prune();
    // A few open challenges per instance; the oldest gives way.
    if (challenges.size >= MAX_OPEN_CHALLENGES) challenges.delete(challenges.keys().next().value);
    const id = crypto.randomBytes(18).toString('base64url');
    const direction = pickDirection();
    challenges.set(id, { direction, step: 'front', frames: 0, mismatches: 0, expiresAt: now() + CHALLENGE_TTL_MS });
    return { challengeId: id, direction, step: 'front', expiresAt: now() + CHALLENGE_TTL_MS };
  }

  // Returns { done } once both steps pass, a hint while the challenge goes
  // on, or { rejected } when the face belongs to someone else.
  async function submit(challengeId, image) {
    prune();
    const state = typeof challengeId === 'string' && challenges.get(challengeId);
    if (!state) throw new FaceUnlockError(410, 'FACE_CHALLENGE_EXPIRED', 'Délai dépassé. Recommence.');
    state.frames += 1;
    if (state.frames > CHALLENGE_MAX_FRAMES) {
      challenges.delete(challengeId);
      throw new FaceUnlockError(410, 'FACE_CHALLENGE_EXPIRED', 'Délai dépassé. Recommence.');
    }
    const { face, hint } = await faceIn(image);
    if (!face) return { step: state.step, hint };
    if (closest(face.descriptor, await samples()) > maxDistance) {
      state.mismatches += 1;
      if (state.mismatches < CHALLENGE_MAX_MISMATCHES) return { step: state.step, hint: 'not_recognized' };
      challenges.delete(challengeId);
      return { rejected: true };
    }
    if (state.step === 'front') {
      if (Math.abs(face.yaw) > FRONT_YAW) return { step: 'front', hint: 'look_straight' };
      state.step = 'turn';
      return { step: 'turn', direction: state.direction };
    }
    // Person's own left is a positive yaw in the unmirrored camera frame.
    const turned = state.direction === 'left' ? face.yaw >= TURN_YAW : face.yaw <= -TURN_YAW;
    if (!turned) return { step: 'turn', direction: state.direction, hint: 'turn_more' };
    challenges.delete(challengeId);
    return { done: true };
  }

  return { status, addSample, erase, challenge, submit };
}

module.exports = { createFaceUnlock, FaceUnlockError, decodeImage, REQUIRED_SAMPLES, MAX_SAMPLES };
