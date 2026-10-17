const $ = (id) => document.getElementById(id);

const cam = $("cam");
const video = $("video");
const canvas = $("canvas");
const shutterBtn = $("shutterBtn");
const gallery = $("gallery");
const viewer = $("viewer");
const settingsEl = $("settings");
const viewerVideo = $("viewerVideo");

const TIMERS = [0, 3, 10];

// ---------- Pengaturan (disimpan di localStorage) ----------
const SETTINGS_KEY = "kamera-settings";
const DEFAULTS = {
  resolution: 1080,
  ratio: "full",
  quality: 0.95,
  videoSize: 720,
  fps: 30,
  audio: true,
  sound: true,
  vibrate: true,
  autoSave: false,
};

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
}

const settings = loadSettings();

const state = {
  stream: null,
  facingMode: "user",
  deviceId: null,
  filter: "none",
  mirror: true,
  mirrorTouched: false,
  grid: false,
  timerIndex: 0,
  mode: "photo",
  busy: false,
  items: [], // { id, type: "photo"|"video", blob, poster, duration, time, url, posterUrl } — terbaru di depan
  viewIndex: 0,
};

// ---------- Penyimpanan (IndexedDB) supaya foto/video tidak hilang saat refresh ----------
const db = {
  conn: null,
  open() {
    return new Promise((resolve) => {
      if (!window.indexedDB) return resolve(null);
      const req = indexedDB.open("kamera", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("photos", { keyPath: "id" });
      req.onsuccess = () => resolve((this.conn = req.result));
      req.onerror = () => resolve(null);
    });
  },
  tx(mode, fn) {
    if (!this.conn) return Promise.resolve([]);
    return new Promise((resolve) => {
      const store = this.conn.transaction("photos", mode).objectStore("photos");
      const req = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  },
  all() { return this.tx("readonly", (s) => s.getAll()); },
  put(item) {
    const { id, type, blob, poster, duration, time } = item;
    return this.tx("readwrite", (s) => s.put({ id, type, blob, poster, duration, time }));
  },
  remove(id) { return this.tx("readwrite", (s) => s.delete(id)); },
  clear() { return this.tx("readwrite", (s) => s.clear()); },
};

// ---------- Utilitas ----------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const vibrate = (p) => settings.vibrate && navigator.vibrate?.(p);
const toBlob = (c, type, q) => new Promise((r) => c.toBlob(r, type, q));

function formatTime(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function toast(text) {
  const el = $("toast");
  el.hidden = true;
  el.textContent = text;
  void el.offsetWidth;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2200);
}

function showMessage(text, retry = false) {
  $("message").hidden = !text;
  $("messageText").textContent = text;
  $("retryBtn").hidden = !retry;
}

function restartAnim(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

function fileName(item) {
  const d = new Date(item.time);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  if (item.type === "video") return `VID_${stamp}.${item.blob.type.includes("mp4") ? "mp4" : "webm"}`;
  return `IMG_${stamp}.jpg`;
}

// ---------- Suara ----------
let audioCtx;
function playSound(kind) {
  if (!settings.sound) return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const out = audioCtx.createGain();
    out.connect(audioCtx.destination);
    const now = audioCtx.currentTime;
    if (kind === "shutter") {
      const len = Math.floor(audioCtx.sampleRate * 0.09);
      const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      out.gain.value = 0.5;
      src.connect(out);
      src.start();
    } else {
      const osc = audioCtx.createOscillator();
      osc.frequency.value = kind === "start" ? 880 : 660;
      out.gain.setValueAtTime(0.15, now);
      out.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      osc.connect(out);
      osc.start(now);
      osc.stop(now + 0.2);
    }
  } catch {}
}

// ---------- Kamera ----------
async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showMessage("Browser ini tidak mendukung kamera. Buka lewat HTTPS di Chrome atau Safari.");
    return;
  }

  shutterBtn.disabled = true;
  state.stream?.getTracks().forEach((t) => t.stop());

  const constraints = state.deviceId
    ? { deviceId: { exact: state.deviceId } }
    : { facingMode: { ideal: state.facingMode } };
  const res = settings.resolution;
  const videoConstraints = {
    ...constraints,
    width: { ideal: Math.round((res * 16) / 9) },
    height: { ideal: res },
    frameRate: { ideal: settings.fps },
  };
  // Izin mikrofon diminta sekarang (bersama kamera), bukan saat mulai rekam:
  // dialog izin di tengah jalan membuat browser keluar dari layar penuh.
  const wantAudio = settings.audio && !state.micDenied;

  try {
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: wantAudio && { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      if (!wantAudio || !["NotAllowedError", "NotFoundError", "NotReadableError"].includes(err.name)) throw err;
      // Mungkin hanya mikrofon yang bermasalah: coba lagi tanpa suara.
      state.stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
      state.micDenied = true;
      toast("Mikrofon tidak tersedia, video akan direkam tanpa suara");
    }
    video.srcObject = state.stream;
    await video.play().catch(() => {});

    const track = state.stream.getVideoTracks()[0];
    const s = track.getSettings();
    if (s.facingMode) state.facingMode = s.facingMode;
    // Kamera depan dicerminkan seperti aplikasi kamera bawaan, kecuali diatur manual.
    if (!state.mirrorTouched) state.mirror = state.facingMode !== "environment";
    applyView();

    showMessage("");
    shutterBtn.disabled = false;
  } catch (err) {
    const reasons = {
      NotAllowedError: "Akses kamera ditolak. Izinkan kamera di pengaturan browser, lalu coba lagi.",
      NotFoundError: "Tidak ada kamera yang terdeteksi.",
      NotReadableError: "Kamera sedang dipakai aplikasi lain.",
      OverconstrainedError: "Kamera yang dipilih tidak tersedia.",
    };
    if (err.name === "OverconstrainedError" && state.deviceId) {
      state.deviceId = null;
      return startCamera();
    }
    showMessage(reasons[err.name] || `Gagal membuka kamera: ${err.message}`, true);
  }
}

async function switchCamera() {
  restartAnim($("switchBtn"), "spin");

  const before = state.stream?.getVideoTracks()[0]?.getSettings().deviceId;
  state.deviceId = null;
  state.mirrorTouched = false;
  state.facingMode = state.facingMode === "user" ? "environment" : "user";
  await startCamera();

  // Di laptop/desktop facingMode sering diabaikan: putar ke kamera berikutnya.
  const after = state.stream?.getVideoTracks()[0]?.getSettings().deviceId;
  if (before && after === before) {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    if (cams.length > 1) {
      const i = cams.findIndex((c) => c.deviceId === after);
      state.deviceId = cams[(i + 1) % cams.length].deviceId;
      await startCamera();
    } else {
      toast("Hanya ada satu kamera");
    }
  }
}

function applyView() {
  video.style.filter = state.filter;
  video.classList.toggle("mirror", state.mirror);
  $("mirrorBtn").classList.toggle("on", state.mirror);
  $("gridBtn").classList.toggle("on", state.grid);
  $("gridOverlay").hidden = !state.grid;
  cam.classList.toggle("video", state.mode === "video");
  shutterBtn.setAttribute("aria-label", state.mode === "video" ? "Mulai rekam" : "Ambil foto");
}

// ---------- Rasio bingkai ----------
const RATIOS = ["full", "9:16", "3:4", "1:1"];

// Posisi bingkai foto di layar (relatif terhadap .cam), sesuai rasio yang dipilih.
function frameRect() {
  const cw = cam.clientWidth;
  const ch = cam.clientHeight;
  if (settings.ratio === "full") return { x: 0, y: 0, w: cw, h: ch };
  const [a, b] = settings.ratio.split(":").map(Number);
  const r = cw > ch ? b / a : a / b; // lebar/tinggi; dibalik saat landscape
  let w = cw, h = cw / r;
  if (h > ch) { h = ch; w = ch * r; }
  const landscape = cw > ch;
  // Di HP tegak, taruh bingkai sedikit di atas supaya tidak tertutup tombol bawah.
  const top = landscape ? (ch - h) / 2 : Math.min((ch - h) / 2, 72);
  return { x: (cw - w) / 2, y: Math.max(0, top), w, h };
}

function layoutFrame() {
  const f = frameRect();
  Object.assign($("frame").style, { left: `${f.x}px`, top: `${f.y}px`, width: `${f.w}px`, height: `${f.h}px` });
  $("frame").classList.toggle("masked", settings.ratio !== "full");
  $("ratioLabel").textContent = settings.ratio === "full" ? "FULL" : settings.ratio;
}

// Bagian video yang ada di dalam bingkai (video ditampilkan object-fit: cover),
// supaya hasil foto/video sama persis dengan yang terlihat.
function visibleCrop() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const cw = cam.clientWidth;
  const ch = cam.clientHeight;
  const scale = Math.max(cw / vw, ch / vh);
  const ox = (cw - vw * scale) / 2;
  const oy = (ch - vh * scale) / 2;
  const f = frameRect();
  const sw = f.w / scale;
  const sh = f.h / scale;
  let sx = (f.x - ox) / scale;
  const sy = (f.y - oy) / scale;
  if (state.mirror) sx = vw - sx - sw;
  return { sx, sy, sw, sh };
}

