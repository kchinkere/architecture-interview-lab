/* Data-layer simulations: Redis caching, replication & failover, sharding, node failure / quorum / Raft. */
(function () {
  const rnd = (a, b) => a + Math.random() * (b - a);
  const mix = x => { x = Math.imul(x ^ (x >>> 16), 0x7feb352d); x = Math.imul(x ^ (x >>> 15), 0x846ca68b); return ((x ^ (x >>> 16)) >>> 0) / 4294967296; };

  /* ============ Redis cache ============ */
  class CacheSim extends LAB.Sim {
    init() {
      this.nodes = [
        { id: 'app', x: 30, y: 195, w: 150, h: 70, label: 'Product service', sub: 'Spring @Cacheable', info: 'Reads and writes product data. Strategy controls who updates the cache and when.' },
        { id: 'redis', x: 380, y: 30, w: 260, h: 380, label: '', info: 'Redis with a small max-memory: when full, the least recently used key is evicted (allkeys-lru). Each key has a TTL.' },
        { id: 'db', x: 820, y: 195, w: 150, h: 70, label: 'PostgreSQL', sub: 'source of truth', info: 'Every cache miss costs a database read. Watch DB reads during a stampede.' }
      ];
      this.cache = new Map(); this.inflight = new Map(); this.acc = 0; this.flushAcc = 0;
      this.s = { hit: 0, miss: 0, dbR: 0, dbW: 0, ev: 0, lost: 0 };
      this.keys = Array.from({ length: 15 }, (_, i) => 'product:' + (i + 1));
      this.weights = this.keys.map((_, i) => 1 / (i + 1)); this.wsum = this.weights.reduce((a, b) => a + b, 0);
    }
    pickKey() { let r = Math.random() * this.wsum; for (let i = 0; i < this.keys.length; i++) { r -= this.weights[i]; if (r <= 0) return this.keys[i]; } return this.keys[0]; }
    rpos() { const r = this.node('redis'); return [r.x, r.y + r.h / 2]; }
    put(k, dirty) {
      const p = this.params;
      if (!this.cache.has(k) && this.cache.size >= p.capacity) {
        const lru = [...this.cache.entries()].sort((a, b) => a[1].used - b[1].used)[0];
        if (lru[1].dirty) { this.s.dbW++; this.log(`evicting dirty ${lru[0]}: written to DB first`, 'warn'); }
        this.cache.delete(lru[0]); this.s.ev++; this.log(`LRU evicted ${lru[0]}`, 'info');
      }
      this.cache.set(k, { exp: this.t + p.ttl * rnd(0.85, 1.15), used: this.t, dirty: !!dirty });
    }
    read(k) {
      const app = this.node('app'), db = this.node('db');
      this.send([app, this.rpos()], { r: 4, speed: 700, onDone: () => {
        const e = this.cache.get(k);
        if (e && e.exp > this.t) { e.used = this.t; this.s.hit++; this.send([this.rpos(), app], { r: 4, speed: 700, color: this.c.ok }); return; }
        if (e) this.cache.delete(k);
        this.s.miss++;
        this.send([this.rpos(), app], { r: 4, speed: 700, color: this.c.bad, onDone: () => {
          if (this.params.coalesce && this.inflight.has(k)) { this.inflight.get(k).push(1); return; }   // single-flight: wait for in-flight load
          this.inflight.set(k, []);
          this.send([app, db], { r: 4, speed: 600, color: this.c.warn, onDone: () => {
            this.s.dbR++;
            this.send([db, app], { r: 4, speed: 600, color: this.c.warn, onDone: () => {
              this.inflight.delete(k);
              this.send([app, this.rpos()], { r: 4, speed: 700, color: this.c.info, onDone: () => this.put(k) });
            } });
          } });
        } });
      } });
    }
    write(k) {
      const app = this.node('app'), db = this.node('db'), st = this.params.strategy;
      if (st === 'aside') {
        this.send([app, db], { r: 5, speed: 600, color: this.c.accent2, shape: 'square', onDone: () => { this.s.dbW++; this.send([app, this.rpos()], { r: 5, speed: 700, color: this.c.accent2, shape: 'square', onDone: () => { this.cache.delete(k); } }); } });
      } else if (st === 'through') {
        this.send([app, this.rpos()], { r: 5, speed: 700, color: this.c.accent2, shape: 'square', onDone: () => { this.put(k); this.send([this.rpos(), db], { r: 5, speed: 600, color: this.c.accent2, shape: 'square', onDone: () => this.s.dbW++ }); } });
      } else {
        this.send([app, this.rpos()], { r: 5, speed: 700, color: this.c.accent2, shape: 'square', onDone: () => this.put(k, true) });
      }
    }
    onButton(b) {
      if (b === 'stampede') {
        const k = this.keys[0]; this.cache.delete(k); this.log(`${k} expired while hot: 12 concurrent reads`, 'warn');
        for (let i = 0; i < 12; i++) setTimeout(() => this.read(k), i * 15);
      } else if (b === 'crash') {
        const dirty = [...this.cache.values()].filter(e => e.dirty).length;
        this.cache.clear(); this.log('Redis restarted: cache empty' + (dirty ? `, ${dirty} write-behind updates LOST` : ''), dirty ? 'bad' : 'warn'); this.s.lost += dirty;
      }
    }
    update(dt) {
      const p = this.params;
      this.acc += p.rate * dt;
      while (this.acc >= 1) { this.acc--; const k = this.pickKey(); (Math.random() * 100 < p.writes ? this.write(k) : this.read(k)); }
      for (const [k, e] of this.cache) if (e.exp <= this.t) { if (e.dirty) { this.s.dbW++; } this.cache.delete(k); }
      if (p.strategy === 'behind') {
        this.flushAcc += dt;
        if (this.flushAcc >= 3) { this.flushAcc = 0; const d = [...this.cache.entries()].filter(([, e]) => e.dirty); if (d.length) { d.forEach(([, e]) => e.dirty = false); this.s.dbW++; this.send([this.rpos(), this.node('db')], { r: 6, color: this.c.accent2, shape: 'square', speed: 500 }); this.log(`write-behind flush: ${d.length} keys in one batch`, 'info'); } }
      }
    }
    draw(ctx, c) {
      const p = this.params, R = this.node('redis');
      this.box(this.node('app')); this.box(this.node('db'));
      this.line(this.node('app'), this.rpos(), { color: c.line, arrow: false }); this.line(this.node('app'), this.node('db'), { color: c.line, arrow: false, dash: [4, 4] });
      if (p.strategy !== 'aside') this.line([R.x + R.w, R.y + R.h / 2], this.node('db'), { color: c.line, arrow: false });
      this.rrect(R.x, R.y, R.w, R.h, 12); ctx.fillStyle = c.panel; ctx.fill(); ctx.strokeStyle = '#d6453d'; ctx.lineWidth = 1.6; ctx.stroke();
      this.text(R.x + R.w / 2, R.y + 16, `Redis · ${this.cache.size}/${p.capacity} keys · LRU`, { bold: true, align: 'center' });
      const rows = [...this.cache.entries()].sort((a, b) => b[1].used - a[1].used);
      rows.forEach(([k, e], i) => {
        const y = R.y + 36 + i * 28; if (y > R.y + R.h - 20) return;
        this.text(R.x + 12, y + 8, k, { size: 11, mono: true, color: e.dirty ? c.warn : c.text });
        this.bar(R.x + 120, y + 2, 110, 10, (e.exp - this.t) / (p.ttl * 1.15), e.dirty ? c.warn : c.info);
        if (e.dirty) this.text(R.x + R.w - 10, y + 8, 'dirty', { size: 9, color: c.warn, align: 'right' });
      });
      const s = this.s, total = s.hit + s.miss;
      const lines = [`hit ratio ${total ? (s.hit / total * 100).toFixed(0) : 0}% (${s.hit}/${total})`, `DB reads ${s.dbR} · DB writes ${s.dbW}`, `evictions ${s.ev}${s.lost ? ' · lost writes ' + s.lost : ''}`];
      lines.forEach((l, i) => this.text(690, 330 + i * 20, l, { size: 12, color: i === 2 && s.lost ? c.bad : c.text }));
      this.text(30, 300, '● read  ■ write', { size: 11, color: c.muted });
      this.text(30, 320, 'green = hit · red = miss · orange = DB', { size: 11, color: c.muted });
    }
  }
  LAB.defineViz('redis-cache', {
    title: 'Redis Caching Strategies',
    desc: 'Cache-aside, write-through and write-behind in front of PostgreSQL, with TTLs, LRU eviction, Zipf-distributed hot keys, cache stampedes and Redis restarts.',
    guide: LAB.md`
### Experiments
1. Start with **cache-aside**: misses fall through to the DB and populate the cache; writes go to the DB and **delete** the key.
2. Reduce **capacity** to 4: LRU evictions rise and the hit ratio drops; hot keys (product:1, product:2) survive.
3. Press **Stampede** with single-flight off: 12 concurrent misses all hit the DB. Turn **single-flight** on and repeat: only one DB read.
4. **Write-behind** batches DB writes (fewer DB writes) but press **Crash Redis**: dirty updates not yet flushed are lost.
5. **Write-through** keeps cache and DB in step on every write at the cost of write latency.`,
    create(el) {
      new CacheSim(el, {
        title: 'Cache in front of the database', height: 440,
        controls: [
          { id: 'strategy', type: 'seg', label: 'Write strategy', value: 'aside', options: [['aside', 'Cache-aside'], ['through', 'Write-through'], ['behind', 'Write-behind']] },
          { id: 'capacity', type: 'range', label: 'Cache capacity (keys)', min: 3, max: 12, value: 6 },
          { id: 'ttl', type: 'range', label: 'TTL', min: 2, max: 30, value: 10, unit: 's' },
          { id: 'rate', type: 'range', label: 'Request rate', min: 1, max: 15, value: 5, unit: '/s' },
          { id: 'writes', type: 'range', label: 'Write share', min: 0, max: 50, value: 10, unit: '%' },
          { id: 'coalesce', type: 'check', label: 'Single-flight (request coalescing) on miss', value: false },
          { type: 'buttons', buttons: [['stampede', 'Stampede on hot key'], ['crash', 'Crash / restart Redis']] }
        ]
      });
    }
  });

  /* ============ Replication & failover ============ */
  class ReplicationSim extends LAB.Sim {
    init() {
      this.db = [
        { id: 'n0', x: 390, y: 190, w: 180, h: 74, label: 'node-a', v: 0, down: false, info: 'Click to crash this node.' },
        { id: 'n1', x: 760, y: 70, w: 180, h: 74, label: 'node-b', v: 0, down: false, info: 'Click to crash this node.' },
        { id: 'n2', x: 760, y: 320, w: 180, h: 74, label: 'node-c', v: 0, down: false, info: 'Click to crash this node.' }];
      this.primary = 0; this.version = 0; this.acked = 0; this.lostTotal = 0;
      this.writer = { id: 'w', x: 20, y: 80, w: 140, h: 54, label: 'Writer', sub: 'UPDATE profile', info: 'Issues writes to the current primary.' };
      this.reader = { id: 'r', x: 20, y: 330, w: 140, h: 54, label: 'Reader', sub: 'GET profile', info: 'Reads from replicas (or primary within the read-your-writes window).' };
      this.nodes = [this.writer, this.reader, ...this.db];
      this.wacc = 0; this.racc = 0; this.stale = 0; this.reads = 0; this.lastWrite = -99; this.failoverAt = null;
    }
    prim() { return this.db[this.primary]; }
    onClick(x, y, n) {
      if (n && n.id.startsWith('n')) {
        n.down = !n.down;
        if (n.down) { this.log(`${n.label} crashed`, 'bad'); if (this.db.indexOf(n) === this.primary) { this.failoverAt = this.t + 1.5; this.log('Primary lost: writes fail until failover', 'warn'); } }
        else { n.v = this.prim().v; this.log(`${n.label} rejoined as replica (resynced to v${n.v})`, 'ok'); }
        return true;
      }
    }
    doWrite() {
      const P = this.prim(); if (P.down) { this.log('write rejected: no primary', 'bad'); return; }
      const v = ++this.version, mode = this.params.mode, start = this.t, lag = this.params.lag;
      this.send([this.writer, P], { r: 5, speed: 700, color: this.c.accent2, shape: 'square', onDone: () => {
        if (P.down) return;
        P.v = Math.max(P.v, v);
        const reps = this.db.filter(n => n !== P && !n.down);
        let acks = 0; const need = mode === 'sync' ? reps.length : mode === 'semi' ? Math.min(1, reps.length) : 0;
        const ack = () => { this.acked = Math.max(this.acked, v); this.lastWrite = this.t; this.send([P, this.writer], { r: 4, speed: 700, color: this.c.ok }); this.log(`write v${v} acknowledged after ${((this.t - start) * 1000).toFixed(0)} ms (${mode})`, 'ok'); };
        if (need === 0) ack();
        reps.forEach(n => {
          const d = Math.hypot(n.x - P.x, n.y - P.y);
          this.send([P, n], { r: 3, color: this.c.info, speed: d / Math.max(0.15, lag), onDone: () => { if (!n.down) n.v = Math.max(n.v, v); if (++acks === need) ack(); } });
        });
      } });
    }
    doRead() {
      const ryw = this.params.ryw && this.t - this.lastWrite < 3;
      const cands = this.db.filter(n => !n.down && (ryw ? n === this.prim() : n !== this.prim()));
      const n = cands[Math.floor(Math.random() * cands.length)] || this.prim(); if (!n || n.down) return;
      this.send([this.reader, n], { r: 4, speed: 800, onDone: () => {
        this.reads++; const stale = n.v < this.acked;
        if (stale) { this.stale++; this.log(`stale read from ${n.label}: v${n.v} < acknowledged v${this.acked}`, 'warn'); }
        this.send([n, this.reader], { r: 4, speed: 800, color: stale ? this.c.warn : this.c.ok });
      } });
    }
    update(dt) {
      const p = this.params;
      if (this.failoverAt && this.t >= this.failoverAt) {
        this.failoverAt = null;
        const cands = this.db.filter(n => !n.down);
        if (cands.length) {
          const best = cands.reduce((a, b) => (b.v > a.v ? b : a)); this.primary = this.db.indexOf(best);
          const lost = this.acked - best.v; this.log(`Failover: promoted ${best.label} (v${best.v})`, 'info');
          if (lost > 0) { this.lostTotal += lost; this.log(`${lost} acknowledged write(s) LOST (were only on the old primary)`, 'bad'); this.acked = best.v; }
          this.version = best.v;
        }
      }
      this.wacc += p.wrate * dt; while (this.wacc >= 1) { this.wacc--; this.doWrite(); }
      this.racc += 2 * dt; while (this.racc >= 1) { this.racc--; this.doRead(); }
    }
    draw(ctx, c) {
      this.box(this.writer); this.box(this.reader);
      const P = this.prim();
      this.db.forEach(n => { if (n !== P) this.line(P, n, { color: c.line, dash: this.params.mode === 'async' ? [5, 5] : [], label: this.params.mode === 'sync' ? 'sync' : this.params.mode === 'semi' ? 'semi-sync' : 'async' }); });
      this.line(this.writer, P, { color: c.line, arrow: false });
      this.db.forEach(n => {
        n.sub = (n === P ? 'PRIMARY' : 'replica') + ` · v${n.v}` + (n !== P && n.v < this.acked ? ` (lag ${this.acked - n.v})` : '');
        this.box(n, { status: n.down ? 'down' : n === P ? 'active' : n.v < this.acked ? 'warn' : 'ok' });
      });
      this.text(200, 230, `acknowledged up to v${this.acked}`, { size: 12 });
      this.text(200, 250, `reads ${this.reads} · stale ${this.stale}`, { size: 12, color: this.stale ? c.warn : c.text });
      this.text(200, 270, `lost acknowledged writes ${this.lostTotal}`, { size: 12, color: this.lostTotal ? c.bad : c.text });
      if (this.failoverAt) this.text(480, 290, 'detecting failure… electing new primary', { size: 12, color: c.warn, align: 'center' });
    }
  }
  LAB.defineViz('replication', {
    title: 'Database Replication & Failover',
    desc: 'A primary with two replicas. Compare synchronous, semi-synchronous and asynchronous replication: write latency, stale reads from lagging replicas, and acknowledged writes lost on failover.',
    guide: LAB.md`
### Experiments
1. **Async** with lag 2s: writes are acknowledged fast, but reads from replicas are often stale (orange).
2. Turn on **read-your-writes**: reads right after a write go to the primary, eliminating stale reads for the writer's session.
3. With **async**, crash the primary (click it) right after a write: failover promotes the most up-to-date replica, but acknowledged writes that never reached it are **lost**.
4. Switch to **sync** and repeat: write latency rises (waits for replicas) but no acknowledged write is lost. **Semi-sync** waits for one replica: a middle ground.`,
    create(el) {
      new ReplicationSim(el, {
        title: 'Primary / replica replication', height: 430,
        controls: [
          { id: 'mode', type: 'seg', label: 'Replication mode', value: 'async', options: [['sync', 'Sync'], ['semi', 'Semi-sync'], ['async', 'Async']] },
          { id: 'lag', type: 'range', label: 'Replication delay', min: 0.2, max: 4, step: 0.1, value: 1.5, unit: 's' },
          { id: 'wrate', type: 'range', label: 'Write rate', min: 0.2, max: 3, step: 0.1, value: 0.8, unit: '/s' },
          { id: 'ryw', type: 'check', label: 'Read-your-writes (route to primary 3s after a write)', value: false }
        ]
      });
    }
  });

  /* ============ Sharding ============ */
  class ShardSim extends LAB.Sim {
    init() {
      this.keys = Array.from({ length: 160 }, (_, i) => ({ id: i, h: mix(i + 101), uid: i * 61 + 1000, moved: 0 }));
      this.prevN = this.params.shards; this.assignAll(true); this.traffic = []; this.tacc = 0; this.nodes = [];
      this.lastMoved = null; this.writes = new Array(8).fill(0);
    }
    shardOf(k, n) {
      const p = this.params;
      if (p.mode === 'mod') return Math.floor(k.h * 1e6) % n;
      if (p.mode === 'range') return Math.min(n - 1, Math.floor((k.uid - 1000) / (160 * 61 / n)));
      const ring = this.ring(n); const pos = k.h; const hit = ring.find(v => v.pos >= pos) || ring[0]; return hit.shard;
    }
    ring(n) {
      const key = n + ':' + this.params.vnodes; if (this._rk === key) return this._ring;
      const r = []; for (let s = 0; s < n; s++) for (let v = 0; v < this.params.vnodes; v++) r.push({ shard: s, pos: mix(s * 1000 + v + 7) });
      r.sort((a, b) => a.pos - b.pos); this._rk = key; this._ring = r; return r;
    }
    assignAll(first) {
      const n = this.params.shards; let moved = 0;
      this.keys.forEach(k => { const s = this.shardOf(k, n); if (!first && k.shard !== s) { moved++; k.moved = this.t + 2; } k.shard = s; });
      if (!first) { this.lastMoved = moved / this.keys.length; this.log(`${this.prevN} → ${n} shards: ${moved} of ${this.keys.length} keys moved (${(this.lastMoved * 100).toFixed(0)}%)`, moved / this.keys.length > 0.5 ? 'bad' : 'ok'); }
    }
    onParam(id) { if (id === 'shards' || id === 'vnodes') { this._rk = null; this.assignAll(false); this.prevN = this.params.shards; } }
    update(dt) {
      // simulated write traffic: new signups get increasing ids
      this.tacc += dt * 20;
      while (this.tacc >= 1) {
        this.tacc--; const p = this.params, n = p.shards;
        let s;
        if (p.hot && Math.random() < 0.4) s = this.shardOf(this.keys[7], n);
        else if (p.mode === 'range' && Math.random() < 0.8) s = n - 1;                    // new ids land in the last range
        else s = this.shardOf({ h: Math.random(), uid: 1000 + Math.random() * 160 * 61 }, n);
        this.writes[s] = (this.writes[s] || 0) + 1;
      }
      this.writes = this.writes.map(w => w * Math.pow(0.5, dt));          // decaying load estimate
    }
    draw(ctx, c) {
      const p = this.params, n = p.shards;
      const pal = ['#4f9dff', '#2fbf71', '#f0a43a', '#c770f0', '#ef5b5b', '#38c3d6', '#a3d95b', '#ff8fb1'];
      if (p.mode === 'ring') {
        const cx = 250, cy = 235, R = 170;
        this.circle(cx, cy, R, null, c.line2);
        this.ring(n).forEach(v => { const a = v.pos * Math.PI * 2 - Math.PI / 2; ctx.strokeStyle = pal[v.shard]; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * (R - 10), cy + Math.sin(a) * (R - 10)); ctx.lineTo(cx + Math.cos(a) * (R + 10), cy + Math.sin(a) * (R + 10)); ctx.stroke(); });
        this.keys.forEach(k => { const a = k.h * Math.PI * 2 - Math.PI / 2, rr = R - 28 - (k.id % 4) * 8; this.circle(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, k.moved > this.t ? 5 : 3, pal[k.shard], k.moved > this.t ? c.text : null); });
        this.text(cx, cy - 8, 'hash ring', { align: 'center', bold: true }); this.text(cx, cy + 10, `${p.vnodes} virtual node(s) per shard`, { align: 'center', size: 11, color: c.muted });
      } else {
        this.text(40, 30, p.mode === 'mod' ? 'shard = hash(key) mod N' : 'range: user_id ranges split evenly (new ids are highest)', { bold: true });
        this.keys.forEach((k, i) => { const x = 50 + (i % 16) * 26, y = 60 + Math.floor(i / 16) * 36; this.rrect(x, y, 20, 26, 4); ctx.fillStyle = pal[k.shard]; ctx.globalAlpha = k.moved > this.t ? 1 : 0.75; ctx.fill(); ctx.globalAlpha = 1; if (k.moved > this.t) { ctx.strokeStyle = c.text; ctx.lineWidth = 2; ctx.stroke(); } });
      }
      // distribution bars
      const bx = 560, counts = new Array(n).fill(0); this.keys.forEach(k => counts[k.shard]++);
      const wsum = this.writes.slice(0, n).reduce((a, b) => a + b, 0) || 1;
      this.text(bx, 30, 'Keys per shard', { bold: true }); this.text(bx + 230, 30, 'Write load', { bold: true });
      for (let s = 0; s < n; s++) {
        const y = 50 + s * 46;
        this.text(bx, y + 8, 'shard ' + (s + 1), { size: 11, color: pal[s] });
        this.bar(bx + 60, y, 150, 14, counts[s] / (this.keys.length / n) / 2, pal[s]); this.text(bx + 60, y + 26, `${counts[s]} keys`, { size: 10, color: c.muted });
        const share = (this.writes[s] || 0) / wsum; this.bar(bx + 230, y, 150, 14, share, share > 0.5 ? c.bad : pal[s]); this.text(bx + 230, y + 26, `${(share * 100).toFixed(0)}% of writes`, { size: 10, color: share > 0.5 ? c.bad : c.muted });
      }
      if (this.lastMoved != null) this.text(560, 440, `Last resize moved ${(this.lastMoved * 100).toFixed(0)}% of keys (ideal ≈ ${(100 / Math.max(this.prevN, n)).toFixed(0)}%)`, { size: 12, color: this.lastMoved > 0.5 ? c.bad : c.ok });
    }
  }
  LAB.defineViz('sharding', {
    title: 'Sharding: Hash, Consistent Hashing, Range',
    desc: 'Distribute 160 keys over N shards. Add or remove shards and see how many keys move with mod-N hashing versus a consistent-hash ring with virtual nodes; observe hotspots with range sharding and celebrity keys.',
    guide: LAB.md`
### Experiments
1. **Hash mod N**: change shards from 4 to 5. Most keys (about 80%) move: a resharding nightmare for caches and databases.
2. **Consistent hashing** with 1 virtual node: only keys between the new node and its predecessor move, but distribution is uneven. Raise **virtual nodes** to 50: even distribution and roughly 1/N keys move.
3. **Range** sharding with increasing user ids: keys are evenly split, but **write load** concentrates on the last shard (new sign-ups).
4. Tick **hot key**: one celebrity key drives 40% of writes to a single shard regardless of the scheme.`,
    create(el) {
      new ShardSim(el, {
        title: 'Shard key distribution', height: 460,
        controls: [
          { id: 'mode', type: 'seg', label: 'Scheme', value: 'mod', options: [['mod', 'hash mod N'], ['ring', 'Consistent hash'], ['range', 'Range']] },
          { id: 'shards', type: 'range', label: 'Shards (drag to add / remove)', min: 2, max: 8, value: 4, reset: false },
          { id: 'vnodes', type: 'range', label: 'Virtual nodes per shard (ring)', min: 1, max: 60, value: 1, reset: false },
          { id: 'hot', type: 'check', label: 'Hot key (celebrity) gets 40% of writes', value: false }
        ]
      });
    }
  });

  /* ============ Node failure: quorum vs Raft ============ */
  class ClusterSim extends LAB.Sim {
    init() {
      const cx = 330, cy = 235, R = 165;
      this.cl = Array.from({ length: 5 }, (_, i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / 5; return { id: 'n' + i, x: cx + Math.cos(a) * R - 60, y: cy + Math.sin(a) * R - 28, w: 120, h: 56, label: 'node-' + (i + 1), down: false, v: 0, term: 0, info: 'Click to crash / restart this node.' }; });
      this.clients = [{ id: 'cA', x: 740, y: 90, w: 160, h: 54, label: 'Client A', sub: 'majority side', info: 'Writes and reads key "x".' },
                      { id: 'cB', x: 740, y: 330, w: 160, h: 54, label: 'Client B', sub: 'minority side', info: 'Only exists during a partition; can reach node-1 and node-2.' }];
      this.nodes = [...this.cl, ...this.clients];
      this.latest = 0; this.opAcc = 0; this.stats = { wok: 0, wfail: 0, rok: 0, rstale: 0, rfail: 0 };
      this.leader = 0; this.term = 1; this.cl.forEach(n => n.term = 1); this.electionAt = null; this.hbAcc = 0;
    }
    side(i) { return this.params.partition ? (i <= 1 ? 'B' : 'A') : 'A'; }
    reachable(clientSide) { return this.cl.filter((n, i) => !n.down && this.side(i) === clientSide); }
    onClick(x, y, n) { if (n && n.id.startsWith('n')) { n.down = !n.down; this.log(`${n.label} ${n.down ? 'crashed' : 'restarted'}`, n.down ? 'bad' : 'ok'); if (!n.down) n.v = Math.min(n.v, this.latest); return true; } }
    onParam(id) { if (id === 'partition') this.log(this.params.partition ? 'Network partition: {node-1,node-2} | {node-3,node-4,node-5}' : 'Partition healed', this.params.partition ? 'warn' : 'ok'); }
    quorumOp(clientSide, client) {
      const p = this.params, replicas = [0, 1, 2], N = 3;
      const reach = replicas.filter(i => !this.cl[i].down && this.side(i) === clientSide);
      const isWrite = Math.random() < 0.5;
      const targets = reach.map(i => this.cl[i]);
      targets.forEach(n => this.send([client, n], { r: 3, speed: 900, color: isWrite ? this.c.accent2 : this.c.accent }));
      if (isWrite) {
        let ok = reach.length >= p.W, hinted = false;
        if (!ok && p.sloppy) { const extra = this.cl.filter((n, i) => !replicas.includes(i) && !n.down && this.side(i) === clientSide); if (reach.length + extra.length >= p.W) { ok = true; hinted = true; } }
        if (ok) { const v = ++this.latest; reach.forEach(i => this.cl[i].v = v); this.stats.wok++; this.log(`write v${v} OK (${reach.length}/${N} replicas${hinted ? ' + hinted handoff' : ''}, W=${p.W})`, hinted ? 'warn' : 'ok'); }
        else { this.stats.wfail++; this.log(`write FAILED: only ${reach.length} replica(s) reachable, W=${p.W}`, 'bad'); }
      } else {
        if (reach.length < p.R) { this.stats.rfail++; this.log(`read FAILED: ${reach.length} reachable < R=${p.R}`, 'bad'); return; }
        const sample = reach.slice().sort(() => Math.random() - .5).slice(0, p.R), v = Math.max(...sample.map(i => this.cl[i].v));
        const stale = v < this.latest; stale ? this.stats.rstale++ : this.stats.rok++;
        this.log(`read v${v} from ${sample.length} replica(s)${stale ? ' — STALE (latest v' + this.latest + ')' : ''}`, stale ? 'warn' : 'ok');
        if (stale === false && p.repair) sample.forEach(i => this.cl[i].v = v);
      }
    }
    raftTick(dt) {
      // leader validity: leader must be up and in majority side to keep committing
      const L = this.cl[this.leader];
      const majoritySide = s => this.cl.filter((n, i) => !n.down && this.side(i) === s).length >= 3;
      const leaderOk = L && !L.down && majoritySide(this.side(this.leader));
      this.hbAcc += dt;
      if (L && !L.down && this.hbAcc > 0.8) { this.hbAcc = 0; this.cl.forEach((n, i) => { if (i !== this.leader && !n.down && this.side(i) === this.side(this.leader)) this.send([L, n], { r: 2.5, color: this.c.info, speed: 900 }); }); }
      if (!leaderOk && this.electionAt == null) { this.electionAt = this.t + rnd(1.2, 2.2); this.log('Followers miss heartbeats: election timeout started', 'warn'); }
      if (leaderOk) this.electionAt = null;
      if (this.electionAt != null && this.t >= this.electionAt) {
        const cands = this.cl.map((n, i) => i).filter(i => !this.cl[i].down && majoritySide(this.side(i)));
        if (cands.length) {
          const best = cands.reduce((a, b) => (this.cl[b].v > this.cl[a].v ? b : a));   // most up-to-date log wins votes
          this.term++; this.leader = best; this.cl.forEach(n => { if (!n.down) n.term = this.term; });
          this.log(`${this.cl[best].label} elected leader for term ${this.term} (majority votes)`, 'info'); this.electionAt = null;
        } else { this.electionAt = this.t + rnd(1.2, 2.2); this.log('Election failed: no majority reachable', 'bad'); }
      }
    }
    raftOp(clientSide, client) {
      const L = this.cl[this.leader], reachL = !L.down && this.side(this.leader) === clientSide;
      if (!reachL) { this.stats.wfail++; this.log(`client ${clientSide}: no reachable leader — request times out`, 'bad'); return; }
      const followers = this.cl.filter((n, i) => !n.down && this.side(i) === clientSide);
      this.send([client, L], { r: 3, speed: 900, color: this.c.accent2 });
      if (followers.length >= 3) { const v = ++this.latest; followers.forEach(n => n.v = v); this.stats.wok++; this.log(`write v${v} committed by ${L.label} (${followers.length}/5 acks ≥ majority)`, 'ok'); }
      else { this.stats.wfail++; this.log(`${L.label} cannot reach a majority (${followers.length}/5): write NOT committed`, 'bad'); }
    }
    update(dt) {
      const p = this.params;
      if (p.mode === 'raft') this.raftTick(dt);
      this.opAcc += dt;
      if (this.opAcc >= 1.4) {
        this.opAcc = 0;
        const sides = p.partition ? ['A', 'B'] : ['A'];
        sides.forEach(s => p.mode === 'raft' ? this.raftOp(s, this.clients[s === 'A' ? 0 : 1]) : this.quorumOp(s, this.clients[s === 'A' ? 0 : 1]));
      }
    }
    draw(ctx, c) {
      const p = this.params;
      if (p.partition) { ctx.strokeStyle = c.bad; ctx.setLineDash([8, 6]); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(380, 10); ctx.lineTo(160, 460); ctx.stroke(); ctx.setLineDash([]); this.text(250, 448, 'network partition', { size: 11, color: c.bad }); }
      this.cl.forEach((n, i) => {
        const isRep = p.mode === 'quorum' && i <= 2;
        n.sub = p.mode === 'raft' ? (i === this.leader ? `LEADER · term ${this.term}` : 'follower') + ` · v${n.v}` : (isRep ? 'replica of x' : 'not a replica') + ` · v${n.v}`;
        this.box(n, { status: n.down ? 'down' : (p.mode === 'raft' && i === this.leader) ? 'active' : n.v < this.latest && (p.mode === 'raft' || isRep) ? 'warn' : 'ok' });
      });
      this.box(this.clients[0]); if (p.partition) this.box(this.clients[1]);
      const s = this.stats;
      const y0 = 190;
      if (p.mode === 'quorum') {
        const strong = p.R + p.W > 3;
        this.text(740, y0, `N=3 · R=${p.R} · W=${p.W}`, { bold: true });
        this.text(740, y0 + 20, strong ? 'R+W > N: reads see latest write' : 'R+W ≤ N: stale reads possible', { size: 11, color: strong ? c.ok : c.warn });
      } else { this.text(740, y0, 'Raft: commit needs 3 of 5', { bold: true }); this.text(740, y0 + 20, 'CP: minority side cannot commit', { size: 11, color: c.muted }); }
      this.text(740, y0 + 46, `writes ok ${s.wok} · failed ${s.wfail}`, { size: 12 });
      if (p.mode === 'quorum') this.text(740, y0 + 66, `reads ok ${s.rok} · stale ${s.rstale} · failed ${s.rfail}`, { size: 12, color: s.rstale ? c.warn : c.text });
      if (this.electionAt != null) this.text(330, 235, 'election in progress…', { align: 'center', color: c.warn, bold: true });
    }
  }
  LAB.defineViz('node-failure', {
    title: 'Node Failures, Quorums & Leader Election',
    desc: 'A five-node cluster. In quorum mode (Dynamo/Cassandra style, N=3) tune R and W, crash replicas and partition the network to see availability vs consistency. In Raft mode watch heartbeats, elections and why a minority partition cannot commit.',
    guide: LAB.md`
### Experiments
1. **Quorum**, R=1, W=1: fast and available, but reads can be **stale** (R + W ≤ N). Set R=2, W=2: reads overlap the latest write.
2. Crash **two of the three replicas** (node-1..3): with W=2 writes fail (consistency preserved); enable **sloppy quorum** to keep accepting writes via hinted handoff (availability preserved, consistency weakened).
3. **Partition** the network: client B on the minority side sees different outcomes depending on R/W: this is CAP in action.
4. **Raft**: crash the leader and watch followers time out and elect the most up-to-date node. During a partition the minority side cannot commit any write (CP).`,
    create(el) {
      new ClusterSim(el, {
        title: 'Distributed cluster under failure', height: 470,
        controls: [
          { id: 'mode', type: 'seg', label: 'Replication protocol', value: 'quorum', options: [['quorum', 'Leaderless quorum'], ['raft', 'Raft (leader + majority)']] },
          { id: 'R', type: 'range', label: 'Read quorum R (quorum mode)', min: 1, max: 3, value: 2 },
          { id: 'W', type: 'range', label: 'Write quorum W (quorum mode)', min: 1, max: 3, value: 2 },
          { id: 'sloppy', type: 'check', label: 'Sloppy quorum + hinted handoff', value: false },
          { id: 'repair', type: 'check', label: 'Read repair', value: true },
          { id: 'partition', type: 'check', label: 'Network partition', value: false }
        ]
      });
    }
  });
})();
