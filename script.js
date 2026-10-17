const $ = (id) => document.getElementById(id);

const cam = $("cam");
const video = $("video");
const canvas = $("canvas");
const shutterBtn = $("shutterBtn");
const gallery = $("gallery");
const viewer = $("viewer");

const TIMERS = [0, 3, 10];

const state = {
  stream: null,
  facingMode: "user",
  deviceId: null,
  filter: "none",
  mirror: true,
  mirrorTouched: false,
  grid: false,
  timerIndex: 0,
  busy: false,
  photos: [], // { id, blob, url, time } — terbaru di depan
  viewIndex: 0,
};

// ---------- Penyimpanan (IndexedDB) supaya foto tidak hilang saat refresh ----------
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
  put(p) { return this.tx("readwrite", (s) => s.put({ id: p.id, blob: p.blob, time: p.time })); },
  remove(id) { return this.tx("readwrite", (s) => s.delete(id)); },
  clear() { return this.tx("readwrite", (s) => s.clear()); },
};

// ---------- Utilitas ----------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const vibrate = (p) => navigator.vibrate?.(p);

function toast(text) {
  const el = $("toast");
  el.hidden = true;
  el.textContent = text;
  void el.offsetWidth;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 1600);
}

function showMessage(text, retry = false) {
  $("message").hidden = !text;
  $("messageText").textContent = text;
  $("retryBtn").hidden = !retry;
}

function fileName(photo) {
  const d = new Date(photo.time);
  const pad = (n) => String(n).padStart(2, "0");
  return `IMG_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jpg`;
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

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { ...constraints, width: { ideal: 1920 }, height: { ideal: 1920 } },
      audio: false,
    });
    video.srcObject = state.stream;
    await video.play().catch(() => {});

    const settings = state.stream.getVideoTracks()[0].getSettings();
    if (settings.facingMode) state.facingMode = settings.facingMode;
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
  const btn = $("switchBtn");
  btn.classList.remove("spin");
  void btn.offsetWidth;
  btn.classList.add("spin");

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
}

// ---------- Memotret ----------
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

async function takePhoto() {
  if (state.busy || shutterBtn.disabled) return;
  state.busy = true;
  shutterBtn.classList.add("busy");

  const seconds = TIMERS[state.timerIndex];
  if (seconds) await countdown(seconds);

  // Potong sesuai area yang terlihat di layar (object-fit: cover).
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const viewRatio = cam.clientWidth / cam.clientHeight;
  let sw = vw, sh = vh;
  if (vw / vh > viewRatio) sw = vh * viewRatio;
  else sh = vw / viewRatio;
  const sx = (vw - sw) / 2;
  const sy = (vh - sh) / 2;

  canvas.width = Math.round(sw);
  canvas.height = Math.round(sh);
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.filter = state.filter;
  if (state.mirror) {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  ctx.restore();

  const flash = $("flash");
  flash.classList.remove("on");
  void flash.offsetWidth;
  flash.classList.add("on");
  vibrate(30);

  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.92));
  const photo = { id: crypto.randomUUID?.() || String(Date.now()), blob, time: Date.now() };
  photo.url = URL.createObjectURL(blob);
  state.photos.unshift(photo);
  db.put(photo);

  updateThumb(true);
  state.busy = false;
  shutterBtn.classList.remove("busy");
}

// ---------- Galeri ----------
function updateThumb(bump = false) {
  const img = $("thumbImg");
  const latest = state.photos[0];
  img.hidden = !latest;
  if (latest) img.src = latest.url;
  if (bump) {
    const btn = $("thumbBtn");
    btn.classList.remove("bump");
    void btn.offsetWidth;
    btn.classList.add("bump");
  }
}

function renderGallery() {
  const grid = $("galleryGrid");
  grid.innerHTML = "";
  state.photos.forEach((photo, i) => {
    const img = document.createElement("img");
    img.src = photo.url;
    img.alt = "";
    img.loading = "lazy";
    img.addEventListener("click", () => openViewer(i));
    grid.append(img);
  });
  $("count").textContent = state.photos.length ? `(${state.photos.length})` : "";
  $("emptyNote").hidden = state.photos.length > 0;
  $("clearBtn").hidden = state.photos.length === 0;
}

