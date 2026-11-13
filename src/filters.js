// One-Euro-Filter: glättet Zittern bei ruhigen Bewegungen,
// reagiert aber schnell bei schnellen Bewegungen (wenig Verzögerung).
// Paper: Casiez et al. 2012, "1€ Filter".

export const filterSettings = { minCutoff: 1.5, beta: 0.8, dCutoff: 1.0 };

function alpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuro {
  constructor(settings = filterSettings) {
    this.s = settings; // gemeinsame Referenz -> Regler wirken sofort
    this.x = null;
    this.dx = 0;
    this.t = 0;
  }

  filter(x, t) {
    if (this.x === null) { this.x = x; this.t = t; return x; }
    const dt = Math.max(t - this.t, 1e-3);
    this.t = t;
    const ad = alpha(this.s.dCutoff, dt);
    this.dx = ad * ((x - this.x) / dt) + (1 - ad) * this.dx;
    const cutoff = this.s.minCutoff + this.s.beta * Math.abs(this.dx);
    const a = alpha(cutoff, dt);
    this.x = a * x + (1 - a) * this.x;
    return this.x;
  }
}

/** Filterbank: je Name ein eigener Filter, wird bei Bedarf angelegt. */
export class FilterBank {
  constructor(settings = filterSettings) { this.s = settings; this.map = new Map(); }
  filter(name, x, t) {
    let f = this.map.get(name);
    if (!f) { f = new OneEuro(this.s); this.map.set(name, f); }
    return f.filter(x, t);
  }
}
