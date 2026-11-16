import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { OneEuro, filterSettings } from './filters.js?v=0.6.0';

// MediaPipe-Hand: 21 Punkte. 0 = Handgelenk, je Finger 4 Punkte (Grundgelenk -> Spitze).
export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], // Daumen
  [0, 5], [5, 6], [6, 7], [7, 8], // Zeigefinger
  [5, 9], [9, 10], [10, 11], [11, 12], // Mittelfinger
  [9, 13], [13, 14], [14, 15], [15, 16], // Ringfinger
  [13, 17], [17, 18], [18, 19], [19, 20], // kleiner Finger
  [0, 17], // Handballen
];
const FINGERS = { Thumb: [1, 2, 3, 4], Index: [5, 6, 7, 8], Middle: [9, 10, 11, 12], Ring: [13, 14, 15, 16], Little: [17, 18, 19, 20] };

const HIDE_AFTER_MS = 300;

/** Geglättete Hand-Daten je Seite (Nutzer-Hand: 'Left' / 'Right'). */
export class HandState {
  constructor() {
    this.slots = {};
  }

  /** hands: Ergebnis von parseHandResult. Glättet Bild- und Weltkoordinaten. */
  update(hands, tSec, nowMs) {
    const seen = new Set();
    for (const h of hands) {
      if (seen.has(h.side)) continue; // doppelte Seite (selten): erste nehmen
      seen.add(h.side);
      let s = this.slots[h.side];
      if (!s) {
        s = this.slots[h.side] = {
          lm: Array.from({ length: 21 }, () => new THREE.Vector3()),
          world: Array.from({ length: 21 }, () => new THREE.Vector3()),
          f: Array.from({ length: 21 * 6 }, () => new OneEuro(filterSettings)),
          lastSeen: 0,
        };
      }
      if (nowMs - s.lastSeen > HIDE_AFTER_MS) s.f.forEach((f) => { f.x = null; }); // nach Pause nicht "einschweben"
      for (let i = 0; i < 21; i++) {
        const q = h.lm[i], w = h.world ? h.world[i] : q;
        const k = i * 6;
        s.lm[i].set(s.f[k].filter(q.x, tSec), s.f[k + 1].filter(q.y, tSec), s.f[k + 2].filter(q.z, tSec));
        s.world[i].set(s.f[k + 3].filter(w.x, tSec), s.f[k + 4].filter(w.y, tSec), s.f[k + 5].filter(w.z, tSec));
      }
      s.lastSeen = nowMs;
    }
  }

  visible(side, nowMs) {
    const s = this.slots[side];
    return !!s && nowMs - s.lastSeen < HIDE_AFTER_MS;
  }
}

// ---------------------------------------------------------------------------
// Mesh-Hände: Knochen als dicke Linien + Gelenkpunkte (passend zum Mesh-Gesicht)
// ---------------------------------------------------------------------------
export class HandMeshes {
  constructor() {
    this.group = new THREE.Group();
    this.hands = {};
    for (const side of ['Left', 'Right']) {
      const pos = new Float32Array(HAND_CONNECTIONS.length * 2 * 3);
      const geo = new LineSegmentsGeometry();
      geo.setPositions(pos);
      const mat = new LineMaterial({ color: 0x6cf0ff, linewidth: 3, transparent: true });
      const lines = new LineSegments2(geo, mat);
      lines.frustumCulled = false;
      const joints = new THREE.InstancedMesh(
        new THREE.SphereGeometry(1, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
        21,
      );
      joints.frustumCulled = false;
      const g = new THREE.Group();
      g.add(lines, joints);
      g.visible = false;
      this.group.add(g);
      this.hands[side] = { g, geo, pos, joints, pts: Array.from({ length: 21 }, () => new THREE.Vector3()) };
    }
    this._m = new THREE.Matrix4();
  }

  /**
   * Bildkoordinaten -> Weltkoordinaten mit derselben Transformation wie das Mesh-Gesicht,
   * damit Hände und Gesicht zueinander passen.
   */
  update(handState, xf, nowMs) {
    for (const side of ['Left', 'Right']) {
      const h = this.hands[side];
      const vis = !!xf && handState.visible(side, nowMs);
      h.g.visible = vis;
      if (!vis) continue;
      const s = handState.slots[side];
      for (let i = 0; i < 21; i++) {
        const q = s.lm[i];
        h.pts[i].set(
          (q.x - xf.cx) * xf.sx * xf.s,
          -(q.y - xf.cy) * xf.height * xf.s,
          -q.z * xf.width * xf.s + 0.03, // etwas vor der Gesichtsebene
        );
      }
      HAND_CONNECTIONS.forEach(([a, b], j) => {
        h.pos.set([h.pts[a].x, h.pts[a].y, h.pts[a].z, h.pts[b].x, h.pts[b].y, h.pts[b].z], j * 6);
      });
      h.geo.setPositions(h.pos);
      const r = 0.0035;
      for (let i = 0; i < 21; i++) {
        this._m.makeScale(r, r, r).setPosition(h.pts[i]);
        h.joints.setMatrixAt(i, this._m);
      }
      h.joints.instanceMatrix.needsUpdate = true;
    }
  }

  /** Alle sichtbaren Punkte (für den Auto-Zoom). */
  *points() {
    for (const h of Object.values(this.hands)) if (h.g.visible) yield* h.pts;
  }
}

// ---------------------------------------------------------------------------
// VRM: Arme per 2-Knochen-IK, Handgelenk-Ausrichtung und Fingerbeugung
// ---------------------------------------------------------------------------
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4();

export class VrmArms {
  constructor() {
    this.weights = { left: 0, right: 0 }; // 0 = Ruhepose, 1 = Tracking (weiches Ein-/Ausblenden)
  }