function openGallery() {
  renderGallery();
  gallery.hidden = false;
  history.pushState({ view: "gallery" }, "");
}

function openViewer(index) {
  state.viewIndex = index;
  showPhoto();
  viewer.hidden = false;
  history.pushState({ view: "viewer" }, "");
}

function showPhoto() {
  const photo = state.photos[state.viewIndex];
  if (!photo) return closeViewer();
  $("viewerImg").src = photo.url;
  $("viewerIndex").textContent = `${state.viewIndex + 1} / ${state.photos.length}`;
}

function closeViewer() {
  if (!viewer.hidden) history.back();
}

async function sharePhoto() {
  const photo = state.photos[state.viewIndex];
  const file = new File([photo.blob], fileName(photo), { type: "image/jpeg" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (e) {
      if (e.name !== "AbortError") toast("Gagal membagikan");
    }
  } else {
    downloadPhoto();
  }
}

function downloadPhoto() {
  const photo = state.photos[state.viewIndex];
  const a = document.createElement("a");
  a.href = photo.url;
  a.download = fileName(photo);
  a.click();
  toast("Foto diunduh");
}

function deletePhoto() {
  const [photo] = state.photos.splice(state.viewIndex, 1);
  URL.revokeObjectURL(photo.url);
  db.remove(photo.id);
  updateThumb();
  renderGallery();
  toast("Foto dihapus");
  if (!state.photos.length) return closeViewer();
  state.viewIndex = Math.min(state.viewIndex, state.photos.length - 1);
  showPhoto();
}

// Geser kiri/kanan di penampil foto
let touchX = null;
$("viewerImg").addEventListener("touchstart", (e) => (touchX = e.touches[0].clientX), { passive: true });
$("viewerImg").addEventListener("touchend", (e) => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (Math.abs(dx) < 50) return;
  const next = state.viewIndex + (dx < 0 ? 1 : -1);
  if (next >= 0 && next < state.photos.length) {
    state.viewIndex = next;
    showPhoto();
  }
});

// Tombol "kembali" di HP menutup penampil/galeri, bukan keluar dari web.
window.addEventListener("popstate", () => {
  if (!viewer.hidden) viewer.hidden = true;
  else if (!gallery.hidden) gallery.hidden = true;
});

// ---------- Event ----------
shutterBtn.addEventListener("click", takePhoto);
$("switchBtn").addEventListener("click", switchCamera);
$("retryBtn").addEventListener("click", startCamera);
$("thumbBtn").addEventListener("click", openGallery);
$("galleryBack").addEventListener("click", () => history.back());
$("viewerClose").addEventListener("click", closeViewer);
$("shareBtn").addEventListener("click", sharePhoto);
$("downloadBtn").addEventListener("click", downloadPhoto);
$("deleteBtn").addEventListener("click", deletePhoto);

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
  if (!confirm("Hapus semua foto?")) return;
  state.photos.forEach((p) => URL.revokeObjectURL(p.url));
  state.photos = [];
  db.clear();
  updateThumb();
  renderGallery();
});

document.addEventListener("keydown", (e) => {
  if (!viewer.hidden) {
    if (e.key === "Escape") closeViewer();
    if (e.key === "ArrowRight" && state.viewIndex < state.photos.length - 1) { state.viewIndex++; showPhoto(); }
    if (e.key === "ArrowLeft" && state.viewIndex > 0) { state.viewIndex--; showPhoto(); }
  } else if (!gallery.hidden) {
    if (e.key === "Escape") history.back();
  } else if (e.code === "Space" || e.key === "Enter") {
    e.preventDefault();
    takePhoto();
  }
});

// Matikan kamera saat tab disembunyikan (hemat baterai), nyalakan lagi saat kembali.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    state.stream?.getTracks().forEach((t) => t.stop());
    state.stream = null;
  } else {
    startCamera();
  }
});

// ---------- Mulai ----------
(async () => {
  applyView();
  await db.open();
  const saved = (await db.all()) || [];
  state.photos = saved
    .sort((a, b) => b.time - a.time)
    .map((p) => ({ ...p, url: URL.createObjectURL(p.blob) }));
  updateThumb();
  startCamera();
})();
