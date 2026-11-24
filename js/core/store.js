/* Progress persistence (localStorage). All reads/writes are guarded so the app works without storage. */
(function () {
  const KEY = 'archlab.v1';
  const blank = () => ({ topics: {}, questions: {}, bookmarks: {}, viz: {}, mocks: [], theme: null, created: Date.now() });
  let state = blank();
  try { const raw = localStorage.getItem(KEY); if (raw) state = Object.assign(blank(), JSON.parse(raw)); } catch (e) { /* storage unavailable */ }

  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { } };

  LAB.store = {
    get state() { return state; },
    topic(key) { return state.topics[key] || {}; },
    setTopic(key, patch) { state.topics[key] = Object.assign({}, state.topics[key], patch, { ts: Date.now() }); save(); },
    question(id) { return state.questions[id] || {}; },
    setQuestion(id, patch) { state.questions[id] = Object.assign({}, state.questions[id], patch, { ts: Date.now() }); save(); },
    isBookmarked(id) { return !!state.bookmarks[id]; },
    toggleBookmark(id) { if (state.bookmarks[id]) delete state.bookmarks[id]; else state.bookmarks[id] = Date.now(); save(); return !!state.bookmarks[id]; },
    markViz(id) { if (!state.viz[id]) { state.viz[id] = Date.now(); save(); } },
    addMock(m) { state.mocks.push(m); save(); },
    setTheme(t) { state.theme = t; save(); },
    export() { return JSON.stringify(state, null, 2); },
    import(json) { state = Object.assign(blank(), JSON.parse(json)); save(); },
    reset() { state = blank(); save(); },

    moduleProgress(mod) {
      const ts = LAB.topicsOf(mod); if (!ts.length) return 0;
      return ts.filter(t => (state.topics[t.key] || {}).done).length / ts.length;
    },
    /* Readiness: 35% topics, 25% questions (confidence-weighted), 30% mock average, 10% visual labs explored. */
    readiness() {
      const ts = LAB.allTopics();
      const topicPart = ts.length ? ts.filter(t => (state.topics[t.key] || {}).done).length / ts.length : 0;
      const qs = LAB.questions;
      const qPart = qs.length ? qs.reduce((a, q) => a + ((state.questions[q.id] || {}).conf || 0) / 5, 0) / qs.length : 0;
      const recent = state.mocks.slice(-5);
      const mockPart = recent.length ? recent.reduce((a, m) => a + m.score, 0) / recent.length / 10 : 0;
      const vizN = Object.keys(LAB.viz).length;
      const vizPart = vizN ? Object.keys(state.viz).length / vizN : 0;
      const parts = { topicPart, qPart, mockPart, vizPart };
      return { score: Math.round(100 * (0.35 * topicPart + 0.25 * qPart + 0.30 * mockPart + 0.10 * vizPart)), parts };
    },
    /* Weak areas: tags/modules with low self-rated confidence or low mock scores. */
    weakAreas() {
      const agg = {};
      const bump = (k, v) => { (agg[k] = agg[k] || { sum: 0, n: 0 }); agg[k].sum += v; agg[k].n++; };
      LAB.allTopics().forEach(t => { const c = (state.topics[t.key] || {}).conf; if (c) bump(t.title + '|' + t.key, c); });
      LAB.questions.forEach(q => { const c = (state.questions[q.id] || {}).conf; if (c) bump((q.topic || q.module) + '|q:' + q.module, c); });
      state.mocks.forEach(m => (m.perQ || []).forEach(p => p.topic && bump(p.topic + '|mock', p.score / 2)));
      return Object.entries(agg).map(([k, v]) => ({ name: k.split('|')[0], ref: k.split('|')[1], avg: v.sum / v.n, n: v.n }))
        .filter(x => x.avg < 3.2).sort((a, b) => a.avg - b.avg).slice(0, 10);
    }
  };
})();
