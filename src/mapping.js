import * as THREE from 'three';

// Die 52 ARKit-Namen, die MediaPipe liefert. Hat ein Modell Ausdrücke mit genau
// diesen Namen ("Perfect Sync"), werden sie 1:1 übertragen = maximale Mimik.
export const ARKIT_NAMES = [
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
  'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight',
  'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight', 'eyeSquintLeft', 'eyeSquintRight',
  'eyeWideLeft', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawOpen', 'jawRight',
  'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthFunnel',
  'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthPressLeft', 'mouthPressRight', 'mouthPucker',
  'mouthRight', 'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper', 'mouthSmileLeft',
  'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight', 'mouthUpperUpLeft', 'mouthUpperUpRight',
  'noseSneerLeft', 'noseSneerRight', 'tongueOut',
];

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const remap = (v, lo, hi) => clamp01((v - lo) / (hi - lo));
const avg = (a, b) => (a + b) / 2;

/** Links/Rechts tauschen (für Spiegel-Modus). */
export function swapLR(name) {
  if (name.endsWith('Left')) return name.slice(0, -4) + 'Right';
  if (name.endsWith('Right')) return name.slice(0, -5) + 'Left';
  return name;
}

/**
 * Gemeinsame Zwischenwerte aus normalisierten Kanälen.
 * N(name) liefert 0..1 im persönlichen Bereich (Nutzer-Sicht).
 * Rückgabe in Avatar-Sicht (L/R ggf. gespiegelt).
 */
function features(N, mirror) {
  const side = (n) => N(mirror ? swapLR(n) : n);
  const open = N('mouthGap');
  const smile = avg(N('mouthSmileLeft'), N('mouthSmileRight'));
  // Blinzeln: geometrische Messung pro Auge (unabhängig), Blendshape nur als Stütze
  const blink = (n) => Math.max(side('eyeCloseGeo' + n), side('eyeBlink' + n) * 0.5);
  return {
    blinkL: blink('Left'),
    blinkR: blink('Right'),
    wide: avg(N('eyeWideLeft'), N('eyeWideRight')),
    browDown: avg(N('browDownLeft'), N('browDownRight')),
    browInner: N('browInnerUp'),
    browOuter: avg(N('browOuterUpLeft'), N('browOuterUpRight')),
    open,
    smile,
    frown: Math.max(avg(N('mouthFrownLeft'), N('mouthFrownRight')), N('mouthCornerDown')),
    funnel: N('mouthFunnel'),
    pucker: N('mouthPucker'),
    stretch: avg(N('mouthStretchLeft'), N('mouthStretchRight')),
  };
}

// Blinzeln "einrasten" lassen: halb geschlossen wirkt unruhig
const blinkCurve = (v) => remap(v, 0.35, 0.75);

/**
 * VRoid-Modelle haben einzelne Formen für Brauen (BRW), Augen (EYE) und Mund (MTH).
 * Die steuern wir direkt an, statt der Komplett-Emotionen (ALL_*),
 * die Brauen + Augen + Mund immer gemeinsam verändern.
 */
export function mapVroid(N, mirror) {
  const f = features(N, mirror);
  // Überrascht = Brauen außen hoch; traurig = nur innen hoch
  const surprised = f.browOuter;
  const sorrow = clamp01((f.browInner - f.browOuter) * 1.2);
  return {
    Fcl_BRW_Angry: f.browDown,
    Fcl_BRW_Surprised: surprised * (1 - f.browDown),
    Fcl_BRW_Sorrow: sorrow * (1 - f.browDown),

    Fcl_EYE_Close_L: blinkCurve(f.blinkL),
    Fcl_EYE_Close_R: blinkCurve(f.blinkR),
    Fcl_EYE_Surprised: f.wide * 0.8,

    Fcl_MTH_A: f.open * (1 - f.pucker * 0.6),
    Fcl_MTH_O: f.funnel * remap(f.open, 0.05, 0.4),
    Fcl_MTH_U: f.pucker * (1 - f.open * 0.5),
    Fcl_MTH_E: f.stretch * 0.6,
    Fcl_MTH_I: f.smile * f.open * 0.5,
    Fcl_MTH_Fun: f.smile * (1 - f.open * 0.7),
    // MTH_Angry = nach unten gebogener Mund (Mundwinkel runter), ohne Brauen/Augen
    Fcl_MTH_Angry: f.frown * (1 - f.smile) * (1 - f.open * 0.7),
  };
}

/** Standard-VRM-Ausdrücke (jedes VRM hat diese) – Fallback für andere Modelle. */
export function mapPresets(N, mirror) {
  const f = features(N, mirror);
  return {
    blinkLeft: blinkCurve(f.blinkL),
    blinkRight: blinkCurve(f.blinkR),
    aa: f.open,
    oh: f.funnel * remap(f.open, 0.05, 0.4),
    ou: f.pucker,
    ee: f.stretch * 0.6,
    ih: f.smile * f.open * 0.5,
    happy: f.smile * 0.8,
    sad: f.frown * (1 - f.smile) * 0.6,
    // Komplett-Emotionen ziehen den Mund mit -> nur abgeschwächt
    angry: f.browDown * 0.5 * (1 - f.smile),
    surprised: Math.max(f.browOuter, f.wide) * 0.5,
  };
}

/** Perfect Sync: alle ARKit-Ausdrücke, die das Modell hat, direkt (Rohwerte, normalisiert). */
export function mapPerfectSync(N, mirror, available) {
  const out = {};
  for (const n of ARKIT_NAMES) {
    const src = mirror ? swapLR(n) : n;
    const v = n === 'jawOpen' ? N('mouthGap') : N(src);
    for (const cand of [n, n[0].toUpperCase() + n.slice(1)]) if (available.has(cand)) out[cand] = v;
  }
  return out;
}

export function countPerfectSync(available) {
  let c = 0;
  for (const n of ARKIT_NAMES) if (available.has(n) || available.has(n[0].toUpperCase() + n.slice(1))) c++;
  return c;
}

/** Blickrichtung aus den eyeLook-Blendshapes (Rohwerte), in Grad (Avatar-Sicht). */
export function mapGaze(b, mirror) {
  const g = (n) => b[n] || 0;
  // positiv = der Nutzer schaut zu SEINER linken Seite
  const yawUser = (g('eyeLookOutLeft') + g('eyeLookInRight') - g('eyeLookInLeft') - g('eyeLookOutRight')) / 2;
  const pitch = avg(g('eyeLookUpLeft'), g('eyeLookUpRight')) - avg(g('eyeLookDownLeft'), g('eyeLookDownRight'));
  const yaw = (mirror ? -yawUser : yawUser) * 30;
  return { yaw, pitch: pitch * 25 };
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();

/** Kopf-Matrix -> Euler (pitch, yaw, roll) in Avatar-Sicht. */
export function headEuler(matrix, mirror) {
  _m.fromArray(matrix);
  _m.decompose(_p, _q, _s);
  _e.setFromQuaternion(_q, 'YXZ');
  let { x: pitch, y: yaw, z: roll } = _e;
  if (mirror) { yaw = -yaw; roll = -roll; }
  return { pitch, yaw, roll, pos: _p.clone() };
}