  /** Bone-Längen und Ruhe-Richtungen aus dem geladenen Modell lesen. */
  bind(vrm) {
    this.vrm = vrm;
    const h = vrm.humanoid;
    const get = (n) => h.getNormalizedBoneNode(n);
    vrm.scene.updateMatrixWorld(true);
    this.arm = {};
    for (const side of ['left', 'right']) {
      const up = get(side + 'UpperArm'), low = get(side + 'LowerArm'), hand = get(side + 'Hand');
      if (!up || !low || !hand) continue;
      // Längen aus Ruhepose (Rotation der Knochen ist zu diesem Zeitpunkt egal: Längen bleiben gleich)
      const L1 = low.position.length(), L2 = hand.position.length();
      this.arm[side] = { up, low, hand, L1, L2, sign: side === 'left' ? 1 : -1, rest: { up: up.quaternion.clone(), low: low.quaternion.clone() } };
    }
    this.fingers = {};
    for (const side of ['left', 'right']) {
      this.fingers[side] = {};
      for (const f of Object.keys(FINGERS)) {
        this.fingers[side][f] = ['Proximal', 'Intermediate', 'Distal']
          .map((j) => get(side + f + (f === 'Thumb' ? { Proximal: 'Metacarpal', Intermediate: 'Proximal', Distal: 'Distal' }[j] : j)))
          .filter(Boolean);
      }
    }
    const head = get('head');
    this.headPos = new THREE.Vector3();
    head.getWorldPosition(this.headPos);
  }

  /** Ruhe-Quaternionen merken, nachdem restPose() gesetzt wurde. */
  captureRest() {
    for (const a of Object.values(this.arm || {})) {
      a.rest = { up: a.up.quaternion.clone(), low: a.low.quaternion.clone(), hand: a.hand.quaternion.clone() };
    }
  }

  /**
   * face: { lm (478 Punkte), width, height } – Bezugsgröße/Position.
   * handState: geglättete Hände. mirror: Spiegelmodus.
   */
  update(handState, face, mirror, nowMs, dt) {
    if (!this.vrm || !this.arm) return;
    const ref = face ? this.faceRef(face) : this.lastRef;
    if (face) this.lastRef = ref;

    for (const userSide of ['Left', 'Right']) {
      // Spiegel: rechte Hand des Nutzers = linker Arm des Avatars
      const avSide = (userSide === 'Right') === mirror ? 'left' : 'right';
      const a = this.arm[avSide];
      if (!a) continue;
      const vis = !!ref && handState.visible(userSide, nowMs);
      const target = vis ? 1 : 0;
      this.weights[avSide] += (target - this.weights[avSide]) * Math.min(1, dt * 8);
      const w = this.weights[avSide];

      if (vis) {
        this.solveArm(a, handState.slots[userSide], ref, mirror, userSide);
        a.up.quaternion.slerpQuaternions(a.rest.up, a.ikUp, w);
        a.low.quaternion.slerpQuaternions(a.rest.low, a.ikLow, w);
        a.hand.quaternion.slerpQuaternions(a.rest.hand, a.ikHand, w);
      } else {
        const k = Math.min(1, dt * 6);
        a.up.quaternion.slerp(a.rest.up, k);
        a.low.quaternion.slerp(a.rest.low, k);
        a.hand.quaternion.slerp(a.rest.hand, k);
      }
      this.solveFingers(avSide, vis ? handState.slots[userSide] : null, w, mirror);
    }
  }

