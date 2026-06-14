/* =====================================================================
   CONFIGURATION — audio clips
   ---------------------------------------------------------------------
   Edit this list to add/remove clips. The S3 bucket must allow public
   GetObject and CORS from the origin serving this page.
===================================================================== */
const SAMPLE_CLIPS = [
  { name: "Debussy — Suite bergamasque",
    url: "https://ysm-assets-for-livestream.s3.us-east-1.amazonaws.com/mp3s/Bergamasque.mp3" },
  { name: "Bernstein — Chichester Psalms (Choir and Orchestra)",
    url: "https://ysm-assets-for-livestream.s3.us-east-1.amazonaws.com/mp3s/Bernstein+-+Chichester+Psalms+(Choir+and+Orchestra).mp3" },
  { name: "Brahms — Op. 78 (viola and piano)",
    url: "https://ysm-assets-for-livestream.s3.us-east-1.amazonaws.com/mp3s/Brahms+-+Op.78+(viola+and+piano).mp3" },
  { name: "Farías — Andean Suite (guitar and string quartet)",
    url: "https://ysm-assets-for-livestream.s3.us-east-1.amazonaws.com/mp3s/Fari%CC%81as+-+Andean+Suite+(guitar+and+string+quartet).mp3" },
  { name: "Fauré — Fantasie (tuba and piano)",
    url: "https://ysm-assets-for-livestream.s3.us-east-1.amazonaws.com/mp3s/Faure%CC%81+-+Fantasie+(tuba+and+piano).mp3" },
  { name: "Prokofiev — Sonata No. 2 Op. 14 (solo piano)",
    url: "https://ysm-assets-for-livestream.s3.us-east-1.amazonaws.com/mp3s/Prokofiev+-+Sonata+No.+2+Op.+14+(solo+piano).mp3" },
];

/* =====================================================================
   CONSTANTS
===================================================================== */
const QUIZ_FREQS = [100, 250, 500, 1000, 2000, 4000, 8000];
const DIFFICULTY = {
  easy:   { gain: 18, Q: 12 },
  medium: { gain: 9, Q: 9 },
  hard:   { gain: 4.5, Q: 6 },
};
let quizDifficulty = "easy";
const FREQ_STOPS = [63, 125, 250, 500, 1000, 2000, 4000, 8000];

/* =====================================================================
   AUDIO ENGINE
===================================================================== */
let ctx = null;
let filter, masterGain, analyser;
// Mono/Stereo graph nodes
let msInput, msSplitter, msMerger, msStereoGain, msMonoGain;
// Stereo vectorscope per-channel analysers
let vizSplitter, leftAnalyser, rightAnalyser;
// Convolution reverb graph nodes (two parallel halls, shared dry)
let reverbInput, reverbDry;
let spragueConvolver, spragueWet;
let woolseyConvolver, woolseyWet;
let spragueBuffer = null;
let woolseyBuffer = null;
// IRs live in the same S3 bucket as the audio clips (CORS already allows this
// origin). If the bucket ever goes offline, `window.IR_DATA_URL_*` can be set
// in a separate file to fall back to embedded base64.
const IR_URL_SPRAGUE = (typeof window !== "undefined" && window.IR_DATA_URL_SPRAGUE)
  || "https://ysm-assets-for-livestream.s3.us-east-1.amazonaws.com/impulse_responses/Sprague_IR.mp3";
const IR_URL_WOOLSEY = (typeof window !== "undefined" && window.IR_DATA_URL_WOOLSEY)
  || "https://ysm-assets-for-livestream.s3.us-east-1.amazonaws.com/impulse_responses/Woolsey_IR.mp3";
let currentSource = null;
let isPlaying = false;
let pinkBuffer = null;

// Which top-level tool is active: "eq" or "monoStereo" — drives the audio graph.
let currentTool = "monoStereo";

// Track playback position so we can "pause" (Web Audio sources are one-shot)
let sourceStartTime = 0;   // ctx.currentTime when the source started
let sourceOffset = 0;      // where in the buffer playback is currently at (seconds)
let currentBufferDuration = 0;

// The currently-active UI element (dropzone or sample-btn) that is "playing".
let activeSourceEl = null;

const bufferCache = new Map();

function ensureCtx() {
  if (ctx) return ctx;
  ctx = new (window.AudioContext || window.webkitAudioContext)();

  filter = ctx.createBiquadFilter();
  filter.type = "peaking";
  filter.frequency.value = 1000;
  filter.gain.value = 0;
  filter.Q.value = 1;

  masterGain = ctx.createGain();
  masterGain.gain.value = 0.85;

  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;

  // --- Mono/Stereo graph (always built; we route through it only when the
  // Mono/Stereo tool is active). The source connects to msInput. msInput fans
  // out to two paths and we crossfade with the two gain nodes:
  //   msInput -> msStereoGain -> masterGain         (stereo path)
  //   msInput -> msSplitter -(L,R)-> msMerger(0) -> msMonoGain -> masterGain
  msInput = ctx.createGain();
  msStereoGain = ctx.createGain();
  msStereoGain.gain.value = 1;
  msMonoGain = ctx.createGain();
  msMonoGain.gain.value = 0;
  msSplitter = ctx.createChannelSplitter(2);
  msMerger = ctx.createChannelMerger(1);

  msInput.connect(msStereoGain);
  msStereoGain.connect(masterGain);

  msInput.connect(msSplitter);
  msSplitter.connect(msMerger, 0, 0);
  msSplitter.connect(msMerger, 1, 0);
  msMerger.connect(msMonoGain);
  msMonoGain.connect(masterGain);

  filter.connect(masterGain);
  masterGain.connect(analyser);
  analyser.connect(ctx.destination);

  // add a stereo vecotscope tap post-master but pre-analyser so the EQ doesn't affect it (makes it easier to see the stereo effect of the EQ changes)
  vizSplitter = ctx.createChannelSplitter(2);
  leftAnalyser = ctx.createAnalyser();
  leftAnalyser.fftSize = 1024;
  leftAnalyser.smoothingTimeConstant = 0;
  rightAnalyser = ctx.createAnalyser();
  rightAnalyser.fftSize = 1024;
  rightAnalyser.smoothingTimeConstant = 0;
  masterGain.connect(vizSplitter);
  vizSplitter.connect(leftAnalyser, 0);
  vizSplitter.connect(rightAnalyser, 1);

  // --- Convolution reverb graph (always built; routed through only when the
  // Reverb tool is active). Two parallel convolver paths (one per hall) share
  // a single dry tap. Each hall's "Amount" slider controls its wet gain; the
  // dry attenuates against whichever slider is higher so the total level stays
  // sane even with both halls pushed:
  //   reverbInput -> reverbDry -------------> masterGain
  //   reverbInput -> spragueConvolver -> spragueWet -> masterGain
  //   reverbInput -> woolseyConvolver -> woolseyWet -> masterGain
  reverbInput = ctx.createGain();
  reverbDry = ctx.createGain();
  spragueWet = ctx.createGain();
  woolseyWet = ctx.createGain();
  spragueConvolver = ctx.createConvolver();
  spragueConvolver.normalize = true;
  woolseyConvolver = ctx.createConvolver();
  woolseyConvolver.normalize = true;

  reverbInput.connect(reverbDry);
  reverbDry.connect(masterGain);
  reverbInput.connect(spragueConvolver);
  spragueConvolver.connect(spragueWet);
  spragueWet.connect(masterGain);
  reverbInput.connect(woolseyConvolver);
  woolseyConvolver.connect(woolseyWet);
  woolseyWet.connect(masterGain);

  // Both halls start at 0% — user chooses what to add.
  reverbDry.gain.value = 1;
  spragueWet.gain.value = 0;
  woolseyWet.gain.value = 0;

  // Only kick off the IR fetch when the user actually opens the Reverb tool —
  // no point burning bandwidth on a ~330 KB download if they never visit it.

  return ctx;
}

/** Returns the node a buffer source should connect to for the active tool. */
function currentInputNode() {
  ensureCtx();
  if (currentTool === "monoStereo") return msInput;
  if (currentTool === "reverb") return reverbInput;
  if (currentTool === "premaster") return masterGain; // dry preview
  return filter;
}

/** Fetch & decode one IR, install it on its convolver. Memoized. */
async function loadIR(url, bufferRef, convolver) {
  if (bufferRef.buf) {
    if (convolver && !convolver.buffer) convolver.buffer = bufferRef.buf;
    return bufferRef.buf;
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("IR fetch failed: " + resp.status);
  const arr = await resp.arrayBuffer();
  const buf = await ctx.decodeAudioData(arr);
  bufferRef.buf = buf;
  if (convolver) convolver.buffer = buf;
  return buf;
}

// Stable refs so loadIR can memoize across calls.
const spragueRef = { get buf() { return spragueBuffer; }, set buf(v) { spragueBuffer = v; } };
const woolseyRef = { get buf() { return woolseyBuffer; }, set buf(v) { woolseyBuffer = v; } };

/** Load both hall IRs in parallel. */
async function loadHallIRs() {
  const results = await Promise.allSettled([
    loadIR(IR_URL_SPRAGUE, spragueRef, spragueConvolver),
    loadIR(IR_URL_WOOLSEY, woolseyRef, woolseyConvolver),
  ]);
  // Refresh UI once either IR lands so the slider/export can enable.
  updateReverbUI();
  const failures = results.filter(r => r.status === "rejected");
  if (failures.length) throw failures[0].reason;
  return { sprague: spragueBuffer, woolsey: woolseyBuffer };
}

function createPinkNoise(durationSec = 4) {
  ensureCtx();
  const length = ctx.sampleRate * durationSec;
  const buf = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
      // Make the pink noise much quieter.
      data[i] = pink * 0.4;
    }
  }
  return buf;
}

async function loadUrl(url) {
  if (bufferCache.has(url)) return bufferCache.get(url);
  const resp = await fetch(url, { mode: "cors" });
  if (!resp.ok) throw new Error("Fetch failed: " + resp.status);
  const arr = await resp.arrayBuffer();
  const buf = await ctx.decodeAudioData(arr);
  bufferCache.set(url, buf);
  return buf;
}

async function decodeFile(file) {
  ensureCtx();
  const arr = await file.arrayBuffer();
  return await ctx.decodeAudioData(arr);
}

function stop() {
  if (currentSource) {
    try { currentSource.onended = null; } catch (e) {}
    try { currentSource.stop(); } catch (e) {}
    try { currentSource.disconnect(); } catch (e) {}
    currentSource = null;
  }
  isPlaying = false;
  sourceOffset = 0;
  currentBufferDuration = 0;
  setActiveSourceEl(null);
}

/**
 * Start a buffer playing (always looping for our UI). Optional startOffset to
 * resume from a point.
 */
function playBuffer(buf, startOffset = 0) {
  ensureCtx();
  if (ctx.state === "suspended") ctx.resume();

  // Kill any previous source without nuking the active-el UI state yet.
  if (currentSource) {
    try { currentSource.onended = null; } catch (e) {}
    try { currentSource.stop(); } catch (e) {}
    try { currentSource.disconnect(); } catch (e) {}
    currentSource = null;
  }

  if (!buf) return;

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.connect(currentInputNode());
  src.start(0, startOffset % buf.duration);
  currentSource = src;
  sourceStartTime = ctx.currentTime;
  sourceOffset = startOffset % buf.duration;
  currentBufferDuration = buf.duration;
  isPlaying = true;
}

