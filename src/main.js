import { AvatarStage } from './avatar.js?v=0.6.1';
import { createFaceTracker, createHandTracker, startCamera, parseFaceResult, parseHandResult } from './tracking.js?v=0.6.1';
import { mapVroid, mapPresets, mapPerfectSync, countPerfectSync, mapGaze, headEuler, ARKIT_NAMES } from './mapping.js?v=0.6.1';
import { FilterBank, filterSettings } from './filters.js?v=0.6.1';
import { Calibrator } from './calib.js?v=0.6.1';
import { FaceMeshAvatar } from './facemesh.js?v=0.6.1';
import { HandState, HandMeshes, VrmArms } from './hands.js?v=0.6.1';

export const VERSION = 'v0.6.1';

// Offizielles pixiv-Beispielmodell (Weitergabe/Änderung erlaubt, Credit nicht nötig)
const DEFAULT_VRM =
  'https://cdn.jsdelivr.net/gh/pixiv/three-vrm@3caf7a21ee68f0d5dfa363ab3d577450bbf60136/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm';

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const video = $('cam');
const statusEl = $('status');
const statsEl = $('stats');
const debugEl = $('debug');
$('version').textContent = VERSION; // Versionsnummer nur an einer Stelle pflegen

const state = {
  mirror: true,
  tracker: null,
  delegate: '-',
  lastVideoTime: -1,
  lastFaceAt: 0,
  mode: '-', // VRoid | PerfectSync | Standard
  raw: {}, // geglättete Rohwerte (für Debug)
  showDebug: false,
  handTracker: null,
  handTick: 0,
  handSlow: false,
  lastFace: null,
  lastHandApply: 0,
  stats: { renderFrames: 0, trackFrames: 0, detectMs: 0, handMs: 0, lastStatAt: performance.now() },
};

const UI_KEY = 'avatar-tracker.ui.v1';
let ui = { avatar: 'mesh', meshStyle: 'both', gain: 1.6, hands: true };
try { ui = { ...ui, ...JSON.parse(localStorage.getItem(UI_KEY) || '{}') }; } catch {}
const saveUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch {} };

// Fehler sichtbar machen statt still zu scheitern
window.addEventListener('error', (e) => setStatus('Fehler: ' + (e.message || e.error)));
window.addEventListener('unhandledrejection', (e) => setStatus('Fehler: ' + (e.reason?.message || e.reason)));

const stage = new AvatarStage(canvas);
const faceMesh = new FaceMeshAvatar();
stage.faceMesh = faceMesh;
stage.scene.add(faceMesh.group);
faceMesh.setStyle(ui.meshStyle);
const handState = new HandState();
const handMeshes = new HandMeshes();
faceMesh.group.add(handMeshes.group);
const arms = new VrmArms();
stage.setAvatarMode(ui.avatar);
const filters = new FilterBank(filterSettings);
const calib = new Calibrator();

function setStatus(t) { statusEl.textContent = t; }

async function loadAvatar(url) {
  setStatus(ui.avatar === 'mesh' ? '' : 'Lade VRoid-Modell…');
  try {
    await stage.load(url);
    arms.bind(stage.vrm);
    arms.captureRest();
    const ps = countPerfectSync(stage.expressionNames);
    state.mode = ps >= 20 ? 'PerfectSync' : stage.isVroid ? 'VRoid' : 'Standard';
    if (ui.avatar !== 'mesh') setStatus('VRoid-Modell bereit');
  } catch (err) {
    console.error(err);
    if (ui.avatar !== 'mesh') setStatus('VRoid-Modell konnte nicht laden: ' + err.message);
  }
}

// ---------- Tracking -> Avatar ----------
const CHANNELS = [...ARKIT_NAMES, 'mouthGap', 'eyeCloseGeoLeft', 'eyeCloseGeoRight', 'mouthCornerDown'];

function applyFace(face, tSec) {
  if (ui.avatar === 'mesh') {
    faceMesh.update(face.landmarks, face.width, face.height, state.mirror, tSec);
    return;
  }
  if (!stage.vrm) return;
  const f = (name, v) => filters.filter(name, v, tSec);

  if (face.matrix) {
    const h = headEuler(face.matrix, state.mirror);
    stage.applyHead(f('pitch', h.pitch), f('yaw', h.yaw), f('roll', h.roll));
  }

  // 1) Rohwerte glätten
  const raw = state.raw;
  for (const n of CHANNELS) raw[n] = f('r:' + n, face.blend[n] || 0);
  calib.feed(raw);

  // 2) auf den persönlichen Bereich normalisieren
  const N = (name) => calib.norm(name, raw[name] || 0);

  // 3) auf das Modell übertragen
  if (state.mode === 'PerfectSync') {
    for (const [k, v] of Object.entries(mapPerfectSync(N, state.mirror, stage.expressionNames))) stage.setExpression(k, v);
  } else if (state.mode === 'VRoid') {
    // Mimik-Stärke: VRoid-Formen sind dezent, Werte > 1 übertreiben sie.
    // Augen-Schließen nicht verstärken (sonst Verformung).
    for (const [k, v] of Object.entries(mapVroid(N, state.mirror))) {
      stage.setMorph(k, k.startsWith('Fcl_EYE_Close') ? v : v * ui.gain);
    }
  } else {
    for (const [k, v] of Object.entries(mapPresets(N, state.mirror))) stage.setExpression(k, v);
  }

  const gz = mapGaze(raw, state.mirror);
  stage.setGaze(gz.yaw, gz.pitch);
}

