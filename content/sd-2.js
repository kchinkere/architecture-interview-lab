(function () {
const md = LAB.md;
const S = 'Transactions & Platforms';

LAB.add('sd', S, [
{ id: 'payment-gateway', title: 'Payment Gateway', level: 'advanced', tags: ['payments', 'idempotency', 'ledger', 'pci'], viz: 'saga',
  summary: 'Merchant-facing gateway: payment intents, acquirer routing, 3-DS, idempotency, double-entry ledger, webhooks and reconciliation.',
  mock: { deep: 'How do you guarantee a merchant\'s customer is never charged twice, even with client retries, timeouts to the acquirer and duplicate webhooks?',
          keys: [['Idempotency key stored atomically with request hash', 'idempot'], ['Persist intent before calling acquirer; pass our id downstream', 'persist|before calling|downstream|acquirer.{0,40}(key|id)'], ['Timeout = unknown state, resolved via status query / reconciliation', 'unknown|pending|status (query|check)|reconcil'], ['State machine with conditional transitions', 'state|transition|conditional|version'], ['Webhook dedup by event id', 'webhook|event id|dedup'], ['Double-entry ledger', 'ledger|double.?entry|debit.{0,20}credit']] },
  body: md`
## Step 1: Requirements gathering
### Functional
- Merchants create payment intents, confirm with card/wallet/UPI, support 3-D Secure.
- Authorise, capture, void, refund; payouts/settlements to merchants.
- Webhooks to merchants on status changes; dashboard and reports.
### Non-functional
- Correctness over availability for money movement; exactly-once **effect**.
- Auditability (immutable ledger), PCI DSS compliance, data residency (UAE CBUAE, India RBI data localisation for payment data).
- Latency: authorisation dominated by external acquirer/network (hundreds of ms to seconds).
### Scope
Card and wallet payments for e-commerce; no issuing, no lending.
### Assumptions
- 10M transactions/day, peaks ×10 during sales; average ticket AED/INR equivalent of ~USD 30.

## Step 2: Capacity estimation
- 10M/day ≈ **~115 TPS** average; sale peak ≈ **1,200 TPS**.
- Each payment produces ~5-10 state changes/ledger entries and 2-4 webhooks: ledger writes ≈ 1k-10k/s at peak.
- Storage: 10M × ~5 KB (payment, events, ledger) ≈ 50 GB/day ≈ 18 TB/year; retention 7-10 years for compliance (cold storage).
- External acquirer latency means many in-flight requests: 1,200 TPS × 2 s ≈ 2,400 concurrent calls: size connection pools and use non-blocking I/O or enough threads.

## Step 3: API design
~~~http
POST /v1/payment_intents   Idempotency-Key: k1   Authorization: Bearer sk_live_...
{ "amount": 15000, "currency": "AED", "orderRef": "ORD-881", "captureMethod": "manual", "customer": "cus_9" }
-> 201 { "id": "pi_123", "status": "requires_payment_method", "clientSecret": "pi_123_secret_..." }

POST /v1/payment_intents/pi_123/confirm { "paymentMethod": "pm_tok_..." }  (from client SDK, card tokenised in hosted field)
-> 200 { "status": "requires_action", "nextAction": { "type": "3ds_redirect", "url": "..." } }  | { "status": "succeeded" }
POST /v1/payment_intents/pi_123/capture { "amount": 15000 }
POST /v1/refunds { "paymentIntent": "pi_123", "amount": 5000 }  Idempotency-Key: k2
Webhook -> merchant: POST https://merchant/webhooks  { "id": "evt_1", "type": "payment_intent.succeeded", ... }  header: Signature: t=...,v1=HMAC
~~~
Amounts in minor units (integers) with explicit currency.

## Step 4: Database design
- Relational (PostgreSQL) for intents, attempts, refunds: strong consistency, constraints.
- **Double-entry ledger**: every money movement is balanced debits and credits across accounts (customer funds in transit, merchant balance, fees, refunds). Append-only.
~~~sql
CREATE TABLE payment_intent (id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, amount BIGINT NOT NULL, currency CHAR(3) NOT NULL,
  status TEXT NOT NULL, capture_method TEXT NOT NULL, version BIGINT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL);
CREATE TABLE payment_attempt (id TEXT PRIMARY KEY, intent_id TEXT REFERENCES payment_intent, acquirer TEXT, acquirer_ref TEXT,
  status TEXT, response_code TEXT, created_at TIMESTAMPTZ, UNIQUE (acquirer, acquirer_ref));
CREATE TABLE ledger_entry (id BIGSERIAL PRIMARY KEY, txn_id TEXT NOT NULL, account TEXT NOT NULL, direction CHAR(1) CHECK (direction IN ('D','C')),
  amount BIGINT NOT NULL CHECK (amount > 0), currency CHAR(3) NOT NULL, created_at TIMESTAMPTZ NOT NULL);
-- invariant per txn_id: sum(D) = sum(C), enforced in the posting code + verified by a nightly job
CREATE TABLE idempotency_key (merchant_id TEXT, key TEXT, request_hash TEXT, status TEXT, response JSONB, PRIMARY KEY (merchant_id, key));
CREATE TABLE outbox (id UUID PRIMARY KEY, topic TEXT, payload JSONB, created_at TIMESTAMPTZ);
~~~
- Shard by merchant_id when needed; card data never stored (vault/tokenisation in a separate PCI zone).

## Step 5: High-level architecture
~~~mermaid
flowchart LR
  M["Merchant backend"] --> GW["API gateway: API keys, rate limits, mTLS"]
  SDK["Client SDK / hosted fields"] --> VAULT["Card vault & tokenisation (PCI zone)"]
  GW --> PAY["Payment service (intent state machine)"]
  PAY --> PDB[("Payments DB + outbox")]
  PAY --> RISK["Fraud / risk scoring"]
  PAY --> ROUTE["Acquirer router"]
  ROUTE --> A1["Acquirer A adapter"] & A2["Acquirer B adapter"] & UPI["UPI / wallet adapters"]
  A1 & A2 --> NET["Card networks / issuers"]
  PAY --> LEDGER["Ledger service"] --> LDB[("Ledger DB")]
  PDB -->|outbox| K{{"Kafka"}} --> WH["Webhook dispatcher"] --> M
  K --> RECON["Reconciliation"] --> FILES[("Acquirer settlement files")]
~~~

## Step 6: Detailed component design
### Payment state machine
{{requires_payment_method -> requires_confirmation -> processing -> requires_action -> succeeded/failed}}, with capture/refund sub-states. Transitions via conditional updates ({{WHERE status = ? AND version = ?}}).
### Calling the acquirer safely
1. Persist attempt (PROCESSING) **before** the network call.
2. Send with our attempt id as the acquirer's idempotency/reference key.
3. On timeout, mark **UNKNOWN**; a resolver queries the acquirer by reference; never blindly retry with a new reference.
### Routing
Choose acquirer by BIN country, currency, cost, live success rate and health; fail over on technical declines (not on issuer declines like insufficient funds).
### Ledger
Posting service writes balanced entries in one DB transaction; balances derived or maintained as snapshots. Captures, fees and refunds are separate postings, never edits.
### Webhooks
Outbox -> Kafka -> dispatcher with retries (exponential backoff up to ~3 days), HMAC signatures, per-merchant ordering not guaranteed (include event created timestamps and object versions).
### Reconciliation
Daily acquirer settlement files matched against attempts and ledger; mismatches to an exceptions queue.

## Step 7: Scalability
- Stateless payment service scales horizontally; DB is the bottleneck: partition by merchant, keep transactions short (no external calls inside DB transactions).
- Async everything that is not on the authorisation critical path (webhooks, ledger projections, analytics).
- Per-merchant rate limits to protect shared capacity.

## Step 8: Reliability
- Timeouts + UNKNOWN state + resolver job; idempotent everywhere.
- Multi-AZ DB with synchronous replica (no acknowledged payment state lost on failover).
- Acquirer outages: circuit breakers and routing to alternates.
- Webhook endpoint down: retries with backoff, dashboard shows failed deliveries, manual replay.
- Ledger invariant checks and alerts.

## Step 9: Security
- PCI DSS: tokenisation, card data only in the isolated vault (HSM-backed encryption), scope minimisation.
- Merchant auth: secret API keys (hashed at rest), restricted keys, mTLS optional; publishable keys for clients.
- 3-DS / SCA for card-not-present; device fingerprinting and velocity rules for fraud.
- Webhook HMAC signatures with timestamp to prevent replay.
- Encryption at rest (KMS), audit logs, least privilege, data localisation per regulator.

## Step 10: Trade-offs
| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| Consistency | CP (Postgres, sync replica) | AP store | Money correctness beats availability |
| Timeout handling | UNKNOWN + resolve | Treat as failure | Avoids double charges |
| Ledger | Double-entry append-only | Balance column updates | Auditability, error detection |
| Webhooks | At-least-once, signed | Exactly-once | Practical; merchants dedupe by event id |

## Step 11: Interview follow-ups
?? The merchant retries a POST with the same idempotency key while the first is still processing. What do you return?
409 Conflict ("request in progress") so the client retries later; once complete, the stored response is returned. Different body with the same key returns 422.
?? The acquirer approved but our service crashed before saving. How do you avoid a lost payment?
The attempt was persisted as PROCESSING before the call; the resolver finds stuck attempts and queries the acquirer by our reference, then completes the state. Settlement reconciliation is the final safety net.
?? Why separate authorisation and capture?
Merchants capture when goods ship (or partially for split shipments); authorisations expire after days; voiding an auth is cheaper and faster than refunding.
?? How do you compute a merchant's available balance?
Sum ledger entries on the merchant's balance account (or maintain a snapshot updated in the same transaction as postings), minus reserves/holds for chargebacks.
?? How do you handle chargebacks?
Ingest dispute notifications, move funds from merchant balance to a dispute account (ledger posting), notify merchant, manage evidence workflow, and post the final outcome.
?? How do you support currencies with different minor units (AED 2, KWD/BHD 3, JPY 0)?
Store amounts in minor units with currency; use ISO 4217 exponent per currency for formatting and conversion; never assume 2 decimals.
?? How do you test this safely?
Acquirer sandboxes, simulators injecting timeouts and declines (fault injection), contract tests for adapters, and ledger invariant property tests.
?? Where is strong consistency truly required, and where is eventual fine?
Strong: intent/attempt state and ledger postings. Eventual: dashboards, analytics, search, webhook delivery.
?? How would you route to maximise approval rates?
Track approval rates per acquirer × BIN range × currency in near real time; route via weighted scoring; retry soft declines on a second acquirer only where scheme rules allow.
?? How would you design payouts to merchants?
Daily batch from ledger balances (minus reserves), create payout records idempotently, send via bank rails (e.g. UAEFTS / IMPS / NEFT), reconcile with bank statements.
` },

{ id: 'food-delivery', title: 'Food Delivery Platform', level: 'advanced', tags: ['marketplace', 'geo', 'real-time', 'dispatch'],
  summary: 'Three-sided marketplace: discovery, ordering, restaurant workflow, rider dispatch with batching, live tracking and ETAs.',
  mock: { deep: 'How do you assign riders to orders so food is picked up when ready, and what happens when a rider rejects or goes offline?',
          keys: [['Rider location geo index', 'geo|location|nearby|h3|geohash'], ['Timing assignment to food-ready time (prep-time prediction)', 'prep|ready time|predict|eta'], ['Batching multiple orders per rider', 'batch|stack|multiple orders'], ['Atomic rider reservation and offer timeout', 'atomic|lock|reserve|timeout|offer'], ['Reassignment on reject/offline', 'reassign|reject|offline|fallback'], ['Order state machine and events', 'state|event|status']] },
  body: md`
## Step 1: Requirements gathering
### Functional
- Customers discover restaurants near them (open, delivers to address), browse menus, order, pay (card/wallet/COD).
- Restaurants receive orders on a tablet, accept/reject, mark ready.
- Riders receive delivery offers, navigate, confirm pickup and drop-off.
- Live tracking with ETA; ratings; cancellations/refunds.
### Non-functional
- Discovery fast and fresh (menu availability changes); ordering strongly consistent with payment.
- Dispatch within seconds; minimise food waiting and rider idle time.
- Peak lunch/dinner and Ramadan iftar spikes (very sharp in UAE/India).
### Assumptions
- 3M orders/day across cities; 200k active riders at peak; rider location every 5 s.

## Step 2: Capacity estimation
- Orders: 3M/day; dinner peak 25% of orders in 2 hours: 750k / 7,200 s ≈ **~100 orders/s** at peak.
- Location updates: 200k / 5 s = **40k/s**.
- Discovery queries: 30M sessions/day × 5 queries ≈ 150M/day ≈ 1.7k/s average, ~10k/s peak.
- Order status events: ~10 per order → 30M/day.

## Step 3: API design
~~~http
GET  /v1/restaurants?lat=25.2&lng=55.3&cuisine=indian&cursor=   -> open restaurants delivering here, with ETA & fee
GET  /v1/restaurants/{id}/menu                                    -> items with availability
POST /v1/orders { restaurantId, items:[...], addressId, paymentMethod, quoteId } Idempotency-Key -> 201 { orderId, status:"PLACED", eta }
GET  /v1/orders/{id}/track   (or WebSocket/SSE subscribe)         -> { status, riderLocation, etaMinutes }
Restaurant: POST /v1/merchant/orders/{id}/accept { prepMinutes } · POST /v1/merchant/orders/{id}/ready
Rider:      WS offers · POST /v1/rider/tasks/{id}/accept|pickup|deliver (with proof/OTP)
~~~

## Step 4: Database design
- Restaurants, menus: Postgres + search index with geo-shapes for delivery zones (OpenSearch geo_shape or PostGIS).
- Orders: Postgres sharded by city/order id; status history; outbox.
- Rider live state: Redis (geo + status); location history: Cassandra by delivery id.
- ETA/prep-time features: feature store; models served online.

## Step 5: High-level architecture
~~~mermaid
flowchart LR
  CU["Customer app"] --> GW["API gateway"]
  GW --> DISC["Discovery svc"] --> SRCH["Search + geo zones"]
  GW --> ORD["Order svc"] --> ODB[("Orders DB + outbox")]
  ORD --> PAY["Payment svc"]
  ODB --> K{{"Kafka: order events"}}
  K --> MER["Merchant svc"] --> TAB["Restaurant tablet (push/WebSocket)"]
  K --> DSP["Dispatch svc"] --> RG[("Redis: rider geo & status")]
  DSP --> ETA["ETA & prep-time models"]
  RID["Rider app"] <--> RGW["Rider gateway"] --> LOC["Location svc"] --> RG
  LOC --> K2{{"Kafka: locations"}} --> TRK["Tracking svc"] --> CU
~~~

## Step 6: Detailed component design
### Discovery
Pre-filter restaurants whose delivery polygon contains the customer location (geo_shape query), open now, not paused for overload; rank by relevance, ETA, promotions. Cache results per geo cell for short periods.
### Order lifecycle
PLACED -> ACCEPTED -> PREPARING -> READY -> PICKED_UP -> DELIVERED (or CANCELLED/REJECTED), conditional updates, events via outbox.
### Dispatch
- Predict food-ready time from restaurant prep history and current load.
- Search riders near the restaurant (geo index), compute rider travel ETA to restaurant; aim to arrive at ready time (avoid riders waiting).
- **Batching**: combine orders from the same/nearby restaurants heading in similar directions when it does not violate delivery promises.
- Reserve rider atomically (status CAS), send offer with timeout, on reject/timeout re-run with next best; escalate (higher fee) after repeated failures.
- Dispatch runs per city/zone in small time windows (e.g. every few seconds) to optimise assignments jointly.
### Tracking
Rider locations streamed; tracking service throttles updates per subscribed customer (e.g. every 5 s) over WebSocket/SSE; ETA recomputed on significant changes.

## Step 7: Scalability
- Partition by city (dispatch, rider index, orders) for locality and isolation.
- Discovery cached per cell; search cluster scaled by replicas.
- Restaurant overload protection: auto-pause restaurants with backlog.
- Peak pre-scaling for iftar/dinner, rider incentives (supply) and dynamic delivery fees (demand).

## Step 8: Reliability
- Restaurant tablet offline: fallback phone call/IVR; auto-cancel with refund if not accepted in N minutes.
- Rider app offline: reassign after missed heartbeats.
- Dispatch failure: orders remain READY_FOR_DISPATCH and are retried; idempotent assignment.
- Payment failures: COD fallback depending on policy; refunds via idempotent payment calls.

## Step 9: Security
- OTP-based delivery confirmation for high-value orders; masked phone numbers.
- Merchant and rider apps with device binding and role-based access.
- Fraud: promo abuse detection, fake accounts, GPS spoofing.
- PII minimisation (rider sees address only after acceptance).

## Step 10: Trade-offs
| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| Dispatch | Windowed batch per zone | Immediate greedy | Better global efficiency with seconds of delay |
| Rider assignment time | Timed to food-ready | Immediately on order | Less rider waiting at restaurant |
| Tracking | Throttled push | Client polling | Lower load, better UX |
| Partition | By city | Global | Isolation and data locality |

## Step 11: Interview follow-ups
?? A restaurant accepts and then marks an item unavailable. What happens?
Restaurant proposes substitution or partial fulfilment; customer approves in-app; order amended with price adjustment (partial refund) via idempotent payment call.
?? How do you predict preparation time?
Model per restaurant using historical prep times, current queue length, item complexity, time of day; continuously updated from READY events.
?? How do you prevent customers seeing restaurants that cannot deliver in time?
Discovery filters by estimated delivery time (rider supply in the zone + prep time) and hides or adds surcharge when over threshold.
?? How do you handle 10× spike at iftar?
Forecast and pre-scale, rider incentives scheduled in advance, restaurant throttling, wider delivery-time quotes, and degrade non-essential features.
?? How do you compute ETA shown to the customer?
Prep-time prediction + rider-to-restaurant ETA + restaurant-to-customer route ETA, with buffers; recalculated on events.
?? What if two dispatchers assign the same rider?
Rider status CAS in Redis (or conditional DB update) makes the second assignment fail; it then picks the next candidate.
?? How do you support COD reconciliation?
Riders' cash balances tracked in a ledger; deposits at hubs reconciled; limits on cash held per rider.
?? How do you handle order cancellation after rider assignment?
Depending on state: before pickup, release rider and refund (maybe partial if food prepared); after pickup, cancellation fee; all transitions via the state machine.
?? Where does eventual consistency affect the user?
Menu availability and restaurant open status in discovery may lag seconds; checkout re-validates items and prices.
?? How would you shard order data?
By city plus order id, with customer order history via a secondary index or a separate per-customer projection.
` },

{ id: 'notification-platform', title: 'Notification Platform', level: 'intermediate', tags: ['async', 'fan-out', 'priority-queues'], viz: 'kafka',
  summary: 'Company-wide multi-channel notifications: priority lanes, templates, preferences, provider failover, delivery tracking and campaigns.',
  mock: { deep: 'How do you make sure OTP notifications are never delayed by a 5-million-user marketing campaign, and how do you handle provider outages?',
          keys: [['Separate queues/topics per priority', 'priorit|separate (queue|topic)|lane'], ['Dedicated consumers / capacity for critical traffic', 'dedicated|reserved|isolat|bulkhead'], ['Rate limiting / throttling of campaigns', 'throttl|rate.?limit'], ['Provider failover with health checks / breakers', 'failover|fallback|secondary provider|circuit'], ['Retries with backoff + DLQ', 'retr|backoff|dlq|dead'], ['Idempotency / dedup by notification id', 'idempot|dedup']] },
  body: md`
## Step 1: Requirements gathering
### Functional
- Internal services send notifications via API or events: SMS, email, push, WhatsApp, in-app.
- Templates (multi-language incl. Arabic RTL), personalisation parameters.
- User preferences, opt-outs, quiet hours; regulatory consent (e.g. TRAI DLT templates in India).
- Scheduled and bulk campaigns; delivery status and analytics.
### Non-functional
- Critical (OTP, security alerts): delivered within seconds, highest priority.
- Bulk: high throughput, throttled to provider limits.
- At-least-once delivery with dedup; no duplicate SMS charges.
- Provider failover; cost awareness.
### Assumptions
- 200M notifications/day; 5% critical; campaigns up to 10M recipients.

## Step 2: Capacity estimation
- 200M/day ≈ **2.3k/s** average; campaign bursts ×10 = 23k/s (throttled by providers).
- Critical: 10M/day ≈ 115/s average, peaks 1k/s.
- Storage: delivery records 200M × 500 B ≈ 100 GB/day; keep 90 days hot ≈ 9 TB.

## Step 3: API design
~~~http
POST /v1/notifications  Idempotency-Key: <sourceEventId>
{ "userId": "u1", "template": "otp_login", "params": { "code": "482910" }, "channels": ["SMS"], "priority": "CRITICAL", "locale": "ar-AE" }
-> 202 { "notificationId": "n-1", "status": "QUEUED" }
POST /v1/campaigns { "template": "ramadan_offer", "segmentId": "seg-22", "scheduleAt": "...", "throttlePerSecond": 2000 }
GET  /v1/notifications/{id} -> { status, attempts, provider, deliveredAt }
Provider callbacks: POST /v1/callbacks/{provider}/dlr
~~~

## Step 4: Database design
- Templates and preferences: Postgres (cached in Redis/Caffeine).
- Delivery records: wide-column or partitioned Postgres by date (high write); index by notification id and user id.
- Dedup: Redis SET with TTL keyed by idempotency key (+ DB unique constraint as backstop).
- Campaign audiences: materialised in batches from segment service to S3/Kafka.

## Step 5: High-level architecture
~~~mermaid
flowchart LR
  SVC["Producer services"] --> API["Notification API"]
  SVC -->|events| K0{{"Kafka: domain events"}} --> RULES["Trigger rules"] --> API
  API --> VAL["Validate, dedupe, preferences, render"]
  VAL --> KC{{"Topic: critical"}} & KN{{"Topic: normal"}} & KB{{"Topic: bulk"}}
  KC --> WC["Critical workers (reserved capacity)"]
  KN --> WN["Normal workers"]
  KB --> WB["Bulk workers (throttled)"]
  WC & WN & WB --> PR["Provider router + breakers"] --> P1["SMS provider A"] & P2["SMS provider B"] & EM["Email (SES)"] & PU["Push (FCM/APNs)"]
  WC & WN & WB --> DR[("Delivery records")]
  P1 & P2 -->|DLR webhooks| CB["Callback svc"] --> DR
~~~

## Step 6: Detailed component design
- **Priority isolation**: separate topics and consumer groups with dedicated capacity; critical workers never process bulk.
- **Render once** in the platform with localisation; validate params; per-channel length limits.
- **Preferences**: suppress non-critical messages for opt-outs/quiet hours; transactional overrides by policy.
- **Provider router**: per-country routing (local aggregators often have better delivery), weighted by cost and live success rate; circuit breakers; failover on transient errors only.
- **Throttling**: token buckets per provider account and per campaign.
- **Retries**: short in-line retries, then delayed retry topics, then DLQ.
- **Status**: QUEUED -> SENT -> DELIVERED/FAILED from provider DLRs; dashboards per provider.

## Step 7: Scalability
Kafka partitions for parallelism (key by user id to preserve per-user ordering if needed); stateless workers autoscale on lag; campaign expansion in batches; provider capacity is the real bottleneck, so throttle and spread over time.

## Step 8: Reliability
Dedup makes redelivery safe; provider outages handled by failover; DLQ with replay tool; monitoring of OTP delivery latency p95 and conversion (OTP entered) as the real SLI.

## Step 9: Security
Never log OTP values; mask phone numbers; service-to-service auth (mTLS/client credentials); anti-SMS-pumping controls (rate limits per destination prefix, anomaly detection on spend); signed provider callbacks.

## Step 10: Trade-offs
| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| Priority handling | Separate topics + capacity | Priority field in one queue | Kafka has no per-message priority; isolation is guaranteed |
| Rendering | Central | In producers | Consistency, localisation, compliance |
| Delivery semantics | At-least-once + dedup | Exactly-once | Practical with external providers |

## Step 11: Interview follow-ups
?? How do you measure OTP delivery success if operators do not send DLRs reliably?
Use OTP verification rate within N minutes as the business SLI, alongside DLRs.
?? How do you avoid sending the same campaign twice after a crash mid-campaign?
Campaign expansion writes per-recipient notification ids deterministically (campaignId + userId) and dedupe on that key.
?? How do you respect quiet hours across time zones?
Store user time zone; scheduler computes the next allowed window and enqueues delayed messages.
?? How do you support in-app notification inbox?
Store per-user inbox entries (wide-column by user id), push real-time via WebSocket when online, badge counts maintained separately.
?? How do you handle WhatsApp template approval constraints?
Template registry with provider approval status; only approved templates can be used for business-initiated messages; validation at API time.
?? How do you reduce SMS cost?
Prefer push/WhatsApp when the user is reachable; least-cost routing per country; avoid duplicates and resend loops.
?? What if Kafka is unavailable?
Critical path: synchronous fallback to provider for OTP from the API with limited concurrency; other priorities return 503 for producers to retry.
?? How would you provide per-producer quotas?
Token buckets per calling service/tenant at the API; reject or downgrade priority when exceeded.
?? How do you ensure ordering of messages to a user?
Key by user id within a topic; across priorities ordering is not guaranteed and usually not required.
?? How do you test templates in Arabic and Hindi?
Preview service rendering with sample params, RTL checks, length validation per channel, and snapshot tests.
` },

{ id: 'distributed-rate-limiter', title: 'Distributed Rate Limiter', level: 'intermediate', tags: ['redis', 'gateway', 'algorithms'], viz: 'rate-limiter',
  summary: 'Cluster-wide limits with Redis Lua token buckets, rule configuration, fail-open policy, multi-region and hot keys.',
  mock: { deep: 'Implement a cluster-wide token bucket for 50 gateway instances. Where is state kept, how is it updated atomically, and what happens if Redis is slow or down?',
          keys: [['Centralised counters in Redis', 'redis'], ['Atomic update via Lua script / single command', 'lua|atomic|script|evalsha'], ['Token bucket maths (refill by elapsed time)', 'refill|elapsed|tokens|capacity'], ['Fail-open vs fail-closed policy with timeout', 'fail.?open|fail.?closed|timeout'], ['Key design and TTL', 'key|ttl|expire'], ['Local cache / batching to reduce Redis load', 'local|batch|cache|approximate']] },
  body: md`
## Step 1: Requirements gathering
### Functional
- Limit requests per key (user, API key, IP, tenant, route) with configurable rules (e.g. 100/min, burst 20).
- Return 429 with Retry-After and RateLimit headers.
- Rules hot-reloadable; per-plan quotas.
### Non-functional
- Low added latency (target ~1-2 ms in-region).
- Accurate across many gateway instances (within small tolerance).
- Highly available; defined behaviour when the store fails.
### Assumptions
- 1M requests/s across 50 gateway instances, 10M active keys.

## Step 2: Capacity estimation
- 1M checks/s; if each is one Redis call, need a Redis Cluster able to handle ~1M ops/s: tens of shards (a single Redis shard commonly handles on the order of 100k simple ops/s; validate with benchmarks for Lua scripts which cost more).
- Memory: 10M keys × ~100 B (hash with tokens + timestamp) ≈ 1 GB, plus overhead.
- Network: 1M × ~200 B ≈ 200 MB/s.

## Step 3: API design
~~~http
Internal library/sidecar: decide(key, rule) -> { allowed, remaining, resetMs, retryAfterMs }
Admin: PUT /v1/rules/{id} { "match": { "route": "/v1/otp/*", "keyBy": "phone" }, "algorithm": "token_bucket", "capacity": 3, "refillPerMinute": 0.3 }
Response headers: RateLimit-Limit: 100, RateLimit-Remaining: 7, RateLimit-Reset: 12, Retry-After: 12
~~~

## Step 4: Database design
- Redis Cluster: key {{rl:{ruleId}:{key}}} -> hash {tokens, ts}; TTL = time to refill full bucket.
- Rules: Postgres/etcd, pushed to gateways (watch/cached).

## Step 5: High-level architecture
~~~mermaid
flowchart LR
  C["Clients"] --> LB["Load balancer"] --> G1["Gateway 1"] & G2["Gateway 2"] & GN["Gateway N"]
  G1 & G2 & GN -->|"EVALSHA token_bucket"| RC[("Redis Cluster (sharded by key)")]
  RULES["Rule service"] -->|push / watch| G1 & G2 & GN
  G1 & G2 & GN --> SVC["Backend services"]
~~~

## Step 6: Detailed component design
~~~lua
-- KEYS[1]=bucket key, ARGV: capacity, refill_per_ms, now_ms, cost
local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local cap, rate, now, cost = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
local tokens = tonumber(b[1]) or cap
local ts = tonumber(b[2]) or now
tokens = math.min(cap, tokens + math.max(0, now - ts) * rate)
local allowed = tokens >= cost
if allowed then tokens = tokens - cost end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(cap / rate))
return { allowed and 1 or 0, math.floor(tokens) }
~~~
- Use Redis server time ({{TIME}}) or tolerate small client clock skew.
- **Fail-open** with a tight timeout (e.g. 5-10 ms) for general APIs; **fail-closed** for abuse-sensitive endpoints (OTP, login).
- **Hybrid local + global**: each gateway keeps a small local token allowance and syncs with Redis in batches, cutting Redis calls at the cost of slight overshoot.

## Step 7: Scalability
Shard by key across Redis Cluster; pipeline/batch requests; local pre-filter for obviously abusive keys; separate clusters per region.

## Step 8: Reliability
Redis replicas with failover (possible brief over-admission due to async replication, acceptable); circuit breaker around Redis; metrics on decision latency and fail-open counts.

## Step 9: Security
Key on authenticated identity where possible (spoofable headers like X-Forwarded-For must be set by trusted proxies only); protect admin APIs; avoid unbounded key creation from attacker-controlled values (hash/validate keys).

## Step 10: Trade-offs
| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| State | Central Redis | Local per instance | Accuracy across instances |
| Algorithm | Token bucket | Sliding log | O(1) memory with bursts |
| Failure | Fail-open (general) | Fail-closed | Availability over strictness, except security endpoints |
| Multi-region | Per-region limits | Global synchronous counter | Cross-region latency too high |

## Step 11: Interview follow-ups
?? How do you enforce a global limit across regions?
Split the quota per region (static or adaptive based on traffic share) and periodically rebalance; exact global enforcement needs cross-region coordination that adds unacceptable latency.
?? One key receives 100k req/s (an attacker). Does it overload one Redis shard?
Yes potentially. Add a local deny cache: once a key is over limit, gateways reject it locally for the Retry-After period without calling Redis.
?? How do you rate limit by cost rather than count (expensive queries)?
Token bucket with variable cost per request (e.g. cost = estimated DB units).
?? How would you test correctness?
Deterministic tests with a fake clock; load tests asserting admitted rate within tolerance across instances.
?? How do you communicate limits to clients?
Documented quotas, RateLimit headers, 429 with Retry-After, and usage dashboards for API customers.
?? Why not use the database for counters?
Write amplification and latency on every request; Redis atomic in-memory operations fit the access pattern.
?? How do you avoid race conditions between read and write of the bucket?
The whole read-refill-decide-write runs inside one Lua script, atomic on the shard.
?? How do you limit concurrency (in-flight requests) instead of rate?
Semaphore-style counters with leases (INCR on start, DECR on finish, TTL safety), or bulkheads per service.
?? What about clock skew between gateways?
Use Redis TIME inside the script or a single time source; or design buckets that tolerate small skew.
?? How do you roll out a new stricter rule safely?
Shadow mode: evaluate and log would-be rejections without enforcing, then enforce gradually.
` },

{ id: 'hotel-booking', title: 'Hotel Booking System', level: 'intermediate', tags: ['booking', 'inventory', 'consistency'],
  summary: 'Search across hotels and dates, inventory per room-type per night, reservations, payments, overbooking and OTA sync.',
  mock: { deep: 'How do you prevent overbooking a room type when many users book overlapping dates at the same time?',
          keys: [['Inventory per room type per night', 'per night|each night|room.?type.{0,30}(date|night)'], ['Atomic conditional update across all nights', 'conditional|atomic|where .*(booked|available)|update.*where'], ['All-or-nothing transaction across nights', 'all.?or.?nothing|transaction|rollback'], ['Hold with expiry during payment', 'hold|expir|ttl|pending'], ['Idempotent booking requests', 'idempot']] },
  body: md`
## Step 1: Requirements gathering
### Functional
- Search hotels by city, dates, guests with price and availability.
- Book a room type for a date range; pay now or at hotel; cancel per policy.
- Hotel admins manage room types, inventory and rates; sync with channel managers/OTAs.
### Non-functional
- Search fast, eventually consistent; booking strongly consistent (no overbooking beyond allowance).
- Peak seasons (Dubai winter, New Year, Diwali) spike search ×10.
### Assumptions
- 50k hotels, avg 100 rooms, 365-day booking horizon; 1M searches/hour peak; 200k bookings/day.

## Step 2: Capacity estimation
- Inventory rows: 50k hotels × ~5 room types × 365 nights ≈ **91M rows** (small, ~100 B each ≈ 9 GB).
- Searches: 1M/hour ≈ **280/s** peak (each touching many hotels → served from a search/availability cache).
- Bookings: 200k/day ≈ 2.3/s average; peak ~50/s. Write load is small; contention on popular hotel-nights is the issue.

## Step 3: API design
~~~http
GET  /v1/search?city=dubai&checkIn=2026-12-30&checkOut=2027-01-02&guests=2&cursor= -> hotels with min price & availability
GET  /v1/hotels/{id}/availability?checkIn=&checkOut=&guests=  -> room types, rate plans, total price breakdown
POST /v1/reservations { hotelId, roomTypeId, ratePlanId, checkIn, checkOut, guests, paymentMethod } Idempotency-Key -> 201 { reservationId, status }
POST /v1/reservations/{id}/cancel -> { refundAmount }
~~~

## Step 4: Database design
~~~sql
CREATE TABLE room_type_inventory (hotel_id BIGINT, room_type_id BIGINT, night DATE, total INT, booked INT, overbook_allowance INT DEFAULT 0,
  PRIMARY KEY (hotel_id, room_type_id, night), CHECK (booked <= total + overbook_allowance));
CREATE TABLE reservation (id UUID PRIMARY KEY, hotel_id BIGINT, room_type_id BIGINT, guest_id UUID, check_in DATE, check_out DATE,
  status TEXT, total_amount BIGINT, currency CHAR(3), policy JSONB, created_at TIMESTAMPTZ);
CREATE TABLE rate (hotel_id BIGINT, room_type_id BIGINT, rate_plan_id BIGINT, night DATE, amount BIGINT, PRIMARY KEY (hotel_id, room_type_id, rate_plan_id, night));
~~~
Shard by hotel_id (bookings for one hotel stay on one shard, transactions remain local).

## Step 5: High-level architecture
~~~mermaid
flowchart LR
  U["User"] --> GW["API gateway"]
  GW --> SRCH["Search svc"] --> ES[("Search index: hotels + cached availability/price")]
  GW --> AV["Availability svc"] --> INV[("Inventory DB (sharded by hotel)")]
  GW --> RES["Reservation svc"] --> INV
  RES --> PAY["Payment svc"]
  INV -->|CDC| K{{"Kafka"}} --> ES
  K --> CM["Channel manager adapters (OTAs)"]
  ADM["Hotel extranet"] --> INV
~~~

## Step 6: Detailed component design
- **Search**: precomputed per hotel min price and availability flags for date ranges in the search index, updated by CDC events; stale results possible; detail page queries live availability.
- **Booking**: single conditional UPDATE incrementing booked for all nights in range where {{booked < total + allowance}}; check updated row count equals nights; insert reservation; commit. For pay-now, reservation is HELD with expiry until payment completes; expiry job releases.
- **Pricing**: rate per night per plan + taxes/fees (tourism dirham) + discounts; quote snapshot stored on the reservation.
- **OTA sync**: publish availability changes to channel managers; incoming OTA bookings use the same booking path with external reference idempotency.

## Step 7: Scalability
Search cluster scaled independently; caching of availability per (hotel, date range) with short TTL; inventory sharded by hotel; hot hotels on New Year's Eve are limited by row contention, which is acceptable at this write rate.

## Step 8: Reliability
Idempotent bookings and OTA sync; holds expire; payment failure releases inventory; multi-AZ DB; reconciliation with OTA booking reports.

## Step 9: Security
Auth for guests and hotel admins (separate realms/roles); PCI for stored cards (pay-at-hotel guarantee) via tokenisation; rate limit search scraping; audit of inventory changes.

## Step 10: Trade-offs
| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| Inventory model | Counters per night | Interval overlap queries | Simple atomic updates, fast availability |
| Search freshness | Eventually consistent | Live query | Scale; final check at booking |
| Concurrency | Conditional update | Distributed lock | DB row locks suffice, no extra component |

## Step 11: Interview follow-ups
?? How do you assign specific room numbers?
At check-in (or nightly), an assignment process allocates physical rooms using an exclusion constraint on (room_id, date range) to prevent overlaps.
?? Price changes after the user saw it in search. What do you show?
Detail and checkout re-price live; if different, show the updated price before payment.
?? How do you handle a booking spanning a night that becomes unavailable mid-transaction?
The conditional update for that night fails, row count mismatch triggers rollback; no partial booking.
?? How do you support "pay at hotel" without overbooking from no-shows?
Card guarantee with tokenised card, no-show fee policy, and overbooking allowance tuned per hotel.
?? How do you reduce load from scrapers/aggregators?
Rate limits per client, caching, and dedicated partner APIs with quotas.
?? How do you handle time zones?
Dates are local to the hotel; cancellation deadlines computed in the hotel's zone.
?? Why shard by hotel?
Booking transactions touch one hotel; per-hotel locality keeps them single-shard.
?? How do you search across 365 days quickly?
Index precomputed aggregates and use bitmaps/availability vectors per hotel-room type for date ranges.
?? How do you process OTA cancellations?
Webhook/polling from channel manager, idempotent by OTA reference, same cancel path.
?? How would you prevent double booking from OTA and direct channels?
Single source of truth inventory, all channels decrement through the same conditional update; channel manager receives updates quickly to stop selling.
` },

{ id: 'ticket-booking', title: 'Ticket Booking System', level: 'advanced', tags: ['concurrency', 'waiting-room', 'seat-locking'],
  summary: 'High-demand event ticketing: virtual waiting room, seat holds with TTL, payment, fairness and bot protection.',
  mock: { deep: '500k fans hit "Buy" for a 50k-seat concert at 10:00. Design the path from waiting room to confirmed ticket without overselling or melting the database.',
          keys: [['Virtual waiting room / queue with admission rate', 'waiting room|queue|admission|token'], ['Seat hold with TTL using atomic conditional update or Redis SETNX', 'hold|ttl|setnx|conditional|atomic'], ['Seat map served from cache', 'cache|seat map'], ['Payment then confirm; release on failure/expiry', 'payment|release|expir|confirm'], ['Bot protection and per-user limits', 'bot|captcha|limit per|per.?user'], ['Partitioning by event/section', 'partition|shard|section']] },
  body: md`
## Step 1: Requirements gathering
### Functional
- Browse events; view seat map (or general admission tiers); select seats; hold during checkout; pay; receive e-ticket (QR).
- Per-user ticket limits; resale/transfer optional.
### Non-functional
- Never sell a seat twice; holds expire reliably.
- Survive extreme spikes at on-sale time (orders of magnitude above normal).
- Fairness (first come first served at queue entry), bot resistance.
### Assumptions
- Big on-sale: 500k users within minutes for 50k seats; normal traffic small.

## Step 2: Capacity estimation
- Spike: 500k users arriving within ~5 min ≈ 1.7k new users/s, each generating many page loads/polls. Without admission control the seat map and hold endpoints would see tens of thousands of req/s.
- Admission: if checkout takes ~5 min and we admit 2k concurrent shoppers, throughput ≈ 2k / 5 min ≈ 400 checkouts/min; 50k seats sell (with ~4 tickets/order ≈ 12.5k orders) in ~30 min. Tune admission rate to DB capacity.
- Seat state: 50k rows per event: tiny; contention is the challenge.

## Step 3: API design
~~~http
POST /v1/events/{id}/queue          -> { queueToken, position, etaSeconds }   (waiting room)
GET  /v1/events/{id}/queue/status   -> { position } | { admitted: true, accessToken (JWT, 10 min) }
GET  /v1/events/{id}/seatmap        (requires accessToken)  -> seats with status (cached, ~1-2 s staleness)
POST /v1/events/{id}/holds { seatIds:[...] }  Idempotency-Key -> 201 { holdId, expiresAt } | 409 seats taken
POST /v1/orders { holdId, paymentMethod } -> { orderId, status }
~~~

## Step 4: Database design
- {{seat(event_id, seat_id, section, status, hold_id, hold_expires_at, order_id, version)}} partitioned by event_id.
- {{hold}}, {{order}}, {{ticket(qr_secret)}} tables; outbox.
- Optional Redis for hold acceleration: {{SET seat:{event}:{seat} holdId NX PX 600000}} via Lua for multi-seat atomicity; DB remains source of truth for sold seats.

## Step 5: High-level architecture
~~~mermaid
flowchart LR
  U["Fans"] --> CDN["CDN + WAF + bot protection"] --> WR["Waiting room (edge queue)"]
  WR -->|"admitted token"| GW["API gateway (verifies admission JWT)"]
  GW --> SM["Seat map svc"] --> CACHE[("Redis: seat map snapshot")]
  GW --> HOLD["Hold svc"] --> DB[("Seats DB partitioned by event")]
  HOLD --> R[("Redis holds (optional)")]
  GW --> ORD["Order svc"] --> PAY["Payment svc"]
  ORD --> DB
  DB -->|CDC| CACHE
  ORD --> TIX["Ticket issuance (QR)"]
~~~

## Step 6: Detailed component design
- **Waiting room**: users get a randomised or arrival-ordered position before on-sale; admission service releases tokens at a controlled rate; token is a signed JWT bound to user and event, required by downstream APIs.
- **Holds**: one conditional UPDATE for all requested seats where status AVAILABLE or hold expired; row count check; hold TTL ~ 8-10 min.
- **Seat map**: snapshot from cache updated by CDC; client shows near-real-time status; holding a just-taken seat returns 409 and the client refreshes.
- **Order**: payment with idempotency; on success confirm seats (HELD -> SOLD where hold_id matches); on failure release.
- **Best available**: server selects contiguous seats in a section under a section-level lock to avoid fragmentation conflicts.

## Step 7: Scalability
Admission control is the key scalability tool; CDN for static assets; cache for seat maps; DB partitions per event/section; separate infrastructure for on-sale events from normal browsing.

## Step 8: Reliability
Holds expire by predicate (correctness without background jobs); idempotent order creation; payment timeouts resolved via status queries; DR for ticket data; waiting room degrades to "please wait" rather than errors.

## Step 9: Security
Bot mitigation (device fingerprinting, CAPTCHA, verified fan pre-registration), per-account and per-card limits, signed admission tokens, rotating QR codes to prevent screenshot resale fraud.

## Step 10: Trade-offs
| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| Spike handling | Waiting room | Autoscaling alone | Seat inventory is fixed; scaling doesn't help contention |
| Seat locking | DB conditional update | Distributed lock per seat | Fewer components, DB enforces truth |
| Seat map freshness | Cached snapshot | Live query | Massive read load; holds validate anyway |

## Step 11: Interview follow-ups
?? Why not just autoscale everything?
The bottleneck is contention on a fixed set of rows and payment provider limits; autoscaling app servers increases contention. Admission control matches demand to real capacity.
?? How do you keep the waiting room fair?
Random position assignment for users who arrived before on-sale (prevents refresh races), FIFO after, tokens bound to identity.
?? A user holds seats and closes the browser. What happens?
Hold expires after TTL; seats become available by predicate; cleanup job releases holds and notifies.
?? How do you avoid leaving single empty seats?
Best-available algorithm with rules against orphan seats; validate user selections server-side.
?? How do you deliver tickets securely?
Ticket record with a server-side secret; app displays rotating QR (TOTP-like) validated at gates offline using pre-synced keys.
?? How would you handle general admission tiers instead of seats?
Counter per tier with conditional decrement (like inventory), or bucketed counters for extreme contention.
?? Payment provider rate limits you at 300 TPS. Impact?
Admission rate must keep checkout completions under that; queue payment attempts; holds sized to cover payment queue time.
?? How do you detect scalpers?
Velocity rules across accounts/cards/devices/IPs, purchase limits, verified fan programmes, transfer restrictions.
?? Can you use Redis only for holds?
For speed, yes with Lua for multi-seat atomicity, but persist confirmations in the DB and reconcile; Redis failover can lose recent holds (acceptable: user retries) but must not lose sales.
?? How do you test on-sale readiness?
Load tests replaying expected arrival curves, game days, and verifying graceful degradation of the waiting room.
` },

{ id: 'banking', title: 'Banking Transaction System', level: 'advanced', tags: ['ledger', 'consistency', 'compliance'], viz: 'replication',
  summary: 'Accounts and double-entry ledger, atomic transfers, idempotency, limits, AML hooks, statements and regulatory constraints.',
  mock: { deep: 'Design an internal transfer between two accounts that is correct under concurrency, retries and crashes. How are balances kept consistent?',
          keys: [['Double-entry ledger postings in one transaction', 'double.?entry|ledger|debit.{0,30}credit|posting'], ['Lock ordering / row locks to avoid deadlock or lost updates', 'lock|for update|order|deadlock'], ['Balance check against available balance (holds)', 'available|hold|insufficient|overdraft'], ['Idempotency key per transfer', 'idempot'], ['Serializable / strong consistency, synchronous replication', 'serializ|strong|synchronous|acid'], ['Audit trail / immutability', 'audit|immutable|append']] },
  body: md`
## Step 1: Requirements gathering
### Functional
- Accounts (current, savings), balances (ledger and available), holds (card authorisations).
- Internal transfers, external transfers (UAEFTS/IPI in UAE, IMPS/NEFT/UPI in India), bill payments.
- Statements and transaction history; limits (daily, per transaction); beneficiary management with cooling periods.
### Non-functional
- Correctness: no money created or destroyed; full audit; regulatory reporting.
- Strong consistency for balances; high availability expected but correctness wins.
- Security: MFA, fraud/AML screening; data residency.
### Assumptions
- 10M customers, 20M transactions/day.

## Step 2: Capacity estimation
- 20M/day ≈ **230 TPS** average; month-end/salary day peaks ×10 ≈ 2,300 TPS.
- Ledger entries: 2 per transfer minimum → 40M/day ≈ 40M × 200 B = 8 GB/day ≈ 3 TB/year; retained for many years (archive tiers).
- Statement reads: monthly heavy batch + app history reads (cacheable recent history).

## Step 3: API design
~~~http
POST /v1/transfers  Idempotency-Key: <uuid>  (requires step-up auth token for new beneficiaries / high amounts)
{ "fromAccount": "AE07...123", "toAccount": "AE45...789", "amount": 250000, "currency": "AED", "reference": "Rent Dec" }
-> 201 { "transferId": "t-1", "status": "COMPLETED" | "PENDING_REVIEW" | "SENT_TO_NETWORK" }
GET /v1/accounts/{id}/balance -> { ledger, available, holds }
GET /v1/accounts/{id}/transactions?from=&to=&cursor=
~~~

## Step 4: Database design
~~~sql
CREATE TABLE account (id TEXT PRIMARY KEY, customer_id TEXT, currency CHAR(3), status TEXT, balance BIGINT NOT NULL, available BIGINT NOT NULL, version BIGINT);
CREATE TABLE journal (id UUID PRIMARY KEY, type TEXT, idempotency_key TEXT UNIQUE, status TEXT, created_at TIMESTAMPTZ);
CREATE TABLE posting (id BIGSERIAL PRIMARY KEY, journal_id UUID REFERENCES journal, account_id TEXT REFERENCES account,
  amount BIGINT NOT NULL, direction CHAR(1), balance_after BIGINT, created_at TIMESTAMPTZ);   -- append-only
CREATE TABLE hold (id UUID PRIMARY KEY, account_id TEXT, amount BIGINT, expires_at TIMESTAMPTZ, status TEXT);
~~~
Relational with serializable or carefully locked transactions; partition postings by time; account balance column maintained in the same transaction as postings (and verifiable from postings).

## Step 5: High-level architecture
~~~mermaid
flowchart LR
  App["Mobile / web banking"] --> GW["API gateway + WAF"] --> AUTH["IAM: OIDC, MFA, step-up"]
  GW --> TX["Transfer service"] --> LIM["Limits & beneficiary rules"]
  TX --> FRAUD["Fraud / AML screening"]
  TX --> LED["Core ledger service"] --> LDB[("Ledger DB: sync replica, PITR")]
  TX --> EXT["Payment network gateway (UAEFTS / UPI / SWIFT)"]
  LDB -->|outbox / CDC| K{{"Kafka"}} --> NOTIF["Notifications"] & STMT["Statements / analytics"] & REG["Regulatory reporting"]
~~~

## Step 6: Detailed component design
### Internal transfer (single ledger DB)
~~~java
@Transactional(isolation = Isolation.READ_COMMITTED)
public Journal transfer(TransferCmd c) {
  journals.findByIdempotencyKey(c.key()).ifPresent(j -> { throw new AlreadyProcessed(j); });   // plus UNIQUE constraint
  // lock both accounts in a deterministic order to avoid deadlocks
  List<Account> locked = accounts.lockForUpdate(Stream.of(c.from(), c.to()).sorted().toList());  // SELECT ... FOR UPDATE
  Account from = byId(locked, c.from()), to = byId(locked, c.to());
  if (from.available() < c.amount()) throw new InsufficientFunds();
  Journal j = journals.save(Journal.transfer(c));
  postings.save(Posting.debit(j, from, c.amount()));   from.debit(c.amount());
  postings.save(Posting.credit(j, to, c.amount()));    to.credit(c.amount());
  outbox.save(TransferCompleted.of(j));
  return j;
}
~~~
### External transfers
Debit customer to a clearing/suspense account first (funds reserved), send to network with unique reference, then on network confirmation move from suspense to nostro; on rejection reverse. Every step is a balanced journal.
### Holds
Card authorisations create holds reducing available balance; settlement converts hold to posting; expiry releases.
### Limits
Daily limits via counters per customer per day (in the same DB transaction or with reservation semantics).

## Step 7: Scalability
Vertical scaling plus partitioning by account range or customer for the ledger when needed; read replicas/projections for history and statements; async downstream processing via outbox; hot accounts (merchant/settlement accounts receiving many credits) use sub-accounts or batched postings.

## Step 8: Reliability
Synchronous replication within region (RPO 0), DR region async with tested failover; idempotency for every external interaction; end-of-day reconciliation (ledger vs network vs core); invariant checks (sum of postings per journal = 0).

## Step 9: Security
MFA and step-up auth for transfers, device binding, beneficiary cooling-off periods, fraud scoring and AML screening (sanctions lists), encryption, HSMs for keys, immutable audit logs, least privilege, maker-checker for admin operations.

## Step 10: Trade-offs
| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| Ledger store | Relational ACID | Event store / NoSQL | Mature transactions, constraints, auditors understand it |
| Concurrency | Pessimistic row locks | Optimistic retries | Hot accounts + money correctness; deterministic order prevents deadlocks |
| Balance | Maintained + verifiable | Computed on read only | Fast reads; integrity check job |

## Step 11: Interview follow-ups
?? Why not compute balance by summing postings on every read?
Too slow for long histories; maintain balance in the same transaction, and periodically verify against postings (or use snapshots + delta).
?? How do you handle a hot account that receives thousands of credits per second?
Split into sub-accounts and sweep periodically, or batch credits into one posting per interval; avoid locking one row for every credit.
?? How do you prevent deadlocks in transfers?
Lock accounts in a global deterministic order (sorted ids) and keep transactions short.
?? Customer retries a transfer after a timeout. What happens?
Same idempotency key returns the existing journal result; no double debit.
?? How do you support multi-currency transfers?
FX conversion as separate legs through FX position accounts at a quoted rate stored on the journal; each currency balanced separately.
?? How would you design statements for 10M customers at month end?
Batch jobs reading from a replica/projection, partitioned by customer ranges, generating PDFs asynchronously to object storage, notifying when ready.
?? What is eventual and what is strong here?
Strong: postings and balances. Eventual: notifications, analytics, statements, search over history.
?? How do you migrate from a legacy core banking system?
Strangler approach with dual-run and reconciliation, migrating products/customers in waves, keeping the ledger of record clear at each moment.
?? How do you implement daily transfer limits correctly under concurrency?
Counter row per customer per day updated in the same transaction with a conditional check ({{used + amount <= limit}}).
?? What happens if Kafka is down?
Transfers still commit (outbox rows accumulate); notifications and downstream updates catch up when the relay resumes.
` }
]);
})();
