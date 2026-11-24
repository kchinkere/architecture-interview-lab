/* App shell: routing, views, search, progress UI. */
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = LAB.esc, S = LAB.store;
  const view = $('#view');
  const TYPES = { direct: 'Direct', scenario: 'Scenario', debugging: 'Debugging', architecture: 'Architecture decision', 'code-review': 'Code review', tradeoff: 'Trade-off' };
  LAB.TYPES = TYPES;

  /* ---------- theme ---------- */
  const applyTheme = t => { document.documentElement.dataset.theme = t; };
  applyTheme(S.state.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  $('#themeBtn').onclick = () => { const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; applyTheme(t); S.setTheme(t); initMermaid(true); route(); };

  /* ---------- mermaid ---------- */
  let mermaidReady = false;
  function initMermaid(force) {
    if (!window.mermaid) return false;
    if (!mermaidReady || force) {
      const dark = document.documentElement.dataset.theme !== 'light';
      mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict', flowchart: { curve: 'basis', htmlLabels: true }, sequence: { mirrorActors: false }, fontFamily: 'inherit' });
      mermaidReady = true;
    }
    return true;
  }
  function runMermaid(root) {
    const nodes = $$('pre.mermaid', root);
    if (!nodes.length) return;
    if (!initMermaid()) {
      nodes.forEach(n => { if (!n.nextElementSibling) n.insertAdjacentHTML('afterend', '<div class="mermaid-note">Diagram source shown (Mermaid loads from CDN when online).</div>'); });
      return;
    }
    nodes.forEach(n => { if (!n.dataset.src) n.dataset.src = n.textContent; });
    mermaid.run({ nodes }).catch(e => console.warn('mermaid', e));
  }
  window.addEventListener('load', () => { if (window.mermaid) runMermaid(view); });

  /* ---------- nav ---------- */
  function renderNav() {
    const cur = location.hash || '#/';
    const item = (href, ic, label, pct) => `<a class="nav-item ${cur === href || (href !== '#/' && cur.startsWith(href + '/')) ? 'active' : ''}" href="${href}"><span class="ic">${ic}</span>${label}${pct != null ? `<span class="pct">${pct}%</span>` : ''}</a>`;
    $('#nav').innerHTML = `
      <div class="nav-group">${item('#/', '⌂', 'Dashboard')}</div>
      <div class="nav-group"><div class="nav-label">Learn</div>
        ${LAB.modules.map(m => item('#/m/' + m.id, m.icon, m.title, Math.round(S.moduleProgress(m.id) * 100))).join('')}
        ${item('#/viz', '▶', 'Visual Labs')}
      </div>
      <div class="nav-group"><div class="nav-label">Practice</div>
        ${item('#/qb', '?', 'Question Bank')}
        ${item('#/mock', '🎙', 'Mock Interview')}
        ${item('#/revise', '↻', 'Revision Mode')}
        ${item('#/progress', '▤', 'Progress')}
      </div>`;
  }

  /* ---------- router ---------- */
  function route() {
    const parts = (location.hash.replace(/^#\/?/, '') || '').split('/').map(decodeURIComponent);
    renderNav();
    $('#sidebar').classList.remove('open');
    const [a, b, c] = parts;
    let html;
    try {
      if (!a) html = dashboard();
      else if (a === 'm') html = modulePage(b);
      else if (a === 't') html = topicPage(b, c);
      else if (a === 'viz') html = b ? vizPage(b) : vizGallery();
      else if (a === 'qb') html = questionBank();
      else if (a === 'mock') html = LAB.mockView();
      else if (a === 'revise') html = revisePage();
      else if (a === 'progress') html = progressPage();
      else html = '<h1>Not found</h1>';
    } catch (e) { console.error(e); html = '<div class="card"><h3>Render error</h3><pre>' + esc(e.stack) + '</pre></div>'; }
    view.innerHTML = html;
    window.scrollTo(0, 0);
    afterRender(parts);
  }
  window.addEventListener('hashchange', route);
  LAB.route = route;

  function afterRender(parts) {
    $$('[data-copy]', view).forEach(b => b.onclick = () => { navigator.clipboard && navigator.clipboard.writeText(b.closest('pre').querySelector('code').innerText); b.textContent = 'Copied'; setTimeout(() => b.textContent = 'Copy', 1200); });
    runMermaid(view);
    $$('[data-viz]', view).forEach(el => LAB.mountViz(el, el.dataset.viz));
    const hook = afterHooks[parts[0] || 'home']; if (hook) hook(parts);
  }
  const afterHooks = { mock: () => LAB.mockAfter() };

  /* ---------- dashboard ---------- */
  function dashboard() {
    const r = S.readiness(); const weak = S.weakAreas();
    const totalTopics = LAB.allTopics().length;
    const doneTopics = LAB.allTopics().filter(t => S.topic(t.key).done).length;
    const practiced = LAB.questions.filter(q => S.question(q.id).conf).length;
    const mocks = S.state.mocks;
    return `
    <div class="page-head"><h1>Senior Backend Interview Lab</h1>
      <p>Built for a 7-year Java / Spring Boot / IAM engineer targeting Senior, Lead and Backend roles in the UAE and India. Learn a concept, watch it run in a simulation, then prove it in a timed mock interview.</p></div>
    <div class="grid dash-top">
      <div class="card" style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
        <div class="gauge" style="--p:${r.score}"><div><div><b>${r.score}</b><span class="muted xs">readiness</span></div></div></div>
        <div class="sm">
          <div>Topics <b>${Math.round(r.parts.topicPart * 100)}%</b></div>
          <div>Question confidence <b>${Math.round(r.parts.qPart * 100)}%</b></div>
          <div>Mock avg (last 5) <b>${Math.round(r.parts.mockPart * 100)}%</b></div>
          <div>Visual labs <b>${Math.round(r.parts.vizPart * 100)}%</b></div>
        </div>
      </div>
      <div class="grid g4">
        <div class="card"><div class="muted sm">Topics completed</div><div class="stat">${doneTopics}<small> / ${totalTopics}</small></div></div>
        <div class="card"><div class="muted sm">Questions practiced</div><div class="stat">${practiced}<small> / ${LAB.questions.length}</small></div></div>
        <div class="card"><div class="muted sm">Mock interviews</div><div class="stat">${mocks.length}<small>${mocks.length ? ' · last ' + mocks[mocks.length - 1].score.toFixed(1) : ''}</small></div></div>
        <div class="card"><div class="muted sm">Bookmarks</div><div class="stat">${Object.keys(S.state.bookmarks).length}</div></div>
      </div>
    </div>
    <div class="section-title">Modules</div>
    <div class="grid g3">${LAB.modules.map(m => {
      const p = Math.round(S.moduleProgress(m.id) * 100), n = LAB.topicsOf(m.id).length;
      return `<a class="card link" href="#/m/${m.id}"><div class="row"><span style="font-size:22px">${m.icon}</span><h3 style="margin:0">${m.title}</h3><span class="spacer"></span><span class="chip">${n} topics</span></div><p style="min-height:62px">${m.blurb}</p><div class="bar"><i style="width:${p}%"></i></div><div class="muted xs" style="margin-top:4px">${p}% complete</div></a>`;
    }).join('')}
      <a class="card link" href="#/viz"><div class="row"><span style="font-size:22px">▶</span><h3 style="margin:0">Visual Labs</h3><span class="spacer"></span><span class="chip">${Object.keys(LAB.viz).length} sims</span></div><p style="min-height:62px">Animated, parameterised simulations: request flow, load balancing, Kafka, replication, sharding, Saga, circuit breaker, rate limiting, OAuth, Spring internals, node failure.</p></a>
    </div>
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><h3>Weak areas</h3>${weak.length ? weak.map(w => `<div class="row sm" style="margin:6px 0"><span>${esc(w.name)}</span><span class="spacer"></span><span class="chip advanced">avg ${w.avg.toFixed(1)}/5</span></div>`).join('') + '<a class="btn sm" style="margin-top:8px" href="#/revise">Revise weak areas →</a>' : '<p>Rate your confidence on topics and questions (1–5). Anything averaging below 3.2 shows up here, along with weak mock-interview answers.</p>'}</div>
      <div class="card"><h3>Suggested next steps</h3>${nextSteps()}</div>
    </div>`;
  }
  function nextSteps() {
    const steps = [];
    LAB.modules.forEach(m => { const t = LAB.topicsOf(m.id).find(t => !S.topic(t.key).done); if (t) steps.push(`<a href="#/t/${m.id}/${t.id}">${m.icon} ${esc(t.title)}</a>`); });
    const v = Object.keys(LAB.viz).find(id => !S.state.viz[id]); if (v) steps.push(`<a href="#/viz/${v}">▶ Run the ${esc(LAB.viz[v].title)} lab</a>`);
    steps.push('<a href="#/mock">🎙 Take a 30-minute mock interview</a>');
    return '<div style="display:flex;flex-direction:column;gap:7px" class="sm">' + steps.slice(0, 7).join('') + '</div>';
  }

  /* ---------- module page ---------- */
  function modulePage(id) {
    const m = LAB.modules.find(x => x.id === id); if (!m) return 'Unknown module';
    const secs = LAB.sections[id] || [];
    return `<div class="crumbs"><a href="#/">Dashboard</a> / ${m.title}</div>
    <div class="page-head"><h1>${m.icon} ${m.title}</h1><p>${m.blurb}</p></div>
    <div class="row" style="margin-bottom:8px"><div class="bar" style="flex:1;max-width:420px"><i style="width:${Math.round(S.moduleProgress(id) * 100)}%"></i></div><span class="muted sm">${Math.round(S.moduleProgress(id) * 100)}% complete</span></div>
    ${secs.map(s => `<div class="section-title">${esc(s.title)}</div><div class="topic-list">${s.topics.map(topicRow).join('')}</div>`).join('')}`;
  }
  function topicRow(t) {
    const st = S.topic(t.key);
    return `<a class="topic-row" href="#/t/${t.module}/${t.id}"><span class="check ${st.done ? 'done' : ''}">${st.done ? '✓' : ''}</span>
      <span style="flex:1;min-width:0"><div class="t">${esc(t.title)} ${S.isBookmarked(t.key) ? '<span style="color:var(--warn)">★</span>' : ''}</div><div class="s">${esc(t.summary || '')}</div></span>
      ${t.viz ? '<span class="chip accent">▶ sim</span>' : ''}<span class="chip ${t.level}">${t.level}</span>${st.conf ? `<span class="chip">conf ${st.conf}/5</span>` : ''}</a>`;
  }

  /* ---------- topic page ---------- */
  function topicPage(mod, id) {
    const t = LAB.topics[mod + ':' + id]; if (!t) return 'Topic not found';
    const m = LAB.modules.find(x => x.id === mod);
    const st = S.topic(t.key);
    const list = LAB.topicsOf(mod); const idx = list.indexOf(t);
    const prev = list[idx - 1], next = list[idx + 1];
    const body = LAB.render(t.body);
    const toc = [...body.matchAll(/<h([23]) id="([^"]+)">(.*?)<\/h\1>/g)].map(x => `<a class="l${x[1]}" href="javascript:void(0)" data-jump="${x[2]}">${x[3].replace(/<[^>]+>/g, '')}</a>`).join('');
    const rel = LAB.questions.filter(q => q.topicKey === t.key || (q.topics || []).includes(t.key));
    return `<div class="crumbs"><a href="#/">Dashboard</a> / <a href="#/m/${mod}">${m.title}</a> / ${esc(t.section)}</div>
    <div class="topic-layout"><div>
      <div class="page-head"><h1>${esc(t.title)}</h1><p>${esc(t.summary || '')}</p>
        <div class="row" style="margin-top:8px"><span class="chip ${t.level}">${t.level}</span>${t.tags.map(x => `<span class="chip">${esc(x)}</span>`).join('')}</div></div>
      <div class="topic-actions">
        <button class="btn sm ${st.done ? 'on' : ''}" id="doneBtn">${st.done ? '✓ Completed' : 'Mark complete'}</button>
        <button class="btn sm ${S.isBookmarked(t.key) ? 'on' : ''}" id="bmBtn">${S.isBookmarked(t.key) ? '★ Bookmarked' : '☆ Bookmark'}</button>
        <span class="spacer"></span><span class="muted sm">Confidence</span>
        <span class="conf" id="confBtns">${[1, 2, 3, 4, 5].map(n => `<button class="${st.conf === n ? 'on' : ''}" data-c="${n}">${n}</button>`).join('')}</span>
      </div>
      ${t.viz ? `<div data-viz="${t.viz}"></div>` : ''}
      <article class="prose">${body}</article>
      ${rel.length ? `<h2 class="prose" style="font-size:21px">Question bank for this topic</h2>${rel.map(qCard).join('')}` : ''}
      <div class="row" style="margin-top:30px">${prev ? `<a class="btn" href="#/t/${mod}/${prev.id}">← ${esc(prev.title)}</a>` : ''}<span class="spacer"></span>${next ? `<a class="btn primary" href="#/t/${mod}/${next.id}">${esc(next.title)} →</a>` : ''}</div>
    </div><nav class="toc"><div class="muted xs" style="margin-bottom:6px;text-transform:uppercase;letter-spacing:.08em">On this page</div>${toc}</nav></div>`;
  }
  afterHooks.t = ([, mod, id]) => {
    const key = mod + ':' + id;
    const done = $('#doneBtn'); if (!done) return;
    done.onclick = () => { S.setTopic(key, { done: !S.topic(key).done }); route(); };
    $('#bmBtn').onclick = () => { S.toggleBookmark(key); route(); };
    $$('#confBtns button').forEach(b => b.onclick = () => { S.setTopic(key, { conf: +b.dataset.c }); $$('#confBtns button').forEach(x => x.classList.toggle('on', x === b)); renderNav(); });
    $$('[data-jump]').forEach(a => a.onclick = () => { const el = document.getElementById(a.dataset.jump); el && window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - 70, behavior: 'smooth' }); });
    bindQCards(view);
  };

  /* ---------- visual labs ---------- */
  function vizGallery() {
    return `<div class="page-head"><h1>▶ Visual Labs</h1><p>Each lab is a live simulation: change parameters, inject failures by clicking components, pause, and step through events. Watching a system misbehave is the fastest way to build the intuition interviewers probe for.</p></div>
    <div class="grid g3">${Object.entries(LAB.viz).map(([id, v]) => `<a class="card link" href="#/viz/${id}"><div class="row"><h3 style="margin:0">${esc(v.title)}</h3><span class="spacer"></span>${S.state.viz[id] ? '<span class="chip beginner">explored</span>' : ''}</div><p>${esc(v.desc)}</p></a>`).join('')}</div>`;
  }
  function vizPage(id) {
    const v = LAB.viz[id]; if (!v) return 'Unknown lab';
    const related = LAB.allTopics().filter(t => t.viz === id);
    return `<div class="crumbs"><a href="#/viz">Visual Labs</a> / ${esc(v.title)}</div>
      <div class="page-head"><h1>${esc(v.title)}</h1><p>${esc(v.desc)}</p></div>
      <div data-viz="${id}"></div>
      ${v.guide ? `<article class="prose card" style="margin-top:12px">${LAB.render(v.guide)}</article>` : ''}
      ${related.length ? `<div class="section-title">Related topics</div><div class="topic-list">${related.map(topicRow).join('')}</div>` : ''}`;
  }
  LAB.mountViz = function (el, id) {
    const v = LAB.viz[id]; if (!v) { el.innerHTML = '<div class="card">Visualization not found: ' + esc(id) + '</div>'; return; }
    S.markViz(id);
    try { v.create(el); } catch (e) { console.error(e); el.innerHTML = '<div class="card">Visualization error: ' + esc(e.message) + '</div>'; }
  };

  /* ---------- question cards ---------- */
  function qCard(q) {
    const st = S.question(q.id);
    return `<div class="qcard" data-q="${q.id}">
      <div class="qh"><span class="check ${st.conf >= 4 ? 'done' : ''}">${st.conf >= 4 ? '✓' : ''}</span><span class="qt">${LAB.render(q.q).replace(/^<p>|<\/p>$/g, '')}</span>
        <span class="chip ${q.level}">${q.level}</span><span class="chip">${TYPES[q.type] || q.type}</span>
        <button class="bm ${S.isBookmarked(q.id) ? 'on' : ''}" data-bm="${q.id}" title="Bookmark">★</button></div>
      <div class="qb hidden"></div></div>`;
  }
  function qBody(q) {
    const st = S.question(q.id);
    const f = (q.followups || []).map(x => Array.isArray(x) ? `?? ${x[0]}\n${x[1]}\n` : `- ${x}`).join('\n');
    return `<div class="attempt"><p class="muted sm" style="margin-top:12px">Answer it yourself first (out loud or in writing), then reveal the model answer.</p>
      <textarea placeholder="Draft your answer…" data-draft>${esc(st.draft || '')}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn primary sm" data-reveal>Reveal model answer</button><button class="btn sm" data-mockq>Get scored on this answer</button></div></div>
      <div class="answer hidden prose">
        <h4>Interviewer's expected answer</h4>${LAB.render(q.expected)}
        ${q.explanation ? '<h4>Detailed explanation</h4>' + LAB.render(q.explanation) : ''}
        ${q.example ? '<h4>Practical example</h4>' + LAB.render(q.example) : ''}
        ${q.wrong ? '<h4 class="bad">Common incorrect answers</h4>' + LAB.render(q.wrong) : ''}
        ${f ? '<h4>Likely follow-ups</h4>' + LAB.render(f) : ''}
        <div class="row" style="margin-top:14px"><span class="muted sm">How confident are you?</span><span class="conf">${[1, 2, 3, 4, 5].map(n => `<button class="${st.conf === n ? 'on' : ''}" data-qc="${n}">${n}</button>`).join('')}</span></div>
      </div>`;
  }
  function bindQCards(root) {
    $$('.qcard', root).forEach(card => {
      const q = LAB.questions.find(x => x.id === card.dataset.q);
      const head = $('.qh', card), body = $('.qb', card);
      head.onclick = e => {
        if (e.target.closest('[data-bm]')) { const on = S.toggleBookmark(q.id); e.target.classList.toggle('on', on); return; }
        if (body.classList.toggle('hidden')) return;
        if (!body.dataset.ready) { body.innerHTML = qBody(q); body.dataset.ready = 1; bindQBody(body, q, card); runMermaid(body); }
      };
    });
  }
  function bindQBody(body, q, card) {
    const ta = $('[data-draft]', body);
    ta.oninput = () => S.setQuestion(q.id, { draft: ta.value });
    $('[data-reveal]', body).onclick = () => { $('.answer', body).classList.remove('hidden'); S.setQuestion(q.id, { seen: true }); };
    $('[data-mockq]', body).onclick = () => {
      const res = LAB.evaluate(q, ta.value);
      openModal(LAB.renderEvaluation(q, ta.value, res));
      $('.answer', body).classList.remove('hidden');
      S.setQuestion(q.id, { lastScore: res.overall });
    };
    $$('[data-qc]', body).forEach(b => b.onclick = () => {
      S.setQuestion(q.id, { conf: +b.dataset.qc }); $$('[data-qc]', body).forEach(x => x.classList.toggle('on', x === b));
      const ck = $('.check', card); ck.classList.toggle('done', +b.dataset.qc >= 4); ck.textContent = +b.dataset.qc >= 4 ? '✓' : '';
    });
    $$('[data-copy]', body).forEach(b => b.onclick = () => navigator.clipboard && navigator.clipboard.writeText(b.closest('pre').querySelector('code').innerText));
  }
  LAB.qCard = qCard; LAB.bindQCards = bindQCards;

  /* ---------- question bank ---------- */
  const qbState = { text: '', module: '', level: '', type: '', status: '' };
  function questionBank() {
    const opt = (k, vals) => `<select data-f="${k}"><option value="">${{ module: 'All modules', level: 'All levels', type: 'All types', status: 'Any status' }[k]}</option>${vals.map(([v, l]) => `<option value="${v}" ${qbState[k] === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    const counts = { beginner: 0, intermediate: 0, advanced: 0 }; LAB.questions.forEach(q => counts[q.level]++);
    return `<div class="page-head"><h1>Question Bank</h1><p>${LAB.questions.length} questions (${counts.beginner} beginner · ${counts.intermediate} intermediate · ${counts.advanced} advanced). Every answer includes the interviewer's expected answer, reasoning, a practical example, common wrong answers and follow-ups. Attempt before you reveal.</p></div>
    <div class="filters">
      <input class="input" id="qbText" placeholder="Filter by text…" value="${esc(qbState.text)}" style="flex:1;min-width:200px">
      ${opt('module', LAB.modules.map(m => [m.id, m.title]))}
      ${opt('level', [['beginner', 'Beginner'], ['intermediate', 'Intermediate'], ['advanced', 'Advanced']])}
      ${opt('type', Object.entries(TYPES))}
      ${opt('status', [['new', 'Not practiced'], ['weak', 'Low confidence (≤2)'], ['strong', 'Confident (≥4)'], ['bm', 'Bookmarked']])}
    </div><div id="qbCount" class="muted sm" style="margin-bottom:8px"></div><div id="qbList"></div>`;
  }
  function filterQs() {
    const terms = qbState.text.toLowerCase().split(/\s+/).filter(Boolean);
    return LAB.questions.filter(q => {
      const st = S.question(q.id);
      if (qbState.module && q.module !== qbState.module) return false;
      if (qbState.level && q.level !== qbState.level) return false;
      if (qbState.type && q.type !== qbState.type) return false;
      if (qbState.status === 'new' && st.conf) return false;
      if (qbState.status === 'weak' && !(st.conf && st.conf <= 2)) return false;
      if (qbState.status === 'strong' && !(st.conf >= 4)) return false;
      if (qbState.status === 'bm' && !S.isBookmarked(q.id)) return false;
      if (terms.length) { const hay = (q.q + ' ' + (q.topic || '') + ' ' + q.expected).toLowerCase(); if (!terms.every(t => hay.includes(t))) return false; }
      return true;
    });
  }
  afterHooks.qb = () => {
    const draw = () => { const qs = filterQs(); $('#qbCount').textContent = qs.length + ' matching'; $('#qbList').innerHTML = qs.map(qCard).join(''); bindQCards($('#qbList')); };
    $('#qbText').oninput = e => { qbState.text = e.target.value; draw(); };
    $$('[data-f]').forEach(s => s.onchange = () => { qbState[s.dataset.f] = s.value; draw(); });
    draw();
  };

  /* ---------- revision ---------- */
  const rev = { mode: 'weak', deck: [], i: 0, flipped: false };
  function buildDeck(mode) {
    let qs = LAB.questions;
    if (mode === 'weak') qs = qs.filter(q => { const c = S.question(q.id).conf; return !c || c <= 3; });
    if (mode === 'bm') qs = qs.filter(q => S.isBookmarked(q.id));
    if (['lld', 'hld', 'sd', 'java', 'iam'].includes(mode)) qs = qs.filter(q => q.module === mode);
    qs = qs.slice().sort(() => Math.random() - .5);
    // weakest first for spaced-repetition feel
    if (mode === 'weak') qs.sort((a, b) => (S.question(a.id).conf || 0) - (S.question(b.id).conf || 0));
    return qs;
  }
  function revisePage() {
    if (!rev.deck.length) rev.deck = buildDeck(rev.mode);
    const q = rev.deck[rev.i];
    const modes = [['weak', 'Weak & unseen'], ['bm', 'Bookmarked'], ['all', 'All (shuffled)'], ...LAB.modules.map(m => [m.id, m.title])];
    return `<div class="page-head"><h1>↻ Revision Mode</h1><p>Flashcards drawn from the question bank. Say the answer out loud, flip, then rate yourself honestly; low ratings come back first next time and feed the weak-area report.</p></div>
    <div class="row" style="margin-bottom:14px"><div class="seg">${modes.map(([k, l]) => `<button data-mode="${k}" class="${rev.mode === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    ${q ? `<div class="muted sm">Card ${rev.i + 1} of ${rev.deck.length} · ${LAB.modules.find(m => m.id === q.module).title} · <span class="chip ${q.level}">${q.level}</span></div>
      <div class="card flash" id="flash" style="margin-top:8px">${rev.flipped ? `<div class="prose" style="text-align:left">${LAB.render(q.expected)}</div>` : `<div class="front">${LAB.render(q.q)}</div><div class="muted sm" style="margin-top:14px">Click to flip</div>`}</div>
      <div class="row" style="margin-top:12px"><button class="btn" id="prevC">←</button><span class="muted sm">Rate recall:</span><span class="conf">${[1, 2, 3, 4, 5].map(n => `<button data-rc="${n}" class="${S.question(q.id).conf === n ? 'on' : ''}">${n}</button>`).join('')}</span><span class="spacer"></span><button class="btn sm" id="fullC">Full answer</button><button class="btn primary" id="nextC">Next →</button></div>`
      : '<div class="card">No cards in this deck yet. Bookmark questions or rate them to build it.</div>'}`;
  }
  afterHooks.revise = () => {
    $$('[data-mode]').forEach(b => b.onclick = () => { rev.mode = b.dataset.mode; rev.deck = buildDeck(rev.mode); rev.i = 0; rev.flipped = false; route(); });
    const q = rev.deck[rev.i]; if (!q) return;
    $('#flash').onclick = () => { rev.flipped = !rev.flipped; route(); };
    $('#nextC').onclick = () => { rev.i = (rev.i + 1) % rev.deck.length; rev.flipped = false; route(); };
    $('#prevC').onclick = () => { rev.i = (rev.i - 1 + rev.deck.length) % rev.deck.length; rev.flipped = false; route(); };
    $('#fullC').onclick = () => openQuestion(q);
    $$('[data-rc]').forEach(b => b.onclick = () => { S.setQuestion(q.id, { conf: +b.dataset.rc }); rev.i = (rev.i + 1) % rev.deck.length; rev.flipped = false; route(); });
  };

  /* ---------- progress ---------- */
  function progressPage() {
    const r = S.readiness();
    const bms = Object.keys(S.state.bookmarks);
    const bmT = bms.map(k => LAB.topics[k]).filter(Boolean), bmQ = bms.map(k => LAB.questions.find(q => q.id === k)).filter(Boolean);
    const lvl = ['beginner', 'intermediate', 'advanced'].map(l => { const qs = LAB.questions.filter(q => q.level === l); const d = qs.filter(q => S.question(q.id).conf >= 4).length; return [l, d, qs.length]; });
    return `<div class="page-head"><h1>▤ Progress</h1><p>Readiness = 35% topics completed + 25% question confidence + 30% average of the last five mock interviews + 10% visual labs explored. It is a study-coverage signal, not a hiring prediction.</p></div>
    <div class="grid g2">
      <div class="card"><h3>Readiness: ${r.score}/100</h3>${LAB.modules.map(m => { const p = Math.round(S.moduleProgress(m.id) * 100); return `<div class="dim"><span>${m.icon} ${m.title}</span><div class="bar"><i style="width:${p}%"></i></div><span class="sm">${p}%</span></div>`; }).join('')}</div>
      <div class="card"><h3>Questions by difficulty (confidence ≥ 4)</h3>${lvl.map(([l, d, n]) => `<div class="dim"><span class="chip ${l}" style="justify-self:start">${l}</span><div class="bar"><i style="width:${n ? d / n * 100 : 0}%"></i></div><span class="sm">${d}/${n}</span></div>`).join('')}</div>
    </div>
    <div class="section-title">Mock interview history</div>
    <div class="card">${S.state.mocks.length ? `<table class="prose" style="max-width:none"><thead><tr><th>Date</th><th>Type</th><th>Length</th><th>Score</th><th>Weakest dimension</th></tr></thead><tbody>${S.state.mocks.slice().reverse().map(m => { const w = Object.entries(m.dims || {}).sort((a, b) => a[1] - b[1])[0]; return `<tr><td>${new Date(m.date).toLocaleString()}</td><td>${esc(m.typeLabel || m.type)}</td><td>${m.minutes} min</td><td><b>${m.score.toFixed(1)}</b>/10</td><td>${w ? esc(w[0]) + ' (' + w[1].toFixed(1) + ')' : ''}</td></tr>`; }).join('')}</tbody></table>` : '<p class="muted">No mock interviews yet.</p>'}</div>
    <div class="section-title">Bookmarks</div>
    <div class="topic-list">${bmT.map(topicRow).join('')}</div>${bmQ.map(qCard).join('') || (bmT.length ? '' : '<p class="muted">Nothing bookmarked yet.</p>')}
    <div class="section-title">Data</div>
    <div class="row"><button class="btn" id="expBtn">Export progress (JSON)</button><label class="btn">Import<input type="file" id="impFile" accept=".json" hidden></label><button class="btn" id="resetBtn" style="color:var(--bad)">Reset all progress</button></div>`;
  }
  afterHooks.progress = () => {
    bindQCards(view);
    $('#expBtn').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([S.export()], { type: 'application/json' })); a.download = 'archlab-progress.json'; a.click(); };
    $('#impFile').onchange = e => { const f = e.target.files[0]; if (!f) return; f.text().then(t => { try { S.import(t); route(); } catch (err) { alert('Invalid file'); } }); };
    $('#resetBtn').onclick = () => { if (confirm('Erase all locally saved progress, bookmarks and mock history?')) { S.reset(); route(); } };
  };

  /* ---------- modal + random ---------- */
  function openModal(html) { $('#modalBody').innerHTML = html; $('#modal').classList.remove('hidden'); runMermaid($('#modalBody')); $$('[data-copy]', $('#modalBody')).forEach(b => b.onclick = () => navigator.clipboard && navigator.clipboard.writeText(b.closest('pre').querySelector('code').innerText)); }
  LAB.openModal = openModal;
  $('#modalX').onclick = () => $('#modal').classList.add('hidden');
  $('#modal').onclick = e => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); };
  function openQuestion(q) {
    openModal(`<div class="muted sm">${LAB.modules.find(m => m.id === q.module).title} · ${esc(q.topic || '')}</div>` + qCard(q));
    const card = $('#modalBody .qcard'); bindQCards($('#modalBody')); $('.qh', card).click();
  }
  LAB.openQuestion = openQuestion;
  $('#randomBtn').onclick = () => openQuestion(LAB.questions[Math.floor(Math.random() * LAB.questions.length)]);

  /* ---------- search ---------- */
  let index = null;
  function buildIndex() {
    index = [];
    LAB.allTopics().forEach(t => index.push({ kind: 'topic', title: t.title, sub: LAB.modules.find(m => m.id === t.module).title + ' · ' + t.section, href: `#/t/${t.module}/${t.id}`, text: (t.title + ' ' + t.summary + ' ' + t.tags.join(' ') + ' ' + LAB.plain(t.body)).toLowerCase(), tl: t.title.toLowerCase() }));
    LAB.questions.forEach(q => index.push({ kind: 'question', q, title: q.q.replace(/[{}`*]/g, ''), sub: 'Question · ' + (q.topic || q.module) + ' · ' + q.level, text: (q.q + ' ' + q.topic + ' ' + q.expected).toLowerCase(), tl: q.q.toLowerCase() }));
    Object.entries(LAB.viz).forEach(([id, v]) => index.push({ kind: 'viz', title: v.title + ' (visual lab)', sub: v.desc, href: '#/viz/' + id, text: (v.title + ' ' + v.desc).toLowerCase(), tl: v.title.toLowerCase() }));
  }
  const sIn = $('#search'), sOut = $('#searchResults'); let sSel = 0, sRes = [];
  sIn.oninput = () => {
    if (!index) buildIndex();
    const terms = sIn.value.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) { sOut.classList.add('hidden'); return; }
    sRes = index.map(it => {
      if (!terms.every(t => it.text.includes(t) || it.tl.includes(t))) return null;
      let s = 0; terms.forEach(t => { if (it.tl.includes(t)) s += 10; s += Math.min(5, it.text.split(t).length - 1); });
      if (it.kind === 'topic') s += 3; return { it, s };
    }).filter(Boolean).sort((a, b) => b.s - a.s).slice(0, 14).map(x => x.it);
    sSel = 0;
    sOut.innerHTML = sRes.length ? sRes.map((r, i) => `<a class="sr-item ${i === 0 ? 'sel' : ''}" data-i="${i}" href="${r.href || 'javascript:void(0)'}"><span>${r.kind === 'question' ? '❓ ' : r.kind === 'viz' ? '▶ ' : '📘 '}${esc(r.title.slice(0, 120))}</span><small>${esc(r.sub.slice(0, 120))}</small></a>`).join('') : '<div class="sr-item muted">No matches</div>';
    sOut.classList.remove('hidden');
    $$('.sr-item[data-i]', sOut).forEach(a => a.onclick = e => pick(+a.dataset.i, e));
  };
  function pick(i, e) { const r = sRes[i]; if (!r) return; sOut.classList.add('hidden'); sIn.value = ''; if (r.kind === 'question') { e && e.preventDefault(); openQuestion(r.q); } else if (!e) location.hash = r.href; }
  sIn.onkeydown = e => {
    const items = $$('.sr-item[data-i]', sOut);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sSel = Math.max(0, Math.min(items.length - 1, sSel + (e.key === 'ArrowDown' ? 1 : -1))); items.forEach((x, i) => x.classList.toggle('sel', i === sSel)); }
    if (e.key === 'Enter') pick(sSel);
    if (e.key === 'Escape') { sOut.classList.add('hidden'); sIn.blur(); }
  };
  document.addEventListener('click', e => { if (!e.target.closest('.search-wrap')) sOut.classList.add('hidden'); });
  document.addEventListener('keydown', e => { if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); sIn.focus(); } if (e.key === 'Escape') $('#modal').classList.add('hidden'); });
  $('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');

  LAB.afterHooks = afterHooks;
  route();
})();