/* =====================================================================
   PLAY MODE — EQ controls
===================================================================== */
function sliderToFreq(v) {
  const i = Math.max(0, Math.min(FREQ_STOPS.length - 1, Math.round(+v)));
  return FREQ_STOPS[i];
}

const freqSlider = document.getElementById("freqSlider");
const gainSlider = document.getElementById("gainSlider");
const qSlider = document.getElementById("qSlider");
const freqVal = document.getElementById("freqVal");
const gainVal = document.getElementById("gainVal");
const qVal = document.getElementById("qVal");
const bypassBtn = document.getElementById("bypassBtn");

let bypass = false;

function applyEQ() {
  if (!ctx) return;
  const f = sliderToFreq(+freqSlider.value);
  const g = +gainSlider.value;
  const q = +qSlider.value;
  filter.frequency.setTargetAtTime(f, ctx.currentTime, 0.01);
  filter.gain.setTargetAtTime(bypass ? 0 : g, ctx.currentTime, 0.01);
  filter.Q.setTargetAtTime(q, ctx.currentTime, 0.01);
  drawEQ(f, bypass ? 0 : g, q);
}

function updateReadouts() {
  const f = sliderToFreq(+freqSlider.value);
  const unitEl = document.getElementById("freqUnit");
  if (f >= 1000) {
    freqVal.textContent = f / 1000;
    unitEl.textContent = "kHz";
  } else {
    freqVal.textContent = f;
    unitEl.textContent = "Hz";
  }
  const g = +gainSlider.value;
  gainVal.textContent = (g > 0 ? "+" : "") + g;
  qVal.textContent = +qSlider.value;
}

[freqSlider, gainSlider, qSlider].forEach((el) => {
  el.addEventListener("input", () => { updateReadouts(); applyEQ(); });
});

bypassBtn.addEventListener("click", () => {
  bypass = !bypass;
  bypassBtn.classList.toggle("active", bypass);
  bypassBtn.textContent = bypass ? "Bypassed" : "Bypass";
  applyEQ();
});

/* =====================================================================
   PLAY MODE — sources (dropzone + sample-list with integrated play/pause)
===================================================================== */

// Each "source element" (dropzone or sample-btn) has its own buffer. We track
// them via a WeakMap so we don't litter the DOM with data attributes.
const sourceBuffers = new WeakMap();

function setSourceBuffer(el, buffer, filename) {
  sourceBuffers.set(el, { buffer, filename });
}
function getSourceBuffer(el) {
  return sourceBuffers.get(el);
}

/**
 * Toggle playback for a specific source element. If it's currently playing,
 * pause (remember offset for resume). If a different source is playing, stop
 * that and start this one. If this one is paused, resume from offset.
 */
function togglePlayback(el, buffer) {
  if (!buffer) return;
  if (activeSourceEl === el && isPlaying) {
    // Pause — stash offset.
    const elapsed = ctx.currentTime - sourceStartTime;
    const offset = (sourceOffset + elapsed) % buffer.duration;
    if (currentSource) {
      try { currentSource.onended = null; } catch (e) {}
      try { currentSource.stop(); } catch (e) {}
      try { currentSource.disconnect(); } catch (e) {}
      currentSource = null;
    }
    isPlaying = false;
    sourceOffset = offset;
    // Keep activeSourceEl so UI still shows this as "selected" but not playing
    refreshSourceUI();
    return;
  }
  if (activeSourceEl === el && !isPlaying) {
    // Resume
    playBuffer(buffer, sourceOffset);
    refreshSourceUI();
    return;
  }
  // Switching to a new source.
  sourceOffset = 0;
  playBuffer(buffer, 0);
  setActiveSourceEl(el);
}

function setActiveSourceEl(el) {
  activeSourceEl = el;
  refreshSourceUI();
}

function refreshSourceUI() {
  // Reset all sample-btn + dropzone state in both panels.
  document.querySelectorAll(".sample-btn").forEach((b) => {
    b.classList.remove("active");
    b.style.setProperty("--progress", "0%");
    const icon = b.querySelector(".play-icon");
    if (icon) icon.textContent = "▶";
  });
  document.querySelectorAll(".dropzone").forEach((d) => {
    d.classList.remove("playing");
    if (!d.classList.contains("loaded")) {
      d.style.setProperty("--progress", "0%");
    }
  });

  if (!activeSourceEl) return;

  if (activeSourceEl.classList.contains("sample-btn")) {
    activeSourceEl.classList.add("active");
    const icon = activeSourceEl.querySelector(".play-icon");
    if (icon) icon.textContent = isPlaying ? "❚❚" : "▶";
  } else if (activeSourceEl.classList.contains("dropzone")) {
    activeSourceEl.classList.toggle("playing", isPlaying);
    const icon = activeSourceEl.querySelector(".dz-icon");
    if (icon) icon.textContent = isPlaying ? "❚❚" : "▶";
  }
}

// Dropzone (Play Mode)
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const dropzoneIcon = document.getElementById("dropzoneIcon");
const dropzoneTitle = document.getElementById("dropzoneTitle");
const dropzoneHint = document.getElementById("dropzoneHint");

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (file) await handleFile(file);
  // allow re-choosing the same file
  fileInput.value = "";
});

["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); })
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); })
);
dropzone.addEventListener("drop", async (e) => {
  const file = e.dataTransfer.files[0];
  if (file) await handleFile(file);
});

dropzone.addEventListener("click", (e) => {
  // If loaded, clicking toggles play/pause. Otherwise, open the file picker.
  const entry = getSourceBuffer(dropzone);
  if (entry && entry.buffer) {
    togglePlayback(dropzone, entry.buffer);
  } else {
    fileInput.click();
  }
});

async function handleFile(file) {
  try {
    const buf = await decodeFile(file);
    setSourceBuffer(dropzone, buf, file.name);
    markDropzoneLoaded(dropzone, file.name);
    togglePlayback(dropzone, buf);
  } catch (err) {
    alert("Could not decode that file: " + err.message);
  }
}

function markDropzoneLoaded(dz, filename) {
  dz.classList.add("loaded");
  const icon = dz.querySelector(".dz-icon");
  const title = dz.querySelector(".dz-title");
  const hint = dz.querySelector(".dz-hint");
  if (icon) icon.textContent = "▶";
  if (title) title.textContent = filename;
  if (hint) hint.textContent = "click to play / pause";
}

// Sample list (Play Mode)
const sampleList = document.getElementById("sampleList");

function buildSampleList() {
  Array.from(sampleList.querySelectorAll("[data-clip]")).forEach((n) => n.remove());
  SAMPLE_CLIPS.forEach((clip, i) => {
    const btn = document.createElement("button");
    btn.className = "sample-btn";
    btn.dataset.source = "clip";
    btn.dataset.clip = String(i);
    btn.innerHTML =
      `<span class="play-icon">▶</span>` +
      `<span class="sample-name">${escapeHtml(clip.name)}</span>`;
    btn.addEventListener("click", () => handlePlaySampleBtn(btn, clip));
    sampleList.appendChild(btn);
  });
}

async function handlePlaySampleBtn(btn, clipOrSpecial) {
  ensureCtx();
  // If this btn already has a buffer cached on it, just toggle.
  const existing = getSourceBuffer(btn);
  if (existing && existing.buffer) {
    togglePlayback(btn, existing.buffer);
    return;
  }

  // Loading path — show a spinner in the play icon.
  const icon = btn.querySelector(".play-icon");
  const originalIconText = icon.textContent;
  icon.textContent = "…";

  try {
    let buf;
    if (clipOrSpecial === "pink") {
      if (!pinkBuffer) pinkBuffer = createPinkNoise(4);
      buf = pinkBuffer;
    } else {
      buf = await loadUrl(clipOrSpecial.url);
    }
    setSourceBuffer(btn, buf);
    togglePlayback(btn, buf);
  } catch (err) {
    alert("Could not load clip: " + err.message + "\n\nMake sure the S3 bucket allows CORS GET from this origin.");
    icon.textContent = originalIconText;
  }
}

// Pink noise in Play mode is a sample-btn (first one in the list).
document.querySelector('#sampleList [data-source="pink"]')
  .addEventListener("click", function () {
    handlePlaySampleBtn(this, "pink");
  });

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* =====================================================================
   PROGRESS TICKER
===================================================================== */
function progressTick() {
  if (isPlaying && currentBufferDuration > 0 && activeSourceEl) {
    const elapsed = ctx.currentTime - sourceStartTime;
    const pos = ((sourceOffset + elapsed) % currentBufferDuration) / currentBufferDuration;
    const pct = (pos * 100).toFixed(2) + "%";
    activeSourceEl.style.setProperty("--progress", pct);
  }
  requestAnimationFrame(progressTick);
}
requestAnimationFrame(progressTick);

/* =====================================================================
   EQ CURVE VISUALIZATION
===================================================================== */
const canvas = document.getElementById("eqCanvas");
const cctx = canvas.getContext("2d");

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const f = ctx ? filter.frequency.value : sliderToFreq(+freqSlider.value);
  const g = ctx ? filter.gain.value : +gainSlider.value;
  const q = ctx ? filter.Q.value : +qSlider.value;
  drawEQ(f, g, q);
}
window.addEventListener("resize", resizeCanvas);

function drawEQ(freqHz, gainDb, qVal) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  cctx.clearRect(0, 0, w, h);

  const bgGrad = cctx.createLinearGradient(0, 0, 0, h);
  bgGrad.addColorStop(0, "#fbfcff");
  bgGrad.addColorStop(1, "#f3f7ff");
  cctx.fillStyle = bgGrad;
  cctx.fillRect(0, 0, w, h);

  const minLog = Math.log10(20), maxLog = Math.log10(20000);
  const gridFreqs = [50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000];
  cctx.strokeStyle = "rgba(29, 35, 48, 0.06)";
  cctx.lineWidth = 1;
  cctx.font = "10px Inter, sans-serif";
  cctx.fillStyle = "rgba(29, 35, 48, 0.35)";
  cctx.textAlign = "center";
  gridFreqs.forEach((f) => {
    const x = ((Math.log10(f) - minLog) / (maxLog - minLog)) * w;
    cctx.beginPath();
    cctx.moveTo(x, 0);
    cctx.lineTo(x, h - 14);
    cctx.stroke();
    const label = f >= 1000 ? (f / 1000) + "k" : f;
    cctx.fillText(label, x, h - 3);
  });

  const dbMax = 18;
  [-12, -6, 0, 6, 12].forEach((db) => {
    const y = ((dbMax - db) / (2 * dbMax)) * (h - 14);
    cctx.strokeStyle = db === 0 ? "rgba(29, 35, 48, 0.18)" : "rgba(29, 35, 48, 0.06)";
    cctx.beginPath();
    cctx.moveTo(0, y);
    cctx.lineTo(w, y);
    cctx.stroke();
    if (db !== 0) {
      cctx.fillStyle = "rgba(29, 35, 48, 0.25)";
      cctx.textAlign = "left";
      cctx.fillText((db > 0 ? "+" : "") + db, 4, y - 2);
    }
  });

  const N = Math.max(256, Math.floor(w));
  const freqs = new Float32Array(N);
  const mag = new Float32Array(N);
  const phase = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    freqs[i] = Math.pow(10, minLog + t * (maxLog - minLog));
  }

  if (ctx && filter) {
    const liveFilter = ctx.createBiquadFilter();
    liveFilter.type = "peaking";
    liveFilter.frequency.value = freqHz;
    liveFilter.gain.value = gainDb;
    liveFilter.Q.value = qVal;
    liveFilter.getFrequencyResponse(freqs, mag, phase);
  } else {
    for (let i = 0; i < N; i++) {
      mag[i] = magPeaking(freqs[i], freqHz, gainDb, qVal, 44100);
    }
  }

  cctx.beginPath();
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * w;
    const db = 20 * Math.log10(mag[i]);
    const y = ((dbMax - db) / (2 * dbMax)) * (h - 14);
    if (i === 0) cctx.moveTo(x, y);
    else cctx.lineTo(x, y);
  }
  const zeroY = (dbMax / (2 * dbMax)) * (h - 14);
  cctx.lineTo(w, zeroY);
  cctx.lineTo(0, zeroY);
  cctx.closePath();

  const curveFill = cctx.createLinearGradient(0, 0, 0, h);
  if (gainDb >= 0) {
    curveFill.addColorStop(0, "rgba(255, 138, 122, 0.35)");
    curveFill.addColorStop(1, "rgba(255, 209, 102, 0.1)");
  } else {
    curveFill.addColorStop(0, "rgba(124, 188, 255, 0.1)");
    curveFill.addColorStop(1, "rgba(124, 188, 255, 0.35)");
  }
  cctx.fillStyle = curveFill;
  cctx.fill();

  cctx.beginPath();
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * w;
    const db = 20 * Math.log10(mag[i]);
    const y = ((dbMax - db) / (2 * dbMax)) * (h - 14);
    if (i === 0) cctx.moveTo(x, y);
    else cctx.lineTo(x, y);
  }
  cctx.strokeStyle = gainDb >= 0 ? "#ff8a7a" : "#7cbcff";
  cctx.lineWidth = 2.5;
  cctx.stroke();

  const px = ((Math.log10(freqHz) - minLog) / (maxLog - minLog)) * w;
  const py = ((dbMax - gainDb) / (2 * dbMax)) * (h - 14);
  cctx.beginPath();
  cctx.arc(px, py, 7, 0, Math.PI * 2);
  cctx.fillStyle = "#fff";
  cctx.fill();
  cctx.strokeStyle = gainDb >= 0 ? "#ff8a7a" : "#7cbcff";
  cctx.lineWidth = 3;
  cctx.stroke();
}

