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
function swapLR(name) {
  if (name.endsWith('Left')) return name.slice(0, -4) + 'Right';
  if (name.endsWith('Right')) return name.slice(0, -5) + 'Left';
  return name;
}
// jawLeft/mouthLeft beschreiben eine Richtung -> beim Spiegeln ebenfalls tauschen (passt mit swapLR)

/**
 * Blendshapes (Nutzer-Sicht) -> Avatar-Ausdrücke.
 * Gibt {name: value} zurück, bereits gespiegelt falls gewünscht.
 */
export function mapExpressions(b, mirror, availableNames) {
  const g = (n) => b[n] || 0;
  // In Avatar-Sicht umbenennen: im Spiegel ist mein linkes Auge das rechte des Avatars
  const side = (n) => (mirror ? g(swapLR(n)) : g(n));

  const out = {};

  // 1) Perfect Sync: alle ARKit-Ausdrücke, die das Modell hat, direkt setzen
  let perfectSync = 0;
  for (const n of ARKIT_NAMES) {
    for (const cand of [n, n[0].toUpperCase() + n.slice(1)]) {
      if (availableNames.has(cand)) { out[cand] = side(n); perfectSync++; }
    }
  }

  // 2) Standard-VRM-Ausdrücke (jedes VRM hat diese) als Näherung
  if (perfectSync < 20) {
    out.blinkLeft = remap(side('eyeBlinkLeft'), 0.3, 0.6);
    out.blinkRight = remap(side('eyeBlinkRight'), 0.3, 0.6);

    const jaw = g('jawOpen');
    const funnel = g('mouthFunnel');
    const pucker = g('mouthPucker');
    const smile = avg(g('mouthSmileLeft'), g('mouthSmileRight'));
    const stretch = avg(g('mouthStretchLeft'), g('mouthStretchRight'));

    out.aa = remap(jaw, 0.04, 0.55);
    out.oh = remap(funnel, 0.1, 0.5) * remap(jaw, 0.02, 0.2);
    out.ou = remap(pucker, 0.2, 0.7);
    out.ee = remap(stretch + smile * 0.3, 0.1, 0.5) * 0.7;
    out.ih = remap(jaw, 0.02, 0.15) * remap(smile, 0.1, 0.5) * 0.5;

    out.happy = remap(smile, 0.25, 0.75);
    out.angry = remap(avg(g('browDownLeft'), g('browDownRight')), 0.25, 0.7) * (1 - out.happy);
    out.sad = remap(avg(g('mouthFrownLeft'), g('mouthFrownRight')), 0.1, 0.45) * (1 - out.happy);
    out.surprised = remap(g('browInnerUp') * 0.5 + avg(g('eyeWideLeft'), g('eyeWideRight')) * 0.5, 0.25, 0.6);
  }
  return { values: out, perfectSync: perfectSync >= 20 };
}

/** Blickrichtung aus den eyeLook-Blendshapes, in Grad (Avatar-Sicht). */
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
