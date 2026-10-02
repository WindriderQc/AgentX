'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../../../public/js/voice/browser-conversation'), 'utf8');

test('shared microphone loads its worklet beside the script even after currentScript clears', async () => {
  for (const [scriptUrl, expected] of [
    ['https://agentx.example.test/js/voice/browser-conversation.js', 'https://agentx.example.test/js/voice/voice-capture-worklet.js?v=1.46.0'],
    ['https://agentx.example.test/assets/household/browser-conversation.js', 'https://agentx.example.test/assets/household/voice-capture-worklet.js?v=1.46.0'],
    ['http://127.0.0.1:4207/llmx-api/assets/browser-conversation.js', 'http://127.0.0.1:4207/llmx-api/assets/voice-capture-worklet.js?v=1.46.0'],
    [undefined, '/js/voice/voice-capture-worklet.js?v=1.46.0'],
  ]) {
    const modules = [];
    const track = { enabled: true, stop() {}, getSettings: () => ({ echoCancellation: true }) };
    const connection = () => ({ connect() {}, disconnect() {} });
    const window = {
      document: { currentScript: scriptUrl ? { src: scriptUrl } : null },
      isSecureContext: true,
      navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) } },
      AudioContext: class {
        sampleRate = 24000; state = 'running'; destination = {};
        audioWorklet = { addModule: async url => modules.push(url) };
        async resume() {} async close() {} createMediaStreamSource() { return connection(); }
      },
      AudioWorkletNode: class {
        port = { postMessage() {} }; connect() {} disconnect() {}
      },
    };
    vm.runInNewContext(source, { window, URL, AbortController, setTimeout, clearTimeout });
    window.document.currentScript = null;
    const audio = await window.NestorConversation.openAudio(new AbortController().signal);
    assert.deepEqual(modules, [expected]);
    assert.equal(audio.canInterrupt, true);
    audio.close();
  }
});
