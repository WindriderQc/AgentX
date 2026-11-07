const MAX_BYTES = 2 * 1024 * 1024;
const cancelled = () => new DOMException('Screen capture cancelled.', 'AbortError');
const stop = stream => stream?.getTracks().forEach(track => track.stop());

export function screenCaptureSupported() {
  return globalThis.isSecureContext && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function firstFrame(video, stream, signal) {
  return new Promise((resolve, reject) => {
    const track = stream.getVideoTracks()[0];
    let frameId, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('loadeddata', loaded);
      video.removeEventListener('error', failed);
      track?.removeEventListener('ended', ended);
      signal.removeEventListener('abort', ended);
      if (frameId !== undefined) video.cancelVideoFrameCallback(frameId);
      error ? reject(error) : resolve();
    };
    const loaded = () => {
      if (video.videoWidth && video.videoHeight && video.readyState >= 2) finish();
    };
    const failed = () => finish(new Error('The selected screen could not be read.'));
    const ended = () => finish(cancelled());
    const timer = setTimeout(failed, 15000);
    video.addEventListener('loadeddata', loaded);
    video.addEventListener('error', failed);
    track?.addEventListener('ended', ended, { once: true });
    signal.addEventListener('abort', ended, { once: true });
    if (signal.aborted || !track || track.readyState === 'ended') return ended();
    if (typeof video.requestVideoFrameCallback === 'function') frameId = video.requestVideoFrameCallback(loaded);
    video.play().then(loaded, failed);
  });
}

// Called directly by the click handler: no await precedes the browser chooser.
// A late chooser grant after cancellation is stopped before it can be used.
export async function captureScreen(signal) {
  if (!screenCaptureSupported()) throw Object.assign(new Error('Screen capture is unavailable in this browser. Use HTTPS or localhost in a supported browser.'), { name: 'NotSupportedError' });
  signal.throwIfAborted();
  let stream, video, canvas;
  try {
    const requested = navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const granted = requested.then(value => {
      if (signal.aborted) stop(value);
      else stream = value;
      return value;
    });
    stream = await abortable(granted, signal);
    signal.throwIfAborted();
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await firstFrame(video, stream, signal);
    signal.throwIfAborted();
    canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    stop(stream);
    const blob = await abortable(new Promise(resolve => canvas.toBlob(resolve, 'image/png')), signal);
    if (!blob) throw new Error('The snapshot could not be encoded.');
    if (blob.size > MAX_BYTES) throw new Error('The snapshot exceeds 2 MiB. Capture a smaller window and try again.');
    const dataUrl = canvas.toDataURL('image/png');
    return { name: 'screen-capture.png', dataUrl, requestId: crypto.randomUUID() };
  } finally {
    stop(stream);
    if (video) { video.pause(); video.srcObject = null; video.remove(); }
    if (canvas) { canvas.width = 0; canvas.height = 0; canvas.remove(); }
  }
}

export function captureErrorMessage(error) {
  if (error.name === 'NotSupportedError') return 'Screen capture is unavailable in this browser. Use HTTPS or localhost in a supported browser.';
  if (error.name === 'NotAllowedError') return 'Screen capture permission was denied or the chooser was cancelled. No snapshot was added.';
  if (error.name === 'AbortError') return 'Screen capture cancelled. No snapshot was added.';
  return error.message || 'Screen capture failed. Try again.';
}
