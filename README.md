# Architecture Interview Lab

An interactive, offline-first preparation platform for Senior Java / Backend / Tech Lead interviews (UAE and India, 5-10 years of experience): system design, low-level design, distributed-systems building blocks, Java and Spring Boot internals, and Identity & Access Management.

## Run it

No build step, no paid APIs, no backend.

**Option 1: open the file.** Double-click `index.html` (Chrome, Edge, Firefox or Safari).

**Option 2: serve it locally** (recommended; also what the in-app preview uses):

```bash
cd "/Users/kartik/Documents/Learning/AI/System Design"
```

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765. After editing files, hard-refresh (Cmd+Shift+R) so the browser does not serve cached scripts.

Internet is only needed for Mermaid diagrams (loaded from the jsDelivr CDN, pinned to `mermaid@10.9.1`). Offline, the diagram source text is shown instead. Everything else, including all 12 simulations, works fully offline.

## What's inside

| Area | Content |
|---|---|
| Low-Level Design | OOP, SOLID, UML, relationships, DI, clean/hexagonal architecture, DDD, extensibility, concurrency; 13 GoF patterns; 15 full problems (Parking Lot, Elevator, ATM, Library, Food Ordering, Movie Booking, Splitwise, Ride Booking, Payments, Notifications, Rate Limiter, Logging, Inventory, Hotel, Chess) each with requirements, entities, UML, patterns, Java code, method walkthrough, concurrency, extensibility, mistakes and follow-ups |
| High-Level Design | 30 concepts (monolith vs microservices through cloud-native), each with definition, why it exists, when to use and not use, use case, diagram, pros/cons, Spring Boot example, interview and advanced questions |
| System Design | 20 end-to-end problems following the 11-step interview structure, with capacity maths and 10 follow-ups each |
| Java & Spring Boot | 26 topics: JVM, GC, JMM, concurrency, Java 8-21, Spring IoC, lifecycle, auto-config, MVC lifecycle, Security, REST, JPA/Hibernate, transactions, isolation, N+1, HikariCP, microservices, Spring Cloud, tracing, testing |
| Identity & Access | 21 topics: OAuth 2.0, OIDC, SAML, JWT, tokens, PKCE, client credentials, Keycloak architecture/realms/SPIs/authenticators/flows/federation, Cognito, Lambda triggers, OTP, sessions, revocation, RBAC/ABAC, SSO, multi-tenant IAM |
| Question bank | 60 questions over 3 levels and 6 types (direct, scenario, debugging, architecture decision, code review, trade-off), each with expected answer, explanation, example, common wrong answers, follow-ups and a scoring rubric |
| Visual Labs | 12 simulations with play/pause/step, speed, parameters, clickable components and failure injection |
| Mock interview | System Design, LLD, HLD, Java/Spring, IAM or mixed; 30/45/60 minutes; one question at a time; scored on six dimensions |
| Progress | Topic completion, confidence ratings, bookmarks, weak areas, revision flashcards, random question, readiness score, export/import |

### The visual labs

Request flow through microservices (with exploded service view), load balancing algorithms, Redis caching strategies, Kafka partitions and consumer groups, replication and failover, sharding and consistent hashing, Saga with compensation, circuit breaker state machine, rate limiter algorithms, OAuth 2.0 / PKCE / client credentials, Spring Boot request lifecycle, and node failures with quorums and Raft leader election.

They are 2D canvas simulations by design: each one models behaviour (queues, quorums, state machines, offsets) that you change and watch. 3D would add visual noise without clarifying any of these mechanisms.

### How mock interview scoring works

Scoring runs locally, with no AI service. Each question has rubric points (the things an interviewer listens for), matched against your answer with regular expressions. The score also counts signals of reasoning ("because", "so that"), trade-off language, structure (a lead sentence and lists) and production experience (monitoring, incidents, rollout). Treat the score as a checklist of what you mentioned, not a judgement of quality. For a second opinion, each result has a **Copy grading prompt** button that bundles the question, rubric and your answer so you can paste it into any LLM you already use.

## Project structure

```text
index.html            app shell; loads everything with plain <script> tags (works from file://)
css/styles.css        theme tokens (dark/light), layout, components
js/core/lab.js        namespace + content registry (LAB.add, LAB.addQuestions)
js/core/md.js         tiny Markdown renderer + Java/SQL/YAML highlighter
js/core/store.js      localStorage progress, readiness and weak-area calculations
js/core/app.js        router and views (dashboard, modules, topics, labs, question bank, revision, progress, search)
js/mock.js            mock interview sessions + answer evaluator
js/viz/engine.js      simulation engine (Sim, SeqSim)
js/viz/flows.js       request flow, saga, OAuth, Spring lifecycle
js/viz/traffic.js     load balancer, rate limiter, circuit breaker, Kafka
js/viz/data.js        Redis cache, replication, sharding, node failure
content/*.js          all learning content (Markdown in JS template strings)
```

## Adding or editing content

Content files call `LAB.add(moduleId, sectionTitle, [topics])`. A topic is:

```js
{ id: 'my-topic', title: 'Title', level: 'intermediate', tags: ['x'], summary: 'One line', viz: 'kafka' /* optional */,
  body: md`## Heading
Markdown text with {{inline code}}.
~~~java
// code fences use ~~~ because the content lives inside JS template strings
~~~
?? A question that reveals its answer on click
The answer, in Markdown.
` }
```

Conventions inside `md` templates: `~~~lang` fences, `{{code}}` for inline code, `\${` for a literal `${`, and `??` lines for collapsible Q&A. Questions use `LAB.addQuestions([...])` (see `content/questions.js`). Add a `keyPoints` array of `[label, regex]` pairs so mock interviews can score the question.

## Data and privacy

Progress is stored only in your browser's localStorage (key `archlab.v1`), per browser and per origin. `file://` and `http://localhost:8765` keep separate progress. Use **Progress → Export** to back it up or move it.
