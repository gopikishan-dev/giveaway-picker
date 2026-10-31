/* Lightweight canvas confetti — no dependencies. */
(function (root) {
  'use strict';

  const COLORS = ['#feda75', '#fa7e1e', '#d62976', '#962fbf', '#4f5bd5', '#ffffff', '#2ee6a6'];
  let canvas = null;
  let ctx = null;
  let particles = [];
  let raf = 0;
  let dpr = 1;

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.className = 'confetti-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    resize();
    root.addEventListener('resize', resize);
  }

  function resize() {
    if (!canvas) return;
    dpr = Math.min(root.devicePixelRatio || 1, 2);
    canvas.width = root.innerWidth * dpr;
    canvas.height = root.innerHeight * dpr;
  }

  function reducedMotion() {
    return root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function burst(opts) {
    if (reducedMotion()) return;
    ensureCanvas();
    const o = Object.assign({ x: 0.5, y: 0.45, count: 140, spread: 70, power: 14 }, opts || {});
    const cx = o.x * root.innerWidth;
    const cy = o.y * root.innerHeight;
    for (let i = 0; i < o.count; i++) {
      const angle = (-90 + (Math.random() - 0.5) * o.spread * 2) * (Math.PI / 180);
      const speed = o.power * (0.45 + Math.random() * 0.75);
      particles.push({
        x: cx, y: cy,
        vx: Math.cos(angle) * speed + (o.drift || 0),
        vy: Math.sin(angle) * speed,
        w: 6 + Math.random() * 6,
        h: 8 + Math.random() * 10,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.35,
        color: COLORS[(Math.random() * COLORS.length) | 0],
        life: 0,
        ttl: 140 + Math.random() * 80,
        shape: Math.random() < 0.3 ? 'circle' : 'rect',
      });
    }
    if (particles.length > 900) particles.splice(0, particles.length - 900);
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function cannons() {
    burst({ x: 0.08, y: 0.95, count: 90, spread: 25, power: 22, drift: 4 });
    burst({ x: 0.92, y: 0.95, count: 90, spread: 25, power: 22, drift: -4 });
  }

  function tick() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const h = root.innerHeight;
    particles = particles.filter((p) => p.life < p.ttl && p.y < h + 40);
    for (const p of particles) {
      p.life++;
      p.vx *= 0.985;
      p.vy = p.vy * 0.985 + 0.32;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      const alpha = Math.max(0, 1 - p.life / p.ttl);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.shape === 'circle') {
        ctx.beginPath();
        ctx.arc(0, 0, p.w / 2.4, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.scale(1, Math.cos(p.life * 0.12));
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      }
      ctx.restore();
    }
    if (particles.length) {
      raf = requestAnimationFrame(tick);
    } else {
      raf = 0;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  root.Confetti = { burst, cannons };
})(window);
