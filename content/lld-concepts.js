(function () {
const md = LAB.md;

LAB.add('lld', 'Foundations', [
{ id: 'oop', title: 'OOP Principles in Practice', level: 'beginner', tags: ['oop', 'encapsulation', 'polymorphism'],
  summary: 'Encapsulation, abstraction, inheritance and polymorphism, as a senior engineer actually applies them.',
  body: md`
## Why interviewers still ask this
At 7+ years nobody wants textbook definitions. They want to see that you use OOP to **protect invariants** and **localise change**. A good answer always ties each principle to a production consequence.

## Encapsulation: protect invariants, not just "private fields"
Encapsulation means that an object is the only thing allowed to change its own state, so it can guarantee its invariants. Getters/setters for every field is _not_ encapsulation; it is a public struct with extra steps.

~~~java
// Anaemic: any caller can put the account into an invalid state
public class Account { private BigDecimal balance; public void setBalance(BigDecimal b) { this.balance = b; } }

// Encapsulated: the invariant (balance >= 0, every change is audited) lives in one place
public class Account {
    private BigDecimal balance = BigDecimal.ZERO;
    private final List<LedgerEntry> entries = new ArrayList<>();

    public void debit(BigDecimal amount, String reference) {
        if (amount.signum() <= 0) throw new IllegalArgumentException("amount must be positive");
        if (balance.compareTo(amount) < 0) throw new InsufficientFundsException(reference);
        balance = balance.subtract(amount);
        entries.add(LedgerEntry.debit(amount, reference));
    }
    public BigDecimal balance() { return balance; }
    public List<LedgerEntry> entries() { return List.copyOf(entries); } // no leaking of mutable internals
}
~~~

## Abstraction: depend on what, not how
An abstraction hides a decision that is likely to change. {{PaymentGateway}} hides whether you call Stripe, Checkout.com or a local UAE acquirer. The test: could you swap the implementation without touching callers?

## Inheritance: use sparingly
Inheritance couples the subclass to the parent's implementation (the **fragile base class** problem). Prefer composition unless there is a true _is-a_ relationship **and** the subclass honours the parent's contract (Liskov). Frameworks (Spring's {{OncePerRequestFilter}}, {{AbstractAuthenticationProcessingFilter}}) use inheritance via Template Method, which is the legitimate use case.

## Polymorphism: replace conditionals
~~~java
// Before: every new type edits this switch (violates Open/Closed)
double fee(Payment p) { switch (p.type()) { case CARD: return p.amount() * 0.029; case WALLET: return 0.5; default: throw new IllegalStateException(); } }

// After: each type owns its rule
sealed interface FeePolicy permits CardFee, WalletFee { BigDecimal feeFor(BigDecimal amount); }
record CardFee(BigDecimal rate) implements FeePolicy { public BigDecimal feeFor(BigDecimal a) { return a.multiply(rate); } }
record WalletFee(BigDecimal flat) implements FeePolicy { public BigDecimal feeFor(BigDecimal a) { return flat; } }
~~~
With Java 17+ sealed types and pattern-matching {{switch}}, an exhaustive switch over a sealed hierarchy is also acceptable: the compiler forces you to handle new types. Know both styles and when each is clearer.

## Composition over inheritance
~~~java
// Instead of RetryingHttpClient extends HttpClient, LoggingRetryingHttpClient extends RetryingHttpClient ...
public final class ResilientClient implements HttpPort {
    private final HttpPort delegate; private final RetryPolicy retry; private final MeterRegistry metrics;
    public ResilientClient(HttpPort delegate, RetryPolicy retry, MeterRegistry metrics) { this.delegate = delegate; this.retry = retry; this.metrics = metrics; }
    public Response send(Request r) { return retry.execute(() -> metrics.timer("http").record(() -> delegate.send(r))); }
}
~~~

## Interview questions
?? What is the difference between abstraction and encapsulation?
Encapsulation is about **who may change state** (the object guards its invariants). Abstraction is about **what callers need to know** (an interface that hides a volatile decision). You can have encapsulation without abstraction (a concrete class with private state) and abstraction without strong encapsulation (an interface whose implementation leaks mutable collections).
?? When is inheritance the right choice?
When there is a genuine substitutable is-a relationship, the base class is designed for extension (documented hooks, final template method), and you control both sides. Otherwise prefer composition: it can be changed at runtime, tested in isolation, and does not expose protected internals.
?? Why are anaemic domain models criticised?
Business rules end up scattered across services, so invariants are enforced inconsistently. It is fine for CRUD-heavy services; it becomes a liability once rules are non-trivial (payments, bookings, entitlements).
` },

{ id: 'solid', title: 'SOLID Principles', level: 'intermediate', tags: ['solid', 'design'],
  summary: 'Each principle with a violating and a corrected Spring Boot example, plus where over-applying it hurts.',
  body: md`
## S: Single Responsibility
"A class should have one reason to change", where a reason is an **actor** (a stakeholder group). An {{InvoiceService}} that calculates tax (finance changes it), renders PDF (design changes it) and emails customers (marketing changes it) has three reasons.
~~~java
// Split by actor
class TaxCalculator { Money taxFor(Invoice i) { ... } }
class InvoiceRenderer { byte[] pdf(Invoice i) { ... } }
class InvoiceNotifier { void send(Invoice i, byte[] pdf) { ... } }
~~~
> **Pitfall** Over-splitting into 40 one-method classes is not SRP. Group things that change together (cohesion).

## O: Open/Closed
Open for extension, closed for modification: add behaviour by adding code, not editing tested code. In Spring, inject a {{List<Handler>}} or a {{Map<String, Handler>}} and pick at runtime.
~~~java
public interface NotificationChannel { Channel type(); void send(Notification n); }

@Service
public class NotificationDispatcher {
    private final Map<Channel, NotificationChannel> channels;
    public NotificationDispatcher(List<NotificationChannel> all) {
        this.channels = all.stream().collect(Collectors.toMap(NotificationChannel::type, c -> c));
    }
    public void dispatch(Notification n) {
        Optional.ofNullable(channels.get(n.channel()))
                .orElseThrow(() -> new UnsupportedChannelException(n.channel()))
                .send(n);
    }
}
// Adding WhatsApp = one new @Component. Dispatcher is untouched.
~~~

## L: Liskov Substitution
Subtypes must honour the base type's contract: no stronger preconditions, no weaker postconditions, no new exceptions callers do not expect. Classic violation: {{ReadOnlyList extends ArrayList}} throwing on {{add}}. Real-world violation: a {{CachedUserRepository}} whose {{save}} silently does nothing for some entities.

## I: Interface Segregation
Clients should not depend on methods they do not use. Split {{UserRepository}} into {{UserReader}} and {{UserWriter}} if most callers only read; it also makes read-replica routing explicit.

## D: Dependency Inversion
High-level policy should not depend on low-level detail; both depend on abstractions, and the **abstraction is owned by the high-level module**. Your domain defines {{PaymentGateway}}; the Stripe adapter implements it. This is the basis of hexagonal / clean architecture.

## How to talk about SOLID in an interview
Say what problem it solved in your code: "Our OTP sender had an if/else per provider (SNS, Twilio, a local UAE SMS aggregator). Moving to a strategy registry meant onboarding a new provider was one class and a config entry, and the existing ones were never re-tested."

?? Is SOLID always worth applying?
No. It trades simplicity for flexibility. Apply it at **volatility points** (payment providers, notification channels, pricing rules) and keep stable code simple. Premature abstraction (an interface with exactly one implementation that will never change) adds indirection without benefit, although interfaces at module boundaries are still useful for testing.
?? Give a Liskov violation you would catch in code review.
An override that throws {{UnsupportedOperationException}}, narrows accepted inputs, or changes side effects (e.g. a subclass of {{EmailSender}} that batches and sends later while callers assume the email was sent when {{send}} returns).
` },

{ id: 'uml', title: 'UML Class Diagrams', level: 'beginner', tags: ['uml', 'diagrams'],
  summary: 'The notation you need on a whiteboard: classes, interfaces, visibility, multiplicity and the five relationships.',
  body: md`
## What to draw in an interview
Draw only what explains your design: core classes, their key fields/methods, and relationships with multiplicity. Skip getters/setters.

~~~mermaid
classDiagram
  class ParkingLot { -List~Floor~ floors +park(Vehicle) Ticket +unpark(Ticket) Receipt }
  class Floor { -int number -List~Spot~ spots +findSpot(VehicleType) Optional~Spot~ }
  class Spot { <<abstract>> -String id -boolean free +fits(Vehicle) boolean }
  class CompactSpot
  class LargeSpot
  class Vehicle { <<abstract>> -String plate }
  class Ticket { -String id -Instant entry }
  class PricingStrategy { <<interface>> +price(Ticket, Instant) Money }
  ParkingLot "1" *-- "1..*" Floor : composition
  Floor "1" *-- "many" Spot
  Spot <|-- CompactSpot
  Spot <|-- LargeSpot
  Ticket --> Spot : association
  Ticket --> Vehicle
  ParkingLot o-- PricingStrategy : aggregation
~~~

## Notation cheat-sheet
| Symbol | Meaning | Java shape |
|---|---|---|
| {{+ - # ~}} | public, private, protected, package | access modifiers |
| {{<\|--}} | inheritance (is-a) | {{extends}} |
| {{<\|..}} | realization | {{implements}} |
| {{*--}} | composition (part dies with whole) | whole creates and owns the part |
| {{o--}} | aggregation (shared, independent lifecycle) | injected reference |
| {{-->}} | association | field reference |
| {{..>}} | dependency (uses temporarily) | method parameter / local |

> **Interview tip** State multiplicity out loud ("one lot has one or more floors") and say _why_ something is composition: "a Spot cannot exist without its Floor, so the Floor constructs its spots."
` },

{ id: 'relationships', title: 'Class Relationships & Composition', level: 'intermediate', tags: ['composition', 'aggregation', 'association'],
  summary: 'Association, aggregation, composition, dependency and inheritance — and how they map to JPA and Spring.',
  body: md`
## The five relationships, by strength
1. **Dependency**: A uses B transiently (parameter or local). Weakest coupling.
2. **Association**: A holds a reference to B. Both live independently.
3. **Aggregation**: A "has" B, but B is shared or survives A (a {{Team}} has {{Employee}}s).
4. **Composition**: A owns B's lifecycle (an {{Order}} owns its {{OrderLine}}s). Deleting the order deletes the lines.
5. **Inheritance**: B is-a A. Strongest coupling.

## Mapping to JPA
~~~java
@Entity
public class Order {
    @Id @GeneratedValue private Long id;

    // Composition: lines have no meaning without the order -> cascade + orphanRemoval
    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<OrderLine> lines = new ArrayList<>();

    // Association: customer lives independently -> no cascade, lazy
    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    private Customer customer;

    public void addLine(Product p, int qty) {           // aggregate root controls its parts
        lines.add(new OrderLine(this, p.id(), p.price(), qty));
    }
}
~~~
> **Pitfall** {{cascade = ALL}} on a {{@ManyToOne}} (e.g. to {{Customer}}) means deleting an order can delete the customer. Cascade only along composition.

## Composition over inheritance: a decision rule
Use composition when behaviour varies independently along more than one axis (a notification that varies by channel **and** by retry policy **and** by template engine). Inheritance would need a class per combination (combinatorial explosion); composition needs one class per axis value.

?? How do you decide aggregate boundaries?
Put things in one aggregate when they must be **consistent in the same transaction** (order + lines must agree on total). Reference other aggregates by ID ({{customerId}}) and accept eventual consistency between them. Small aggregates mean less lock contention and smaller transactions.
` },

{ id: 'di', title: 'Dependency Injection', level: 'intermediate', tags: ['di', 'ioc', 'spring'],
  summary: 'Constructor injection, why field injection is discouraged, scopes, qualifiers and circular dependencies.',
  body: md`
## What DI solves
Objects receive collaborators instead of constructing them, so you can substitute implementations (tests, environments, providers) and the wiring lives in one place (the container).

## Prefer constructor injection
~~~java
@Service
public class OtpService {
    private final OtpRepository repo;
    private final SmsSender sms;
    private final Clock clock;            // inject time: makes expiry logic testable

    public OtpService(OtpRepository repo, SmsSender sms, Clock clock) { // @Autowired optional with one constructor
        this.repo = repo; this.sms = sms; this.clock = clock;
    }
}
~~~
Why: dependencies are explicit and {{final}}, the object is never half-built, it is trivially testable with {{new OtpService(fakeRepo, fakeSms, Clock.fixed(...))}}, and a constructor with 9 parameters is a visible SRP smell. Field injection hides all of that and needs reflection in tests.

## Choosing among implementations
~~~java
@Bean @Primary SmsSender snsSender(SnsClient c) { return new SnsSmsSender(c); }
@Bean @Qualifier("fallback") SmsSender twilioSender(TwilioClient c) { return new TwilioSmsSender(c); }

@Bean @ConditionalOnProperty(name = "otp.provider", havingValue = "local-aggregator")
SmsSender localAggregator(...) { ... }
~~~

## Scopes and the classic bug
Singleton is default. Injecting a {{prototype}} or {{request}}-scoped bean into a singleton gives you **one instance forever**. Fix with {{ObjectProvider<T>}}, a scoped proxy ({{proxyMode = TARGET_CLASS}}), or rethink the design.

## Circular dependencies
Spring Boot 2.6+ fails on circular references by default. The right fix is design (extract a third component or publish an event), not {{@Lazy}} or setter injection.

?? Why can't @Transactional work when a method calls another method in the same class?
Spring applies {{@Transactional}} through a proxy. A self-invocation ({{this.inner()}}) bypasses the proxy, so the advice never runs. Fixes: move the method to another bean, inject self via {{ObjectProvider}}, or use {{TransactionTemplate}} programmatically.
` },

{ id: 'clean-arch', title: 'Clean / Hexagonal Architecture', level: 'advanced', tags: ['architecture', 'hexagonal', 'ports-adapters'],
  summary: 'Dependency rule, ports and adapters, package layout for a Spring Boot service, and when it is overkill.',
  body: md`
## The dependency rule
Source-code dependencies point **inwards**. The domain knows nothing about Spring, JPA, Kafka or HTTP. Infrastructure implements interfaces (ports) that the application layer defines.

~~~mermaid
flowchart LR
  subgraph Adapters_In["Inbound adapters"]
    REST["REST controller"]; KC["Kafka listener"]
  end
  subgraph App["Application layer (use cases)"]
    UC["PlaceOrderUseCase"]; PO["Ports: OrderRepository, PaymentPort, EventPublisher"]
  end
  subgraph Domain["Domain"]
    AGG["Order aggregate, Money, policies"]
  end
  subgraph Adapters_Out["Outbound adapters"]
    JPA["JPA repository"]; PAY["Payment HTTP client"]; KP["Kafka publisher"]
  end
  REST --> UC; KC --> UC; UC --> AGG; UC --> PO
  JPA -. implements .-> PO; PAY -. implements .-> PO; KP -. implements .-> PO
~~~

## Package layout
~~~text
com.acme.orders
 ├─ domain        Order, OrderLine, Money, OrderPolicy        (no framework imports)
 ├─ application   PlaceOrderUseCase, ports/OrderRepository, ports/PaymentPort
 ├─ adapter.in    web/OrderController, messaging/PaymentEventsListener
 └─ adapter.out   persistence/OrderJpaAdapter, payment/PaymentClient, messaging/KafkaEventPublisher
~~~
Enforce it with **ArchUnit** tests so the rule survives the next deadline.

~~~java
@AnalyzeClasses(packages = "com.acme.orders")
class ArchitectureTest {
  @ArchTest static final ArchRule domainIsPure = noClasses().that().resideInAPackage("..domain..")
      .should().dependOnClassesThat().resideInAnyPackage("org.springframework..", "jakarta.persistence..");
}
~~~

## When NOT to use it
For a thin CRUD service or a short-lived integration, full hexagonal layering doubles the number of classes (JPA entity + domain model + mappers) for little gain. A pragmatic middle ground: keep JPA annotations on domain entities but keep HTTP/Kafka out of the domain.

?? JPA entities vs separate domain models — which do you choose?
Separate models give a pure domain and freedom in persistence, at the cost of mapping code and losing dirty-checking convenience. I use separate models when the domain is rich or persistence may change, and annotated entities for simpler bounded contexts. State the trade-off; there is no universally right answer.
` },

{ id: 'ddd', title: 'Domain-Driven Design Fundamentals', level: 'advanced', tags: ['ddd', 'aggregates', 'bounded-context'],
  summary: 'Bounded contexts, aggregates, value objects, domain events and how they drive microservice boundaries.',
  body: md`
## Strategic DDD (what seniors are expected to know)
- **Ubiquitous language**: the code uses the business's words ({{Booking}}, {{Hold}}, {{Settlement}}).
- **Bounded context**: a boundary inside which a model is consistent. "Customer" in Billing (payment methods, VAT number) differs from "Customer" in Support (tickets, SLA). Microservice boundaries should follow bounded contexts, not database tables.
- **Context map**: how contexts integrate (customer/supplier, anti-corruption layer, published language/events).

## Tactical DDD
| Building block | Rule | Example |
|---|---|---|
| Entity | identity over time | {{Order(id)}} |
| Value object | immutable, equality by value | {{Money(amount, currency)}}, {{EmailAddress}} |
| Aggregate | consistency boundary, one root, one transaction | {{Order}} + lines |
| Domain event | something that happened, past tense | {{OrderPlaced}} |
| Repository | collection-like access to aggregates | {{OrderRepository.byId}} |
| Domain service | logic that does not belong to one entity | {{FxConversionService}} |

~~~java
public record Money(BigDecimal amount, Currency currency) {
    public Money { Objects.requireNonNull(currency); amount = amount.setScale(currency.getDefaultFractionDigits(), RoundingMode.HALF_EVEN); }
    public Money plus(Money o) { requireSame(o); return new Money(amount.add(o.amount), currency); }
    private void requireSame(Money o) { if (!currency.equals(o.currency)) throw new CurrencyMismatchException(currency, o.currency); }
}
~~~

## Aggregate design rules (Vaughn Vernon)
1. Protect true invariants inside one aggregate.
2. Design small aggregates.
3. Reference other aggregates by identity.
4. Use eventual consistency (domain events) across aggregates.

## Publishing domain events reliably
Save the aggregate and the event in the same DB transaction (transactional **outbox**), then relay to Kafka. Publishing directly to Kafka inside {{@Transactional}} risks "event sent, DB rolled back" or the reverse.

?? How do you find service boundaries in a legacy monolith?
Event-storm the business process, look for clusters of commands/events with their own language, check which tables change together, and check team ownership. Then extract the context with the fewest inbound dependencies first (strangler fig), putting an anti-corruption layer between old and new models.
` },

{ id: 'extensible', title: 'Extensible & Maintainable Code', level: 'intermediate', tags: ['maintainability', 'refactoring'],
  summary: 'Concrete techniques: strategy registries, feature flags, immutability, explicit errors, small modules and tests as a safety net.',
  body: md`
## Techniques that pay off in real services
1. **Strategy registries** instead of growing switches (see SOLID/OCP).
2. **Immutability by default**: records, {{List.copyOf}}, final fields. Removes whole classes of concurrency bugs.
3. **Make illegal states unrepresentable**: sealed interfaces for states; value objects for IDs ({{record OrderId(UUID value)}}) so you cannot pass a {{UserId}} where an {{OrderId}} is expected.
4. **Explicit errors**: domain exceptions mapped once in a {{@RestControllerAdvice}} to RFC 7807 problem details.
5. **Configuration over code** for things that change often (limits, providers, templates) with validation ({{@ConfigurationProperties}} + {{@Validated}}).
6. **Feature flags** for risky changes; remove them after rollout.
7. **Tests at the right level**: domain unit tests, slice tests ({{@WebMvcTest}}, {{@DataJpaTest}}), and a few Testcontainers integration tests.

~~~java
@ConfigurationProperties(prefix = "otp")
@Validated
public record OtpProperties(@Min(4) @Max(8) int length, @NotNull Duration ttl, @Min(1) int maxAttempts) {}
~~~

## Code-review heuristics seniors use
- Does a new requirement of the same kind need edits in many files (shotgun surgery)? Missing abstraction.
- Is a boolean parameter changing behaviour ({{send(msg, true)}})? Split the method or pass an enum.
- Are exceptions swallowed or logged and rethrown at every layer? Handle once at the boundary.
- Are there time/random/UUID calls inside domain logic? Inject {{Clock}}/{{IdGenerator}} for determinism.
` },

{ id: 'concurrency-lld', title: 'Concurrency & Thread Safety in LLD', level: 'advanced', tags: ['concurrency', 'locks', 'thread-safety'],
  summary: 'Race conditions in LLD problems (parking, booking, wallets) and the right tool for each: confinement, immutability, locks, CAS, DB locking.',
  body: md`
## The decision ladder
1. **Avoid sharing**: thread confinement, request-scoped objects.
2. **Immutability**: share freely.
3. **Concurrent data structures**: {{ConcurrentHashMap}}, {{ConcurrentLinkedQueue}}, {{LongAdder}}.
4. **Atomic CAS**: {{AtomicReference.compareAndSet}} for single-variable state transitions.
5. **Locks**: {{synchronized}} / {{ReentrantLock}} for multi-variable invariants; keep the critical section small; consistent lock ordering to avoid deadlock.
6. **Across JVMs**: the database (row lock, optimistic version column, unique constraint) or a distributed lock with fencing tokens.

## Booking a seat: three correct variants
~~~java
// 1) In-memory, per-seat CAS: no global lock, no double booking within one JVM
public final class Seat {
    private final AtomicReference<String> heldBy = new AtomicReference<>(null);
    public boolean tryHold(String userId) { return heldBy.compareAndSet(null, userId); }
    public void release(String userId) { heldBy.compareAndSet(userId, null); }
}

// 2) Multi-seat atomically: lock seats in a global order to avoid deadlock
public boolean holdAll(List<Seat> seats, String user) {
    List<Seat> ordered = seats.stream().sorted(Comparator.comparing(Seat::id)).toList();
    ordered.forEach(s -> s.lock().lock());
    try {
        if (ordered.stream().anyMatch(Seat::isTaken)) return false;
        ordered.forEach(s -> s.assign(user));
        return true;
    } finally { ordered.forEach(s -> s.lock().unlock()); }
}
~~~
~~~sql
-- 3) Multiple app instances: let the database arbitrate
UPDATE seat SET status = 'HELD', held_by = :user, hold_expires_at = now() + interval '10 minutes', version = version + 1
WHERE show_id = :show AND seat_no = ANY(:seats) AND status = 'AVAILABLE';
-- if updated rows != requested seats -> rollback (someone else won)
~~~

## Common mistakes
- {{check-then-act}} on a {{ConcurrentHashMap}} ({{if (!map.containsKey(k)) map.put(k, v)}}) — use {{putIfAbsent}}/{{computeIfAbsent}}.
- Double-checked locking without {{volatile}}.
- Holding a lock while doing I/O (HTTP call to a payment provider inside {{synchronized}}).
- Assuming {{synchronized}} works across pods. It does not.
- Using a Redis lock without a TTL or without fencing: a GC pause can let two holders write.

?? Optimistic vs pessimistic locking: which for seat booking?
Pessimistic ({{SELECT ... FOR UPDATE}}) when contention is high and short (hot seats during a concert drop). Optimistic (version column) when conflicts are rare; it avoids holding locks but losers must retry. Many production systems use a conditional {{UPDATE ... WHERE status='AVAILABLE'}} which is effectively an atomic compare-and-set in the DB.
` }
]);

/* ---------------- Design patterns ---------------- */
const P = (id, title, level, summary, body) => ({ id, title, level, summary, tags: ['design-pattern'], body });

LAB.add('lld', 'Design Patterns', [
P('singleton', 'Singleton', 'beginner', 'One instance per JVM. Know the thread-safe variants and why DI containers mostly replace it.', md`
## Intent
Guarantee one instance and a global access point. Legitimate uses: a process-wide registry, metrics registry, or a costly client (although in Spring you would make it a singleton **bean** instead).

## Thread-safe implementations
~~~java
// 1) Enum singleton: serialization- and reflection-safe (Effective Java item 3)
public enum IdGenerator { INSTANCE; private final AtomicLong seq = new AtomicLong(); public long next() { return seq.incrementAndGet(); } }

// 2) Initialization-on-demand holder: lazy, no synchronization cost (class init is thread-safe per JLS)
public final class Config {
    private Config() {}
    private static class Holder { static final Config INSTANCE = new Config(); }
    public static Config get() { return Holder.INSTANCE; }
}

// 3) Double-checked locking: volatile is REQUIRED, otherwise another thread may see a partially constructed object
public final class Registry {
    private static volatile Registry instance;
    public static Registry get() {
        Registry r = instance;
        if (r == null) { synchronized (Registry.class) { r = instance; if (r == null) instance = r = new Registry(); } }
        return r;
    }
}
~~~

## When NOT to use it
Global mutable state hides dependencies and makes tests order-dependent. In Spring, use a singleton-scoped bean injected via constructor: one instance, but still replaceable in tests.

## Interview angles
?? Is a Spring singleton bean the same as the Singleton pattern?
No. Spring's singleton is **one instance per container (ApplicationContext)**, not per JVM/classloader, and it is obtained via injection, not a static accessor. Two contexts mean two instances.
?? How can a Singleton be broken?
Reflection (calling the private constructor), serialization (deserializing creates a new instance unless {{readResolve}} is implemented), multiple classloaders, and cloning. The enum approach defends against the first two.
`),
P('factory', 'Factory Method', 'beginner', 'Delegate object creation to a method so callers depend on an interface, not on concrete classes.', md`
## Intent
Creation logic varies (by type, config or input) and you do not want callers to know concrete classes.
~~~java
public interface PaymentProcessor { PaymentResult charge(PaymentRequest r); }

@Component
public class PaymentProcessorFactory {
    private final Map<PaymentMethod, PaymentProcessor> byMethod;
    public PaymentProcessorFactory(CardProcessor card, ApplePayProcessor applePay, BankTransferProcessor bank) {
        this.byMethod = Map.of(PaymentMethod.CARD, card, PaymentMethod.APPLE_PAY, applePay, PaymentMethod.BANK_TRANSFER, bank);
    }
    public PaymentProcessor forMethod(PaymentMethod m) {
        PaymentProcessor p = byMethod.get(m);
        if (p == null) throw new UnsupportedPaymentMethodException(m);
        return p;
    }
}
~~~
## Where you already use it
{{Calendar.getInstance()}}, {{List.of()}}, {{LoggerFactory.getLogger()}}, Spring's {{FactoryBean}}, {{BeanFactory.getBean}}.

## Simple factory vs Factory Method vs Abstract Factory
- **Simple factory**: one method with a switch/map (above). Not a GoF pattern but most common.
- **Factory Method** (GoF): a superclass defines {{createX()}} and subclasses override it (e.g. {{AbstractDocumentExporter.createWriter()}}).
- **Abstract Factory**: a family of related products created together.

> **Pitfall** A factory that is itself a growing switch statement violates OCP; prefer a registry built from injected beans.
`),
P('abstract-factory', 'Abstract Factory', 'intermediate', 'Create families of related objects that must be used together (e.g. per-cloud or per-tenant component sets).', md`
## Intent
Provide an interface for creating **families** of related objects without specifying concrete classes, guaranteeing that the products are compatible.
~~~java
public interface CloudFactory { BlobStore blobStore(); MessageQueue queue(); SecretStore secrets(); }

public final class AwsFactory implements CloudFactory {
    public BlobStore blobStore() { return new S3BlobStore(); }
    public MessageQueue queue() { return new SqsQueue(); }
    public SecretStore secrets() { return new SecretsManagerStore(); }
}
public final class AzureFactory implements CloudFactory {
    public BlobStore blobStore() { return new AzureBlobStore(); }
    public MessageQueue queue() { return new ServiceBusQueue(); }
    public SecretStore secrets() { return new KeyVaultStore(); }
}
// The application receives one CloudFactory and can never mix S3 with Service Bus by accident.
~~~
## Real-world use
Multi-region deployments where UAE data-residency tenants use a different provider family; UI toolkits (Windows vs Mac widgets); JDBC's {{Connection}} creating {{Statement}}s of the same driver family.

## Trade-off
Adding a new **product** (e.g. a cache) means changing every factory. Adding a new **family** is easy. Use it when families change more often than products.
`),
P('builder', 'Builder', 'beginner', 'Construct complex immutable objects step by step with validation at build time.', md`
## Intent
Avoid telescoping constructors and enable immutable objects with many optional fields.
~~~java
public final class NotificationRequest {
    private final String recipient; private final Channel channel; private final String templateId;
    private final Map<String, String> params; private final Priority priority; private final Instant sendAt;

    private NotificationRequest(Builder b) {
        this.recipient = b.recipient; this.channel = b.channel; this.templateId = b.templateId;
        this.params = Map.copyOf(b.params); this.priority = b.priority; this.sendAt = b.sendAt;
    }
    public static Builder to(String recipient, Channel channel) { return new Builder(recipient, channel); }

    public static final class Builder {
        private final String recipient; private final Channel channel;
        private String templateId; private final Map<String, String> params = new HashMap<>();
        private Priority priority = Priority.NORMAL; private Instant sendAt;
        private Builder(String r, Channel c) { this.recipient = Objects.requireNonNull(r); this.channel = Objects.requireNonNull(c); }
        public Builder template(String id) { this.templateId = id; return this; }
        public Builder param(String k, String v) { params.put(k, v); return this; }
        public Builder priority(Priority p) { this.priority = p; return this; }
        public Builder sendAt(Instant t) { this.sendAt = t; return this; }
        public NotificationRequest build() {
            if (templateId == null) throw new IllegalStateException("template required");
            if (channel == Channel.SMS && params.values().stream().mapToInt(String::length).sum() > 1000)
                throw new IllegalStateException("SMS params too long");
            return new NotificationRequest(this);
        }
    }
}
NotificationRequest req = NotificationRequest.to("+9715xxxxxxx", Channel.SMS).template("otp").param("code", "482910").priority(Priority.HIGH).build();
~~~
## In the wild
{{StringBuilder}}, {{HttpRequest.newBuilder()}}, {{WebClient.builder()}}, Lombok {{@Builder}}, {{ResponseEntity.ok().header(...).body(...)}}.
> **Pitfall** Lombok {{@Builder}} skips validation unless you add it in a custom {{build()}} or a compact record constructor.
`),
P('strategy', 'Strategy', 'beginner', 'Encapsulate interchangeable algorithms behind one interface and choose at runtime.', md`
## Intent
Select an algorithm at runtime without conditionals in the caller. The single most useful pattern in backend LLD (pricing, routing, retry, rate-limit algorithm, OTP delivery).
~~~java
public interface PricingStrategy { Money price(Ticket ticket, Instant exit); }

public final class HourlyPricing implements PricingStrategy {
    private final Money perHour;
    public HourlyPricing(Money perHour) { this.perHour = perHour; }
    public Money price(Ticket t, Instant exit) {
        long hours = Math.max(1, (long) Math.ceil(Duration.between(t.entry(), exit).toMinutes() / 60.0));
        return perHour.times(hours);
    }
}
public final class WeekendFlatPricing implements PricingStrategy { ... }

// Java 8+: a strategy can simply be a lambda when it is stateless
PricingStrategy free = (t, exit) -> Money.zero(Currency.getInstance("AED"));
~~~
## Strategy vs State
Same structure, different intent: **Strategy** is chosen by the client and does not change itself; **State** objects transition the context from one state to another.

## Spring idiom
Inject {{Map<String, PricingStrategy>}} — Spring populates it keyed by bean name — and select by configuration or tenant.
`),
P('observer', 'Observer', 'beginner', 'Publish-subscribe inside a process; the in-memory ancestor of event-driven architecture.', md`
## Intent
When one object changes, notify dependents without coupling to them.
~~~java
// Spring's built-in observer
public record OrderPlaced(String orderId, String customerId, Money total) {}

@Service
class OrderService {
    private final ApplicationEventPublisher events;
    OrderService(ApplicationEventPublisher events) { this.events = events; }
    @Transactional
    public void place(Order o) { /* persist */ events.publishEvent(new OrderPlaced(o.id(), o.customerId(), o.total())); }
}

@Component
class LoyaltyListener {
    // Runs only if the transaction commits: avoids awarding points for a rolled-back order
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void on(OrderPlaced e) { /* award points */ }
}
~~~
## Pitfalls
- Synchronous listeners run on the publisher's thread: a slow listener slows the request, and an exception can roll back the publisher's transaction (with {{@EventListener}}).
- In-memory events are **lost on crash**. For cross-service or must-not-lose events use the outbox pattern + Kafka.
- Memory leaks when observers register but never unregister (classic in UI code).
`),
P('decorator', 'Decorator', 'intermediate', 'Add responsibilities to an object dynamically by wrapping it with the same interface.', md`
## Intent
Layer behaviour (caching, retries, metrics, encryption) without subclass explosion.
~~~java
public interface SmsSender { void send(String phone, String text); }

public final class RetryingSmsSender implements SmsSender {
    private final SmsSender delegate; private final int maxAttempts;
    public RetryingSmsSender(SmsSender d, int max) { this.delegate = d; this.maxAttempts = max; }
    public void send(String phone, String text) {
        RuntimeException last = null;
        for (int i = 1; i <= maxAttempts; i++) {
            try { delegate.send(phone, text); return; }
            catch (TransientSmsException e) { last = e; sleep(backoffWithJitter(i)); }
        }
        throw last;
    }
}
public final class MaskingLoggingSmsSender implements SmsSender {
    private final SmsSender delegate; private static final Logger log = LoggerFactory.getLogger(MaskingLoggingSmsSender.class);
    public MaskingLoggingSmsSender(SmsSender d) { this.delegate = d; }
    public void send(String phone, String text) { log.info("sms to {}", phone.replaceAll("\\d(?=\\d{4})", "*")); delegate.send(phone, text); }
}
SmsSender sender = new MaskingLoggingSmsSender(new RetryingSmsSender(new SnsSmsSender(sns), 3));
~~~
## In the wild
{{java.io}} streams ({{new BufferedInputStream(new FileInputStream(f))}}), {{Collections.unmodifiableList}}, Spring's {{TransactionAwareDataSourceProxy}}, servlet {{HttpServletRequestWrapper}}.
## Decorator vs Proxy
Structurally identical. **Decorator** adds behaviour and is composed by the client; **Proxy** controls access (lazy loading, security, remoting) and the client usually does not know it is there.
`),
P('adapter', 'Adapter', 'beginner', 'Convert an incompatible interface into the one your code expects; the core of anti-corruption layers.', md`
## Intent
Integrate a third-party or legacy API without letting its model leak into your domain.
~~~java
// Our port
public interface IdentityProvider { UserIdentity findByEmail(String email); void disable(String userId); }

// Adapter for Keycloak Admin API
public final class KeycloakIdentityProvider implements IdentityProvider {
    private final RealmResource realm;
    public KeycloakIdentityProvider(Keycloak kc, String realmName) { this.realm = kc.realm(realmName); }
    public UserIdentity findByEmail(String email) {
        return realm.users().searchByEmail(email, true).stream().findFirst()
            .map(u -> new UserIdentity(u.getId(), u.getEmail(), u.isEnabled()))
            .orElseThrow(() -> new UserNotFoundException(email));
    }
    public void disable(String userId) {
        UserRepresentation u = realm.users().get(userId).toRepresentation(); u.setEnabled(false); realm.users().get(userId).update(u);
    }
}
// A CognitoIdentityProvider adapter implements the same port: migrating IdPs touches one class.
~~~
## Object adapter vs class adapter
Java favours **object adapters** (composition). Class adapters need multiple inheritance.
`),
P('proxy', 'Proxy', 'intermediate', 'A stand-in that controls access: lazy loading, caching, security, remoting. Spring AOP is built on it.', md`
## Kinds
- **Virtual proxy**: lazy load (Hibernate lazy associations are proxies; {{LazyInitializationException}} is what happens when the session is closed).
- **Protection proxy**: access control ({{@PreAuthorize}}).
- **Remote proxy**: Feign clients, gRPC stubs.
- **Caching proxy**: {{@Cacheable}}.

## How Spring creates proxies
JDK dynamic proxies (when the bean implements an interface and {{proxyTargetClass=false}}) or CGLIB subclasses (Spring Boot default). Consequences:
- Self-invocation bypasses the proxy ({{@Transactional}}, {{@Cacheable}}, {{@Async}} silently not applied).
- {{final}} classes/methods cannot be CGLIB-proxied.
- {{private}} methods are never advised.
~~~java
// Hand-written JDK dynamic proxy that times every call
@SuppressWarnings("unchecked")
static <T> T timed(T target, Class<T> iface, MeterRegistry reg) {
    return (T) Proxy.newProxyInstance(iface.getClassLoader(), new Class<?>[]{iface}, (proxy, m, args) -> {
        Timer.Sample s = Timer.start(reg);
        try { return m.invoke(target, args); }
        catch (InvocationTargetException e) { throw e.getTargetException(); }
        finally { s.stop(reg.timer("calls", "method", m.getName())); }
    });
}
~~~
`),
P('chain-of-responsibility', 'Chain of Responsibility', 'intermediate', 'Pass a request along a chain of handlers; each may handle, enrich or stop it. Servlet filters and Keycloak flows are chains.', md`
## Intent
Decouple sender from receivers and compose processing steps.
~~~java
public abstract class Validator {
    private Validator next;
    public Validator then(Validator n) { this.next = n; return n; }
    public final void validate(PaymentRequest r) { check(r); if (next != null) next.validate(r); }
    protected abstract void check(PaymentRequest r);
}
class AmountValidator extends Validator { protected void check(PaymentRequest r) { if (r.amount().signum() <= 0) throw new ValidationException("amount"); } }
class FraudScoreValidator extends Validator { protected void check(PaymentRequest r) { if (fraud.score(r) > 0.9) throw new SuspectedFraudException(); } }
class VelocityValidator extends Validator { protected void check(PaymentRequest r) { /* >5 attempts per minute per card */ } }

Validator chain = new AmountValidator();
chain.then(new VelocityValidator()).then(new FraudScoreValidator());
chain.validate(request);
~~~
## Where you see it
Servlet {{FilterChain}}, Spring Security's {{SecurityFilterChain}}, Spring MVC {{HandlerInterceptor}}s, Netty pipelines, Keycloak authentication flows (each execution REQUIRED / ALTERNATIVE / CONDITIONAL), logging appenders.
> **Pitfall** Order matters and is often implicit. Make it explicit ({{@Order}}, a configured list) and test it.
`),
P('template-method', 'Template Method', 'intermediate', 'Fix the skeleton of an algorithm in a base class; subclasses fill in steps.', md`
## Intent
Reuse an invariant workflow while allowing specific steps to vary.
~~~java
public abstract class OtpFlow {
    // final: subclasses cannot reorder the security-critical steps
    public final OtpResult start(String principal) {
        enforceRateLimit(principal);
        String code = generateCode();
        store(principal, hash(code), ttl());
        deliver(principal, code);
        return OtpResult.sent(maskedDestination(principal));
    }
    protected abstract void deliver(String principal, String code);   // SMS, email, WhatsApp
    protected abstract String maskedDestination(String principal);
    protected Duration ttl() { return Duration.ofMinutes(5); }          // hook with default
    private String generateCode() { return String.format("%06d", SECURE_RANDOM.nextInt(1_000_000)); }
    ...
}
~~~
## In the wild
{{AbstractList}}, Spring's {{JdbcTemplate}} (template + callback variant), {{OncePerRequestFilter.doFilterInternal}}, {{AbstractAuthenticationProcessingFilter}}.
## Template Method vs Strategy
Template Method varies steps via **inheritance** (compile-time); Strategy varies the whole algorithm via **composition** (runtime). Modern Java often prefers passing lambdas (template + callback), as {{JdbcTemplate}} and {{TransactionTemplate}} do.
`),
P('state', 'State', 'intermediate', 'Let an object change behaviour when its internal state changes; model workflows explicitly.', md`
## Intent
Replace scattered {{if (status == X)}} checks with state objects that know which transitions are legal.
~~~java
public sealed interface OrderState permits Created, Paid, Shipped, Cancelled {
    default OrderState pay()    { throw illegal("pay"); }
    default OrderState ship()   { throw illegal("ship"); }
    default OrderState cancel() { throw illegal("cancel"); }
    private IllegalStateException illegal(String op) { return new IllegalStateException(op + " not allowed in " + getClass().getSimpleName()); }
}
record Created()   implements OrderState { public OrderState pay() { return new Paid(); } public OrderState cancel() { return new Cancelled(); } }
record Paid()      implements OrderState { public OrderState ship() { return new Shipped(); } public OrderState cancel() { return new Cancelled(); /* + refund */ } }
record Shipped()   implements OrderState {}
record Cancelled() implements OrderState {}
~~~
~~~mermaid
stateDiagram-v2
  [*] --> Created
  Created --> Paid: pay
  Created --> Cancelled: cancel
  Paid --> Shipped: ship
  Paid --> Cancelled: cancel / refund
  Shipped --> [*]
~~~
## Persistence reality
Persist the state as an enum column and enforce transitions in the domain **and** with a conditional update ({{UPDATE orders SET status='PAID' WHERE id=? AND status='CREATED'}}) so concurrent requests cannot both transition. Spring Statemachine exists, but a small explicit state model is usually clearer.
`),
P('command', 'Command', 'intermediate', 'Turn a request into an object: queue it, log it, retry it, undo it.', md`
## Intent
Encapsulate an action with its parameters so it can be queued, scheduled, retried, audited or undone.
~~~java
public interface Command { void execute(); default void undo() { throw new UnsupportedOperationException(); } }

public record TransferCommand(AccountService svc, String from, String to, Money amount, String idempotencyKey) implements Command {
    public void execute() { svc.transfer(from, to, amount, idempotencyKey); }
    public void undo()    { svc.transfer(to, from, amount, idempotencyKey + ":undo"); }
}

public final class CommandBus {
    private final Deque<Command> history = new ArrayDeque<>();
    public void run(Command c) { c.execute(); history.push(c); }
    public void undoLast() { Optional.ofNullable(history.poll()).ifPresent(Command::undo); }
}
~~~
## Where it shows up
{{Runnable}}/{{Callable}} submitted to an {{ExecutorService}}, Kafka messages as serialized commands, CQRS command handlers, the Saga pattern's compensating actions (each step's undo), editor undo/redo, job schedulers.
`)
]);
})();