// RBJ cookbook peaking filter magnitude — fallback only
function magPeaking(f, f0, dbGain, Q, fs) {
  const A = Math.pow(10, dbGain / 40);
  const w0 = 2 * Math.PI * f0 / fs;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosW0 = Math.cos(w0);

  const b0 = 1 + alpha * A;
  const b1 = -2 * cosW0;
  const b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A;
  const a1 = -2 * cosW0;
  const a2 = 1 - alpha / A;

  const w = 2 * Math.PI * f / fs;
  const cosW = Math.cos(w), sinW = Math.sin(w);
  const cos2W = Math.cos(2 * w), sin2W = Math.sin(2 * w);

  const numRe = b0 + b1 * cosW + b2 * cos2W;
  const numIm = -b1 * sinW - b2 * sin2W;
  const denRe = a0 + a1 * cosW + a2 * cos2W;
  const denIm = -a1 * sinW - a2 * sin2W;

  const numMag = Math.sqrt(numRe * numRe + numIm * numIm);
  const denMag = Math.sqrt(denRe * denRe + denIm * denIm);
  return numMag / denMag;
}

/* =====================================================================
   MODE SWITCHING
===================================================================== */
const modePlay = document.getElementById("modePlay");
const modeQuiz = document.getElementById("modeQuiz");
const playPanel = document.getElementById("playPanel");
const quizPanel = document.getElementById("quizPanel");

modePlay.addEventListener("click", () => setMode("play"));
modeQuiz.addEventListener("click", () => setMode("quiz"));

function setMode(m) {
  stop();
  if (m === "play") {
    modePlay.classList.add("active");
    modeQuiz.classList.remove("active");
    playPanel.style.display = "";
    quizPanel.classList.remove("visible");
    applyEQ();
  } else {
    modeQuiz.classList.add("active");
    modePlay.classList.remove("active");
    playPanel.style.display = "none";
    quizPanel.classList.add("visible");
    // Do NOT auto-start anything; user must pick a source.
    updateQuizUI();
  }
}

/* =====================================================================
   QUIZ MODE
===================================================================== */
const quizState = {
  phase: "idle",        // "idle" | "guessing" | "revealed"
  currentFreq: null,
  guessed: null,
  source: null,         // null | "pink" | "file" | clip index (number)
  userBuffer: null,
  userFileName: null,
  toggle: "eq",         // "dry" | "eq"
  correct: 0,
  total: 0,
};

const freqGuess = document.getElementById("freqGuess");
const scorePill = document.getElementById("scorePill");
const quizFeedback = document.getElementById("quizFeedback");
const quizAction = document.getElementById("quizAction");
const dryEqToggle = document.getElementById("dryEqToggle");
const quizSampleList = document.getElementById("quizSampleList");
const quizDropzone = document.getElementById("quizDropzone");
const quizFileInput = document.getElementById("quizFileInput");
const quizDropzoneIcon = document.getElementById("quizDropzoneIcon");
const quizDropzoneTitle = document.getElementById("quizDropzoneTitle");
const quizDropzoneHint = document.getElementById("quizDropzoneHint");
const diffGroup = document.getElementById("diffGroup");

function fmtQuizFreq(hz) {
  return hz >= 1000 ? (hz / 1000) + "k" : String(hz);
}

function buildQuizButtons() {
  freqGuess.innerHTML = "";
  QUIZ_FREQS.forEach((f) => {
    const btn = document.createElement("button");
    btn.className = "freq-btn";
    btn.textContent = fmtQuizFreq(f) + " Hz";
    btn.dataset.freq = String(f);
    btn.disabled = true;
    btn.addEventListener("click", () => makeGuess(f, btn));
    freqGuess.appendChild(btn);
  });
}

function buildQuizSources() {
  Array.from(quizSampleList.querySelectorAll("[data-qclip]")).forEach((n) => n.remove());
  SAMPLE_CLIPS.forEach((clip, i) => {
    const btn = document.createElement("button");
    btn.className = "sample-btn";
    btn.dataset.qsource = "clip";
    btn.dataset.qclip = String(i);
    btn.innerHTML =
      `<span class="play-icon">▶</span>` +
      `<span class="sample-name">${escapeHtml(clip.name)}</span>`;
    btn.addEventListener("click", () => selectQuizClip(i, btn));
    quizSampleList.appendChild(btn);
  });
}

// Pink-noise quiz-source listener — attached once
document.querySelector('#quizSampleList [data-qsource="pink"]').addEventListener("click", function () {
  selectQuizSource("pink", this);
});

async function selectQuizClip(index, btnEl) {
  ensureCtx();
  const icon = btnEl.querySelector(".play-icon");
  const prev = icon ? icon.textContent : "▶";
  if (icon) icon.textContent = "…";
  try {
    await loadUrl(SAMPLE_CLIPS[index].url);
    selectQuizSource(index, btnEl);
  } catch (err) {
    alert("Could not load clip: " + err.message);
    if (icon) icon.textContent = prev;
  }
}

async function selectQuizSource(src, btnEl) {
  ensureCtx();
  const srcEl = (src === "file") ? quizDropzone : btnEl;

  // If clicking the already-active source, toggle play/pause (don't restart).
  if (quizState.source === src && activeSourceEl === srcEl) {
    try {
      const buf = await getQuizBuffer();
      if (!buf) return;
      applyQuizEQ(quizState.toggle === "dry");
      togglePlayback(srcEl, buf);
    } catch (err) {
      alert("Could not load source: " + err.message);
    }
    updateQuizUI();
    return;
  }

  // Switching sources — full selection flow.
  quizState.source = src;

  // UI: mark the selected source element
  quizSampleList.querySelectorAll(".sample-btn").forEach((b) => b.classList.remove("active"));
  quizDropzone.classList.remove("playing");
  if (src === "file") {
    // dropzone is the active one — it already shows .loaded state
  } else if (btnEl) {
    btnEl.classList.add("active");
  }

  // If we're in idle phase, auto-create a question.
  if (quizState.phase === "idle") {
    newQuestion();
  }

  // Make sure the toggle is enabled
  dryEqToggle.setAttribute("aria-disabled", "false");

  // Start playback. Quiz playback defers to the Dry/EQ'd toggle state.
  try {
    const buf = await getQuizBuffer();
    if (!buf) return;
    applyQuizEQ(quizState.toggle === "dry");
    sourceOffset = 0;
    playBuffer(buf, 0);
    // Put the focus/active state on the source UI element
    setActiveSourceEl(srcEl);
  } catch (err) {
    alert("Could not load source: " + err.message);
  }

  updateQuizUI();
}

// Quiz drop zone
quizFileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (file) await handleQuizFile(file);
  quizFileInput.value = "";
});
["dragenter", "dragover"].forEach((ev) =>
  quizDropzone.addEventListener(ev, (e) => { e.preventDefault(); quizDropzone.classList.add("dragover"); })
);
["dragleave", "drop"].forEach((ev) =>
  quizDropzone.addEventListener(ev, (e) => { e.preventDefault(); quizDropzone.classList.remove("dragover"); })
);
quizDropzone.addEventListener("drop", async (e) => {
  const file = e.dataTransfer.files[0];
  if (file) await handleQuizFile(file);
});

quizDropzone.addEventListener("click", () => {
  if (quizState.userBuffer) {
    // Clicking a loaded quiz dropzone selects it (and auto-plays)
    selectQuizSource("file", null);
  } else {
    quizFileInput.click();
  }
});

async function handleQuizFile(file) {
  try {
    const buf = await decodeFile(file);
    quizState.userBuffer = buf;
    quizState.userFileName = file.name;
    markDropzoneLoaded(quizDropzone, file.name);
    await selectQuizSource("file", null);
  } catch (err) {
    alert("Could not decode that file: " + err.message);
  }
}

async function getQuizBuffer() {
  ensureCtx();
  if (quizState.source === "pink") {
    if (!pinkBuffer) pinkBuffer = createPinkNoise(4);
    return pinkBuffer;
  }
  if (quizState.source === "file") {
    return quizState.userBuffer;
  }
  if (typeof quizState.source === "number") {
    const clip = SAMPLE_CLIPS[quizState.source];
    return await loadUrl(clip.url);
  }
  return null;
}

function applyQuizEQ(bypassThis = false) {
  if (!ctx) return;
  const diff = DIFFICULTY[quizDifficulty];
  if (bypassThis) {
    filter.gain.setTargetAtTime(0, ctx.currentTime, 0.005);
  } else {
    filter.frequency.setTargetAtTime(quizState.currentFreq || 1000, ctx.currentTime, 0.005);
    filter.gain.setTargetAtTime(diff.gain, ctx.currentTime, 0.005);
    filter.Q.setTargetAtTime(diff.Q, ctx.currentTime, 0.005);
  }
}

/* ---------- Dry/EQ'd toggle ---------- */
function setToggleState(newVal, animate = true) {
  quizState.toggle = newVal;
  dryEqToggle.setAttribute("aria-checked", newVal === "eq" ? "true" : "false");
  // Live-switch the filter without restarting audio
  applyQuizEQ(newVal === "dry");
}

function handleToggleClick() {
  if (dryEqToggle.getAttribute("aria-disabled") === "true") return;
  if (quizState.source == null) return;
  if (quizState.phase === "idle") return;
  setToggleState(quizState.toggle === "eq" ? "dry" : "eq");
}

