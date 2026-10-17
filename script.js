const $ = (id) => document.getElementById(id);

const video = $("video");
const canvas = $("canvas");
const message = $("message");
const cameraSelect = $("cameraSelect");
const shutterBtn = $("shutterBtn");
const gallery = $("gallery");
const preview = $("preview");

const TIMERS = [0, 3, 5, 10];

const state = {
  stream: null,
  deviceId: null,
  facingMode: "user",
  filter: "none",
  mirror: true,
  timerIndex: 0,
  busy: false,
  photos: [], // { url }
  current: null,
};

function showMessage(text) {
  message.textContent = text;
  message.hidden = !text;
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showMessage("Browser ini tidak mendukung akses kamera.");
    shutterBtn.disabled = true;
    return;
  }

  state.stream?.getTracks().forEach((t) => t.stop());
  showMessage("Mengaktifkan kamera…");

  const video_constraints = state.deviceId
    ? { deviceId: { exact: state.deviceId } }
    : { facingMode: state.facingMode };

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { ...video_constraints, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    video.srcObject = state.stream;
    shutterBtn.disabled = false;
    showMessage("");
    await listCameras();
  } catch (err) {
    shutterBtn.disabled = true;
    const reasons = {
      NotAllowedError: "Izin kamera ditolak. Izinkan akses kamera di pengaturan browser lalu muat ulang halaman.",
      NotFoundError: "Tidak ada kamera yang terdeteksi.",
      NotReadableError: "Kamera sedang dipakai aplikasi lain.",
    };
    showMessage(reasons[err.name] || `Gagal membuka kamera: ${err.message}`);
  }
}

async function listCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === "videoinput");
  const activeId = state.stream?.getVideoTracks()[0]?.getSettings().deviceId;

  cameraSelect.innerHTML = "";
  cams.forEach((cam, i) => {
    const opt = document.createElement("option");
    opt.value = cam.deviceId;
    opt.textContent = cam.label || `Kamera ${i + 1}`;
    if (cam.deviceId === activeId) opt.selected = true;
    cameraSelect.append(opt);
  });
  cameraSelect.hidden = cams.length < 2;
  $("switchBtn").hidden = cams.length < 2;
}

function applyFilter() {
  video.style.filter = state.filter;
  video.classList.toggle("mirror", state.mirror);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function countdown(seconds) {
  const el = $("countdown");
  el.hidden = false;
  for (let s = seconds; s > 0; s--) {
    el.textContent = s;
    await wait(1000);
  }
  el.hidden = true;
}

async function takePhoto() {
  if (state.busy || !state.stream) return;
  state.busy = true;
  shutterBtn.disabled = true;

  const seconds = TIMERS[state.timerIndex];
  if (seconds) await countdown(seconds);

  const w = video.videoWidth;
  const h = video.videoHeight;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.filter = state.filter;
  if (state.mirror) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, w, h);
  ctx.restore();

  const flash = $("flash");
  flash.classList.remove("on");
  void flash.offsetWidth;
  flash.classList.add("on");

  canvas.toBlob((blob) => {
    state.photos.unshift({ url: URL.createObjectURL(blob) });
    renderGallery();
    state.busy = false;
    shutterBtn.disabled = false;
  }, "image/jpeg", 0.92);
}

function renderGallery() {
  gallery.innerHTML = "";
  state.photos.forEach((photo) => {
    const img = document.createElement("img");
    img.src = photo.url;
    img.alt = "Foto";
    img.addEventListener("click", () => openPreview(photo));
    gallery.append(img);
  });
  $("count").textContent = `(${state.photos.length})`;
  $("emptyNote").hidden = state.photos.length > 0;
  $("clearBtn").hidden = state.photos.length === 0;
}

function openPreview(photo) {
  state.current = photo;
  $("previewImg").src = photo.url;
  const link = $("downloadLink");
  link.href = photo.url;
  link.download = `foto-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`;
  preview.showModal();
}

function removePhoto(photo) {
  URL.revokeObjectURL(photo.url);
  state.photos = state.photos.filter((p) => p !== photo);
  renderGallery();
}

// --- Events ---
shutterBtn.addEventListener("click", takePhoto);

document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !preview.open) {
    e.preventDefault();
    takePhoto();
  }
});

$("timerBtn").addEventListener("click", () => {
  state.timerIndex = (state.timerIndex + 1) % TIMERS.length;
  const t = TIMERS[state.timerIndex];
  $("timerLabel").textContent = t ? `${t}s` : "Off";
});

$("mirrorBtn").addEventListener("click", (e) => {
  state.mirror = !state.mirror;
  e.currentTarget.classList.toggle("active", state.mirror);
  applyFilter();
});

$("filters").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-filter]");
  if (!btn) return;
  document.querySelectorAll("#filters .chip").forEach((c) => c.classList.remove("active"));
  btn.classList.add("active");
  state.filter = btn.dataset.filter;
  applyFilter();
});

cameraSelect.addEventListener("change", () => {
  state.deviceId = cameraSelect.value;
  startCamera();
});

$("switchBtn").addEventListener("click", () => {
  const opts = [...cameraSelect.options];
  if (opts.length > 1) {
    const next = (cameraSelect.selectedIndex + 1) % opts.length;
    state.deviceId = opts[next].value;
  } else {
    state.deviceId = null;
    state.facingMode = state.facingMode === "user" ? "environment" : "user";
  }
  startCamera();
});

$("clearBtn").addEventListener("click", () => {
  if (!confirm("Hapus semua foto?")) return;
  state.photos.forEach((p) => URL.revokeObjectURL(p.url));
  state.photos = [];
  renderGallery();
});

$("deleteBtn").addEventListener("click", () => {
  if (state.current) removePhoto(state.current);
  preview.close();
});

$("closeBtn").addEventListener("click", () => preview.close());
preview.addEventListener("click", (e) => {
  if (e.target === preview) preview.close();
});

applyFilter();
renderGallery();
startCamera();
