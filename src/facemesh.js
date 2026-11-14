import * as THREE from 'three';
import { OneEuro, filterSettings } from './filters.js?v=0.4.0';
import { FACE_TRIANGLES } from './facemesh-data.js?v=0.4.0';

// Eigenes "Mesh-Gesicht": das MediaPipe-Gesichtsnetz wird direkt aus den
// 478 erkannten Punkten aufgebaut. Keine Ausdrucks-Übersetzung dazwischen:
// jede Bewegung, die die Kamera sieht, ist 1:1 sichtbar (auch einseitig).

const N_POINTS = 478; // 468 Gesicht + 2×5 Iris
const IRIS = [468, 473]; // Mittelpunkte der beiden Iris
const EYE_DIST = 0.065; // Augenabstand in Weltkoordinaten (~6,5 cm)

export const MESH_STYLES = ['both', 'wire', 'solid'];

export class FaceMeshAvatar {
  constructor() {
    this.group = new THREE.Group();
    this.positions = new Float32Array(N_POINTS * 3);
    this.filters = Array.from({ length: N_POINTS * 3 }, () => new OneEuro(filterSettings));
    this.hasData = false;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(FACE_TRIANGLES, 1));
    this.geometry = geo;

    this.solid = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: 0x223246, roughness: 0.55, metalness: 0.15, flatShading: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    }));
    this.wire = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0x6cf0ff, wireframe: true, transparent: true, opacity: 0.55,
    }));
    this.group.add(this.solid, this.wire);

    // Iris als leuchtende Ringe
    this.irises = IRIS.map(() => {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.55, 1, 32),
        new THREE.MeshBasicMaterial({ color: 0x9ff8ff, side: THREE.DoubleSide }),
      );
      const pupil = new THREE.Mesh(new THREE.CircleGeometry(0.5, 24), new THREE.MeshBasicMaterial({ color: 0x05080c }));
      pupil.position.z = 0.01;
      ring.add(pupil);
      this.group.add(ring);
      return ring;
    });

    this.group.visible = false;
    this.setStyle('both');
  }

  setStyle(style) {
    this.style = style;
    this.solid.visible = style !== 'wire';
    this.wire.visible = style !== 'solid';
    this.wire.material.opacity = style === 'wire' ? 0.9 : 0.55;
  }

  /**
   * Landmarks (normalisiert 0..1) -> Weltkoordinaten, zentriert und auf feste Größe skaliert.
   * Kopfdrehung bleibt erhalten, Abstand zur Kamera wird ausgeglichen.
   */
  update(lm, width, height, mirror, tSec) {
    if (!lm || lm.length < N_POINTS) return;
    const sx = mirror ? -width : width;
    // Mittelpunkt + Maßstab
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < 468; i++) { cx += lm[i].x; cy += lm[i].y; cz += lm[i].z; }
    cx /= 468; cy /= 468; cz /= 468;
    const a = lm[33], b = lm[263];
    const eye = Math.hypot((a.x - b.x) * width, (a.y - b.y) * height, (a.z - b.z) * width) || 1;
    const s = EYE_DIST / eye;

    const p = this.positions;
    for (let i = 0; i < N_POINTS; i++) {
      const q = lm[i];
      const x = (q.x - cx) * sx * s;
      const y = -(q.y - cy) * height * s;
      const z = -(q.z - cz) * width * s;
      const k = i * 3;
      p[k] = this.filters[k].filter(x, tSec);
      p[k + 1] = this.filters[k + 1].filter(y, tSec);
      p[k + 2] = this.filters[k + 2].filter(z, tSec);
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();

    // Iris: Mitte + Radius aus den 4 Randpunkten
    IRIS.forEach((c, n) => {
      const ring = this.irises[n];
      ring.position.set(p[c * 3], p[c * 3 + 1], p[c * 3 + 2] + 0.002);
      const e = (c + 1) * 3;
      const r = Math.hypot(p[e] - p[c * 3], p[e + 1] - p[c * 3 + 1]) || 0.005;
      ring.scale.setScalar(r);
    });
    this.hasData = true;
  }
}
