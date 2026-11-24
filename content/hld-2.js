(function () {
const md = LAB.md;

LAB.add('hld', 'Messaging & Events', [
{ id: 'event-driven', title: 'Event-Driven Architecture', level: 'intermediate', tags: ['events', 'eda', 'kafka'], viz: 'kafka',
  summary: 'Events as facts, choreography vs orchestration, outbox, event-carried state transfer and the pitfalls of async everything.',
  body: md`
## Definition
Services communicate by emitting **events** (facts that happened, past tense: {{OrderPlaced}}) to a broker; interested services react asynchronously. Producers do not know consumers.

## Why it exists
Temporal decoupling (consumer can be down), fan-out to many consumers without changing the producer, load levelling, and an audit-able log of business facts.

## Event types
- **Notification event**: thin ({{orderId}} only); consumers call back for details (coupling + load).
- **Event-carried state transfer**: includes the data consumers need; enables local read models; larger payloads, schema evolution matters.
- **Domain event vs integration event**: internal model change vs published contract. Do not leak internal entities as public events.

## When to use
Workflows spanning services, notifications/analytics fan-out, CQRS read models, integrating with slow/unreliable downstreams.

## When NOT to use
- When the caller needs an immediate answer (credit check before showing a price): use synchronous calls.
- Simple CRUD apps: async adds debugging and consistency complexity.
- As a way to hide tight coupling (a chain of events that must all happen in order is a workflow; make it explicit with orchestration).

## Reliability: the dual-write problem and the outbox
Writing to the DB and publishing to Kafka are two systems; one can fail. The **transactional outbox** writes the event to an {{outbox}} table in the same DB transaction; a relay (Debezium CDC or a poller) publishes it. Consumers must be idempotent because delivery is at-least-once.

## Architecture
~~~mermaid
flowchart LR
  OS["Order service"] -->|"tx: insert order + outbox row"| ODB[("Orders DB")]
  ODB -->|"CDC (Debezium)"| K{{"Kafka topic: orders.events"}}
  K --> PAY["Payment service"]
  K --> NOTIF["Notification service"]
  K --> AN["Analytics"]
~~~

## Spring Boot implementation
~~~java
@Transactional
public Order place(PlaceOrder cmd) {
  Order o = orders.save(Order.from(cmd));
  outbox.save(new OutboxEvent(UUID.randomUUID(), "Order", o.id().toString(), "OrderPlaced",
      json.write(new OrderPlaced(o.id(), o.customerId(), o.total(), o.lines())), Instant.now()));
  return o;
}

// Consumer: idempotent by event id
@KafkaListener(topics = "orders.events", groupId = "payment-service")
@Transactional
public void on(ConsumerRecord<String, String> rec) {
  UUID eventId = UUID.fromString(new String(rec.headers().lastHeader("id").value()));
  if (!processed.insertIfAbsent(eventId)) return;            // unique constraint on processed_event(id)
  OrderPlaced e = json.read(rec.value(), OrderPlaced.class);
  payments.initiate(e.orderId(), e.total());
}
~~~

## Interview questions
?? How do consumers handle events arriving out of order?
Kafka orders within a partition, so key by aggregate id. Additionally include a version/sequence in events and ignore older versions, or design handlers to be commutative.
?? Choreography vs orchestration?
Choreography: services react to each other's events (loose coupling, but the end-to-end flow is implicit and hard to monitor). Orchestration: a coordinator tells services what to do (explicit flow, easier error handling, central component). Long business workflows (> 3-4 steps, compensations) benefit from orchestration.

## Advanced follow-ups
?? How do you evolve event schemas without breaking consumers?
Use a schema registry (Avro/Protobuf/JSON Schema) with backward/forward compatibility rules: add optional fields, never remove or repurpose; for breaking changes publish a new versioned topic and migrate consumers.
` },

{ id: 'message-queues', title: 'Message Queues', level: 'beginner', tags: ['queues', 'async', 'backpressure'], viz: 'kafka',
  summary: 'Point-to-point queues vs pub/sub, delivery guarantees, acknowledgements, DLQs, ordering and backpressure.',
  body: md`
## Definition
A message queue stores messages from producers until consumers process them, decoupling them in time and rate.

## Why it exists
- **Load levelling**: absorb bursts (Black Friday) and let workers process at a sustainable rate.
- **Reliability**: work survives consumer crashes.
- **Decoupling**: producers do not need consumers to be up.

## Core concepts
- **Point-to-point** (work queue: each message processed by one consumer) vs **pub/sub** (each subscriber gets a copy).
- **Delivery semantics**: at-most-once (ack before processing), at-least-once (ack after; duplicates possible), exactly-once (only within limited scopes; aim for exactly-once **effect** via idempotency).
- **Visibility timeout / ack deadline**: message reappears if not acked in time.
- **Dead-letter queue (DLQ)**: after N failures, park the message for inspection instead of blocking the queue (poison pill).
- **Ordering**: FIFO queues or partition keys; strict global ordering limits throughput.
- **Backpressure**: bounded queues, consumer concurrency limits, producer throttling.

## When NOT to use
When the user waits for the result synchronously and latency matters, or when ordering + exactly-once requirements make a database transaction simpler.

## Architecture
~~~mermaid
flowchart LR
  API["API"] -->|enqueue| Q[["Queue"]]
  Q --> W1["Worker"] & W2["Worker"] & W3["Worker"]
  Q -.->|"after 5 failures"| DLQ[["DLQ"]]
  DLQ --> Ops["Alert + replay tool"]
~~~

## Spring Boot implementation
~~~java
// SQS with Spring Cloud AWS
@SqsListener(value = "invoice-generation", maxConcurrentMessages = "10", acknowledgementMode = "ON_SUCCESS")
public void generate(InvoiceRequested msg) {
  if (invoices.exists(msg.orderId())) return;     // idempotent: redelivery after visibility timeout
  invoices.generate(msg.orderId());
}
// Queue configured with a redrive policy: maxReceiveCount=5 -> invoice-generation-dlq
~~~

## Interview questions
?? A poison message keeps failing and blocks processing. What do you do?
Limit retries, route to a DLQ with error metadata, alert, and provide a replay tool once fixed. For ordered partitions, a failing message blocks the partition, so you must DLQ it to continue.
?? How do you make processing exactly-once?
You generally cannot get exactly-once delivery end to end; you get at-least-once delivery plus idempotent handlers (dedupe by message id, conditional updates, upserts), giving exactly-once effect.
` },

{ id: 'kafka-rabbit-sqs', title: 'Kafka vs RabbitMQ vs SQS/SNS', level: 'intermediate', tags: ['kafka', 'rabbitmq', 'sqs', 'sns'], viz: 'kafka',
  summary: 'Log-based streaming vs smart broker vs managed queue/topic: semantics, ordering, retention, scaling and when to pick each.',
  body: md`
## Kafka (distributed commit log)
- Topics split into **partitions**; each partition is an ordered, append-only log replicated across brokers (leader + ISR followers).
- Consumers in a **consumer group** split partitions (one partition -> at most one consumer in the group); they track **offsets** and can **replay**.
- Retention by time/size (days to forever, compacted topics keep the latest value per key).
- Ordering only within a partition: key by aggregate id.
- Producer settings: {{acks=all}}, {{enable.idempotence=true}}; transactions enable exactly-once **within Kafka** (consume-transform-produce).
- Scale: throughput scales with partitions; parallelism bounded by partition count.

## RabbitMQ (smart broker, AMQP)
- Exchanges (direct, topic, fanout, headers) route messages to queues by binding rules.
- Per-message acks, TTL, priority queues, dead-lettering, delayed messages (plugin).
- Messages are removed once acked (no replay; Streams add log semantics).
- Great for task queues and complex routing at moderate throughput.

## AWS SQS and SNS
- **SQS**: fully managed queue. Standard (at-least-once, best-effort ordering, nearly unlimited throughput) or FIFO (ordering per message group, deduplication window of 5 minutes, lower throughput).
- **SNS**: managed pub/sub topic pushing to SQS, Lambda, HTTP, SMS, email. Classic **fan-out**: SNS topic -> several SQS queues.
- Zero operations; integrates with Lambda; message size limit 256 KB (use S3 pointer for larger).

## Decision table
| Need | Choose |
|---|---|
| Event streaming, replay, multiple independent consumers, high throughput, CDC | Kafka (MSK / Confluent) |
| Task distribution with routing rules, priorities, per-message TTL | RabbitMQ |
| Simple managed work queue on AWS, Lambda triggers | SQS |
| Fan-out notifications to multiple queues/endpoints | SNS (+ SQS) |
| Strict ordering per entity, managed | SQS FIFO with message group id, or Kafka keyed partitions |

## Architecture
~~~mermaid
flowchart TB
  subgraph Kafka
    P["Producer (key=orderId)"] --> T0["Partition 0"] & T1["Partition 1"] & T2["Partition 2"]
    T0 --> C1["Consumer A1"]
    T1 --> C1
    T2 --> C2["Consumer A2"]
    T0 & T1 & T2 --> G2["Group B (analytics) reads independently"]
  end
  subgraph AWS
    SNS["SNS topic: order-events"] --> Q1[["SQS: billing"]] & Q2[["SQS: email"]] & L["Lambda: audit"]
  end
~~~

## Spring Boot implementation
~~~yaml
spring:
  kafka:
    producer:
      acks: all
      properties:
        enable.idempotence: true
        max.in.flight.requests.per.connection: 5
    consumer:
      group-id: billing
      enable-auto-commit: false
      auto-offset-reset: earliest
    listener:
      ack-mode: record
~~~
~~~java
@Bean DefaultErrorHandler errorHandler(KafkaTemplate<Object, Object> t) {
  var recoverer = new DeadLetterPublishingRecoverer(t);                // -> topic.DLT
  return new DefaultErrorHandler(recoverer, new ExponentialBackOff(500, 2.0) {{ setMaxElapsedTime(10_000); }});
}
~~~

## Interview questions
?? How does Kafka guarantee ordering and how can you break it?
Order is guaranteed per partition. You break it by not keying messages consistently, by increasing partition count (keys remap), or by retries with {{max.in.flight > 1}} without idempotence (idempotent producers preserve order with up to 5 in flight).
?? Consumer lag keeps growing. What do you check?
Consumer processing time (slow DB calls), partition count vs consumer count (extra consumers are idle), rebalancing storms ({{max.poll.interval.ms}} exceeded), skewed keys (one hot partition), and downstream throttling.

## Advanced follow-ups
?? What does acks=all with min.insync.replicas=2 guarantee?
A write is acknowledged only when the leader and at least one more in-sync replica have it, so a single broker failure does not lose acknowledged data. If ISR drops below 2, producers get errors (choosing consistency over availability).
` }
]);

LAB.add('hld', 'Distributed Coordination', [
{ id: 'service-discovery', title: 'Service Discovery', level: 'beginner', tags: ['discovery', 'eureka', 'kubernetes'],
  summary: 'How services find each other: client-side (Eureka) vs server-side (Kubernetes Services, load balancers), health and DNS caching.',
  body: md`
## Definition
Service discovery maps a logical service name to the current set of healthy instance addresses in a dynamic environment where instances come and go.

## Approaches
- **Client-side**: instances register with a registry (Eureka, Consul); clients fetch the list and load-balance themselves (Spring Cloud LoadBalancer).
- **Server-side**: clients call a stable name/VIP; the platform routes (Kubernetes Service + kube-proxy/IPVS, AWS Cloud Map + ALB, service mesh).
- **DNS-based**: SRV/A records with short TTLs.

## When to use what
On Kubernetes, use native Services/DNS ({{http://inventory.orders.svc.cluster.local}}); a separate Eureka is redundant. On VMs/ECS without a mesh, Eureka/Consul or Cloud Map.

## Pitfalls
- JVM DNS caching ({{networkaddress.cache.ttl}}) causing calls to dead IPs.
- Registry staleness: an instance dies without deregistering; health checks and client retries to another instance handle it.

## Architecture
~~~mermaid
flowchart LR
  A["Order svc"] -->|"lookup 'inventory'"| R["Registry / K8s DNS"]
  I1["Inventory pod 1"] -->|register / readiness| R
  I2["Inventory pod 2"] -->|register / readiness| R
  A -->|call| I1
~~~

## Spring Boot implementation
~~~yaml
# Eureka client (non-Kubernetes)
eureka:
  client:
    service-url:
      defaultZone: http://eureka:8761/eureka
  instance:
    prefer-ip-address: true
    lease-renewal-interval-in-seconds: 10
~~~

## Interview questions
?? Why might a service keep calling a terminated pod for a few seconds?
Endpoint propagation delay and client-side caches (DNS, load balancer instance lists). Use graceful shutdown with preStop delay so the pod stops receiving traffic before it stops serving, and retries on idempotent calls.
` },

{ id: 'distributed-transactions', title: 'Distributed Transactions', level: 'advanced', tags: ['2pc', 'transactions', 'consistency'], viz: 'saga',
  summary: 'Why 2PC is rarely used between microservices, and the alternatives: sagas, outbox, idempotency and reconciliation.',
  body: md`
## Definition
A distributed transaction updates data across multiple resources (databases, brokers, services) atomically: all commit or none.

## Two-phase commit (2PC)
1. **Prepare**: coordinator asks each participant to prepare (durably lock and promise to commit).
2. **Commit/Abort**: if all voted yes, commit; else abort.
Problems: participants hold locks while waiting; if the coordinator crashes after prepare, participants are **blocked** (in doubt); requires XA support in every resource; poor fit for HTTP services and many NoSQL stores; latency scales with the slowest participant.

## Why microservices avoid it
Services own their data and expose APIs, not XA resources. Blocking protocols across teams' services reduce availability. Instead we accept **eventual consistency** with explicit compensation.

## Alternatives
| Technique | Use |
|---|---|
| Saga (orchestrated/choreographed) | multi-step business workflows with compensations |
| Transactional outbox | atomically change DB state and publish an event |
| Idempotent consumers | survive redelivery |
| Reservation / TCC (Try-Confirm-Cancel) | hold resources then confirm (inventory, seats) |
| Reconciliation jobs | detect and fix drift (payments vs ledger) |

## When 2PC is acceptable
Within one platform that supports it well (e.g. a single database's internal distributed transactions in Spanner/CockroachDB, or Kafka transactions for consume-transform-produce).

## Architecture
~~~mermaid
sequenceDiagram
  participant C as Coordinator
  participant A as DB A
  participant B as DB B
  C->>A: PREPARE
  C->>B: PREPARE
  A-->>C: YES (locks held)
  B-->>C: YES (locks held)
  Note over C: crash here = A and B blocked "in doubt"
  C->>A: COMMIT
  C->>B: COMMIT
~~~

## Spring Boot implementation
~~~java
// Kafka transactions: atomically consume an offset and produce output (exactly-once within Kafka)
@Bean KafkaTransactionManager<String, String> ktm(ProducerFactory<String, String> pf) { return new KafkaTransactionManager<>(pf); }

@KafkaListener(topics = "payments.raw")
@Transactional("ktm")
public void enrich(String msg) { template.send("payments.enriched", enrich(msg)); } // offset commit + send in one Kafka tx
~~~

## Interview questions
?? Why not just use @Transactional across two services?
{{@Transactional}} is local to one resource manager/connection in one JVM. A REST call inside it is not rolled back if the transaction later fails, and holding a DB transaction open during a remote call increases lock time and connection usage.
?? What is TCC?
Try reserves resources (hold seats, freeze funds), Confirm makes it final, Cancel releases. Each step is idempotent and each service exposes these operations. It is a saga variant with explicit reservations.
` },

{ id: 'saga', title: 'Saga Pattern', level: 'advanced', tags: ['saga', 'compensation', 'workflow'], viz: 'saga',
  summary: 'Long-running business transactions as local transactions plus compensations; orchestration vs choreography; failure handling.',
  body: md`
## Definition
A saga is a sequence of local transactions, one per service. Each step publishes an event or replies to an orchestrator; if a step fails, previously completed steps are undone by **compensating transactions**.

## Why it exists
To keep data consistent across services without distributed locks or 2PC, accepting that intermediate states are visible (no isolation).

## Orchestration vs choreography
| | Orchestration | Choreography |
|---|---|---|
| Control | central orchestrator (state machine) | services react to events |
| Visibility | one place shows saga state | implicit, spread across services |
| Coupling | orchestrator knows all steps | services know event types |
| Best for | complex flows, many steps, timeouts | 2-3 simple steps |
| Tools | Temporal, Camunda, AWS Step Functions, custom state machine | Kafka events |

## Designing compensations
- Compensation is a **semantic** undo, not a rollback: refund a charge, release a hold, send a cancellation email.
- Some actions cannot be compensated (email sent, item shipped). Order steps so that irreversible ones come **last** (pivot transaction), and retryable steps after the pivot must eventually succeed.
- All steps and compensations must be **idempotent** and retryable.
- Handle lack of isolation: use semantic locks (order status PENDING) so other operations know the saga is in flight.

## Real-world use case
Order placement: create order (PENDING) -> reserve inventory -> authorise payment -> confirm order -> (later) capture payment and ship. If payment fails: release inventory, mark order CANCELLED.

## Architecture
~~~mermaid
sequenceDiagram
  participant O as Order Orchestrator
  participant I as Inventory
  participant P as Payment
  participant S as Shipping
  O->>I: ReserveStock(order)
  I-->>O: Reserved
  O->>P: Authorize(order, amount)
  P-->>O: Declined
  O->>I: ReleaseStock(order)  [compensation]
  I-->>O: Released
  O->>O: Order = CANCELLED
~~~

## Spring Boot implementation
~~~java
// Minimal persistent orchestrator (state stored per saga; steps triggered by replies over Kafka)
public enum SagaState { STARTED, STOCK_RESERVED, PAYMENT_AUTHORIZED, COMPLETED, COMPENSATING, CANCELLED }

@Service
public class OrderSaga {
  @Transactional
  public void onStockReserved(StockReserved e) {
    SagaInstance s = sagas.lock(e.orderId());
    if (s.state() != SagaState.STARTED) return;                    // idempotent: duplicate reply
    s.moveTo(SagaState.STOCK_RESERVED);
    commands.send("payment.commands", new AuthorizePayment(e.orderId(), s.amount(), s.id() + ":auth")); // via outbox
  }

  @Transactional
  public void onPaymentDeclined(PaymentDeclined e) {
    SagaInstance s = sagas.lock(e.orderId());
    if (s.state() != SagaState.STOCK_RESERVED) return;
    s.moveTo(SagaState.COMPENSATING);
    commands.send("inventory.commands", new ReleaseStock(e.orderId(), s.id() + ":release"));
  }

  @Transactional
  public void onStockReleased(StockReleased e) { sagas.lock(e.orderId()).moveTo(SagaState.CANCELLED); orders.cancel(e.orderId(), "payment declined"); }

  @Scheduled(fixedDelay = 30_000)   // timeouts: a step that never replied
  public void timeouts() { sagas.stuckLongerThan(Duration.ofMinutes(5)).forEach(this::retryOrCompensate); }
}
~~~

## Interview questions
?? What happens if the compensation itself fails?
Retry with backoff (compensations must be idempotent and eventually succeed). If it keeps failing, the saga goes to a FAILED state with an alert for manual intervention; never silently drop it.
?? How do you prevent another request from seeing intermediate state?
Semantic locks (status fields like PENDING_PAYMENT), commutative updates, re-reading values at each step, and by ordering steps so dangerous visibility is minimal. Sagas trade isolation for availability, so say this explicitly.

## Advanced follow-ups
?? Why use Temporal or Step Functions instead of a home-grown orchestrator?
They provide durable state, timers, retries, versioning of workflow code and visibility out of the box. Home-grown is fine for one or two simple sagas but tends to re-implement these poorly.
` }
]);

LAB.add('hld', 'Resilience', [
{ id: 'circuit-breaker', title: 'Circuit Breakers', level: 'intermediate', tags: ['resilience', 'resilience4j'], viz: 'circuit-breaker',
  summary: 'Stop calling a failing dependency, fail fast with fallbacks, probe for recovery; tune thresholds and windows.',
  body: md`
## Definition
A circuit breaker wraps calls to a dependency and tracks failures. **Closed**: calls pass. When the failure (or slow-call) rate exceeds a threshold over a window, it trips **Open**: calls fail immediately. After a wait, **Half-open** lets a few trial calls through; success closes it, failure re-opens it.

## Why it exists
Without it, threads pile up waiting on a dead or slow dependency (timeouts of seconds), exhausting thread pools and connection pools, and the failure cascades upstream. Failing fast preserves resources and gives the dependency room to recover.

## When to use
Synchronous calls to remote dependencies that can fail independently: payment providers, other services, third-party APIs (SMS, KYC).

## When NOT to use
- Around calls where a fast failure has no better alternative and the caller must wait anyway (rare).
- As a replacement for timeouts: you need **both** (a breaker counts timeouts as failures).

## Tuning
- Sliding window (count-based last N calls or time-based last N seconds), minimum number of calls before evaluating.
- Failure-rate threshold (e.g. 50%) and slow-call threshold (e.g. calls > 2s).
- Wait duration in open state, permitted calls in half-open.
- Which exceptions count: 5xx and timeouts yes; 4xx validation errors no.

## Architecture
~~~mermaid
stateDiagram-v2
  [*] --> Closed
  Closed --> Open: failure rate >= threshold
  Open --> HalfOpen: wait duration elapsed
  HalfOpen --> Closed: trial calls succeed
  HalfOpen --> Open: trial call fails
~~~

## Spring Boot implementation
~~~yaml
resilience4j:
  circuitbreaker:
    instances:
      kyc:
        sliding-window-type: COUNT_BASED
        sliding-window-size: 50
        minimum-number-of-calls: 20
        failure-rate-threshold: 50
        slow-call-duration-threshold: 2s
        slow-call-rate-threshold: 60
        wait-duration-in-open-state: 30s
        permitted-number-of-calls-in-half-open-state: 5
        ignore-exceptions: [com.acme.kyc.InvalidDocumentException]
  timelimiter:
    instances:
      kyc: { timeout-duration: 3s }
~~~
~~~java
@CircuitBreaker(name = "kyc", fallbackMethod = "queueForLater")
@Retry(name = "kyc")
public KycResult verify(KycRequest r) { return kycClient.verify(r); }

private KycResult queueForLater(KycRequest r, CallNotPermittedException e) {
  kycQueue.enqueue(r);                                  // degrade: async verification, user sees "pending"
  return KycResult.pending();
}
~~~

## Interview questions
?? In what order should Retry and CircuitBreaker be applied?
Resilience4j's default aspect order is Retry(CircuitBreaker(RateLimiter(TimeLimiter(Bulkhead(call))))): retry wraps the breaker so that when the breaker is open, retries fail fast with {{CallNotPermittedException}} (which you should not retry). Each retry attempt is recorded by the breaker.
?? What is a bulkhead and how does it relate?
A bulkhead caps concurrent calls (semaphore or dedicated thread pool) to one dependency, so a slow dependency cannot consume all threads. Breakers react to failure rates; bulkheads limit blast radius immediately.

## Advanced follow-ups
?? 50 pods each have their own breaker. Is that a problem?
Each pod learns independently, which is usually fine and avoids a shared failure point. It means a dependency may get some traffic until every pod trips; with low per-pod traffic, use time-based windows and a sensible minimum-calls value.
` },

{ id: 'retries', title: 'Retry Mechanisms', level: 'intermediate', tags: ['resilience', 'backoff', 'jitter'],
  summary: 'When to retry, exponential backoff with jitter, retry budgets, and how retries cause outages.',
  body: md`
## Definition
Re-attempting a failed operation that may succeed on a later attempt (transient failures: timeouts, 503, connection resets, throttling).

## Rules that prevent outages
1. Retry only **transient** errors and only **idempotent** operations (or ones made idempotent with keys).
2. **Exponential backoff with jitter** so clients do not retry in lockstep (thundering herd).
3. **Cap attempts and total time**; respect {{Retry-After}}.
4. Retry at **one layer** only. Retries at gateway, service and client multiply: 3 × 3 × 3 = 27 calls per user request.
5. Use **retry budgets** (e.g. retries ≤ 10% of requests) so a struggling dependency is not hammered.
6. Combine with circuit breakers and timeouts.

## Backoff formulas
- Exponential: {{base × 2^attempt}}, capped.
- Full jitter: {{random(0, min(cap, base × 2^attempt))}} (AWS Architecture Blog recommendation).

## When NOT to retry
4xx validation errors, authentication failures, non-idempotent POSTs without keys, or when the user-facing latency budget is already spent.

## Architecture
~~~mermaid
sequenceDiagram
  participant S as Service
  participant D as Dependency
  S->>D: call (attempt 1)
  D-->>S: 503
  Note over S: sleep random(0, 200ms)
  S->>D: call (attempt 2)
  D-->>S: timeout
  Note over S: sleep random(0, 400ms)
  S->>D: call (attempt 3)
  D-->>S: 200
~~~

## Spring Boot implementation
~~~yaml
resilience4j:
  retry:
    instances:
      inventory:
        max-attempts: 3
        wait-duration: 200ms
        enable-exponential-backoff: true
        exponential-backoff-multiplier: 2
        enable-randomized-wait: true
        randomized-wait-factor: 0.5
        retry-exceptions: [java.io.IOException, org.springframework.web.client.HttpServerErrorException]
        ignore-exceptions: [org.springframework.web.client.HttpClientErrorException]
~~~

## Interview questions
?? How can retries make an outage worse?
A dependency slows down, callers time out and retry, multiplying load exactly when capacity is lowest (retry storm), which keeps it down. Budgets, jitter, breakers and backoff prevent this.
?? Should a Kafka consumer retry in-line?
Short in-line retries for transient errors, then publish to a retry topic with delay (non-blocking retries in Spring Kafka {{@RetryableTopic}}) and finally a DLT, so one bad message does not stall the partition.
` },

{ id: 'idempotency', title: 'Idempotency', level: 'intermediate', tags: ['idempotency', 'payments', 'apis'],
  summary: 'Idempotency keys, dedup tables, natural idempotency, and making consumers and APIs safe to retry.',
  body: md`
## Definition
An operation is idempotent if performing it multiple times has the same effect as performing it once. GET, PUT and DELETE are defined as idempotent in HTTP; POST is not unless you make it so.

## Why it exists
Networks fail ambiguously: a client times out without knowing if the server processed the request. Brokers deliver at-least-once. Without idempotency, retries cause double charges, duplicate orders and duplicate notifications.

## Techniques
1. **Idempotency-Key header** (Stripe-style): store key + request hash + response; replay the stored response for repeats; reject the same key with a different body.
2. **Natural keys + unique constraints**: {{UNIQUE(order_id, type)}} on a payment row; insert conflicts mean "already done".
3. **Conditional updates**: {{UPDATE ... WHERE status = 'PENDING'}}.
4. **Dedup table for consumers**: {{processed_message(id)}} inserted in the same transaction as the side effect.
5. **Set semantics instead of increments**: "set status=PAID" is idempotent; "balance += 10" is not.

## Edge cases interviewers probe
- Concurrent duplicates (two requests with the same key at once): the first inserts an IN_PROGRESS record; the second gets 409 or waits.
- Key scope (per user + endpoint) and expiry (24h-7d).
- Storing the response so the retry gets the same result, including errors you decide are final.

## Architecture
~~~mermaid
sequenceDiagram
  participant C as Client
  participant API
  participant DB
  C->>API: POST /payments Idempotency-Key: k1
  API->>DB: INSERT idem(k1, IN_PROGRESS)
  API->>API: charge
  API->>DB: UPDATE idem(k1, COMPLETED, response)
  API--xC: response lost (timeout)
  C->>API: POST /payments Idempotency-Key: k1 (retry)
  API->>DB: SELECT idem(k1) -> COMPLETED
  API-->>C: stored response (no second charge)
~~~

## Spring Boot implementation
~~~java
@PostMapping("/payments")
public ResponseEntity<PaymentResponse> create(@RequestHeader("Idempotency-Key") @NotBlank String key,
                                              @Valid @RequestBody CreatePayment body, @AuthenticationPrincipal Jwt jwt) {
  String scopedKey = jwt.getSubject() + ":" + key;
  return idempotency.execute(scopedKey, DigestUtils.sha256Hex(json.write(body)),
      () -> ResponseEntity.status(201).body(payments.create(body)));
}

public <T> T execute(String key, String hash, Supplier<T> action) {
  int inserted = jdbc.update("INSERT INTO idem(key, hash, status) VALUES (?,?, 'IN_PROGRESS') ON CONFLICT DO NOTHING", key, hash);
  if (inserted == 0) {
    IdemRow row = load(key);
    if (!row.hash().equals(hash)) throw new IdempotencyKeyReusedException();          // 422
    if (row.status() == Status.IN_PROGRESS) throw new RequestInProgressException();     // 409, client retries later
    return row.response();
  }
  T result = action.get();
  jdbc.update("UPDATE idem SET status='COMPLETED', response=?::jsonb WHERE key=?", json.write(result), key);
  return result;
}
~~~

## Interview questions
?? Is DELETE idempotent if the second call returns 404?
Yes: idempotency is about server state, not identical responses. The resource is gone either way. Many APIs still return 204 for consistency.
?? What if the server crashes after charging but before storing COMPLETED?
The key stays IN_PROGRESS. A retry gets 409; a recovery job checks the provider (using the same key passed to the provider as its idempotency key) and completes the record. This is why the key must propagate downstream.
` },

{ id: 'rate-limiting', title: 'Rate Limiting', level: 'intermediate', tags: ['rate-limiting', 'redis', 'gateway'], viz: 'rate-limiter',
  summary: 'Why and where to limit, algorithm comparison, distributed counters, headers and fairness.',
  body: md`
## Definition
Rate limiting restricts how many requests a client (user, API key, IP, tenant) can make in a time period, rejecting excess with HTTP 429.

## Why it exists
Protect services from overload and abuse (credential stuffing, OTP/SMS pumping, scraping), enforce commercial quotas, and ensure fairness among tenants.

## Algorithms
| Algorithm | Behaviour | Memory | Notes |
|---|---|---|---|
| Fixed window | count per minute | O(1) | 2× burst at window edges |
| Sliding window log | exact | O(limit) | expensive at high limits |
| Sliding window counter | weighted previous window | O(1) | good approximation |
| Token bucket | refill rate + burst capacity | O(1) | industry default (AWS API GW, Envoy) |
| Leaky bucket | constant outflow, queue | O(queue) | smooths traffic |

## Where to enforce
Edge (CDN/WAF for IP floods), gateway (per API key/user quotas), service (per-operation limits like OTP send: 3/10 min per phone), and outbound (respect third-party limits).

## Distributed implementation
Central store (Redis) with atomic Lua scripts; or local token buckets with periodic sync (approximate, cheaper). Decide **fail-open vs fail-closed** when Redis is unavailable: usually fail-open for general APIs, fail-closed for security-sensitive endpoints like OTP.

## Architecture
~~~mermaid
flowchart LR
  C["Client"] --> GW["Gateway"]
  GW -->|"EVALSHA token_bucket key=user:42"| R[("Redis")]
  R -->|"allowed / remaining / retry-after"| GW
  GW -->|allowed| S["Service"]
  GW -->|"429 + Retry-After"| C
~~~

## Spring Boot implementation
~~~java
// Bucket4j with Redis (Lettuce) for distributed token buckets
@Bean ProxyManager<String> buckets(RedisClient client) {
  return LettuceBasedProxyManager.builderFor(client).withExpirationStrategy(
      ExpirationAfterWriteStrategy.basedOnTimeForRefillingBucketUpToMax(Duration.ofMinutes(10))).build();
}

public boolean tryConsumeOtp(String phone) {
  BucketConfiguration cfg = BucketConfiguration.builder()
      .addLimit(Bandwidth.builder().capacity(3).refillIntervally(3, Duration.ofMinutes(10)).build()).build();
  return buckets.builder().build("otp:" + phone, () -> cfg).tryConsume(1);
}
// Respond with 429 and headers: Retry-After, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset
~~~

## Interview questions
?? How do you rate limit unauthenticated login attempts?
Several keys at once: per IP (with care for NAT/carrier-grade NAT in mobile networks), per username/phone (protects the account), and globally per endpoint; progressive delays and CAPTCHA after thresholds; alert on distributed attacks.
?? Why token bucket for public APIs?
It allows short bursts (good UX for real clients) while enforcing an average rate, needs O(1) state, and maps cleanly to documented quotas.
` },

{ id: 'fault-tolerance', title: 'Fault Tolerance & Disaster Recovery', level: 'advanced', tags: ['availability', 'dr', 'rpo', 'rto'], viz: 'node-failure',
  summary: 'Redundancy, failure domains, graceful degradation, RPO/RTO, backup/restore, pilot light, warm standby and active-active.',
  body: md`
## Definition
**Fault tolerance**: the system keeps working (perhaps degraded) when components fail. **Disaster recovery**: restoring service after a large-scale failure (region loss, data corruption, ransomware).

## Building blocks
- Redundancy across **failure domains**: instances, AZs, regions.
- Timeouts, retries, breakers, bulkheads, load shedding.
- Graceful degradation: serve cached/stale data, disable non-critical features (recommendations) to keep core flows (checkout) alive.
- Health checks and automatic replacement (auto-scaling groups, Kubernetes).
- Data protection: replication **plus** backups (replication copies corruption and deletes too), point-in-time recovery, immutable backups.

## RPO and RTO
- **RPO** (Recovery Point Objective): how much data you can lose (time).
- **RTO** (Recovery Time Objective): how long until service is restored.

| Strategy | RPO | RTO | Cost |
|---|---|---|---|
| Backup & restore | hours | hours | lowest |
| Pilot light (data replicated, minimal infra) | minutes | tens of minutes | low |
| Warm standby (scaled-down full stack) | seconds-minutes | minutes | medium |
| Active-active multi-region | near zero | near zero | highest, complex consistency |

## When NOT to go multi-region active-active
When requirements do not demand it: it doubles infra, complicates data consistency (conflicts, global uniqueness) and testing. Many businesses are well served by multi-AZ + warm standby. Data residency (UAE, India) may also restrict which regions can be used.

## Architecture
~~~mermaid
flowchart LR
  R53["DNS failover / Global Accelerator"] --> RA & RB
  subgraph RA["Primary region (3 AZs)"]
    A1["App ×N"] --> DBA[("Aurora writer + readers")]
  end
  subgraph RB["DR region (warm standby)"]
    B1["App ×2 (scaled down)"] --> DBB[("Aurora Global DB secondary")]
  end
  DBA -- "async replication (~1s lag)" --> DBB
  DBA --> S3B[("Backups, cross-region, immutable")]
~~~

## Spring Boot implementation
~~~java
// Graceful degradation: recommendations are optional on the product page
public ProductPage page(long id) {
  Product p = products.get(id);                                   // critical
  List<Product> recs = recommendations.forProduct(id)              // optional, with breaker + 300ms timeout
      .onErrorResume(e -> Mono.just(List.of()))
      .block(Duration.ofMillis(300));
  return new ProductPage(p, recs);
}
~~~

## Interview questions
?? Replication exists, why do we still need backups?
Replication faithfully copies mistakes: a bad migration, an accidental {{DELETE}}, or ransomware encrypting data. Backups (with point-in-time recovery and immutability) let you go back in time.
?? How do you know your DR works?
Game days: regularly fail over for real, measure RTO/RPO, restore backups into an isolated environment and verify data. An untested DR plan is a hypothesis.
` }
]);

LAB.add('hld', 'Operations & Security', [
{ id: 'observability', title: 'Observability: Logs, Metrics, Traces', level: 'intermediate', tags: ['observability', 'opentelemetry', 'micrometer'],
  summary: 'Three signals, RED/USE methods, SLOs and error budgets, distributed tracing with OpenTelemetry, and alerting that works.',
  body: md`
## Definition
Observability is the ability to understand a system's internal state from its outputs: **metrics** (aggregated numbers over time), **logs** (discrete events), **traces** (request paths across services).

## Why it exists
In distributed systems, failures are emergent and partial. You need to ask new questions during incidents without shipping new code.

## What to measure
- **RED** for services: Rate, Errors, Duration (latency percentiles p50/p95/p99, not averages).
- **USE** for resources: Utilisation, Saturation, Errors (CPU, connection pools, thread pools, queues, consumer lag).
- **SLIs/SLOs**: e.g. 99.9% of checkout requests succeed within 800ms over 30 days; the **error budget** (0.1%) governs release risk.
- Business metrics: orders/min, OTP success rate, payment authorisation rate by provider.

## Logs
Structured JSON with {{traceId}}, {{spanId}}, user/tenant id (no PII/secrets), consistent levels. Centralise (Loki, OpenSearch, CloudWatch). Sample debug logs.

## Traces
OpenTelemetry instrumentation propagates W3C {{traceparent}} across HTTP and Kafka headers; backends: Jaeger, Tempo, X-Ray. Use tail-based sampling to keep slow/error traces.

## Alerting
Alert on symptoms (SLO burn rate, error rate) rather than causes (CPU 80%). Multi-window burn-rate alerts reduce noise. Every alert needs a runbook.

## Architecture
~~~mermaid
flowchart LR
  S1["Service (Micrometer + OTel)"] -->|OTLP| Col["OTel Collector"]
  S2["Service"] -->|OTLP| Col
  Col --> Prom["Prometheus / Mimir (metrics)"]
  Col --> Tempo["Tempo / Jaeger (traces)"]
  S1 & S2 -->|stdout JSON| Loki["Loki / OpenSearch (logs)"]
  Prom & Tempo & Loki --> Graf["Grafana: dashboards, SLO alerts"]
~~~

## Spring Boot implementation
~~~yaml
management:
  endpoints: { web: { exposure: { include: health,info,prometheus } } }
  tracing: { sampling: { probability: 0.1 } }
  metrics:
    distribution:
      percentiles-histogram: { http.server.requests: true }
      slo: { http.server.requests: 200ms,500ms,1s }
logging:
  pattern:
    level: "%5p [\${spring.application.name},%X{traceId:-},%X{spanId:-}]"
~~~
~~~java
@Observed(name = "otp.verify", contextualName = "verify-otp")      // timer + span in one annotation
public VerifyResult verify(String txnId, String code) { ... }

Counter.builder("payments.authorization").tag("provider", p).tag("outcome", ok ? "approved" : "declined").register(registry).increment();
~~~

## Interview questions
?? p99 latency doubled but averages are flat. How do you investigate?
Look at the latency histogram by route/instance, correlate with GC pauses, connection-pool wait time, downstream span durations in traces (exemplars link metrics to traces), and recent deploys. Averages hide tail latency that users actually feel.
?? Why should you not use high-cardinality labels like userId in metrics?
Each label combination is a separate time series; millions of users explode memory and cost of the metrics backend. Put such identifiers in logs/traces instead.
` },

{ id: 'security-auth', title: 'Security & Authentication', level: 'intermediate', tags: ['security', 'oauth', 'zero-trust'], viz: 'oauth',
  summary: 'Defence in depth for distributed systems: edge auth, token validation, service-to-service identity, secrets, encryption and OWASP API risks.',
  body: md`
## Definition
Protecting confidentiality, integrity and availability of the system and its data: who are you (authentication), what may you do (authorization), and protection of data in transit and at rest.

## Layers
1. **Edge**: WAF, DDoS protection, TLS 1.2+, rate limiting, bot protection.
2. **User authentication**: OAuth 2.0 / OIDC with an IdP (Keycloak, Cognito); short-lived access tokens; MFA/OTP for risky actions.
3. **API authorization**: scopes/roles at the gateway, **object-level checks** in services (does this user own order 42?).
4. **Service-to-service**: mTLS (service mesh) and/or client-credentials tokens with audience restriction; never rely only on "it is inside the VPC".
5. **Secrets**: Vault / AWS Secrets Manager, rotation, no secrets in Git or images.
6. **Data**: encryption at rest (KMS), field-level encryption/tokenization for PII and card data, masking in logs.
7. **Supply chain**: dependency scanning, signed images, least-privilege IAM roles.

## OWASP API Top 10 highlights
Broken object level authorization (IDOR), broken authentication, broken object property level authorization (mass assignment), unrestricted resource consumption, broken function level authorization, SSRF.

## Architecture
~~~mermaid
flowchart LR
  U["User"] -->|"OIDC login + PKCE"| IdP["Keycloak / Cognito"]
  U -->|"Bearer access token"| WAF["WAF + CDN"] --> GW["Gateway: validate JWT, scopes, rate limit"]
  GW --> S1["Order svc: ownership checks"]
  S1 -->|"mTLS + client-credentials token (aud=payment)"| S2["Payment svc"]
  S1 & S2 --> SM["Secrets Manager / KMS"]
~~~

## Spring Boot implementation
~~~java
@Configuration @EnableMethodSecurity
class SecurityConfig {
  @Bean SecurityFilterChain api(HttpSecurity http) throws Exception {
    return http.csrf(c -> c.disable())                               // stateless API with bearer tokens
        .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .authorizeHttpRequests(a -> a.requestMatchers("/actuator/health/**").permitAll()
                                     .requestMatchers(HttpMethod.POST, "/orders/**").hasAuthority("SCOPE_orders:write")
                                     .anyRequest().authenticated())
        .oauth2ResourceServer(o -> o.jwt(Customizer.withDefaults()))
        .build();
  }
}

@GetMapping("/orders/{id}")
@PostAuthorize("returnObject.customerId() == authentication.name or hasRole('SUPPORT')")  // object-level check
public OrderDto get(@PathVariable UUID id) { return orders.get(id); }
~~~

## Interview questions
?? What is IDOR and how do you prevent it systematically?
Insecure Direct Object Reference: changing {{/orders/41}} to {{/orders/42}} returns someone else's order. Prevent with ownership checks in the service/repository layer ({{findByIdAndCustomerId}}), tenant filters, and tests that call endpoints as a different user.
?? Should internal services trust each other?
No (zero trust). Authenticate every call (mTLS identities, signed tokens with audience), authorize by caller identity, and propagate end-user context when needed (token exchange) rather than using one all-powerful service account.
` },

{ id: 'multi-tenancy', title: 'Multi-Tenancy', level: 'advanced', tags: ['saas', 'tenancy', 'isolation'],
  summary: 'Silo vs pool vs bridge models, tenant context propagation, data isolation, noisy neighbours and per-tenant IAM.',
  body: md`
## Definition
One deployment serves multiple customers (tenants) while keeping their data, configuration and performance isolated.

## Isolation models
| Model | Data | Pros | Cons |
|---|---|---|---|
| Silo (DB/stack per tenant) | separate databases or accounts | strongest isolation, per-tenant residency/backup | costly, many deployments to operate |
| Bridge (schema per tenant) | shared DB, schema each | moderate isolation | migrations × N schemas, connection limits |
| Pool (shared tables + tenant_id) | shared everything | cheapest, simplest ops | isolation enforced in code/RLS; noisy neighbours |

Hybrid is common: pooled for SMB tenants, silo for regulated enterprise tenants (banks, government).

## Essential mechanics
- **Tenant resolution**: from token claim ({{tenant_id}}), subdomain or header (validated against the token).
- **Context propagation**: across async boundaries (Kafka headers, thread pools).
- **Enforcement**: Hibernate filters / {{@TenantId}} (Hibernate 6), PostgreSQL Row-Level Security as a second line of defence.
- **Noisy neighbours**: per-tenant rate limits, quotas, separate queues/partitions for big tenants.
- **Per-tenant configuration**: features, branding, IdP (Keycloak realm or organization per tenant).
- Observability tagged by tenant (logs/traces; careful with metric cardinality).

## Architecture
~~~mermaid
flowchart LR
  T1["tenant-a.app.com"] & T2["tenant-b.app.com"] --> GW["Gateway: resolve tenant, validate token's tenant claim"]
  GW --> SVC["Shared service: TenantContext"]
  SVC --> PG[("Postgres: tenant_id + RLS")]
  SVC --> BIG[("Dedicated DB for enterprise tenant")]
  GW -.-> KC["Keycloak: realm per tenant / organizations"]
~~~

## Spring Boot implementation
~~~java
@Entity class Invoice { @Id UUID id; @TenantId String tenantId; ... }   // Hibernate 6 adds tenant predicate automatically

@Component class JwtTenantResolver implements CurrentTenantIdentifierResolver<String> {
  public String resolveCurrentTenantIdentifier() {
    return Optional.ofNullable(SecurityContextHolder.getContext().getAuthentication())
        .map(a -> ((Jwt) a.getPrincipal()).getClaimAsString("tenant_id")).orElse("system");
  }
  public boolean validateExistingCurrentSessions() { return true; }
}
~~~
~~~sql
ALTER TABLE invoice ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice USING (tenant_id = current_setting('app.tenant_id'));
-- set per transaction: SET LOCAL app.tenant_id = 'tenant-a';
~~~

## Interview questions
?? How do you make sure a bug cannot leak tenant A's data to tenant B?
Defence in depth: tenant from the verified token only, automatic ORM filters, RLS in the database, tenant-aware cache keys ({{tenant:a:product:1}}), and automated cross-tenant access tests in CI.
?? One tenant runs a huge export and slows everyone. Fix?
Per-tenant quotas and concurrency limits, move heavy jobs to async queues with per-tenant fairness (weighted queues), read replicas for exports, or promote the tenant to a dedicated tier.
` }
]);
})();
