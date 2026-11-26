// The AXON mark, drawn live: a letter A made of twisted nerve fibers, a light at the apex.
(() => {
  function rng(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }

  function buildFibers(density) {
    const R = rng(11);
    const fibers = [];
    const P = { x: 500, y: 215 };
    function bundle(B, E, N, wB, wE, k, alpha, curve, prof, leg) {
      const dx = E.x - B.x, dy = E.y - B.y, L = Math.hypot(dx, dy), nx = -dy / L, ny = dx / L;
      for (let i = 0; i < N; i++) {
        const phi = R() * Math.PI * 2, rr = 0.35 + 0.65 * Math.sqrt(R());
        const t0 = prof ? 0 : R() * 0.07, t1 = prof ? 1 : 1 - R() * 0.015;
        const blue = R() < 0.06;
        const st = 90, pts = new Float32Array((st + 1) * 2);
        for (let j = 0; j <= st; j++) {
          const t = t0 + (t1 - t0) * j / st;
          const w = prof ? prof(t) : wE + (wB - wE) * Math.pow(1 - t, 1.7);
          const a = phi + k * t * Math.PI;
          const bend = curve * Math.sin(Math.PI * t);
          pts[j * 2] = B.x + dx * t + nx * (w * rr * Math.sin(a) + bend);
          pts[j * 2 + 1] = B.y + dy * t + ny * (w * rr * Math.sin(a) + bend);
        }
        const depth = 0.5 + 0.5 * Math.cos(phi);
        fibers.push({ pts, blue, alpha: alpha * (0.35 + 0.65 * depth), width: blue ? 0.9 : 0.55 + 0.6 * depth, leg });
      }
    }
    const n = Math.round(460 * density), nb = Math.round(170 * density);
    bundle({ x: 250, y: 840 }, P, n, 80, 2.5, 1.9, 0.19 / Math.sqrt(density), -26, null, true);
    bundle({ x: 750, y: 840 }, P, n, 80, 2.5, -1.9, 0.19 / Math.sqrt(density), 26, null, true);
    const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const Lp = lerp({ x: 250, y: 840 }, P, 0.42), Rp = lerp({ x: 750, y: 840 }, P, 0.42);
    const bar = (t) => 2 + 16 * Math.pow(Math.abs(2 * t - 1), 1.6);
    bundle({ x: Lp.x - 14, y: Lp.y }, { x: Rp.x + 14, y: Rp.y }, nb, 0, 0, 2.2, 0.17 / Math.sqrt(density), 24, bar, false);
    return { fibers, apex: P };
  }

  window.AxonMark = function (canvas, opts = {}) {
    const ctx = canvas.getContext('2d');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const { fibers, apex } = buildFibers(opts.density || 1);
    const legs = fibers.filter((f) => f.leg);
    let W = 0, H = 0, dpr = 1, scale = 1, ox = 0, oy = 0, layer = null, start = performance.now(), raf = 0, visible = true;
    const pulses = [];
    let nodeBoost = 0;

    function layout() {
      const r = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = Math.max(1, r.width); H = Math.max(1, r.height);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      const size = Math.min(H * (opts.fill || 0.95), W * (opts.maxW || 1));
      scale = size / 1000;
      const cx = W * (opts.cx ?? 0.5), cy = H * (opts.cy ?? 0.5);
      ox = cx - 500 * scale; oy = cy - 520 * scale;
      layer = document.createElement('canvas');
      layer.width = canvas.width; layer.height = canvas.height;
      const l = layer.getContext('2d');
      l.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
      l.globalCompositeOperation = 'lighter';
      for (const f of fibers) {
        l.beginPath();
        for (let j = 0; j < f.pts.length; j += 2) j ? l.lineTo(f.pts[j], f.pts[j + 1]) : l.moveTo(f.pts[j], f.pts[j + 1]);
        l.strokeStyle = f.blue ? `rgba(140,200,255,${f.alpha * 1.5})` : `rgba(236,228,212,${f.alpha})`;
        l.lineWidth = f.width;
        l.stroke();
      }
      // feather the feet
      l.globalCompositeOperation = 'destination-out';
      const g = l.createLinearGradient(0, 700, 0, 880);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,1)');
      l.fillStyle = g; l.fillRect(0, 700, 1000, 300);
    }

    function at(f, t) {
      const n = f.pts.length / 2 - 1, i = Math.min(n - 1, Math.floor(t * n)), u = t * n - i;
      return [f.pts[i * 2] + (f.pts[i * 2 + 2] - f.pts[i * 2]) * u, f.pts[i * 2 + 1] + (f.pts[i * 2 + 3] - f.pts[i * 2 + 1]) * u];
    }

    function frame(now) {
      raf = 0;
      if (!visible) return;
      const el = (now - start) / 1000;
      const reveal = reduce ? 1 : Math.min(1, el / 1.9);
      const ease = 1 - Math.pow(1 - reveal, 3);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // fibers rise from the feet to the apex
      ctx.save();
      const top = dpr * (oy + (880 - 700 * ease) * scale);
      ctx.beginPath(); ctx.rect(0, top, canvas.width, canvas.height - top); ctx.clip();
      ctx.drawImage(layer, 0, 0);
      ctx.restore();
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
      ctx.globalCompositeOperation = 'lighter';
      // signals travelling up the fibers
      if (!reduce && reveal >= 1) {
        if (pulses.length < (opts.pulses ?? 9) && Math.random() < 0.08) pulses.push({ f: legs[(Math.random() * legs.length) | 0], t: 0.05, v: 0.004 + Math.random() * 0.004 });
        for (let i = pulses.length - 1; i >= 0; i--) {
          const p = pulses[i]; p.t += p.v * (1 + p.t * 1.5);
          if (p.t >= 1) { pulses.splice(i, 1); nodeBoost = Math.min(1, nodeBoost + 0.35); continue; }
          const [x, y] = at(p.f, p.t);
          const gr = ctx.createRadialGradient(x, y, 0, x, y, 9);
          gr.addColorStop(0, 'rgba(210,236,255,0.9)'); gr.addColorStop(1, 'rgba(140,200,255,0)');
          ctx.fillStyle = gr; ctx.fillRect(x - 10, y - 10, 20, 20);
        }
      }
      nodeBoost *= 0.96;
      // the node
      if (reveal > 0.85) {
        const k = reduce ? 1 : Math.min(1, (reveal - 0.85) / 0.15);
        const breathe = reduce ? 0 : 0.08 * Math.sin(el * 1.6);
        const a = k * (0.55 + breathe + nodeBoost * 0.35);
        let gl = ctx.createRadialGradient(apex.x, apex.y, 0, apex.x, apex.y, 170);
        gl.addColorStop(0, `rgba(200,230,255,${a})`); gl.addColorStop(0.12, `rgba(120,180,255,${a * 0.4})`); gl.addColorStop(1, 'rgba(40,80,160,0)');
        ctx.fillStyle = gl; ctx.fillRect(apex.x - 180, apex.y - 180, 360, 360);
        gl = ctx.createRadialGradient(apex.x, apex.y, 0, apex.x, apex.y, 16);
        gl.addColorStop(0, `rgba(255,255,255,${k})`); gl.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gl; ctx.fillRect(apex.x - 20, apex.y - 20, 40, 40);
      }
      ctx.globalCompositeOperation = 'source-over';
      if (!reduce || reveal < 1) raf = requestAnimationFrame(frame);
    }

    const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
    layout(); kick();
    let rt = 0;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { layout(); kick(); }, 120); });
    if ('IntersectionObserver' in window) new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) kick(); }).observe(canvas);
    return { pulse: () => { nodeBoost = 1; kick(); } };
  };
})();