dryEqToggle.addEventListener("click", handleToggleClick);
dryEqToggle.addEventListener("keydown", (e) => {
  if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    handleToggleClick();
  }
});

/* ---------- Difficulty picker ---------- */
diffGroup.querySelectorAll(".diff-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const d = btn.dataset.diff;
    if (!DIFFICULTY[d]) return;
    quizDifficulty = d;
    diffGroup.querySelectorAll(".diff-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    // Re-apply EQ with the new difficulty if a question is active
    if (quizState.phase !== "idle") {
      applyQuizEQ(quizState.toggle === "dry");
    }
  });
});

/* ---------- Guess / reveal / next ---------- */
function makeGuess(hz, btnEl) {
  if (quizState.phase !== "guessing") return;
  quizState.guessed = hz;
  freqGuess.querySelectorAll(".freq-btn").forEach((b) => b.classList.remove("selected"));
  btnEl.classList.add("selected");
  updateQuizUI();
}

function newQuestion() {
  if (quizState.source == null) return;

  // Pick a different frequency than the last one when possible.
  let f;
  do { f = QUIZ_FREQS[Math.floor(Math.random() * QUIZ_FREQS.length)]; }
  while (quizState.currentFreq && f === quizState.currentFreq && QUIZ_FREQS.length > 1);

  quizState.currentFreq = f;
  quizState.guessed = null;
  quizState.phase = "guessing";
  // Default back to EQ'd on a new question, so the ear hears the boost.
  setToggleState("eq");

  // Clear any reveal markings on the freq buttons.
  freqGuess.querySelectorAll(".freq-btn").forEach((b) =>
    b.classList.remove("selected", "correct", "wrong")
  );

  // Update the filter for the new question. If audio is already playing, it
  // continues — the EQ freq just shifts underneath.
  if (ctx) applyQuizEQ(quizState.toggle === "dry");

  updateQuizUI();
}

function revealAnswer() {
  if (quizState.phase !== "guessing" || quizState.guessed == null) return;

  quizState.phase = "revealed";
  quizState.total += 1;
  const correct = quizState.guessed === quizState.currentFreq;
  if (correct) quizState.correct += 1;

  freqGuess.querySelectorAll(".freq-btn").forEach((b) => {
    const f = +b.dataset.freq;
    if (f === quizState.currentFreq) b.classList.add("correct");
    else if (f === quizState.guessed) b.classList.add("wrong");
  });

  quizFeedback.textContent = correct
    ? "Nice — that's right!"
    : `Nope — it was ${fmtQuizFreq(quizState.currentFreq)} Hz. You picked ${fmtQuizFreq(quizState.guessed)} Hz.`;
  quizFeedback.className = "feedback " + (correct ? "ok" : "bad");

  scorePill.textContent = `${quizState.correct} / ${quizState.total}`;
  updateQuizUI();
}

quizAction.addEventListener("click", () => {
  if (quizState.phase === "guessing") {
    revealAnswer();
  } else {
    newQuestion();
  }
});

/**
 * Centralized UI state for the Quiz panel.
 */
function updateQuizUI() {
  if (quizState.phase === "idle") {
    quizAction.textContent = "New Question";
    quizAction.disabled = quizState.source == null;
  } else if (quizState.phase === "guessing") {
    quizAction.textContent = "Reveal";
    quizAction.disabled = quizState.guessed == null;
  } else {
    quizAction.textContent = "New Question";
    quizAction.disabled = false;
  }

  const toggleOK = quizState.source != null && quizState.phase !== "idle";
  dryEqToggle.setAttribute("aria-disabled", toggleOK ? "false" : "true");
  dryEqToggle.setAttribute("aria-checked", quizState.toggle === "eq" ? "true" : "false");

  freqGuess.querySelectorAll(".freq-btn").forEach((b) => {
    b.disabled = quizState.phase !== "guessing";
  });

  if (quizState.phase === "idle") {
    quizFeedback.textContent = quizState.source == null
      ? "Select a source to start."
      : "Click New Question to begin.";
    quizFeedback.className = "feedback";
  } else if (quizState.phase === "guessing") {
    quizFeedback.textContent = quizState.guessed == null
      ? "Flip between Dry and EQ'd, then pick a frequency."
      : "Ready — click Reveal.";
    quizFeedback.className = "feedback";
  }
  // "revealed" feedback is set inside revealAnswer() and left alone here.
}

/* =====================================================================
   MONO / STEREO TOOL
===================================================================== */
const msDropzone = document.getElementById("msDropzone");
const msFileInput = document.getElementById("msFileInput");
const msSampleList = document.getElementById("msSampleList");
const monoToggle = document.getElementById("monoToggle");
const msStatus = document.getElementById("msStatus");

const msState = {
  source: null,       // null | "file" | clip index (number)
  userBuffer: null,
  userFileName: null,
  isMono: false,
};

function buildMsSources() {
  msSampleList.innerHTML = "";
  SAMPLE_CLIPS.forEach((clip, i) => {
    const btn = document.createElement("button");
    btn.className = "sample-btn";
    btn.dataset.msSource = "clip";
    btn.dataset.msClip = String(i);
    btn.innerHTML =
      `<span class="play-icon">▶</span>` +
      `<span class="sample-name">${escapeHtml(clip.name)}</span>`;
    btn.addEventListener("click", () => handleMsSampleClick(btn, clip, i));
    msSampleList.appendChild(btn);
  });
}

async function handleMsSampleClick(btn, clip, index) {
  ensureCtx();
  const existing = getSourceBuffer(btn);
  if (existing && existing.buffer) {
    msState.source = index;
    togglePlayback(btn, existing.buffer);
    updateMsUI();
    return;
  }
  const icon = btn.querySelector(".play-icon");
  const prev = icon.textContent;
  icon.textContent = "…";
  try {
    const buf = await loadUrl(clip.url);
    setSourceBuffer(btn, buf);
    msState.source = index;
    togglePlayback(btn, buf);
    updateMsUI();
  } catch (err) {
    alert("Could not load clip: " + err.message + "\n\nMake sure the S3 bucket allows CORS GET from this origin.");
    icon.textContent = prev;
  }
}

// Mono/Stereo drop zone
msFileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (file) await handleMsFile(file);
  msFileInput.value = "";
});
["dragenter", "dragover"].forEach((ev) =>
  msDropzone.addEventListener(ev, (e) => { e.preventDefault(); msDropzone.classList.add("dragover"); })
);
["dragleave", "drop"].forEach((ev) =>
  msDropzone.addEventListener(ev, (e) => { e.preventDefault(); msDropzone.classList.remove("dragover"); })
);
msDropzone.addEventListener("drop", async (e) => {
  const file = e.dataTransfer.files[0];
  if (file) await handleMsFile(file);
});
msDropzone.addEventListener("click", () => {
  const entry = getSourceBuffer(msDropzone);
  if (entry && entry.buffer) {
    msState.source = "file";
    togglePlayback(msDropzone, entry.buffer);
    updateMsUI();
  } else {
    msFileInput.click();
  }
});

async function handleMsFile(file) {
  try {
    const buf = await decodeFile(file);
    msState.userBuffer = buf;
    msState.userFileName = file.name;
    msState.source = "file";
    setSourceBuffer(msDropzone, buf, file.name);
    markDropzoneLoaded(msDropzone, file.name);
    togglePlayback(msDropzone, buf);
    updateMsUI();
  } catch (err) {
    alert("Could not decode that file: " + err.message);
  }
}

/** Crossfade between the stereo path and the summed-mono path. */
function setMonoRouting(isMono) {
  if (!ctx) return;
  const now = ctx.currentTime;
  msStereoGain.gain.setTargetAtTime(isMono ? 0 : 1, now, 0.015);
  msMonoGain.gain.setTargetAtTime(isMono ? 1 : 0, now, 0.015);
}

function handleMonoToggleClick() {
  if (monoToggle.getAttribute("aria-disabled") === "true") return;
  msState.isMono = !msState.isMono;
  monoToggle.setAttribute("aria-checked", msState.isMono ? "true" : "false");
  setMonoRouting(msState.isMono);
  updateMsUI();
}
monoToggle.addEventListener("click", handleMonoToggleClick);
monoToggle.addEventListener("keydown", (e) => {
  if (e.key === " " || e.key === "Enter") { e.preventDefault(); handleMonoToggleClick(); }
});

function updateMsUI() {
  const hasSource = msState.source != null;
  monoToggle.setAttribute("aria-disabled", hasSource ? "false" : "true");
  monoToggle.setAttribute("aria-checked", msState.isMono ? "true" : "false");
  if (!hasSource) {
    msStatus.textContent = "Select a source to start.";
    msStatus.classList.remove("active");
  } else {
    msStatus.classList.add("active");
    msStatus.textContent = msState.isMono
      ? "Summed mono — both channels combined."
      : "Stereo — left and right independent.";
  }
}

/* =====================================================================
   STEREO VECTORSCOPE — minimalist mid/side Lissajous
===================================================================== */
const msCanvas = document.getElementById("msCanvas");
const msCtx = msCanvas ? msCanvas.getContext("2d") : null;