function drawFrame(ctx, crop, w, h) {
  ctx.save();
  ctx.filter = state.filter;
  if (state.mirror) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h);
  ctx.restore();
}

async function countdown(seconds) {
  const el = $("countdown");
  el.hidden = false;
  for (let s = seconds; s > 0; s--) {
    el.innerHTML = `<span>${s}</span>`;
    vibrate(15);
    await wait(1000);
  }
  el.hidden = true;
}

// ---------- Foto ----------
async function takePhoto() {
  state.busy = true;
  shutterBtn.classList.add("busy");

  const seconds = TIMERS[state.timerIndex];
  if (seconds) await countdown(seconds);

  const crop = visibleCrop();
  canvas.width = Math.round(crop.sw);
  canvas.height = Math.round(crop.sh);
  drawFrame(canvas.getContext("2d"), crop, canvas.width, canvas.height);

  restartAnim($("flash"), "on");
  playSound("shutter");
  vibrate(30);

  const blob = await toBlob(canvas, "image/jpeg", settings.quality);
  addItem({ type: "photo", blob });

  state.busy = false;
  shutterBtn.classList.remove("busy");
}

// ---------- Video ----------
const rec = { recorder: null, chunks: [], draw: 0, tick: 0, start: 0, poster: null, canvas: document.createElement("canvas") };

