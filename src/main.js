import { AvatarStage } from './avatar.js?v=0.4.1';
import { createFaceTracker, startCamera, parseFaceResult } from './tracking.js?v=0.4.1';
import { mapVroid, mapPresets, mapPerfectSync, countPerfectSync, mapGaze, headEuler, ARKIT_NAMES } from './mapping.js?v=0.4.1';
import { FilterBank, filterSettings } from './filters.js?v=0.4.1';
import { Calibrator } from './calib.js?v=0.4.1';
import { FaceMeshAvatar } from './facemesh.js?v=0.4.1';

export const VERSION = 'v0.4.1';

// Offizielles pixiv-Beispielmodell (Weitergabe/Änderung erlaubt, Credit nicht nötig)
const DEFAULT_VRM =
  'https://cdn.jsdelivr.net/gh/pixiv/three-vrm@3caf7a21ee68f0d5dfa363ab3d577450bbf60136/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm';

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const video = $('cam');
const statusEl = $('status');
const statsEl = $('stats');
const debugEl = $('debug');

const state = {
  mirror: true,
  tracker: null,
  delegate: '-',
  lastVideoTime: -1,
  lastFaceAt: 0,
  mode: '-', // VRoid | PerfectSync | Standard
  raw: {}, // geglättete Rohwerte (für Debug)
  showDebug: false,
  stats: { renderFrames: 0, trackFrames: 0, detectMs: 0, lastStatAt: performance.now() },
};

const UI_KEY = 'avatar-tracker.ui.v1';
let ui = { avatar: 'mesh', meshStyle: 'both' };
try { ui = { ...ui, ...JSON.parse(localStorage.getItem(UI_KEY) || '{}') }; } catch {}
const saveUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch {} };

const stage = new AvatarStage(canvas);
const faceMesh = new FaceMeshAvatar();
stage.faceMesh = faceMesh;
stage.scene.add(faceMesh.group);
faceMesh.setStyle(ui.meshStyle);
stage.setAvatarMode(ui.avatar);
const filters = new FilterBank(filterSettings);
const calib = new Calibrator();

function setStatus(t) { statusEl.textContent = t; }

async function loadAvatar(url) {
  setStatus('Lade Avatar…');
  try {
    await stage.load(url);
    const ps = countPerfectSync(stage.expressionNames);
    state.mode = ps >= 20 ? 'PerfectSync' : stage.isVroid ? 'VRoid' : 'Standard';
    setStatus('Avatar bereit');
  } catch (err) {
    console.error(err);
    setStatus('Avatar-Fehler: ' + err.message);
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
    for (const [k, v] of Object.entries(mapVroid(N, state.mirror))) stage.setMorph(k, v);
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

  const now = performance.now();
  const res = state.tracker.detectForVideo(video, now);
  state.stats.detectMs = performance.now() - now;
  state.stats.trackFrames++;

  const face = parseFaceResult(res, video.videoWidth, video.videoHeight);
  if (face) {
    face.width = video.videoWidth;
    face.height = video.videoHeight;
    state.lastFaceAt = now;
    applyFace(face, now / 1000);
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
    `Erkennung ${s.detectMs.toFixed(1)} ms | ${state.delegate} | ${ui.avatar === 'mesh' ? 'Mesh-Gesicht' : state.mode} | ${faceOk ? 'Gesicht ✓' : 'kein Gesicht'}`;
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
    setStatus('Lade Gesichtserkennung… (einmalig ~4 MB)');
    const { landmarker, delegate } = await createFaceTracker();
    state.tracker = landmarker;
    state.delegate = delegate;
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
$('opt-meshstyle').value = ui.meshStyle;
$('opt-avatar').addEventListener('change', (e) => { ui.avatar = e.target.value; saveUi(); stage.setAvatarMode(ui.avatar); });
$('opt-meshstyle').addEventListener('change', (e) => { ui.meshStyle = e.target.value; saveUi(); faceMesh.setStyle(ui.meshStyle); });
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
loadAvatar(params.get('vrm') || DEFAULT_VRM).then(() => { $('btn-start').disabled = false; });
loop();

// Für Tests/Debugging in der Konsole
window.__avatar = { stage, state, applyFace, calib, faceMesh, ui };
