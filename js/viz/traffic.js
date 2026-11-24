/* Continuous simulations: load balancing, rate limiting, circuit breaker, Kafka. */
(function () {
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pct = (arr, q) => { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

  /* ============ Load balancer ============ */
  class LoadBalancerSim extends LAB.Sim {
    init() {
      const p = this.params, n = p.servers;
      this.clients = Array.from({ length: 6 }, (_, i) => ({ id: 'c' + i, x: 30, y: 60 + i * 65, w: 70, h: 40, label: '10.0.0.' + (11 + i), info: 'Client IP. With IP-hash, the same client always maps to the same server (until the server set changes).' }));
      this.lb = { id: 'lb', x: 300, y: 205, w: 150, h: 70, label: 'Load balancer', sub: '', info: 'Chooses a backend per request using the selected algorithm. With health checks on, failed servers are removed after ~2s of failed checks.' };
      this.servers = Array.from({ length: n }, (_, i) => ({ id: 's' + i, x: 600, y: 20 + i * (440 / n), w: 170, h: Math.min(52, 440 / n - 8), label: 'Server ' + (i + 1), active: 0, queue: [], handled: 0, errors: 0, dead: false, detected: false, weight: (p.slow && i === 0) ? 1 : 3,
        info: 'Click to kill / revive this instance. Watch requests fail until health checks remove it.' }));
      this.nodes = [...this.clients, this.lb, ...this.servers];
      this.acc = 0; this.rr = 0; this.wrrState = this.servers.map(() => 0); this.lat = []; this.done = 0; this.errs = 0; this.sent = 0;
      this.lb.sub = { rr: 'round robin', wrr: 'weighted round robin', lc: 'least connections', p2c: 'power of two choices', hash: 'IP hash', random: 'random' }[p.algo];
    }
    eligible() { return this.servers.filter(s => !(this.params.hc && s.detected)); }
    pick(clientIdx) {
      const e = this.eligible(); if (!e.length) return null;
      const load = s => s.active + s.queue.length;
      switch (this.params.algo) {
        case 'rr': return e[this.rr++ % e.length];
        case 'wrr': { // smooth weighted round robin (nginx style)
          let best = null, total = 0;
          e.forEach(s => { const i = this.servers.indexOf(s); this.wrrState[i] += s.weight; total += s.weight; if (!best || this.wrrState[i] > this.wrrState[this.servers.indexOf(best)]) best = s; });
          this.wrrState[this.servers.indexOf(best)] -= total; return best;
        }
        case 'lc': return e.reduce((a, b) => (load(b) < load(a) ? b : a));
        case 'p2c': { const a = e[Math.floor(Math.random() * e.length)], b = e[Math.floor(Math.random() * e.length)]; return load(a) <= load(b) ? a : b; }
        case 'hash': return e[(clientIdx * 2654435761 >>> 0) % e.length];
        default: return e[Math.floor(Math.random() * e.length)];
      }
    }
    onClick(x, y, n) {
      if (n && n.id && n.id.startsWith('s')) {
        n.dead = !n.dead; n.detected = false; n.deadAt = this.t;
        if (n.dead) { this.log(`${n.label} crashed`, 'bad'); n.queue.forEach(() => { n.errors++; this.errs++; }); n.queue = []; n.active = 0; }
        else this.log(`${n.label} restarted`, 'ok');
        this.showNode(n); return true;
      }
    }
    update(dt) {
      const p = this.params;
      this.servers.forEach(s => {
        if (s.dead && !s.detected && this.t - s.deadAt > 2 && p.hc) { s.detected = true; this.log(`Health check removed ${s.label} from rotation`, 'warn'); }
        if (!s.dead && s.detected) s.detected = false;
      });
      this.acc += p.rate * dt;
      while (this.acc >= 1) {
        this.acc--; this.sent++;
        const ci = Math.floor(Math.random() * this.clients.length), c = this.clients[ci], s = this.pick(ci);
        const born = this.t;
        if (!s) { this.errs++; this.send([c, this.lb], { color: this.c.bad, r: 4 }); continue; }
        this.send([c, this.lb, s], { r: 4, color: this.c.accent, speed: 650, onDone: () => this.arrive(s, born) });
      }
      this.servers.forEach(s => {
        s.jobs = (s.jobs || []).filter(j => { j.left -= dt; if (j.left <= 0) { this.finish(s, j); return false; } return true; });
        while (!s.dead && s.jobs.length < p.capacity && s.queue.length) this.start(s, s.queue.shift());
        s.active = s.jobs.length;
      });
    }
    arrive(s, born) {
      if (s.dead) { s.errors++; this.errs++; if (Math.random() < 0.3) this.log(`Request to dead ${s.label} failed (502)`, 'bad'); this.send([s, this.lb], { color: this.c.bad, r: 4, speed: 650 }); return; }
      const job = { born };
      if ((s.jobs || []).length < this.params.capacity) this.start(s, job); else s.queue.push(job);
    }
    start(s, j) { j.left = rnd(0.5, 0.9) * ((this.params.slow && s.id === 's0') ? 3 : 1); (s.jobs = s.jobs || []).push(j); }
    finish(s, j) { s.handled++; this.done++; this.lat.push(this.t - j.born); if (this.lat.length > 200) this.lat.shift(); this.send([s, this.lb], { color: this.c.ok, r: 3, speed: 650 }); }
    draw(ctx, c) {
      this.clients.forEach(cl => { this.line(cl, this.lb, { color: c.line, arrow: false }); this.box(cl, { size: 11 }); });
      this.servers.forEach(s => this.line(this.lb, s, { color: s.detected ? LAB.hexA(c.bad, .25) : c.line, dash: s.detected ? [4, 4] : [], arrow: false }));
      this.box(this.lb);
      const total = this.servers.reduce((a, s) => a + s.handled, 0) || 1;
      this.servers.forEach(s => {
        this.box(s, { status: s.dead ? 'down' : (this.params.slow && s.id === 's0') ? 'warn' : undefined });
        const by = s.y + s.h - 12;
        this.bar(s.x + s.w + 10, s.y + 4, 70, 10, s.active / this.params.capacity, s.active >= this.params.capacity ? c.warn : c.accent);
        this.text(s.x + s.w + 84, s.y + 9, `${s.active}/${this.params.capacity}` + (s.queue.length ? ` +${s.queue.length}q` : ''), { size: 10, color: c.muted });
        this.text(s.x + s.w + 10, s.y + 26, `${Math.round(s.handled / total * 100)}% · ${s.handled} ok${s.errors ? ' · ' + s.errors + ' err' : ''}${this.params.algo === 'wrr' ? ' · w=' + s.weight : ''}`, { size: 10, color: s.errors ? c.bad : c.muted });
        if (s.detected) this.text(s.x + s.w / 2, by + 4, 'out of rotation', { size: 10, color: c.bad, align: 'center' });
      });
      const p95 = pct(this.lat, 0.95), p50 = pct(this.lat, 0.5);
      this.text(300, 320, `Completed ${this.done} · errors ${this.errs}`, { size: 12, color: c.text });
      this.text(300, 340, `Latency p50 ${(p50 * 1000).toFixed(0)} ms · p95 ${(p95 * 1000).toFixed(0)} ms`, { size: 12, color: p95 > 1.5 ? c.warn : c.text });
      this.text(300, 360, 'Click a server to crash/restart it', { size: 11, color: c.muted });
    }
  }
  LAB.defineViz('load-balancer', {
    title: 'Load Balancing Algorithms',
    desc: 'Six clients send traffic through a load balancer to N servers. Compare round robin, weighted, least connections, power-of-two-choices, IP hash and random; make one server slow, crash servers and toggle health checks.',
    guide: LAB.md`
### Experiments
1. **Round robin + slow server**: the slow server's queue grows and p95 latency climbs, because RR ignores load.
2. Switch to **least connections** or **power of two choices**: traffic shifts away from the slow server and p95 drops.
3. **Crash a server** with health checks off: requests keep failing (502). Turn health checks on: after ~2s it is removed from rotation.
4. **IP hash**: one client always lands on the same server; with few clients distribution is uneven, and changing the server set remaps clients.`,
    create(el) {
      new LoadBalancerSim(el, {
        title: 'Load balancer', height: 470,
        controls: [
          { id: 'algo', type: 'select', label: 'Algorithm', value: 'rr', reset: true, options: [['rr', 'Round robin'], ['wrr', 'Weighted round robin'], ['lc', 'Least connections'], ['p2c', 'Power of two choices'], ['hash', 'IP hash'], ['random', 'Random']] },
          { id: 'servers', type: 'range', label: 'Servers', min: 2, max: 8, value: 4, reset: true },
          { id: 'rate', type: 'range', label: 'Arrival rate', min: 2, max: 30, value: 10, unit: ' req/s' },
          { id: 'capacity', type: 'range', label: 'Concurrency per server', min: 1, max: 6, value: 3 },
          { id: 'slow', type: 'check', label: 'Server 1 is 3× slower (noisy neighbour / GC)', value: true, reset: true },
          { id: 'hc', type: 'check', label: 'Active health checks', value: true }
        ]
      });
    }
  });

  /* ============ Rate limiter ============ */
  class RateLimiterSim extends LAB.Sim {
    init() {
      this.st = { tokens: this.params.limit, last: 0, queue: [], drainAcc: 0, winStart: 0, count: 0, log: [], prev: 0, cur: 0, curStart: 0 };
      this.acc = 0; this.hist = []; this.bucket = { a: 0, r: 0, t: 0 }; this.allowed = 0; this.rejected = 0;
      this.nodes = [
        { id: 'src', x: 20, y: 190, w: 120, h: 60, label: 'Clients', sub: 'API key k-42', info: 'Incoming requests for one key. Use the burst button to send 15 at once.' },
        { id: 'lim', x: 300, y: 130, w: 300, h: 180, label: '', info: '' },
        { id: 'ok', x: 820, y: 110, w: 150, h: 50, label: 'Backend', sub: 'allowed', info: 'Requests that passed the limiter.' },
        { id: 'no', x: 820, y: 290, w: 150, h: 50, label: '429 Too Many Requests', sub: 'Retry-After', info: 'Rejected requests. A good API returns Retry-After and RateLimit-* headers.' }
      ];
    }
    onButton(b) { if (b === 'burst') for (let i = 0; i < 15; i++) setTimeout(() => this.request(), i * 25); }
    decide() {
      const p = this.params, s = this.st, now = this.t;
      switch (p.algo) {
        case 'token': {
          s.tokens = Math.min(p.limit, s.tokens + (now - s.last) * p.refill); s.last = now;
          if (s.tokens >= 1) { s.tokens -= 1; return 'allow'; } return 'reject';
        }
        case 'leaky': if (s.queue.length < p.limit) { s.queue.push(now); return 'queue'; } return 'reject';
        case 'fixed': {
          const ws = Math.floor(now / p.window) * p.window; if (ws !== s.winStart) { s.winStart = ws; s.count = 0; }
          if (s.count < p.limit) { s.count++; return 'allow'; } return 'reject';
        }
        case 'slog': { s.log = s.log.filter(t => now - t < p.window); if (s.log.length < p.limit) { s.log.push(now); return 'allow'; } return 'reject'; }
        case 'scount': {
          const ws = Math.floor(now / p.window) * p.window;
          if (ws !== s.curStart) { s.prev = (ws - s.curStart === p.window) ? s.cur : 0; s.cur = 0; s.curStart = ws; }
          const w = 1 - (now - ws) / p.window, est = s.prev * w + s.cur;
          if (est < p.limit) { s.cur++; return 'allow'; } return 'reject';
        }
      }
    }
    request() {
      const d = this.decide();
      const lim = this.node('lim');
      this.send([this.node('src'), [lim.x, lim.y + lim.h / 2]], { r: 4, color: this.c.accent, speed: 600, onDone: () => {
        if (d === 'allow') { this.allowed++; this.bucket.a++; this.send([[lim.x + lim.w, lim.y + lim.h / 2], this.node('ok')], { r: 4, color: this.c.ok, speed: 600 }); }
        else if (d === 'reject') { this.rejected++; this.bucket.r++; this.send([[lim.x + lim.w, lim.y + lim.h / 2], this.node('no')], { r: 4, color: this.c.bad, speed: 600 }); }
      } });
    }
    update(dt) {
      const p = this.params, s = this.st;
      this.acc += p.traffic * dt * rnd(0.6, 1.4);
      while (this.acc >= 1) { this.acc--; this.request(); }
      if (p.algo === 'leaky') {
        s.drainAcc += p.refill * dt;
        while (s.drainAcc >= 1 && s.queue.length) { s.drainAcc--; s.queue.shift(); this.allowed++; this.bucket.a++; const lim = this.node('lim'); this.send([[lim.x + lim.w, lim.y + lim.h / 2], this.node('ok')], { r: 4, color: this.c.ok, speed: 600 }); }
        if (!s.queue.length) s.drainAcc = Math.min(s.drainAcc, 1);
      }
      if (p.algo === 'token') { s.tokens = Math.min(p.limit, s.tokens + (this.t - s.last) * p.refill); s.last = this.t; }
      this.bucket.t += dt;
      if (this.bucket.t >= 0.5) { this.hist.push({ a: this.bucket.a, r: this.bucket.r }); if (this.hist.length > 40) this.hist.shift(); this.bucket = { a: 0, r: 0, t: 0 }; }
    }
    draw(ctx, c) {
      const p = this.params, s = this.st, L = this.node('lim');
      ['src', 'ok', 'no'].forEach(id => this.box(this.node(id), { status: id === 'no' ? 'warn' : undefined }));
      this.line(this.node('src'), [L.x, L.y + L.h / 2], { color: c.line }); this.line([L.x + L.w, L.y + L.h / 2], this.node('ok'), { color: c.line }); this.line([L.x + L.w, L.y + L.h / 2], this.node('no'), { color: c.line });
      this.rrect(L.x, L.y, L.w, L.h, 12); ctx.fillStyle = c.panel; ctx.fill(); ctx.strokeStyle = c.accent; ctx.lineWidth = 1.5; ctx.stroke();
      const names = { token: 'Token bucket', leaky: 'Leaky bucket (queue)', fixed: 'Fixed window counter', slog: 'Sliding window log', scount: 'Sliding window counter' };
      this.text(L.x + L.w / 2, L.y + 16, names[p.algo], { bold: true, align: 'center' });
      const ix = L.x + 20, iy = L.y + 36, iw = L.w - 40, ih = L.h - 56;
      if (p.algo === 'token' || p.algo === 'leaky') {
        const level = p.algo === 'token' ? s.tokens / p.limit : s.queue.length / p.limit;
        const bx = L.x + L.w / 2 - 50, bw = 100;
        ctx.strokeStyle = c.text2; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(bx, iy); ctx.lineTo(bx, iy + ih); ctx.lineTo(bx + bw, iy + ih); ctx.lineTo(bx + bw, iy); ctx.stroke();
        ctx.fillStyle = LAB.hexA(p.algo === 'token' ? c.ok : c.warn, .55); ctx.fillRect(bx + 2, iy + ih - ih * level, bw - 4, ih * level);
        this.text(bx + bw + 12, iy + 10, p.algo === 'token' ? `tokens ${s.tokens.toFixed(1)} / ${p.limit}` : `queued ${s.queue.length} / ${p.limit}`, { size: 11 });
        this.text(bx + bw + 12, iy + 28, p.algo === 'token' ? `refill ${p.refill}/s` : `drain ${p.refill}/s`, { size: 11, color: c.muted });
        this.text(bx - 12, iy + 10, p.algo === 'token' ? 'burst capacity' : 'smooths output', { size: 11, color: c.muted, align: 'right' });
      } else if (p.algo === 'fixed') {
        const prog = (this.t % p.window) / p.window;
        this.bar(ix, iy + 10, iw, 14, prog, c.info); this.text(ix, iy + 34, `window ${p.window}s · resets at boundary`, { size: 11, color: c.muted });
        this.bar(ix, iy + 56, iw, 18, s.count / p.limit, s.count >= p.limit ? c.bad : c.ok); this.text(ix, iy + 88, `count ${s.count} / ${p.limit}  (bursts of 2× possible across a boundary)`, { size: 11 });
      } else if (p.algo === 'slog') {
        ctx.strokeStyle = c.line2; ctx.beginPath(); ctx.moveTo(ix, iy + 50); ctx.lineTo(ix + iw, iy + 50); ctx.stroke();
        s.log.forEach(t => { const x = ix + iw - (this.t - t) / p.window * iw; ctx.fillStyle = c.ok; ctx.fillRect(x - 1.5, iy + 36, 3, 28); });
        this.text(ix, iy + 84, `${s.log.length} / ${p.limit} timestamps in the last ${p.window}s (exact, O(limit) memory)`, { size: 11 });
        this.text(ix + iw, iy + 20, 'now', { size: 10, color: c.muted, align: 'right' }); this.text(ix, iy + 20, `-${p.window}s`, { size: 10, color: c.muted });
      } else {
        const ws = Math.floor(this.t / p.window) * p.window, w = 1 - (this.t - ws) / p.window, est = s.prev * w + s.cur;
        this.bar(ix, iy + 6, iw / 2 - 6, 16, Math.min(1, s.prev / p.limit), LAB.hexA(c.info, .6)); this.text(ix, iy + 32, `previous ${s.prev} × weight ${w.toFixed(2)}`, { size: 11, color: c.muted });
        this.bar(ix + iw / 2 + 6, iy + 6, iw / 2 - 6, 16, Math.min(1, s.cur / p.limit), c.ok); this.text(ix + iw / 2 + 6, iy + 32, `current ${s.cur}`, { size: 11, color: c.muted });
        this.bar(ix, iy + 56, iw, 18, Math.min(1, est / p.limit), est >= p.limit ? c.bad : c.accent); this.text(ix, iy + 88, `estimate ${est.toFixed(1)} / ${p.limit}`, { size: 11 });
      }
      // timeline chart
      const gx = 40, gy = 360, gw = 920, gh = 90, bw = gw / 40, mx = Math.max(4, ...this.hist.map(h => h.a + h.r));
      this.text(gx, gy - 12, `Last 20s (0.5s buckets): allowed ${this.allowed} · rejected ${this.rejected}`, { size: 11, color: c.muted });
      ctx.strokeStyle = c.line; ctx.strokeRect(gx, gy, gw, gh);
      this.hist.forEach((h, i) => { const x = gx + i * bw + 1, ha = h.a / mx * gh, hr = h.r / mx * gh; ctx.fillStyle = c.ok; ctx.fillRect(x, gy + gh - ha, bw - 2, ha); ctx.fillStyle = c.bad; ctx.fillRect(x, gy + gh - ha - hr, bw - 2, hr); });
    }
  }
  LAB.defineViz('rate-limiter', {
    title: 'Rate Limiter Algorithms',
    desc: 'Feed steady or bursty traffic into token bucket, leaky bucket, fixed window, sliding window log and sliding window counter limiters and compare what gets through.',
    guide: LAB.md`
### Experiments
1. **Token bucket**, traffic below refill rate, then press **Burst**: the bucket absorbs the burst up to capacity, then rejects.
2. **Leaky bucket**: the same burst is queued and released at a constant rate; output is smooth but latency increases.
3. **Fixed window**: watch the counter reset at the boundary; a burst at the end of one window plus the start of the next lets through up to 2× the limit.
4. **Sliding log** is exact but stores one timestamp per allowed request; **sliding counter** approximates with two numbers.`,
    create(el) {
      new RateLimiterSim(el, {
        title: 'Rate limiter for one API key', height: 470,
        controls: [
          { id: 'algo', type: 'select', label: 'Algorithm', value: 'token', reset: true, options: [['token', 'Token bucket'], ['leaky', 'Leaky bucket'], ['fixed', 'Fixed window'], ['slog', 'Sliding window log'], ['scount', 'Sliding window counter']] },
          { id: 'limit', type: 'range', label: 'Capacity / limit', min: 3, max: 20, value: 8, reset: true },
          { id: 'refill', type: 'range', label: 'Refill / drain rate', min: 0.5, max: 10, step: 0.5, value: 2, unit: '/s' },
          { id: 'window', type: 'range', label: 'Window (window algorithms)', min: 1, max: 10, value: 4, unit: 's', reset: true },
          { id: 'traffic', type: 'range', label: 'Incoming traffic', min: 0, max: 15, step: 0.5, value: 2.5, unit: ' req/s' },
          { type: 'buttons', buttons: [['burst', 'Send burst of 15']] }
        ]
      });
    }
  });

  /* ============ Circuit breaker ============ */
  class BreakerSim extends LAB.Sim {
    init() {
      this.state = 'CLOSED'; this.window = []; this.openedAt = 0; this.halfAllowed = 0; this.halfResults = []; this.pending = [];
      this.acc = 0; this.stats = { calls: 0, ok: 0, fail: 0, rejected: 0, fallback: 0 }; this.timeline = []; this.tlAcc = 0;
      this.nodes = [
        { id: 'caller', x: 20, y: 180, w: 150, h: 64, label: 'Order service', sub: 'caller', info: 'Calls the KYC/payment dependency through a Resilience4j circuit breaker with a 2s timeout.' },
        { id: 'dep', x: 820, y: 180, w: 160, h: 64, label: 'Dependency', sub: 'e.g. payment provider', info: 'Use the sliders to change its failure rate and latency.' }
      ];
      this.circles = { CLOSED: [360, 120], OPEN: [640, 120], HALF_OPEN: [500, 300] };
    }
    rate() { const w = this.window; return w.length ? w.filter(x => !x).length / w.length : 0; }
    transition(to, why) { this.state = to; this.log(`→ ${to.replace('_', '-')}: ${why}`, to === 'OPEN' ? 'bad' : to === 'CLOSED' ? 'ok' : 'warn'); if (to === 'OPEN') this.openedAt = this.t; if (to === 'HALF_OPEN') { this.halfAllowed = 0; this.halfResults = []; } if (to === 'CLOSED') this.window = []; }
    call() {
      const p = this.params; this.stats.calls++;
      const caller = this.node('caller'), dep = this.node('dep'), brk = [500, 211];
      if (this.state === 'OPEN' || (this.state === 'HALF_OPEN' && this.halfAllowed >= p.half)) {
        this.stats.rejected++; if (p.fallback) this.stats.fallback++;
        this.send([caller, brk], { r: 4, color: this.c.warn, speed: 700, onDone: () => this.send([brk, caller], { r: 4, color: this.c.warn, speed: 700 }) });
        return;
      }
      if (this.state === 'HALF_OPEN') this.halfAllowed++;
      const lat = Math.min(2000, p.latency * rnd(0.7, 1.3)), timedOut = p.latency * 1.0 > 2000 && lat >= 2000;
      const ok = !timedOut && Math.random() * 100 >= p.fail;
      const slow = lat > 1000;
      const st = this.state;
      this.send([caller, brk, dep], { r: 4, color: this.c.accent, speed: 700, onDone: () => {
        setTimeout(() => {}, 0);
        this.pending = (this.pending || []); this.pending.push({ at: this.t + lat / 1000, ok: ok && !slow, slow, timedOut, st });
      } });
    }
    record(res) {
      const p = this.params; const success = res.ok;
      if (res.st === 'HALF_OPEN' && this.state === 'HALF_OPEN') {
        this.halfResults.push(success);
        if (!success) this.transition('OPEN', 'trial call failed in half-open');
        else if (this.halfResults.length >= p.half) this.transition('CLOSED', `${p.half} trial calls succeeded`);
      } else if (this.state === 'CLOSED') {
        this.window.push(success); if (this.window.length > p.size) this.window.shift();
        if (this.window.length >= p.min && this.rate() * 100 >= p.threshold) this.transition('OPEN', `failure rate ${(this.rate() * 100).toFixed(0)}% ≥ ${p.threshold}% over ${this.window.length} calls`);
      }
      success ? this.stats.ok++ : this.stats.fail++;
    }
    update(dt) {
      const p = this.params;
      if (this.state === 'OPEN' && this.t - this.openedAt >= p.wait) this.transition('HALF_OPEN', `wait duration ${p.wait}s elapsed`);
      this.acc += p.rate * dt; while (this.acc >= 1) { this.acc--; this.call(); }
      (this.pending || []).filter(x => x.at <= this.t).forEach(x => {
        this.pending.splice(this.pending.indexOf(x), 1); this.record(x);
        const col = x.ok ? this.c.ok : this.c.bad;
        this.send([this.node('dep'), [500, 211], this.node('caller')], { r: 4, color: col, speed: 700 });
        if (!x.ok && Math.random() < 0.25) this.log(x.timedOut ? 'call timed out (2s)' : x.slow ? 'slow call (>1s) counted as failure' : 'dependency returned 503', 'bad');
      });
      this.tlAcc += dt; if (this.tlAcc > 0.25) { this.tlAcc = 0; this.timeline.push(this.state); if (this.timeline.length > 160) this.timeline.shift(); }
    }
    draw(ctx, c) {
      const p = this.params;
      this.box(this.node('caller')); this.box(this.node('dep'), { status: p.fail >= 50 || p.latency > 2000 ? 'down' : p.fail > 10 || p.latency > 1000 ? 'warn' : 'ok' });
      this.line(this.node('caller'), [430, 211], { color: c.line, arrow: false }); this.line([570, 211], this.node('dep'), { color: this.state === 'OPEN' ? LAB.hexA(c.bad, .3) : c.line, dash: this.state === 'OPEN' ? [5, 5] : [] });
      const cols = { CLOSED: c.ok, OPEN: c.bad, HALF_OPEN: c.warn };
      const [a, b, h] = [this.circles.CLOSED, this.circles.OPEN, this.circles.HALF_OPEN];
      this.line(a, b, { color: c.line2, label: 'failure rate ≥ threshold' }); this.line([b[0] - 20, b[1] + 30], [h[0] + 30, h[1] - 25], { color: c.line2, label: 'wait elapsed' });
      this.line([h[0] - 30, h[1] - 25], [a[0] + 20, a[1] + 30], { color: c.line2, label: 'trials succeed' });
      Object.entries(this.circles).forEach(([k, [x, y]]) => {
        const on = this.state === k; this.circle(x, y, 44, on ? LAB.hexA(cols[k], .25) : c.panel, on ? cols[k] : c.line2);
        this.text(x, y - 6, k.replace('_', '-'), { bold: true, align: 'center', color: on ? cols[k] : c.text2 });
        this.text(x, y + 12, k === 'CLOSED' ? `fail ${(this.rate() * 100).toFixed(0)}% (${this.window.length})` : k === 'OPEN' ? (on ? `${Math.max(0, p.wait - (this.t - this.openedAt)).toFixed(1)}s left` : 'fail fast') : `trials ${this.halfResults ? this.halfResults.length : 0}/${p.half}`, { size: 10, align: 'center', color: c.muted });
      });
      // window
      const wx = 40, wy = 380; this.text(wx, wy - 12, `Sliding window (last ${p.size} calls)`, { size: 11, color: c.muted });
      for (let i = 0; i < p.size; i++) { const v = this.window[i]; this.rrect(wx + i * 18, wy, 14, 14, 3); ctx.fillStyle = v === undefined ? c.panel2 : v ? c.ok : c.bad; ctx.fill(); }
      // timeline
      const tx = 40, ty = 430, tw = 920; this.text(tx, ty - 10, 'State over time', { size: 11, color: c.muted });
      this.timeline.forEach((s, i) => { ctx.fillStyle = cols[s]; ctx.fillRect(tx + i * (tw / 160), ty, tw / 160 + .5, 14); });
      const s = this.stats;
      this.text(620, 380, `calls ${s.calls} · success ${s.ok} · failed ${s.fail}`, { size: 12 });
      this.text(620, 398, `rejected fast ${s.rejected}${p.fallback ? ' (served fallback)' : ''}`, { size: 12, color: c.warn });
    }
  }
  LAB.defineViz('circuit-breaker', {
    title: 'Circuit Breaker State Machine',
    desc: 'Drive a Resilience4j-style breaker with a dependency whose failure rate and latency you control. Watch CLOSED -> OPEN -> HALF-OPEN transitions, the sliding window and fast-failed calls.',
    guide: LAB.md`
### Experiments
1. Raise **dependency failure rate** to 60%: once the window has the minimum number of calls and the failure rate passes the threshold, the breaker opens and calls fail fast (orange).
2. After the **wait duration** it goes half-open and lets a few trial calls through. Lower the failure rate to 0% to watch it close.
3. Set **latency** above 1000 ms: slow calls count as failures (slow-call threshold) even when the dependency eventually answers. Above 2000 ms the 2s timeout fires.
4. Increase **minimum calls** to see how it avoids tripping on a handful of errors.`,
    create(el) {
      new BreakerSim(el, {
        title: 'Circuit breaker', height: 470,
        controls: [
          { id: 'fail', type: 'range', label: 'Dependency failure rate', min: 0, max: 100, value: 10, unit: '%' },
          { id: 'latency', type: 'range', label: 'Dependency latency', min: 50, max: 3000, step: 50, value: 200, unit: ' ms' },
          { id: 'rate', type: 'range', label: 'Request rate', min: 1, max: 15, value: 6, unit: '/s' },
          { id: 'threshold', type: 'range', label: 'Failure-rate threshold', min: 10, max: 90, step: 5, value: 50, unit: '%' },
          { id: 'size', type: 'range', label: 'Sliding window size', min: 5, max: 40, value: 20, reset: true },
          { id: 'min', type: 'range', label: 'Minimum number of calls', min: 2, max: 20, value: 8 },
          { id: 'wait', type: 'range', label: 'Wait in OPEN', min: 1, max: 15, value: 5, unit: 's' },
          { id: 'half', type: 'range', label: 'Calls permitted in HALF-OPEN', min: 1, max: 5, value: 3 },
          { id: 'fallback', type: 'check', label: 'Fallback enabled', value: true }
        ]
      });
    }
  });

  /* ============ Kafka ============ */
  class KafkaSim extends LAB.Sim {
    init() {
      const p = this.params;
      this.parts = Array.from({ length: p.partitions }, (_, i) => ({ id: 'p' + i, x: 260, y: 30 + i * (400 / p.partitions), w: 420, h: Math.min(40, 400 / p.partitions - 8), label: '', end: 0, committed: 0, recent: [], info: `Partition ${i}: an ordered, append-only log. Messages with the same key always land here (hash(key) % partitions).` }));
      this.producers = [0, 1, 2].map(i => ({ id: 'pr' + i, x: 20, y: 60 + i * 140, w: 150, h: 50, label: ['Order svc', 'Payment svc', 'Inventory svc'][i], sub: 'producer', info: 'acks=all, idempotent producer. Key = aggregate id (e.g. orderId) to preserve per-entity ordering.' }));
      this.consumers = Array.from({ length: p.consumers }, (_, i) => ({ id: 'cs' + i, x: 800, y: 30 + i * (400 / p.consumers), w: 170, h: Math.min(44, 400 / p.consumers - 8), label: 'consumer-' + (i + 1), sub: '', dead: false, assigned: [], busy: 0, info: 'Member of consumer group "billing". Click to crash it and trigger a rebalance.' }));
      this.nodes = [...this.producers, ...this.parts, ...this.consumers];
      this.acc = 0; this.rebalanceUntil = 0; this.assign(); this.keys = Array.from({ length: 12 }, (_, i) => 'order-' + (1000 + i * 7));
    }
    assign() {
      const alive = this.consumers.filter(c => !c.dead); this.consumers.forEach(c => c.assigned = []);
      if (!alive.length) return;
      this.parts.forEach((pt, i) => { const c = alive[i % alive.length]; c.assigned.push(pt); pt.owner = c; });  // round-robin assignment
      alive.forEach(c => c.sub = c.assigned.length ? 'P' + c.assigned.map(x => x.id.slice(1)).join(', P') : 'idle (no partition)');
    }
    onClick(x, y, n) {
      if (n && n.id.startsWith('cs')) {
        n.dead = !n.dead; this.log(n.dead ? `${n.label} crashed: group rebalance (consumption paused)` : `${n.label} rejoined: rebalance`, n.dead ? 'bad' : 'ok');
        this.rebalanceUntil = this.t + 1.5; this.parts.forEach(pt => pt.owner = null); this.consumers.forEach(c => { c.assigned = []; if (!c.dead) c.sub = 'rebalancing…'; else c.sub = 'down'; });
        setTimeout(() => {}, 0); this.pendingAssign = true; return true;
      }
    }
    hash(k) { let h = 0; for (const ch of k) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h); }
    update(dt) {
      const p = this.params;
      if (this.pendingAssign && this.t >= this.rebalanceUntil) { this.pendingAssign = false; this.assign(); this.log('Rebalance complete: partitions reassigned', 'info'); }
      this.acc += p.prod * dt;
      while (this.acc >= 1) {
        this.acc--;
        const key = p.skew && Math.random() < 0.6 ? 'order-HOT' : this.keys[Math.floor(Math.random() * this.keys.length)];
        const pt = this.parts[this.hash(key) % this.parts.length], pr = this.producers[Math.floor(Math.random() * 3)];
        this.send([pr, [pt.x, pt.y + pt.h / 2]], { r: 4, speed: 700, color: key === 'order-HOT' ? this.c.warn : this.c.accent, onDone: () => { pt.recent.push(key === 'order-HOT'); if (pt.recent.length > 18) pt.recent.shift(); pt.end++; } });
      }
      if (this.t < this.rebalanceUntil) return;
      this.consumers.forEach(c => {
        if (c.dead || !c.assigned.length) return;
        c.busy += p.cons * dt;
        while (c.busy >= 1) {
          const pt = c.assigned.filter(x => x.committed < x.end).sort((a, b) => (b.end - b.committed) - (a.end - a.committed))[0];
          if (!pt) { c.busy = 0; break; }
          c.busy--; pt.committed++;
          this.send([[pt.x + pt.w, pt.y + pt.h / 2], c], { r: 3, speed: 800, color: this.c.ok });
        }
      });
    }
    draw(ctx, c) {
      const p = this.params;
      this.producers.forEach(pr => this.box(pr));
      this.text(470, 14, `Topic orders.events · ${p.partitions} partitions · group "billing"`, { size: 11, color: c.muted, align: 'center' });
      this.parts.forEach((pt, i) => {
        if (pt.owner) this.line([pt.x + pt.w, pt.y + pt.h / 2], pt.owner, { color: LAB.hexA(c.accent, .35), arrow: false });
        this.rrect(pt.x, pt.y, pt.w, pt.h, 6); ctx.fillStyle = c.panel; ctx.fill(); ctx.strokeStyle = c.line2; ctx.lineWidth = 1; ctx.stroke();
        this.text(pt.x + 8, pt.y + pt.h / 2, 'P' + i, { bold: true, size: 12 });
        const cw = 16; pt.recent.forEach((hot, j) => { const x = pt.x + 36 + j * (cw + 2); const consumed = (pt.end - pt.recent.length + j) < pt.committed; this.rrect(x, pt.y + 6, cw, pt.h - 12, 3); ctx.fillStyle = consumed ? LAB.hexA(c.ok, .35) : hot ? c.warn : LAB.hexA(c.accent, .7); ctx.fill(); });
        const lag = pt.end - pt.committed;
        this.text(pt.x + pt.w - 8, pt.y + pt.h / 2, `offset ${pt.end} · lag ${lag}`, { size: 11, align: 'right', color: lag > 20 ? c.bad : lag > 8 ? c.warn : c.muted });
      });
      this.consumers.forEach(cs => this.box(cs, { status: cs.dead ? 'down' : !cs.assigned.length && this.t >= this.rebalanceUntil ? 'warn' : undefined, size: 12 }));
      const totalLag = this.parts.reduce((a, pt) => a + pt.end - pt.committed, 0);
      this.text(260, 455, `Total lag ${totalLag}${this.t < this.rebalanceUntil ? ' · REBALANCING (stop-the-world)' : ''}`, { size: 12, color: this.t < this.rebalanceUntil ? c.warn : totalLag > 40 ? c.bad : c.text });
    }
  }
  LAB.defineViz('kafka', {
    title: 'Kafka: Producers, Partitions, Consumer Groups',
    desc: 'Producers write keyed messages to partitions; a consumer group splits partitions among its members. Change partition and consumer counts, skew keys, crash consumers and watch lag and rebalances.',
    guide: LAB.md`
### Experiments
1. Set **consumers > partitions**: the extra consumers are idle. Parallelism is capped by partition count.
2. Increase **produce rate** above total consumption: lag grows on every partition.
3. Enable **hot key skew**: 60% of messages share one key, so one partition (orange) lags while others are idle. Adding consumers does not help; fix the key design.
4. **Click a consumer** to crash it: the group rebalances (consumption pauses), then its partitions move to surviving members.
5. Ordering is guaranteed only **within a partition**, which is why messages for the same order id share a key.`,
    create(el) {
      new KafkaSim(el, {
        title: 'Kafka consumer group', height: 470,
        controls: [
          { id: 'partitions', type: 'range', label: 'Partitions', min: 1, max: 8, value: 4, reset: true },
          { id: 'consumers', type: 'range', label: 'Consumers in group', min: 1, max: 8, value: 3, reset: true },
          { id: 'prod', type: 'range', label: 'Produce rate', min: 1, max: 40, value: 12, unit: ' msg/s' },
          { id: 'cons', type: 'range', label: 'Consume rate per consumer', min: 1, max: 20, value: 5, unit: ' msg/s' },
          { id: 'skew', type: 'check', label: 'Hot key skew (60% one key)', value: false }
        ]
      });
    }
  });
})();