function resizeMsCanvas() {
  if (!msCanvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = msCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  msCanvas.width = rect.width * dpr;
  msCanvas.height = rect.height * dpr;
  msCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resizeMsCanvas);

// Mode-driven scope color: lavender (matches the Stereo toggle) when stereo,
// a darker gold for contrast (toggle uses --sun #ffd166) when mono.
const VIZ_COLOR_STEREO = "#c29cf2";  // = var(--lavender)
const VIZ_COLOR_MONO   = "#d9a836";  // darker than --sun for contrast on light bg

function drawStereoViz() {
  if (!msCtx || !msCanvas) return;
  const w = msCanvas.clientWidth;
  const h = msCanvas.clientHeight;
  if (!w || !h) { requestAnimationFrame(drawStereoViz); return; }

  // Motion-trail fade — matches the soft gradient bg so dots slowly disappear.
  msCtx.fillStyle = "rgba(250, 252, 255, 0.18)";
  msCtx.fillRect(0, 0, w, h);

  // Faint center cross — the only structural ink on the scope.
  msCtx.strokeStyle = "rgba(29, 35, 48, 0.08)";
  msCtx.lineWidth = 1;
  msCtx.beginPath();
  msCtx.moveTo(w / 2, 0); msCtx.lineTo(w / 2, h);
  msCtx.moveTo(0, h / 2); msCtx.lineTo(w, h / 2);
  msCtx.stroke();

  // Only animate when the mono/stereo tool is active and audio is playing.
  if (currentTool !== "monoStereo" || !isPlaying || !leftAnalyser || !rightAnalyser) {
    requestAnimationFrame(drawStereoViz);
    return;
  }

  const N = leftAnalyser.fftSize;
  const left = new Float32Array(N);
  const right = new Float32Array(N);
  leftAnalyser.getFloatTimeDomainData(left);
  rightAnalyser.getFloatTimeDomainData(right);

  const cx = w / 2, cy = h / 2;
  const radius = Math.min(w, h) * 0.46;
  const color = msState.isMono ? VIZ_COLOR_MONO : VIZ_COLOR_STEREO;

  // Plot mid on Y-axis, side on X-axis, rotated 45° from raw L/R so mono lives
  // on the vertical. Subsample for speed (every 2nd frame = ~512 dots). Single
  // color avoids muddy-brown overlap artifacts from multi-hue blending.
  msCtx.fillStyle = color;
  for (let i = 0; i < N; i += 2) {
    const L = left[i];
    const R = right[i];
    const mid  = (L + R) * 0.5;
    const side = (L - R) * 0.5;

    const x = cx + side * radius * 2;
    const y = cy - mid  * radius * 2;

    const amp = Math.min(1, Math.sqrt(mid * mid + side * side) * 1.5);

    msCtx.globalAlpha = 0.3 + amp * 0.5;
    msCtx.beginPath();
    msCtx.arc(x, y, 1.4 + amp * 1.4, 0, Math.PI * 2);
    msCtx.fill();
  }
  msCtx.globalAlpha = 1;

  requestAnimationFrame(drawStereoViz);
}

/* =====================================================================
   REVERB TOOL — convolution with Sprague Hall IR + wet/dry + WAV export
===================================================================== */
const reverbDropzone = document.getElementById("reverbDropzone");
const reverbFileInput = document.getElementById("reverbFileInput");
const reverbSampleList = document.getElementById("reverbSampleList");
const reverbStatus = document.getElementById("reverbStatus");
const reverbExport = document.getElementById("reverbExport");
const spragueSlider = document.getElementById("spragueSlider");
const spragueVal = document.getElementById("spragueVal");
const woolseySlider = document.getElementById("woolseySlider");
const woolseyVal = document.getElementById("woolseyVal");

const reverbState = {
  source: null,        // null | "file" | clip index (number)
  userBuffer: null,
  userFileName: null,
  sourceName: null,    // friendly name for export filename
};

function buildReverbSources() {
  reverbSampleList.innerHTML = "";
  SAMPLE_CLIPS.forEach((clip, i) => {
    const btn = document.createElement("button");
    btn.className = "sample-btn";
    btn.dataset.revSource = "clip";
    btn.dataset.revClip = String(i);
    btn.innerHTML =
      `<span class="play-icon">▶</span>` +
      `<span class="sample-name">${escapeHtml(clip.name)}</span>`;
    btn.addEventListener("click", () => handleReverbSampleClick(btn, clip, i));
    reverbSampleList.appendChild(btn);
  });
}

async function handleReverbSampleClick(btn, clip, index) {
  ensureCtx();
  const existing = getSourceBuffer(btn);
  if (existing && existing.buffer) {
    reverbState.source = index;
    reverbState.sourceName = clip.name;
    togglePlayback(btn, existing.buffer);
    updateReverbUI();
    return;
  }
  const icon = btn.querySelector(".play-icon");
  const prev = icon.textContent;
  icon.textContent = "…";
  try {
    const buf = await loadUrl(clip.url);
    setSourceBuffer(btn, buf);
    reverbState.source = index;
    reverbState.sourceName = clip.name;
    togglePlayback(btn, buf);
    updateReverbUI();
  } catch (err) {
    alert("Could not load clip: " + err.message);
    icon.textContent = prev;
  }
}

// Reverb drop zone
reverbFileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (file) await handleReverbFile(file);
  reverbFileInput.value = "";
});
["dragenter", "dragover"].forEach((ev) =>
  reverbDropzone.addEventListener(ev, (e) => { e.preventDefault(); reverbDropzone.classList.add("dragover"); })
);
["dragleave", "drop"].forEach((ev) =>
  reverbDropzone.addEventListener(ev, (e) => { e.preventDefault(); reverbDropzone.classList.remove("dragover"); })
);
reverbDropzone.addEventListener("drop", async (e) => {
  const file = e.dataTransfer.files[0];
  if (file) await handleReverbFile(file);
});
reverbDropzone.addEventListener("click", () => {
  const entry = getSourceBuffer(reverbDropzone);
  if (entry && entry.buffer) {
    reverbState.source = "file";
    reverbState.sourceName = entry.filename || "audio";
    togglePlayback(reverbDropzone, entry.buffer);
    updateReverbUI();
  } else {
    reverbFileInput.click();
  }
});

async function handleReverbFile(file) {
  try {
    const buf = await decodeFile(file);
    reverbState.userBuffer = buf;
    reverbState.userFileName = file.name;
    reverbState.source = "file";
    reverbState.sourceName = file.name.replace(/\.[^.]+$/, "");
    setSourceBuffer(reverbDropzone, buf, file.name);
    markDropzoneLoaded(reverbDropzone, file.name);
    togglePlayback(reverbDropzone, buf);
    updateReverbUI();
  } catch (err) {
    alert("Could not decode that file: " + err.message);
  }
}

/**
 * Apply the current hall-slider positions to the audio graph.
 *   - Each hall's wet gain = sin(frac * π/2) (equal-power taper per slider).
 *   - Dry gain          = cos(max(f1, f2) * π/2) — drops against the louder
 *     slider so pushing one or both halls keeps total perceived level in check.
 */
function applyHallMix() {
  if (!ctx) return;
  const now = ctx.currentTime;
  const f1 = (+spragueSlider.value) / 100;
  const f2 = (+woolseySlider.value) / 100;
  const wet1 = Math.sin(f1 * Math.PI / 2);
  const wet2 = Math.sin(f2 * Math.PI / 2);
  const dry  = Math.cos(Math.max(f1, f2) * Math.PI / 2);
  reverbDry.gain.setTargetAtTime(dry, now, 0.01);
  spragueWet.gain.setTargetAtTime(wet1, now, 0.01);
  woolseyWet.gain.setTargetAtTime(wet2, now, 0.01);
}

spragueSlider.addEventListener("input", () => {
  spragueVal.textContent = +spragueSlider.value;
  applyHallMix();
});
woolseySlider.addEventListener("input", () => {
  woolseyVal.textContent = +woolseySlider.value;
  applyHallMix();
});

function getCurrentReverbBuffer() {
  if (reverbState.source === "file") return reverbState.userBuffer;
  if (typeof reverbState.source === "number") {
    // Look up the cached buffer by URL
    const clip = SAMPLE_CLIPS[reverbState.source];
    return bufferCache.get(clip && clip.url) || null;
  }
  return null;
}

function updateReverbUI() {
  const hasSource = reverbState.source != null && getCurrentReverbBuffer();
  const anyIRReady = !!(spragueBuffer || woolseyBuffer);
  const bothIRReady = !!(spragueBuffer && woolseyBuffer);
  reverbExport.disabled = !(hasSource && anyIRReady);
  if (!anyIRReady) {
    reverbStatus.textContent = "Loading impulse responses…";
    reverbStatus.classList.remove("active");
  } else if (!bothIRReady) {
    reverbStatus.textContent = spragueBuffer
      ? "Sprague loaded — Woolsey still loading."
      : "Woolsey loaded — Sprague still loading.";
    reverbStatus.classList.remove("active");
  } else if (!hasSource) {
    reverbStatus.textContent = "Select a source to start.";
    reverbStatus.classList.remove("active");
  } else {
    reverbStatus.classList.add("active");
    reverbStatus.textContent = "Playing — blend Sprague and Woolsey, then export.";
  }
}

/* ----------- Export: render offline + encode as WAV ------------- */

/**
 * Render the current source through the same two-convolver graph offline,
 * including a full reverb tail, and return the rendered AudioBuffer.
 */
async function renderReverbOffline() {
  const buf = getCurrentReverbBuffer();
  if (!buf) throw new Error("No source buffer");
  await loadHallIRs().catch(() => null); // tolerate partial load
  if (!spragueBuffer && !woolseyBuffer) throw new Error("No IR available");

  const f1 = (+spragueSlider.value) / 100;
  const f2 = (+woolseySlider.value) / 100;
  // Tail is the longer of whichever halls are actually used.
  const tailSec = Math.max(
    f1 > 0 && spragueBuffer ? spragueBuffer.duration : 0,
    f2 > 0 && woolseyBuffer ? woolseyBuffer.duration : 0,
    0.1
  );
  const totalLen = Math.ceil((buf.duration + tailSec) * buf.sampleRate);
  const offline = new OfflineAudioContext(2, totalLen, buf.sampleRate);

  const src = offline.createBufferSource();
  src.buffer = buf;
  src.loop = false;

  const dry = offline.createGain();
  dry.gain.value = Math.cos(Math.max(f1, f2) * Math.PI / 2);
  src.connect(dry);
  dry.connect(offline.destination);

  if (spragueBuffer) {
    const conv1 = offline.createConvolver();
    conv1.normalize = true;
    conv1.buffer = spragueBuffer;
    const wet1 = offline.createGain();
    wet1.gain.value = Math.sin(f1 * Math.PI / 2);
    src.connect(conv1);
    conv1.connect(wet1);
    wet1.connect(offline.destination);
  }
  if (woolseyBuffer) {
    const conv2 = offline.createConvolver();
    conv2.normalize = true;
    conv2.buffer = woolseyBuffer;
    const wet2 = offline.createGain();
    wet2.gain.value = Math.sin(f2 * Math.PI / 2);
    src.connect(conv2);
    conv2.connect(wet2);
    wet2.connect(offline.destination);
  }

  src.start(0);
  return await offline.startRendering();
}

/** Encode an AudioBuffer as 16-bit PCM WAV. Interleaves channels for stereo. */
function audioBufferToWav(audioBuffer) {
  const numCh = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numFrames = audioBuffer.length;
  const byteLength = 44 + numFrames * numCh * 2;
  const ab = new ArrayBuffer(byteLength);
  const view = new DataView(ab);

  const channels = [];
  for (let i = 0; i < numCh; i++) channels.push(audioBuffer.getChannelData(i));

  function writeString(off, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  }

  // RIFF header
  writeString(0, "RIFF");
  view.setUint32(4, byteLength - 8, true);
  writeString(8, "WAVE");
  // fmt chunk
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);                      // PCM header size
  view.setUint16(20, 1, true);                       // format = PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numCh * 2, true);  // byte rate
  view.setUint16(32, numCh * 2, true);               // block align
  view.setUint16(34, 16, true);                      // bits per sample
  // data chunk
  writeString(36, "data");
  view.setUint32(40, numFrames * numCh * 2, true);

  // Interleave + convert to int16
  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      let s = channels[ch][i];
      s = Math.max(-1, Math.min(1, s));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
  }
  return new Blob([ab], { type: "audio/wav" });
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

