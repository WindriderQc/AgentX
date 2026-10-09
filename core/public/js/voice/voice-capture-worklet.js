/* Microphone PCM only; outputs stay silent. Audio never leaves this page here. */
class NestorCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(1024);
    this.reference = new Float32Array(1024);
    this.offset = 0;
    this.epoch = null;
    this.port.onmessage = ({ data }) => {
      this.epoch = data.epoch;
      this.offset = 0;
    };
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (input && this.epoch !== null) {
      for (let i = 0; i < input.length; i++) {
        this.buffer[this.offset] = input[i];
        this.reference[this.offset++] = inputs[1]?.[0]?.[i] || 0;
        if (this.offset === this.buffer.length) {
          this.port.postMessage({ samples: this.buffer, reference: this.reference, epoch: this.epoch, time: currentTime + (i + 1) / sampleRate });
          this.offset = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('nestor-capture', NestorCapture);
