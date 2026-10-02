'use strict';

// Runs face detection, landmarks and descriptors off Core's event loop. The
// models ship inside the @vladmandic/face-api package; nothing leaves the host.
const path = require('node:path');
const { parentPort } = require('node:worker_threads');
const jpeg = require('jpeg-js');
const faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
const { setWasmPaths } = require('@tensorflow/tfjs-backend-wasm');

const { tf } = faceapi;
const MODEL_DIR = path.join(path.dirname(require.resolve('@vladmandic/face-api/package.json')), 'model');
let ready = null;

function load() {
  if (!ready) {
    ready = (async () => {
      setWasmPaths(`${path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm'))}/`, false);
      await tf.setBackend('wasm');
      await tf.ready();
      await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_DIR);
      await faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_DIR);
      await faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_DIR);
    })();
  }
  return ready;
}

// Signed head rotation from the 68-point landmarks: the nose tip's distance to
// each jaw edge. Positive when the nose points to the image's right, which is
// the person's own left in an unmirrored camera frame. A flat photo turned in
// front of the camera keeps this ratio, a real head does not.
function yawOf(points) {
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const left = distance(points[30], points[0]);
  const right = distance(points[30], points[16]);
  return (left - right) / (left + right);
}

async function analyze(bytes) {
  await load();
  const image = jpeg.decode(Buffer.from(bytes), { useTArray: true, formatAsRGBA: false, maxResolutionInMP: 2, maxMemoryUsageInMB: 64 });
  const input = tf.tensor3d(image.data, [image.height, image.width, 3], 'int32');
  try {
    const found = await faceapi.detectAllFaces(input, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.6 }))
      .withFaceLandmarks().withFaceDescriptors();
    return found.map(face => ({
      score: face.detection.score,
      width: face.detection.box.width,
      yaw: yawOf(face.landmarks.positions),
      descriptor: Array.from(face.descriptor)
    }));
  } finally {
    input.dispose();
  }
}

parentPort.on('message', async ({ id, image }) => {
  try {
    parentPort.postMessage({ id, faces: await analyze(image) });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message || 'Face analysis failed' });
  }
});