  /** Gesichtsgröße/-position im Bild als Maßstab (Pixel -> Meter). */
  faceRef(face) {
    const lm = face.landmarks, W = face.width, H = face.height;
    const eye = Math.hypot((lm[33].x - lm[263].x) * W, (lm[33].y - lm[263].y) * H);
    // Nasenwurzel als Bezugspunkt
    // 33/263 sind die äußeren Augenwinkel: real ~9,5 cm auseinander
    return { x: lm[168].x * W, y: lm[168].y * H, mPerPx: 0.095 / eye, W, H };
  }

  solveArm(a, slot, ref, mirror, userSide) {
    const vrm = this.vrm;
    vrm.scene.updateMatrixWorld(true);

    // --- Zielposition des Handgelenks in Weltkoordinaten
    const px = (q) => ({ x: q.x * ref.W, y: q.y * ref.H });
    const pw = px(slot.lm[0]);
    // Maßstab an der Hand: Welt-Landmarks sind in Metern. Vergleicht man ihre Länge
    // in der Bildebene (x/y) mit der Länge in Pixeln, erhält man Meter pro Pixel an der
    // Hand – unabhängig davon, wie schräg die Hand gehalten wird.
    let px2D = 0, m2D = 0;
    for (const [i, j] of [[0, 5], [0, 9], [0, 17], [5, 17], [5, 8], [9, 12]]) {
      const pa = px(slot.lm[i]), pb = px(slot.lm[j]);
      px2D += Math.hypot(pa.x - pb.x, pa.y - pb.y);
      m2D += Math.hypot(slot.world[i].x - slot.world[j].x, slot.world[i].y - slot.world[j].y);
    }
    const mPerPxHand = px2D > 1 ? m2D / px2D : ref.mPerPx;
    // Hand im Bild größer als erwartet = näher an der Kamera als das Gesicht
    const f = Math.max(0.6, Math.min(3, ref.mPerPx / mPerPxHand));
    const camDist = 0.55; // angenommener Abstand Kamera–Gesicht
    const forward = Math.min(0.4, Math.max(-0.02, camDist * (1 - 1 / f)));

    const dx = (pw.x - ref.x) * mPerPxHand * (mirror ? -1 : 1);
    const dy = -(pw.y - ref.y) * mPerPxHand;
    // Kopf-Knochen sitzt am Halsansatz; die Nasenwurzel liegt ~7 cm höher und ~9 cm weiter vorne
    const head = this.headPos;
    const target = _v1.set(head.x + dx, head.y + 0.065 + dy, head.z + 0.09 + forward);
    // Nicht in den Kopf greifen: aus einer Kugel um die Kopfmitte herausschieben
    const headC = _v3.set(head.x, head.y + 0.07, head.z + 0.01);
    const off = target.clone().sub(headC);
    if (off.length() < 0.11) target.copy(headC).add(off.setLength(0.11));

    // --- 2-Knochen-IK (Schulter -> Ellbogen -> Handgelenk)
    const S = a.up.getWorldPosition(_v2.clone());
    const toT = target.clone().sub(S);
    const maxLen = (a.L1 + a.L2) * 0.995;
    if (toT.length() > maxLen) toT.setLength(maxLen);
    const d = toT.length();
    const T = S.clone().add(toT);
    // Ellbogen-Richtung: nach unten, außen und leicht nach vorne (Sitzhaltung, Arme vor dem Körper)
    const pole = new THREE.Vector3(a.sign * 0.45, -1, 0.35).normalize();
    const dirST = toT.clone().normalize();
    const poleOrtho = pole.clone().sub(dirST.clone().multiplyScalar(pole.dot(dirST))).normalize();
    const cosA = (a.L1 * a.L1 + d * d - a.L2 * a.L2) / (2 * a.L1 * d);
    const ang = Math.acos(Math.min(1, Math.max(-1, cosA)));
    const E = S.clone()
      .add(dirST.clone().multiplyScalar(Math.cos(ang) * a.L1))
      .add(poleOrtho.multiplyScalar(Math.sin(ang) * a.L1));

    // Ruhe-Richtung der Arm-Knochen im normalisierten VRM: +X (links) / -X (rechts)
    const restDir = new THREE.Vector3(a.sign, 0, 0);
    const parentQ = a.up.parent.getWorldQuaternion(new THREE.Quaternion());
    const upWorld = new THREE.Quaternion().setFromUnitVectors(restDir, E.clone().sub(S).normalize());
    a.ikUp = parentQ.clone().invert().multiply(upWorld);
    const lowWorld = new THREE.Quaternion().setFromUnitVectors(restDir, T.clone().sub(E).normalize());
    a.ikLow = upWorld.clone().invert().multiply(lowWorld);

    // --- Handgelenk-Ausrichtung aus den Welt-Landmarks (Meter, Hand-zentriert)
    const W0 = slot.world[0], W5 = slot.world[5], W9 = slot.world[9], W17 = slot.world[17];
    // MediaPipe-Welt: x rechts (Bild), y unten, z von der Kamera weg -> Avatar: y hoch, z zur Kamera
    const conv = (v) => new THREE.Vector3(mirror ? -v.x : v.x, -v.y, -v.z);
    const fwd = conv(W9).sub(conv(W0)).normalize(); // Richtung Finger
    const across = conv(W5).sub(conv(W17)).normalize(); // vom kleinen Finger zum Zeigefinger
    const n = new THREE.Vector3().crossVectors(across, fwd).normalize();
    // n zeigt je nach Hand/Spiegelung zur Handfläche oder zum Handrücken -> vereinheitlichen
    const s = (userSide === 'Right' ? -1 : 1) * (mirror ? -1 : 1);
    const back = n.multiplyScalar(s);
    back.sub(fwd.clone().multiplyScalar(back.dot(fwd))).normalize();
    // Basis: (Fingerrichtung, Handrücken, Kreuzprodukt) – für Ziel und Ruhe gleich gebildet
    _m1.makeBasis(fwd, back, new THREE.Vector3().crossVectors(fwd, back));
    const rf = new THREE.Vector3(a.sign, 0, 0), rb = new THREE.Vector3(0, 1, 0);
    _m2.makeBasis(rf, rb, new THREE.Vector3().crossVectors(rf, rb));
    const handWorld = new THREE.Quaternion().setFromRotationMatrix(_m1.multiply(_m2.clone().invert()));
    a.ikHand = lowWorld.clone().invert().multiply(handWorld);
  }

