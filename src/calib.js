// Kalibrierung auf das eigene Gesicht:
// - "base": Neutralwert jedes Kanals (wird beim Kalibrieren gemessen)
// - "peak": größter bisher gesehener Wert (wächst automatisch mit)
// Ergebnis: dein eigener Bewegungsumfang wird auf 0..1 gestreckt.

const STORAGE_KEY = 'avatar-tracker.calib.v2';

// Startwerte für den Maximalwert. Bewusst niedrig, damit auch kleine
// Bewegungen sofort sichtbar sind; sie wachsen, sobald du stärker bewegst.
const DEFAULT_PEAK = {
  browDownLeft: 0.3, browDownRight: 0.3, browInnerUp: 0.35,
  browOuterUpLeft: 0.3, browOuterUpRight: 0.3,
  eyeBlinkLeft: 0.7, eyeBlinkRight: 0.7, eyeWideLeft: 0.3, eyeWideRight: 0.3,
  eyeSquintLeft: 0.5, eyeSquintRight: 0.5,
  mouthSmileLeft: 0.6, mouthSmileRight: 0.6, mouthFrownLeft: 0.3, mouthFrownRight: 0.3,
  mouthFunnel: 0.4, mouthPucker: 0.6, mouthStretchLeft: 0.3, mouthStretchRight: 0.3,
  mouthGap: 0.5, cheekPuff: 0.3,
  eyeCloseGeoLeft: 0.3, eyeCloseGeoRight: 0.3, mouthCornerDown: 0.08,
};
// Mindestabstand zwischen Neutral und Maximum: verhindert, dass Rauschen
// zu großen Ausschlägen verstärkt wird.
const MIN_RANGE = {
  mouthGap: 0.15, eyeBlinkLeft: 0.3, eyeBlinkRight: 0.3,
  eyeCloseGeoLeft: 0.12, eyeCloseGeoRight: 0.12, mouthCornerDown: 0.05,
};
const DEFAULT_MIN_RANGE = 0.1;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

export class Calibrator {
  constructor() {
    this.base = {};
    this.peak = {};
    this.sampling = null;
    this.load();
  }

  /** Rohwert -> 0..1 im persönlichen Bereich. */
  norm(name, v) {
    const b = this.base[name] || 0;
    let p = this.peak[name];
    if (p === undefined) p = Math.max(DEFAULT_PEAK[name] ?? 0.5, b);
    if (v > p && !this.sampling) { p = v; this.peak[name] = p; this.dirty = true; }
    const range = Math.max(p - b, MIN_RANGE[name] ?? DEFAULT_MIN_RANGE);
    return clamp01((v - b) / range);
  }

  /** Startet eine Neutral-Messung über `ms` Millisekunden. */
  start(ms = 1500) {
    return new Promise((resolve) => {
      this.sampling = { sum: {}, count: 0, until: performance.now() + ms, resolve };
    });
  }

  /** Bei jedem erkannten Frame aufrufen (Rohwerte, bereits geglättet). */
  feed(values) {
    if (!this.sampling) return;
    const s = this.sampling;
    for (const [k, v] of Object.entries(values)) s.sum[k] = (s.sum[k] || 0) + v;
    s.count++;
    if (performance.now() >= s.until && s.count > 5) {
      this.base = {};
      for (const [k, v] of Object.entries(s.sum)) this.base[k] = v / s.count;
      this.peak = {}; // Maxima neu lernen
      this.sampling = null;
      this.save();
      s.resolve(true);
    }
  }

  get calibrated() { return Object.keys(this.base).length > 0; }

  save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ base: this.base, peak: this.peak })); } catch {}
    this.dirty = false;
  }

  load() {
    try {
      const d = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (d) { this.base = d.base || {}; this.peak = d.peak || {}; }
    } catch {}
  }
}
