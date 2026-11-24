/* Lightweight 2D simulation engine for the Visual Labs.
 * Every sim works in a virtual 1000 x H coordinate space that is scaled to the canvas width.
 * Features: play/pause, single step, speed, reset, parameter controls, clickable components,
 * an info panel and an event log. Animation stops automatically when the canvas leaves the DOM.
 */
(function () {
  const esc = LAB.esc;
  const VW = 1000;

  function colors() {
    const cs = getComputedStyle(document.documentElement);
    const g = n => cs.getPropertyValue(n).trim();
    return { text: g('--text'), text2: g('--text2'), muted: g('--muted'), line: g('--line'), line2: g('--line2'), panel: g('--panel'), panel2: g('--panel2'),
             bg: g('--bg2'), accent: g('--accent'), accent2: g('--accent2'), ok: g('--ok'), warn: g('--warn'), bad: g('--bad'), info: g('--info') };
  }

  class Sim {
    constructor(el, cfg) {
      this.el = el; this.cfg = cfg; this.H = cfg.height || 480;
      this.params = {}; this.paused = false; this.speed = 1; this.t = 0; this.packets = []; this.nodes = []; this.stepRequested = false;
      (cfg.controls || []).forEach(c => { if (c.id) this.params[c.id] = c.value; });
      this.buildDom();
      this.c = colors(); this.frame = 0;
      LAB._sim = this;                                                   // handy for debugging in devtools
      this.reset();
      this.last = performance.now();
      const loop = now => {
        if (!document.body.contains(this.canvas)) return;             // unmounted: stop
        const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
        if (++this.frame % 30 === 0) this.c = colors();
        if (this.paused && this.stepRequested) {
          this.stepRequested = false;
          if (this.onStep) this.onStep();
          else for (let i = 0; i < 20; i++) { this.t += 0.025; this.updatePackets(0.025); this.update && this.update(0.025); } // advance 0.5s
        } else if (!this.paused) {
          const d = dt * this.speed;
          this.t += d; this.updatePackets(d); this.update && this.update(d);
        }
        this.render();
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }

    buildDom() {
      const cfg = this.cfg;
      this.el.innerHTML = `<div class="viz">
        <div class="viz-head"><h3>${esc(cfg.title)}</h3><span class="spacer"></span>
          <button class="btn sm" data-a="play">⏸ Pause</button>
          <button class="btn sm" data-a="step" title="Advance one step while paused">⏭ Step</button>
          <button class="btn sm" data-a="reset">↺ Reset</button>
          <label class="sm muted row" style="gap:6px">Speed <input type="range" min="0.25" max="3" step="0.25" value="1" data-a="speed" style="width:80px"></label>
        </div>
        <div class="viz-body">
          <div class="viz-stage"><canvas></canvas></div>
          <div class="viz-side">
            <div class="viz-controls"></div>
            <div class="viz-info"></div>
            <div class="viz-log"></div>
          </div>
        </div>
        ${cfg.hint ? `<div class="viz-foot">${cfg.hint}</div>` : ''}
      </div>`;
      const $ = s => this.el.querySelector(s);
      this.canvas = $('canvas'); this.ctx = this.canvas.getContext('2d');
      this.infoEl = $('.viz-info'); this.logEl = $('.viz-log'); this.ctrlEl = $('.viz-controls');
      $('[data-a=play]').onclick = e => { this.paused = !this.paused; e.target.textContent = this.paused ? '▶ Play' : '⏸ Pause'; };
      $('[data-a=step]').onclick = () => { if (!this.paused) { this.paused = true; $('[data-a=play]').textContent = '▶ Play'; } this.stepRequested = true; };
      $('[data-a=reset]').onclick = () => this.reset();
      $('[data-a=speed]').oninput = e => this.speed = +e.target.value;
      this.buildControls();
      this.canvas.addEventListener('click', e => {
        const r = this.canvas.getBoundingClientRect(), s = VW / r.width;
        const x = (e.clientX - r.left) * s, y = (e.clientY - r.top) * s;
        const n = this.nodes.slice().reverse().find(n => !n.hidden && x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h);
        if (this.onClick && this.onClick(x, y, n)) return;
        if (n) this.showNode(n);
      });
      const ro = new ResizeObserver(() => this.resize()); ro.observe(this.canvas.parentElement); this.resize();
    }

    buildControls() {
      const html = (this.cfg.controls || []).map(c => {
        const v = this.params[c.id];
        if (c.type === 'range') return `<label>${esc(c.label)} <span class="val" data-v="${c.id}">${this.fmt(c, v)}</span><input type="range" data-c="${c.id}" min="${c.min}" max="${c.max}" step="${c.step || 1}" value="${v}"></label>`;
        if (c.type === 'select') return `<label>${esc(c.label)}<select data-c="${c.id}">${c.options.map(o => `<option value="${o[0]}" ${o[0] == v ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select></label>`;
        if (c.type === 'seg') return `<label>${esc(c.label)}<div class="seg" data-seg="${c.id}">${c.options.map(o => `<button data-sv="${o[0]}" class="${o[0] == v ? 'on' : ''}">${esc(o[1])}</button>`).join('')}</div></label>`;
        if (c.type === 'check') return `<label class="inline"><input type="checkbox" data-c="${c.id}" ${v ? 'checked' : ''}> ${esc(c.label)}</label>`;
        if (c.type === 'buttons') return `<div class="row" style="gap:6px">${c.buttons.map(b => `<button class="btn sm" data-b="${b[0]}">${esc(b[1])}</button>`).join('')}</div>`;
        return '';
      }).join('');
      this.ctrlEl.innerHTML = html;
      this.ctrlEl.querySelectorAll('[data-c]').forEach(inp => {
        const c = this.cfg.controls.find(x => x.id === inp.dataset.c);
        const handler = () => {
          const val = inp.type === 'checkbox' ? inp.checked : inp.type === 'range' ? +inp.value : inp.value;
          this.params[c.id] = val;
          const lab = this.ctrlEl.querySelector(`[data-v="${c.id}"]`); if (lab) lab.textContent = this.fmt(c, val);
          if (c.reset) this.reset(); else this.onParam && this.onParam(c.id, val);
        };
        inp.addEventListener(inp.type === 'range' ? 'input' : 'change', handler);
      });
      this.ctrlEl.querySelectorAll('[data-seg]').forEach(seg => seg.querySelectorAll('button').forEach(b => b.onclick = () => {
        const c = this.cfg.controls.find(x => x.id === seg.dataset.seg);
        seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
        this.params[c.id] = b.dataset.sv;
        if (c.reset !== false) this.reset(); else this.onParam && this.onParam(c.id, b.dataset.sv);
      }));
      this.ctrlEl.querySelectorAll('[data-b]').forEach(b => b.onclick = () => this.onButton && this.onButton(b.dataset.b));
    }
    fmt(c, v) { return c.fmt ? c.fmt(v) : (v + (c.unit || '')); }

    resize() {
      const w = this.canvas.parentElement.clientWidth || 700;
      const scale = w / VW, h = Math.max(260, this.H * scale);
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
      this.canvas.style.height = h + 'px';
      this.scale = scale * dpr; this.vh = h / scale;
      this.fontBoost = Math.max(1, Math.min(1.3, 0.95 / scale));         // keep labels legible on narrow screens
    }

    reset() {
      this.t = 0; this.packets = []; this.logEl.innerHTML = '';
      this.init && this.init();
      this.setInfo(this.cfg.info || 'Click any component for details.');
    }

    /* ---- logging & info ---- */
    log(msg, cls = '') {
      const d = document.createElement('div'); d.className = cls; d.innerHTML = `<span class="muted">${this.t.toFixed(1)}s</span> ${msg}`;
      this.logEl.prepend(d); while (this.logEl.children.length > 120) this.logEl.lastChild.remove();
    }
    setInfo(html) { this.infoEl.innerHTML = html; }
    showNode(n) { this.setInfo(`<b>${esc(n.label)}</b>${n.sub ? ' <span class="muted">' + esc(n.sub) + '</span>' : ''}<div style="margin-top:4px">${n.info || ''}</div>`); this.selected = n; }

    /* ---- packets ---- */
    send(path, opts = {}) {
      const pts = path.map(p => Array.isArray(p) ? p : this.center(p));
      const segs = []; let total = 0;
      for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); segs.push(l); total += l; }
      const p = { pts, segs, total: Math.max(total, 1), d: 0, speed: opts.speed || 420, color: opts.color || this.c.accent, r: opts.r || 6, label: opts.label, onDone: opts.onDone, shape: opts.shape };
      this.packets.push(p); return p;
    }
    updatePackets(dt) {
      const done = [];
      this.packets.forEach(p => { p.d += p.speed * dt; if (p.d >= p.total) done.push(p); });
      if (done.length) { this.packets = this.packets.filter(p => !done.includes(p)); done.forEach(p => p.onDone && p.onDone()); }
    }
    pos(p) {
      let d = Math.min(p.d, p.total);
      for (let i = 0; i < p.segs.length; i++) {
        if (d <= p.segs[i]) { const a = p.pts[i], b = p.pts[i + 1], f = p.segs[i] ? d / p.segs[i] : 1; return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]; }
        d -= p.segs[i];
      }
      return p.pts[p.pts.length - 1];
    }
    center(n) { if (typeof n === 'string') n = this.node(n); return [n.x + n.w / 2, n.y + n.h / 2]; }
    node(id) { return this.nodes.find(n => n.id === id); }

    /* ---- rendering ---- */
    render() {
      const ctx = this.ctx, c = this.c;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      this.draw && this.draw(ctx, c);
      this.packets.forEach(p => {
        const [x, y] = this.pos(p);
        ctx.fillStyle = p.color; ctx.shadowColor = p.color; ctx.shadowBlur = 10;
        ctx.beginPath();
        if (p.shape === 'square') ctx.rect(x - p.r, y - p.r, p.r * 2, p.r * 2); else ctx.arc(x, y, p.r, 0, Math.PI * 2);
        ctx.fill(); ctx.shadowBlur = 0;
        if (p.label) this.text(x, y - p.r - 6, p.label, { size: 11, color: c.text, align: 'center', bg: true });
      });
    }
    box(n, o = {}) {
      const ctx = this.ctx, c = this.c;
      const st = o.status || n.status;
      const stroke = st === 'down' ? c.bad : st === 'warn' ? c.warn : st === 'ok' ? c.ok : st === 'active' ? c.accent : (this.selected === n ? c.accent : c.line2);
      ctx.globalAlpha = n.dim || st === 'down' ? 0.55 : 1;
      this.rrect(n.x, n.y, n.w, n.h, 9);
      ctx.fillStyle = o.fill || (st === 'active' ? hexA(c.accent, .15) : c.panel); ctx.fill();
      ctx.lineWidth = st === 'active' || this.selected === n ? 2.2 : 1.3; ctx.strokeStyle = stroke; ctx.stroke();
      const lines = [n.label].concat(n.sub ? [n.sub] : []);
      const cy = n.y + n.h / 2 - (lines.length - 1) * 8;
      this.text(n.x + n.w / 2, cy, n.label, { size: o.size || 13, bold: true, color: st === 'down' ? c.bad : c.text, align: 'center' });
      if (n.sub) this.text(n.x + n.w / 2, cy + 16, n.sub, { size: 11, color: c.muted, align: 'center' });
      if (st === 'down') { ctx.strokeStyle = c.bad; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(n.x + 6, n.y + 6); ctx.lineTo(n.x + n.w - 6, n.y + n.h - 6); ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
    rrect(x, y, w, h, r) { const ctx = this.ctx; ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
    line(a, b, o = {}) {
      const ctx = this.ctx; const [x1, y1] = Array.isArray(a) ? a : this.edgePoint(a, b), [x2, y2] = Array.isArray(b) ? b : this.edgePoint(b, a);
      ctx.strokeStyle = o.color || this.c.line2; ctx.lineWidth = o.width || 1.4; ctx.setLineDash(o.dash || []);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
      if (o.arrow !== false) { const ang = Math.atan2(y2 - y1, x2 - x1); ctx.fillStyle = o.color || this.c.line2; ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x2 - 9 * Math.cos(ang - .4), y2 - 9 * Math.sin(ang - .4)); ctx.lineTo(x2 - 9 * Math.cos(ang + .4), y2 - 9 * Math.sin(ang + .4)); ctx.closePath(); ctx.fill(); }
      if (o.label) this.text((x1 + x2) / 2, (y1 + y2) / 2 - 7, o.label, { size: 10.5, color: this.c.muted, align: 'center', bg: true });
    }
    edgePoint(n, toward) {
      if (typeof n === 'string') n = this.node(n);
      const [cx, cy] = this.center(n); const [tx, ty] = Array.isArray(toward) ? toward : this.center(toward);
      const dx = tx - cx, dy = ty - cy; if (!dx && !dy) return [cx, cy];
      const sx = (n.w / 2) / Math.abs(dx || 1e-9), sy = (n.h / 2) / Math.abs(dy || 1e-9); const s = Math.min(sx, sy);
      return [cx + dx * s, cy + dy * s];
    }
    text(x, y, s, o = {}) {
      const ctx = this.ctx; ctx.font = `${o.bold ? 600 : 400} ${(o.size || 12) * (this.fontBoost || 1)}px ${o.mono ? 'ui-monospace,Menlo,monospace' : '-apple-system,Segoe UI,Inter,sans-serif'}`;
      ctx.textAlign = o.align || 'left'; ctx.textBaseline = 'middle';
      if (o.bg) { const w = ctx.measureText(s).width + 8; const bx = o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x - 4; ctx.fillStyle = hexA(this.c.bg || '#000', .85); this.rrect(bx, y - 9, w, 18, 5); ctx.fill(); }
      ctx.fillStyle = o.color || this.c.text; ctx.fillText(s, x, y);
    }
    bar(x, y, w, h, frac, color) {
      const ctx = this.ctx; this.rrect(x, y, w, h, Math.min(4, h / 2)); ctx.fillStyle = this.c.panel2; ctx.fill(); ctx.strokeStyle = this.c.line; ctx.lineWidth = 1; ctx.stroke();
      if (frac > 0) { this.rrect(x, y, Math.max(2, w * Math.min(1, frac)), h, Math.min(4, h / 2)); ctx.fillStyle = color || this.c.accent; ctx.fill(); }
    }
    circle(x, y, r, fill, stroke) { const ctx = this.ctx; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); } }
  }

  function hexA(col, a) {
    col = (col || '').trim();
    if (col.startsWith('#')) { let h = col.slice(1); if (h.length === 3) h = h.split('').map(x => x + x).join(''); const n = parseInt(h, 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; }
    if (col.startsWith('rgb(')) return col.replace('rgb(', 'rgba(').replace(')', `,${a})`);
    return col;
  }

  /* ---------- Scripted sequence simulation (request flows, protocols, sagas) ----------
   * cfg.nodes: [{id,x,y,w,h,label,sub,info}] (may be a function of params)
   * cfg.script(params, sim): returns [{from,to,label,detail,cls,status:{id:status},pause,self}]
   */
  class SeqSim extends Sim {
    init() {
      const p = this.params;
      this.nodes = (typeof this.cfg.nodes === 'function' ? this.cfg.nodes(p) : this.cfg.nodes).map(n => Object.assign({ w: 130, h: 54 }, n));
      this.steps = this.cfg.script(p, this);
      this.i = -1; this.wait = 0.6; this.active = null; this.edges = this.cfg.edges ? this.cfg.edges(p) : [];
      this.done = false;
    }
    next() {
      this.i++;
      if (this.i >= this.steps.length) { this.done = true; this.wait = 3.5; this.log('— flow complete — (restarts automatically)', 'info'); return; }
      const s = this.steps[this.i];
      this.nodes.forEach(n => { if (n.status === 'active') n.status = undefined; });
      const label = (this.i + 1) + '. ' + s.label;
      const arrive = () => {
        if (s.status) Object.entries(s.status).forEach(([id, st]) => { const n = this.node(id); if (n) n.status = st; });
        const to = this.node(s.to); if (to && !s.status?.[s.to] && to.status !== 'down') to.status = 'active';
        this.log(`<b>${esc(label)}</b>`, s.cls || '');
        this.setInfo(`<b>Step ${this.i + 1}/${this.steps.length}: ${esc(s.label)}</b><div style="margin-top:6px">${s.detail || ''}</div>`);
        this.active = null; this.wait = s.pause != null ? s.pause : 1.1;
      };
      const color = s.cls === 'bad' ? this.c.bad : s.cls === 'warn' ? this.c.warn : s.cls === 'ok' ? this.c.ok : s.cls === 'info' ? this.c.info : this.c.accent;
      if (s.from === s.to || s.self) { this.active = { s, t: 0.5, arrive }; this.node(s.from).status = 'active'; }
      else this.active = { s, pkt: this.send(s.via ? [s.from, ...s.via, s.to] : [s.from, s.to], { color, label: s.short || '', speed: 380, onDone: arrive }) };
    }
    update(dt) {
      if (this.active && this.active.t != null) { this.active.t -= dt; if (this.active.t <= 0) this.active.arrive(); return; }
      if (this.active) return;
      this.wait -= dt;
      if (this.wait <= 0) { if (this.done) { this.init(); this.logEl.innerHTML = ''; } this.next(); }
    }
    onStep() { // when paused: complete the current animation instantly and start the next
      if (this.active && this.active.pkt) { this.packets = this.packets.filter(p => p !== this.active.pkt); this.active.pkt.onDone(); }
      else if (this.active) this.active.arrive();
      if (this.done) { this.init(); this.logEl.innerHTML = ''; }
      this.next();
    }
    draw(ctx, c) {
      if (this.cfg.drawBg) this.cfg.drawBg(this, ctx, c);
      this.edges.forEach(e => this.line(e[0], e[1], Object.assign({ arrow: false, color: c.line }, e[2] || {})));
      if (this.active && this.active.s && this.active.s.from !== this.active.s.to) this.line(this.active.s.from, this.active.s.to, { color: hexA(c.accent, .5), width: 2, dash: [5, 5] });
      this.nodes.forEach(n => !n.hidden && this.box(n));
    }
  }

  LAB.Sim = Sim; LAB.SeqSim = SeqSim; LAB.hexA = hexA;
  LAB.defineViz = (id, def) => { LAB.viz[id] = def; };
})();