  /** Fingerbeugung: Winkel zwischen aufeinanderfolgenden Fingergliedern. */
  solveFingers(avSide, slot, w, mirror) {
    const fingers = this.fingers[avSide];
    const sign = avSide === 'left' ? -1 : 1;
    for (const [name, idx] of Object.entries(FINGERS)) {
      const bones = fingers[name];
      if (!bones.length) continue;
      const chain = [0, ...idx]; // Handgelenk + 4 Punkte
      for (let j = 0; j < bones.length; j++) {
        let bend = 0;
        if (slot) {
          const a = slot.world[chain[j]], b = slot.world[chain[j + 1]], c = slot.world[chain[j + 2]];
          _v1.subVectors(b, a).normalize();
          _v2.subVectors(c, b).normalize();
          bend = Math.acos(Math.min(1, Math.max(-1, _v1.dot(_v2))));
          // Grundgelenk: Ruhewinkel der Handfläche abziehen
          if (j === 0) bend = Math.max(0, bend - (name === 'Thumb' ? 0.5 : 0.25));
          bend = Math.min(bend, name === 'Thumb' ? 1.0 : 1.7);
        }
        const target = bend * w;
        const bone = bones[j];
        if (name === 'Thumb') {
          // Daumen beugt sich zur Handfläche hin (um Y bzw. Z gemischt)
          bone.rotation.set(0, -sign * target * 0.6, sign * target * 0.4);
        } else {
          bone.rotation.set(0, 0, sign * target);
        }
      }
    }
  }
}
