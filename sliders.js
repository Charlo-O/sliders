(() => {
  'use strict';

  const TRACK_W = 320;
  const TRACK_H = 28;
  // Horizontal room on each side of the track for the rubber-band stretch (see --stretch-room).
  const MARGIN = 12;
  const STRETCH_MAX = 8;
  const STRETCH_FALLOFF = 16;
  // The fill profile averages the fill edge over this trailing window (seconds), which
  // smears the transition band like motion blur while the slider moves.
  const TRAIL = 0.28;
  // Samples per CSS px in the precomputed fill profile.
  const PROFILE_RES = 4;
  // #3b6af8 packed as little-endian RGB; alpha goes in the top byte per pixel.
  const FILL_RGB = 0xf86a3b;
  const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const SUBSTEP = 1 / 240;

  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  // Snap a CSS length to whole device pixels so the pixel patterns stay crisp.
  const snap = (css, dpr) => Math.max(1, Math.round(css * dpr)) / dpr;

  // Each pattern returns a per-pixel coverage test (u, v in track CSS px) given the fill
  // profile fill(u) in [0, 1]: 1 is solid, 0 is the bare pattern.
  // `band` is the resting width of the pattern-to-solid transition; `lead` lets the
  // value-0 position sit left of the track so nothing is filled at 0.
  const PATTERNS = {
    // Volume: thin vertical bars that fatten into a solid fill.
    lines: {
      band: 10,
      lead: 6,
      create(dpr) {
        const pitch = 8;
        const base = snap(2, dpr);
        return (u, v, fill) => {
          const c = (Math.floor(u / pitch) + 0.5) * pitch;
          const w = base + (pitch - base) * fill(c);
          return Math.abs(u - c) * 2 <= w ? 1 : 0;
        };
      },
    },
    // Brightness: 4x4 ordered dither. Low fill lights more cells as small dots; high fill
    // swells them to full cells in dither order, leaving the last two ranks as holes.
    dither: {
      band: 9,
      lead: 0,
      create(dpr) {
        const cell = snap(3.5, dpr);
        const dot = snap(2, dpr);
        return (u, v, fill) => {
          const i = Math.floor(u / cell);
          const j = Math.floor(v / cell);
          const f = fill((i + 0.5) * cell);
          const rank = BAYER4[(j & 3) * 4 + (i & 3)];
          if (rank >= 6 + 10 * Math.min(1, f / 0.6)) return 0;
          const swollen = f > 0.97 ? 16 : 14 * clamp((f - 0.6) / 0.15, 0, 1);
          if (rank >= swollen && f > 0.75) return 0;
          const size = rank < swollen ? cell : dot;
          return u - i * cell < size && v - j * cell < size ? 1 : 0;
        };
      },
    },
    // Contrast: antialiased halftone dots on a 45-degree lattice that swell until they merge.
    halftone: {
      band: 26,
      lead: 0,
      create(dpr) {
        const dots = halftoneLattice(6.6, dpr);
        const r0 = 0.75;
        const r1 = dots.reach;
        return (u, v, fill) => dots.cover(u, v, (cx) => r0 + (r1 - r0) * Math.sqrt(fill(cx)));
      },
    },
    // Sharpness: 45-degree hatching. Strokes thicken slightly while halftone dots, centred on
    // the strokes and in the gaps between them, swell until everything merges.
    hatch: {
      band: 36,
      lead: 0,
      create(dpr) {
        const pitch = 8;
        const base = 1.6;
        // Every centre of a step-4 lattice satisfies u + v = 0 (mod 4), i.e. sits on a
        // stroke or exactly halfway between two strokes.
        const dots = halftoneLattice(pitch / 2, dpr);
        return (u, v, fill) => {
          const f = fill(u);
          const t = (u + v) % pitch;
          const d = Math.min(t, pitch - t);
          const w = base + (pitch * 0.3 - base) * smoothstep(0, 0.6, f);
          const stroke = clamp(0.5 + (w / 2 - d) * dpr, 0, 1);
          if (stroke >= 1 || f < 0.1) return stroke;
          const r = dots.reach * smoothstep(0.1, 1, f);
          return Math.max(stroke, dots.cover(u, v, () => r));
        };
      },
    },
  };

  // Antialiased dots on two interleaved square grids (a square lattice rotated 45 degrees).
  // `radius(cx)` receives the x of the nearest dot centre so each dot grows as a unit.
  function halftoneLattice(step, dpr) {
    return {
      // Smallest radius at which neighbouring dots cover the whole plane.
      reach: step / 2 + 0.05,
      cover(u, v, radius) {
        let cx = Math.round(u / step) * step;
        let dx = u - cx;
        let dy = v - Math.round(v / step) * step;
        const bx = (Math.floor(u / step) + 0.5) * step;
        const ex = u - bx;
        const ey = v - (Math.floor(v / step) + 0.5) * step;
        if (ex * ex + ey * ey < dx * dx + dy * dy) {
          cx = bx;
          dx = ex;
          dy = ey;
        }
        return clamp(0.5 + (radius(cx) - Math.sqrt(dx * dx + dy * dy)) * dpr, 0, 1);
      },
    };
  }

  // Integral of the resting edge profile e(x) = clamp(1 - x / band, 0, 1), from 0 to x.
  function edgeIntegral(x, band) {
    if (x <= 0) return x;
    if (x >= band) return band / 2;
    return x - (x * x) / (2 * band);
  }

  // Mean edge profile at u while the edge sweeps linearly from a to b.
  function sweptEdge(u, a, b, band) {
    if (Math.abs(b - a) < 1e-6) return clamp(1 - (u - a) / band, 0, 1);
    return (edgeIntegral(u - a, band) - edgeIntegral(u - b, band)) / (b - a);
  }

  class Spring {
    constructor(value, omega, zeta) {
      this.x = value;
      this.v = 0;
      this.target = value;
      this.omega = omega;
      this.zeta = zeta;
    }

    step(dt) {
      const w = this.omega;
      this.v += (w * w * (this.target - this.x) - 2 * this.zeta * w * this.v) * dt;
      this.x += this.v * dt;
    }

    get resting() {
      return Math.abs(this.target - this.x) < 0.01 && Math.abs(this.v) < 0.05;
    }

    settle() {
      this.x = this.target;
      this.v = 0;
    }
  }

  class Slider {
    constructor(el) {
      this.el = el;
      this.canvas = el.querySelector('.slider-track');
      this.ctx = this.canvas.getContext('2d');
      this.spec = PATTERNS[el.dataset.pattern];
      this.pMin = -this.spec.lead;
      this.pos = this.toPosition(Number(el.dataset.value || 0) / 100);
      this.lastPos = this.pos;
      // Recent edge motion as { a, b, dt } segments covering at least TRAIL seconds.
      this.trail = [{ a: this.pos, b: this.pos, dt: TRAIL }];
      this.profile = new Float32Array(TRACK_W * PROFILE_RES + 1);
      this.fill = (u) => this.profile[clamp(Math.round(u * PROFILE_RES), 0, this.profile.length - 1)];
      this.stretch = new Spring(0, 30, 0.6);
      this.pointerId = null;
      this.pct = null;
      this.moving = false;
      this.buildProfile();
      this.sync();
      this.bind();
    }

    toPosition(value) {
      return this.pMin + clamp(value, 0, 1) * (TRACK_W - this.pMin);
    }

    get value() {
      return (this.pos - this.pMin) / (TRACK_W - this.pMin);
    }

    bind() {
      const el = this.el;
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || this.pointerId !== null) return;
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        this.pointerId = e.pointerId;
        document.documentElement.classList.add('is-dragging');
        el.focus({ preventScroll: true });
        this.drag(e.clientX);
      });
      el.addEventListener('pointermove', (e) => {
        if (e.pointerId === this.pointerId) this.drag(e.clientX);
      });
      const release = (e) => {
        if (e.pointerId !== this.pointerId) return;
        this.pointerId = null;
        document.documentElement.classList.remove('is-dragging');
        this.stretch.target = 0;
        this.wake();
      };
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
      el.addEventListener('lostpointercapture', release);
      el.addEventListener('keydown', (e) => this.key(e));
    }

    drag(clientX) {
      const x = clientX - this.canvas.getBoundingClientRect().left - MARGIN;
      const over = x > TRACK_W ? x - TRACK_W : x < this.pMin ? x - this.pMin : 0;
      this.pos = clamp(x, this.pMin, TRACK_W);
      this.stretch.target =
        Math.sign(over) * STRETCH_MAX * (1 - Math.exp(-Math.abs(over) / STRETCH_FALLOFF));
      this.sync();
      this.wake();
    }

    key(e) {
      let v = this.value;
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowUp':
          v += e.shiftKey ? 0.1 : 0.01;
          break;
        case 'ArrowLeft':
        case 'ArrowDown':
          v -= e.shiftKey ? 0.1 : 0.01;
          break;
        case 'PageUp':
          v += 0.1;
          break;
        case 'PageDown':
          v -= 0.1;
          break;
        case 'Home':
          v = 0;
          break;
        case 'End':
          v = 1;
          break;
        default:
          return;
      }
      e.preventDefault();
      this.pos = this.toPosition(v);
      this.sync();
      this.wake();
    }

    sync() {
      const pct = Math.round(clamp(this.value, 0, 1) * 100);
      if (pct === this.pct) return;
      this.pct = pct;
      this.el.setAttribute('aria-valuenow', String(pct));
    }

    wake() {
      this.moving = true;
      startLoop();
    }

    // Advances the animation by dt seconds and redraws. Returns true while still animating.
    advance(dt) {
      if (!this.moving) return false;
      const trail = this.trail;
      trail.push({ a: this.lastPos, b: this.pos, dt });
      this.lastPos = this.pos;
      let total = 0;
      for (const seg of trail) total += seg.dt;
      while (trail.length > 1 && total - trail[0].dt >= TRAIL) total -= trail.shift().dt;

      const n = Math.max(1, Math.ceil(dt / SUBSTEP));
      for (let i = 0; i < n; i++) this.stretch.step(dt / n);

      const still = trail.every((seg) => seg.a === this.pos && seg.b === this.pos);
      if (still && this.stretch.resting) {
        this.stretch.settle();
        this.trail = [{ a: this.pos, b: this.pos, dt: TRAIL }];
        this.moving = false;
      }
      this.buildProfile();
      this.render();
      return this.moving;
    }

    buildProfile() {
      const { trail, profile } = this;
      const band = this.spec.band;
      let total = 0;
      for (const seg of trail) total += seg.dt;
      const excess = Math.max(0, total - TRAIL);
      const weight = total - excess;
      for (let i = 0; i < profile.length; i++) {
        const u = i / PROFILE_RES;
        let acc = 0;
        for (let k = 0; k < trail.length; k++) {
          const seg = trail[k];
          const w = k === 0 ? seg.dt - excess : seg.dt;
          acc += w * sweptEdge(u, seg.a, seg.b, band);
        }
        profile[i] = clamp(acc / weight, 0, 1);
      }
    }

    resize(dpr) {
      const w = Math.round((TRACK_W + 2 * MARGIN) * dpr);
      const h = Math.round(TRACK_H * dpr);
      if (this.canvas.width !== w || this.canvas.height !== h || this.dpr !== dpr) {
        this.canvas.width = w;
        this.canvas.height = h;
        this.dpr = dpr;
        this.test = this.spec.create(dpr);
        this.image = this.ctx.createImageData(w, h);
        this.pixels = new Uint32Array(this.image.data.buffer);
      }
      this.render();
    }

    render() {
      const { pixels, dpr, test, fill } = this;
      const cw = this.canvas.width;
      const ch = this.canvas.height;
      pixels.fill(0);
      // Stretching scales the whole track away from the opposite edge.
      const s = this.stretch.x;
      const scale = (TRACK_W + Math.abs(s)) / TRACK_W;
      for (let X = 0; X < cw; X++) {
        const xc = (X + 0.5) / dpr - MARGIN;
        const u = s >= 0 ? xc / scale : TRACK_W - (TRACK_W - xc) / scale;
        if (u < 0 || u >= TRACK_W) continue;
        for (let Y = 0; Y < ch; Y++) {
          const a = test(u, (Y + 0.5) / dpr, fill);
          if (a > 0) pixels[Y * cw + X] = FILL_RGB | (Math.round(a * 255) << 24);
        }
      }
      this.ctx.putImageData(this.image, 0, 0);
    }
  }

  const sliders = Array.from(document.querySelectorAll('.slider'), (el) => new Slider(el));

  let raf = 0;
  let last = 0;

  function startLoop() {
    if (raf) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  function tick(now) {
    const dt = clamp((now - last) / 1000, 1 / 1000, 1 / 30);
    last = now;
    let active = false;
    for (const slider of sliders) {
      if (slider.advance(dt)) active = true;
    }
    raf = active ? requestAnimationFrame(tick) : 0;
  }

  function layout() {
    const dpr = window.devicePixelRatio || 1;
    for (const slider of sliders) slider.resize(dpr);
  }

  window.addEventListener('resize', layout);
  layout();
})();