function pickMimeType() {
  const types = [
    // H.264 + AAC paling mudah diputar di mana saja (WhatsApp, iPhone, galeri HP).
    "video/mp4;codecs=avc1,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return types.find((t) => MediaRecorder.isTypeSupported?.(t)) || "";
}

async function startRecording() {
  if (!window.MediaRecorder || !rec.canvas.captureStream) {
    toast("Browser ini tidak mendukung rekam video");
    return;
  }
  state.busy = true;
  shutterBtn.classList.add("busy");

  const seconds = TIMERS[state.timerIndex];
  if (seconds) await countdown(seconds);

  // Gambar ulang video ke canvas (dengan filter, cermin, dan potongan layar) lalu rekam canvas-nya.
  const crop = visibleCrop();
  const scale = Math.min(1, settings.videoSize / Math.min(crop.sw, crop.sh));
  const w = (rec.canvas.width = Math.round((crop.sw * scale) / 2) * 2);
  const h = (rec.canvas.height = Math.round((crop.sh * scale) / 2) * 2);
  const ctx = rec.canvas.getContext("2d");
  drawFrame(ctx, crop, w, h);
  rec.draw = setInterval(() => drawFrame(ctx, crop, w, h), 1000 / settings.fps);
  rec.poster = await toBlob(rec.canvas, "image/jpeg", 0.8);

  const stream = rec.canvas.captureStream(settings.fps);
  if (settings.audio) state.stream.getAudioTracks().forEach((t) => stream.addTrack(t));

  const mimeType = pickMimeType();
  try {
    rec.recorder = new MediaRecorder(stream, {
      ...(mimeType && { mimeType }),
      videoBitsPerSecond: settings.videoSize >= 1080 ? 8_000_000 : 4_000_000,
    });
  } catch (err) {
    cleanupRecording();
    toast(`Gagal merekam: ${err.message}`);
    return;
  }
  rec.chunks = [];
  rec.recorder.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data);
  rec.recorder.onstop = finishRecording;
  rec.recorder.start(1000);

  rec.start = Date.now();
  $("recTime").textContent = "00:00";
  rec.tick = setInterval(() => ($("recTime").textContent = formatTime((Date.now() - rec.start) / 1000)), 500);
  cam.classList.add("recording");
  shutterBtn.setAttribute("aria-label", "Berhenti rekam");
  playSound("start");
  vibrate(40);

  state.busy = false;
  shutterBtn.classList.remove("busy");
}