reverbExport.addEventListener("click", async () => {
  if (reverbExport.disabled) return;
  const prev = reverbExport.textContent;
  reverbExport.disabled = true;
  reverbExport.classList.add("rendering");
  reverbExport.textContent = "Rendering…";
  try {
    const rendered = await renderReverbOffline();
    const blob = audioBufferToWav(rendered);
    const s = Math.round((+spragueSlider.value));
    const w = Math.round((+woolseySlider.value));
    const base = (reverbState.sourceName || "audio").replace(/[\\\/:*?"<>|]/g, " ").trim();
    triggerDownload(blob, `${base} (Sprague ${s}pct Woolsey ${w}pct).wav`);
    reverbExport.textContent = "Exported ✓";
    setTimeout(() => { reverbExport.textContent = prev; }, 1400);
  } catch (err) {
    alert("Export failed: " + err.message);
    reverbExport.textContent = prev;
  } finally {
    reverbExport.classList.remove("rendering");
    reverbExport.disabled = false;
    updateReverbUI();
  }
});

/* =====================================================================
   MUSIC MOUNTAIN PRE-MASTER
   ---------------------------------------------------------------------
   Upload -> normalize -> limit (3 dB GR, 0 dB ceiling) -> Sprague
   convolution at 15% wet -> 192 kbps MP3.

   Built for very long files (2+ hours). Nothing is decoded at upload
   time; on export the file is processed in ~30 s segments so peak memory
   stays small:
     - WAV input is streamed straight off disk (no decodeAudioData at all)
     - compressed input (mp3/m4a/flac/...) falls back to a one-shot decode
     - the limiter runs segment-by-segment with a small lookahead "peek"
       into the next segment, mathematically identical to whole-file
     - the reverb convolves each segment offline and overlap-adds the tail
       into the next segment (linear convolution distributes over time)
     - MP3 encoding happens in a Web Worker running LAME compiled to WASM
       (~10x faster than the JS encoder), with a main-thread JS fallback
===================================================================== */
const premasterTool = document.getElementById("premasterTool");
const pmDropzone = document.getElementById("pmDropzone");
const pmFileInput = document.getElementById("pmFileInput");
const pmStatus = document.getElementById("pmStatus");
const pmExport = document.getElementById("pmExport");
const pmProgress = document.getElementById("pmProgress");
const pmProgressFill = document.getElementById("pmProgressFill");

const PM_LIMITER_CEILING_DB = 0; // limiter output ceiling
const PM_LIMITER_DRIVE_DB = 3;   // gain pushed into the limiter after normalization (= max gain reduction)
const PM_WET_FRAC = 0.15;        // 15% wet, equal-power dry/wet taper
const PM_MP3_KBPS = 192;
const PM_SEG_SEC = 120;          // processing segment length (bigger = fewer convolver setups)
const PM_RENDER_AHEAD = 2;       // offline reverb renders allowed in flight concurrently

const pmState = {
  file: null,
  sourceName: null,
};

const pmYield = () => new Promise((r) => setTimeout(r, 0));

/* ---------------- upload (no decoding here — that's the crash fix) ----- */

pmFileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) handlePmFile(file);
  pmFileInput.value = "";
});
["dragenter", "dragover"].forEach((ev) =>
  pmDropzone.addEventListener(ev, (e) => { e.preventDefault(); pmDropzone.classList.add("dragover"); })
);
["dragleave", "drop"].forEach((ev) =>
  pmDropzone.addEventListener(ev, (e) => { e.preventDefault(); pmDropzone.classList.remove("dragover"); })
);
pmDropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) handlePmFile(file);
});
pmDropzone.addEventListener("click", () => pmFileInput.click());

function handlePmFile(file) {
  pmState.file = file;
  pmState.sourceName = file.name.replace(/\.[^.]+$/, "");
  pmDropzone.classList.add("loaded");
  const icon = pmDropzone.querySelector(".dz-icon");
  const title = pmDropzone.querySelector(".dz-title");
  const hint = pmDropzone.querySelector(".dz-hint");
  if (icon) icon.textContent = "🎵";
  if (title) title.textContent = file.name;
  if (hint) hint.textContent = "click to replace";
  updatePmUI();
}

function updatePmUI(msg) {
  const hasSource = !!pmState.file;
  pmExport.disabled = !hasSource;
  if (msg) {
    pmStatus.textContent = msg;
    pmStatus.classList.add("active");
  } else if (!hasSource) {
    pmStatus.textContent = "Upload an audio file to start.";
    pmStatus.classList.remove("active");
  } else {
    pmStatus.textContent = "File loaded — ready to process.";
    pmStatus.classList.add("active");
  }
}

function pmSetProgress(frac) {
  pmProgressFill.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
}
function pmShowProgress(show) {
  pmProgress.hidden = !show;
  if (show) pmSetProgress(0);
}

const pmElapsed = document.getElementById("pmElapsed");
const pmElapsedTime = document.getElementById("pmElapsedTime");
let pmTimerId = null;
let pmTimerStart = 0;

function pmFormatElapsed(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return (h > 0 ? `${h}:` : "") + `${mm}:${String(s).padStart(2, "0")}`;
}
function pmStartTimer() {
  pmTimerStart = performance.now();
  pmElapsedTime.textContent = "0:00";
  pmElapsed.hidden = false;
  if (pmTimerId) clearInterval(pmTimerId);
  pmTimerId = setInterval(() => {
    pmElapsedTime.textContent = pmFormatElapsed(performance.now() - pmTimerStart);
  }, 250);
}
function pmStopTimer() {
  if (pmTimerId) { clearInterval(pmTimerId); pmTimerId = null; }
  // freeze on the final elapsed value (leave it visible)
  if (pmTimerStart) pmElapsedTime.textContent = pmFormatElapsed(performance.now() - pmTimerStart);
}

/* ---------------- audio sources (streamed WAV / decoded fallback) ------ */

/**
 * Parse a RIFF/WAVE file's chunk structure by reading small slices off disk.
 * Returns { sampleRate, channels, bitsPerSample, format, blockAlign,
 * dataOffset, dataBytes, length } or throws if not a PCM/float WAV.
 */
async function pmParseWavHeader(file) {
  const readBytes = async (off, n) => new DataView(await file.slice(off, off + n).arrayBuffer());
  const head = await readBytes(0, 12);
  const tag = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(head, 0) !== "RIFF" || tag(head, 8) !== "WAVE") throw new Error("not a WAV file");

  let off = 12;
  let fmt = null, dataOffset = -1, dataBytes = 0;
  while (off + 8 <= file.size) {
    const ch = await readBytes(off, 8);
    const id = tag(ch, 0);
    const size = ch.getUint32(4, true);
    if (id === "fmt ") {
      const f = await readBytes(off + 8, Math.min(size, 40));
      let format = f.getUint16(0, true);
      const channels = f.getUint16(2, true);
      const sampleRate = f.getUint32(4, true);
      const blockAlign = f.getUint16(12, true);
      const bitsPerSample = f.getUint16(14, true);
      if (format === 0xfffe && size >= 40) format = f.getUint16(24, true); // WAVE_FORMAT_EXTENSIBLE
      fmt = { format, channels, sampleRate, blockAlign, bitsPerSample };
    } else if (id === "data") {
      dataOffset = off + 8;
      dataBytes = size === 0xffffffff ? file.size - dataOffset : Math.min(size, file.size - dataOffset);
      // fmt almost always precedes data; if we have both, stop walking.
      if (fmt) break;
    }
    off += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || dataOffset < 0) throw new Error("malformed WAV (missing fmt/data chunk)");
  const ok = (fmt.format === 1 && [8, 16, 24, 32].includes(fmt.bitsPerSample)) ||
             (fmt.format === 3 && fmt.bitsPerSample === 32);
  if (!ok) throw new Error("unsupported WAV encoding");
  const length = Math.floor(dataBytes / fmt.blockAlign);
  return { ...fmt, dataOffset, dataBytes, length };
}

/**
 * Streaming WAV source: reads sample ranges directly from the File via
 * Blob.slice, converting to Float32 on the fly. Memory stays at segment
 * size no matter how long the file is.
 */
function pmWavSource(file, info) {
  const numCh = Math.min(2, info.channels);
  const stride = info.channels; // samples per frame in the interleaved data
  return {
    kind: "wav",
    sampleRate: info.sampleRate,
    length: info.length,
    channels: numCh,
    async readSegment(start, count) {
      const n = Math.max(0, Math.min(count, info.length - start));
      const out = [];
      for (let c = 0; c < numCh; c++) out.push(new Float32Array(n));
      if (n === 0) return out;
      const byteStart = info.dataOffset + start * info.blockAlign;
      // slice() returns a fresh ArrayBuffer starting at byte 0, so typed-array
      // views are always aligned — this bulk conversion is 10-50x faster than
      // per-sample DataView reads, which matters a lot on 2-hour files.
      const ab = await file.slice(byteStart, byteStart + n * info.blockAlign).arrayBuffer();
      if (info.format === 3) {
        const f32 = new Float32Array(ab);
        for (let c = 0; c < numCh; c++) {
          const d = out[c];
          for (let i = 0; i < n; i++) d[i] = f32[i * stride + c];
        }
      } else if (info.bitsPerSample === 16) {
        const i16 = new Int16Array(ab);
        for (let c = 0; c < numCh; c++) {
          const d = out[c];
          for (let i = 0; i < n; i++) d[i] = i16[i * stride + c] / 32768;
        }
      } else if (info.bitsPerSample === 24) {
        const u8 = new Uint8Array(ab);
        const ba = info.blockAlign;
        for (let c = 0; c < numCh; c++) {
          const d = out[c];
          const co = c * 3;
          for (let i = 0; i < n; i++) {
            const o = i * ba + co;
            d[i] = (((u8[o + 2] << 24) | (u8[o + 1] << 16) | (u8[o] << 8)) >> 8) / 8388608;
          }
        }
      } else if (info.bitsPerSample === 32) {
        const i32 = new Int32Array(ab);
        for (let c = 0; c < numCh; c++) {
          const d = out[c];
          for (let i = 0; i < n; i++) d[i] = i32[i * stride + c] / 2147483648;
        }
      } else {
        const u8 = new Uint8Array(ab);
        for (let c = 0; c < numCh; c++) {
          const d = out[c];
          for (let i = 0; i < n; i++) d[i] = (u8[i * stride + c] - 128) / 128;
        }
      }
      return out;
    },
    /** Fast peak scan: reads raw integers, no float conversion or copies. */
    async scanPeak(start, count) {
      const n = Math.max(0, Math.min(count, info.length - start));
      if (n === 0) return 0;
      const byteStart = info.dataOffset + start * info.blockAlign;
      const ab = await file.slice(byteStart, byteStart + n * info.blockAlign).arrayBuffer();
      let m = 0;
      if (info.format === 3) {
        const f32 = new Float32Array(ab);
        for (let i = 0; i < f32.length; i++) {
          const a = Math.abs(f32[i]);
          if (a > m) m = a;
        }
        return m;
      }
      if (info.bitsPerSample === 16) {
        const i16 = new Int16Array(ab);
        for (let i = 0; i < i16.length; i++) {
          const a = i16[i] < 0 ? -i16[i] : i16[i];
          if (a > m) m = a;
        }
        return m / 32768;
      }
      if (info.bitsPerSample === 24) {
        const u8 = new Uint8Array(ab);
        for (let o = 0; o + 2 < u8.length; o += 3) {
          let v = ((u8[o + 2] << 24) | (u8[o + 1] << 16) | (u8[o] << 8)) >> 8;
          if (v < 0) v = -v;
          if (v > m) m = v;
        }
        return m / 8388608;
      }
      if (info.bitsPerSample === 32) {
        const i32 = new Int32Array(ab);
        for (let i = 0; i < i32.length; i++) {
          const a = i32[i] < 0 ? -i32[i] : i32[i];
          if (a > m) m = a;
        }
        return m / 2147483648;
      }
      const u8 = new Uint8Array(ab);
      for (let i = 0; i < u8.length; i++) {
        const a = u8[i] < 128 ? 128 - u8[i] : u8[i] - 128;
        if (a > m) m = a;
      }
      return m / 128;
    },
  };
}

/** Decoded-buffer source for compressed input (mp3/m4a/flac/...). */
function pmBufferSource(buffer) {
  const numCh = Math.min(2, buffer.numberOfChannels);
  return {
    kind: "decoded",
    sampleRate: buffer.sampleRate,
    length: buffer.length,
    channels: numCh,
    async readSegment(start, count) {
      const n = Math.max(0, Math.min(count, buffer.length - start));
      const out = [];
      for (let c = 0; c < numCh; c++) {
        const arr = new Float32Array(n);
        if (n > 0) buffer.copyFromChannel(arr, c, start);
        out.push(arr);
      }
      return out;
    },
  };
}

