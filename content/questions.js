(function () {
const md = LAB.md;
// Q(id, module, topicKey, topic, level, type, question, {expected, explanation, example, wrong, followups, keyPoints})
const Q = (id, module, topicKey, topic, level, type, q, o) => Object.assign({ id, module, topicKey, topic, level, type, q }, o);

LAB.addQuestions([
/* ======================= LLD ======================= */
Q('lld-01', 'lld', 'lld:solid', 'SOLID', 'beginner', 'direct', 'Explain the Open/Closed Principle with an example from a Spring Boot service you would build.', {
  expected: md`OCP: modules should be **open for extension, closed for modification**. New behaviour is added by writing new code (a new implementation of an abstraction) rather than editing existing, tested code. In Spring, define an interface (e.g. {{NotificationChannel}}), implement each channel as a bean, inject {{List<NotificationChannel>}} into a dispatcher that builds a map by type. Adding WhatsApp means adding one class; the dispatcher never changes.`,
  explanation: md`The point is to protect stable code from churn at **volatility points**. It is achieved through polymorphism (strategy registries), configuration and plug-in mechanisms. Over-applying it (interfaces everywhere for things that never vary) adds indirection without benefit.`,
  example: md`~~~java
@Service class Dispatcher {
  private final Map<Channel, NotificationChannel> byType;
  Dispatcher(List<NotificationChannel> all) { byType = all.stream().collect(toMap(NotificationChannel::type, c -> c)); }
  void send(Notification n) { byType.get(n.channel()).send(n); }
}
~~~`,
  wrong: md`- "Classes should never be modified" (bug fixes and refactoring are fine).
- Equating OCP with inheritance only.
- An example with a switch statement that still must be edited for each new type.`,
  followups: [['Where would you NOT apply OCP?', 'In stable code paths with no expected variation; YAGNI. Apply where change is likely (providers, pricing, channels).'], ['How do sealed interfaces with exhaustive switch relate?', 'They trade OCP for compiler-checked exhaustiveness: adding a type forces updates everywhere, which can be desirable for closed domains (payment states).']],
  keyPoints: [['Definition: extend without modifying existing code', 'extension|extend.{0,40}(without|not) modif|closed for modification'], ['Abstraction/interface + polymorphism', 'interface|abstract|polymorph'], ['Concrete Spring example (beans registry / injection of list or map)', 'bean|inject|list<|map<|@component|@service'], ['When not to over-apply', 'over|yagni|unnecessary|stable']]
}),
Q('lld-02', 'lld', 'lld:singleton', 'Singleton', 'intermediate', 'code-review', 'Code review: a colleague wrote a lazy singleton with "if (instance == null) instance = new Config();" inside a getInstance() method. What is wrong and how would you fix it?', {
  expected: md`It is not thread-safe: two threads can both see {{null}} and create two instances (race), and without proper publication another thread may even observe a partially constructed object. Fixes: **holder-class idiom** (lazy, thread-safe through class initialisation), **enum singleton**, or **double-checked locking with a volatile field**. In Spring, the better answer is usually to make it a singleton bean and inject it.`,
  explanation: md`The JLS guarantees class initialisation happens once with proper synchronisation, so a static holder class is both lazy and safe without locks on the hot path. Double-checked locking requires {{volatile}} to prevent reordering of the reference assignment before construction completes.`,
  example: md`~~~java
public final class Config {
  private Config() {}
  private static final class Holder { static final Config INSTANCE = new Config(); }
  public static Config get() { return Holder.INSTANCE; }
}
~~~`,
  wrong: md`- "Just make getInstance() synchronized" (works but adds lock cost on every call; acceptable but not best).
- Double-checked locking without volatile.
- Claiming Spring singletons are JVM-wide singletons.`,
  followups: [['How can serialization break a singleton?', 'Deserialisation creates a new instance unless readResolve returns the existing one; enum singletons are safe by design.']],
  keyPoints: [['Identifies race condition / not thread-safe', 'race|thread.?safe|two threads|multiple instances'], ['Holder idiom or enum', 'holder|enum'], ['volatile with double-checked locking', 'volatile'], ['Prefer DI singleton bean', 'bean|spring|inject']]
}),
Q('lld-03', 'lld', 'lld:parking-lot', 'Parking Lot', 'intermediate', 'scenario', 'In your parking lot design, two entry gates try to assign the last compact spot at the same moment. Walk through what happens in your design and why it is correct.', {
  expected: md`Spot allocation must be an **atomic acquire**. With per-floor, per-type free pools implemented as a {{ConcurrentLinkedDeque}}, {{poll()}} is atomic: exactly one gate receives the spot, the other gets {{null}} and continues to the next compatible type/floor or reports the lot full. If state lives in a database across several gate servers, use a conditional update ({{UPDATE spot SET vehicle_id=? WHERE id=? AND vehicle_id IS NULL}}) and check the affected row count, retrying on zero.`,
  explanation: md`The bug to avoid is check-then-act: "find a free spot" then "mark it occupied" as two steps. A global lock fixes correctness but serialises all gates; atomic pool operations or row-level conditional updates keep throughput.`,
  example: md`~~~java
Optional<Spot> s = floor.tryAcquire(SpotType.COMPACT); // CLD.poll(): atomic
~~~`,
  wrong: md`- "synchronized on enter()" across distributed gates (does not work across JVMs).
- Scanning spots with isFree() and then setting occupied without atomicity.`,
  followups: [['What if allocation needs several steps (reserve EV charger + spot)?', 'Lock per floor (ReentrantLock) or a DB transaction with SELECT FOR UPDATE ordered by id to avoid deadlocks.']],
  keyPoints: [['Atomic acquire, not check-then-act', 'atomic|check.?then.?act|poll|compare.?and'], ['Exactly one winner, loser retries / next spot', 'one (gate|winner)|other.{0,30}(next|retry|null|full)'], ['Distributed case: conditional DB update / row lock', 'conditional|where .* is null|for update|row'], ['Avoid global lock bottleneck', 'global lock|serializ|bottleneck|throughput']]
}),
Q('lld-04', 'lld', 'lld:strategy', 'Strategy vs State', 'intermediate', 'tradeoff', 'Strategy and State have the same class structure. How do you decide which one you are applying, and give one example of each from a payments or booking domain.', {
  expected: md`Same structure (context delegates to an interface), different **intent**. **Strategy**: the client selects an interchangeable algorithm; strategies are independent and do not know about each other (fee calculation, acquirer routing, pricing). **State**: behaviour changes with the object's internal state, and state objects drive **transitions** to other states (payment CREATED -> AUTHORIZED -> CAPTURED; booking HELD -> CONFIRMED). If the implementations decide "what comes next", it is State.`,
  explanation: md`State enforces legal transitions in one place and eliminates scattered status checks. Strategy enables runtime substitution per tenant/config. Both reduce conditionals.`,
  example: md`~~~java
interface RoutingStrategy { Acquirer route(Payment p); }            // Strategy
sealed interface BookingState permits Held, Confirmed, Cancelled {  // State
  default BookingState confirm() { throw new IllegalStateException(); }
}
~~~`,
  wrong: md`- "They are the same pattern."
- Using an enum status with if/else everywhere and calling it State pattern.`,
  followups: [['How do you persist a State pattern object?', 'Persist an enum/status column; map to state objects in the domain; enforce transitions with conditional updates in SQL as well.']],
  keyPoints: [['Intent difference: client chooses vs internal state drives', 'intent|client (chooses|selects)|internal state'], ['State handles transitions', 'transition'], ['Strategy example (pricing/routing/fees)', 'pric|rout|fee|strategy'], ['State example (payment/booking lifecycle)', 'authoriz|captur|held|confirm|lifecycle|status']]
}),
Q('lld-05', 'lld', 'lld:concurrency-lld', 'Concurrency in LLD', 'advanced', 'debugging', 'A ConcurrentHashMap-based cache occasionally creates two expensive objects for the same key under load. The code is: if (!map.containsKey(k)) map.put(k, load(k)); return map.get(k); Explain and fix.', {
  expected: md`It is a **check-then-act** race: two threads both see the key absent and both call {{load}}. {{ConcurrentHashMap}} makes individual operations thread-safe, not sequences. Use {{computeIfAbsent(k, this::load)}}, which atomically computes once per key (blocking other writers to that bin while computing). For long-running loads, avoid holding the bin lock: store a {{CompletableFuture}} via {{computeIfAbsent}} (memoizing future) or use Caffeine's {{LoadingCache}}, which coalesces concurrent loads.`,
  explanation: md`computeIfAbsent's mapping function must be short and must not modify the same map (can deadlock/throw). A future-based memo makes the critical section tiny and lets callers wait on the same in-flight load.`,
  example: md`~~~java
ConcurrentHashMap<String, CompletableFuture<Report>> cache = new ConcurrentHashMap<>();
Report get(String k) { return cache.computeIfAbsent(k, key -> CompletableFuture.supplyAsync(() -> load(key), pool)).join(); }
~~~`,
  wrong: md`- "Wrap it in synchronized" (works but serialises all keys).
- "Use putIfAbsent" while still calling load() eagerly (still loads twice, just discards one).`,
  followups: [['What about failures in the future-based cache?', 'Remove the failed future from the map so later calls retry; otherwise failures are cached forever.']],
  keyPoints: [['Check-then-act race explained', 'check.?then.?act|race|both (see|call)'], ['computeIfAbsent atomic', 'computeifabsent'], ['Long computations: future memo / Caffeine', 'future|caffeine|loadingcache|coalesc'], ['Do not modify map inside mapping function / keep short', 'short|recurs|inside|bin lock|deadlock']]
}),
Q('lld-06', 'lld', 'lld:movie-booking', 'Movie Ticket Booking', 'advanced', 'architecture', 'How do you implement seat holds that expire after 8 minutes without relying on a background job for correctness?', {
  expected: md`Store {{hold_expires_at}} with the seat and treat **expired holds as free in the predicate** of the hold query: {{UPDATE show_seat SET state='HELD', held_by=?, hold_expires_at=? WHERE show_id=? AND seat_id = ANY(?) AND (state='AVAILABLE' OR (state='HELD' AND hold_expires_at < now()))}}. Check the updated row count equals the requested seats; otherwise roll back. Confirmation checks the hold is still owned and unexpired. A background job only tidies state and notifies; correctness never depends on it running on time.`,
  explanation: md`Time-based predicates make expiry a property of the data, robust to crashed schedulers. All-or-nothing semantics come from the transaction and the count check.`,
  example: md`See the Movie Ticket Booking LLD for the full SQL and the in-memory lock-ordering variant.`,
  wrong: md`- "A cron job releases holds every minute" as the only mechanism.
- Redis TTL alone without the database as the source of truth for sold seats.`,
  followups: [['Payment succeeded after hold expiry and seat was resold. Now what?', 'Confirm fails (0 rows); mark booking failed and refund automatically (idempotent by booking id).']],
  keyPoints: [['Expiry timestamp stored', 'expir'], ['Expired holds treated as free in the predicate', 'predicate|where.{0,80}expir|expired.{0,30}(free|available)|treat'], ['Single conditional update with row-count check', 'conditional|row count|rows|updated'], ['Background job only for cleanup', 'cleanup|tidy|not (rely|depend)|job']]
}),
Q('lld-07', 'lld', 'lld:clean-arch', 'Clean Architecture', 'advanced', 'architecture', 'Your team debates separate domain models vs JPA entities used as the domain model in a hexagonal architecture. What do you recommend?', {
  expected: md`It depends on domain complexity and change drivers. **Separate models** keep the domain free of persistence concerns (no lazy proxies, no no-arg constructors, freedom to change storage), at the cost of mapping code, double maintenance and loss of dirty-checking convenience. **Annotated entities as domain** are pragmatic for simpler bounded contexts. Recommendation: rich, rule-heavy domains (payments, bookings) get separate models or at least strict boundaries; CRUD-ish contexts use annotated entities. Keep HTTP/Kafka out of the domain either way, and enforce boundaries with ArchUnit.`,
  explanation: md`The architecture's value is the dependency rule and testable use cases, not mapping layers for their own sake. Make the decision per bounded context.`,
  example: md`~~~java
// Domain
public final class Payment { private PaymentStatus status; public void capture() { ... } }
// Adapter
@Entity class PaymentJpa { @Id String id; @Enumerated String status; }
class PaymentMapper { Payment toDomain(PaymentJpa e) { ... } }
~~~`,
  wrong: md`- Dogmatic "always separate" or "never separate" without trade-offs.`,
  followups: [['How do you enforce the dependency rule?', 'Module boundaries (Maven/Gradle modules), ArchUnit tests, Spring Modulith verification.']],
  keyPoints: [['Trade-off: purity vs mapping cost', 'mapping|boilerplate|duplicat|cost'], ['Depends on domain complexity', 'depend|complex|rich|crud'], ['Keep framework/transport out of domain', 'framework|http|kafka|spring.{0,20}domain'], ['Enforcement (ArchUnit/modules)', 'archunit|modul']]
}),
Q('lld-08', 'lld', 'lld:splitwise', 'Splitwise', 'intermediate', 'debugging', 'Users report that splitting AED 100 equally among 3 people shows balances that do not add up to 100. What is the likely bug and fix?', {
  expected: md`Floating-point or naive rounding: 100/3 = 33.333... rounded to 33.33 × 3 = 99.99. Fix: compute in **integer minor units** (fils/paise) and distribute the remainder deterministically (10000 / 3 = 3333 rem 1 → one person gets 3334). For percentages, round down and let the last participant absorb the remainder, and validate that splits always sum exactly to the total. Use {{BigDecimal}} with explicit scale and RoundingMode if not using minor units.`,
  explanation: md`Money invariants (sum of parts = total) must be enforced in code and tests; property-based tests are great here.`,
  example: md`~~~java
long base = total / n, rem = total % n;
for (int i = 0; i < n; i++) owed[i] = base + (i < rem ? 1 : 0);
~~~`,
  wrong: md`- "Use double with Math.round."
- Ignoring the remainder (money disappears).`,
  followups: [['How do you test this?', 'Property-based tests asserting sum(splits)==total for random totals and participant counts.']],
  keyPoints: [['Floating point / rounding issue', 'float|double|round'], ['Integer minor units or BigDecimal', 'minor unit|cents|fils|paise|bigdecimal|long'], ['Distribute remainder', 'remainder|leftover|last.{0,20}absorb'], ['Invariant sum equals total + tests', 'sum|invariant|test']]
}),
Q('lld-09', 'lld', 'lld:decorator', 'Decorator', 'beginner', 'direct', 'How is the Decorator pattern used in Java and Spring, and how does it differ from Proxy?', {
  expected: md`Decorator wraps an object implementing the same interface to **add behaviour** (retry, metrics, caching, masking) and can be stacked: {{new BufferedInputStream(new FileInputStream(f))}}. Spring uses decorator-like wrappers ({{TransactionAwareDataSourceProxy}}, {{HttpServletRequestWrapper}}, {{TaskDecorator}}). **Proxy** has the same structure but its intent is **controlling access** (lazy loading, security, remoting, transactions); Spring AOP proxies are generated and transparent to the client.`,
  explanation: md`Structure is identical; intent and who composes it differ. Decorators are composed explicitly; proxies usually appear transparently via the container.`,
  example: md`~~~java
SmsSender s = new MaskingLoggingSmsSender(new RetryingSmsSender(new SnsSmsSender(sns), 3));
~~~`,
  wrong: md`- Confusing with inheritance-based extension.`,
  followups: [['When would you prefer AOP over hand-written decorators?', 'Cross-cutting concerns across many beans (transactions, metrics) where explicit wrapping is repetitive.']],
  keyPoints: [['Same interface, adds behaviour, stackable', 'same interface|wrap|stack|add (behaviour|behavior|responsib)'], ['Java/Spring example', 'inputstream|wrapper|taskdecorator|java\\.io'], ['Proxy intent: control access', 'control|access|lazy|security|remote'], ['Spring AOP proxies', 'aop|cglib|dynamic proxy']]
}),
Q('lld-10', 'lld', 'lld:payment-processing', 'Payment Processing', 'advanced', 'scenario', 'The call to the card acquirer times out. The client retries the same checkout. How does your payment module avoid a double charge?', {
  expected: md`(1) The API requires an **Idempotency-Key**; the first request inserted an IN_PROGRESS record, so the retry gets either the stored result or 409 while in progress. (2) The payment/attempt was **persisted before** calling the acquirer, and our attempt id is passed as the acquirer's idempotency/reference key, so even a re-sent request cannot create a second charge at the acquirer. (3) A timeout moves the attempt to **UNKNOWN/PENDING**, never FAILED; a resolver queries the acquirer by reference and completes the state. (4) Webhooks are deduped by event id and applied only via legal state transitions.`,
  explanation: md`Timeouts are ambiguous; the safe design converts ambiguity into a reconcilable state instead of guessing. Idempotency must be end-to-end, including the downstream provider.`,
  example: md`See the Payment Processing LLD and the Payment Gateway system design.`,
  wrong: md`- "Treat the timeout as failure and let them retry."
- Idempotency only at our API but a fresh reference sent to the acquirer on retry.`,
  followups: [['What if the resolver also cannot reach the acquirer?', 'Keep retrying with backoff; settlement file reconciliation is the final arbiter; customer sees pending status.']],
  keyPoints: [['Idempotency key with stored response', 'idempot'], ['Persist before external call', 'persist|save|before'], ['Pass id downstream as provider idempotency/reference', 'downstream|acquirer.{0,40}(key|reference|id)|provider.{0,40}(key|reference)'], ['Timeout = unknown/pending resolved by status query', 'unknown|pending|status query|resolv|reconcil'], ['Webhook dedup', 'webhook|dedup']]
}),
Q('lld-11', 'lld', 'lld:rate-limiter-lld', 'Rate Limiter LLD', 'intermediate', 'tradeoff', 'Compare fixed window, sliding window log, sliding window counter and token bucket. Which would you pick for a public API and why?', {
  expected: md`**Fixed window**: O(1), simple, but allows up to 2× bursts at window boundaries. **Sliding window log**: exact, but memory O(limit) per key and expensive at high limits. **Sliding window counter**: O(1), approximates by weighting the previous window's count; good accuracy. **Token bucket**: O(1), allows controlled bursts up to capacity with a sustained refill rate; easy to explain; widely used by gateways. For a public API: token bucket (burst-friendly for real clients, simple quotas, cheap). Use sliding window counter when smooth per-window limits matter.`,
  explanation: md`Algorithm choice is about burst semantics, memory and accuracy. Implementation details (atomicity, eviction of idle keys, monotonic clocks) matter as much.`,
  example: md`See the Rate Limiter LLD for thread-safe implementations, and the Rate Limiter visual lab.`,
  wrong: md`- Picking fixed window without mentioning boundary bursts.
- Claiming the sliding log is cheap.`,
  followups: [['How does a leaky bucket differ from a token bucket?', 'Leaky bucket enforces constant output rate (queue + drain), smoothing bursts; token bucket allows bursts while bounding average.']],
  keyPoints: [['Fixed window boundary burst', 'boundary|2x|double|edge'], ['Sliding log exact but memory-heavy', 'log.{0,60}(memory|exact)|memory.{0,40}log'], ['Sliding counter approximation', 'weight|approximat|previous window'], ['Token bucket bursts + refill', 'token bucket.{0,80}(burst|refill)|refill|capacity'], ['Justified choice', 'choose|pick|prefer|recommend|would use']]
}),
Q('lld-12', 'lld', 'lld:ddd', 'DDD', 'advanced', 'architecture', 'How do you decide aggregate boundaries? Use an e-commerce Order and Customer as the example.', {
  expected: md`An aggregate is a **consistency boundary**: everything that must be consistent within one transaction belongs inside it, with one root enforcing invariants. Order + OrderLines form one aggregate (order total must equal the lines; lines cannot exist alone). Customer is a separate aggregate referenced **by id** ({{customerId}}); changes to customer (address, loyalty) do not need to be atomic with the order. Cross-aggregate rules use domain events and eventual consistency. Keep aggregates small to reduce contention and transaction size.`,
  explanation: md`Large aggregates cause lock contention and loading huge object graphs; too small aggregates push invariants into services. Start with true invariants and transactional needs.`,
  example: md`~~~java
public class Order { private CustomerId customerId; private List<OrderLine> lines; public void addLine(...) { /* enforce max items, recalc total */ } }
~~~`,
  wrong: md`- One aggregate per table.
- Putting Customer inside Order to "make it easy to load".`,
  followups: [['How do you update stock when an order is placed if they are different aggregates?', 'Domain event OrderPlaced handled by inventory (possibly via a saga with reservation); accept eventual consistency or reserve first.']],
  keyPoints: [['Consistency/transaction boundary', 'consisten|transaction|invariant'], ['Order + lines inside, root enforces invariants', 'line|root'], ['Reference other aggregates by id', 'by id|reference|customerid'], ['Eventual consistency via events across aggregates', 'event|eventual'], ['Small aggregates', 'small|contention']]
}),

/* ======================= HLD ======================= */
Q('hld-01', 'hld', 'hld:cap', 'CAP Theorem', 'beginner', 'direct', 'Explain the CAP theorem precisely, and why "CA" is not a real option for distributed databases.', {
  expected: md`During a **network partition**, a distributed store must choose between **consistency** (linearizability: every read sees the latest write or errors) and **availability** (every non-failing node returns a non-error response). Partitions happen in real networks, so the meaningful choice is CP or AP **when partitioned**. "CA" means assuming partitions never happen, which only holds for a single node. Mention **PACELC**: even without partitions, you trade latency vs consistency.`,
  explanation: md`CAP's C is linearizability, not ACID consistency. Real systems are configurable per operation (Cassandra consistency levels, MongoDB read/write concerns).`,
  example: md`Payment ledger: CP (reject rather than risk double-spend). Shopping cart or likes: AP (serve possibly stale data and reconcile).`,
  wrong: md`- "Pick any two of three at all times."
- Confusing CAP consistency with ACID consistency.`,
  followups: [['Is MongoDB CP or AP?', 'Depends on configuration: majority write/read concern with primary reads behaves CP; w:1 and secondary reads can be stale and lose acknowledged writes on failover.']],
  keyPoints: [['Choice only during partition', 'partition'], ['C = linearizability / latest write', 'lineariz|latest write|most recent'], ['A = every non-failing node responds', 'non.?fail|every request|respond'], ['CA not realistic for distributed systems', 'single node|ca.{0,40}(not|impossible|unrealistic)|partitions (are|will) happen'], ['PACELC latency trade-off', 'pacelc|latency']]
}),
Q('hld-02', 'hld', 'hld:caching', 'Caching', 'intermediate', 'scenario', 'After adding Redis cache-aside for product prices, customers sometimes see an old price for up to 10 minutes after an update. Diagnose and fix.', {
  expected: md`Likely causes: (1) the cache is **updated or not invalidated** on write (only TTL expiry refreshes it); (2) the **race**: a reader misses, reads the old DB value, the writer updates DB and deletes the key, then the reader writes the stale value back; (3) invalidation happens **before commit** or in a different service that never learns of the change. Fixes: delete the key **after the DB transaction commits** ({{@TransactionalEventListener(AFTER_COMMIT)}}), short TTL for price data, delayed double delete or version-stamped values, CDC-driven invalidation (Debezium -> Kafka -> invalidator) when multiple writers exist. At checkout, always read price from the source of truth (or a quote) regardless of cache.`,
  explanation: md`Cache-aside is eventually consistent by nature; design for a bounded staleness window and keep critical decisions off the cache.`,
  example: md`~~~java
@TransactionalEventListener(phase = AFTER_COMMIT)
void on(PriceChanged e) { redis.delete("price:" + e.sku()); }
~~~`,
  wrong: md`- "Disable the cache."
- "Update the cache before writing the DB."`,
  followups: [['How do you prevent a stampede when a hot key is deleted?', 'Single-flight per key, short lock with SETNX, serve stale while revalidating, TTL jitter.']],
  keyPoints: [['Invalidate on write (delete, not update)', 'invalidat|delete|evict'], ['Race between reader and writer', 'race|stale value back|repopulat'], ['After commit timing', 'after commit|commit'], ['CDC / events for multiple writers', 'cdc|debezium|event'], ['Critical path reads source of truth', 'checkout|source of truth|quote']]
}),
Q('hld-03', 'hld', 'hld:kafka-rabbit-sqs', 'Kafka', 'intermediate', 'debugging', 'Consumer lag on a Kafka topic keeps growing during peak hours. How do you investigate and fix it?', {
  expected: md`Check: (1) **per-partition lag** distribution: one hot partition means key skew; (2) **processing time per record** (slow DB calls, synchronous HTTP, locks) via metrics/traces; (3) **consumer count vs partitions**: extra consumers are idle, so parallelism is capped by partitions; (4) **rebalance storms** ({{max.poll.interval.ms}} exceeded because batches take too long, causing repeated rebalances); (5) downstream throttling. Fixes: optimise handlers (batching, async I/O, bulk writes), increase partitions (careful: key remapping affects ordering), scale consumers up to partition count, tune {{max.poll.records}}, fix key skew, move slow work to separate topics.`,
  explanation: md`Kafka throughput scales with partitions; lag is usually a consumer-side processing problem, not a broker problem.`,
  example: md`~~~yaml
spring.kafka.consumer.max-poll-records: 200
spring.kafka.listener.concurrency: 6   # <= partitions
~~~`,
  wrong: md`- "Add more consumers" without checking partition count.
- "Increase retention."`,
  followups: [['Why can increasing partitions break ordering?', 'Keys hash to different partitions after the change; events for the same key may be processed out of order across the transition.']],
  keyPoints: [['Per-partition lag / key skew', 'partition.{0,30}(lag|skew|hot)|skew|hot partition'], ['Processing time is the usual cause', 'processing time|slow|db call|handler'], ['Consumers capped by partitions', 'idle|partition count|more consumers than'], ['Rebalance / max.poll.interval', 'rebalanc|max\\.poll'], ['Fixes: batching, partitions, tuning', 'batch|increase partitions|max\\.poll\\.records|concurrency']]
}),
Q('hld-04', 'hld', 'hld:saga', 'Saga', 'advanced', 'architecture', 'Design order placement across Order, Inventory and Payment services without 2PC. What happens when payment fails?', {
  expected: md`Use an **orchestrated saga** (or choreography for few steps): Order creates order PENDING -> Inventory reserves stock (local tx) -> Payment authorises (idempotency key = order id) -> Order confirmed. If payment is declined, the orchestrator issues **compensations** in reverse: release inventory reservation, mark order CANCELLED. Each step and compensation is a local transaction, idempotent and retryable; messages published via **outbox**; saga state persisted; timeouts trigger retry or compensation. Order steps so irreversible actions (capture, shipping) come last. Acknowledge the lack of isolation and use semantic locks (PENDING status).`,
  explanation: md`2PC blocks and couples services' availability; sagas trade isolation for availability and require explicit compensation design.`,
  example: md`See the Saga visual lab to watch compensation run backwards when a step fails.`,
  wrong: md`- "Use @Transactional across services."
- Compensations that are not idempotent.`,
  followups: [['What if the compensation fails?', 'Retry with backoff; it must eventually succeed; if not, move to a FAILED state with alerting and manual resolution.']],
  keyPoints: [['Sequence of local transactions', 'local transaction|step'], ['Compensating actions on failure (release stock)', 'compensat|release|undo'], ['Orchestration vs choreography choice', 'orchestrat|choreograph'], ['Idempotency + outbox for reliable messaging', 'idempot|outbox'], ['Timeouts / persisted saga state', 'timeout|state|persist'], ['Lack of isolation acknowledged', 'isolation|intermediate state|pending']]
}),
Q('hld-05', 'hld', 'hld:circuit-breaker', 'Circuit Breaker', 'intermediate', 'direct', 'How does a circuit breaker work, and how do you choose its thresholds?', {
  expected: md`States: **Closed** (calls pass, outcomes recorded in a sliding window), **Open** (calls fail fast for a wait duration after failure or slow-call rate exceeds a threshold), **Half-open** (a limited number of trial calls; success closes, failure re-opens). Thresholds from data: window type/size relative to traffic, a minimum number of calls to avoid tripping on noise, failure-rate threshold (e.g. 50%), slow-call threshold tied to the latency SLO, wait duration matched to typical recovery time; exclude client errors (4xx/validation) from failures. Combine with timeouts, a fallback and bulkheads.`,
  explanation: md`The breaker protects caller resources and the struggling dependency. Without timeouts it cannot detect slowness; without a fallback, failing fast just moves the error.`,
  example: md`~~~yaml
resilience4j.circuitbreaker.instances.kyc:
  sliding-window-size: 50
  minimum-number-of-calls: 20
  failure-rate-threshold: 50
  slow-call-duration-threshold: 2s
  wait-duration-in-open-state: 30s
~~~`,
  wrong: md`- "It retries the call until it works."
- Counting 400 validation errors as failures.`,
  followups: [['Retry and breaker order?', 'Retry outside the breaker; do not retry CallNotPermittedException.']],
  keyPoints: [['Three states and transitions', 'closed|open|half'], ['Sliding window + failure/slow rate thresholds', 'window|threshold|rate'], ['Minimum calls to avoid noise', 'minimum'], ['Exclude client errors', '4\\d\\d|client error|validation|ignore'], ['Timeouts / fallback', 'timeout|fallback']]
}),
Q('hld-06', 'hld', 'hld:sharding', 'Sharding', 'advanced', 'tradeoff', 'How do you choose a shard key for a multi-tenant SaaS orders table, and what goes wrong with a poor choice?', {
  expected: md`Choose a key with **high cardinality, even distribution, and presence in most queries/transactions**, so most operations are single-shard. For multi-tenant SaaS, {{tenant_id}} keeps a tenant's data together (transactions and queries stay local, easy tenant moves/residency) but large tenants create **hot shards**; mitigate with a **directory** mapping (big tenants get dedicated shards) or composite keys (tenant_id + order_id hash) for very large tenants. Poor choices: monotonically increasing keys (timestamp) with range sharding (all writes hit the newest shard), low-cardinality keys (country), keys absent from queries (scatter-gather everywhere), and cross-shard transactions.`,
  explanation: md`Sharding is hard to undo; resharding requires migration tooling. Prefer vertical scaling/replicas/partitioning first.`,
  example: md`Directory: {{tenant -> shard}} table cached in services; consistent hashing for small tenants.`,
  wrong: md`- "Shard by created_at."
- Ignoring hot tenants.`,
  followups: [['How do you run a report across all tenants?', 'Scatter-gather for small results or, better, CDC into an analytics store.']],
  keyPoints: [['Cardinality/distribution/query alignment', 'cardinality|distribut|even|query'], ['tenant_id locality', 'tenant'], ['Hot shard / big tenant mitigation', 'hot|large tenant|dedicated|directory'], ['Bad keys: monotonic, low cardinality', 'monoton|timestamp|low.?cardinality|sequential'], ['Cross-shard queries/transactions cost', 'cross.?shard|scatter']]
}),
Q('hld-07', 'hld', 'hld:idempotency', 'Idempotency', 'intermediate', 'scenario', 'Two identical POST /payments requests with the same Idempotency-Key arrive 5 ms apart on different pods. What does your implementation do?', {
  expected: md`The first pod **atomically inserts** the key with status IN_PROGRESS and a request hash (unique constraint / {{INSERT ... ON CONFLICT DO NOTHING}} or Redis {{SET NX}}). The second pod's insert fails; it reads the record: IN_PROGRESS -> returns **409 Conflict** (or waits briefly and polls) so the client retries; once COMPLETED, retries receive the **stored response**. A different body with the same key gets 422. Keys are scoped per merchant/user and expire after a retention period.`,
  explanation: md`The atomic claim is what prevents duplicate side effects under concurrency; a read-then-insert check has the same race as any check-then-act.`,
  example: md`See the Idempotency topic for the Spring implementation.`,
  wrong: md`- "Check if the key exists, then process" (race).
- Storing the key only after processing completes.`,
  followups: [['What if the process crashes after charging but before marking COMPLETED?', 'Recovery job checks the provider using the same key/reference and completes the record.']],
  keyPoints: [['Atomic claim (unique constraint / SETNX)', 'atomic|unique|on conflict|setnx|set nx'], ['IN_PROGRESS -> 409 for concurrent duplicate', 'in.?progress|409|conflict'], ['Stored response replay', 'stored response|same response|replay'], ['Request hash mismatch -> 422', 'hash|different body|422'], ['Scope and expiry', 'scope|expir|ttl']]
}),
Q('hld-08', 'hld', 'hld:replication', 'Replication', 'intermediate', 'tradeoff', 'Synchronous vs asynchronous replication for a PostgreSQL primary: what do you choose for a payments database?', {
  expected: md`Payments need **no loss of acknowledged writes** on failover, so use **synchronous (or quorum/semi-sync) replication to at least one standby in another AZ**: commits wait for the standby to confirm WAL durability. Cost: higher commit latency (cross-AZ round trip, typically small within a region) and write availability depends on the standby (use quorum commit with multiple standbys so one slow standby does not block). Cross-region DR replicas stay asynchronous (latency too high) with a stated RPO. Read replicas for reporting are async and must not serve read-after-write paths.`,
  explanation: md`The decision follows the RPO requirement: RPO 0 within a region requires sync; across regions you accept seconds of RPO or use specialised databases.`,
  example: md`{{synchronous_standby_names = 'ANY 1 (standby_b, standby_c)'}}`,
  wrong: md`- "Async is fine because failover is rare."
- Sync replication to another region for every commit without discussing latency.`,
  followups: [['How does Aurora change this?', 'Storage-level quorum (4/6 across 3 AZs) gives durability without classic sync standbys; replicas share storage.']],
  keyPoints: [['RPO / no loss of acknowledged writes', 'rpo|lose|loss|acknowledged'], ['Sync/quorum to standby in another AZ', 'sync|quorum|semi'], ['Latency/availability cost', 'latency|slow|availability|block'], ['Cross-region async DR', 'region|dr|disaster']]
}),
Q('hld-09', 'hld', 'hld:event-driven', 'Event-Driven Architecture', 'advanced', 'debugging', 'The order service saves the order and publishes OrderPlaced to Kafka. Occasionally downstream services never see some orders. Why, and how do you fix it permanently?', {
  expected: md`This is the **dual-write problem**: DB commit and Kafka publish are separate operations; a crash, timeout or Kafka error between them loses the event (or publishes an event for a rolled-back order if published inside the transaction). Fix with the **transactional outbox**: insert the event into an outbox table in the same DB transaction; a relay (Debezium CDC or a poller) publishes to Kafka with retries; consumers are idempotent because the relay is at-least-once. Alternative: event sourcing or listen-to-yourself patterns.`,
  explanation: md`Without a shared transaction across DB and broker, only an atomically written outbox gives you "if the order exists, the event will eventually be published".`,
  example: md`~~~java
@Transactional void place(Order o) { orders.save(o); outbox.save(OutboxEvent.of("OrderPlaced", o)); }
~~~`,
  wrong: md`- "Use KafkaTemplate inside @Transactional" (not atomic with the DB).
- "Retry publishing a few times" (still lost on crash).`,
  followups: [['How do you clean up the outbox table?', 'Delete or partition by time after publish confirmation; with Debezium you can delete immediately since the WAL captured it.']],
  keyPoints: [['Dual-write problem identified', 'dual.?write|two (systems|operations)|not atomic'], ['Transactional outbox in same DB transaction', 'outbox'], ['Relay via CDC/poller', 'cdc|debezium|poll|relay'], ['At-least-once + idempotent consumers', 'at.?least.?once|idempot|duplicate']]
}),
Q('hld-10', 'hld', 'hld:load-balancing', 'Load Balancing', 'intermediate', 'debugging', 'Every deployment causes a short burst of 502/503 errors behind your load balancer. What is happening and how do you fix it?', {
  expected: md`Instances are removed or killed while still receiving traffic, or receive traffic before they are ready. Fixes: **readiness probes** that pass only after warm-up; **graceful shutdown** ({{server.shutdown=graceful}}) so in-flight requests finish; a **preStop delay** in Kubernetes so endpoint removal propagates to the LB/kube-proxy before SIGTERM processing; LB **deregistration delay** longer than the longest request; rolling update settings (maxUnavailable 0, maxSurge); connection draining for keep-alive connections; client retries for idempotent requests.`,
  explanation: md`Endpoint removal and process termination happen concurrently in Kubernetes; without the preStop pause, the pod stops accepting while traffic still arrives.`,
  example: md`~~~yaml
lifecycle: { preStop: { exec: { command: ["sh", "-c", "sleep 10"] } } }
terminationGracePeriodSeconds: 40
~~~`,
  wrong: md`- "Increase the number of replicas" (does not address the race).`,
  followups: [['Why can liveness probes cause outages?', 'If they depend on downstream services, a DB outage restarts all pods in a loop.']],
  keyPoints: [['Readiness probe / warm-up', 'readiness|warm'], ['Graceful shutdown / draining', 'graceful|drain'], ['preStop delay / deregistration delay', 'prestop|deregistration|delay'], ['Rolling update settings', 'rolling|maxunavailable|maxsurge']]
}),
Q('hld-11', 'hld', 'hld:observability', 'Observability', 'intermediate', 'scenario', 'p99 latency for checkout doubled after a release, but the average is unchanged. How do you find the cause?', {
  expected: md`Averages hide tail latency. Steps: (1) compare **latency histograms** by route, instance and version (canary vs baseline); (2) use **exemplars/traces** for slow requests to see which span grew (DB query, downstream call, lock wait); (3) check **resource saturation**: connection-pool wait time, thread pool queueing, GC pauses (JFR / jvm.gc.pause), CPU throttling in containers; (4) diff the release (new query, N+1, removed index, synchronous call added, larger payloads); (5) roll back if SLO burn rate is high, then fix.`,
  explanation: md`Tail latency often comes from contention or rare slow paths that only traces and histograms reveal.`,
  example: md`{{histogram_quantile(0.99, sum by (le, version) (rate(http_server_requests_seconds_bucket{uri="/checkout"}[5m])))}}`,
  wrong: md`- Looking only at average latency or CPU.`,
  followups: [['Why avoid userId as a metric label?', 'High cardinality explodes time-series count and cost; use logs/traces.']],
  keyPoints: [['Histograms/percentiles by version/instance', 'histogram|percentile|p99|by (version|instance|route)'], ['Traces/exemplars for slow requests', 'trace|span|exemplar'], ['Saturation: pools, GC, threads', 'pool|gc|thread|saturat|cpu'], ['Release diff / rollback', 'release|deploy|diff|rollback|canary']]
}),
Q('hld-12', 'hld', 'hld:multi-tenancy', 'Multi-tenancy', 'advanced', 'architecture', 'Pool vs silo tenancy: a regulated bank wants to become a customer of your pooled SaaS. How do you adapt the architecture?', {
  expected: md`Offer a **hybrid model**: keep SMB tenants pooled ({{tenant_id}} + row-level security), and give the bank a **silo** or dedicated tier: dedicated database (or schema), possibly dedicated compute/namespace, in-country region for data residency, customer-managed encryption keys, separate IdP realm/org with their corporate SSO, stricter audit and retention. A **tenant directory/routing layer** maps tenant -> data store/cell so application code stays the same. Operations must support many deployment cells (automation, migrations across all, per-tenant monitoring).`,
  explanation: md`Isolation requirements drive the model; a routing layer lets you mix models without forking code.`,
  example: md`{{TenantRouter.dataSourceFor(tenantId)}} with cells: pooled-cell-1, pooled-cell-2, bank-dedicated-uae.`,
  wrong: md`- "Just add tenant_id and promise isolation" for a regulated customer.
- Forking the codebase per customer.`,
  followups: [['How do you run schema migrations across 200 tenant databases?', 'Automated migration orchestration (Flyway per tenant DB) with canary cells, idempotent migrations and backward-compatible changes.']],
  keyPoints: [['Hybrid pooled + silo', 'hybrid|silo|dedicated'], ['Data residency / encryption keys', 'residen|region|key|kms|encrypt'], ['Routing layer / tenant directory / cells', 'rout|directory|cell'], ['Operational cost of silos', 'operat|migration|cost|automation']]
}),

/* ======================= System Design ======================= */
Q('sd-01', 'sd', 'sd:url-shortener', 'URL Shortener', 'intermediate', 'architecture', 'How would you generate unique short codes for a URL shortener at 200 creations/second across many instances?', {
  expected: md`Use **range-leased counters + base62**: each instance leases a block of IDs (e.g. 1M) from a coordinator (DB sequence row updated atomically, or etcd/ZooKeeper), issues IDs locally, and encodes in base62 (7 chars ≈ 3.5 trillion codes). To avoid enumerable codes, apply a reversible permutation (Feistel/multiplicative modulo) before encoding. Alternatives: hashing the URL and truncating (needs collision handling with unique constraint + retry) or a pre-generated key service. Custom aliases go through a unique constraint.`,
  explanation: md`Leasing removes per-request coordination; the permutation hides volume and prevents scraping by enumeration.`,
  example: md`62^7 = 3,521,614,606,208 codes; at 200/s that lasts centuries.`,
  wrong: md`- UUIDs (too long).
- MD5 truncated without collision handling.`,
  followups: [['What if the coordinator is down?', 'Instances continue with their leased ranges; size leases to cover hours.']],
  keyPoints: [['Base62 encoding', 'base.?62'], ['Counter ranges / unique ID source', 'range|lease|counter|sequence|snowflake'], ['Collision handling for hash approach', 'collision'], ['Non-enumerable codes', 'enumerat|guess|permut|random'], ['Keyspace maths', '62\\^|trillion|billion']]
}),
Q('sd-02', 'sd', 'sd:whatsapp', 'Messaging', 'advanced', 'scenario', 'In a chat system, how do you guarantee a message is not lost and not shown twice when the sender\'s network flaps?', {
  expected: md`Client assigns a **clientMsgId** and keeps the message in a local outbox until acked. Server **dedupes** on (sender device, clientMsgId), **persists** the message (assigning a per-conversation sequence), and only then acks. On reconnect, the client resends unacked messages; dedup returns the existing messageId. Recipient delivery is at-least-once (inbox until DELIVERED receipt) and the recipient client dedupes by messageId. Ordering is by server sequence per conversation.`,
  explanation: md`At-least-once delivery plus idempotency at both ends yields exactly-once display.`,
  example: md`Ack frame: {{ack(clientMsgId, messageId, seq)}}`,
  wrong: md`- "TCP guarantees delivery" (connections drop; app-level acks are needed).
- Exactly-once delivery over the network.`,
  followups: [['How long do you keep dedup state?', 'A window (e.g. days) keyed by device+clientMsgId, sufficient for client retry horizons.']],
  keyPoints: [['Client-generated message id', 'client.?(msg|message)?.?id|client id'], ['Persist before ack', 'persist|store.{0,20}before|before ack'], ['Server dedup', 'dedup|idempot'], ['Resend unacked on reconnect', 'resend|retry|outbox|unack'], ['Recipient dedup / per-conversation sequence', 'sequence|messageid|recipient']]
}),
Q('sd-03', 'sd', 'sd:instagram', 'News Feed', 'advanced', 'tradeoff', 'Fan-out on write vs fan-out on read for a social feed. When do you use each?', {
  expected: md`**Fan-out on write (push)**: on post, insert post id into every follower's timeline cache. Fast reads, expensive writes, wasteful for inactive users, explodes for celebrities. **Fan-out on read (pull)**: at read time, fetch recent posts from followees and merge. Cheap writes, expensive and slow reads for users following many accounts. **Hybrid**: push for normal authors (to active followers only), pull for high-follower accounts merged at read time; ranking after candidate merge.`,
  explanation: md`The workload is read-heavy, so precomputation pays off except where the write amplification is extreme.`,
  example: md`Celebrity threshold chosen by cost (e.g. >100k followers) and adjustable.`,
  wrong: md`- Choosing one model without addressing celebrities or inactive users.`,
  followups: [['How do you show a user their own post immediately?', 'Merge author\'s recent posts at read time (read-your-writes).']],
  keyPoints: [['Push: fast reads, write amplification', 'push|fan.?out on write'], ['Pull: cheap writes, slow reads', 'pull|fan.?out on read'], ['Celebrity problem', 'celebrit|million followers|high.?follower'], ['Hybrid solution', 'hybrid'], ['Inactive users optimisation', 'inactive|active followers']]
}),
Q('sd-04', 'sd', 'sd:distributed-rate-limiter', 'Distributed Rate Limiter', 'intermediate', 'architecture', 'How do you implement a rate limit of 100 requests/minute per API key across 50 gateway instances, and what happens if Redis goes down?', {
  expected: md`Central state in **Redis** with an **atomic Lua script** implementing a token bucket (refill by elapsed time, decrement, set TTL) keyed by API key; each gateway calls it per request (pipelined, with a tight timeout). On Redis failure: **fail-open** for general APIs (with local approximate limiting as a backstop) and **fail-closed** for abuse-sensitive endpoints (OTP, login). Optimisations: local deny cache once a key is over limit, local token allowances synced in batches. Return 429 with Retry-After and RateLimit headers.`,
  explanation: md`Atomicity prevents races between instances; the failure policy is a business decision you should state.`,
  example: md`See the Distributed Rate Limiter design for the Lua script.`,
  wrong: md`- In-memory per-instance counters claiming global accuracy.
- Read then write in two Redis calls (race).`,
  followups: [['How do you enforce limits across regions?', 'Split quota per region and rebalance; global synchronous counters add too much latency.']],
  keyPoints: [['Central Redis store', 'redis'], ['Atomic Lua / single operation', 'lua|atomic|script'], ['Algorithm (token bucket) details', 'token|bucket|refill|window'], ['Fail-open vs fail-closed', 'fail.?open|fail.?closed'], ['429 + headers', '429|retry.?after']]
}),
Q('sd-05', 'sd', 'sd:amazon', 'E-commerce Checkout', 'advanced', 'scenario', 'Flash sale: 100k users try to buy 1,000 units of one SKU. How do you avoid overselling and keep the system up?', {
  expected: md`(1) **Admission control**: virtual waiting room/queue tokens so only a manageable number of users reach checkout; rate limits per user. (2) **Atomic reservation**: conditional decrement ({{UPDATE ... SET reserved = reserved + 1 WHERE available >= 1}}) or Redis Lua decrement with DB reconciliation; split the hot SKU into **stock buckets** to reduce row contention. (3) Reservation with **expiry** during payment; compensation releases stock on payment failure. (4) Cache product pages/CDN, keep the buy path minimal, pre-scale and pre-warm. (5) Idempotent order creation.`,
  explanation: md`Autoscaling alone does not solve contention on a single inventory row; you must limit concurrency at the entry point and make the decrement atomic.`,
  example: md`10 buckets of 100 units each, reserve from a random bucket, try another if empty.`,
  wrong: md`- "Use a distributed lock for the SKU" (serialises everything, lock becomes bottleneck).
- Check stock then decrement in two steps.`,
  followups: [['How do you make the waiting room fair?', 'Randomise positions for early arrivals, FIFO after on-sale, tokens bound to identity.']],
  keyPoints: [['Waiting room / admission control', 'waiting room|queue|admission|throttl'], ['Atomic conditional decrement', 'atomic|conditional|where.{0,40}>=|lua'], ['Hot row mitigation (bucketing)', 'bucket|split|shard.{0,20}stock|contention'], ['Reservation expiry + compensation', 'reserv|expir|release|compensat'], ['Caching / pre-scaling', 'cache|cdn|pre.?scal|warm']]
}),
Q('sd-06', 'sd', 'sd:youtube', 'Video Streaming', 'intermediate', 'direct', 'Why do video platforms transcode into multiple renditions and serve them as small segments via a CDN?', {
  expected: md`Clients have different devices and fluctuating bandwidth. **Multiple renditions** (bitrate ladder across resolutions and codecs) let the player pick quality; **segments** (a few seconds each, HLS/DASH manifests) allow **adaptive bitrate** switching at segment boundaries and make content **cacheable static files** that CDNs can serve close to users, which is the only way to handle the egress volume. Segmenting also enables parallel transcoding and faster processing.`,
  explanation: md`ABR minimises rebuffering; CDN edges reduce latency and origin load.`,
  example: md`Master manifest lists 240p..1080p variant playlists; each lists .ts/.m4s segment URLs.`,
  wrong: md`- Serving one MP4 from the app servers.`,
  followups: [['How do you protect premium segments?', 'DRM encryption with licence servers and short-lived signed URLs.']],
  keyPoints: [['Device/bandwidth diversity', 'device|bandwidth|network'], ['Adaptive bitrate switching', 'adaptive|abr|switch'], ['Segments + manifests (HLS/DASH)', 'segment|hls|dash|manifest'], ['CDN caching for egress', 'cdn|edge|egress|cache'], ['Parallel transcoding', 'parallel']]
}),
Q('sd-07', 'sd', 'sd:uber', 'Ride Booking', 'advanced', 'architecture', 'How do you store and query real-time driver locations for matching?', {
  expected: md`Locations are high-write (every few seconds per driver), ephemeral and queried by proximity. Store them **in memory** in a geo index partitioned by city: geohash/H3/S2 cells -> set of available drivers (or Redis GEO). Update: move driver between cells when it changes cell; last-write-wins by timestamp. Query: look up the pickup cell and neighbouring rings, filter by status/vehicle type, then rank by **ETA** from a routing service rather than straight-line distance. Persist traces asynchronously via Kafka for trips/analytics.`,
  explanation: md`Disk-based spatial indexes would be overwhelmed by update rates; the data can be rebuilt quickly because drivers resend locations continuously.`,
  example: md`1M online drivers / 4 s = 250k updates/s.`,
  wrong: md`- "Store in PostGIS and query ST_DWithin on every request."`,
  followups: [['How do you avoid double-assigning a driver?', 'CAS on driver status (AVAILABLE -> OFFERED) in Redis/DB before sending an offer.']],
  keyPoints: [['High write rate, ephemeral data', 'write|ephemeral|every \\d|update'], ['In-memory geo index (geohash/H3/Redis GEO)', 'geohash|h3|s2|redis geo|grid|cell'], ['Neighbour cell search', 'neighbo|ring|adjacent'], ['ETA-based ranking', 'eta|route|road'], ['Partition by city / async persistence', 'city|region|kafka|async']]
}),
Q('sd-08', 'sd', 'sd:payment-gateway', 'Payment Gateway', 'advanced', 'tradeoff', 'Why do payment systems use a double-entry ledger instead of just updating a balance column?', {
  expected: md`A double-entry ledger records every money movement as **balanced debits and credits** in an **append-only** log. Benefits: auditability (every balance explained by entries), error detection (sum of debits must equal credits per transaction), no destructive updates (corrections are new entries), easier reconciliation with external statements, and support for complex flows (fees, refunds, chargebacks, holds). Balances can still be maintained as snapshots for performance, verified against entries.`,
  explanation: md`Regulators and auditors expect it, and it turns silent corruption into detectable imbalances.`,
  example: md`Capture AED 100 with 2% fee: Dr customer_funds 100 / Cr merchant_balance 98 / Cr fee_revenue 2.`,
  wrong: md`- "Ledger is just a log table."`,
  followups: [['How do you compute a balance quickly?', 'Snapshot balance updated in the same transaction as entries, periodically verified.']],
  keyPoints: [['Balanced debits and credits', 'debit.{0,30}credit|balanced'], ['Append-only / immutable', 'append|immutable|never update|correction'], ['Auditability / reconciliation', 'audit|reconcil'], ['Error detection invariant', 'invariant|detect|sum'], ['Balance snapshots for performance', 'snapshot|derive|performance']]
}),
Q('sd-09', 'sd', 'sd:google-drive', 'File Storage', 'advanced', 'scenario', 'Two devices edit the same file offline and sync later. What does your file storage system do?', {
  expected: md`Uploads commit against a **base version** (optimistic concurrency). The first commit succeeds and becomes the new version; the second fails the version check. Instead of overwriting (data loss), the system saves it as a **conflicted copy** (e.g. "report (Kartik's laptop conflicted copy).docx") and notifies the user; both versions remain in history. For real-time collaborative formats, use OT/CRDT-based merging instead.`,
  explanation: md`Never losing user data outweighs convenience; last-writer-wins silently destroys work.`,
  example: md`{{POST /commit { fileId, baseVersion: 7, chunks: [...] }}} -> 409 if current version is 8.`,
  wrong: md`- Last writer wins.`,
  followups: [['How does the second device learn about the conflict?', 'Commit response 409; client creates the conflicted copy and syncs both.']],
  keyPoints: [['Optimistic concurrency with base version', 'version|optimistic|base'], ['Conflicted copy instead of overwrite', 'conflict(ed)? copy|copy|keep both'], ['No data loss / history', 'loss|history|both versions'], ['Collaborative alternative OT/CRDT', 'crdt|operational transform|ot\\b']]
}),
Q('sd-10', 'sd', 'sd:notification-platform', 'Notification Platform', 'intermediate', 'architecture', 'How do you ensure OTP messages are not delayed when a 5-million-recipient marketing campaign is running?', {
  expected: md`**Isolate priorities**: separate topics/queues and consumer groups for critical (OTP), normal and bulk traffic with **reserved capacity** for critical workers; throttle campaigns with token buckets per provider; separate provider accounts/sender IDs or routes for transactional vs promotional SMS; monitor OTP latency and verification rate as the SLI; failover providers for critical traffic.`,
  explanation: md`Kafka/SQS have no per-message priority that preempts a backlog; physical separation is the dependable way.`,
  example: md`Topics: notif.critical (12 partitions, dedicated consumers), notif.bulk (throttled).`,
  wrong: md`- "Add a priority field to the message."`,
  followups: [['What if the SMS provider is the bottleneck?', 'Separate accounts/throughput for transactional traffic; route OTP via a second provider or WhatsApp.']],
  keyPoints: [['Separate queues/topics per priority', 'separate|priority (queue|topic)|lane'], ['Dedicated consumers/capacity', 'dedicated|reserved|isolat'], ['Throttle campaigns', 'throttl|rate'], ['Provider separation / failover', 'provider|failover|route'], ['Monitor OTP latency SLI', 'monitor|sli|latency|verification rate']]
}),
Q('sd-11', 'sd', 'sd:banking', 'Banking', 'advanced', 'debugging', 'Two concurrent transfers between the same pair of accounts in opposite directions occasionally deadlock. Explain and fix.', {
  expected: md`Transfer A->B locks A then B; transfer B->A locks B then A; each waits for the other: **lock-order inversion**. The database detects the deadlock and aborts one transaction (error to the client). Fix: **lock accounts in a deterministic global order** (e.g. sorted by account id) regardless of transfer direction, keep transactions short, and retry on deadlock errors with backoff. Alternatively use single-statement conditional updates that avoid multi-row read-then-write patterns.`,
  explanation: md`Deterministic ordering breaks the circular wait condition.`,
  example: md`{{SELECT * FROM account WHERE id IN (:a, :b) ORDER BY id FOR UPDATE}}`,
  wrong: md`- "Increase the lock timeout."`,
  followups: [['How do you handle hot accounts like a merchant settlement account?', 'Sub-accounts, batched postings, or append-only postings with periodic balance aggregation.']],
  keyPoints: [['Lock-order inversion / circular wait', 'order|circular|opposite|inversion'], ['Deterministic lock ordering', 'sort|deterministic|consistent order|order by'], ['Retry on deadlock', 'retry'], ['Short transactions', 'short']]
}),
Q('sd-12', 'sd', 'sd:search-autocomplete', 'Autocomplete', 'intermediate', 'direct', 'How do you return top-10 autocomplete suggestions in a few milliseconds?', {
  expected: md`Precompute: build a **trie** (or prefix -> list map) from aggregated query logs, storing the **top-K suggestions at each node**, so a lookup is O(prefix length) plus returning a cached list. Serve from **memory** on replicated (or prefix-sharded) servers loaded from snapshots built offline; merge a **trending overlay** from streaming counts; cache common short prefixes at the CDN/browser; debounce on the client.`,
  explanation: md`Computing top-K at query time would traverse large subtrees; precomputation trades build time and memory for latency.`,
  example: md`Node "bur" -> ["burj khalifa", "burj al arab", "burger king near me", ...]`,
  wrong: md`- "Run a LIKE 'prefix%' SQL query per keystroke."`,
  followups: [['How do suggestions stay fresh?', 'Periodic snapshot rebuilds plus a streaming trending layer with time decay.']],
  keyPoints: [['Trie / prefix index', 'trie|prefix'], ['Top-K precomputed per node', 'top.?k|precomput'], ['In-memory serving + snapshots', 'memory|snapshot'], ['Offline aggregation of logs', 'log|aggregat|batch'], ['Client debounce / caching', 'debounce|cache|cdn']]
}),

/* ======================= Java / Spring ======================= */
Q('java-01', 'java', 'java:transactions', 'Spring Transactions', 'intermediate', 'debugging', 'A @Transactional method in a service calls another @Transactional(propagation = REQUIRES_NEW) method in the same class, but the inner work is not committed separately. Why?', {
  expected: md`**Self-invocation bypasses the Spring proxy.** Transactions are applied by an AOP proxy around the bean; calling {{this.inner()}} goes directly to the target object, so the REQUIRES_NEW advice never runs and the inner work joins the outer transaction. Fixes: move the inner method to another bean, inject the bean's own proxy (ObjectProvider / self-injection), or use {{TransactionTemplate}} with {{PROPAGATION_REQUIRES_NEW}} programmatically.`,
  explanation: md`Same root cause affects {{@Async}}, {{@Cacheable}}, {{@Retryable}}. Private/final methods are also not advised.`,
  example: md`~~~java
@Service class AuditService { @Transactional(propagation = REQUIRES_NEW) public void log(Event e) { ... } }
@Service class OrderService { private final AuditService audit; @Transactional public void place(...) { ...; audit.log(e); } }
~~~`,
  wrong: md`- "REQUIRES_NEW does not work with JPA."
- "Add @EnableTransactionManagement."`,
  followups: [['What happens if the inner method throws and the outer catches it, with REQUIRED?', 'The shared transaction is marked rollback-only; outer commit throws UnexpectedRollbackException.']],
  keyPoints: [['Proxy-based AOP', 'proxy|aop'], ['Self-invocation bypasses proxy', 'self.?invo|this\\.|same class|internal call'], ['Fix: separate bean / self-proxy / TransactionTemplate', 'another bean|separate|transactiontemplate|self.?inject|objectprovider'], ['Also affects @Async/@Cacheable or private methods', 'async|cacheable|private']]
}),
Q('java-02', 'java', 'java:n-plus-one', 'N+1 Problem', 'intermediate', 'debugging', 'An endpoint listing 50 orders with their lines executes 51 SQL queries. Explain and give three fixes, including one that works with pagination.', {
  expected: md`Classic **N+1**: one query loads orders, then each lazy {{lines}} collection is initialised separately (often during JSON serialisation). Fixes: (1) **fetch join** or {{@EntityGraph}} to load lines with orders; (2) **batch fetching** ({{hibernate.default_batch_fetch_size}} / {{@BatchSize}}) turning N queries into a few IN queries; (3) **DTO projection** tailored to the endpoint. With pagination, avoid fetch-joining collections with {{Pageable}} (Hibernate paginates in memory); instead page over order ids, then load lines for those ids in one query (or rely on batch fetching).`,
  explanation: md`Detect with SQL logging/statement count assertions in tests; set {{open-in-view=false}} so lazy loading outside transactions fails loudly.`,
  example: md`~~~java
@EntityGraph(attributePaths = "lines") List<Order> findByIdIn(List<UUID> ids);
~~~`,
  wrong: md`- "Make the association EAGER" (causes N+1 elsewhere and over-fetching).`,
  followups: [['How do you prevent regressions?', 'Integration tests asserting query counts (datasource-proxy / Hypersistence utils).']],
  keyPoints: [['Explains lazy loading per row', 'lazy|each order|per (row|order)|n\\+1'], ['Fetch join / entity graph', 'join fetch|fetch join|entitygraph|entity graph'], ['Batch fetching', 'batch'], ['DTO projection', 'projection|dto'], ['Pagination caveat (ids first)', 'paginat|in memory|ids first|page']]
}),
Q('java-03', 'java', 'java:jmm', 'Java Memory Model', 'advanced', 'direct', 'What does volatile guarantee, and why is "volatile int counter; counter++" still broken?', {
  expected: md`volatile guarantees **visibility** (a write is visible to subsequent reads by other threads) and **ordering** (establishes happens-before; prevents certain reorderings around the access). It does **not** make compound actions atomic: {{counter++}} is read, add, write; two threads can read the same value and both write value+1 (lost update). Use {{AtomicInteger}}/{{LongAdder}} (CAS-based) or a lock.`,
  explanation: md`volatile is perfect for flags and safe publication of immutable objects; atomicity of read-modify-write needs CAS or mutual exclusion.`,
  example: md`~~~java
private final LongAdder hits = new LongAdder(); hits.increment();
~~~`,
  wrong: md`- "volatile makes the variable thread-safe."`,
  followups: [['LongAdder vs AtomicLong?', 'LongAdder spreads contention across cells, much faster under high contention; sum() is not an atomic snapshot.']],
  keyPoints: [['Visibility', 'visib'], ['Happens-before / ordering', 'happens.?before|order|reorder'], ['Not atomic: read-modify-write', 'atomic|read.?modify|lost update'], ['Atomic/LongAdder/lock fix', 'atomicinteger|longadder|atomic|lock|synchron']]
}),
Q('java-04', 'java', 'java:executor-service', 'Thread Pools', 'intermediate', 'code-review', 'Code review: "ExecutorService pool = Executors.newFixedThreadPool(50);" used to call a slow partner API for every incoming request. What concerns do you raise?', {
  expected: md`(1) {{newFixedThreadPool}} uses an **unbounded LinkedBlockingQueue**: during a partner slowdown tasks pile up until OOM, and latency grows without bound. (2) No **timeouts** on the partner call, so threads hang. (3) No **rejection policy/backpressure**, no thread naming, no metrics. (4) Missing **shutdown** handling. Recommend: explicit {{ThreadPoolExecutor}} with a bounded queue and a rejection policy (fail fast with 503 or CallerRuns), timeouts, circuit breaker/bulkhead (Resilience4j), MDC/trace propagation via a TaskDecorator, and Micrometer executor metrics; or virtual threads with a semaphore bulkhead.`,
  explanation: md`Thread pools are resource boundaries; unbounded queues hide overload until it is catastrophic.`,
  example: md`~~~java
new ThreadPoolExecutor(20, 50, 60, SECONDS, new ArrayBlockingQueue<>(200), namedFactory, new AbortPolicy());
~~~`,
  wrong: md`- "Increase to 500 threads."`,
  followups: [['How do you size it?', 'Throughput × latency (Little\'s law), capped by partner rate limits; validate with load tests.']],
  keyPoints: [['Unbounded queue OOM / latency', 'unbounded|linkedblockingqueue|oom|memory'], ['Timeouts missing', 'timeout'], ['Bounded queue + rejection policy', 'bounded|reject|abortpolicy|callerruns'], ['Bulkhead/circuit breaker', 'bulkhead|circuit'], ['Metrics/naming/context propagation', 'metric|name|mdc|taskdecorator|trace']]
}),
Q('java-05', 'java', 'java:spring-security', 'Spring Security', 'advanced', 'scenario', 'Your Spring Boot API accepts Keycloak JWTs. A token issued for a different client/API is accepted by your service. What is missing?', {
  expected: md`**Audience validation**. Spring's issuer-based decoder validates signature, issuer and timestamps, but you must also verify that {{aud}} contains your API (Boot 3.1+: {{spring.security.oauth2.resourceserver.jwt.audiences}} or a custom {{OAuth2TokenValidator}}). In Keycloak, add an **Audience mapper** (client scope) so tokens intended for your API carry {{aud=orders-api}}, and restrict roles in tokens (full scope off). Also verify token type (access token, not ID token) and check scopes/roles per endpoint.`,
  explanation: md`Without audience checks, any valid token from the same issuer (another app's) can be replayed to your API (confused deputy / token substitution).`,
  example: md`~~~yaml
spring.security.oauth2.resourceserver.jwt.audiences: orders-api
~~~`,
  wrong: md`- "The signature is valid so it's fine."`,
  followups: [['Where do Keycloak roles appear in the token?', 'realm_access.roles and resource_access.<client>.roles; map them with a JwtAuthenticationConverter.']],
  keyPoints: [['Audience (aud) validation missing', 'aud'], ['Keycloak audience mapper / client scope', 'mapper|client scope'], ['Token type / scopes checks', 'scope|token type|id token'], ['Confused deputy / substitution risk', 'substitut|replay|another (client|api)|confused']]
}),
Q('java-06', 'java', 'java:connection-pooling', 'Connection Pooling', 'intermediate', 'debugging', 'Under load, requests fail with "HikariPool-1 - Connection is not available, request timed out after 30000ms". How do you diagnose and fix?', {
  expected: md`The pool is exhausted: connections are held too long or there are too few for the load. Diagnose with Hikari metrics (active, idle, pending, acquire time), leak detection logs, thread dumps and traces: look for **remote calls inside @Transactional**, Open Session In View holding connections, slow queries/lock waits, connection leaks in manual JDBC, or virtual threads creating unbounded concurrency. Fix the holding pattern first (short transactions, no I/O inside them, {{open-in-view=false}}, query tuning), size the pool via Little's law within DB limits across all pods, lower {{connection-timeout}} to fail fast, and add bulkheads.`,
  explanation: md`Increasing the pool blindly can overload the database and reduce throughput.`,
  example: md`{{leak-detection-threshold: 20000}} logs stack traces of connections held > 20s.`,
  wrong: md`- "Set maximumPoolSize to 500."`,
  followups: [['40 pods × 20 connections exceeds Postgres max_connections. Options?', 'Smaller pools, PgBouncer/RDS Proxy transaction pooling, or fewer, larger pods.']],
  keyPoints: [['Pool exhaustion / connections held too long', 'exhaust|held|hold'], ['Metrics/leak detection/thread dumps', 'metric|leak|pending|thread dump|trace'], ['Remote calls in transactions / OSIV', 'transaction|open.?in.?view|osiv|remote|http'], ['Sizing via Little\'s law within DB limits', 'little|max_connections|db limit|size'], ['Fail fast timeout / bulkhead', 'timeout|bulkhead|fail fast']]
}),
Q('java-07', 'java', 'java:gc', 'Garbage Collection', 'advanced', 'scenario', 'A Spring Boot service is OOMKilled in Kubernetes even though the heap never exceeds -Xmx. Why?', {
  expected: md`The container limit covers **total process memory**, not just heap: metaspace, thread stacks (many threads × ~1 MB), code cache, **direct buffers** (Netty, NIO), GC overhead structures, and native allocations (libraries, glibc arenas). If {{-Xmx}} is set close to the container limit, non-heap usage pushes RSS over the limit and the kernel kills the pod (OOMKilled, no Java OOM). Fix: use {{-XX:MaxRAMPercentage=~70-75}}, cap direct memory ({{-XX:MaxDirectMemorySize}}), limit thread counts, monitor native memory (NMT: {{-XX:NativeMemoryTracking=summary}}, jcmd VM.native_memory), consider {{MALLOC_ARENA_MAX}}.`,
  explanation: md`A Java OutOfMemoryError is thrown by the JVM; OOMKilled is the kernel enforcing cgroup limits.`,
  example: md`~~~bash
JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75 -XX:NativeMemoryTracking=summary"
~~~`,
  wrong: md`- "There must be a heap leak."`,
  followups: [['How do you tell heap leaks from native leaks?', 'Heap after GC trending up -> heap leak; RSS growing while heap stable -> native (NMT, direct buffers, threads).']],
  keyPoints: [['Container limit = total process memory', 'total|process|rss|non.?heap|container limit'], ['Non-heap areas listed (metaspace, threads, direct buffers)', 'metaspace|stack|direct|native|code cache'], ['MaxRAMPercentage headroom', 'maxrampercentage|headroom|75'], ['NMT / diagnosis', 'nmt|native memory tracking|jcmd']]
}),
Q('java-08', 'java', 'java:completable-future', 'CompletableFuture', 'intermediate', 'code-review', 'Code review: supplyAsync(() -> restClient.call()) is used without an executor to call 5 services in parallel in a web request. What is the problem?', {
  expected: md`Without an executor, {{supplyAsync}} uses {{ForkJoinPool.commonPool()}}, sized for CPU-bound work (cores - 1). Blocking HTTP calls there **starve the common pool**, which is also used by parallel streams and other async code, causing latency spikes across the app. Provide a dedicated bounded executor (or virtual threads executor), add timeouts ({{orTimeout}}/{{completeOnTimeout}}), handle exceptions with fallbacks, and propagate context (MDC, tracing, security).`,
  explanation: md`Common-pool starvation is a frequent production surprise because it couples unrelated code paths.`,
  example: md`~~~java
var ex = Executors.newVirtualThreadPerTaskExecutor();
supplyAsync(() -> client.call(), ex).orTimeout(500, MILLISECONDS);
~~~`,
  wrong: md`- "CompletableFuture is non-blocking so it's fine."`,
  followups: [['thenApply vs thenCompose?', 'thenCompose flattens a function that returns a CompletableFuture.']],
  keyPoints: [['Common ForkJoinPool default', 'commonpool|common pool|forkjoin'], ['Blocking I/O starves it', 'block|starv'], ['Dedicated executor / virtual threads', 'executor|virtual'], ['Timeouts and error handling', 'timeout|exceptionally|handle|fallback'], ['Context propagation', 'mdc|context|trace']]
}),
Q('java-09', 'java', 'java:isolation-levels', 'Isolation Levels', 'advanced', 'tradeoff', 'With PostgreSQL READ COMMITTED, how do you prevent lost updates on a wallet balance? Compare options.', {
  expected: md`Options: (1) **Atomic conditional UPDATE** ({{SET balance = balance - :amt WHERE id = :id AND balance >= :amt}}): simplest, no read-modify-write in Java, one round trip. (2) **Optimistic locking** ({{@Version}}): good when conflicts are rare; losers retry or get 409. (3) **Pessimistic locking** ({{SELECT ... FOR UPDATE}}): serialises access to the row; good under high contention for short transactions; watch deadlocks (lock order). (4) **REPEATABLE READ/SERIALIZABLE**: Postgres detects conflicts and aborts with serialization errors; requires retry logic. Choose by contention and complexity; for wallets, conditional update or FOR UPDATE with a ledger insert in the same transaction.`,
  explanation: md`Isolation level alone at READ COMMITTED does not prevent lost updates for read-modify-write in application code.`,
  example: md`~~~java
@Modifying @Query("update Wallet w set w.balance = w.balance - :a where w.id = :id and w.balance >= :a") int debit(UUID id, long a);
~~~`,
  wrong: md`- "READ COMMITTED prevents lost updates."`,
  followups: [['What is write skew?', 'Two transactions read overlapping data and update different rows breaking an invariant; needs SERIALIZABLE or explicit locks/constraints.']],
  keyPoints: [['Atomic conditional update', 'conditional|atomic|balance - |where.{0,40}>='], ['Optimistic @Version', 'optimistic|@version|version'], ['Pessimistic FOR UPDATE', 'for update|pessimistic'], ['Serializable + retry', 'serializ|retry'], ['Choice by contention', 'contention|conflict|rare|hot']]
}),
Q('java-10', 'java', 'java:mvc-lifecycle', 'Spring MVC', 'beginner', 'direct', 'Walk through what happens inside Spring Boot from the moment an HTTP request hits Tomcat until your controller method runs.', {
  expected: md`Tomcat's connector accepts the connection and a worker thread (or virtual thread) handles the request -> **servlet filter chain** runs (including Spring Security's {{FilterChainProxy}}: authentication, authorization, CORS, tracing) -> **DispatcherServlet** -> **HandlerMapping** finds the controller method -> **HandlerInterceptor.preHandle** -> **HandlerAdapter** resolves arguments ({{@PathVariable}}, {{@RequestBody}} via HttpMessageConverter/Jackson, {{@Valid}} validation) -> controller method executes (calls services through proxies, e.g. @Transactional) -> return value written by message converters -> postHandle/afterCompletion -> exceptions mapped by {{@ControllerAdvice}} to responses.`,
  explanation: md`Knowing the order tells you where to put cross-cutting logic and why certain exceptions are handled where they are.`,
  example: md`Try the Spring Request Lifecycle visual lab and toggle "missing token" or "validation error".`,
  wrong: md`- Skipping the filter chain or putting security after the controller.`,
  followups: [['Why does an exception in a filter not reach @ControllerAdvice?', 'It occurs before DispatcherServlet handler execution; handle in the filter or error controller.']],
  keyPoints: [['Tomcat thread', 'tomcat|thread|connector'], ['Filter chain incl. Spring Security', 'filter'], ['DispatcherServlet + HandlerMapping', 'dispatcherservlet|handlermapping|handler mapping'], ['Argument resolution, message converters, validation', 'argument|converter|jackson|@valid|validation'], ['Interceptors / ControllerAdvice', 'interceptor|controlleradvice|exception']]
}),
Q('java-11', 'java', 'java:bean-lifecycle', 'Bean Lifecycle', 'intermediate', 'direct', 'Describe the Spring bean lifecycle and where AOP proxies are created.', {
  expected: md`Instantiate -> inject dependencies -> Aware callbacks -> {{BeanPostProcessor.postProcessBeforeInitialization}} -> {{@PostConstruct}} -> {{afterPropertiesSet}} -> custom init -> {{postProcessAfterInitialization}} (**AOP proxies created here** by auto-proxy creators) -> bean ready; SmartLifecycle start after refresh; on shutdown SmartLifecycle stop, {{@PreDestroy}}, {{destroy}}. Consequence: inside {{@PostConstruct}} you are working with the raw target, so proxy-based features (transactions on self-calls, async) are not applied there.`,
  explanation: md`Use ApplicationReadyEvent or SmartLifecycle for work that needs the fully initialised, proxied context.`,
  example: md`~~~java
@EventListener(ApplicationReadyEvent.class) public void warmUp() { ... }
~~~`,
  wrong: md`- "Proxies are created at instantiation."`,
  followups: [['Difference between BeanFactoryPostProcessor and BeanPostProcessor?', 'BFPP modifies bean definitions before instantiation; BPP modifies bean instances.']],
  keyPoints: [['Instantiate and inject', 'instantiat|inject|constructor'], ['@PostConstruct / init callbacks', 'postconstruct|afterpropertiesset|init'], ['BeanPostProcessor before/after', 'beanpostprocessor|post.?process'], ['Proxies created after initialization', 'after.?initiali|proxy'], ['Destroy callbacks', 'predestroy|destroy|shutdown']]
}),
Q('java-12', 'java', 'java:multithreading', 'Virtual Threads', 'advanced', 'tradeoff', 'Should your team enable virtual threads in a Spring Boot 3.3 service that calls Postgres and two REST APIs? What could go wrong?', {
  expected: md`For I/O-bound request-per-thread code, virtual threads usually increase throughput and simplify code ({{spring.threads.virtual.enabled=true}}). Risks: **pinning** of carrier threads when blocking inside {{synchronized}} blocks or native frames (pre-JDK 24), large **ThreadLocal** usage per request multiplied by many threads, and the fact that **downstream resources stay limited**: thousands of concurrent requests will queue on a 20-connection Hikari pool or hit partner rate limits, so add semaphores/bulkheads and timeouts. Validate with load tests and JFR pinning events ({{jdk.VirtualThreadPinned}}).`,
  explanation: md`Virtual threads remove the thread bottleneck, exposing the next bottleneck.`,
  example: md`~~~bash
java -Djdk.tracePinnedThreads=full -jar app.jar   # diagnose pinning (older JDKs)
~~~`,
  wrong: md`- "Virtual threads make CPU-bound code faster."`,
  followups: [['Do you still need thread pools?', 'Not for I/O concurrency, but you need concurrency limits (semaphores) for scarce resources.']],
  keyPoints: [['Benefit for I/O-bound workloads', 'i/o|blocking|throughput'], ['Pinning with synchronized/native', 'pin'], ['Downstream limits: DB pool, rate limits', 'pool|connection|downstream|rate limit'], ['Bulkheads/semaphores', 'semaphore|bulkhead|limit'], ['Measure with load tests/JFR', 'load test|jfr|measure']]
}),

/* ======================= IAM ======================= */
Q('iam-01', 'iam', 'iam:pkce', 'PKCE', 'intermediate', 'direct', 'Explain the Authorization Code flow with PKCE and the attack it prevents.', {
  expected: md`The client generates a random **code_verifier**, sends **code_challenge = BASE64URL(SHA256(verifier))** with {{code_challenge_method=S256}} in the authorize request. The authorization server binds the challenge to the issued code. At token exchange, the client sends the verifier; the server hashes and compares. It prevents **authorization code interception/injection**: a malicious app or attacker who steals the code (custom scheme hijack, logs) cannot redeem it without the verifier. Used for public clients (SPA, mobile) and recommended for all clients in OAuth 2.1, along with {{state}} for CSRF and {{nonce}} for ID token replay.`,
  explanation: md`PKCE replaces the client secret's role for public clients in proving that the token requester initiated the flow.`,
  example: md`See the OAuth visual lab: toggle "attacker intercepts code" to see the token endpoint reject it.`,
  wrong: md`- "PKCE encrypts the token."
- Using {{plain}} method in production.`,
  followups: [['Why use the system browser on mobile?', 'Embedded WebViews let the app capture credentials and break SSO; AppAuth with system browser is the standard.']],
  keyPoints: [['code_verifier and code_challenge (S256 hash)', 'verifier|challenge|sha.?256|s256'], ['Server compares at token exchange', 'token (endpoint|exchange|request)|compare|hash'], ['Prevents code interception', 'intercept|steal|stolen|inject'], ['Public clients / OAuth 2.1 for all', 'public client|spa|mobile|2\\.1'], ['state / nonce mentioned', 'state|nonce']]
}),
Q('iam-02', 'iam', 'iam:access-refresh', 'Tokens', 'intermediate', 'tradeoff', 'Why are access tokens short-lived while refresh tokens are long-lived, and how does refresh token rotation detect theft?', {
  expected: md`Access tokens are presented to many APIs and validated locally (stateless JWTs), so they cannot be easily revoked: short lifetime bounds the damage window. Refresh tokens are only sent to the authorization server, which checks them centrally and can revoke them, so they can live longer. **Rotation**: each refresh returns a new refresh token and invalidates the previous; if an old token is presented again (an attacker or the victim using a stolen copy), the server detects **reuse** and revokes the whole token family/session, forcing re-authentication.`,
  explanation: md`It is a balance between revocation latency, load on the AS, and UX.`,
  example: md`Keycloak: Revoke Refresh Token ON, Max Reuse 0; access token 5 min; SSO idle 30 min.`,
  wrong: md`- "Refresh tokens can be sent to APIs."`,
  followups: [['How do multiple tabs refreshing concurrently interact with rotation?', 'Race causes reuse detection; use single-flight refresh, grace periods, or a BFF.']],
  keyPoints: [['Access token short: bounded exposure, hard to revoke', 'revoke|exposure|window|stateless'], ['Refresh token checked centrally by AS', 'authorization server|central|only sent'], ['Rotation issues new, invalidates old', 'rotat|new refresh|invalidat'], ['Reuse detection revokes family', 'reuse|family|revoke']]
}),
Q('iam-03', 'iam', 'iam:custom-authenticator', 'Keycloak Authenticators', 'advanced', 'architecture', 'Describe how you would implement SMS OTP as a second factor in Keycloak using a local UAE SMS aggregator.', {
  expected: md`Implement a custom **Authenticator** + **AuthenticatorFactory** (SPI) packaged as a provider jar. In {{authenticate()}}: read the user's verified phone, generate a cryptographically random code, store its **hash and expiry in authentication session notes**, send via an {{SmsGateway}} abstraction (aggregator adapter with timeouts and failover), and render a FreeMarker form. In {{action()}}: check expiry, attempt count (cap ~5), constant-time hash comparison, then {{context.success()}} or {{failureChallenge}}. Make it configurable (length, TTL, provider) via authenticator config, add it to a **conditional sub-flow** after username/password (e.g. only for certain roles/LoA or new devices), add resend cooldown and rate limits against SMS pumping, localise templates (Arabic/English), never log codes, and emit events for audit. Test with Testcontainers Keycloak.`,
  explanation: md`Auth notes scope state to the login attempt; flows provide the orchestration without custom endpoints.`,
  example: md`See the Custom Authenticators topic for full code.`,
  wrong: md`- Storing OTP in user attributes.
- Implementing OTP as a separate REST service outside the login flow without binding to the auth session.`,
  followups: [['How do you implement step-up only for sensitive operations?', 'Map acr/LoA levels in a conditional flow; client requests acr_values; API checks acr claim.']],
  keyPoints: [['Authenticator + Factory SPI, provider jar', 'authenticator|factory|spi|provider'], ['authenticate() generates/sends, action() verifies', 'authenticate\\(|action\\(|verify'], ['Auth session notes, hashed code, expiry', 'auth.?note|session note|hash|expir'], ['Attempt limits / rate limiting / pumping', 'attempt|rate.?limit|pumping|cooldown'], ['Conditional flow placement', 'conditional|flow|sub.?flow']]
}),
Q('iam-04', 'iam', 'iam:jwt', 'JWT', 'intermediate', 'code-review', 'Code review: a service validates JWTs by decoding the payload and checking exp, using a shared HS256 secret copied to 12 microservices. What are the problems?', {
  expected: md`(1) If it only decodes without **verifying the signature**, anyone can forge tokens. (2) **HS256 shared secret across 12 services** means any compromised service can mint valid tokens for all others; secret rotation is painful. Use asymmetric signing (RS256/ES256) by the IdP, with services verifying via **JWKS** (cached, refresh on unknown {{kid}}). (3) Must validate **iss, aud**, exp/nbf with small skew, allowed algorithms (reject {{none}} and alg confusion). (4) Authorization (scopes/roles, object-level) still needed after authentication. Use Spring Security's resource server rather than hand-rolled parsing.`,
  explanation: md`Symmetric keys conflate verification and issuance capabilities.`,
  example: md`{{spring.security.oauth2.resourceserver.jwt.issuer-uri}} + audiences.`,
  wrong: md`- "Base64 decoding the token is validation."`,
  followups: [['How do you rotate signing keys?', 'Publish new key in JWKS, start signing with it, keep old key until all its tokens expire.']],
  keyPoints: [['Signature verification required', 'signature|verify|forge'], ['Shared HS256 secret risk', 'hs256|shared secret|symmetric|mint'], ['Asymmetric + JWKS', 'rs256|es256|asymmetric|jwks|public key'], ['Validate iss/aud/alg', 'iss|aud|alg|none'], ['Use framework resource server', 'spring security|resource server|library']]
}),
Q('iam-05', 'iam', 'iam:lambda-triggers', 'Cognito Lambda Triggers', 'advanced', 'scenario', 'You must migrate 2 million users from a legacy MySQL user table to Cognito without forcing password resets. How?', {
  expected: md`Use the **User Migration Lambda trigger** for lazy migration: when an unknown user signs in, Cognito invokes the Lambda with username and password; the Lambda verifies against the legacy hash (bcrypt/PBKDF2) and, if valid, returns user attributes with {{finalUserStatus = CONFIRMED}} and {{messageAction = SUPPRESS}}; Cognito creates the user with that password. The trigger also handles forgot-password for unmigrated users. Complement with a **bulk import** (CSV import job) of profiles for users who will not log in soon (they will need a reset), monitor migration progress, and eventually decommission the legacy store. Keep the Lambda fast (Cognito timeout ~5s), secure DB access (VPC, Secrets Manager), and rate-limit to protect the legacy DB.`,
  explanation: md`Lazy migration preserves credentials without ever exporting plaintext passwords or incompatible hashes.`,
  example: md`Trigger events: {{UserMigration_Authentication}}, {{UserMigration_ForgotPassword}}.`,
  wrong: md`- Exporting passwords to Cognito (hashes cannot be imported).`,
  followups: [['How would you do the same in Keycloak?', 'User Storage SPI federation or a custom provider that validates legacy hashes and imports users on first login.']],
  keyPoints: [['User Migration trigger', 'migration (trigger|lambda)|user migration'], ['Verify legacy hash on sign-in, create user', 'verify|legacy|hash|sign.?in'], ['Forgot password path', 'forgot'], ['Bulk import for inactive users', 'bulk|import|csv'], ['Lambda timeout/security', 'timeout|vpc|secret|fast']]
}),
Q('iam-06', 'iam', 'iam:token-revocation', 'Revocation', 'advanced', 'scenario', 'A customer reports their phone was stolen while logged into your banking app (Keycloak + JWT access tokens of 5 minutes). What do you do technically, and what is the residual risk?', {
  expected: md`(1) Revoke the user's **sessions and refresh tokens** at Keycloak (admin API: logout user / revoke sessions), which stops new access tokens. (2) For the residual window (up to 5 minutes of a valid access token), add the session id ({{sid}}) or token ids to a **gateway deny list** (Redis with TTL = remaining token life), or require **introspection** for high-risk endpoints (transfers). (3) Trigger **back-channel logout** to BFFs/apps. (4) Force step-up authentication on next login, revoke device binding/trusted device, notify the customer, review recent activity. Residual risk: without deny list/introspection, an already-issued access token remains usable until expiry; sensitive operations should also require step-up/transaction signing (OTP).`,
  explanation: md`Self-contained tokens trade revocation latency for scalability; compensate on critical paths.`,
  example: md`See Token Revocation topic for the gateway deny-list filter.`,
  wrong: md`- "Delete the JWT."`,
  followups: [['Why not introspect every request?', 'Load and latency on the IdP; reserve for high-value APIs and cache briefly.']],
  keyPoints: [['Revoke sessions/refresh tokens at IdP', 'revoke|logout|session'], ['Residual access token window', 'residual|until expir|5 min|still valid'], ['Deny list or introspection', 'deny|block|introspect'], ['Back-channel logout / device binding', 'back.?channel|device'], ['Step-up / transaction signing for sensitive actions', 'step.?up|otp|signing']]
}),
Q('iam-07', 'iam', 'iam:rbac-abac', 'Authorization Models', 'intermediate', 'tradeoff', 'Your loan approval system has roles like BRANCH_A_OFFICER_LIMIT_50K and the list keeps growing. What is happening and what do you propose?', {
  expected: md`**Role explosion**: encoding attributes (branch, limit) into roles. Move to **RBAC + ABAC**: keep a small role (LOAN_OFFICER) and express context as **attributes** (branch, approval_limit, department) as token claims or looked up from a directory; enforce rules in the service or a **policy engine** (OPA/Cedar): allow if amount ≤ limit, loan.branch == user.branch, and not self-created (segregation of duties). Policies are versioned, testable and auditable.`,
  explanation: md`Roles describe job functions; attributes describe context. Mixing them leads to unmanageable role sets.`,
  example: md`{{@PreAuthorize("hasRole('LOAN_OFFICER') and @loanPolicy.canApprove(authentication, #loanId)")}}`,
  wrong: md`- "Create more roles and groups."`,
  followups: [['Where should these checks run?', 'In the service that owns the loan data (or via a sidecar PDP), not only at the gateway.']],
  keyPoints: [['Identifies role explosion', 'role explosion|too many roles|explosion'], ['ABAC with attributes', 'abac|attribute'], ['Policy engine / service-level checks', 'opa|policy|cedar|service'], ['Segregation of duties / example rule', 'segregation|self|limit|branch']]
}),
Q('iam-08', 'iam', 'iam:multi-tenant-iam', 'Multi-tenant IAM', 'advanced', 'architecture', 'Realm per tenant or a shared realm for a B2B SaaS with 3,000 small tenants and 5 large enterprise tenants on Keycloak?', {
  expected: md`3,000 realms would strain Keycloak (startup time, caches, admin UX, upgrades). Use a **shared realm with Organizations** (Keycloak 25+) for the small tenants: org membership, org-specific IdPs and domains, tenant claim in tokens. For the 5 enterprise tenants requiring stronger isolation (own keys, custom policies, data residency), consider **dedicated realms** (or even dedicated Keycloak clusters) behind the same login routing. Services derive tenant from the verified token and enforce tenant isolation in data access (filters + RLS).`,
  explanation: md`Hybrid tenancy matches isolation to customer requirements while keeping operations manageable.`,
  example: md`Home-realm discovery by email domain routes users to the org IdP or the enterprise realm.`,
  wrong: md`- A realm per tenant for thousands of tenants without mentioning scale limits.`,
  followups: [['How do tokens carry tenant context?', 'tenant_id or organization claim via protocol mappers; one active tenant per token is simplest.']],
  keyPoints: [['Realm-per-tenant scaling concerns', 'realm.{0,40}(scale|startup|cache|thousand|many)|too many realms'], ['Shared realm + organizations', 'organization|shared realm'], ['Hybrid for enterprise tenants', 'hybrid|dedicated|enterprise'], ['Tenant claim + enforcement in services', 'claim|token|rls|isolation|filter']]
}),
Q('iam-09', 'iam', 'iam:oidc', 'OIDC', 'beginner', 'direct', 'What is the difference between an ID token and an access token? Which one should your API accept?', {
  expected: md`The **ID token** (OIDC) is for the **client** to learn who authenticated ({{aud}} = client_id, contains identity claims, nonce). The **access token** is for the **resource server/API** to authorize requests ({{aud}} = API, scopes/roles). APIs must accept **access tokens only**, validating issuer, audience, expiry and scopes. Sending ID tokens to APIs breaks audience semantics and enables token substitution.`,
  explanation: md`OAuth 2.0 = authorization (access tokens); OIDC adds authentication (ID tokens).`,
  example: md`Spring resource server validates access tokens; Spring oauth2Login consumes the ID token.`,
  wrong: md`- "They are the same JWT, any is fine."`,
  followups: [['What does nonce protect against?', 'Replay/injection of ID tokens: the client checks the nonce it sent matches the token.']],
  keyPoints: [['ID token for client (aud=client_id), identity', 'id token.{0,80}client|identity|who'], ['Access token for API, scopes', 'access token.{0,80}(api|resource)|scope'], ['API accepts access tokens only', 'only access|not (the )?id token|access tokens only'], ['Audience validation', 'aud']]
}),
Q('iam-10', 'iam', 'iam:otp-auth', 'OTP', 'intermediate', 'code-review', 'Code review of an OTP service: codes are generated with new Random(), stored in plaintext in Redis keyed by phone number, valid for 30 minutes, unlimited attempts. List the issues and fixes.', {
  expected: md`(1) **java.util.Random** is predictable: use {{SecureRandom}}. (2) **Plaintext storage**: store an HMAC/hash of the code. (3) **Keyed by phone only**: bind to a **challenge id**/session to prevent cross-session replay and allow per-challenge limits. (4) **30-minute TTL** too long: use 3-5 minutes and single-use. (5) **Unlimited attempts**: allow ~3-5 attempts per challenge, then invalidate; rate-limit sends and verifications per phone/IP/device; resend cooldown. (6) Use **constant-time comparison**, generic responses (no enumeration), never log codes, and protect against SMS pumping (prefix blocks, spend alerts).`,
  explanation: md`A 6-digit code has 1,000,000 possibilities; without attempt limits it can be brute-forced quickly.`,
  example: md`See OTP Authentication topic for a corrected Spring implementation.`,
  wrong: md`- Only increasing code length without attempt limits.`,
  followups: [['Is SMS OTP strong MFA?', 'Weaker than TOTP/passkeys due to SIM swap and interception; acceptable as a factor with risk controls, but step up for high-value actions.']],
  keyPoints: [['SecureRandom', 'securerandom|predictable'], ['Hash codes, do not store plaintext', 'hash|hmac|plaintext'], ['Short TTL + single use', 'ttl|expir|single.?use|minutes'], ['Attempt limits + rate limiting', 'attempt|rate.?limit|brute'], ['Bind to challenge/session, constant-time, no enumeration', 'challenge|constant.?time|enumerat|session']]
}),
Q('iam-11', 'iam', 'iam:keycloak-architecture', 'Keycloak Operations', 'intermediate', 'debugging', 'After moving Keycloak behind an AWS ALB, login redirects loop and APIs reject tokens with "invalid issuer". Why?', {
  expected: md`Keycloak builds URLs (redirects, issuer) from its **hostname configuration and forwarded headers**. Behind the ALB, without {{--hostname}} and {{--proxy-headers=xforwarded}} (or legacy proxy settings), Keycloak sees internal HTTP host/scheme: redirect URIs and the {{iss}} claim contain the wrong scheme/host (e.g. http://10.0.x.x:8080), so browsers loop and resource servers configured with {{https://idp.example.com/realms/x}} reject the issuer. Fix hostname/proxy settings, ensure the ALB sends X-Forwarded-Proto/Host, and configure sticky sessions or proper cache clustering if needed.`,
  explanation: md`Issuer must exactly match what clients and APIs expect; it is derived from the frontend URL.`,
  example: md`{{kc.sh start --hostname=https://idp.example.com --proxy-headers=xforwarded}}`,
  wrong: md`- "Disable issuer validation."`,
  followups: [['Why might users get logged out when pods restart?', 'Session cache owners/persistence not configured; sessions lost with the node.']],
  keyPoints: [['Hostname / frontend URL config', 'hostname|frontend url'], ['Forwarded headers / proxy mode', 'x-forwarded|forwarded|proxy'], ['Issuer mismatch explained', 'iss|issuer'], ['Redirect URI wrong scheme/host', 'redirect|scheme|http']]
}),
Q('iam-12', 'iam', 'iam:saml', 'SAML vs OIDC', 'beginner', 'tradeoff', 'An enterprise customer only supports SAML, but your apps use OIDC. How do you integrate?', {
  expected: md`Use **identity brokering**: configure the customer's SAML IdP as an identity provider in Keycloak (exchange metadata: entity IDs, ACS URL, certificates, NameID format, attribute mappings). Keycloak acts as SAML **SP** to the customer and as OIDC **provider** to your apps, translating assertions into OIDC tokens with mapped claims/roles (IdP mappers). Route users via home-realm discovery (email domain or {{kc_idp_hint}}). Validate signatures, audience, timestamps; plan certificate rollover; add SCIM or JIT provisioning.`,
  explanation: md`Brokering means apps integrate once with OIDC while supporting any upstream protocol.`,
  example: md`Customer Entra ID (SAML) -> Keycloak broker -> OIDC tokens for your SPA/APIs.`,
  wrong: md`- Implementing SAML in every microservice.`,
  followups: [['What is first broker login?', 'The flow run when an external identity logs in the first time: create/link local account, review profile.']],
  keyPoints: [['Identity brokering via Keycloak', 'broker|keycloak'], ['Metadata exchange / ACS / certificates', 'metadata|acs|certificate|entity'], ['Attribute/role mappers', 'mapper|attribute|claim'], ['Home realm discovery / kc_idp_hint', 'discovery|idp_hint|domain'], ['Provisioning (JIT/SCIM)', 'scim|jit|provision']]
})
]);
})();