function stopRecording() {
  if (!rec.recorder || rec.recorder.state === "inactive") return;
  rec.recorder.stop();
  clearInterval(rec.tick);
  cam.classList.remove("recording");
  applyView();
  playSound("stop");
  vibrate([30, 60, 30]);
}

function cleanupRecording() {
  clearInterval(rec.draw);
  rec.recorder = null;
  state.busy = false;
  shutterBtn.classList.remove("busy");
}

function finishRecording() {
  const duration = (Date.now() - rec.start) / 1000;
  const type = rec.recorder.mimeType || rec.chunks[0]?.type || "video/webm";
  const blob = new Blob(rec.chunks, { type });
  cleanupRecording();
  if (blob.size) addItem({ type: "video", blob, poster: rec.poster, duration });
}

function onShutter() {
  if (shutterBtn.disabled) return;
  if (rec.recorder) return stopRecording();
  if (state.busy) return;
  if (state.mode === "video") startRecording();
  else takePhoto();
}

function setMode(mode) {
  if (rec.recorder || state.busy) return;
  state.mode = mode;
  document.querySelectorAll(".mode").forEach((m) => m.classList.toggle("active", m.dataset.mode === mode));
  applyView();
}

// ---------- Galeri ----------
function withUrls(item) {
  item.url = URL.createObjectURL(item.blob);
  item.posterUrl = item.poster ? URL.createObjectURL(item.poster) : null;
  return item;
}

function revokeUrls(item) {
  URL.revokeObjectURL(item.url);
  if (item.posterUrl) URL.revokeObjectURL(item.posterUrl);
}

function addItem({ type, blob, poster = null, duration = 0 }) {
  const item = withUrls({ id: crypto.randomUUID?.() || String(Date.now()), type, blob, poster, duration, time: Date.now() });
  state.items.unshift(item);
  db.put(item);
  updateThumb(true);
  if (settings.autoSave) download(item, false);
}

function updateThumb(bump = false) {
  const img = $("thumbImg");
  const latest = state.items[0];
  img.hidden = !latest;
  if (latest) img.src = latest.posterUrl || latest.url;
  if (bump) restartAnim($("thumbBtn"), "bump");
}

function renderGallery() {
  const grid = $("galleryGrid");
  grid.innerHTML = "";
  state.items.forEach((item, i) => {
    const tile = document.createElement("button");
    tile.className = "tile";
    tile.setAttribute("aria-label", item.type === "video" ? "Video" : "Foto");
    const img = document.createElement("img");
    img.src = item.posterUrl || item.url;
    img.alt = "";
    img.loading = "lazy";
    tile.append(img);
    if (item.type === "video") {
      const dur = document.createElement("span");
      dur.className = "dur";
      dur.textContent = formatTime(item.duration);
      tile.append(dur);
    }
    tile.addEventListener("click", () => openViewer(i));
    grid.append(tile);
  });
  const n = state.items.length;
  $("count").textContent = n ? `(${n})` : "";
  grid.hidden = n === 0;
  $("emptyNote").hidden = n > 0;
  $("clearBtn").hidden = n === 0;
}

// ---------- Panel di atas kamera (galeri, penampil, pengaturan) ----------
// Tombol "kembali" di HP menutup panel teratas, bukan keluar dari web.
function openPanel(el) {
  el.hidden = false;
  history.pushState({ panel: el.id }, "");
}

function closePanel(el) {
  if (!el.hidden) history.back();
}

window.addEventListener("popstate", () => {
  const top = [viewer, settingsEl, gallery].find((el) => !el.hidden);
  if (!top) return;
  top.hidden = true;
  if (top === viewer) viewerVideo.pause();
});

function openViewer(index) {
  state.viewIndex = index;
  showItem();
  openPanel(viewer);
}

function showItem() {
  const item = state.items[state.viewIndex];
  if (!item) return closePanel(viewer);
  const isVideo = item.type === "video";
  viewerVideo.pause();
  $("viewerImg").hidden = isVideo;
  viewerVideo.hidden = !isVideo;
  if (isVideo) {
    viewerVideo.poster = item.posterUrl || "";
    viewerVideo.src = item.url;
  } else {
    viewerVideo.removeAttribute("src");
    $("viewerImg").src = item.url;
  }
  $("viewerIndex").textContent = `${state.viewIndex + 1} / ${state.items.length}`;
}

