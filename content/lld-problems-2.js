(function () {
const md = LAB.md;
const S = 'LLD Interview Problems';

LAB.add('lld', S, [
{ id: 'payment-processing', title: 'Payment Processing System', level: 'advanced', tags: ['lld', 'idempotency', 'state', 'strategy'],
  summary: 'Payment intents, provider routing, idempotency keys, state machine, retries, webhooks and refunds.',
  mock: { entities: [['Payment / PaymentIntent with status', 'payment|intent'], ['Idempotency key store', 'idempot'], ['Provider / gateway abstraction', 'provider|gateway|psp|processor'], ['Refund entity', 'refund'], ['Ledger / transaction record', 'ledger|journal|transaction']], patterns: [['Strategy/Adapter per provider', 'adapter|strategy'], ['State machine for payment status', 'state'], ['Chain for validation / fraud checks', 'chain|validat|fraud'], ['Retry with idempotency', 'retr']] },
  body: md`
## Problem statement
Design the payment module of an e-commerce or fintech backend: create a payment for an order, charge via one of several providers (cards via Checkout.com/Stripe, Apple Pay, UPI in India), handle asynchronous confirmations (3-D Secure, webhooks), refunds, and guarantee that a customer is never charged twice.

## Requirements
**Functional**
- Create payment for an order and amount; choose provider by method, currency, country, and availability.
- Authorise, capture (immediately or later), void, refund (full/partial).
- Process provider webhooks; reconcile states.

**Non-functional**
- **Exactly-once effect** for charges: client retries and duplicate webhooks must not double charge or double refund.
- Auditability: every state change recorded (append-only).
- Provider failure must not lose payment state; timeouts lead to "unknown" status resolved by status queries.
- PCI DSS: never store PAN/CVV; use provider tokens.

## Core entities
- **Payment** (id, orderId, amount, currency, method, provider, providerRef, status, version).
- **PaymentStatus**: CREATED, AUTHORIZED, CAPTURED, FAILED, VOIDED, REFUNDED, PARTIALLY_REFUNDED, PENDING (unknown/3DS).
- **IdempotencyRecord** (key, requestHash, response, status).
- **PaymentProvider** (interface) with adapters.
- **ProviderRouter** (strategy).
- **Refund**, **LedgerEntry**.

## UML class diagram
~~~mermaid
classDiagram
  class PaymentService { +create(CreatePaymentCmd, String idemKey) Payment +capture(id) +refund(id, Money, String idemKey) +onWebhook(ProviderEvent) }
  class Payment { +String id +Money amount +PaymentStatus status +String providerRef +long version +transition(PaymentStatus) }
  class PaymentProvider { <<interface>> +authorize(AuthRequest) ProviderResult +capture(String ref, Money) +refund(String ref, Money, String key) +status(String ref) }
  class CheckoutAdapter
  class UpiAdapter
  class ProviderRouter { +route(Payment) PaymentProvider }
  class IdempotencyStore { +begin(key, hash) Optional~Response~ +complete(key, response) }
  PaymentService ..> ProviderRouter
  PaymentService ..> IdempotencyStore
  ProviderRouter o-- PaymentProvider
  PaymentProvider <|.. CheckoutAdapter
  PaymentProvider <|.. UpiAdapter
  Payment *-- LedgerEntry
~~~

## Relationships
The router aggregates provider adapters; Payment composes its ledger entries (append-only history).

## Design patterns used
- **Adapter** per provider: each provider's API/model is translated to our {{PaymentProvider}} port.
- **Strategy** for routing (cost, success rate, method support, failover).
- **State** for payment status with legal transitions.
- **Template Method / Chain** for pre-checks (validation, fraud, limits).
- **Idempotency key** pattern at the API boundary.

## Java implementation
~~~java
public enum PaymentStatus {
    CREATED, PENDING, AUTHORIZED, CAPTURED, FAILED, VOIDED, PARTIALLY_REFUNDED, REFUNDED;
    private static final Map<PaymentStatus, Set<PaymentStatus>> NEXT = Map.of(
        CREATED, EnumSet.of(PENDING, AUTHORIZED, CAPTURED, FAILED),
        PENDING, EnumSet.of(AUTHORIZED, CAPTURED, FAILED),
        AUTHORIZED, EnumSet.of(CAPTURED, VOIDED, FAILED),
        CAPTURED, EnumSet.of(PARTIALLY_REFUNDED, REFUNDED),
        PARTIALLY_REFUNDED, EnumSet.of(PARTIALLY_REFUNDED, REFUNDED),
        FAILED, EnumSet.noneOf(PaymentStatus.class), VOIDED, EnumSet.noneOf(PaymentStatus.class), REFUNDED, EnumSet.noneOf(PaymentStatus.class));
    boolean canMoveTo(PaymentStatus n) { return NEXT.get(this).contains(n); }
    boolean terminal() { return NEXT.get(this).isEmpty(); }
}

public interface PaymentProvider {
    String name(); boolean supports(PaymentMethod m, Currency c);
    ProviderResult authorize(AuthRequest r);            // r carries our payment id as the provider idempotency key
    ProviderResult capture(String providerRef, Money amount, String idemKey);
    ProviderResult refund(String providerRef, Money amount, String idemKey);
    ProviderResult status(String providerRef);
}

@Service
public class PaymentService {
    private final PaymentRepository payments; private final IdempotencyStore idem; private final ProviderRouter router;
    private final LedgerRepository ledger; private final Clock clock;
    // constructor omitted

    public PaymentResponse create(CreatePaymentCmd cmd, String idemKey) {
        // 1) Idempotency: same key + same body -> same response; same key + different body -> 422
        Optional<PaymentResponse> prior = idem.begin(idemKey, cmd.hash());
        if (prior.isPresent()) return prior.get();

        Payment p = payments.save(Payment.create(cmd, clock.instant()));          // committed before calling the provider
        PaymentProvider provider = router.route(p);
        ProviderResult r;
        try {
            r = provider.authorize(AuthRequest.from(p, provider.name()));
        } catch (ProviderTimeoutException e) {
            transition(p, PaymentStatus.PENDING, "provider timeout; will reconcile");   // never assume failure on timeout
            return idem.complete(idemKey, PaymentResponse.pending(p));
        }
        transition(p, r.success() ? (cmd.autoCapture() ? PaymentStatus.CAPTURED : PaymentStatus.AUTHORIZED)
                                  : r.requiresAction() ? PaymentStatus.PENDING : PaymentStatus.FAILED, r.reason());
        p.setProviderRef(provider.name(), r.reference());
        return idem.complete(idemKey, PaymentResponse.of(p, r.nextAction()));
    }

    @Transactional
    void transition(Payment p, PaymentStatus to, String reason) {
        if (p.status() == to) return;                                            // duplicate webhook: no-op
        if (!p.status().canMoveTo(to)) throw new IllegalTransitionException(p.status(), to);
        int rows = payments.updateStatus(p.id(), p.status(), to, p.version());   // optimistic: WHERE status=? AND version=?
        if (rows == 0) throw new ConcurrentModificationException(p.id());
        ledger.append(LedgerEntry.of(p, to, reason, clock.instant()));
        p.apply(to);
    }

    /** Webhooks are at-least-once and may arrive out of order: dedupe by event id, ignore stale transitions. */
    public void onWebhook(ProviderEvent e) {
        if (!webhookEvents.markProcessed(e.provider(), e.eventId())) return;
        Payment p = payments.byProviderRef(e.provider(), e.reference()).orElseThrow();
        PaymentStatus target = e.mappedStatus();
        if (p.status().terminal() || !p.status().canMoveTo(target)) { log.info("ignoring stale event {} for {}", e.eventId(), p.id()); return; }
        transition(p, target, "webhook " + e.eventId());
    }
}
~~~

~~~sql
CREATE TABLE idempotency_record (
  idem_key      VARCHAR(80) PRIMARY KEY,
  request_hash  CHAR(64) NOT NULL,
  status        VARCHAR(16) NOT NULL,      -- IN_PROGRESS | COMPLETED
  response_json JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- begin(): INSERT ... ON CONFLICT (idem_key) DO NOTHING; if not inserted, read the row:
--   COMPLETED + same hash -> return stored response; IN_PROGRESS -> 409 "retry later"; different hash -> 422
~~~

## Important methods explained
- {{create}}: persists the payment **before** calling the provider and passes our payment id as the provider's idempotency key, so a retry after a crash cannot create a second charge at the provider.
- Timeouts become **PENDING**, not FAILED. A reconciliation job queries {{provider.status()}} for PENDING payments older than N minutes.
- {{transition}}: legal-transition check + optimistic version check + append-only ledger in one transaction.
- {{onWebhook}}: dedupe by provider event id; ignore out-of-order events that would move backwards.

## Extensibility
New provider = new adapter + router rule. Smart routing (by BIN country, cost, live success rates) = new router strategy. Split payments / marketplace payouts add a {{Payout}} aggregate.

## Common mistakes
- Treating a timeout as failure and letting the client retry with a new payment (double charge).
- Idempotency key checked but not stored atomically (two concurrent retries both pass).
- Using float money; not storing currency with amount.
- Trusting webhook payloads without signature verification.

## Follow-up questions
?? How do you guarantee that the order service learns about the payment result?
Write a {{PaymentCaptured}} event to an outbox table in the same transaction as the status change; a relay publishes to Kafka; the order service consumes idempotently.
?? How do you handle a partial refund racing with a full refund?
Refunds lock the payment row (or use version checks) and validate {{refunded + amount <= captured}}; each refund has its own idempotency key forwarded to the provider.
?? How do you reconcile with the provider's settlement file?
Daily job parses the settlement report, matches by provider reference, flags mismatches (amount, status, missing) into an exceptions queue for ops.
` },

{ id: 'notification-service', title: 'Notification Service', level: 'intermediate', tags: ['lld', 'strategy', 'template', 'observer'],
  summary: 'Multi-channel notifications with templates, user preferences, priority, retries and provider failover.',
  mock: { entities: [['Notification request with channel, template, params', 'notification|request'], ['Channel senders (SMS, email, push, WhatsApp)', 'sms|email|push|whatsapp|channel'], ['Templates with localisation', 'template|locali|language|arabic'], ['User preferences / opt-out / quiet hours', 'prefer|opt.?out|quiet|consent'], ['Retry / delivery status tracking', 'retr|status|deliver']], patterns: [['Strategy per channel', 'strategy'], ['Template method or template engine', 'template'], ['Decorator for retry / failover / rate limit', 'decorator|failover|fallback'], ['Observer / pub-sub for triggering', 'observer|event|queue|kafka']] },
  body: md`
## Problem statement
Build a reusable notification module used by many services (OTP, order updates, marketing). It must route to SMS, e-mail, push or WhatsApp, render localised templates (English/Arabic/Hindi), respect user preferences, and survive provider outages.

## Requirements
**Functional**
- Send by user id or raw address; channel explicit or chosen by preference.
- Templates with parameters and locale; RTL for Arabic.
- Priorities: OTP (critical, immediate) vs marketing (bulk, can be delayed/throttled).
- Track status: QUEUED, SENT, DELIVERED, FAILED.
- Respect opt-outs and quiet hours (not for transactional/OTP).

**Non-functional**
- Provider failover (primary SMS aggregator down -> secondary).
- Retries with backoff for transient failures; no retries for permanent failures (invalid number).
- At-least-once delivery to providers with de-duplication by notification id.

## Core entities
- **NotificationRequest** (id, recipient, channel, templateId, params, priority, locale).
- **Template** (id, channel, locale, body) and **TemplateRenderer**.
- **ChannelSender** (interface): SmsSender, EmailSender, PushSender, WhatsAppSender.
- **PreferenceService** (opt-outs, preferred channel, quiet hours).
- **DeliveryRecord** (status, attempts, provider, providerMessageId).

## UML class diagram
~~~mermaid
classDiagram
  class NotificationService { +send(NotificationRequest) String }
  class ChannelSender { <<interface>> +channel() Channel +send(RenderedMessage) SendResult }
  class FailoverSender { -List~ChannelSender~ providers }
  class RetryingSender { -ChannelSender delegate -RetryPolicy policy }
  class TemplateRenderer { +render(templateId, locale, params) RenderedMessage }
  class PreferenceService { +allowed(userId, Channel, Priority) boolean }
  NotificationService ..> TemplateRenderer
  NotificationService ..> PreferenceService
  NotificationService o-- ChannelSender
  ChannelSender <|.. FailoverSender
  ChannelSender <|.. RetryingSender
~~~

## Relationships
The service aggregates channel senders (registry by channel); decorators wrap senders.

## Design patterns used
- **Strategy** per channel (registry keyed by {{Channel}}).
- **Decorator** for retry, failover, rate limiting, masking logs.
- **Builder** for requests.
- **Observer/queue**: producers publish events; the notification service consumes.

## Java implementation
~~~java
public interface ChannelSender { Channel channel(); SendResult send(RenderedMessage m); }

public final class FailoverSender implements ChannelSender {
    private final Channel channel; private final List<ChannelSender> providers;  // ordered by preference
    public FailoverSender(Channel c, List<ChannelSender> p) { this.channel = c; this.providers = List.copyOf(p); }
    public Channel channel() { return channel; }
    public SendResult send(RenderedMessage m) {
        SendResult last = SendResult.failed("no providers");
        for (ChannelSender p : providers) {
            last = p.send(m);
            if (last.ok() || last.permanent()) return last;      // do not fail over on "invalid number"
        }
        return last;
    }
}

public final class RetryingSender implements ChannelSender {
    private final ChannelSender delegate; private final int maxAttempts; private final Duration base;
    // constructor omitted
    public Channel channel() { return delegate.channel(); }
    public SendResult send(RenderedMessage m) {
        SendResult r = null;
        for (int attempt = 1; attempt <= maxAttempts; attempt++) {
            r = delegate.send(m);
            if (r.ok() || r.permanent()) return r;
            long sleep = (long) (base.toMillis() * Math.pow(2, attempt - 1) * ThreadLocalRandom.current().nextDouble(0.5, 1.0)); // full jitter
            LockSupport.parkNanos(Duration.ofMillis(sleep).toNanos());
        }
        return r;
    }
}

@Service
public class NotificationService {
    private final Map<Channel, ChannelSender> senders; private final TemplateRenderer renderer;
    private final PreferenceService prefs; private final DeliveryRepository deliveries;

    public NotificationService(List<ChannelSender> all, TemplateRenderer r, PreferenceService p, DeliveryRepository d) {
        this.senders = all.stream().collect(Collectors.toMap(ChannelSender::channel, s -> s)); this.renderer = r; this.prefs = p; this.deliveries = d;
    }

    public DeliveryRecord send(NotificationRequest req) {
        if (!deliveries.claim(req.id())) return deliveries.get(req.id());           // dedupe on redelivery
        Channel ch = req.channel().orElseGet(() -> prefs.preferredChannel(req.userId()));
        if (req.priority() != Priority.CRITICAL && !prefs.allowed(req.userId(), ch, req.priority(), Instant.now()))
            return deliveries.mark(req.id(), DeliveryStatus.SUPPRESSED, "user preference");
        RenderedMessage msg = renderer.render(req.templateId(), req.locale(), req.params(), ch);
        SendResult r = Optional.ofNullable(senders.get(ch)).orElseThrow(() -> new UnsupportedChannelException(ch)).send(msg);
        return deliveries.mark(req.id(), r.ok() ? DeliveryStatus.SENT : DeliveryStatus.FAILED, r.detail());
    }
}
~~~

## Important methods explained
- {{FailoverSender}}: fails over on transient/provider errors only; permanent errors (invalid recipient) stop immediately so you do not pay two providers to fail.
- {{RetryingSender}}: exponential backoff with full jitter to avoid synchronised retry storms. In production prefer a delayed retry queue over sleeping in a worker thread.
- {{deliveries.claim}}: insert-if-absent on notification id makes the consumer idempotent under at-least-once delivery.

## Extensibility
New channel (WhatsApp Business API): one sender bean. New provider: add to the failover list via config. Digest/batching: a scheduler that aggregates low-priority notifications per user.

## Common mistakes
- One queue for OTP and marketing: a campaign of 2M SMS delays OTPs by minutes. Use separate queues/priorities.
- Retrying permanent failures; no jitter.
- Rendering templates in the producer services (duplicated logic, inconsistent localisation).

## Follow-up questions
?? How do you track delivered vs sent?
Providers send delivery receipts (DLR) via webhook; map providerMessageId -> notification id and update status. Treat DLRs as best-effort; some operators never send them.
?? How do you prevent SMS cost abuse on OTP endpoints?
Rate limit per phone/IP/device, CAPTCHA after N attempts, block premium-rate number ranges, and alert on spend anomalies (SMS pumping fraud).
` },

{ id: 'rate-limiter-lld', title: 'Rate Limiter (LLD)', level: 'intermediate', tags: ['lld', 'algorithms', 'concurrency'], viz: 'rate-limiter',
  summary: 'Token bucket, sliding window log and sliding window counter as pluggable, thread-safe Java classes.',
  mock: { entities: [['RateLimiter interface (tryAcquire)', 'tryacquire|allow|ratelimiter'], ['Algorithm implementations', 'token|bucket|window|leaky'], ['Key / client identity', 'key|client|user|ip'], ['Rule configuration (limit, period)', 'rule|config|limit|period|capacity'], ['Clock abstraction', 'clock|time']], patterns: [['Strategy for algorithms', 'strategy'], ['Factory to build limiters from rules', 'factory'], ['Thread-safe per-key state', 'concurrenthashmap|synchron|atomic|lock']] },
  body: md`
## Problem statement
Implement an in-process rate limiter library: given a key (user, API key, IP) decide whether a request is allowed, supporting several algorithms and per-route rules. (For the distributed version see the HLD topic and the Distributed Rate Limiter system design.)

## Requirements
**Functional**
- {{boolean tryAcquire(String key)}} with configurable algorithm: token bucket, fixed window, sliding window log, sliding window counter.
- Rules per route/tier (e.g. free: 100/min, premium: 1000/min).
- Return remaining quota and retry-after for {{429}} headers.

**Non-functional**
- Thread-safe, low overhead (sub-microsecond in-process).
- Bounded memory: idle keys evicted.
- Deterministic tests: inject a clock.

## Core entities
- **RateLimiter** (interface): {{tryAcquire(key)}}.
- **TokenBucketLimiter**, **SlidingWindowLogLimiter**, **SlidingWindowCounterLimiter**, **FixedWindowLimiter**.
- **Rule** (limit, period, burst).
- **RateLimiterFactory** / **RateLimiterRegistry** (route -> limiter).
- **TimeSource** (nanoTime abstraction).

## UML class diagram
~~~mermaid
classDiagram
  class RateLimiter { <<interface>> +tryAcquire(String key) Decision }
  class TokenBucketLimiter { -long capacity -double refillPerNano -ConcurrentHashMap buckets }
  class SlidingWindowLogLimiter { -int limit -long windowNanos }
  class SlidingWindowCounterLimiter { -int limit -long windowNanos }
  class RateLimiterRegistry { +forRoute(String) RateLimiter }
  RateLimiter <|.. TokenBucketLimiter
  RateLimiter <|.. SlidingWindowLogLimiter
  RateLimiter <|.. SlidingWindowCounterLimiter
  RateLimiterRegistry o-- RateLimiter
~~~

## Relationships
The registry aggregates limiters per rule; each limiter owns per-key state.

## Design patterns used
- **Strategy** for algorithms; **Factory** builds limiters from {{Rule}} config; **Decorator** to add metrics.

## Java implementation
~~~java
public record Decision(boolean allowed, long remaining, long retryAfterMillis) {}
public interface RateLimiter { Decision tryAcquire(String key); }
public interface TimeSource { long nanos(); TimeSource SYSTEM = System::nanoTime; }

/** Token bucket: allows bursts up to capacity, sustained rate = refill rate. Lazy refill, no background threads. */
public final class TokenBucketLimiter implements RateLimiter {
    private final long capacity; private final double tokensPerNano; private final TimeSource time;
    private final ConcurrentHashMap<String, Bucket> buckets = new ConcurrentHashMap<>();
    private static final class Bucket { double tokens; long last; Bucket(double t, long l) { tokens = t; last = l; } }

    public TokenBucketLimiter(long capacity, long refillTokens, Duration per, TimeSource time) {
        this.capacity = capacity; this.tokensPerNano = (double) refillTokens / per.toNanos(); this.time = time;
    }
    public Decision tryAcquire(String key) {
        long now = time.nanos();
        Bucket b = buckets.computeIfAbsent(key, k -> new Bucket(capacity, now));
        synchronized (b) {                                              // per-key lock: keys do not contend with each other
            b.tokens = Math.min(capacity, b.tokens + (now - b.last) * tokensPerNano);
            b.last = now;
            if (b.tokens >= 1) { b.tokens -= 1; return new Decision(true, (long) b.tokens, 0); }
            long waitNanos = (long) Math.ceil((1 - b.tokens) / tokensPerNano);
            return new Decision(false, 0, TimeUnit.NANOSECONDS.toMillis(waitNanos));
        }
    }
}

/** Sliding window log: exact, but memory O(limit) per key. */
public final class SlidingWindowLogLimiter implements RateLimiter {
    private final int limit; private final long window; private final TimeSource time;
    private final ConcurrentHashMap<String, ArrayDeque<Long>> logs = new ConcurrentHashMap<>();
    public SlidingWindowLogLimiter(int limit, Duration window, TimeSource t) { this.limit = limit; this.window = window.toNanos(); this.time = t; }
    public Decision tryAcquire(String key) {
        long now = time.nanos();
        ArrayDeque<Long> log = logs.computeIfAbsent(key, k -> new ArrayDeque<>());
        synchronized (log) {
            while (!log.isEmpty() && now - log.peekFirst() >= window) log.pollFirst();
            if (log.size() < limit) { log.addLast(now); return new Decision(true, limit - log.size(), 0); }
            return new Decision(false, 0, TimeUnit.NANOSECONDS.toMillis(window - (now - log.peekFirst())));
        }
    }
}

/** Sliding window counter: O(1) memory, approximates by weighting the previous window. */
public final class SlidingWindowCounterLimiter implements RateLimiter {
    private final int limit; private final long window; private final TimeSource time;
    private final ConcurrentHashMap<String, long[]> state = new ConcurrentHashMap<>(); // [windowStart, current, previous]
    public SlidingWindowCounterLimiter(int limit, Duration window, TimeSource t) { this.limit = limit; this.window = window.toNanos(); this.time = t; }
    public Decision tryAcquire(String key) {
        long now = time.nanos(), start = now - Math.floorMod(now, window);
        long[] s = state.computeIfAbsent(key, k -> new long[]{start, 0, 0});
        synchronized (s) {
            if (s[0] != start) { s[2] = (start - s[0] == window) ? s[1] : 0; s[1] = 0; s[0] = start; }
            double prevWeight = 1.0 - (double) (now - start) / window;
            double estimated = s[2] * prevWeight + s[1];
            if (estimated < limit) { s[1]++; return new Decision(true, (long) (limit - estimated - 1), 0); }
            return new Decision(false, 0, TimeUnit.NANOSECONDS.toMillis(window - (now - start)));
        }
    }
}
~~~

## Important methods explained
- Token bucket refills **lazily** on access using elapsed time: no scheduler thread, O(1) per call.
- Per-key {{synchronized}} on the bucket object keeps contention local to one key.
- Sliding window counter: if the previous minute had 80 requests and we are 25% into the current minute with 30 requests, estimate = 80 × 0.75 + 30 = 90.

## Extensibility
Add a {{LeakyBucketLimiter}} (queue + constant drain) for smoothing; a {{CompositeLimiter}} enforcing per-second and per-day limits together; Caffeine-based maps with {{expireAfterAccess}} to evict idle keys.

## Common mistakes
- Fixed window only (allows 2× limit across a window boundary).
- A global lock across all keys.
- Using {{System.currentTimeMillis()}} for elapsed time (wall clock can jump); use {{nanoTime}} in-process.
- Unbounded {{ConcurrentHashMap}} growth from random keys (memory DoS).

## Follow-up questions
?? How do you make this work across 20 pods?
Move state to Redis with an atomic Lua script (token bucket) or use the gateway's limiter (Envoy, Kong, AWS API Gateway usage plans). Or accept approximate local limits (limit / pod count) when exactness is not required.
?? Which algorithm for a public API?
Token bucket: allows reasonable bursts, simple to explain to clients via {{RateLimit-*}} headers, O(1) state.
` },

{ id: 'logging-framework', title: 'Logging Framework', level: 'intermediate', tags: ['lld', 'chain-of-responsibility', 'singleton', 'async'],
  summary: 'Loggers, levels, appenders, formatters, hierarchical config and asynchronous non-blocking writes.',
  mock: { entities: [['Logger with name and level', 'logger'], ['Log levels with ordering', 'level|debug|info|warn|error'], ['Appenders / sinks (console, file, remote)', 'appender|sink|handler|destination'], ['Formatter / layout', 'format|layout|pattern'], ['Log event / record', 'event|record|message']], patterns: [['Chain of responsibility for handlers/appenders', 'chain'], ['Singleton / factory for logger registry', 'singleton|factory|registry'], ['Strategy for formatter', 'strategy'], ['Observer for multiple appenders', 'observer'], ['Async queue / producer-consumer', 'async|queue|buffer|producer']] },
  body: md`
## Problem statement
Design a logging library like a mini Logback: named loggers with levels, multiple appenders (console, rolling file, remote), pluggable formatting, and minimal impact on request latency.

## Requirements
**Functional**
- Levels TRACE < DEBUG < INFO < WARN < ERROR; per-logger level with hierarchical inheritance ({{com.acme}} -> {{com.acme.orders}}).
- Multiple appenders per logger; formatters (pattern, JSON).
- MDC (mapped diagnostic context) for traceId/userId.

**Non-functional**
- Logging must not block request threads on I/O (async appenders).
- Bounded memory: when the queue is full, drop low-level events instead of OOM or blocking.
- Thread-safe; no interleaved lines.

## Core entities
- **LogLevel** (ordered enum), **LogEvent** (timestamp, level, logger, message, args, throwable, MDC snapshot, thread).
- **Logger** (name, level, appenders, parent).
- **LoggerFactory/Registry** (singleton, caches loggers).
- **Appender** (interface): ConsoleAppender, FileAppender, AsyncAppender (decorator).
- **Formatter** (interface): PatternFormatter, JsonFormatter.

## UML class diagram
~~~mermaid
classDiagram
  class LoggerFactory { -ConcurrentHashMap~String,Logger~ loggers +getLogger(String) Logger }
  class Logger { -String name -LogLevel level -Logger parent -List~Appender~ appenders +info(String, Object...) +isEnabled(LogLevel) boolean }
  class Appender { <<interface>> +append(LogEvent) }
  class AsyncAppender { -BlockingQueue~LogEvent~ queue -Appender delegate }
  class FileAppender { -Formatter formatter }
  class Formatter { <<interface>> +format(LogEvent) String }
  LoggerFactory *-- Logger
  Logger o-- Appender
  Appender <|.. AsyncAppender
  Appender <|.. FileAppender
  AsyncAppender o-- Appender
  FileAppender o-- Formatter
~~~

## Relationships
Loggers form a tree (parent references); appenders are shared aggregations; AsyncAppender decorates another appender.

## Design patterns used
- **Singleton** registry (or DI) and **Factory** for loggers.
- **Chain of Responsibility**: an event propagates up the logger hierarchy (additivity).
- **Strategy** for formatters; **Decorator** for async/filtering appenders; **Producer-consumer** for async I/O.

## Java implementation
~~~java
public enum LogLevel { TRACE, DEBUG, INFO, WARN, ERROR; boolean atLeast(LogLevel o) { return compareTo(o) >= 0; } }

public record LogEvent(Instant ts, LogLevel level, String logger, String thread, String message, Throwable error, Map<String, String> mdc) {}

public interface Appender { void append(LogEvent e); default void close() {} }
public interface Formatter { String format(LogEvent e); }

public final class Logger {
    private final String name; private final Logger parent; private volatile LogLevel level;   // null = inherit
    private final List<Appender> appenders = new CopyOnWriteArrayList<>(); private volatile boolean additive = true;
    Logger(String name, Logger parent) { this.name = name; this.parent = parent; }

    public LogLevel effectiveLevel() { for (Logger l = this; l != null; l = l.parent) if (l.level != null) return l.level; return LogLevel.INFO; }
    public boolean isEnabled(LogLevel lv) { return lv.atLeast(effectiveLevel()); }

    public void info(String fmt, Object... args)  { log(LogLevel.INFO, fmt, args); }
    public void error(String fmt, Object... args) { log(LogLevel.ERROR, fmt, args); }

    private void log(LogLevel lv, String fmt, Object... args) {
        if (!isEnabled(lv)) return;                                    // cheap check first: no formatting cost when disabled
        Throwable t = args.length > 0 && args[args.length - 1] instanceof Throwable th ? th : null;
        LogEvent e = new LogEvent(Instant.now(), lv, name, Thread.currentThread().getName(), MessageFormatter.format(fmt, args), t, Mdc.copy());
        for (Logger l = this; l != null; l = l.additive ? l.parent : null) l.appenders.forEach(a -> a.append(e)); // propagate up
    }
    public void setLevel(LogLevel l) { this.level = l; } public void addAppender(Appender a) { appenders.add(a); }
}

public final class LoggerFactory {
    private static final ConcurrentHashMap<String, Logger> LOGGERS = new ConcurrentHashMap<>();
    private static final Logger ROOT = new Logger("ROOT", null);
    public static Logger getLogger(String name) {
        return LOGGERS.computeIfAbsent(name, n -> {
            int dot = n.lastIndexOf('.');
            return new Logger(n, dot < 0 ? ROOT : getLogger(n.substring(0, dot)));
        });
    }
    public static Logger root() { return ROOT; }
}

/** Decorator: producer-consumer with bounded queue, drops DEBUG/INFO when > 80% full, never blocks on ERROR unless full. */
public final class AsyncAppender implements Appender {
    private final BlockingQueue<LogEvent> q; private final Appender delegate; private final Thread worker; private final AtomicLong dropped = new AtomicLong();
    public AsyncAppender(Appender delegate, int capacity) {
        this.q = new ArrayBlockingQueue<>(capacity); this.delegate = delegate;
        this.worker = Thread.ofPlatform().daemon().name("async-log").start(this::drain);
    }
    public void append(LogEvent e) {
        boolean lowPriority = !e.level().atLeast(LogLevel.WARN);
        if (lowPriority && q.remainingCapacity() < q.size() / 4) { dropped.incrementAndGet(); return; }
        if (!q.offer(e)) dropped.incrementAndGet();
    }
    private void drain() {
        List<LogEvent> batch = new ArrayList<>(256);
        while (!Thread.currentThread().isInterrupted()) {
            try { batch.add(q.take()); q.drainTo(batch, 255); batch.forEach(delegate::append); batch.clear(); }
            catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
        }
    }
    public void close() { worker.interrupt(); List<LogEvent> rest = new ArrayList<>(); q.drainTo(rest); rest.forEach(delegate::append); delegate.close(); }
}

public final class FileAppender implements Appender {
    private final Formatter f; private final BufferedWriter out;
    public FileAppender(Path p, Formatter f) throws IOException { this.f = f; this.out = Files.newBufferedWriter(p, StandardOpenOption.CREATE, StandardOpenOption.APPEND); }
    public synchronized void append(LogEvent e) {                       // synchronized: no interleaved lines
        try { out.write(f.format(e)); out.newLine(); if (e.level().atLeast(LogLevel.WARN)) out.flush(); }
        catch (IOException ex) { System.err.println("log write failed: " + ex.getMessage()); }   // never throw into the caller
    }
}
~~~

## Important methods explained
- {{isEnabled}} before formatting: avoids string building for disabled levels (same reason SLF4J uses {{"{}"}} placeholders).
- Hierarchical lookup walks up parents; in production cache effective level and invalidate on reconfiguration.
- {{AsyncAppender}}: bounded queue + drain batches; drops low-priority events under pressure and counts drops (expose as a metric).

## Extensibility
New sink (Kafka, OpenSearch) = new Appender; JSON logs = new Formatter; filters (e.g. mask card numbers) = decorator appender.

## Common mistakes
- Logging synchronously to a remote service from request threads.
- Unbounded async queue (OOM during an incident, exactly when logs spike).
- Throwing exceptions from the logger into business code.
- Logging secrets/PII (tokens, OTPs, card numbers).

## Follow-up questions
?? How does MDC work with thread pools and CompletableFuture?
MDC is ThreadLocal, so it does not propagate automatically. Capture the map when submitting and restore it in the task (a {{TaskDecorator}} in Spring), or use Micrometer context propagation.
?? How do you change log levels at runtime in production?
Spring Boot Actuator {{/actuator/loggers}} (secured), or watch a config source; the registry updates the level and invalidates the cached effective levels.
` },

{ id: 'inventory', title: 'Inventory Management System', level: 'intermediate', tags: ['lld', 'concurrency', 'reservation'],
  summary: 'SKUs per warehouse, reservations vs on-hand stock, concurrency-safe decrement, replenishment and low-stock alerts.',
  mock: { entities: [['Product / SKU', 'sku|product'], ['Warehouse / location stock levels', 'warehouse|location|stock'], ['On-hand vs reserved vs available quantities', 'reserv|on.?hand|available'], ['Reservation with expiry', 'expir|ttl|hold'], ['Stock movement / audit ledger', 'movement|ledger|audit|history']], patterns: [['Observer for low-stock alerts', 'observer|alert|event'], ['Strategy for warehouse selection / allocation', 'strategy|allocation'], ['Command / event sourcing for movements', 'command|event'], ['Optimistic locking / atomic decrement', 'optimistic|version|atomic|conditional']] },
  body: md`
## Problem statement
Design inventory for an e-commerce company with multiple warehouses: track stock per SKU and location, reserve stock at checkout, commit on payment, release on cancellation, and alert on low stock.

## Requirements
**Functional**
- Receive stock (purchase order), adjust (damage/count corrections), transfer between warehouses.
- Reserve on checkout (with expiry), commit on payment, release on cancel/timeout.
- Choose a fulfilment warehouse (nearest with full availability, else split).
- Low-stock alerts at reorder points.

**Non-functional**
- Never oversell: concurrent checkouts for the last unit must not both succeed.
- Full audit trail of stock movements.
- Reads (availability on product pages) vastly outnumber writes; can be slightly stale. Checkout must be exact.

## Core entities
- **Sku**, **Warehouse**.
- **StockLevel** (sku, warehouse, onHand, reserved, version); available = onHand - reserved.
- **Reservation** (id, orderId, lines, expiresAt, status).
- **StockMovement** (append-only ledger: RECEIVE, RESERVE, COMMIT, RELEASE, ADJUST, TRANSFER).
- **AllocationStrategy** (pick warehouses).

## UML class diagram
~~~mermaid
classDiagram
  class StockLevel { +String sku +String warehouse +int onHand +int reserved +long version +available() int }
  class Reservation { +String id +String orderId +List~ReservationLine~ lines +Instant expiresAt +Status status }
  class InventoryService { +reserve(orderId, lines) Reservation +commit(reservationId) +release(reservationId) +receive(sku, wh, qty) }
  class AllocationStrategy { <<interface>> +allocate(lines, Map) Map }
  class StockMovement { +MovementType type +int qty +Instant at +String ref }
  InventoryService ..> StockLevel
  InventoryService ..> AllocationStrategy
  InventoryService ..> StockMovement
  Reservation *-- ReservationLine
~~~

## Relationships
Reservation composes lines; movements reference stock levels by key (sku, warehouse).

## Design patterns used
- **Strategy**: allocation (nearest, cheapest shipping, minimise splits).
- **Observer/events**: {{StockBelowReorderPoint}} triggers purchasing.
- **Event-sourcing-lite**: movements are the audit trail; levels are a maintained projection.

## Java implementation
~~~java
@Service
public class InventoryService {
    private final StockJdbc stock; private final ReservationRepository reservations; private final AllocationStrategy allocation;
    private final MovementRepository movements; private final ApplicationEventPublisher events; private final Clock clock;
    // constructor omitted

    @Transactional
    public Reservation reserve(String orderId, List<Line> lines, String destinationRegion) {
        Map<String, List<Line>> plan = allocation.allocate(lines, stock.availability(lines), destinationRegion);
        for (var e : plan.entrySet()) {
            for (Line l : e.getValue()) {
                // atomic conditional decrement of availability; no read-modify-write race
                int rows = stock.reserve(l.sku(), e.getKey(), l.qty());
                if (rows == 0) throw new OutOfStockException(l.sku());        // rolls back all earlier reservations
                movements.append(StockMovement.reserve(l.sku(), e.getKey(), l.qty(), orderId));
            }
        }
        return reservations.save(Reservation.pending(orderId, plan, clock.instant().plus(Duration.ofMinutes(15))));
    }

    @Transactional
    public void commit(String reservationId) {                                // payment captured
        Reservation r = reservations.lockById(reservationId);
        if (r.status() == Status.COMMITTED) return;                           // idempotent
        if (r.status() != Status.PENDING) throw new IllegalStateException("reservation " + r.status());
        r.lines().forEach(l -> { stock.commit(l.sku(), l.warehouse(), l.qty()); afterChange(l.sku(), l.warehouse()); });
        r.commit();
    }

    @Transactional
    public void release(String reservationId) {                               // cancel or expiry job
        Reservation r = reservations.lockById(reservationId);
        if (r.status() != Status.PENDING) return;
        r.lines().forEach(l -> stock.release(l.sku(), l.warehouse(), l.qty()));
        r.release();
    }

    private void afterChange(String sku, String wh) {
        StockLevel s = stock.get(sku, wh);
        if (s.available() <= s.reorderPoint()) events.publishEvent(new StockBelowReorderPoint(sku, wh, s.available()));
    }
}
~~~
~~~sql
-- reserve: succeeds only if enough is available
UPDATE stock_level SET reserved = reserved + :qty, version = version + 1
 WHERE sku = :sku AND warehouse = :wh AND on_hand - reserved >= :qty;

-- commit: stock leaves the building
UPDATE stock_level SET on_hand = on_hand - :qty, reserved = reserved - :qty WHERE sku = :sku AND warehouse = :wh;

-- release
UPDATE stock_level SET reserved = reserved - :qty WHERE sku = :sku AND warehouse = :wh AND reserved >= :qty;

ALTER TABLE stock_level ADD CONSTRAINT chk_non_negative CHECK (on_hand >= 0 AND reserved >= 0 AND reserved <= on_hand);
~~~

## Important methods explained
- {{reserve}}: conditional UPDATE is an atomic check-and-decrement executed under a row lock by the DB; the CHECK constraint is a final safety net.
- Reservations expire: a job (or delayed message) calls {{release}} for PENDING reservations past {{expiresAt}}; {{release}} is idempotent.

## Extensibility
Batch/lot and expiry tracking (FEFO for groceries/pharma) as allocation strategies; serial-numbered items; dropshipping suppliers as virtual warehouses.

## Common mistakes
- {{SELECT stock; if (stock >= qty) UPDATE stock = stock - qty}} without locking.
- Decrementing on-hand at add-to-cart (cart abandonment locks inventory).
- No audit ledger: impossible to explain discrepancies after a stock count.

## Follow-up questions
?? A flash sale: 10,000 people try to buy 500 units of one SKU. The single row becomes a hotspot. What do you do?
Pre-split the stock into N buckets (rows) and reserve from a random bucket (retry another on failure), or move the hot counter to Redis with an atomic Lua decrement and reconcile to the DB asynchronously, combined with a queue/waiting room. Measure first; PostgreSQL handles a few thousand row updates/sec on one row before lock contention dominates.
?? How do product pages show availability cheaply?
A cached read model (Redis) updated by stock-change events, with a "low stock" bucket instead of exact counts.
` },

{ id: 'hotel-reservation', title: 'Hotel Reservation System', level: 'intermediate', tags: ['lld', 'booking', 'date-ranges'],
  summary: 'Room types, date-range availability, overlapping booking prevention, pricing by night and cancellation policies.',
  mock: { entities: [['Hotel, RoomType, Room', 'room'], ['Booking with check-in / check-out range', 'check.?in|check.?out|date|range|night'], ['Availability / inventory per room type per night', 'availab|inventory|per night|calendar'], ['Guest', 'guest|customer'], ['Cancellation policy', 'cancel']], patterns: [['Strategy for pricing (seasonal, weekend)', 'strategy|season|weekend'], ['Strategy for cancellation policy', 'cancel.{0,40}(polic|strategy)'], ['State for booking status', 'state|status'], ['Overlap check / exclusion constraint / locking', 'overlap|exclusion|lock|conditional']] },
  body: md`
## Problem statement
Design reservations for a hotel chain: search availability by room type and dates, book, modify, cancel with policy-dependent refunds, and price per night (weekends, seasons, Ramadan/Diwali peaks).

## Requirements
**Functional**
- Search availability for (hotel, check-in, check-out, guests).
- Book a room type for a date range; assign a specific room at check-in (or at booking).
- Price per night with rules; taxes and tourism fees (e.g. Dubai Tourism Dirham fee per room-night).
- Cancel with policy (free until 48h before, then first night charged).

**Non-functional**
- No overbooking beyond configured allowance.
- Date handling in the hotel's time zone; check-out date is exclusive.

## Core entities
- **Hotel**, **RoomType** (capacity, base rate), **Room** (number, type, status).
- **RoomTypeInventory** (hotel, roomType, date, total, booked): one row per night.
- **Booking** (guest, roomType, checkIn, checkOut, status, price breakdown, policy).
- **PricingStrategy**, **CancellationPolicy**.

## UML class diagram
~~~mermaid
classDiagram
  class Booking { +String id +LocalDate checkIn +LocalDate checkOut +BookingStatus status +Money total +cancel(Clock) Money }
  class RoomTypeInventory { +LocalDate night +int total +int booked +int overbookAllowance }
  class PricingStrategy { <<interface>> +nightly(RoomType, LocalDate) Money }
  class CancellationPolicy { <<interface>> +penalty(Booking, Instant) Money }
  class ReservationService { +search(...) List~Offer~ +book(...) Booking +cancel(id) }
  ReservationService ..> RoomTypeInventory
  ReservationService ..> PricingStrategy
  Booking o-- CancellationPolicy
~~~

## Relationships
Booking aggregates a cancellation policy (snapshotted terms); inventory rows are per room type per night.

## Design patterns used
- **Strategy**: pricing (composite of seasonal + weekend + length-of-stay discount) and cancellation policy.
- **State**: booking status (HELD, CONFIRMED, CHECKED_IN, CHECKED_OUT, CANCELLED, NO_SHOW).

## Java implementation
~~~java
@Service
public class ReservationService {
    private final InventoryJdbc inventory; private final BookingRepository bookings; private final PricingStrategy pricing; private final Clock clock;
    // constructor omitted

    @Transactional
    public Booking book(String hotelId, String roomTypeId, LocalDate in, LocalDate out, Guest guest, CancellationPolicy policy) {
        if (!out.isAfter(in)) throw new IllegalArgumentException("check-out must be after check-in");
        List<LocalDate> nights = in.datesUntil(out).toList();                  // [in, out): check-out night not charged
        int updated = inventory.incrementBooked(hotelId, roomTypeId, nights);   // one conditional UPDATE for all nights
        if (updated != nights.size()) throw new NoAvailabilityException(roomTypeId, in, out); // rollback partial
        Money total = nights.stream().map(n -> pricing.nightly(roomTypeId, n)).reduce(Money::plus).orElseThrow();
        return bookings.save(Booking.confirmed(hotelId, roomTypeId, in, out, guest, total, policy.snapshot()));
    }

    @Transactional
    public Money cancel(String bookingId) {
        Booking b = bookings.lockById(bookingId);
        if (b.status() == BookingStatus.CANCELLED) return b.cancellationFee();   // idempotent
        Money fee = b.policy().penalty(b, clock.instant());
        inventory.decrementBooked(b.hotelId(), b.roomTypeId(), b.checkIn().datesUntil(b.checkOut()).toList());
        b.cancel(fee);
        return fee;
    }
}

public final class FreeUntilHoursBefore implements CancellationPolicy {
    private final Duration freeWindow; private final ZoneId hotelZone; private final LocalTime checkInTime;
    // constructor omitted
    public Money penalty(Booking b, Instant now) {
        Instant checkIn = b.checkIn().atTime(checkInTime).atZone(hotelZone).toInstant();
        return now.isBefore(checkIn.minus(freeWindow)) ? Money.zero(b.total().currency()) : b.firstNightPrice();
    }
}
~~~
~~~sql
UPDATE room_type_inventory
   SET booked = booked + 1
 WHERE hotel_id = :hotel AND room_type_id = :type AND night = ANY(:nights)
   AND booked < total + overbook_allowance;
-- updated row count must equal number of nights

-- Alternative for specific-room assignment: PostgreSQL exclusion constraint prevents overlapping ranges
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE room_assignment ADD CONSTRAINT no_overlap
  EXCLUDE USING gist (room_id WITH =, daterange(check_in, check_out, '[)') WITH &&);
~~~

## Important methods explained
- Inventory per night turns a range-overlap problem into simple counters; search is a {{MIN(total - booked)}} over the nights.
- The exclusion constraint guarantees no two assignments of the same physical room overlap, enforced by the database even under races.
- Cancellation policy is **snapshotted** at booking: changing the hotel's policy later must not affect existing bookings.

## Extensibility
Rate plans (non-refundable cheaper rate, breakfast included) = pricing + policy pairs; channel managers (Booking.com) = adapters publishing inventory; loyalty pricing = another strategy.

## Common mistakes
- Treating check-out day as a booked night.
- Using {{LocalDateTime}} without a zone for policy deadlines.
- Checking overlap in application code without a lock/constraint.

## Follow-up questions
?? How do you handle overbooking intentionally?
Configure an allowance per room type/night based on historical no-show rates; walk-out procedure if everyone shows. The inventory predicate includes the allowance.
?? How do you sync availability with OTAs?
Publish inventory/rate changes as events to a channel-manager adapter; OTA bookings come back via webhooks and go through the same {{book}} path (idempotent by OTA booking reference).
` },

{ id: 'chess', title: 'Chess Game', level: 'intermediate', tags: ['lld', 'polymorphism', 'command'],
  summary: 'Board, pieces with polymorphic move generation, move validation including check, game state and undo.',
  mock: { entities: [['Board / Cell / Position', 'board|cell|position|square'], ['Piece hierarchy (King, Queen, ...)', 'piece|king|queen|knight'], ['Player / Color', 'player|color|colour|white|black'], ['Move object', 'move'], ['Game with status and turn', 'game|turn|status|checkmate']], patterns: [['Polymorphism / strategy for piece movement', 'polymorph|strategy|override|abstract'], ['Command for moves (undo)', 'command|undo'], ['State for game status', 'state'], ['Factory to set up pieces', 'factory']] },
  body: md`
## Problem statement
Design a two-player chess game: board setup, legal move generation, turn handling, check/checkmate/stalemate detection, special moves (castling, en passant, promotion), and undo.

## Requirements
**Functional**
- Standard 8×8 setup; alternate turns; reject illegal moves.
- A move is illegal if it leaves your own king in check.
- Detect check, checkmate, stalemate; support resignation and draw by agreement.
- Move history (algebraic notation) and undo.

**Non-functional**
- Easy to add variants (Chess960 setup, timers).
- Testable move generation (perft tests).

## Core entities
- **Position** (file, rank) value object; **Board** (8×8 array of Piece or null).
- **Piece** (abstract: color, {{pseudoLegalMoves(board, from)}}) with King, Queen, Rook, Bishop, Knight, Pawn.
- **Move** (from, to, piece, captured, promotion, special flags).
- **Game** (board, current turn, status, history), **Player**.

## UML class diagram
~~~mermaid
classDiagram
  class Game { -Board board -Color turn -GameStatus status -Deque~Move~ history +play(Position, Position) +undo() }
  class Board { -Piece[][] grid +pieceAt(Position) Piece +apply(Move) +revert(Move) +isAttacked(Position, Color) boolean }
  class Piece { <<abstract>> +Color color +pseudoLegalMoves(Board, Position) List~Move~ }
  class Knight
  class SlidingPiece { <<abstract>> #directions() int[][] }
  class Rook
  class Bishop
  class Queen
  class King
  class Pawn
  Game *-- Board
  Board o-- Piece
  Piece <|-- Knight
  Piece <|-- SlidingPiece
  SlidingPiece <|-- Rook
  SlidingPiece <|-- Bishop
  SlidingPiece <|-- Queen
  Piece <|-- King
  Piece <|-- Pawn
~~~

## Relationships
Game composes the board; the board aggregates pieces; Move objects reference positions and pieces.

## Design patterns used
- **Polymorphism / Template Method**: {{SlidingPiece}} implements ray-walking once; Rook/Bishop/Queen supply directions.
- **Command**: {{Move}} carries enough state to apply and revert (undo).
- **State**: game status (ACTIVE, CHECK, CHECKMATE, STALEMATE, RESIGNED, DRAW).
- **Factory**: board setup (standard vs Chess960).

## Java implementation
~~~java
public enum Color { WHITE, BLACK; Color opponent() { return this == WHITE ? BLACK : WHITE; } }
public record Position(int file, int rank) { boolean valid() { return file >= 0 && file < 8 && rank >= 0 && rank < 8; } Position plus(int df, int dr) { return new Position(file + df, rank + dr); } }
public record Move(Position from, Position to, Piece piece, Piece captured, Piece promotion) {}

public abstract class Piece {
    protected final Color color;
    protected Piece(Color c) { this.color = c; }
    public Color color() { return color; }
    public abstract List<Move> pseudoLegalMoves(Board b, Position from);
    protected boolean canLandOn(Board b, Position p) { Piece x = b.pieceAt(p); return x == null || x.color != color; }
}

public abstract class SlidingPiece extends Piece {
    protected SlidingPiece(Color c) { super(c); }
    protected abstract int[][] directions();
    public final List<Move> pseudoLegalMoves(Board b, Position from) {
        List<Move> moves = new ArrayList<>();
        for (int[] d : directions()) {
            for (Position p = from.plus(d[0], d[1]); p.valid(); p = p.plus(d[0], d[1])) {
                Piece target = b.pieceAt(p);
                if (target == null) { moves.add(new Move(from, p, this, null, null)); continue; }
                if (target.color != color) moves.add(new Move(from, p, this, target, null));
                break;                                                            // blocked
            }
        }
        return moves;
    }
}
public final class Rook extends SlidingPiece { public Rook(Color c) { super(c); } protected int[][] directions() { return new int[][]{{1,0},{-1,0},{0,1},{0,-1}}; } }
public final class Bishop extends SlidingPiece { public Bishop(Color c) { super(c); } protected int[][] directions() { return new int[][]{{1,1},{1,-1},{-1,1},{-1,-1}}; } }
public final class Queen extends SlidingPiece { public Queen(Color c) { super(c); } protected int[][] directions() { return new int[][]{{1,0},{-1,0},{0,1},{0,-1},{1,1},{1,-1},{-1,1},{-1,-1}}; } }

public final class Knight extends Piece {
    private static final int[][] JUMPS = {{1,2},{2,1},{2,-1},{1,-2},{-1,-2},{-2,-1},{-2,1},{-1,2}};
    public Knight(Color c) { super(c); }
    public List<Move> pseudoLegalMoves(Board b, Position from) {
        List<Move> out = new ArrayList<>();
        for (int[] j : JUMPS) { Position p = from.plus(j[0], j[1]); if (p.valid() && canLandOn(b, p)) out.add(new Move(from, p, this, b.pieceAt(p), null)); }
        return out;
    }
}

public final class Game {
    private final Board board; private Color turn = Color.WHITE; private GameStatus status = GameStatus.ACTIVE;
    private final Deque<Move> history = new ArrayDeque<>();
    public Game(Board board) { this.board = board; }

    public synchronized void play(Position from, Position to) {
        if (status.isOver()) throw new IllegalStateException("game over: " + status);
        Piece p = board.pieceAt(from);
        if (p == null || p.color() != turn) throw new IllegalMoveException("not your piece");
        Move m = legalMoves(turn).stream().filter(x -> x.from().equals(from) && x.to().equals(to)).findFirst()
                     .orElseThrow(() -> new IllegalMoveException(from + "->" + to));
        board.apply(m); history.push(m);
        turn = turn.opponent();
        status = evaluate(turn);
    }

    /** Legal = pseudo-legal moves that do not leave own king attacked (try, test, revert). */
    List<Move> legalMoves(Color c) {
        List<Move> legal = new ArrayList<>();
        for (Position from : board.positionsOf(c))
            for (Move m : board.pieceAt(from).pseudoLegalMoves(board, from)) {
                board.apply(m);
                if (!board.isAttacked(board.kingOf(c), c.opponent())) legal.add(m);
                board.revert(m);
            }
        return legal;
    }

    private GameStatus evaluate(Color toMove) {
        boolean inCheck = board.isAttacked(board.kingOf(toMove), toMove.opponent());
        boolean hasMoves = !legalMoves(toMove).isEmpty();
        if (!hasMoves) return inCheck ? GameStatus.CHECKMATE : GameStatus.STALEMATE;
        return inCheck ? GameStatus.CHECK : GameStatus.ACTIVE;
    }

    public synchronized void undo() {
        Move m = history.poll(); if (m == null) return;
        board.revert(m); turn = turn.opponent(); status = evaluate(turn);
    }
}
~~~

## Important methods explained
- {{SlidingPiece.pseudoLegalMoves}}: shared ray-walking; stops at the first blocker, capturing if it is an enemy.
- {{legalMoves}}: generate pseudo-legal moves, apply, check king safety, revert. Simple and correct; engines optimise with pins/attack maps.
- {{Move}} as a command with {{captured}} lets {{revert}} restore the board exactly (castling/en passant/promotion need extra fields).

## Extensibility
Chess960: a different setup factory. Clocks: a {{GameClock}} observer on {{play}}. Online play: Game becomes an aggregate persisted per move with optimistic version checks.

## Common mistakes
- Forgetting that moves leaving your king in check are illegal (or pins).
- Putting all movement logic in one giant switch in Board.
- No undo support because moves do not capture enough state.

## Follow-up questions
?? How would you build an online chess service?
Game state as an aggregate (FEN + move list) in a DB, moves submitted via WebSocket, validated server-side with optimistic concurrency (expected move number), clocks server-authoritative, spectators via pub/sub.
?? How do you test move generation?
Perft: count leaf nodes to depth N from known positions and compare with published values; it catches subtle castling/en passant bugs.
` }
]);
})();
