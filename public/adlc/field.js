// The run field: an ASCII ramp on an 8x16 cell, six lifecycle bands deep at the top
// (raw intent) resolving to quiet marks at the base (approved release).
// Each band carries its own stage name from the page's ledger, so the ramp reads as
// run state moving through the lifecycle rather than density for its own sake.
// Pauses off screen and under reduced motion; the CSS dot grid behind it is the no-script state.
(() => {
  const host = document.querySelector('[data-field]');
  if (!host) return;
  const canvas = host.querySelector('canvas');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const ramp = ['.', ',', ':', '-', '+', '*', '#', '@'];
  // intent, planner, coder, tester, review, release: floor of the ramp per band, top to base
  const bands = [1.0, 0.86, 0.72, 0.58, 0.44, 0.34];
  const bandTop = [7, 6, 5, 4, 3, 2];
  const stages = ['intent', 'planner', 'coder', 'tester', 'review', 'release'];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let seen = true, raf = 0, t = 0, lens = { x: -1, y: -1 };
  const draw = () => {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = host.clientWidth, h = host.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const s = getComputedStyle(document.documentElement);
    const cw = 8, ch = 16;
    // Six lane rows run clear of the ramp, so a stage name never sits on dense cells.
    const laneY = stages.map((_, band) => Math.round(((band + 0.62) / stages.length) * h));
    ctx.font = '12px "JetBrains Mono", ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    for (let y = 0, row = 0; y < h; y += ch, row++) {
      if (laneY.some((ly) => Math.abs(y + ch / 2 - ly) < 11)) continue;
      const band = Math.min(bands.length - 1, Math.floor((y / h) * bands.length));
      const floor = bands[band];
      for (let x = 0, col = 0; x < w; x += cw, col++) {
        let v = (Math.sin(col * 0.35 + row * 0.18 + t) + 1) / 2;
        v *= floor;
        let i = Math.min(ramp.length - 1, Math.floor(v * ramp.length));
        if (i > bandTop[band]) i = bandTop[band];
        if (lens.x >= 0) {
          const d = Math.hypot(x + cw / 2 - lens.x, y + ch / 2 - lens.y);
          if (d < 140) { i = Math.min(ramp.length - 1, i + 3); }
        }
        if (v < 0.1 && i < 2) continue;
        const step = Math.min(4, Math.max(1, Math.ceil((i / (ramp.length - 1)) * 4)));
        ctx.fillStyle = i >= 6 ? s.getPropertyValue('--color-accent-deep') : s.getPropertyValue(`--color-glyph-${step}`);
        ctx.fillText(ramp[i], x, y + ch / 2);
      }
    }
    // one stage lane per band: the name runs left along its own row, and a copy fades
    // in or out at an edge instead of being cut mid-word on a narrow screen
    ctx.textBaseline = 'alphabetic';
    for (let band = 0; band < stages.length; band++) {
      const y = laneY[band];
      const label = stages[band];
      const tw = ctx.measureText(label).width;
      const advance = tw + Math.max(140, w * 0.6);
      const offset = ((t * 42) % advance);
      ctx.fillStyle = s.getPropertyValue(band === stages.length - 1 ? '--color-accent-deep' : `--color-glyph-${band + 2}`);
      // A copy is drawn only once the whole word is inside the field, so a stage
      // name fades in and out at the edges instead of being cut mid-word on a phone.
      const fade = 24;
      for (let x = -offset; x < w + tw; x += advance) {
        const a = Math.min(x, w - tw - x) / fade;
        if (a <= 0) continue;
        ctx.globalAlpha = Math.min(1, a);
        ctx.fillText(label, x, y);
      }
      ctx.globalAlpha = 1;
    }
  };
  const loop = () => {
    if (!seen || reduce) { draw(); return; }
    t += 0.02;
    draw();
    raf = requestAnimationFrame(loop);
  };
  new IntersectionObserver(([e]) => {
    seen = e.isIntersecting;
    cancelAnimationFrame(raf);
    if (seen) raf = requestAnimationFrame(loop);
  }, { threshold: 0 }).observe(host);
  if (!reduce) {
    host.addEventListener('pointermove', (e) => {
      const r = host.getBoundingClientRect();
      lens = { x: e.clientX - r.left, y: e.clientY - r.top };
    });
    host.addEventListener('pointerleave', () => { lens = { x: -1, y: -1 }; });
  }
  addEventListener('resize', draw);
  loop();
})();
