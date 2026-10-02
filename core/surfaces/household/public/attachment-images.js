/* Photos attached to a conversation. The model receives a copy within the
   2 MB attachment limit (vision models downscale to about 1000 px anyway);
   the original, as the device produced it, goes to the image archive. */
(function (root) {
  'use strict';
  const LIMIT = 2 * 1024 * 1024;
  const MAX_ORIGINAL = 50 * 1024 * 1024;
  const SENDABLE = new Set(['image/jpeg', 'image/png']);
  const EDGES = [2048, 1600, 1280];
  const QUALITIES = [0.9, 0.82, 0.72];

  function isImage(file) {
    return /^image\//.test(file?.type || '') || /\.(jpe?g|png|webp|heic|heif|avif)$/i.test(file?.name || '');
  }

  /** Size limit at selection: an image may be large, it is reduced before sending. */
  function accepts(file) {
    return isImage(file) ? file.size <= MAX_ORIGINAL : file.size <= LIMIT;
  }

  function fitWithin(width, height, maxEdge) {
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }

  function reducedName(name) {
    return String(name || 'photo').replace(/\.[^.]+$/, '') + '.jpg';
  }

  /** The file sent to the model: the photo itself when it fits, else a JPEG copy. */
  async function reduce(file) {
    if (SENDABLE.has(file.type) && file.size <= LIMIT) return file;
    const bitmap = await root.createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
    if (!bitmap) throw new Error('Le navigateur ne peut pas lire cette photo. Choisis une photo JPEG ou PNG.');
    try {
      for (const edge of EDGES) {
        const { width, height } = fitWithin(bitmap.width, bitmap.height, edge);
        const canvas = root.document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
        for (const quality of QUALITIES) {
          const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
          if (blob && blob.size <= LIMIT) return new root.File([blob], reducedName(file.name), { type: 'image/jpeg' });
        }
      }
    } finally { bitmap.close?.(); }
    throw new Error('Cette photo reste trop lourde, même réduite.');
  }

  const api = { LIMIT, MAX_ORIGINAL, isImage, accepts, fitWithin, reducedName, reduce };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NestorAttachmentImages = api;
})(typeof window === 'undefined' ? globalThis : window);