/** Kein Gesicht erkannt: sanft in die Ruhepose zurück. */
function relax() {
  if (!stage.vrm) return;
  const k = 0.9;
  for (const n of ['spine', 'chest', 'neck', 'head']) {
    const b = stage.bone(n);
    if (b) b.rotation.set(b.rotation.x * k, b.rotation.y * k, b.rotation.z * k);
  }
  for (const name of stage.expressionNames) {
    const cur = stage.vrm.expressionManager.getValue(name) || 0;
    stage.vrm.expressionManager.setValue(name, cur * k);
  }
  for (const name of Object.keys(stage.direct || {})) stage.direct[name] *= k;
}

function track() {
  if (!state.tracker || video.readyState < 2) return;
  if (video.currentTime === state.lastVideoTime) return; // kein neues Kamerabild
  state.lastVideoTime = video.currentTime;
  processFrame(video, video.videoWidth, video.videoHeight, performance.now());
}

/** Ein Kamerabild verarbeiten: Gesicht + Hände erkennen und auf den Avatar übertragen. */
function processFrame(src, width, height, now) {
  const t0 = performance.now();
  const res = state.tracker.detectForVideo(src, now);
  const t1 = performance.now();
  state.stats.detectMs = t1 - t0;
  state.stats.trackFrames++;

  let hands = null;
  if (state.handTracker && ui.hands) {
    state.handTick++;
    // Wird es zu langsam, Hände nur jedes 2. Bild erkennen (Glättung überbrückt)
    if (!state.handSlow || state.handTick % 2 === 0) {
      hands = parseHandResult(state.handTracker.detectForVideo(src, now));
      state.stats.handMs = performance.now() - t1;
      state.stats.handCount = hands.length;
      state.handSlow = state.stats.detectMs + state.stats.handMs > 40;
    }
  }

  const tSec = now / 1000;
  const face = parseFaceResult(res, width, height);
  if (face) {
    face.width = width;
    face.height = height;
    state.lastFaceAt = now;
    state.lastFace = face;
    applyFace(face, tSec);
  }
  if (hands) handState.update(hands, tSec, now);
  applyHands(now);
}

function applyHands(now) {
  const dt = state.lastHandApply ? Math.min(0.1, (now - state.lastHandApply) / 1000) : 0.033;
  state.lastHandApply = now;
  if (ui.avatar === 'mesh') {
    handMeshes.update(handState, ui.hands ? faceMesh.xf : null, now);
    stage.fitMesh(handMeshes.points());
  } else if (stage.vrm && arms.vrm) {
    const face = now - state.lastFaceAt < 500 ? state.lastFace : null;
    arms.update(ui.hands ? handState : { visible: () => false }, face, state.mirror, now, dt);
  }
}

// ---------- Kalibrierung ----------
async function calibrate() {
  const msg = $('calib-msg');
  msg.hidden = false;
  if (ui.avatar === 'mesh') {
    msg.textContent = 'Das Mesh-Gesicht braucht keine Kalibrierung – es nutzt deine Gesichtspunkte direkt.';
    setTimeout(() => { msg.hidden = true; }, 3000);
    return;
  }
  msg.textContent = 'Neutral schauen… (entspannt, Mund zu)';
  await calib.start(1500);
  msg.textContent = 'Fertig! Jetzt einmal alles maximal: Brauen hoch/runter, Mund weit auf, breit lächeln.';
  setTimeout(() => { msg.hidden = true; }, 4000);
}

// ---------- Anzeige ----------
const DEBUG_ROWS = [
  ['Braue runter', 'browDownLeft'], ['Braue innen hoch', 'browInnerUp'], ['Braue außen hoch', 'browOuterUpLeft'],
  ['Mund offen', 'mouthGap'], ['jawOpen (alt)', 'jawOpen'], ['Lächeln', 'mouthSmileLeft'],
  ['Mundwinkel runter', 'mouthCornerDown'],
  ['Auge zu L', 'eyeCloseGeoLeft'], ['Auge zu R', 'eyeCloseGeoRight'], ['Augen weit', 'eyeWideLeft'],
];
function bar(v) { const n = Math.round(Math.min(1, Math.max(0, v)) * 10); return '█'.repeat(n) + '·'.repeat(10 - n); }