function step(delta) {
  const next = state.viewIndex + delta;
  if (next < 0 || next >= state.items.length) return;
  state.viewIndex = next;
  showItem();
}

async function shareItem() {
  const item = state.items[state.viewIndex];
  const file = new File([item.blob], fileName(item), { type: item.blob.type || "image/jpeg" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (e) {
      if (e.name !== "AbortError") toast("Gagal membagikan");
    }
  } else {
    download(item);
  }
}

function download(item, notify = true) {
  const a = document.createElement("a");
  a.href = item.url;
  a.download = fileName(item);
  a.click();
  if (notify) toast(item.type === "video" ? "Video diunduh" : "Foto diunduh");
}

function deleteItem() {
  const [item] = state.items.splice(state.viewIndex, 1);
  revokeUrls(item);
  db.remove(item.id);
  updateThumb();
  renderGallery();
  toast(item.type === "video" ? "Video dihapus" : "Foto dihapus");
  if (!state.items.length) return closePanel(viewer);
  state.viewIndex = Math.min(state.viewIndex, state.items.length - 1);
  showItem();
}

// Geser kiri/kanan di penampil
let touchX = null;
$("viewerStage").addEventListener("touchstart", (e) => (touchX = e.touches[0].clientX), { passive: true });
$("viewerStage").addEventListener("touchend", (e) => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
});

// ---------- Layar penuh ----------
const root = document.documentElement;
const fullscreenSupported = document.fullscreenEnabled || document.webkitFullscreenEnabled;
const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

// Browser bisa keluar dari layar penuh sendiri (mis. saat muncul dialog izin) dan
// kadang statusnya tertinggal. Karena itu setiap hasil dicek, dan kegagalan selalu
// diberi tahu lewat toast supaya tombol tidak terlihat "mati".
let fullscreenPending = false;

async function toggleFullscreen() {
  const request = root.requestFullscreen || root.webkitRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (!request) return toast("Layar penuh tidak didukung di browser ini");
  if (fullscreenPending) return;
  fullscreenPending = true;

  try {
    if (isFullscreen()) {
      try {
        await exit.call(document);
        return;
      } catch (err) {
        // Status "layar penuh" ternyata basi: lanjut minta layar penuh lagi.
        console.warn("exitFullscreen gagal, mencoba masuk lagi:", err);
      }
    }
    await Promise.race([
      Promise.resolve(request.call(root, { navigationUI: "hide" })),
      wait(2000).then(() => {
        // Chrome kadang "macet" per tab setelah keluar paksa dari layar penuh;
        // refresh tidak cukup, tab harus ditutup lalu dibuka lagi.
        throw new Error("browser tidak merespons. Tutup tab ini lalu buka lagi web-nya");
      }),
    ]);
    if (!isFullscreen()) throw new Error("browser menolak tanpa alasan");
  } catch (err) {
    console.warn("Layar penuh gagal:", err);
    toast(`Layar penuh gagal: ${err.message}`);
  } finally {
    fullscreenPending = false;
    onFullscreenChange();
  }
}

function onFullscreenChange() {
  const on = isFullscreen();
  $("fullscreenIcon").setAttribute("href", on ? "#i-shrink" : "#i-expand");
  $("fullscreenBtn").setAttribute("aria-label", on ? "Keluar layar penuh" : "Layar penuh");
}

$("fullscreenBtn").hidden = !fullscreenSupported;
document.addEventListener("fullscreenchange", onFullscreenChange);
document.addEventListener("webkitfullscreenchange", onFullscreenChange);
document.addEventListener("fullscreenerror", () => toast("Browser menolak layar penuh"));

// ---------- Panel pengaturan ----------
function renderSettings() {
  document.querySelectorAll(".seg").forEach((seg) => {
    const key = seg.dataset.setting;
    seg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.value === String(settings[key])));
  });
  document.querySelectorAll(".switch").forEach((sw) => (sw.checked = !!settings[sw.dataset.setting]));
}

document.querySelectorAll(".seg").forEach((seg) => {
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    setSetting(seg.dataset.setting, btn.dataset.value);
  });
});

function setSetting(key, raw) {
  const value = typeof DEFAULTS[key] === "number" ? Number(raw) : raw;
  if (settings[key] === value) return;
  settings[key] = value;
  saveSettings();
  renderSettings();
  if (key === "ratio") layoutFrame();
  if (key === "resolution" || key === "fps") startCamera();
}