async function pmBuildSource(file, onStatus) {
  const isWavName = /\.(wav|wave|bwf)$/i.test(file.name) || file.type === "audio/wav" || file.type === "audio/x-wav";
  if (isWavName) {
    try {
      const info = await pmParseWavHeader(file);
      return pmWavSource(file, info);
    } catch (e) {
      // fall through to decode (could be a compressed file with a .wav name)
    }
  }
  onStatus("Decoding…");
  const buf = await decodeFile(file);
  return pmBufferSource(buf);
}

/* ---------------- DSP: streaming limiter ---------------- */

/**
 * Limiter state shared across segments. The lookahead window only reaches
 * FORWARD, so each segment is self-contained given a `look`-sample peek into
 * the next segment; the only state carried across segments is the smoothed
 * envelope scalar. Output is bit-identical to whole-file processing.
 */
function pmLimiterState(sampleRate, thresholdDb, normGain, lookaheadMs = 5, releaseMs = 80) {
  return {
    thr: Math.pow(10, thresholdDb / 20),
    normGain,
    look: Math.max(1, Math.round((lookaheadMs / 1000) * sampleRate)),
    attCoef: Math.exp(-1 / ((1 / 1000) * sampleRate)),
    relCoef: Math.exp(-1 / ((releaseMs / 1000) * sampleRate)),
    env: 1,
  };
}

/**
 * Normalize + limit one segment in place. `chans` is the segment audio,
 * `peek` is up to `look` samples of the NEXT segment (or empty arrays at the
 * end of the file).
 */
function pmLimitSegment(chans, peek, st) {
  const numCh = chans.length;
  const S = chans[0].length;
  const P = peek && peek[0] ? peek[0].length : 0;
  const total = S + P;
  const { thr, normGain, look, attCoef, relCoef } = st;

  // desired gain over segment + peek
  const desired = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    let m = 0;
    for (let c = 0; c < numCh; c++) {
      const src = i < S ? chans[c] : peek[c];
      const a = Math.abs(src[i < S ? i : i - S]) * normGain;
      if (a > m) m = a;
    }
    desired[i] = m > thr ? thr / m : 1;
  }

  // sliding-window min over [j, j+look], then smooth + apply for j in [0, S)
  const dqCap = look + 2;
  const dqIdx = new Int32Array(dqCap);
  const dqVal = new Float32Array(dqCap);
  let head = 0, tail = 0;
  let env = st.env;
  let j = 0;
  const emit = (g) => {
    const target = g;
    const coef = target < env ? attCoef : relCoef;
    env = coef * env + (1 - coef) * target;
    const k = normGain * env;
    for (let c = 0; c < numCh; c++) {
      let s = chans[c][j] * k;
      if (s > thr) s = thr; else if (s < -thr) s = -thr;
      chans[c][j] = s;
    }
    j++;
  };
  for (let i = 0; i < total && j < S; i++) {
    while (tail !== head && dqVal[(tail - 1 + dqCap) % dqCap] >= desired[i]) tail = (tail - 1 + dqCap) % dqCap;
    dqIdx[tail] = i; dqVal[tail] = desired[i]; tail = (tail + 1) % dqCap;
    if (i >= look + j) {
      // window for j is [j, j+look] and i has reached j+look
      while (dqIdx[head] < j) head = (head + 1) % dqCap;
      emit(dqVal[head]);
    }
  }
  // tail of the segment: window shrinks against end of available data
  while (j < S) {
    while (head !== tail && dqIdx[head] < j) head = (head + 1) % dqCap;
    emit(head !== tail ? dqVal[head] : 1);
  }
  st.env = env;
}

/* ---------------- DSP: segmented chamber reverb ---------------- */

/**
 * Fetch and decode the Sprague Hall impulse response AT the target sample
 * rate (decodeAudioData resamples to its context's rate, so we decode through
 * a throwaway OfflineAudioContext at the file's rate to keep the convolution
 * exact). Raw bytes are fetched once and cached; decodes are cached per rate.
 */
let pmIRRawPromise = null;
const pmIRCache = new Map(); // sampleRate -> AudioBuffer
function pmWarmSpragueIR() {
  if (!pmIRRawPromise) {
    pmIRRawPromise = fetch(IR_URL_SPRAGUE).then((r) => {
      if (!r.ok) throw new Error("couldn't download the Sprague impulse response");
      return r.arrayBuffer();
    });
    pmIRRawPromise.catch(() => { pmIRRawPromise = null; });
  }
  return pmIRRawPromise;
}
async function pmGetSpragueIR(sampleRate) {
  if (pmIRCache.has(sampleRate)) return pmIRCache.get(sampleRate);
  const raw = await pmWarmSpragueIR();
  const oc = new OfflineAudioContext(2, 1, sampleRate);
  const buf = await oc.decodeAudioData(raw.slice(0)); // decode detaches, so copy
  pmIRCache.set(sampleRate, buf);
  return buf;
}

/**
 * Convolve one segment with the shared IR at 20% wet (equal-power) via a
 * short OfflineAudioContext render. Returns stereo Float32Arrays of length
 * S + tail; the caller overlap-adds the tail into the next segment.
 * Convolution is linear, so segment-wise processing with tail carry is
 * exactly equivalent to convolving the whole file at once.
 */
async function pmRenderSegmentReverb(chans, sampleRate, ir) {
  const S = chans[0].length;
  const tailLen = ir.length;
  ensureCtx();
  const segBuf = ctx.createBuffer(chans.length, S, sampleRate);
  for (let c = 0; c < chans.length; c++) segBuf.copyToChannel(chans[c], c);

  const offline = new OfflineAudioContext(2, S + tailLen, sampleRate);
  const src = offline.createBufferSource();
  src.buffer = segBuf;

  const f = PM_WET_FRAC;
  const dry = offline.createGain();
  dry.gain.value = Math.cos(f * Math.PI / 2);
  src.connect(dry);
  dry.connect(offline.destination);

  const conv = offline.createConvolver();
  conv.normalize = true;
  conv.buffer = ir;
  const wet = offline.createGain();
  wet.gain.value = Math.sin(f * Math.PI / 2);
  src.connect(conv);
  conv.connect(wet);
  wet.connect(offline.destination);

  src.start(0);
  const rendered = await offline.startRendering();
  return [rendered.getChannelData(0), rendered.getChannelData(1)];
}

/* ---------------- MP3 sinks: WASM worker, lamejs fallback ---------------- */

function pmCreateWorkerSink(sampleRate) {
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker("pm-mp3-worker.js");
    } catch (e) {
      resolve(null);
      return;
    }
    let seq = 0;
    const pending = new Map(); // seq -> resolve
    let doneResolve = null;
    let failed = false;

    const giveUp = () => {
      failed = true;
      try { worker.terminate(); } catch (e) {}
      resolve(null);
    };
    const initTimeout = setTimeout(giveUp, 15000);

    worker.onerror = () => { if (!sinkReady) giveUp(); };
    let sinkReady = false;

    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "ready") {
        sinkReady = true;
        clearTimeout(initTimeout);
        resolve({
          usingWorker: true,
          write(left, right) {
            return new Promise((res, rej) => {
              const s = seq++;
              pending.set(s, { res, rej });
              worker.postMessage(
                { type: "encode", seq: s, left: left.buffer, right: right.buffer },
                [left.buffer, ...(right.buffer !== left.buffer ? [right.buffer] : [])]
              );
            });
          },
          finish() {
            return new Promise((res, rej) => {
              doneResolve = { res, rej };
              worker.postMessage({ type: "finish" });
            });
          },
          abort() { try { worker.terminate(); } catch (e) {} },
        });
      } else if (msg.type === "encoded") {
        const p = pending.get(msg.seq);
        if (p) { pending.delete(msg.seq); p.res(); }
      } else if (msg.type === "done") {
        if (doneResolve) doneResolve.res(new Blob([msg.mp3], { type: "audio/mpeg" }));
        try { worker.terminate(); } catch (e) {}
      } else if (msg.type === "error") {
        clearTimeout(initTimeout);
        const err = new Error(msg.message);
        if (!sinkReady) { giveUp(); return; }
        pending.forEach((p) => p.rej(err));
        pending.clear();
        if (doneResolve) doneResolve.rej(err);
      }
    };

    worker.postMessage({
      type: "init",
      wasmUrl: new URL("mp3.wasm", location.href).href,
      sampleRate,
      channels: 2,
      bitrate: PM_MP3_KBPS,
    });
  });
}