function updateStats() {
  const s = state.stats;
  const now = performance.now();
  const dt = (now - s.lastStatAt) / 1000;
  if (dt < 0.25) return;
  const faceOk = now - state.lastFaceAt < 300;
  statsEl.textContent =
    `${VERSION} | Render ${(s.renderFrames / dt).toFixed(0)} fps | Track ${(s.trackFrames / dt).toFixed(0)} fps\n` +
    `Gesicht ${s.detectMs.toFixed(0)} ms | Hände ${s.handMs.toFixed(0)} ms${state.handSlow ? ' (½)' : ''} | ${state.delegate}\n` +
    `${ui.avatar === 'mesh' ? 'Mesh-Gesicht' : state.mode} | ${faceOk ? 'Gesicht ✓' : 'kein Gesicht'} | ${state.stats.handCount || 0} Hand/Hände`;
  s.renderFrames = 0; s.trackFrames = 0; s.lastStatAt = now;

  if (state.showDebug) {
    debugEl.textContent = DEBUG_ROWS.map(([label, key]) => {
      const r = state.raw[key] || 0;
      return `${label.padEnd(17)} ${bar(calib.norm(key, r))} roh ${r.toFixed(2)}`;
    }).join('\n');
  }
  if (calib.dirty) calib.save();
}

function loop() {
  requestAnimationFrame(loop);
  if (state.paused) return; // für automatisierte Tests
  try { track(); } catch (err) { console.error(err); }
  if (state.tracker && performance.now() - state.lastFaceAt > 500) relax();
  stage.render();
  state.stats.renderFrames++;
  updateStats();
}

// ---------- UI ----------
$('btn-start').addEventListener('click', async () => {
  $('btn-start').disabled = true;
  try {
    setStatus('Starte Kamera…');
    await startCamera(video);
    setStatus('Lade Gesichts- und Handerkennung… (einmalig ~12 MB)');
    const [faceT, handT] = await Promise.all([
      createFaceTracker(),
      createHandTracker().catch((err) => { console.error(err); return null; }),
    ]);
    state.tracker = faceT.landmarker;
    state.delegate = faceT.delegate;
    state.handTracker = handT ? handT.landmarker : null;
    $('start-overlay').classList.add('hidden');
    setStatus('');
    if (!calib.calibrated && ui.avatar !== 'mesh') setTimeout(calibrate, 800);
  } catch (err) {
    console.error(err);
    $('btn-start').disabled = false;
    setStatus('Fehler: ' + (err.name === 'NotAllowedError' ? 'Kamera-Zugriff verweigert' : err.message));
  }
});

$('btn-menu').addEventListener('click', () => { $('panel').hidden = !$('panel').hidden; });
$('btn-calib').addEventListener('click', () => { $('panel').hidden = true; calibrate(); });
$('opt-avatar').value = ui.avatar;
$('opt-gain').value = ui.gain;
$('opt-gain').addEventListener('input', (e) => { ui.gain = parseFloat(e.target.value); saveUi(); });
$('opt-meshstyle').value = ui.meshStyle;
$('opt-avatar').addEventListener('change', (e) => { ui.avatar = e.target.value; saveUi(); stage.setAvatarMode(ui.avatar); });
$('opt-meshstyle').addEventListener('change', (e) => { ui.meshStyle = e.target.value; saveUi(); faceMesh.setStyle(ui.meshStyle); });
$('opt-hands').checked = ui.hands;
$('opt-hands').addEventListener('change', (e) => { ui.hands = e.target.checked; saveUi(); });
$('opt-mirror').addEventListener('change', (e) => { state.mirror = e.target.checked; });
$('opt-preview').addEventListener('change', (e) => video.classList.toggle('hidden', !e.target.checked));
$('opt-green').addEventListener('change', (e) => stage.setGreenscreen(e.target.checked));
$('opt-debug').addEventListener('change', (e) => { state.showDebug = e.target.checked; debugEl.hidden = !e.target.checked; });
$('opt-smooth').addEventListener('input', (e) => {
  // Regler rechts = mehr Glättung -> kleinere minCutoff
  filterSettings.minCutoff = 5.2 - parseFloat(e.target.value);
});
$('opt-beta').addEventListener('input', (e) => { filterSettings.beta = parseFloat(e.target.value); });
$('opt-vrm').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) loadAvatar(URL.createObjectURL(file));
});

// ---------- Start ----------
filterSettings.minCutoff = 5.2 - parseFloat($('opt-smooth').value);
filterSettings.beta = parseFloat($('opt-beta').value);

const params = new URLSearchParams(location.search);
// Start-Button sofort freigeben: das Mesh-Gesicht braucht kein Modell,
// das VRoid-Modell lädt im Hintergrund weiter.
$('btn-start').disabled = false;
loadAvatar(params.get('vrm') || DEFAULT_VRM);
loop();

// Für Tests/Debugging in der Konsole
window.__avatar = { stage, state, applyFace, processFrame, calib, faceMesh, handState, handMeshes, arms, ui };
