import { AvatarStage } from './avatar.js';
import { createFaceTracker, startCamera, parseFaceResult } from './tracking.js';
import { mapExpressions, mapGaze, headEuler } from './mapping.js';
import { FilterBank, filterSettings } from './filters.js';

// Offizielles pixiv-Beispielmodell (Weitergabe/Änderung erlaubt, Credit nicht nötig)
const DEFAULT_VRM =
  'https://cdn.jsdelivr.net/gh/pixiv/three-vrm@3caf7a21ee68f0d5dfa363ab3d577450bbf60136/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm';

export const VERSION = 'v0.1.0';

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const video = $('cam');
const statusEl = $('status');
const statsEl = $('stats');

const state = {
  mirror: true,
  tracker: null,
  delegate: '-',
  lastVideoTime: -1,
  lastFaceAt: 0,
  face: null, // letztes geparstes Ergebnis
  perfectSync: false,
  stats: { renderFrames: 0, trackFrames: 0, detectMs: 0, lastStatAt: performance.now() },
};

const stage = new AvatarStage(canvas);
const filters = new FilterBank(filterSettings);

function setStatus(t) { statusEl.textContent = t; }

async function loadAvatar(url) {
  setStatus('Lade Avatar…');
  try {
    await stage.load(url);
    setStatus('Avatar bereit');
  } catch (err) {
    console.error(err);
    setStatus('Avatar-Fehler: ' + err.message);
  }
}

// ---------- Tracking -> Avatar ----------
function applyFace(face, tSec) {
  if (!stage.vrm) return;
  const f = (name, v) => filters.filter(name, v, tSec);

  if (face.matrix) {
    const h = headEuler(face.matrix, state.mirror);
    stage.applyHead(f('pitch', h.pitch), f('yaw', h.yaw), f('roll', h.roll));
  }

  const { values, perfectSync } = mapExpressions(face.blend, state.mirror, stage.expressionNames);
  state.perfectSync = perfectSync;
  for (const [name, v] of Object.entries(values)) stage.setExpression(name, f('x:' + name, v));

  const gz = mapGaze(face.blend, state.mirror);
  stage.setGaze(f('gazeYaw', gz.yaw), f('gazePitch', gz.pitch));
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
}

function track() {
  if (!state.tracker || video.readyState < 2) return;
  if (video.currentTime === state.lastVideoTime) return; // kein neues Kamerabild
  state.lastVideoTime = video.currentTime;

  const now = performance.now();
  const res = state.tracker.detectForVideo(video, now);
  state.stats.detectMs = performance.now() - now;
  state.stats.trackFrames++;

  const face = parseFaceResult(res);
  if (face) {
    state.face = face;
    state.lastFaceAt = now;
    applyFace(face, now / 1000);
  }
}

function updateStats() {
  const s = state.stats;
  const now = performance.now();
  const dt = (now - s.lastStatAt) / 1000;
  if (dt < 0.5) return;
  const faceOk = now - state.lastFaceAt < 300;
  statsEl.textContent =
    `${VERSION} | Render ${(s.renderFrames / dt).toFixed(0)} fps | Track ${(s.trackFrames / dt).toFixed(0)} fps\n` +
    `Erkennung ${s.detectMs.toFixed(1)} ms | ${state.delegate} | ${faceOk ? 'Gesicht ✓' : 'kein Gesicht'}` +
    (state.perfectSync ? ' | PerfectSync' : '');
  s.renderFrames = 0; s.trackFrames = 0; s.lastStatAt = now;
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
  } catch (err) {
    console.error(err);
    $('btn-start').disabled = false;
    setStatus('Fehler: ' + (err.name === 'NotAllowedError' ? 'Kamera-Zugriff verweigert' : err.message));
  }
});

$('btn-menu').addEventListener('click', () => { $('panel').hidden = !$('panel').hidden; });
$('opt-mirror').addEventListener('change', (e) => { state.mirror = e.target.checked; });
$('opt-preview').addEventListener('change', (e) => video.classList.toggle('hidden', !e.target.checked));
$('opt-green').addEventListener('change', (e) => stage.setGreenscreen(e.target.checked));
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
window.__avatar = { stage, state, applyFace };
