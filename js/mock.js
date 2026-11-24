/* Mock interview mode + offline answer evaluator.
 * The evaluator is a transparent heuristic: it checks your answer against the key points an interviewer
 * listens for (regex rubric per question), then looks for reasoning, trade-off language, structure and
 * production experience. It never sees the ideal answer until you submit. For a second opinion, the
 * "Copy grading prompt" button produces a prompt you can paste into any LLM you already use.
 */
(function () {
  const esc = LAB.esc;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  /* ---------- evaluator ---------- */
  const count = (txt, re) => (txt.match(re) || []).length;
  const clamp = (x, a = 0, b = 10) => Math.max(a, Math.min(b, x));

  function keyPointsFor(q) {
    if (q.keyPoints && q.keyPoints.length) return q.keyPoints;
    // Fallback: bold terms in the expected answer become key concepts.
    const bold = [...String(q.expected || '').matchAll(/\*\*([^*]{3,60})\*\*/g)].map(m => m[1].replace(/[.:]$/, ''));
    return [...new Set(bold)].slice(0, 8).map(b => [b, b.toLowerCase().split(/[\s/,-]+/).filter(w => w.length > 3).slice(0, 2).map(w => w.replace(/[^a-z0-9]/g, '')).filter(Boolean).join('.{0,40}') || b]);
  }

  LAB.evaluate = function (q, answer) {
    const a = String(answer || '');
    const low = a.toLowerCase();
    const words = (a.match(/\b[\w'-]+\b/g) || []).length;
    const kps = keyPointsFor(q);
    const hits = kps.map(([label, re]) => { let ok = false; try { ok = new RegExp(re, 'i').test(a); } catch (e) { ok = low.includes(String(re).toLowerCase()); } return { label, ok }; });
    const cov = kps.length ? hits.filter(h => h.ok).length / kps.length : Math.min(1, words / 150);
    const miscon = (q.misconceptions || []).filter(([, re]) => new RegExp(re, 'i').test(a)).map(([l]) => l);

    const reasoning = count(low, /\b(because|so that|therefore|which means|this ensures|to avoid|otherwise|as a result|the reason|since)\b/g);
    const trade = count(low, /(trade-?off|however|\bbut\b|downside|drawback|\bcost\b|alternativ|instead|on the other hand|\bvs\.?\b|versus|it depends|at the expense|con:|cons\b|pros\b|latency vs|consistency vs)/g);
    const practical = count(low, /(production|in my (project|experience|team|last)|we (used|had|built|ran|migrated|saw)|monitor|alert|metric|dashboard|incident|rollout|canary|on-?call|p9\d|grafana|prometheus|load test|postmortem|runbook|feature flag)/g);
    const mechanism = count(low, /(internally|under the hood|works by|step|first|then|finally|flow|lifecycle|algorithm)/g);
    const lines = a.split(/\n/).filter(l => l.trim());
    const structured = lines.filter(l => /^\s*([-*•]|\d+[.)])\s/.test(l)).length >= 2 || lines.length >= 3;
    const sentences = a.split(/[.!?]+\s/).filter(s => s.trim().split(/\s+/).length > 2);
    const avgLen = sentences.length ? words / sentences.length : words;
    const firstLen = (sentences[0] || '').split(/\s+/).length;

    const dims = {
      'Technical correctness': clamp(10 * cov - 2 * miscon.length + (cov > 0 ? 0.5 : 0)),
      'Depth of understanding': clamp(10 * (0.55 * cov + 0.3 * Math.min(1, words / 200) + 0.15 * Math.min(1, mechanism / 3))),
      'Architecture reasoning': clamp(10 * (0.5 * cov + 0.5 * Math.min(1, reasoning / 4))),
      'Trade-off analysis': clamp(10 * (0.3 * cov + 0.7 * Math.min(1, trade / 4))),
      'Communication': clamp((structured ? 4 : 1.5) + (avgLen >= 7 && avgLen <= 32 ? 3 : 1) + (firstLen > 0 && firstLen <= 35 ? 1.5 : 0) + Math.min(1.5, words / 100)),
      'Practical experience': clamp(10 * (0.35 * cov + 0.65 * Math.min(1, practical / 3)))
    };
    const W = { 'Technical correctness': .30, 'Depth of understanding': .20, 'Architecture reasoning': .15, 'Trade-off analysis': .15, 'Communication': .10, 'Practical experience': .10 };
    let overall = Object.entries(dims).reduce((s, [k, v]) => s + v * W[k], 0);
    if (words < 15) overall = Math.min(overall, 1.5);
    else if (words < 40) overall = Math.min(overall, 4);

    const tips = [];
    if (dims['Trade-off analysis'] < 5) tips.push('Name at least one alternative and say what you give up (latency, cost, consistency, complexity) by choosing your approach.');
    if (dims['Architecture reasoning'] < 5) tips.push('Explain *why*: connect each decision to a requirement ("because reads dominate 100:1, so…").');
    if (dims['Practical experience'] < 5) tips.push('Ground it in production: what you would monitor, an incident you have seen, how you would roll it out safely.');
    if (dims['Communication'] < 5) tips.push('Lead with a one-sentence answer, then structure the detail as a short list.');
    if (dims['Depth of understanding'] < 5) tips.push('Go one level deeper into the mechanism (what happens internally, step by step).');
    if (miscon.length) tips.unshift('Possible misconception: ' + miscon.join('; '));
    return { overall: Math.round(overall * 10) / 10, dims, hits, words, tips, miscon };
  };

  LAB.renderEvaluation = function (q, answer, r) {
    const bar = v => `<div class="bar"><i style="width:${v * 10}%;${v < 5 ? 'background:var(--bad)' : v < 7 ? 'background:var(--warn)' : ''}"></i></div>`;
    return `<div class="row"><div class="score-big">${r.overall.toFixed(1)}<span class="muted" style="font-size:20px">/10</span></div><div class="muted sm" style="max-width:420px">Heuristic offline score from ${r.hits.length} rubric points + reasoning, trade-off, structure and experience signals (${r.words} words). Compare with the model answer and adjust your self-rating.</div></div>
      ${Object.entries(r.dims).map(([k, v]) => `<div class="dim"><span>${k}</span>${bar(v)}<b>${v.toFixed(1)}</b></div>`).join('')}
      <h3 style="margin-top:18px">Rubric points</h3>${r.hits.map(h => `<div class="kp"><span class="${h.ok ? 'y' : 'n'}">${h.ok ? '✓' : '✗'}</span><span>${esc(h.label)}</span></div>`).join('')}
      ${r.tips.length ? '<h3>What to improve</h3><ul class="sm">' + r.tips.map(t => '<li>' + LAB.render(t).replace(/^<p>|<\/p>$/g, '') + '</li>').join('') + '</ul>' : ''}
      <div class="row" style="margin:10px 0"><button class="btn sm" onclick="navigator.clipboard.writeText(LAB.gradingPrompt(LAB._lastQ, LAB._lastA)); this.textContent='Copied'">Copy grading prompt for an external LLM</button></div>
      <details class="qa" open><summary>Model answer</summary><div class="qa-body prose">${LAB.render(q.expected)}${q.explanation ? LAB.render(q.explanation) : ''}</div></details>`;
  };
  const _re = LAB.renderEvaluation;
  LAB.renderEvaluation = (q, a, r) => { LAB._lastQ = q; LAB._lastA = a; return _re(q, a, r); };

  LAB.gradingPrompt = (q, a) => `You are a strict senior backend / system design interviewer (5-10 years experience bar, UAE and India markets).
Score the candidate's answer from 0-10 on: technical correctness, depth, architecture reasoning, trade-off analysis, communication, practical engineering experience. Then list what they missed and one follow-up question you would ask.

QUESTION:
${q.q}

RUBRIC POINTS THE INTERVIEWER LISTENS FOR:
${keyPointsFor(q).map(k => '- ' + k[0]).join('\n')}

CANDIDATE ANSWER:
${a}`;

  /* ---------- phase rubrics for design interviews ---------- */
  const SD_PHASES = [
    { key: 'Step 1', name: 'Requirements', prompt: t => `Let's design **${t.title}**. Before drawing anything: what functional and non-functional requirements would you clarify, what is in and out of scope, and what assumptions will you make?`,
      kp: [['Functional requirements listed', 'functional|user(s)? (can|should)|feature|must (be able|support)'], ['Non-functional requirements (latency, availability, consistency, durability)', 'latency|availability|available|consisten|durab|throughput'], ['Explicit scope / out-of-scope', 'scope|out of scope|not (cover|include|support)|exclude|v1|mvp'], ['Scale assumptions stated', '\\d+\\s*(k|m|b|million|billion|thousand)\\b|\\d+\\s*(dau|users|requests|orders|messages|events)|per (second|day|month)|qps|daily active'], ['Clarifying questions asked', '\\?|clarif|ask|confirm']] },
    { key: 'Step 2', name: 'Capacity estimation', prompt: t => `Give me a back-of-the-envelope capacity estimate for ${t.title}: QPS (average and peak), read/write ratio, storage over a few years and bandwidth. Show the arithmetic.`,
      kp: [['Daily active users / volume assumption', 'dau|daily|per day|users'], ['QPS computed from daily volume (÷ ~86,400 or ~10^5)', 'qps|rps|per second|/s\\b|86,?400|10\\^?5|100k'], ['Peak factor considered', 'peak|burst|spike|[x×]\\s*\\d|\\d\\s*[x×]'], ['Read/write ratio', 'read.{0,15}write|write.{0,15}read|ratio|\\d+\\s*:\\s*1'], ['Storage estimate with growth / retention', 'storage|tb|pb|gb|bytes|retention|years?'], ['Bandwidth / egress', 'bandwidth|egress|ingress|gbps|mbps|mb/s|gb/s']] },
    { key: 'Step 3', name: 'API design', prompt: t => `Design the core APIs for ${t.title}. Show endpoints, request/response shapes, how clients authenticate, pagination and error handling.`,
      kp: [['REST endpoints with correct verbs', '\\b(get|post|put|patch|delete)\\b\\s*/'], ['Authentication (bearer token / OAuth / API key)', 'auth|bearer|token|jwt|oauth|api.?key'], ['Pagination strategy (cursor preferred at scale)', 'cursor|pagina|page|limit|offset'], ['Error handling / status codes', '4\\d\\d|5\\d\\d|error|problem\\+json'], ['Idempotency for writes', 'idempot'], ['Versioning or rate limiting mentioned', 'v1|version|rate.?limit|429']] },
    { key: 'Step 4', name: 'Data model', prompt: t => `What does the data model look like for ${t.title}? Which databases do you choose and why, what are the keys and indexes, and how will you partition the data?`,
      kp: [['Database choice justified by access pattern', '(postgres|mysql|sql|cassandra|dynamo|mongo|redis|elastic|s3|nosql).{0,120}(because|since|access|pattern|query|consisten|scale)|(because|since).{0,120}(postgres|mysql|sql|cassandra|dynamo|nosql)'], ['Tables/collections with key fields', 'table|collection|schema|column|field|\\bid\\b'], ['Primary / partition key choice', 'primary key|partition key|shard key|clustering|hash key'], ['Indexes for main queries', 'index'], ['Sharding / partitioning strategy and hot-key risk', 'shard|partition|hot'], ['Relationships / denormalisation discussed', 'relation|foreign|join|denormal|normaliz']] },
    { key: 'Step 5', name: 'High-level architecture', prompt: t => `Walk me through the high-level architecture of ${t.title}. Name each component and trace the main read and write paths.`,
      kp: [['Load balancer / API gateway at the edge', 'load balanc|gateway|\\blb\\b|alb|nginx|envoy'], ['Separate services with clear responsibility', 'service'], ['Cache layer and what is cached', 'cache|redis|memcache|cdn'], ['Asynchronous messaging where appropriate', 'kafka|queue|sqs|sns|rabbit|event|async'], ['Write path traced', 'write|create|post|publish|upload'], ['Read path traced', 'read|fetch|get|query|serve']] },
    { key: 'Step 6', name: 'Deep dive', prompt: t => (t.mock && t.mock.deep) || `Pick the most critical component of ${t.title} and explain exactly how it works internally.`, kp: null },
    { key: 'Step 7', name: 'Scalability', prompt: t => `Traffic grows 10× for ${t.title}. What breaks first, and how do you scale each tier?`,
      kp: [['Identifies the first bottleneck', 'bottleneck|breaks? first|first to|saturat|limit'], ['Horizontal scaling of stateless tier', 'horizontal|stateless|autoscal|replicas|more (pods|instances|nodes)'], ['Database scaling (replicas, sharding, partitioning)', 'read replica|replica|shard|partition'], ['Caching / CDN strategy', 'cache|cdn'], ['Async / queue-based load levelling', 'async|queue|kafka|backpressure|batch'], ['Hot keys / hot partitions handled', 'hot (key|partition|shard|spot)|celebrity|skew']] },
    { key: 'Step 8', name: 'Reliability', prompt: t => `A dependency or a whole availability zone fails. Walk me through the failure scenarios for ${t.title} and how the system stays correct and available.`,
      kp: [['Concrete failure scenarios enumerated', 'fail|down|outage|crash|partition|timeout'], ['Retries with backoff and jitter', 'retr(y|ies)|backoff|jitter'], ['Circuit breaker / bulkhead / timeouts', 'circuit|bulkhead|timeout|fallback'], ['Replication and failover', 'replica|failover|multi-?az|standby|quorum'], ['Idempotency / exactly-once effect', 'idempot|dedup|exactly.?once|outbox'], ['DR targets (RPO/RTO) and backups', 'rpo|rto|backup|disaster|region']] },
    { key: 'Step 9', name: 'Security', prompt: t => `How do you secure ${t.title}?`,
      kp: [['Authentication (OAuth2/OIDC/JWT)', 'oauth|oidc|jwt|token|authenticat'], ['Authorization model (RBAC/ABAC/ownership checks)', 'rbac|abac|authoriz|role|permission|owner'], ['Encryption in transit and at rest', 'tls|https|encrypt|kms|at rest'], ['Rate limiting / abuse protection', 'rate.?limit|throttl|waf|ddos|abuse|captcha'], ['Sensitive data protection / audit', 'pii|mask|audit|gdpr|pci|tokeni|secret']] },
    { key: 'Step 10', name: 'Trade-offs', prompt: t => `What are the biggest trade-offs in your design for ${t.title}, and what alternative would you choose under different requirements?`,
      kp: [['Names a concrete alternative', 'instead|alternative|could (also )?use|vs\\.?|versus|option'], ['States what is given up', 'trade-?off|cost|downside|at the expense|sacrific|complex'], ['Ties the choice to stated requirements', 'because|requirement|given|since|if (we|the)'], ['Consistency vs availability / latency reasoning', 'consisten|availab|latency|cap\\b|eventual']] }
  ];

  const LLD_PHASES = [
    { re: /requirement/i, name: 'Requirements', prompt: t => `Let's do a low-level design for **${t.title}**. What requirements and constraints would you confirm first?`,
      kp: [['Functional requirements', 'should|must|can|support|allow'], ['Non-functional (concurrency, extensibility, performance)', 'concurren|thread|extensib|performance|scal|maintain'], ['Scope boundaries / assumptions', 'assum|scope|out of scope|ignore|v1'], ['Clarifying questions', '\\?|clarif|ask']] },
    { re: /entit|class/i, name: 'Core entities', prompt: t => `What are the core entities and classes for ${t.title}, and what is each one responsible for?`, kp: null },
    { re: /pattern/i, name: 'Design patterns', prompt: t => `Which design patterns would you apply in ${t.title}, where exactly, and why? Which would you deliberately avoid?`, kp: null },
    { re: /implementation|code/i, name: 'Implementation', prompt: t => (t.mock && t.mock.code) || `Write (or describe precisely) the most important method in ${t.title}, including how it handles invalid input.`,
      kp: [['Concrete method signature / code', '(public|private|void|class|interface|return|\\w+\\()'], ['Validation / error handling', 'throw|exception|invalid|validat|optional|null'], ['Uses abstractions not concretes', 'interface|abstract|strategy|inject']] },
    { re: /concurren|thread/i, name: 'Concurrency', prompt: t => `Two users act on ${t.title} at the same instant on the same resource. What can go wrong and how does your design prevent it?`,
      kp: [['Identifies the race condition', 'race|concurren|same time|simultaneous|double'], ['Locking or atomic primitive chosen', 'lock|synchron|atomic|cas|compare.?and|reentrant|semaphore|concurrenthashmap'], ['Lock granularity considered', 'granular|per[- ](spot|seat|account|resource|key|floor)|striped|fine'], ['Distributed case (DB row lock / optimistic version / Redis)', 'optimistic|version|select .* for update|row lock|redis|distributed']] },
    { re: /extensib/i, name: 'Extensibility', prompt: t => `Product asks for a significant new feature in ${t.title} next quarter. How does your design absorb it without rewriting core classes?`,
      kp: [['Open/closed principle applied', 'open.?closed|ocp|extend|without modif'], ['New implementation of an existing interface', 'new (class|implementation|strategy)|implement|plug'], ['Configuration / registration rather than if-else', 'registr|map|config|factory|if.?else|switch']] }
  ];

  function section(body, re) {
    const parts = String(body).replace(/\r/g, '').split(/\n(?=\s*## )/);
    const hit = parts.find(p => re.test((p.match(/##\s+(.*)/) || [])[1] || ''));
    return hit ? hit.replace(/^\s*##\s+.*\n/, '') : '';
  }
  function bulletsAsKp(md, n) {
    // Use the first n meaningful bullet lines of a section as rubric items (keyword = 2 longest words).
    return String(md).split('\n').filter(l => /^\s*[-*]\s+\S/.test(l)).slice(0, n).map(l => {
      const txt = l.replace(/^\s*[-*]\s+/, '').replace(/[*{}`]/g, '');
      const label = txt.split(/[:—–.(]/)[0].trim().slice(0, 90);
      const words = label.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || [];
      const keys = words.sort((a, b) => b.length - a.length).slice(0, 2).map(w => w.slice(0, Math.max(4, w.length - 2)));
      return [label, keys.length ? keys.join('|') : label.toLowerCase()];
    }).filter(k => k[0].length > 2);
  }

  function sdQuestions(t, n) {
    const phases = n >= 9 ? SD_PHASES.slice(0, 10) : n >= 7 ? SD_PHASES.filter((p, i) => [0, 1, 2, 3, 4, 5, 7].includes(i)) : SD_PHASES.filter((p, i) => [0, 1, 4, 5, 9].includes(i));
    const qs = phases.map(p => {
      const sec = section(t.body, new RegExp(p.key + '\\b'));
      let kp = p.kp;
      if (!kp) kp = (t.mock && t.mock.keys) || bulletsAsKp(sec, 6);
      return { id: 'mock:' + t.key + ':' + p.name, module: 'sd', topic: t.title, phase: p.name, q: p.prompt(t), keyPoints: kp, expected: sec || '_See the full walkthrough in the System Design module._', minutes: 0 };
    });
    if (n >= 9) {
      const fu = section(t.body, /Step 11/).split(/\n(?=\s*\?\?)/).filter(x => /^\s*\?\?/.test(x));
      const pick = fu[Math.floor(Math.random() * fu.length)];
      if (pick) { const [h, ...rest] = pick.trim().split('\n'); qs.push({ id: 'mock:' + t.key + ':followup', module: 'sd', topic: t.title, phase: 'Follow-up', q: h.replace(/^\?\?\s*/, ''), expected: rest.join('\n'), keyPoints: null }); }
    }
    return qs;
  }
  function lldQuestions(t, n) {
    const phases = n >= 7 ? LLD_PHASES : n >= 5 ? LLD_PHASES.filter((p, i) => i !== 5) : LLD_PHASES.filter((p, i) => [0, 1, 2, 4].includes(i));
    return phases.map(p => {
      const sec = section(t.body, p.re) || (p.name === 'Concurrency' ? section(t.body, /mistake|extensib/i) : '');
      let kp = p.kp;
      if (!kp) kp = p.name === 'Core entities' ? ((t.mock && t.mock.entities) || bulletsAsKp(sec, 7)) : ((t.mock && t.mock.patterns) || bulletsAsKp(sec, 5));
      return { id: 'mock:' + t.key + ':' + p.name, module: 'lld', topic: t.title, phase: p.name, q: p.prompt(t), keyPoints: kp, expected: sec || '_See the full problem in the LLD module._' };
    });
  }

  const TYPES = [
    { id: 'sd', label: 'System Design interview', desc: 'One end-to-end problem, phase by phase: requirements → estimation → APIs → data → architecture → deep dive → scale → reliability → trade-offs.' },
    { id: 'lld', label: 'LLD interview', desc: 'One machine-coding style problem: requirements, entities, patterns, core implementation, concurrency, extensibility.' },
    { id: 'hld', label: 'HLD concepts interview', desc: 'Distributed-systems building blocks: caching, queues, consistency, sagas, resilience, scaling.' },
    { id: 'java', label: 'Java / Spring Boot interview', desc: 'JVM, concurrency, Spring internals, JPA/Hibernate, transactions, microservices.' },
    { id: 'iam', label: 'IAM-focused interview', desc: 'OAuth2/OIDC, JWT, PKCE, Keycloak SPIs, Cognito triggers, OTP, multi-tenant IAM.' },
    { id: 'mixed', label: 'Mixed senior loop', desc: 'A blend across all modules weighted towards advanced questions, like a real panel.' }
  ];
  const DUR = { 30: 5, 45: 7, 60: 9 };

  function buildSession(type, minutes) {
    const n = DUR[minutes];
    let qs = [];
    const pickQs = (filter, k) => {
      const pool = LAB.questions.filter(filter).sort(() => Math.random() - .5);
      // prefer a level mix weighted to intermediate/advanced
      pool.sort((a, b) => ({ beginner: 2, intermediate: 1, advanced: 0 }[a.level] - { beginner: 2, intermediate: 1, advanced: 0 }[b.level]) + (Math.random() - .5) * 1.5);
      return pool.slice(0, k);
    };
    let label = TYPES.find(t => t.id === type).label, subject = '';
    if (type === 'sd') { const ts = LAB.topicsOf('sd'); const t = ts[Math.floor(Math.random() * ts.length)]; subject = t.title; qs = sdQuestions(t, n); }
    else if (type === 'lld') { const ts = LAB.topicsOf('lld').filter(t => t.section === 'LLD Interview Problems'); const t = ts[Math.floor(Math.random() * ts.length)]; subject = t.title; qs = lldQuestions(t, n); if (n >= 7) qs = qs.concat(pickQs(q => q.module === 'lld', 1)); }
    else if (type === 'mixed') { qs = pickQs(q => q.level !== 'beginner', n); }
    else qs = pickQs(q => q.module === type, n);
    const per = Math.floor(minutes / Math.max(1, qs.length));
    return { type, label, subject, minutes, qs, per, i: 0, answers: [], results: [], start: Date.now(), phase: 'answer' };
  }

  let session = null, timerId = null;

  LAB.mockView = function () {
    if (!session) return setupView();
    if (session.phase === 'done') return summaryView();
    return questionView();
  };

  function setupView() {
    const hist = LAB.store.state.mocks.slice(-3).reverse();
    return `<div class="page-head"><h1>🎙 Mock Interview</h1><p>The interviewer asks one question at a time. The model answer stays hidden until you submit. Each answer is scored 0–10 across six dimensions (technical correctness, depth, architecture reasoning, trade-offs, communication, practical experience) and you see exactly which rubric points you missed.</p></div>
      <div class="section-title">1 · Interview type</div>
      <div class="grid g3" id="mType">${TYPES.map((t, i) => `<div class="card link ${i === 0 ? 'sel' : ''}" data-t="${t.id}" style="${i === 0 ? 'border-color:var(--accent)' : ''}"><h3>${t.label}</h3><p>${t.desc}</p></div>`).join('')}</div>
      <div class="section-title">2 · Length</div>
      <div class="seg" id="mDur">${Object.keys(DUR).map((d, i) => `<button data-d="${d}" class="${i === 0 ? 'on' : ''}">${d} minutes · ${DUR[d]} questions</button>`).join('')}</div>
      <div style="margin-top:22px" class="row"><button class="btn primary" id="mStart">Start interview →</button><span class="muted sm">Tip: answer as you would speak it. Lead with the answer, then justify, then trade-offs.</span></div>
      ${hist.length ? `<div class="section-title">Recent</div>${hist.map(m => `<div class="row sm" style="margin:4px 0"><span>${new Date(m.date).toLocaleDateString()}</span><span>${esc(m.typeLabel)}${m.subject ? ' · ' + esc(m.subject) : ''}</span><span class="spacer"></span><b>${m.score.toFixed(1)}/10</b></div>`).join('')}` : ''}`;
  }

  function questionView() {
    const q = session.qs[session.i], res = session.results[session.i];
    return `<div class="row" style="margin-bottom:10px"><span class="chip accent">${esc(session.label)}${session.subject ? ' · ' + esc(session.subject) : ''}</span><span class="chip">Question ${session.i + 1} / ${session.qs.length}</span>${q.phase ? `<span class="chip">${esc(q.phase)}</span>` : `<span class="chip ${q.level}">${q.level}</span>`}<span class="spacer"></span><span class="timer" id="mTimer">--:--</span><button class="btn sm ghost" id="mQuit">End interview</button></div>
      <div class="card"><div class="muted sm">Interviewer</div><div class="mock-q">${LAB.render(q.q).replace(/^<p>|<\/p>$/g, '')}</div>
      ${res ? `<div class="card" style="background:var(--panel2)"><div class="muted sm">Your answer</div><div style="white-space:pre-wrap">${esc(session.answers[session.i] || '(skipped)')}</div></div><div style="margin-top:14px">${LAB.renderEvaluation(q, session.answers[session.i], res)}</div>
        <div class="row" style="margin-top:14px"><span class="spacer"></span><button class="btn primary" id="mNext">${session.i + 1 < session.qs.length ? 'Next question →' : 'Finish & see report →'}</button></div>`
      : `<textarea id="mAns" placeholder="Type your answer as you would say it… (Ctrl/Cmd+Enter to submit)" style="min-height:240px"></textarea>
        <div class="row" style="margin-top:10px"><span class="muted sm">Suggested time: ~${session.per} min</span><span class="spacer"></span><button class="btn" id="mSkip">Skip</button><button class="btn primary" id="mSubmit">Submit answer</button></div>`}
      </div>`;
  }

  function summaryView() {
    const s = session, avg = s.results.reduce((a, r) => a + r.overall, 0) / Math.max(1, s.results.length);
    const dimAvg = {};
    s.results.forEach(r => Object.entries(r.dims).forEach(([k, v]) => dimAvg[k] = (dimAvg[k] || 0) + v / s.results.length));
    const missed = s.results.flatMap((r, i) => r.hits.filter(h => !h.ok).map(h => ({ q: i + 1, label: h.label })));
    const verdict = avg >= 8 ? 'Strong hire signal for this round' : avg >= 6.5 ? 'Leaning hire — tighten the weak dimensions' : avg >= 5 ? 'Borderline — the gaps below would likely be probed' : 'Not ready yet for this round — revisit the module, then retry';
    return `<div class="page-head"><h1>Interview report</h1><p>${esc(s.label)}${s.subject ? ' · ' + esc(s.subject) : ''} · ${s.minutes} minutes · ${Math.round((Date.now() - s.start) / 60000)} min used</p></div>
      <div class="grid g2"><div class="card"><div class="score-big">${avg.toFixed(1)}<span class="muted" style="font-size:20px">/10</span></div><p><b>${verdict}</b></p>${Object.entries(dimAvg).map(([k, v]) => `<div class="dim"><span>${k}</span><div class="bar"><i style="width:${v * 10}%"></i></div><b>${v.toFixed(1)}</b></div>`).join('')}</div>
      <div class="card"><h3>What you missed</h3>${missed.length ? missed.slice(0, 18).map(m => `<div class="kp"><span class="n">✗</span><span>Q${m.q}: ${esc(m.label)}</span></div>`).join('') : '<p>No rubric points missed. Now practise saying it in less time.</p>'}</div></div>
      <div class="section-title">Per question</div>
      ${s.qs.map((q, i) => `<details class="qa"><summary>Q${i + 1} · ${(s.results[i] || { overall: 0 }).overall.toFixed(1)}/10 · ${esc((q.phase ? q.phase + ': ' : '') + q.q.replace(/[*{}]/g, '').slice(0, 110))}</summary><div class="qa-body"><div class="muted sm">Your answer</div><div style="white-space:pre-wrap;margin-bottom:10px">${esc(s.answers[i] || '(skipped)')}</div><div class="prose">${LAB.render(q.expected)}</div></div></details>`).join('')}
      <div class="row" style="margin-top:16px"><button class="btn primary" id="mAgain">New interview</button><a class="btn" href="#/progress">View progress</a></div>`;
  }

  function finish() {
    clearInterval(timerId);
    const s = session; s.phase = 'done';
    const avg = s.results.reduce((a, r) => a + r.overall, 0) / Math.max(1, s.results.length);
    const dims = {}; s.results.forEach(r => Object.entries(r.dims).forEach(([k, v]) => dims[k] = (dims[k] || 0) + v / s.results.length));
    LAB.store.addMock({ date: Date.now(), type: s.type, typeLabel: s.label, subject: s.subject, minutes: s.minutes, score: avg, dims, perQ: s.qs.map((q, i) => ({ id: q.id, topic: q.topic || q.phase, score: (s.results[i] || { overall: 0 }).overall })) });
    // feed weak areas: real bank questions get a confidence derived from the score
    s.qs.forEach((q, i) => { if (!q.id.startsWith('mock:') && s.results[i]) LAB.store.setQuestion(q.id, { lastScore: s.results[i].overall }); });
    LAB.route();
  }

  function tick() {
    const el = $('#mTimer'); if (!el || !session) return clearInterval(timerId);
    const left = session.minutes * 60 - Math.floor((Date.now() - session.start) / 1000);
    const m = Math.floor(Math.abs(left) / 60), s = Math.abs(left) % 60;
    el.textContent = (left < 0 ? '+' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    el.classList.toggle('low', left < 300);
  }

  LAB.mockAfter = function () {
    if (!session) {
      let type = 'sd', dur = 30;
      $$('#mType [data-t]').forEach(c => c.onclick = () => { type = c.dataset.t; $$('#mType [data-t]').forEach(x => x.style.borderColor = x === c ? 'var(--accent)' : ''); });
      $$('#mDur [data-d]').forEach(b => b.onclick = () => { dur = +b.dataset.d; $$('#mDur [data-d]').forEach(x => x.classList.toggle('on', x === b)); });
      $('#mStart').onclick = () => { session = buildSession(type, dur); LAB.route(); };
      return;
    }
    if (session.phase === 'done') { $('#mAgain').onclick = () => { session = null; LAB.route(); }; return; }
    clearInterval(timerId); timerId = setInterval(tick, 1000); tick();
    $('#mQuit').onclick = () => { if (confirm('End the interview now and see the report?')) { session.qs = session.qs.slice(0, Math.max(1, session.results.filter(Boolean).length)); if (!session.results.length) { session = null; clearInterval(timerId); LAB.route(); return; } finish(); } };
    const submit = skip => {
      const ans = skip ? '' : $('#mAns').value;
      session.answers[session.i] = ans;
      session.results[session.i] = LAB.evaluate(session.qs[session.i], ans);
      LAB.route();
    };
    if ($('#mSubmit')) {
      const ta = $('#mAns'); ta.focus();
      ta.onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(false); };
      $('#mSubmit').onclick = () => { if (ta.value.trim().split(/\s+/).length < 5 && !confirm('Very short answer. Submit anyway?')) return; submit(false); };
      $('#mSkip').onclick = () => submit(true);
    }
    if ($('#mNext')) $('#mNext').onclick = () => { if (session.i + 1 < session.qs.length) { session.i++; LAB.route(); } else finish(); };
  };
})();
