'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../../public/js/chat/screen-capture.js'), 'utf8')
  .replace(/export /g, '') + '\nthis.api = { captureScreen, captureErrorMessage, screenCaptureSupported };';

function fixture({ secure = true, supported = true, size = 100, encodeNull = false, noFrame = false, drawError = false } = {}) {
  const track = new EventTarget(); track.readyState = 'live'; track.stop = jest.fn(() => { track.readyState = 'ended'; });
  const audio = { stop: jest.fn() };
  const stream = { getTracks: () => [track, audio], getVideoTracks: () => [track] };
  const video = new EventTarget();
  Object.assign(video, { videoWidth: 800, videoHeight: 600, readyState: 0, srcObject: null, pause: jest.fn(), remove: jest.fn(),
    play: jest.fn(async () => { if (!noFrame) { video.readyState = 2; video.dispatchEvent(new Event('loadeddata')); } }) });
  const canvas = { width: 0, height: 0, remove: jest.fn(), toBlob: jest.fn(callback => callback(encodeNull ? null : { size })),
    toDataURL: jest.fn(() => 'data:image/png;base64,c3ludGhldGlj'),
    getContext: () => ({ drawImage: () => { if (drawError) throw new Error('Synthetic draw error'); } }) };
  const getDisplayMedia = jest.fn(async () => stream);
  const context = { isSecureContext: secure, navigator: { mediaDevices: supported ? { getDisplayMedia } : {} },
    document: { createElement: name => name === 'video' ? video : canvas }, crypto: { randomUUID: () => 'synthetic-capture-id' },
    DOMException, setTimeout, clearTimeout };
  vm.runInNewContext(source, context);
  return { ...context.api, getDisplayMedia, track, audio, stream, video, canvas };
}

test('consent is requested synchronously with audio off; only one frame survives and all resources stop', async () => {
  const f = fixture();
  const pending = f.captureScreen(new AbortController().signal);
  expect(f.getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });
  const result = await pending;
  expect(result.name).toBe('screen-capture.png');
  expect(result.dataUrl).toMatch(/^data:image\/png/);
  expect(f.track.stop).toHaveBeenCalled(); expect(f.audio.stop).toHaveBeenCalled();
  expect(f.video.srcObject).toBeNull(); expect(f.video.pause).toHaveBeenCalled(); expect(f.video.remove).toHaveBeenCalled();
  expect(f.canvas.width).toBe(0); expect(f.canvas.height).toBe(0);
});

test.each([{ supported: false }, { secure: false }])('unsupported or insecure contexts never open a chooser: %j', async options => {
  const f = fixture(options);
  await expect(f.captureScreen(new AbortController().signal)).rejects.toMatchObject({ name: 'NotSupportedError' });
  expect(f.getDisplayMedia).not.toHaveBeenCalled();
});

test('permission refusal is separate from unsupported browsers', async () => {
  const f = fixture();
  f.getDisplayMedia.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
  await expect(f.captureScreen(new AbortController().signal)).rejects.toMatchObject({ name: 'NotAllowedError' });
  expect(f.captureErrorMessage({ name: 'NotAllowedError' })).toMatch(/permission was denied/);
  expect(f.captureErrorMessage({ name: 'AbortError' })).toMatch(/cancelled/);
  expect(f.video.play).not.toHaveBeenCalled();
});

test('cancelling a pending chooser returns immediately and stops a late grant', async () => {
  const f = fixture(); const controller = new AbortController(); let grant;
  f.getDisplayMedia.mockReturnValue(new Promise(resolve => { grant = resolve; }));
  const pending = f.captureScreen(controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  grant(f.stream); await Promise.resolve();
  expect(f.track.stop).toHaveBeenCalled(); expect(f.audio.stop).toHaveBeenCalled();
  expect(f.video.play).not.toHaveBeenCalled();
});

test.each(['cancel', 'ended', 'timeout'])('%s while waiting for the first frame stops tracks and releases the video', async action => {
  jest.useFakeTimers();
  try {
    const f = fixture({ noFrame: true }); const controller = new AbortController();
    const pending = f.captureScreen(controller.signal);
    for (let step = 0; step < 20 && !f.video.play.mock.calls.length; step++) await Promise.resolve();
    expect(f.video.play).toHaveBeenCalled();
    if (action === 'cancel') controller.abort();
    else if (action === 'ended') f.track.dispatchEvent(new Event('ended'));
    else jest.advanceTimersByTime(15000);
    await expect(pending).rejects.toBeDefined();
    expect(f.track.stop).toHaveBeenCalled(); expect(f.video.srcObject).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});

test.each([{ size: 2 * 1024 * 1024 + 1 }, { encodeNull: true }, { drawError: true }])('capture errors release tracks, canvas and video: %j', async options => {
  const f = fixture(options);
  await expect(f.captureScreen(new AbortController().signal)).rejects.toBeDefined();
  expect(f.track.stop).toHaveBeenCalled(); expect(f.audio.stop).toHaveBeenCalled();
  expect(f.video.srcObject).toBeNull(); expect(f.canvas.width).toBe(0);
});
