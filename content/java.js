(function () {
const md = LAB.md;

LAB.add('java', 'JVM & Memory', [
{ id: 'jvm-architecture', title: 'JVM Architecture', level: 'intermediate', tags: ['jvm', 'classloading', 'jit'],
  summary: 'Class loading, runtime data areas, interpreter + JIT tiers, and what that means for startup and performance.',
  body: md`
## The big picture
~~~mermaid
flowchart LR
  SRC[".java"] -->|javac| BC[".class bytecode"]
  BC --> CL["Class loader subsystem: load -> link (verify, prepare, resolve) -> initialize"]
  CL --> RDA["Runtime data areas: heap, metaspace, per-thread stacks, PC registers, native stacks, code cache"]
  RDA --> EE["Execution engine: interpreter -> C1 -> C2 (tiered JIT), GC"]
  EE --> JNI["JNI / native libraries"]
~~~

## Class loading
- **Delegation model**: Application loader -> Platform loader -> Bootstrap loader. A class is loaded by the first parent that can find it, which prevents user code from replacing {{java.lang.String}}.
- Spring Boot fat jars use a custom {{LaunchedURLClassLoader}} to load nested jars.
- **Static initialisation** runs once, thread-safe, on first active use (this is why the holder-class singleton works).
- {{ClassNotFoundException}} (loading by name failed) vs {{NoClassDefFoundError}} (class was present at compile time but missing or failed static init at runtime).

## Runtime data areas
| Area | Per | Holds | Error when full |
|---|---|---|---|
| Heap | JVM | objects, arrays | {{OutOfMemoryError: Java heap space}} |
| Metaspace (native) | JVM | class metadata | {{OutOfMemoryError: Metaspace}} (classloader leaks) |
| Stack | thread | frames: locals, operand stack | {{StackOverflowError}} |
| Code cache | JVM | JIT-compiled code | JIT stops compiling (performance cliff) |
| Direct memory | JVM | NIO buffers (Netty) | {{OutOfMemoryError: Direct buffer memory}} |

## Execution: interpreter and JIT
Tiered compilation: code starts interpreted, hot methods are compiled by C1 (fast, profiled) then C2 (aggressive optimisation: inlining, escape analysis, loop unrolling). Consequences:
- **Warm-up**: first requests after deploy are slower; use readiness gates, warm-up traffic, or CDS/AOT (Spring Boot 3 AOT + GraalVM native image, CRaC) for fast startup.
- Deoptimisation can happen when assumptions break (a new subclass loaded).

## Production flags worth knowing
~~~bash
java -XX:MaxRAMPercentage=75 -XX:+UseG1GC -Xlog:gc*:file=gc.log:time,uptime \
     -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/dumps -XX:+ExitOnOutOfMemoryError -jar app.jar
~~~

## Interview questions
?? What happens when you run java -jar app.jar?
JVM starts, bootstrap loader loads core classes, the manifest Main-Class (Spring Boot's {{JarLauncher}}) is loaded, which sets up a classloader over nested jars and invokes your {{main}}. Classes are loaded lazily on first use, linked, initialised, interpreted, then JIT-compiled when hot.
?? Your service is slow for the first minute after every deploy. Why and what do you do?
JIT warm-up, lazy class loading, cold caches and connection pools establishing. Use readiness probes that pass only after warm-up, pre-initialise pools, send synthetic warm-up requests, consider CDS/AOT/CRaC.
` },

{ id: 'gc', title: 'Garbage Collection', level: 'advanced', tags: ['gc', 'g1', 'zgc', 'performance'],
  summary: 'Generational hypothesis, G1 vs ZGC vs Parallel, pause vs throughput trade-offs, reading GC logs and fixing memory issues.',
  body: md`
## Core ideas
- **Reachability**: objects reachable from GC roots (thread stacks, static fields, JNI refs) survive; others are garbage.
- **Generational hypothesis**: most objects die young. Young collections are frequent and cheap; old collections are rarer and costlier.
- **Stop-the-world (STW)** pauses vs concurrent phases.

## Collectors
| Collector | Goal | Notes |
|---|---|---|
| Serial | small heaps, single core | containers with < 2 CPUs may default to it |
| Parallel | throughput | batch jobs; longer pauses |
| **G1** (default since JDK 9) | balanced, pause target ({{-XX:MaxGCPauseMillis=200}}) | region-based, mixed collections, humongous objects |
| **ZGC** (generational since JDK 21) | very low pauses (sub-ms to low ms) regardless of heap size | concurrent relocation via load barriers; some CPU/memory overhead |
| Shenandoah | low pause | concurrent compaction |

## Choosing
Latency-sensitive APIs with large heaps: ZGC (JDK 21+ generational) is a strong default; G1 is fine for most services with moderate heaps. Batch/ETL: Parallel. Always measure with your workload.

## Diagnosing memory problems
1. GC logs ({{-Xlog:gc*}}): frequency, pause times, heap after GC trending up = leak.
2. Heap dump on OOM; analyse with Eclipse MAT (dominator tree, leak suspects).
3. Common leaks: static maps/caches without eviction, ThreadLocals in thread pools not removed, listeners not unregistered, classloader leaks on redeploy, unbounded queues.
4. Allocation profiling: JFR + JDK Mission Control, async-profiler.

~~~java
// Classic leak: unbounded static cache
private static final Map<String, byte[]> CACHE = new HashMap<>();   // grows forever
// Fix: bounded cache with eviction
private final Cache<String, byte[]> cache = Caffeine.newBuilder().maximumSize(10_000).expireAfterWrite(Duration.ofMinutes(10)).build();
~~~

## Interview questions
?? p99 latency spikes every few minutes. How do you check if GC is the cause?
Correlate GC pause logs (or JFR GC events / Micrometer {{jvm.gc.pause}}) with latency spikes. If old-gen collections or humongous allocations cause long pauses, tune heap size, reduce allocation rate, fix large object allocations, or move to ZGC.
?? Does calling System.gc() help?
Usually no: it requests a full GC (STW in many collectors), and is often disabled ({{-XX:+DisableExplicitGC}}). Fix the allocation pattern instead.
?? What is a memory leak in a GC'd language?
Objects that are no longer needed but remain reachable (referenced from long-lived structures), so GC cannot reclaim them.
` },

{ id: 'heap-stack', title: 'Heap vs Stack', level: 'beginner', tags: ['memory', 'jvm'],
  summary: 'What lives where, escape analysis, thread stacks, and how this affects concurrency and virtual threads.',
  body: md`
## The difference
| | Stack | Heap |
|---|---|---|
| Owner | each thread | shared by all threads |
| Contains | frames: primitives, references, return addresses | objects and arrays |
| Lifetime | frame popped when method returns | until unreachable and collected |
| Size | small (default ~512 KB-1 MB per platform thread) | large, configured by -Xmx |
| Thread safety | inherently thread-confined | needs synchronisation when shared |

~~~java
void handle(Request req) {
    int count = 0;                       // primitive on the stack
    Order order = new Order(req.id());   // reference on the stack, Order object on the heap
    process(order);
}
~~~
## Escape analysis
If the JIT proves an object never escapes a method, it can scalar-replace it (no heap allocation). This is why short-lived small objects are cheap in modern Java.

## Why it matters for concurrency
Local variables are thread-confined; shared mutable state lives on the heap and needs synchronisation. Lambdas capturing locals require them to be effectively final for this reason.

## Virtual threads (JDK 21)
Virtual thread stacks are stored on the heap as stack chunks and grow as needed, so millions of virtual threads are feasible for blocking I/O workloads, unlike platform threads whose stacks reserve native memory.

?? What causes StackOverflowError and how do you fix it?
Deep or infinite recursion (or very large frames). Fix the recursion (iterative algorithm, tail logic), or increase {{-Xss}} only when the depth is legitimately bounded.
` },

{ id: 'jmm', title: 'Java Memory Model', level: 'advanced', tags: ['jmm', 'volatile', 'happens-before'],
  summary: 'Visibility, ordering and atomicity; happens-before rules; volatile, final, synchronized; safe publication.',
  body: md`
## Three problems the JMM addresses
1. **Visibility**: a write by one thread may not be seen by another (CPU caches, registers, compiler reordering).
2. **Ordering**: compiler/CPU may reorder instructions as long as single-thread semantics hold.
3. **Atomicity**: {{count++}} is read-modify-write; {{long}}/{{double}} writes may tear without volatile (on some platforms).

## Happens-before rules (the ones you use)
- Program order within a thread.
- **Monitor lock**: unlock happens-before every subsequent lock of the same monitor.
- **volatile**: a write happens-before every subsequent read of that variable.
- **Thread start/join**: {{start()}} happens-before actions in the new thread; thread actions happen-before {{join()}} returns.
- **final fields**: correctly constructed objects' final fields are visible without synchronisation (if {{this}} does not escape the constructor).
- Concurrent utilities ({{ConcurrentHashMap.put}} -> {{get}}, {{BlockingQueue}}, {{CompletableFuture.complete}}) document happens-before.

## volatile is not atomic
~~~java
class Flag { volatile boolean running = true; void stop() { running = false; } }   // correct: visibility only

class Counter { volatile int c; void inc() { c++; } }    // WRONG: lost updates
class Counter2 { final AtomicInteger c = new AtomicInteger(); void inc() { c.incrementAndGet(); } } // CAS
class Counter3 { final LongAdder c = new LongAdder(); void inc() { c.increment(); } }              // high contention
~~~

## Safe publication
Publish an object via a final field, a volatile field, a properly locked field, static initialiser, or a concurrent collection. Otherwise another thread may see a partially constructed object (the double-checked locking bug without volatile).

## Interview questions
?? Why does double-checked locking need volatile?
{{instance = new X()}} can be reordered so the reference is published before the constructor finishes. Another thread sees non-null and uses a half-initialised object. volatile forbids that reordering and gives visibility.
?? Is a HashMap safe if one thread writes once at startup and others only read afterwards?
Only if it is safely published (e.g. assigned to a final/volatile field after population, or populated before threads start). Unsafe publication can expose inconsistent internal state.
` }
]);

LAB.add('java', 'Concurrency', [
{ id: 'multithreading', title: 'Multithreading Fundamentals', level: 'intermediate', tags: ['threads', 'virtual-threads'],
  summary: 'Thread lifecycle, platform vs virtual threads, interruption, deadlock/livelock/starvation and how to diagnose them.',
  body: md`
## Thread states
NEW -> RUNNABLE -> (BLOCKED on monitor | WAITING | TIMED_WAITING) -> TERMINATED. Thread dumps ({{jstack}}, {{jcmd Thread.print}}) show these states and the locks held/waited on.

## Platform vs virtual threads (JDK 21)
| | Platform thread | Virtual thread |
|---|---|---|
| Mapping | 1:1 OS thread | many:few carrier threads |
| Cost | ~MB stack, expensive creation | cheap, millions feasible |
| Best for | CPU-bound work | blocking I/O (JDBC, HTTP) per request |
| Caveat | pool sizing | pinning inside {{synchronized}} blocks during blocking calls (improved in JDK 24), ThreadLocal-heavy code, still limited by DB connections |

~~~yaml
spring:
  threads:
    virtual:
      enabled: true    # Spring Boot 3.2+: Tomcat requests, @Async, scheduling on virtual threads
~~~
> **Pitfall** Virtual threads remove thread limits, not resource limits. 10,000 concurrent requests still compete for 20 DB connections; add bulkheads/semaphores.

## Interruption
Cooperative cancellation: blocking methods throw {{InterruptedException}}; restore the flag if you cannot propagate it.
~~~java
try { queue.take(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); return; }
~~~

## Liveness problems
- **Deadlock**: circular wait on locks. Prevent with lock ordering, {{tryLock}} with timeout.
- **Livelock**: threads keep reacting to each other without progress (retry without backoff).
- **Starvation**: some threads never get CPU/lock (unfair locks, priority).

?? How do you find a deadlock in production?
Take a thread dump; the JVM reports "Found one Java-level deadlock" with the threads and locks involved. {{ThreadMXBean.findDeadlockedThreads()}} can be exposed as a health check.
?? Should you switch everything to virtual threads?
For I/O-bound request-per-thread services it often helps throughput with minimal code change. Check for pinning, large ThreadLocal usage, and downstream limits; load test before and after.
` },

{ id: 'executor-service', title: 'ExecutorService & Thread Pools', level: 'intermediate', tags: ['executors', 'thread-pools'],
  summary: 'ThreadPoolExecutor parameters, queue choices, rejection policies, sizing, shutdown and Spring TaskExecutor.',
  body: md`
## ThreadPoolExecutor anatomy
{{corePoolSize}}, {{maximumPoolSize}}, {{keepAliveTime}}, {{workQueue}}, {{threadFactory}}, {{RejectedExecutionHandler}}.

Execution order: start core threads; then queue tasks; only when the queue is full grow to max; then reject. Therefore an **unbounded queue means max size is never used** and memory can explode.

~~~java
ThreadPoolExecutor pool = new ThreadPoolExecutor(
    16, 32, 60, TimeUnit.SECONDS,
    new ArrayBlockingQueue<>(1_000),                        // bounded: backpressure
    Thread.ofPlatform().name("report-", 0).factory(),
    new ThreadPoolExecutor.CallerRunsPolicy());             // slow the producer instead of dropping
~~~

## Avoid the Executors.* traps
- {{newFixedThreadPool}} and {{newSingleThreadExecutor}} use unbounded {{LinkedBlockingQueue}} (OOM risk).
- {{newCachedThreadPool}} creates unbounded threads.
Construct {{ThreadPoolExecutor}} explicitly in production code.

## Sizing
- CPU-bound: about number of cores (+1).
- I/O-bound: cores × (1 + wait time / compute time) (Little's law reasoning), capped by downstream limits. Or use virtual threads for I/O.

## Shutdown
~~~java
pool.shutdown();
if (!pool.awaitTermination(30, TimeUnit.SECONDS)) pool.shutdownNow();   // interrupts running tasks
~~~

## Spring
~~~java
@Bean ThreadPoolTaskExecutor reportExecutor() {
  var e = new ThreadPoolTaskExecutor();
  e.setCorePoolSize(8); e.setMaxPoolSize(16); e.setQueueCapacity(500);
  e.setThreadNamePrefix("report-"); e.setTaskDecorator(new MdcTaskDecorator());   // propagate MDC/trace context
  e.setWaitForTasksToCompleteOnShutdown(true); e.setAwaitTerminationSeconds(30);
  return e;
}
@Async("reportExecutor") public CompletableFuture<Report> build(Long id) { ... }
~~~

?? What happens to exceptions thrown in tasks submitted with execute() vs submit()?
{{execute}}: propagates to the thread's uncaught exception handler (logged). {{submit}}: captured in the Future; silently lost if nobody calls {{get()}}.
?? Why name your threads?
Thread dumps, logs and profilers become readable; you can see which pool is saturated during an incident.
` },

{ id: 'completable-future', title: 'CompletableFuture', level: 'intermediate', tags: ['async', 'composition'],
  summary: 'Composing async calls, thenApply vs thenCompose, combining, timeouts, error handling and executor choice.',
  body: md`
## Composition operators
| Method | Use |
|---|---|
| {{thenApply}} | transform result (sync function) |
| {{thenCompose}} | chain another async call (flatMap) |
| {{thenCombine}} | combine two independent futures |
| {{allOf / anyOf}} | wait for all / first |
| {{exceptionally / handle / whenComplete}} | recover / transform both outcomes / side effects |
| {{orTimeout / completeOnTimeout}} | JDK 9+ timeouts |

## Example: parallel fan-out with timeouts and fallbacks
~~~java
public ProductPage page(long id) {
  var product = supplyAsync(() -> catalog.get(id), ioPool);
  var price   = supplyAsync(() -> pricing.price(id), ioPool).orTimeout(300, MILLISECONDS);
  var reviews = supplyAsync(() -> reviewsClient.top(id), ioPool)
                  .completeOnTimeout(List.of(), 200, MILLISECONDS)        // optional section
                  .exceptionally(ex -> { log.warn("reviews failed", ex); return List.of(); });
  return product.thenCombine(price, ProductPage::new)
                .thenCombine(reviews, ProductPage::withReviews)
                .join();
}
~~~

## Pitfalls
- Default executor is {{ForkJoinPool.commonPool()}} (sized to CPU cores): blocking I/O there starves everything else. Pass an executor (or use virtual threads).
- {{join()}} on a request thread negates async benefits unless you are just parallelising.
- Exceptions are wrapped in {{CompletionException}}; unwrap with {{getCause()}}.
- Context (MDC, security context, tracing) does not propagate automatically.

?? thenApply vs thenCompose?
{{thenApply(f)}} where {{f}} returns a value gives {{CF<T>}}; if {{f}} returns a CF you would get {{CF<CF<T>>}}. {{thenCompose}} flattens it.
?? How do you cancel the remaining calls once one fails?
{{allOf}} does not cancel others. Track futures and cancel them in an {{exceptionally}} handler, or use structured concurrency ({{StructuredTaskScope.ShutdownOnFailure}}) in newer JDKs.
` },

{ id: 'locks', title: 'Synchronization & Locks', level: 'advanced', tags: ['synchronized', 'reentrantlock', 'stampedlock'],
  summary: 'synchronized vs ReentrantLock vs ReadWriteLock vs StampedLock, conditions, fairness, and lock-free alternatives.',
  body: md`
## Options
| Tool | Features | Use |
|---|---|---|
| {{synchronized}} | simple, reentrant, auto-release | short critical sections |
| {{ReentrantLock}} | tryLock with timeout, interruptible, fairness, multiple Conditions | need timeout/cancellation |
| {{ReentrantReadWriteLock}} | many readers or one writer | read-mostly data |
| {{StampedLock}} | optimistic reads | very read-heavy, careful use (not reentrant) |
| {{Semaphore}} | limit concurrency | bulkheads, connection limits |
| Atomics / CAS | lock-free single variable | counters, state flags |

~~~java
private final ReentrantLock lock = new ReentrantLock();
public boolean transfer(Account a, Account b, long amt) throws InterruptedException {
  Account first = a.id() < b.id() ? a : b, second = first == a ? b : a;   // ordering prevents deadlock
  if (!first.lock().tryLock(100, MILLISECONDS)) return false;
  try {
    if (!second.lock().tryLock(100, MILLISECONDS)) return false;
    try { a.debit(amt); b.credit(amt); return true; } finally { second.lock().unlock(); }
  } finally { first.lock().unlock(); }
}

// Optimistic read with StampedLock
double distanceFromOrigin() {
  long stamp = sl.tryOptimisticRead();
  double cx = x, cy = y;
  if (!sl.validate(stamp)) { stamp = sl.readLock(); try { cx = x; cy = y; } finally { sl.unlockRead(stamp); } }
  return Math.hypot(cx, cy);
}
~~~

## Condition variables
{{wait/notify}} (with synchronized) or {{Condition.await/signal}} (with locks). Always wait in a loop checking the predicate (spurious wakeups).

?? What does synchronized lock on?
The monitor of an object: {{this}} for instance methods, the {{Class}} object for static methods, or the given object. Locking on a publicly accessible object (or a String literal/boxed Integer) invites accidental contention.
?? Why must unlock be in finally?
Exceptions would leave the lock held forever, deadlocking other threads.
` },

{ id: 'concurrent-collections', title: 'Concurrent Collections', level: 'intermediate', tags: ['concurrenthashmap', 'queues'],
  summary: 'ConcurrentHashMap internals and atomic ops, CopyOnWrite, BlockingQueues, ConcurrentSkipListMap and when to use each.',
  body: md`
## ConcurrentHashMap
- Java 8+: array of bins; CAS for empty bins, synchronized on the bin head for collisions; bins convert to trees beyond a threshold. Reads are lock-free.
- Use **atomic compound operations**: {{computeIfAbsent}}, {{compute}}, {{merge}}, {{putIfAbsent}}.
- Do not do long work inside {{computeIfAbsent}} (it holds the bin lock) and never modify the map recursively within it.
~~~java
ConcurrentHashMap<String, LongAdder> hits = new ConcurrentHashMap<>();
hits.computeIfAbsent(route, k -> new LongAdder()).increment();       // atomic, contention-friendly
counts.merge(word, 1, Integer::sum);
~~~
- {{size()}} is an estimate under concurrency; null keys/values are not allowed (ambiguity of get returning null).

## Others
| Collection | Characteristics | Use |
|---|---|---|
| {{CopyOnWriteArrayList}} | copy on every write, snapshot iteration | listeners, rarely changing config |
| {{ArrayBlockingQueue}} | bounded, one lock | producer-consumer with backpressure |
| {{LinkedBlockingQueue}} | optionally bounded, two locks | throughput; set capacity |
| {{ConcurrentLinkedQueue}} | lock-free, unbounded | non-blocking handoff |
| {{ConcurrentSkipListMap}} | sorted, concurrent | leaderboards, time-ordered indexes |
| {{DelayQueue}} | elements available after delay | retries, expiry |

?? Collections.synchronizedMap vs ConcurrentHashMap?
synchronizedMap uses one lock for all operations (contention) and iteration requires manual locking; ConcurrentHashMap allows concurrent reads/writes and weakly consistent iteration without ConcurrentModificationException.
?? Is iterating a ConcurrentHashMap while others write safe?
Yes: iterators are weakly consistent (reflect some state at or after creation, never throw CME), but may or may not see concurrent updates.
` }
]);

LAB.add('java', 'Modern Java', [
{ id: 'java8-features', title: 'Java 8+ Features (to 21)', level: 'beginner', tags: ['lambdas', 'records', 'sealed', 'optional'],
  summary: 'Lambdas, Optional, java.time, records, sealed types, pattern matching, text blocks and virtual threads, with idiomatic usage.',
  body: md`
## What seniors are expected to use fluently
| Version | Feature | Idiomatic use |
|---|---|---|
| 8 | Lambdas, method refs, Streams, Optional, java.time, default methods, CompletableFuture | functional pipelines; Instant/ZonedDateTime instead of Date |
| 9-11 | {{List.of}}, {{var}}, HttpClient, {{String.isBlank/strip/lines}} | immutable collections; local inference |
| 14-16 | switch expressions, records, text blocks | DTOs/value objects as records |
| 17 (LTS) | sealed classes, pattern matching for instanceof | closed hierarchies |
| 21 (LTS) | virtual threads, pattern matching for switch, record patterns, sequenced collections | I/O concurrency; exhaustive switches |

~~~java
public sealed interface PaymentEvent permits Authorized, Declined, Refunded {}
public record Authorized(String id, long amount) implements PaymentEvent {}
public record Declined(String id, String reason) implements PaymentEvent {}
public record Refunded(String id, long amount) implements PaymentEvent {}

String describe(PaymentEvent e) {
  return switch (e) {                                   // exhaustive: compiler error if a new type is added
    case Authorized(var id, var amt) when amt > 1_000_000 -> "Large auth " + id;
    case Authorized a -> "Auth " + a.id();
    case Declined d   -> "Declined: " + d.reason();
    case Refunded r   -> "Refund " + r.amount();
  };
}
~~~

## Optional done right
Use as a return type for "may be absent". Do not use for fields, parameters, or collections; never call {{get()}} without checking; prefer {{map/orElseThrow}}.
~~~java
return repo.findByEmail(email).map(mapper::toDto).orElseThrow(() -> new UserNotFound(email));
~~~

## java.time
{{Instant}} for timestamps (UTC), {{LocalDate}} for dates without zone (birthdays), {{ZonedDateTime}} with explicit {{ZoneId.of("Asia/Dubai")}} for user-facing schedules. Inject a {{Clock}} for testability.

?? Records vs Lombok @Value?
Records are language-level immutable data carriers with canonical constructors, equals/hashCode/toString and pattern-matching support. Not suitable as JPA entities (need no-arg constructor, mutability, proxies) but excellent for DTOs, events, value objects.
` },

{ id: 'streams', title: 'Streams & Functional Programming', level: 'intermediate', tags: ['streams', 'collectors', 'functional'],
  summary: 'Laziness, collectors (groupingBy, toMap), parallel streams caveats, side-effect pitfalls and performance.',
  body: md`
## Mental model
A stream is a lazy pipeline: source -> intermediate ops (lazy) -> terminal op (triggers execution). Elements flow one at a time through the pipeline (short-circuiting possible).

~~~java
Map<String, BigDecimal> revenueByCity = orders.stream()
    .filter(o -> o.status() == Status.DELIVERED)
    .collect(Collectors.groupingBy(Order::city, TreeMap::new,
             Collectors.reducing(BigDecimal.ZERO, Order::total, BigDecimal::add)));

Map<String, User> byEmail = users.stream()
    .collect(Collectors.toMap(User::email, Function.identity(), (a, b) -> a));   // merge fn avoids IllegalStateException on duplicates

List<String> top3 = products.stream().sorted(comparing(Product::rating).reversed()).limit(3).map(Product::name).toList();
~~~

## Pitfalls
- **Side effects** in {{map/filter}} (mutating external lists) break with parallel streams and obscure logic.
- {{toMap}} throws on duplicate keys without a merge function.
- **Parallel streams** use the common ForkJoinPool: bad for blocking I/O, beneficial only for large CPU-bound workloads with cheap splitting (ArrayList, arrays), and order-dependent ops cost more.
- Streams cannot be reused after a terminal operation.
- Checked exceptions inside lambdas need wrapping; consider a loop when it is clearer.
- Boxing overhead: use {{IntStream/LongStream}} for numeric work.

## Functional interfaces
{{Function}}, {{BiFunction}}, {{Supplier}}, {{Consumer}}, {{Predicate}}, {{UnaryOperator}}; compose with {{andThen/compose/and/or/negate}}.

?? When is a for-loop better than a stream?
When the logic has early exits with complex state, checked exceptions, or when performance-critical tight loops show measurable overhead. Readability is the main criterion.
?? What does flatMap do?
Maps each element to a stream and flattens the results into one stream (e.g. orders -> order lines).
` }
]);

LAB.add('java', 'Spring Core', [
{ id: 'spring-ioc', title: 'Spring IoC & Dependency Injection', level: 'intermediate', tags: ['spring', 'ioc', 'beans'],
  summary: 'ApplicationContext, bean definitions, component scanning, @Configuration proxies, scopes, conditional beans and proxies.',
  body: md`
## How the container works
1. Read configuration: component scanning ({{@Component}}, {{@Service}}...), {{@Configuration}} classes, auto-configuration imports.
2. Register **BeanDefinitions** (metadata: class, scope, dependencies, init/destroy).
3. Run **BeanFactoryPostProcessors** (e.g. property placeholder resolution, configuration class parsing).
4. Instantiate singletons eagerly, inject dependencies, run **BeanPostProcessors** (this is where AOP proxies for {{@Transactional}}, {{@Async}}, {{@Cacheable}} are created).
5. Context refreshed, {{ApplicationReadyEvent}} fired.

## @Configuration vs @Component @Bean methods
{{@Configuration}} classes are CGLIB-proxied so calling one {{@Bean}} method from another returns the singleton (full mode). In {{@Component}} (lite mode) or {{proxyBeanMethods=false}}, direct calls create new instances; Spring Boot's own auto-config uses {{proxyBeanMethods=false}} for startup speed and injects via parameters instead.

## Injecting collections and choosing beans
~~~java
@Service class PaymentRouter {
  private final Map<String, PaymentProvider> providers;          // bean name -> bean
  PaymentRouter(Map<String, PaymentProvider> providers) { this.providers = providers; }
}
@Bean @ConditionalOnProperty(prefix = "payments", name = "provider", havingValue = "checkout")
PaymentProvider checkout(...) { ... }
@Bean @ConditionalOnMissingBean PaymentProvider noop() { return new NoopProvider(); }  // overridable default
~~~

## Scopes
singleton (default), prototype, request, session, application, websocket. Injecting shorter-lived beans into singletons requires {{ObjectProvider}} or scoped proxies.

?? BeanFactory vs ApplicationContext?
ApplicationContext extends BeanFactory with eager singleton instantiation, event publishing, internationalisation, environment/profiles, resource loading and automatic post-processor registration.
?? How do you resolve "expected single matching bean but found 2"?
{{@Primary}} for the default, {{@Qualifier}} at injection, inject {{List/Map}} and choose at runtime, or conditional beans so only one exists per environment.
` },

{ id: 'bean-lifecycle', title: 'Spring Bean Lifecycle', level: 'intermediate', tags: ['spring', 'lifecycle'],
  summary: 'Instantiation to destruction, the order of Aware, BeanPostProcessor, @PostConstruct, InitializingBean, SmartLifecycle and shutdown hooks.',
  body: md`
## Order of events for a singleton
1. Instantiate (constructor injection).
2. Populate properties (setter/field injection).
3. Aware callbacks ({{BeanNameAware}}, {{ApplicationContextAware}}...).
4. {{BeanPostProcessor.postProcessBeforeInitialization}}.
5. {{@PostConstruct}} -> {{InitializingBean.afterPropertiesSet()}} -> custom {{initMethod}}.
6. {{BeanPostProcessor.postProcessAfterInitialization}} (**proxies are created here**, so the bean you get injected may be a proxy).
7. Bean in use. {{SmartLifecycle.start()}} after context refresh (e.g. start Kafka listeners).
8. On shutdown: {{SmartLifecycle.stop()}} (in phase order), {{@PreDestroy}} -> {{DisposableBean.destroy()}} -> {{destroyMethod}}.

~~~java
@Component
class CacheWarmer implements SmartLifecycle {
  private volatile boolean running;
  @PostConstruct void validateConfig() { /* fail fast on bad config */ }
  public void start() { warmCaches(); running = true; }          // after all beans ready
  public void stop() { running = false; }
  public boolean isRunning() { return running; }
  public int getPhase() { return 0; }
}
~~~

## Pitfalls
- Calling a {{@Transactional}} method from {{@PostConstruct}}: the proxy may not be fully applied for self-calls; use {{ApplicationReadyEvent}} listeners or SmartLifecycle for work that needs the full context.
- Long blocking work in {{@PostConstruct}} slows startup and can fail readiness; do it asynchronously or in a lifecycle bean with readiness signalling.

?? Where are AOP proxies created and why does it matter?
In {{postProcessAfterInitialization}} by {{AbstractAutoProxyCreator}}. Inside the bean's own {{@PostConstruct}}, {{this}} is the raw target, so advice does not apply to self-invocations.
` },

{ id: 'auto-configuration', title: 'Spring Boot Auto-configuration', level: 'intermediate', tags: ['spring-boot', 'autoconfig', 'starters'],
  summary: 'How starters and conditional configuration work, ordering, overriding defaults, and writing your own starter.',
  body: md`
## Mechanism
- {{@SpringBootApplication}} = {{@Configuration}} + {{@ComponentScan}} + {{@EnableAutoConfiguration}}.
- Auto-config classes are listed in {{META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports}} (Boot 2.7+/3).
- Each is guarded by conditions: {{@ConditionalOnClass}} (library on classpath), {{@ConditionalOnMissingBean}} (you did not define one), {{@ConditionalOnProperty}}, {{@ConditionalOnWebApplication}}...
- User configuration is processed first, so your beans win over auto-configured defaults.

## Debugging
Run with {{--debug}} (condition evaluation report) or {{/actuator/conditions}} to see which auto-configs matched and why.

## Writing a custom starter (e.g. company OTP client)
~~~java
@AutoConfiguration
@ConditionalOnClass(OtpClient.class)
@EnableConfigurationProperties(OtpProperties.class)
public class OtpAutoConfiguration {
  @Bean @ConditionalOnMissingBean
  OtpClient otpClient(OtpProperties p, RestClient.Builder b) { return new OtpClient(b.baseUrl(p.baseUrl()).build(), p); }
}
// resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports:
// com.acme.otp.OtpAutoConfiguration
~~~

## Externalised configuration precedence (simplified, highest first)
Command-line args > environment variables > profile-specific application-{profile}.yml > application.yml > defaults. Kubernetes secrets/config typically via env vars or mounted config trees.

?? How do you disable a specific auto-configuration?
{{@SpringBootApplication(exclude = DataSourceAutoConfiguration.class)}} or {{spring.autoconfigure.exclude}} property; better, define your own bean so {{@ConditionalOnMissingBean}} backs off.
` },

{ id: 'mvc-lifecycle', title: 'Spring MVC Request Lifecycle', level: 'intermediate', tags: ['spring-mvc', 'dispatcherservlet', 'filters'], viz: 'spring-request',
  summary: 'From Tomcat thread to response: filters, DispatcherServlet, HandlerMapping, interceptors, argument resolvers, converters and exception handling.',
  body: md`
## The path of a request
~~~mermaid
sequenceDiagram
  participant T as Tomcat (NIO connector, worker thread)
  participant F as Filter chain (incl. Spring Security)
  participant D as DispatcherServlet
  participant HM as HandlerMapping
  participant I as HandlerInterceptors
  participant HA as HandlerAdapter
  participant C as @RestController
  participant S as Service (@Transactional proxy)
  T->>F: HttpServletRequest
  F->>D: doFilter (if authenticated/allowed)
  D->>HM: find handler for path + method
  D->>I: preHandle
  D->>HA: invoke: resolve args (@PathVariable, @RequestBody via HttpMessageConverter, @Valid)
  HA->>C: method call
  C->>S: business logic
  S-->>C: result
  C-->>HA: return value
  HA-->>D: write body via HttpMessageConverter (Jackson)
  D->>I: postHandle / afterCompletion
  D-->>F: response
  F-->>T: response committed
~~~

## Key components
- **Filters** (servlet level): security, CORS, request logging, tracing. Run before Spring MVC knows the handler.
- **HandlerMapping**: {{RequestMappingHandlerMapping}} matches {{@GetMapping}} etc.
- **HandlerInterceptor**: preHandle/postHandle/afterCompletion with access to the handler (e.g. tenant resolution, timing).
- **HandlerMethodArgumentResolver**: binds parameters; custom resolvers e.g. {{@CurrentUser}}.
- **HttpMessageConverter**: JSON (Jackson) in/out.
- **Exception handling**: {{@RestControllerAdvice}} + {{@ExceptionHandler}}, producing RFC 7807 {{ProblemDetail}}.

~~~java
@RestControllerAdvice
class ApiErrors {
  @ExceptionHandler(MethodArgumentNotValidException.class)
  ProblemDetail invalid(MethodArgumentNotValidException ex) {
    ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, "Validation failed");
    pd.setProperty("errors", ex.getFieldErrors().stream().map(f -> Map.of("field", f.getField(), "message", f.getDefaultMessage())).toList());
    return pd;
  }
  @ExceptionHandler(OrderNotFoundException.class)
  ProblemDetail notFound(OrderNotFoundException ex) { return ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, ex.getMessage()); }
}
~~~

?? Filter vs interceptor: which for what?
Filters for cross-cutting concerns independent of Spring MVC (security, CORS, compression, tracing), and they run for all servlet requests. Interceptors when you need handler information or MVC-specific behaviour.
?? Why does an exception thrown in a filter not reach @ControllerAdvice?
ControllerAdvice handles exceptions from handler execution within DispatcherServlet. Filter exceptions happen outside it; handle them in the filter (Spring Security uses AuthenticationEntryPoint/AccessDeniedHandler) or forward to the error controller.
` },

{ id: 'spring-security', title: 'Spring Security', level: 'advanced', tags: ['spring-security', 'oauth2', 'jwt'], viz: 'spring-request',
  summary: 'SecurityFilterChain architecture, authentication vs authorization, resource server with JWT, method security and common mistakes.',
  body: md`
## Architecture
- {{DelegatingFilterProxy}} -> {{FilterChainProxy}} -> one or more {{SecurityFilterChain}}s selected by request matcher.
- Important filters (in order): CORS, CSRF, logout, {{BearerTokenAuthenticationFilter}} / {{UsernamePasswordAuthenticationFilter}}, {{ExceptionTranslationFilter}}, {{AuthorizationFilter}}.
- {{AuthenticationManager}} -> {{AuthenticationProvider}}s; result stored in {{SecurityContextHolder}} (ThreadLocal by default).

## Resource server with Keycloak/Cognito JWTs
~~~java
@Bean SecurityFilterChain api(HttpSecurity http) throws Exception {
  return http
    .csrf(AbstractHttpConfigurer::disable)
    .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
    .authorizeHttpRequests(a -> a
        .requestMatchers("/actuator/health/**").permitAll()
        .requestMatchers("/admin/**").hasRole("ADMIN")
        .anyRequest().authenticated())
    .oauth2ResourceServer(o -> o.jwt(j -> j.jwtAuthenticationConverter(keycloakRoles())))
    .build();
}

// Keycloak puts realm roles in realm_access.roles; map them to ROLE_ authorities
Converter<Jwt, AbstractAuthenticationToken> keycloakRoles() {
  return jwt -> {
    Collection<String> roles = Optional.ofNullable(jwt.getClaimAsMap("realm_access"))
        .map(m -> (Collection<String>) m.get("roles")).orElse(List.of());
    var auths = roles.stream().map(r -> new SimpleGrantedAuthority("ROLE_" + r)).collect(Collectors.toSet());
    return new JwtAuthenticationToken(jwt, auths, jwt.getClaimAsString("preferred_username"));
  };
}
~~~
~~~yaml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://idp.example.com/realms/retail     # discovers JWKS, validates iss + exp
          audiences: orders-api                                   # Boot 3.1+: validate aud
~~~

## Method security
{{@EnableMethodSecurity}}; {{@PreAuthorize("hasAuthority('SCOPE_orders:write')")}}, {{@PostAuthorize}} for ownership checks, or custom beans {{@PreAuthorize("@orderAuth.canView(#id, authentication)")}}.

## Common mistakes
- Disabling CSRF for a cookie-session browser app (CSRF matters when the browser sends credentials automatically).
- Not validating audience: a token minted for another API is accepted.
- Using {{hasRole("ROLE_ADMIN")}} (double prefix) or mixing roles/authorities.
- Relying only on URL rules and forgetting object-level authorization.
- SecurityContext not propagated to {{@Async}} threads ({{DelegatingSecurityContextExecutor}}).

?? How does Spring Security return 401 vs 403?
{{ExceptionTranslationFilter}}: {{AuthenticationException}} (no/invalid credentials) -> AuthenticationEntryPoint -> 401 with WWW-Authenticate; {{AccessDeniedException}} for authenticated users lacking permission -> 403.
?? How do you test secured endpoints?
{{@WebMvcTest}} with {{SecurityMockMvcRequestPostProcessors.jwt().authorities(...)}} or {{@WithMockUser}}; test both allowed and forbidden cases, including another user's resource.
` }
]);

LAB.add('java', 'Data & Transactions', [
{ id: 'rest-api-design', title: 'REST API Design', level: 'intermediate', tags: ['rest', 'http', 'api'],
  summary: 'Resource modelling, status codes, pagination, idempotency, versioning, validation and error format.',
  body: md`
## Principles that interviewers check
- Resources as nouns ({{/orders/{id}/items}}), HTTP verbs with correct semantics (GET safe, PUT/DELETE idempotent, POST create/commands, PATCH partial).
- Status codes: 200/201 (+Location)/202 (async)/204; 400 validation, 401 unauthenticated, 403 forbidden, 404, 409 conflict (state/version), 412 precondition failed (ETag), 422 semantic error, 429 throttled; 5xx server.
- **Pagination**: cursor-based for large/changing datasets; limit max page size.
- **Idempotency-Key** for POSTs that create money-moving resources.
- **Concurrency control**: ETag + If-Match or version field to prevent lost updates.
- **Versioning**: URI ({{/v1}}) or header; prefer additive, backward-compatible evolution.
- **Errors**: consistent RFC 7807 problem+json with a machine-readable type and correlation id.
- Long operations: 202 Accepted + status resource / webhook.

~~~java
@PostMapping("/orders")
public ResponseEntity<OrderDto> create(@Valid @RequestBody CreateOrder req, UriComponentsBuilder uri) {
  OrderDto o = service.create(req);
  return ResponseEntity.created(uri.path("/orders/{id}").build(o.id())).eTag("\"" + o.version() + "\"").body(o);
}

@PatchMapping("/orders/{id}")
public OrderDto update(@PathVariable UUID id, @RequestHeader("If-Match") String etag, @Valid @RequestBody UpdateOrder req) {
  return service.update(id, Long.parseLong(etag.replace("\"", "")), req);   // 412 if version mismatch
}

@GetMapping("/orders")
public Page<OrderDto> list(@RequestParam(required = false) String cursor, @RequestParam(defaultValue = "20") @Max(100) int limit) { ... }
~~~

?? PUT vs PATCH?
PUT replaces the resource representation (idempotent); PATCH applies a partial change (JSON Merge Patch or JSON Patch); PATCH is not necessarily idempotent (e.g. "increment").
?? How do you design an API for a long-running report?
POST returns 202 with a job resource URL; client polls GET /jobs/{id} or receives a webhook; result available at a download link (signed URL).
` },

{ id: 'jpa-hibernate', title: 'JPA & Hibernate Internals', level: 'advanced', tags: ['jpa', 'hibernate', 'persistence-context'],
  summary: 'Persistence context, entity states, dirty checking, flush modes, lazy loading proxies, fetch strategies and batching.',
  body: md`
## Persistence context (first-level cache)
Within a transaction/session, each entity row is represented by one managed instance. {{find}} twice returns the same object; changes to managed entities are **automatically flushed** (dirty checking) at commit or before queries that might be affected.

## Entity states
Transient (new, not managed) -> Managed ({{persist}}/{{find}}) -> Detached (after session closes / {{detach}}) -> Removed ({{remove}}). {{merge}} copies a detached state onto a managed instance and returns that managed instance.

## Dirty checking and flush
At flush Hibernate compares current state with the loaded snapshot and issues UPDATEs. Implications: no need to call {{save}} on managed entities; large persistence contexts make flush slow (clear periodically in batch jobs); {{@DynamicUpdate}} to update only changed columns.

## Fetching
- {{@ManyToOne}}/{{@OneToOne}} default EAGER; set **LAZY** explicitly. Collections default LAZY.
- Lazy associations are proxies; accessing them outside a session throws {{LazyInitializationException}}. Do not "fix" with Open Session In View in APIs ({{spring.jpa.open-in-view=false}}); fetch what you need explicitly.
- Fetch strategies: {{JOIN FETCH}}, {{@EntityGraph}}, {{@BatchSize}} / {{hibernate.default_batch_fetch_size}}, DTO projections.

## Write performance
~~~yaml
spring:
  jpa:
    open-in-view: false
    properties:
      hibernate:
        jdbc.batch_size: 50
        order_inserts: true
        order_updates: true
        default_batch_fetch_size: 100
~~~
{{GenerationType.IDENTITY}} disables JDBC insert batching (needs the id immediately); prefer {{SEQUENCE}} with a pooled optimizer.

## Second-level cache
Shared across sessions (e.g. Ehcache/Hazelcast/Redis via JCache) for read-mostly reference data; invalidation across nodes and stale data are the trade-offs.

?? Why do updates happen even though I never called save()?
The entity is managed; dirty checking flushes changes at commit. If you do not want writes, use read-only transactions/queries or detach.
?? equals/hashCode for entities?
Avoid using generated ids before persist (null/changes) and avoid all fields (lazy loading). Use a natural business key or a UUID assigned at construction, or the id with null-safe handling and a constant hashCode.
` },

{ id: 'transactions', title: 'Transaction Management in Spring', level: 'advanced', tags: ['transactional', 'propagation', 'rollback'],
  summary: '@Transactional proxies, propagation, rollback rules, readOnly, self-invocation and transactions with messaging.',
  body: md`
## How @Transactional works
A proxy intercepts the call, obtains a transaction from the {{PlatformTransactionManager}} (binding a connection to the thread), invokes the method, then commits or rolls back.

## Rollback rules
By default rollback on **unchecked** exceptions (RuntimeException, Error), **not** on checked exceptions. Use {{rollbackFor = Exception.class}} when needed. Catching an exception inside the method prevents rollback unless you rethrow or call {{setRollbackOnly}}.

## Propagation
| Propagation | Behaviour | Use |
|---|---|---|
| REQUIRED (default) | join existing or create | most service methods |
| REQUIRES_NEW | suspend current, start new | audit log that must persist even if outer rolls back |
| NESTED | savepoint within current (JDBC) | partial rollback |
| SUPPORTS / NOT_SUPPORTED / MANDATORY / NEVER | special cases | |

> **Pitfall** An inner REQUIRED method that throws marks the shared transaction rollback-only; the outer catching it still gets {{UnexpectedRollbackException}} at commit.

## readOnly
{{@Transactional(readOnly = true)}} hints the driver/DB, lets Hibernate skip dirty checking (flush mode MANUAL), and can route to replicas with a routing DataSource.

## Self-invocation and visibility
- Calls within the same bean bypass the proxy.
- Only public methods are advised (Spring 6 also supports protected/package with CGLIB, but keep it public).
- Keep transactions short: no remote calls (HTTP, Kafka send with waiting) inside DB transactions.

## Transactions and messaging
~~~java
@Transactional
public void placeOrder(Cmd c) {
  orders.save(...);
  outbox.save(...);                                    // same DB transaction: reliable
}

@TransactionalEventListener(phase = AFTER_COMMIT)      // run side effects only after commit
public void afterCommit(OrderPlaced e) { cacheEvict(e.id()); }
~~~

?? @Transactional on a private method: what happens?
Nothing: proxies cannot intercept private methods, so no transaction starts (silently).
?? How do you do a transaction programmatically?
{{TransactionTemplate.execute(status -> { ... })}}, useful inside loops (one transaction per batch) or when self-invocation is unavoidable.
` },

{ id: 'isolation-levels', title: 'Transaction Isolation Levels', level: 'advanced', tags: ['isolation', 'mvcc', 'anomalies'],
  summary: 'Dirty reads, non-repeatable reads, phantoms, lost updates and write skew; what Postgres/MySQL actually do; choosing locking strategies.',
  body: md`
## Anomalies
| Anomaly | Description |
|---|---|
| Dirty read | read uncommitted data of another transaction |
| Non-repeatable read | same row read twice returns different values |
| Phantom read | same query returns new rows |
| Lost update | two read-modify-write cycles overwrite each other |
| Write skew | two transactions read overlapping data and write different rows, violating an invariant (two doctors both go off call) |

## Levels (SQL standard) and reality
| Level | Prevents | PostgreSQL | MySQL InnoDB |
|---|---|---|---|
| READ UNCOMMITTED | nothing | behaves as READ COMMITTED | allows dirty reads |
| READ COMMITTED | dirty reads | **default**; each statement sees a fresh snapshot | available |
| REPEATABLE READ | + non-repeatable reads | snapshot isolation; also prevents phantoms; detects lost updates (serialization error) | **default**; consistent snapshot reads, gap locks for locking reads |
| SERIALIZABLE | all incl. write skew | SSI: aborts conflicting transactions (retry needed) | locking reads everywhere |

## Practical techniques in Spring/JPA
~~~java
// Optimistic: version column -> OptimisticLockException on conflict (retry or 409)
@Entity class Wallet { @Id UUID id; long balance; @Version long version; }

// Pessimistic: SELECT ... FOR UPDATE
@Lock(LockModeType.PESSIMISTIC_WRITE)
@Query("select w from Wallet w where w.id = :id")
Optional<Wallet> lockById(UUID id);

// Atomic SQL: no read-modify-write in Java
@Modifying @Query("update Wallet w set w.balance = w.balance - :amt where w.id = :id and w.balance >= :amt")
int debit(UUID id, long amt);

@Transactional(isolation = Isolation.SERIALIZABLE)   // only where needed, with retry on serialization failure
public void assignOnCall(...) { ... }
~~~

?? Default READ COMMITTED: how do you prevent lost updates on a balance?
Atomic UPDATE with condition, optimistic locking with @Version, or SELECT FOR UPDATE. Do not rely on isolation level alone.
?? What is write skew and which level prevents it?
Two transactions each read a condition (two doctors on call), both decide it's safe, and update different rows, breaking the invariant. Only SERIALIZABLE (or explicit locking of the rows that represent the invariant / a constraint) prevents it.
` },

{ id: 'n-plus-one', title: 'The N+1 Query Problem', level: 'intermediate', tags: ['jpa', 'performance', 'hibernate'],
  summary: 'How N+1 happens with lazy associations, how to detect it, and fixes: fetch join, entity graph, batch fetching, projections.',
  body: md`
## How it happens
~~~java
List<Order> orders = orderRepo.findByCustomerId(id);   // 1 query
for (Order o : orders) o.getLines().size();            // N queries, one per order (lazy collection)
~~~
Also with EAGER {{@ManyToOne}} loaded per row, and JSON serialisation touching lazy fields.

## Detecting it
- Enable SQL logging in tests or use datasource-proxy / p6spy; assert query counts in integration tests (e.g. Hypersistence Utils {{SQLStatementCountValidator}}).
- Hibernate statistics ({{hibernate.generate_statistics}}), APM traces showing many identical queries.

## Fixes
~~~java
// 1) Fetch join (careful with pagination on collections)
@Query("select distinct o from Order o join fetch o.lines where o.customerId = :c")
List<Order> findWithLines(UUID c);

// 2) Entity graph
@EntityGraph(attributePaths = {"lines", "lines.product"})
List<Order> findByCustomerId(UUID c);

// 3) Batch fetching: N queries become N/100 (IN clause)
// spring.jpa.properties.hibernate.default_batch_fetch_size=100

// 4) DTO projection: fetch exactly what the API needs
@Query("select new com.acme.OrderSummary(o.id, o.total, count(l)) from Order o left join o.lines l where o.customerId = :c group by o.id, o.total")
List<OrderSummary> summaries(UUID c);
~~~
> **Pitfall** {{join fetch}} on a collection plus {{Pageable}} makes Hibernate paginate in memory (warning HHH90003004). Page over ids first, then fetch the graph for those ids.

?? How do you fix N+1 for a paginated list endpoint?
Query a page of parent ids with keyset pagination, then load children with one IN query (batch fetch or a second query), or use a DTO projection designed for the screen.
` },

{ id: 'connection-pooling', title: 'Connection Pooling (HikariCP)', level: 'intermediate', tags: ['hikaricp', 'database', 'performance'],
  summary: 'Why pools exist, sizing with Little\'s law, timeouts, leak detection, and pool exhaustion incidents.',
  body: md`
## Why
Creating DB connections is expensive (TCP, TLS, auth, server process/thread). A pool reuses a bounded set; the bound also protects the database.

## Sizing
- Total connections across all instances must fit the DB's limit: {{pods × maximumPoolSize ≤ DB max_connections - headroom}}. 40 pods × 20 = 800 connections can overwhelm Postgres; use PgBouncer/RDS Proxy or smaller pools.
- Little's law: required connections ≈ throughput × average time a connection is held. 500 queries/s × 10 ms = 5 connections busy on average; add headroom for bursts.
- More connections than DB cores × small factor often reduces throughput (contention).

## Configuration
~~~yaml
spring:
  datasource:
    hikari:
      maximum-pool-size: 20
      minimum-idle: 20                   # fixed-size pool recommended by HikariCP
      connection-timeout: 2000           # fail fast when exhausted (ms)
      max-lifetime: 1740000              # below DB/infra idle timeouts
      leak-detection-threshold: 20000    # log stack trace if a connection is held > 20s
~~~
Expose metrics: {{hikaricp.connections.active}}, {{pending}}, {{acquire}} time.

## Pool exhaustion: typical causes
- Long transactions holding connections while calling HTTP services.
- Open Session In View holding connections during view rendering/serialisation.
- Connection leaks (unclosed JDBC resources in manual code).
- Slow queries under load; lock waits.
- Virtual threads making thousands of concurrent requests compete for 20 connections (add a semaphore/bulkhead).

?? Requests time out with "Connection is not available, request timed out after 30000ms". Diagnose.
Check pending vs active metrics, find long-held connections (leak detection logs, traces), look for remote calls inside transactions, slow queries and DB locks; reduce connection-timeout to fail fast and add bulkheads; then fix the holding pattern.
` }
]);

LAB.add('java', 'Microservices with Spring', [
{ id: 'ms-communication', title: 'Microservices Communication', level: 'intermediate', tags: ['rest', 'grpc', 'kafka', 'resilience'],
  summary: 'Sync (REST/gRPC) vs async (Kafka), RestClient/WebClient/Feign, timeouts and resilience, contracts and versioning.',
  body: md`
## Choosing the style
| Style | When | Costs |
|---|---|---|
| REST (HTTP/JSON) | simple request/response, public APIs | coupling in time, latency chains |
| gRPC (HTTP/2, protobuf) | internal high-throughput, streaming, strict contracts | tooling, browser support |
| Async events (Kafka) | decoupling, fan-out, workflows | eventual consistency, debugging |

## Spring clients
~~~java
@Bean RestClient inventoryClient(RestClient.Builder b) {
  var rf = new JdkClientHttpRequestFactory(HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1)).build());
  rf.setReadTimeout(Duration.ofSeconds(2));                                        // always set timeouts
  return b.baseUrl("http://inventory").requestFactory(rf)
          .defaultStatusHandler(HttpStatusCode::is5xxServerError, (req, res) -> { throw new InventoryUnavailable(); })
          .build();
}

// Declarative HTTP interface (Spring 6)
@HttpExchange("/stock")
interface InventoryApi { @GetExchange("/{sku}") Stock get(@PathVariable String sku); }
~~~
Combine with Resilience4j (timeouts, retries for idempotent calls, circuit breakers, bulkheads).

## Avoid long synchronous chains
A -> B -> C -> D multiplies latency and failure probability (four 99.9% services in series ≈ 99.6%). Prefer data replication via events for reads, or aggregate at a BFF in parallel.

## Contracts
OpenAPI for REST, protobuf for gRPC, schema registry for events; consumer-driven contract tests (Spring Cloud Contract, Pact).

?? Sync or async for "order placed -> send email"?
Async event: the order must not fail or wait because email is slow; the email service consumes OrderPlaced idempotently.
` },

{ id: 'spring-cloud', title: 'Spring Cloud', level: 'intermediate', tags: ['spring-cloud', 'gateway', 'config'],
  summary: 'Gateway, Config, LoadBalancer, CircuitBreaker, Stream, OpenFeign, and what Kubernetes makes redundant.',
  body: md`
## Components and when you still need them
| Component | Purpose | On Kubernetes? |
|---|---|---|
| Spring Cloud Gateway | API gateway in Java (reactive) | yes, or use Ingress/Envoy/Kong/AWS API GW |
| Spring Cloud Config | centralised config with Git backend | often replaced by ConfigMaps/Secrets + Vault |
| Eureka / Consul discovery | service registry | usually unnecessary (K8s DNS) |
| Spring Cloud LoadBalancer | client-side LB | optional |
| Spring Cloud CircuitBreaker (Resilience4j) | resilience abstraction | yes |
| Spring Cloud Stream | binder abstraction over Kafka/RabbitMQ | yes, if you like functional bindings |
| OpenFeign | declarative HTTP clients | Spring HTTP interfaces are the newer alternative |
| Spring Cloud Kubernetes | config/discovery from K8s APIs | optional |

## Spring Cloud Stream (functional style)
~~~java
@Bean Function<OrderPlaced, PaymentRequested> requestPayment() { return e -> new PaymentRequested(e.orderId(), e.total()); }
~~~
~~~yaml
spring:
  cloud:
    function: { definition: requestPayment }
    stream:
      bindings:
        requestPayment-in-0:  { destination: orders.events, group: payment }
        requestPayment-out-0: { destination: payments.commands }
      kafka:
        bindings:
          requestPayment-in-0: { consumer: { enableDlq: true, dlqName: orders.events.payment.dlq } }
~~~

?? Do you need Eureka on Kubernetes?
Generally no: Kubernetes Services provide stable DNS names and load balancing; readiness probes manage membership. Eureka adds another moving part.
` },

{ id: 'distributed-tracing', title: 'Distributed Tracing', level: 'intermediate', tags: ['tracing', 'opentelemetry', 'micrometer'],
  summary: 'Traces, spans, context propagation over HTTP and Kafka, Micrometer Tracing with OpenTelemetry, sampling and log correlation.',
  body: md`
## Concepts
- **Trace**: the whole request journey, identified by traceId. **Span**: one operation (HTTP server/client call, DB query, Kafka send/consume) with timing, attributes and parent span id.
- **Propagation**: W3C {{traceparent}} header across HTTP; Kafka record headers for messaging.
- **Sampling**: head-based (decide at start, e.g. 10%) vs tail-based (collector keeps slow/error traces).

## Spring Boot 3 setup
~~~xml
<dependency><groupId>io.micrometer</groupId><artifactId>micrometer-tracing-bridge-otel</artifactId></dependency>
<dependency><groupId>io.opentelemetry</groupId><artifactId>opentelemetry-exporter-otlp</artifactId></dependency>
~~~
~~~yaml
management:
  tracing: { sampling: { probability: 0.1 } }
  otlp: { tracing: { endpoint: http://otel-collector:4318/v1/traces } }
spring:
  kafka:
    template: { observation-enabled: true }
    listener: { observation-enabled: true }
~~~
Use injected {{RestClient.Builder}}/{{WebClient.Builder}} (instrumented) rather than {{new RestTemplate()}}; otherwise propagation is lost.

## Custom spans
~~~java
@Observed(name = "pricing.calculate")
public Price calculate(Cart c) { ... }

Observation.createNotStarted("otp.send", registry).lowCardinalityKeyValue("channel", "sms").observe(() -> sender.send(msg));
~~~

?? A trace shows a gap between service A's client span and service B's server span. What could it be?
Network latency, load balancer/proxy queuing, TLS handshakes, or B's thread pool queueing before the server span starts (e.g. Tomcat accept queue). Check B's executor/connector metrics.
?? Why are traces broken across Kafka?
Producer/consumer observation not enabled, or messages created by non-instrumented clients without trace headers.
` },

{ id: 'testing-strategies', title: 'Testing Strategies', level: 'intermediate', tags: ['testing', 'testcontainers', 'junit'],
  summary: 'Test pyramid for Spring services: unit, slice tests, Testcontainers integration, contract tests, and what to mock.',
  body: md`
## A pragmatic pyramid
1. **Unit tests** (JUnit 5, AssertJ, Mockito): domain logic, pure functions, state machines. Fast, many.
2. **Slice tests**: {{@WebMvcTest}} (controllers, validation, security, JSON), {{@DataJpaTest}} (queries, mappings) against a real DB via Testcontainers.
3. **Integration tests**: {{@SpringBootTest}} + Testcontainers (Postgres, Kafka, Redis, Keycloak) for critical flows.
4. **Contract tests**: Spring Cloud Contract / Pact between services.
5. **E2E**: a few smoke tests in a deployed environment.

~~~java
@SpringBootTest
@Testcontainers
class CheckoutIT {
  @Container @ServiceConnection static PostgreSQLContainer<?> pg = new PostgreSQLContainer<>("postgres:16");
  @Container @ServiceConnection static KafkaContainer kafka = new KafkaContainer(DockerImageName.parse("confluentinc/cp-kafka:7.6.1"));

  @Autowired CheckoutService checkout;

  @Test void doesNotOversellUnderConcurrency() throws Exception {
    stock.set("SKU-1", 1);
    var pool = Executors.newFixedThreadPool(10);
    var results = IntStream.range(0, 10).mapToObj(i -> pool.submit(() -> checkout.tryBuy("SKU-1", "user" + i))).toList();
    long ok = results.stream().filter(f -> { try { return f.get(); } catch (Exception e) { return false; } }).count();
    assertThat(ok).isEqualTo(1);
  }
}

@WebMvcTest(OrderController.class)
class OrderControllerTest {
  @Autowired MockMvc mvc; @MockitoBean OrderService service;     // Boot 3.4+ (@MockBean earlier)
  @Test void forbidsOtherUsersOrder() throws Exception {
    given(service.get(any(), eq("alice"))).willThrow(new AccessDeniedException("no"));
    mvc.perform(get("/orders/{id}", UUID.randomUUID()).with(jwt().jwt(j -> j.subject("alice")))).andExpect(status().isForbidden());
  }
}
~~~

## What to mock
Mock what you do not own at the boundary (third-party HTTP via WireMock), not your own repositories in integration tests (use real DB). Avoid mocking value objects or the class under test's collaborators so heavily that tests mirror implementation.

?? H2 for repository tests: good idea?
Risky: SQL dialect differences, missing features (JSONB, partial indexes, locking semantics). Testcontainers with the real engine gives confidence at small cost.
?? How do you test time-dependent code (OTP expiry)?
Inject {{Clock}} and use {{Clock.fixed}} / a mutable test clock; never sleep in tests.
` }
]);
})();
