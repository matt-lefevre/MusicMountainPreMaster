/* MP3 encoder worker for the Music Mountain Pre-Master tool.
   Uses wasm-media-encoders (LAME compiled to WebAssembly) so encoding runs
   off the main thread at many times realtime. Protocol:
     -> { type: "init", wasmUrl, sampleRate, channels, bitrate }
     <- { type: "ready" }                 (or { type: "error", message })
     -> { type: "encode", seq, left, right }   (ArrayBuffers, transferred)
     <- { type: "encoded", seq }
     -> { type: "finish" }
     <- { type: "done", mp3 }             (ArrayBuffer, transferred)
*/
importScripts("WasmMediaEncoder.min.js");

let encoder = null;
let chunks = [];

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      encoder = await WasmMediaEncoder.createEncoder("audio/mpeg", msg.wasmUrl);
      encoder.configure({
        channels: msg.channels,
        sampleRate: msg.sampleRate,
        bitrate: msg.bitrate,
      });
      chunks = [];
      self.postMessage({ type: "ready" });
    } else if (msg.type === "encode") {
      const left = new Float32Array(msg.left);
      const right = msg.right ? new Float32Array(msg.right) : left;
      const out = encoder.encode([left, right]);
      // The returned Uint8Array is a view into wasm memory that gets reused —
      // copy it before stashing.
      if (out.length) chunks.push(new Uint8Array(out));
      self.postMessage({ type: "encoded", seq: msg.seq });
    } else if (msg.type === "finish") {
      const fin = encoder.finalize();
      if (fin.length) chunks.push(new Uint8Array(fin));
      let total = 0;
      for (const c of chunks) total += c.length;
      const out = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      chunks = [];
      self.postMessage({ type: "done", mp3: out.buffer }, [out.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: "error", message: (err && err.message) || String(err) });
  }
};