document.querySelectorAll(".switch").forEach((sw) => {
  sw.addEventListener("change", () => {
    const key = sw.dataset.setting;
    settings[key] = sw.checked;
    saveSettings();
    if (key === "audio" && sw.checked) {
      state.micDenied = false;
      startCamera();
    }
  });
});

$("ratioBtn").addEventListener("click", () => {
  if (rec.recorder) return;
  setSetting("ratio", RATIOS[(RATIOS.indexOf(settings.ratio) + 1) % RATIOS.length]);
  toast(settings.ratio === "full" ? "Rasio layar penuh" : `Rasio ${settings.ratio}`);
});

window.addEventListener("resize", layoutFrame);

// ---------- Event ----------
shutterBtn.addEventListener("click", onShutter);
$("switchBtn").addEventListener("click", switchCamera);
$("retryBtn").addEventListener("click", startCamera);
$("fullscreenBtn").addEventListener("click", toggleFullscreen);
$("thumbBtn").addEventListener("click", () => {
  renderGallery();
  openPanel(gallery);
});
$("galleryBack").addEventListener("click", () => closePanel(gallery));
$("emptyBack").addEventListener("click", () => closePanel(gallery));
$("viewerClose").addEventListener("click", () => closePanel(viewer));
$("shareBtn").addEventListener("click", shareItem);
$("downloadBtn").addEventListener("click", () => download(state.items[state.viewIndex]));
$("deleteBtn").addEventListener("click", deleteItem);
$("settingsBtn").addEventListener("click", () => {
  renderSettings();
  openPanel(settingsEl);
});
$("settingsBackdrop").addEventListener("click", () => closePanel(settingsEl));
$("settingsDone").addEventListener("click", () => closePanel(settingsEl));

$("modes").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-mode]");
  if (btn) setMode(btn.dataset.mode);
});

$("timerBtn").addEventListener("click", () => {
  state.timerIndex = (state.timerIndex + 1) % TIMERS.length;
  const t = TIMERS[state.timerIndex];
  $("timerLabel").hidden = !t;
  $("timerLabel").textContent = `${t}s`;
  $("timerBtn").classList.toggle("on", !!t);
  toast(t ? `Timer ${t} detik` : "Timer mati");
});

$("gridBtn").addEventListener("click", () => {
  state.grid = !state.grid;
  applyView();
});

$("mirrorBtn").addEventListener("click", () => {
  state.mirror = !state.mirror;
  state.mirrorTouched = true;
  applyView();
  toast(state.mirror ? "Cermin aktif" : "Cermin mati");
});

$("filters").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-filter]");
  if (!btn) return;
  document.querySelectorAll(".filter").forEach((f) => f.classList.toggle("active", f === btn));
  btn.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  state.filter = btn.dataset.filter;
  applyView();
});

$("clearBtn").addEventListener("click", () => {
  if (!confirm("Hapus semua foto dan video?")) return;
  state.items.forEach(revokeUrls);
  state.items = [];
  db.clear();
  updateThumb();
  renderGallery();
});

document.addEventListener("keydown", (e) => {
  if (!viewer.hidden) {
    if (e.key === "Escape") closePanel(viewer);
    if (e.key === "ArrowRight") step(1);
    if (e.key === "ArrowLeft") step(-1);
  } else if (!settingsEl.hidden) {
    if (e.key === "Escape") closePanel(settingsEl);
  } else if (!gallery.hidden) {
    if (e.key === "Escape") closePanel(gallery);
  } else if (e.code === "Space" || e.key === "Enter") {
    e.preventDefault();
    onShutter();
  } else if (e.key === "f") {
    toggleFullscreen();
  }
});

// Matikan kamera saat pindah aplikasi/tab (hemat baterai), nyalakan lagi saat kembali.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopRecording();
    state.stream?.getTracks().forEach((t) => t.stop());
    state.stream = null;
  } else {
    startCamera();
  }
});

// ---------- Mulai ----------
(async () => {
  applyView();
  layoutFrame();
  await db.open();
  const saved = (await db.all()) || [];
  state.items = saved
    .map((p) => withUrls({ type: "photo", ...p }))
    .sort((a, b) => b.time - a.time);
  updateThumb();
  startCamera();
})();