function pmCreateLamejsSink(sampleRate) {
  if (typeof lamejs === "undefined" || !lamejs.Mp3Encoder) return null;
  const encoder = new lamejs.Mp3Encoder(2, sampleRate, PM_MP3_KBPS);
  const chunks = [];
  const block = 1152;
  const l16 = new Int16Array(block);
  const r16 = new Int16Array(block);
  return {
    usingWorker: false,
    async write(left, right) {
      const len = left.length;
      let count = 0;
      for (let i = 0; i < len; i += block) {
        const n = Math.min(block, len - i);
        for (let k = 0; k < n; k++) {
          let s = left[i + k];
          if (s > 1) s = 1; else if (s < -1) s = -1;
          l16[k] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          s = right[i + k];
          if (s > 1) s = 1; else if (s < -1) s = -1;
          r16[k] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        const out = encoder.encodeBuffer(
          n === block ? l16 : l16.subarray(0, n),
          n === block ? r16 : r16.subarray(0, n)
        );
        if (out.length) chunks.push(out);
        if (++count % 400 === 0) await pmYield();
      }
    },
    async finish() {
      const tail = encoder.flush();
      if (tail.length) chunks.push(tail);
      return new Blob(chunks, { type: "audio/mpeg" });
    },
    abort() {},
  };
}

/* ---------------- export pipeline ---------------- */

async function pmRunPipeline(file, onProgress, onStatus) {
  const t0 = performance.now();
  const mark = (label, since) =>
    console.info(`[pre-master] ${label}: ${((performance.now() - since) / 1000).toFixed(1)}s`);

  const source = await pmBuildSource(file, onStatus);
  mark("source ready (" + source.kind + ")", t0);
  if (source.sampleRate > 48000) {
    throw new Error("Sample rates above 48 kHz aren't supported yet — please export at 44.1 or 48 kHz.");
  }
  const sr = source.sampleRate;
  const SEG = Math.round(PM_SEG_SEC * sr);
  const numSegs = Math.max(1, Math.ceil(source.length / SEG));

  // Pass 1 (0-6%): global peak for normalization. For PCM WAVs this scans
  // the integers directly with no float conversion or per-channel copies.
  onStatus("Processing…");
  const tPeak = performance.now();
  let peak = 0;
  for (let s = 0; s < numSegs; s++) {
    if (source.scanPeak) {
      const p = await source.scanPeak(s * SEG, SEG);
      if (p > peak) peak = p;
    } else {
      const chans = await source.readSegment(s * SEG, SEG);
      for (let c = 0; c < chans.length; c++) {
        const d = chans[c];
        for (let i = 0; i < d.length; i++) {
          const a = Math.abs(d[i]);
          if (a > peak) peak = a;
        }
      }
    }
    onProgress(0.06 * ((s + 1) / numSegs));
    await pmYield();
  }
  mark("peak scan", tPeak);
  const normGain = peak > 0 ? 1 / peak : 1;
  // Gain staging: normalize the peak to 0 dBFS, then push PM_LIMITER_DRIVE_DB
  // of gain into the limiter whose ceiling is PM_LIMITER_CEILING_DB — i.e.
  // exactly 3 dB of gain reduction at the loudest peaks, output ceiling 0.
  const staticGain = normGain * Math.pow(10, PM_LIMITER_DRIVE_DB / 20);

  // MP3 sink: WASM worker preferred, lamejs fallback
  let sink = await pmCreateWorkerSink(sr);
  if (!sink) sink = pmCreateLamejsSink(sr);
  if (!sink) throw new Error("no MP3 encoder available");
  console.info("[pre-master] encoder: " + (sink.usingWorker ? "WASM worker" : "main-thread JS fallback"));
  if (!sink.usingWorker) onStatus("Processing… (compatibility encoder — slower)");

  // Pass 2 (6-98%), three overlapping stages:
  //   stage A (sequential): read + limit  (limiter envelope carries in order)
  //   stage B (concurrent): offline reverb renders — each OfflineAudioContext
  //            renders on its own thread, so up to PM_RENDER_AHEAD segments
  //            convolve in parallel while later segments are being read
  //   stage C (worker):     MP3 encode, pipelined behind the renders
  const st = pmLimiterState(sr, PM_LIMITER_CEILING_DB, staticGain);
  const tIR = performance.now();
  const ir = await pmGetSpragueIR(sr);
  mark("Sprague IR ready (" + (ir.duration).toFixed(1) + "s tail)", tIR);
  const tailLen = ir.length;
  let carry = [new Float32Array(tailLen), new Float32Array(tailLen)];
  let pendingWrite = Promise.resolve();

  let nextToStart = 0;
  const renderQ = []; // promises of rendered [L, R], in segment order
  let readLimitMs = 0, renderWaitMs = 0, encodeWaitMs = 0;

  const startNextRender = async () => {
    const s = nextToStart++;
    const start = s * SEG;
    const bodyLen = Math.min(SEG, source.length - start);
    const tA = performance.now();
    // read segment plus a lookahead peek into the next one
    const read = await source.readSegment(start, bodyLen + st.look);
    const chans = read.map((d) => d.subarray(0, bodyLen));
    const peek = read.map((d) => d.subarray(bodyLen));
    pmLimitSegment(chans, peek, st);
    readLimitMs += performance.now() - tA;
    return { bodyLen, rendered: pmRenderSegmentReverb(chans, sr, ir) };
  };

  try {
    // prime the render queue
    while (nextToStart < Math.min(PM_RENDER_AHEAD, numSegs)) {
      renderQ.push(await startNextRender());
    }

    for (let s = 0; s < numSegs; s++) {
      const job = renderQ.shift();
      const tB = performance.now();
      const [rL, rR] = await job.rendered;
      renderWaitMs += performance.now() - tB;
      // top the queue back up so renders keep overlapping
      if (nextToStart < numSegs) renderQ.push(await startNextRender());

      const bodyLen = job.bodyLen;
      // overlap-add the carried tail, then stash the new tail
      const outL = new Float32Array(bodyLen);
      const outR = new Float32Array(bodyLen);
      for (let i = 0; i < bodyLen; i++) {
        let l = rL[i] + (i < tailLen ? carry[0][i] : 0);
        let r = rR[i] + (i < tailLen ? carry[1][i] : 0);
        if (l > 1) l = 1; else if (l < -1) l = -1; // safety clamp at 0 dBFS
        if (r > 1) r = 1; else if (r < -1) r = -1;
        outL[i] = l;
        outR[i] = r;
      }
      const nc = [new Float32Array(tailLen), new Float32Array(tailLen)];
      for (let k = 0; k < tailLen; k++) {
        const idx = bodyLen + k;
        nc[0][k] = rL[idx] + (idx < tailLen ? carry[0][idx] : 0);
        nc[1][k] = rR[idx] + (idx < tailLen ? carry[1][idx] : 0);
      }
      carry = nc;

      const tC = performance.now();
      await pendingWrite;
      encodeWaitMs += performance.now() - tC;
      pendingWrite = sink.write(outL, outR);
      onProgress(0.06 + 0.92 * ((s + 1) / numSegs));
    }

    // final reverb tail
    await pendingWrite;
    await sink.write(carry[0], carry[1]);

    onStatus("Exporting…");
    const blob = await sink.finish();
    onProgress(1);
    console.info(
      `[pre-master] stage time — read+limit: ${(readLimitMs / 1000).toFixed(1)}s, ` +
      `waiting on reverb renders: ${(renderWaitMs / 1000).toFixed(1)}s, ` +
      `waiting on encoder: ${(encodeWaitMs / 1000).toFixed(1)}s`
    );
    mark("total", t0);
    return blob;
  } catch (err) {
    sink.abort();
    throw err;
  }
}

pmExport.addEventListener("click", async () => {
  if (pmExport.disabled || !pmState.file) return;
  stop();
  const prev = pmExport.textContent;
  pmExport.disabled = true;
  pmExport.classList.add("rendering");
  pmExport.textContent = "Processing…";
  pmShowProgress(true);
  pmStartTimer();
  try {
    const blob = await pmRunPipeline(
      pmState.file,
      (p) => pmSetProgress(p),
      (msg) => updatePmUI(msg)
    );
    pmStopTimer();
    const base = (pmState.sourceName || "audio").replace(/[\\\/:*?"<>|]/g, " ").trim();
    triggerDownload(blob, `${base} (Music Mountain Pre-Master).mp3`);
    updatePmUI(`Done in ${pmElapsedTime.textContent} — exported to your downloads.`);
    pmExport.textContent = "Exported ✓";
    setTimeout(() => {
      pmExport.textContent = prev;
      pmShowProgress(false);
      updatePmUI();
    }, 1800);
  } catch (err) {
    pmStopTimer();
    alert("Pre-master failed: " + err.message);
    updatePmUI("Something went wrong — try again.");
    pmExport.textContent = prev;
    pmShowProgress(false);
  } finally {
    pmExport.classList.remove("rendering");
    pmExport.disabled = false;
  }
});

/* =====================================================================
   TOOL SWITCHING (hamburger menu)
===================================================================== */
const hamburgerBtn = document.getElementById("hamburgerBtn");
const menuCloseBtn = document.getElementById("menuCloseBtn");
const menuOverlay = document.getElementById("menuOverlay");
const sideMenu = document.getElementById("sideMenu");
const menuItems = document.querySelectorAll(".menu-item[data-tool]");
const eqTool = document.getElementById("eqTool");
const monoStereoTool = document.getElementById("monoStereoTool");
const reverbTool = document.getElementById("reverbTool");
const toolNameEl = document.getElementById("toolName");
const eqModeToggle = document.getElementById("eqModeToggle");

function openMenu() {
  sideMenu.classList.add("open");
  menuOverlay.classList.add("visible");
  hamburgerBtn.classList.add("open");
  // `inert` hides from AT and removes from tab order — the replacement for
  // aria-hidden when the hidden subtree might contain focused elements.
  sideMenu.removeAttribute("inert");
}
function closeMenu() {
  // Move focus out of the menu BEFORE making it inert so the browser doesn't
  // complain about a focused element in a hidden subtree.
  if (sideMenu.contains(document.activeElement)) {
    document.activeElement.blur();
  }
  sideMenu.classList.remove("open");
  menuOverlay.classList.remove("visible");
  hamburgerBtn.classList.remove("open");
  sideMenu.setAttribute("inert", "");
}
hamburgerBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  sideMenu.classList.contains("open") ? closeMenu() : openMenu();
});
menuCloseBtn.addEventListener("click", closeMenu);
menuOverlay.addEventListener("click", closeMenu);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && sideMenu.classList.contains("open")) closeMenu();
});

menuItems.forEach((item) => {
  item.addEventListener("click", () => {
    const tool = item.dataset.tool;
    setTool(tool);
    closeMenu();
  });
});

function setTool(tool) {
  // Stop any audio when switching tools; the source was connected to the old
  // tool's input node, so starting fresh in the new tool is the cleanest move.
  stop();

  if (tool === "eq") {
    currentTool = "eq";
    eqTool.style.display = "";
    monoStereoTool.style.display = "none";
    if (reverbTool) reverbTool.style.display = "none";
    if (premasterTool) premasterTool.style.display = "none";
    toolNameEl.textContent = "EQ trainer";
    eqModeToggle.style.display = "";
    applyEQ();
  } else if (tool === "monoStereo") {
    currentTool = "monoStereo";
    eqTool.style.display = "none";
    monoStereoTool.style.display = "";
    if (reverbTool) reverbTool.style.display = "none";
    if (premasterTool) premasterTool.style.display = "none";
    toolNameEl.textContent = "Mono / Stereo";
    eqModeToggle.style.display = "none";
    // Park the EQ filter at unity so it doesn't color anything if any stray
    // connection ever reached it.
    if (ctx) filter.gain.setTargetAtTime(0, ctx.currentTime, 0.005);
    // Apply the current mono/stereo routing state.
    setMonoRouting(msState.isMono);
    updateMsUI();
    // Canvas was display:none until now — measure it on the next frame.
    requestAnimationFrame(resizeMsCanvas);
  } else if (tool === "reverb") {
    currentTool = "reverb";
    eqTool.style.display = "none";
    monoStereoTool.style.display = "none";
    if (reverbTool) reverbTool.style.display = "";
    if (premasterTool) premasterTool.style.display = "none";
    toolNameEl.textContent = "Reverb";
    eqModeToggle.style.display = "none";
    // Park the EQ filter at unity — reverb path doesn't go through it.
    if (ctx) filter.gain.setTargetAtTime(0, ctx.currentTime, 0.005);
    // Also reset mono routing in case it was muted when the user left the M/S tool.
    setMonoRouting(false);
    // Make sure the IRs have started loading and refresh UI.
    ensureCtx();
    loadHallIRs()
      .then(() => updateReverbUI())
      .catch((err) => {
        console.warn("IR load failed:", err);
        reverbStatus.textContent = "Couldn't load impulse responses.";
      });
    updateReverbUI();
  } else if (tool === "premaster") {
    currentTool = "premaster";
    eqTool.style.display = "none";
    monoStereoTool.style.display = "none";
    if (reverbTool) reverbTool.style.display = "none";
    if (premasterTool) premasterTool.style.display = "";
    toolNameEl.textContent = "Music Mountain Pre-Master";
    eqModeToggle.style.display = "none";
    pmWarmSpragueIR().catch(() => {}); // warm the IR download in the background
    // Park the EQ filter at unity and reset mono routing — preview here is dry.
    if (ctx) filter.gain.setTargetAtTime(0, ctx.currentTime, 0.005);
    setMonoRouting(false);
    updatePmUI();
  }

  menuItems.forEach((mi) => mi.classList.toggle("active", mi.dataset.tool === tool));
}

/* =====================================================================
   INIT
===================================================================== */
function init() {
  buildSampleList();
  buildQuizButtons();
  buildQuizSources();
  buildMsSources();
  buildReverbSources();
  resizeCanvas();
  resizeMsCanvas();
  updateReadouts();
  drawEQ(sliderToFreq(+freqSlider.value), +gainSlider.value, +qSlider.value);
  updateQuizUI();
  updateMsUI();
  updateReverbUI();
  updatePmUI();
  setTool("premaster");
  requestAnimationFrame(drawStereoViz);
}
init();

// Resume audio on first user gesture (required by browsers)
document.addEventListener("click", function once() {
  ensureCtx();
  if (ctx.state === "suspended") ctx.resume();
  document.removeEventListener("click", once);
});
