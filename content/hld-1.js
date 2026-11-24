(function () {
const md = LAB.md;

LAB.add('hld', 'Architecture Styles', [
{ id: 'monolith-vs-microservices', title: 'Monolith vs Microservices', level: 'intermediate', tags: ['architecture', 'microservices'], viz: 'request-flow',
  summary: 'The real trade-off: deployment independence and team autonomy versus distributed-systems complexity.',
  body: md`
## Definition
A **monolith** is one deployable unit containing all business capabilities (it can still be well modularised). **Microservices** split capabilities into independently deployable services, each owning its data, communicating over the network.

## Why microservices exist
They solve an **organisational scaling** problem first: many teams changing one codebase cause merge contention, coupled releases and slow pipelines. Independent deployability and data ownership let teams ship without coordinating. Independent runtime scaling and fault isolation are secondary benefits.

## When to use
- Several teams (roughly 3+ teams / 25+ engineers) with clear bounded contexts.
- Parts with very different scaling or availability needs (search vs payments).
- Need for independent release cadence or different tech stacks in some areas.

## When NOT to use
- A new product where domain boundaries are not yet known (you will draw them wrong; refactoring across services is expensive).
- A small team: you pay the distributed tax (network failures, eventual consistency, tracing, contract versioning, platform engineering) without the organisational benefit.
- Prefer a **modular monolith** first: strict module boundaries (Spring Modulith, ArchUnit), one deployment, later extraction along proven seams.

## Real-world use case
A UAE fintech starts with a modular monolith (onboarding, KYC, wallet, payments). As the team grows to 6 squads and payments needs PCI scope isolation, payments is extracted first: it has a clear boundary, distinct compliance needs and its own scaling profile.

## Architecture
~~~mermaid
flowchart LR
  subgraph Mono["Modular monolith"]
    direction TB
    W["Web layer"] --> M1["Orders module"] & M2["Payments module"] & M3["Catalog module"]
    M1 & M2 & M3 --> DB[("One database, schema per module")]
  end
  subgraph Micro["Microservices"]
    direction TB
    GW["API Gateway"] --> S1["Order svc"] & S2["Payment svc"] & S3["Catalog svc"]
    S1 --> D1[("Orders DB")]
    S2 --> D2[("Payments DB")]
    S3 --> D3[("Catalog DB")]
    S1 -. events .-> K{{"Kafka"}}
    K -.-> S2
  end
~~~

## Advantages and disadvantages
| | Monolith | Microservices |
|---|---|---|
| Deployment | One pipeline, simple | Independent, needs CI/CD per service |
| Consistency | Local ACID transactions | Sagas, outbox, eventual consistency |
| Failure modes | In-process calls | Network partitions, timeouts, retries |
| Scaling | Scale everything together | Scale hot services independently |
| Debugging | Stack trace | Distributed tracing required |
| Team autonomy | Low at scale | High with clear ownership |

## Spring Boot implementation
~~~java
// Modular monolith boundary enforcement with Spring Modulith
@ApplicationModuleTest
class OrdersModuleTests { /* boots only the orders module and its declared dependencies */ }

@Test
void verifyModularity() { ApplicationModules.of(ShopApplication.class).verify(); } // fails on illegal cross-module access

// Cross-module communication via events, the same seam you later turn into Kafka
@Service class OrderService {
  private final ApplicationEventPublisher events;
  @Transactional public void place(Order o) { repo.save(o); events.publishEvent(new OrderPlaced(o.id())); }
}
@ApplicationModuleListener  // async, transactional, persisted in the event publication registry
void on(OrderPlaced e) { payments.initiate(e.orderId()); }
~~~

## Interview questions
?? How do you decide where to split a monolith?
Along bounded contexts with low coupling: look at which tables change together, which features are owned by one team, and which parts have distinct non-functional needs. Extract the piece with the fewest inbound dependencies using the strangler-fig pattern behind the gateway.
?? What is a distributed monolith?
Services that must be deployed together, share a database, or call each other synchronously in long chains. You get the costs of both styles and the benefits of neither.

## Advanced follow-ups
?? Two services need a JOIN across their data. What do you do?
Do not share the database. Options: API composition (call both, join in memory, fine for small results), a read-model/projection built from events (CQRS), or rethink the boundary if they are constantly joined.
?? How do you keep 30 services' API contracts from breaking each other?
Backward-compatible changes only (add fields, never repurpose), consumer-driven contract tests (Spring Cloud Contract / Pact) in CI, versioned events with a schema registry and compatibility rules.
` },

{ id: 'soa', title: 'Service-Oriented Architecture', level: 'beginner', tags: ['architecture', 'soa', 'esb'],
  summary: 'Enterprise-scale reusable services, often via an ESB; how it differs from microservices.',
  body: md`
## Definition
SOA structures an enterprise's capabilities as reusable services with formal contracts (often SOAP/WSDL), frequently integrated through an **Enterprise Service Bus** (ESB) that handles routing, transformation and orchestration.

## Why it exists
Large enterprises (banks, telcos, governments in the Gulf) had dozens of silos (core banking, CRM, billing). SOA aimed at reuse and integration across them.

## When to use
- Integrating heterogeneous legacy systems (core banking on mainframe, CRM, AML).
- Strong governance and canonical data models are required.

## When NOT to use
- Greenfield product development where team autonomy and fast iteration matter; a smart central bus becomes a bottleneck and a single point of change.

## SOA vs microservices
| | SOA | Microservices |
|---|---|---|
| Scope | Enterprise-wide integration | One application/product |
| Communication | Smart pipes (ESB) | Smart endpoints, dumb pipes (HTTP, Kafka) |
| Data | Often shared databases | Database per service |
| Contracts | WSDL/XSD, canonical model | OpenAPI/AsyncAPI, consumer-driven |
| Governance | Centralised | Decentralised per team |

## Real-world use case
A bank in Abu Dhabi exposes core-banking functions via an ESB (IBM IIB / MuleSoft); new digital channels (mobile app microservices) call the ESB through an API layer, with an anti-corruption layer translating canonical XML to the app's JSON model.

## Architecture
~~~mermaid
flowchart LR
  App["Mobile backend services"] --> APIGW["API layer"] --> ESB["ESB: routing, transformation, orchestration"]
  ESB --> CB["Core banking"] & CRM["CRM"] & AML["AML screening"]
~~~

## Interview questions
?? Is microservices just SOA done right?
Partly: both are service-based, but microservices reject the central smart bus and shared canonical models in favour of autonomous services owning their data. The difference is mostly about where logic and governance live.
` },

{ id: 'api-gateway', title: 'API Gateway', level: 'intermediate', tags: ['gateway', 'edge', 'routing'], viz: 'request-flow',
  summary: 'Single entry point that handles cross-cutting concerns: routing, auth, rate limiting, aggregation, TLS.',
  body: md`
## Definition
An API gateway is a reverse proxy specialised for APIs that sits between clients and backend services, providing routing and cross-cutting concerns: TLS termination, authentication (JWT validation), rate limiting, request/response transformation, aggregation, canary routing and observability.

## Why it exists
Without it, every service re-implements auth, CORS, rate limiting and logging, and clients must know every service's address. The gateway centralises edge policy and decouples clients from internal topology.

## When to use
- Multiple backend services exposed to external clients.
- Need for consistent authN, quotas and API keys (partner APIs).
- **BFF (Backend for Frontend)**: separate gateways per client type (mobile vs web) when their needs diverge.

## When NOT to use
- Do not put business logic or orchestration of business workflows in the gateway (it becomes a new monolith).
- For service-to-service traffic inside the cluster, prefer a service mesh or direct calls; routing east-west traffic through the edge gateway adds latency and a choke point.

## Real-world use case
A ride-hailing app: AWS API Gateway (or Kong/Spring Cloud Gateway) validates Cognito JWTs, applies usage plans per partner, routes {{/rides/**}} to ride service and {{/payments/**}} to payment service, and returns 429 on quota breach.

## Architecture
~~~mermaid
flowchart LR
  C["Mobile / Web / Partners"] -->|HTTPS| GW["API Gateway: TLS, JWT validation, rate limit, routing, logging"]
  GW --> R["Ride service"] & P["Payment service"] & U["User service"]
  GW -.-> IdP["Keycloak / Cognito JWKS"]
  GW -.-> RL[("Redis: rate-limit counters")]
~~~

## Advantages and disadvantages
| Advantages | Disadvantages |
|---|---|
| One place for edge policy | Extra network hop (typically single-digit ms) |
| Hides internal topology; enables canary/blue-green | Must be highly available: it is on every request path |
| Protocol translation (REST to gRPC) | Risk of becoming a bottleneck of team changes |

## Spring Boot implementation
~~~yaml
# Spring Cloud Gateway (reactive)
spring:
  cloud:
    gateway:
      routes:
        - id: orders
          uri: lb://order-service            # resolved via service discovery
          predicates: [ Path=/api/orders/** ]
          filters:
            - StripPrefix=1
            - name: RequestRateLimiter
              args:
                redis-rate-limiter.replenishRate: 50
                redis-rate-limiter.burstCapacity: 100
                key-resolver: "#{@userKeyResolver}"
            - name: CircuitBreaker
              args: { name: orders, fallbackUri: forward:/fallback/orders }
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://auth.example.com/realms/shop
~~~
~~~java
@Bean KeyResolver userKeyResolver() {
  return exchange -> exchange.getPrincipal().map(Principal::getName).defaultIfEmpty("anonymous");
}
~~~

## Interview questions
?? Should the gateway validate JWTs or should each service?
Both, at different depths. The gateway rejects invalid/expired tokens early (cheap, protects services). Services still validate (zero trust: a misrouted internal call must not bypass auth) and perform **authorization** using claims and their own domain rules.
?? Gateway vs load balancer?
An L4/L7 load balancer distributes traffic among instances of one service; a gateway understands APIs (routes by path/version, auth, quotas, transformations). Gateways usually sit behind a load balancer and in front of service load balancing.

## Advanced follow-ups
?? How do you avoid the gateway becoming a single point of failure?
Run multiple stateless instances behind an L4 LB across AZs, keep state (rate-limit counters) in a replicated store with a fail-open policy, set timeouts per route, and keep config changes GitOps-driven with canaries.
?? How would you implement request aggregation for a mobile home screen?
A BFF service (not the generic gateway) calls profile, offers and orders in parallel with timeouts and partial-response fallbacks, returning one payload shaped for the screen.
` },

{ id: 'reverse-proxy', title: 'Reverse Proxy', level: 'beginner', tags: ['proxy', 'nginx', 'edge'],
  summary: 'A server that accepts client requests on behalf of backends: TLS termination, caching, compression, buffering.',
  body: md`
## Definition
A **reverse proxy** receives requests from clients and forwards them to backend servers, returning responses as if it were the origin. (A **forward proxy** acts on behalf of clients, e.g. corporate egress.)

## Why it exists
To hide backend topology and centralise concerns: TLS termination, HTTP/2 to clients, gzip/brotli compression, static file serving, response caching, request buffering (protecting slow app threads from slow clients), and basic load balancing.

## When to use
Almost always in front of application servers: Nginx, Envoy, HAProxy, AWS ALB, Cloudflare.

## When NOT to use
Do not add layers of proxies without purpose; each adds latency, timeouts to tune, and header-forwarding pitfalls.

## Architecture
~~~mermaid
flowchart LR
  Client -->|TLS| RP["Nginx / Envoy: TLS, gzip, cache, buffering"] --> A1["App 1"] & A2["App 2"]
~~~

## Production configuration that matters
~~~text
upstream orders { least_conn; server 10.0.1.10:8080 max_fails=3 fail_timeout=10s; server 10.0.1.11:8080; keepalive 64; }
server {
  listen 443 ssl http2;
  location /api/ {
    proxy_pass http://orders;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_connect_timeout 2s; proxy_read_timeout 15s;
  }
}
~~~
~~~yaml
# Spring Boot behind a proxy: trust forwarded headers so redirects and OAuth callbacks use https
server:
  forward-headers-strategy: framework
~~~

## Interview questions
?? Why did OAuth redirects break after putting the app behind a load balancer?
The app saw {{http}} and the internal host, building the wrong {{redirect_uri}}. Configure the proxy to send {{X-Forwarded-Proto/Host}} and the app to trust them ({{forward-headers-strategy}}), or Keycloak's {{KC_PROXY_HEADERS=xforwarded}}.
?? What is request buffering and why does it matter?
The proxy reads the full request (or response) before passing it on, so a slow mobile client uploading over 3G does not tie up a servlet thread for seconds.
` },

{ id: 'cloud-native', title: 'Cloud-Native Architecture', level: 'intermediate', tags: ['kubernetes', '12-factor', 'containers'],
  summary: '12-factor services on containers and Kubernetes: stateless processes, declarative config, probes, autoscaling, managed services.',
  body: md`
## Definition
Cloud-native systems are designed to exploit elastic, managed infrastructure: containerised stateless services, orchestrated declaratively (Kubernetes/ECS), using managed data services, automated CI/CD, and observability built in.

## Why it exists
To make scaling, recovery and deployment automatic and repeatable: the platform replaces failed instances, scales on load, and rolls out changes safely.

## Key principles (12-factor, pragmatic)
- Config in environment/secret stores, not in the image.
- Stateless processes; state in backing services (RDS, ElastiCache, S3).
- Disposability: fast startup, graceful shutdown (drain in-flight requests on SIGTERM).
- Dev/prod parity; logs as event streams to stdout.

## When NOT to use (or not fully)
Strict data-residency or air-gapped environments may require on-prem; small apps may be better on a PaaS (App Runner, Cloud Run) than self-managed Kubernetes, which needs platform skills.

## Architecture
~~~mermaid
flowchart TB
  Dev["Git push"] --> CI["CI: test, build image, scan"] --> Reg["Registry"] --> CD["GitOps (Argo CD)"] --> K8s
  subgraph K8s["Kubernetes cluster (multi-AZ)"]
    Ing["Ingress"] --> SvcA["Deployment A + HPA"] & SvcB["Deployment B + HPA"]
  end
  SvcA --> RDS[("Managed Postgres")]
  SvcB --> MQ["Managed Kafka / SQS"]
  K8s --> Obs["Prometheus / OTel / Loki"]
~~~

## Spring Boot implementation
~~~yaml
server:
  shutdown: graceful
spring:
  lifecycle:
    timeout-per-shutdown-phase: 20s
management:
  endpoint:
    health:
      probes: { enabled: true }      # /actuator/health/liveness and /readiness
~~~
~~~yaml
# Kubernetes deployment excerpt
readinessProbe: { httpGet: { path: /actuator/health/readiness, port: 8080 }, periodSeconds: 5 }
livenessProbe:  { httpGet: { path: /actuator/health/liveness,  port: 8080 }, initialDelaySeconds: 30 }
resources: { requests: { cpu: "500m", memory: "768Mi" }, limits: { memory: "768Mi" } }
env: [ { name: JAVA_TOOL_OPTIONS, value: "-XX:MaxRAMPercentage=75" } ]
~~~

## Interview questions
?? Liveness vs readiness probe?
Readiness controls whether the pod receives traffic (fail it during warm-up or when a critical dependency is down). Liveness restarts the container when it is stuck. Never make liveness depend on downstream services, or a DB outage restarts every pod in a loop.
?? Why set MaxRAMPercentage in containers?
The JVM sizes the heap from container memory limits (since JDK 10). Leaving headroom (about 25%) for metaspace, threads, direct buffers prevents OOMKills.
` }
]);

LAB.add('hld', 'Scaling & Traffic', [
{ id: 'load-balancing', title: 'Load Balancing', level: 'intermediate', tags: ['load-balancer', 'l4', 'l7'], viz: 'load-balancer',
  summary: 'L4 vs L7, algorithms (round robin, least connections, consistent hashing), health checks and failure behaviour.',
  body: md`
## Definition
A load balancer distributes incoming requests across multiple backend instances to increase capacity and availability.

## Why it exists
One server has finite CPU, memory and connections, and it fails. Load balancing enables horizontal scaling and removes unhealthy instances from rotation.

## L4 vs L7
| | L4 (TCP/UDP) | L7 (HTTP) |
|---|---|---|
| Sees | IP, port | URL, headers, cookies |
| Examples | AWS NLB, HAProxy TCP | AWS ALB, Nginx, Envoy |
| Can do | Very high throughput, TLS passthrough | Path routing, header-based canaries, retries |

## Algorithms
- **Round robin / weighted round robin**: simple; poor when request costs vary.
- **Least connections / least outstanding requests**: adapts to slow instances; good default for variable latency.
- **Power of two random choices**: pick two at random, send to the less loaded; near-optimal with little state (Envoy, Nginx {{random two}}).
- **IP hash / consistent hashing**: affinity (caches, sticky sessions); uneven when few clients dominate.

## When to use / not to use
Use for any horizontally scaled stateless tier. Avoid sticky sessions as a substitute for externalising session state: they break even distribution and failover.

## Real-world use case
ALB across three AZs in me-central-1 routing to an ECS service; health check {{/actuator/health/readiness}} every 10s, deregistration delay 30s for graceful drains during deploys.

## Architecture
~~~mermaid
flowchart LR
  Clients --> DNS["DNS (Route 53)"] --> LB["L7 load balancer (multi-AZ)"]
  LB -->|health-checked| I1["Instance AZ-a"] & I2["Instance AZ-b"] & I3["Instance AZ-c"]
~~~

## Spring Boot implementation
~~~java
// Client-side load balancing between services (Spring Cloud LoadBalancer)
@Bean @LoadBalanced
RestClient.Builder lbRestClient() { return RestClient.builder(); }

@Service class InventoryClient {
  private final RestClient http;
  InventoryClient(@LoadBalanced RestClient.Builder b) { this.http = b.baseUrl("http://inventory-service").build(); }
  Stock get(String sku) { return http.get().uri("/stock/{sku}", sku).retrieve().body(Stock.class); }
}
~~~

## Interview questions
?? A deploy causes a burst of 502s. Why?
Instances are killed while still in the LB's target list, or new instances get traffic before warm-up. Fix: readiness probes, graceful shutdown ({{server.shutdown=graceful}}), deregistration delay longer than the longest request, and preStop sleep in Kubernetes so endpoints update before SIGTERM.
?? Why might round robin overload one server?
Requests have different costs, or one instance is degraded (GC pauses, noisy neighbour). Least-outstanding-requests or P2C adapts.

## Advanced follow-ups
?? How do you load balance long-lived WebSocket connections?
Connection counts, not requests, matter. Use least-connections, cap connections per instance, and rebalance gradually during scale-out (new instances only receive new connections). Clients reconnect with jitter.
?? What is the thundering herd on health-check recovery?
When a recovered instance rejoins, a naive balancer floods it. Use slow-start (ramp-up weight) as supported by ALB and Envoy.
` },

{ id: 'scaling', title: 'Horizontal vs Vertical Scaling', level: 'beginner', tags: ['scaling', 'capacity'],
  summary: 'Scale up versus scale out, what must be true for horizontal scaling, and where each hits limits.',
  body: md`
## Definition
**Vertical scaling** adds resources to one machine (more CPU/RAM). **Horizontal scaling** adds more machines behind a distribution mechanism.

## Why it matters
Vertical is simple but bounded (largest instance, cost grows non-linearly, still a single point of failure). Horizontal is effectively how internet-scale systems grow, but requires statelessness or partitioned state.

## When to use each
- **Vertical**: databases early on (a bigger RDS instance is often the cheapest, safest first step), in-memory analytics, legacy software that cannot be distributed.
- **Horizontal**: stateless app tiers, caches (sharded), Kafka, Cassandra, read replicas.

## Prerequisites for horizontal scaling
1. No local session state (use JWT or Redis-backed sessions).
2. No local file storage for shared data (use S3/EFS).
3. Idempotent, retry-safe operations.
4. Scheduled jobs coordinated (ShedLock / leader election) so they do not run N times.
5. Caches either shared or tolerant of per-instance inconsistency.

## Architecture
~~~mermaid
flowchart LR
  subgraph V["Vertical"]
    B["1 big instance: 64 vCPU"]
  end
  subgraph H["Horizontal"]
    LB["LB"] --> a["4 vCPU"] & b["4 vCPU"] & c["4 vCPU"] & d["..."]
  end
~~~

## Spring Boot implementation
~~~java
// Prevent a @Scheduled job from running on every replica
@Scheduled(cron = "0 */5 * * * *")
@SchedulerLock(name = "expireHolds", lockAtMostFor = "4m", lockAtLeastFor = "30s")
public void expireHolds() { holds.releaseExpired(); }
~~~

## Interview questions
?? Your service is CPU-bound at 80%. Scale up or out?
Out, if it is stateless: better availability and linear-ish scaling. But first profile: a hot loop, excessive JSON serialisation, or GC thrash may be the real issue. For a database, scaling up plus read replicas usually comes before sharding.
?? Does adding instances always increase throughput?
No. Shared bottlenecks (DB connections, a lock, a single partition, a downstream rate limit) cap it (Amdahl/Universal Scalability Law). Doubling app pods can even reduce throughput if they exhaust DB connections.
` }
]);

LAB.add('hld', 'Caching', [
{ id: 'caching', title: 'Caching Strategies', level: 'intermediate', tags: ['cache', 'redis', 'cdn'], viz: 'redis-cache',
  summary: 'Cache-aside, read-through, write-through, write-behind, TTLs, invalidation, stampedes and consistency.',
  body: md`
## Definition
A cache stores copies of data in faster storage to reduce latency and load on the source of truth. Layers: browser, CDN, gateway, application (in-process), distributed cache (Redis), database buffer pool.

## Why it exists
Reads often dominate (10:1 to 1000:1). Memory access is orders of magnitude faster than a network round trip to a database doing disk I/O, and caches absorb hot-key traffic.

## Strategies
| Strategy | Read | Write | Use when |
|---|---|---|---|
| **Cache-aside** (lazy) | app checks cache, on miss reads DB and populates | app writes DB, then **deletes** cache key | default for most services |
| **Read-through** | cache library loads from DB on miss | — | when using a caching layer that owns loading |
| **Write-through** | — | write cache and DB synchronously | read-after-write must hit cache |
| **Write-behind** | — | write cache, flush to DB async | high write rates tolerant of loss (counters) |
| **Refresh-ahead** | refresh before expiry | — | predictable hot keys |

## When NOT to cache
- Data that must be strongly consistent on every read (account balance at debit time).
- Low hit-rate data (unique per request): you pay the extra hop for nothing.
- As a band-aid for missing indexes.

## Invalidation and consistency
Delete-on-write (not update) avoids racing writers leaving stale values. Even so, a classic race exists: reader misses, reads old DB value, writer updates DB and deletes key, reader writes old value into the cache. Mitigations: short TTLs, versioned values, delayed double delete, or change-data-capture driven invalidation.

## Stampede (dogpile) protection
When a hot key expires, thousands of requests hit the DB. Use: request coalescing (single-flight per key), probabilistic early expiration, a short lock ({{SET NX}}), or serve-stale-while-revalidate. Add **TTL jitter** so keys do not expire together.

## Real-world use case
Product detail pages: cache-aside in Redis with TTL 10 min + jitter, CDN caching of images, in-process Caffeine for config/feature flags (TTL 30s).

## Architecture
~~~mermaid
sequenceDiagram
  participant App
  participant Redis
  participant DB
  App->>Redis: GET product:42
  alt hit
    Redis-->>App: value
  else miss
    Redis-->>App: nil
    App->>DB: SELECT ... WHERE id=42
    DB-->>App: row
    App->>Redis: SET product:42 value EX 600
  end
~~~

## Spring Boot implementation
~~~java
@Configuration @EnableCaching
class CacheConfig {
  @Bean RedisCacheManager cacheManager(RedisConnectionFactory cf) {
    var defaults = RedisCacheConfiguration.defaultCacheConfig()
        .entryTtl(Duration.ofMinutes(10))
        .serializeValuesWith(RedisSerializationContext.SerializationPair.fromSerializer(new GenericJackson2JsonRedisSerializer()))
        .disableCachingNullValues();
    return RedisCacheManager.builder(cf).cacheDefaults(defaults)
        .withCacheConfiguration("prices", defaults.entryTtl(Duration.ofSeconds(30))).build();
  }
}

@Service class ProductService {
  @Cacheable(cacheNames = "products", key = "#id", sync = true)   // sync=true: per-JVM single-flight on miss
  public ProductDto get(long id) { return repo.findById(id).map(mapper::toDto).orElseThrow(); }

  @CacheEvict(cacheNames = "products", key = "#cmd.id")           // evict after the DB write commits
  @Transactional public void update(UpdateProduct cmd) { ... }
}
~~~

## Interview questions
?? Why delete the cache key on write instead of updating it?
Two concurrent writers can update the DB in one order and the cache in the other, leaving the cache permanently wrong until TTL. Deleting converges: the next read repopulates from the DB.
?? What hit ratio is "good"?
It depends on cost of a miss and access distribution. Measure it; a 60% hit rate on a very expensive query can be worth more than 99% on a cheap one.

## Advanced follow-ups
?? How do you cache personalised responses?
Cache the shared parts (product data) and compose personal parts (price for this user's segment, cart) at request time; or key by segment, not by user, to keep the key space bounded.
?? How do you keep a multi-region cache consistent?
Usually you do not try for strong consistency: each region caches locally with short TTLs, and invalidations are broadcast via CDC/Kafka. Writes that need read-your-writes route reads for that user to the primary or bypass the cache briefly.
` },

{ id: 'redis', title: 'Redis Architecture', level: 'intermediate', tags: ['redis', 'cache', 'data-structures'], viz: 'redis-cache',
  summary: 'Single-threaded event loop, data structures, persistence (RDB/AOF), replication, Sentinel vs Cluster, and pitfalls.',
  body: md`
## Definition
Redis is an in-memory data-structure server: strings, hashes, lists, sets, sorted sets, streams, bitmaps, HyperLogLog, geospatial indexes, with optional persistence and replication.

## How it works internally
- Command execution is **single-threaded** per instance (an event loop with I/O multiplexing; Redis 6+ can use I/O threads for socket reads/writes). This makes each command atomic and avoids locks, but one slow command ({{KEYS *}}, big {{HGETALL}}, a long Lua script) blocks everyone.
- **Persistence**: RDB snapshots (fork + copy-on-write; compact, may lose minutes) and AOF (append-only log with fsync policy {{everysec}} typically losing at most ~1s).
- **Replication**: asynchronous primary -> replicas. A failover can lose acknowledged writes.
- **Sentinel**: monitors a primary/replica set and performs failover (no sharding).
- **Cluster**: 16,384 hash slots split across primaries (each with replicas); clients route by slot; multi-key operations only work when keys share a slot (use hash tags {{{user:42}:cart}}).

## When to use
Caching, sessions, rate limiting (atomic INCR/Lua), leaderboards (sorted sets), distributed locks for efficiency (not correctness), pub/sub notifications, geo search (nearby drivers), deduplication sets, short-lived queues (Streams).

## When NOT to use
- As the only store for data you cannot lose (async replication + memory-bound).
- For large values (> a few hundred KB) or large collections fetched whole.
- As a general-purpose database with complex queries.

## Architecture
~~~mermaid
flowchart LR
  subgraph Cluster["Redis Cluster: 16384 slots"]
    P1["Primary A: slots 0-5460"] --> R1["Replica A'"]
    P2["Primary B: 5461-10922"] --> R2["Replica B'"]
    P3["Primary C: 10923-16383"] --> R3["Replica C'"]
  end
  Client["Lettuce client (slot map cached)"] --> P1 & P2 & P3
~~~

## Advantages and disadvantages
| Advantages | Disadvantages |
|---|---|
| Sub-millisecond operations, rich data structures | Memory cost; dataset must fit in RAM |
| Atomic operations and Lua scripts | Async replication: failover may lose writes |
| Simple operational model (managed ElastiCache/MemoryDB) | Hot keys bottleneck a single shard/thread |

## Spring Boot implementation
~~~java
// Atomic fixed-window counter with expiry in one round trip
private static final RedisScript<Long> INCR_WITH_TTL = RedisScript.of(
    "local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end return c", Long.class);

public boolean allow(String userId, int limit, Duration window) {
    String key = "rl:" + userId + ":" + (System.currentTimeMillis() / window.toMillis());
    Long count = redis.execute(INCR_WITH_TTL, List.of(key), String.valueOf(window.toMillis()));
    return count != null && count <= limit;
}

// Leaderboard with sorted sets
redis.opsForZSet().incrementScore("lb:weekly", playerId, points);
Set<ZSetOperations.TypedTuple<String>> top10 = redis.opsForZSet().reverseRangeWithScores("lb:weekly", 0, 9);
~~~

## Interview questions
?? Is Redis single-threaded? Why is it fast then?
Command execution is single-threaded: no locks or context switches, operations are in-memory and mostly O(1)/O(log n), and the bottleneck is usually network, not CPU. Throughput scales by sharding (Cluster) or adding replicas for reads.
?? Is a Redis lock (SET NX PX) safe for correctness?
It is fine for efficiency (avoid duplicate work). For correctness (two writers must never overlap) it is not sufficient: GC pauses and failover can produce two holders. Use fencing tokens checked by the resource, or a consensus-based lock (etcd/ZooKeeper), or the database itself.

## Advanced follow-ups
?? You have a hot key receiving 200k reads/sec. What do you do?
Replicate the key: local in-process cache with a short TTL (Caffeine), read from replicas, or split into N copies ({{key#0..key#N}}) with random reads. For hot writes (counters), shard the counter and sum on read.
?? What is the impact of a big key?
Deleting or reading it blocks the event loop (use {{UNLINK}} for async free), it unbalances cluster memory, and replication/migration stalls. Find with {{redis-cli --bigkeys}} / {{MEMORY USAGE}}.
` }
]);

LAB.add('hld', 'Data', [
{ id: 'db-selection', title: 'Database Selection', level: 'intermediate', tags: ['database', 'decision'],
  summary: 'A decision framework from access patterns, consistency, scale and operations, not from fashion.',
  body: md`
## Definition
Choosing a storage engine to match the workload: relational, key-value, wide-column, document, search, time-series, graph, object storage.

## The questions to ask
1. **Access patterns**: point lookups by key? ad-hoc queries and joins? range scans by time? full-text search?
2. **Consistency**: do you need multi-row ACID transactions (money, inventory)?
3. **Scale**: data size, write rate, read rate, growth; do you need horizontal write scaling?
4. **Latency**: single-digit ms at p99?
5. **Operations**: managed offering, team skills, backup/restore, cost.

## Decision table
| Workload | Good fit | Why |
|---|---|---|
| Orders, payments, bookings | PostgreSQL / MySQL (Aurora) | ACID, constraints, joins, mature tooling |
| Session, cache, counters | Redis | in-memory, atomic ops |
| Massive write-heavy timelines, chat messages | Cassandra / ScyllaDB / DynamoDB | partitioned writes, predictable key access |
| Flexible product catalogue | MongoDB or Postgres JSONB | document shape varies by category |
| Search, autocomplete, log search | Elasticsearch / OpenSearch | inverted index, relevance scoring |
| Metrics | Prometheus / TimescaleDB / InfluxDB | time-series compression and downsampling |
| Files, video, backups | S3 | cheap, durable object storage |
| Relationship traversal (fraud rings) | Neo4j / Neptune | multi-hop graph queries |

## When NOT to over-engineer
Polyglot persistence multiplies operational burden. A single PostgreSQL with JSONB, full-text search and read replicas covers a surprising range until proven otherwise.

## Architecture
~~~mermaid
flowchart LR
  OrderSvc --> PG[("PostgreSQL: orders")]
  OrderSvc -. CDC Debezium .-> K{{"Kafka"}} --> Search["OpenSearch: order search"]
  ChatSvc --> CS[("Cassandra: messages by conversation")]
  Media --> S3[("S3")]
~~~

## Interview questions
?? Why not use MongoDB for everything?
It can do a lot, but multi-document transactions, joins and strict constraints are weaker or costlier than in a relational DB, and schema-less often means schema-in-code without enforcement. Pick per access pattern.
?? When would you choose DynamoDB over PostgreSQL?
Known, key-based access patterns at very high scale with need for serverless operations and predictable latency, and where you can design single-table access patterns upfront. Avoid it when you need ad-hoc queries or complex transactions.
` },

{ id: 'sql-vs-nosql', title: 'SQL vs NoSQL', level: 'beginner', tags: ['database', 'nosql', 'sql'],
  summary: 'Data model, query flexibility, transactions and scaling differences, with the nuance interviewers expect.',
  body: md`
## Definition
**SQL (relational)** databases store normalised tables with schemas, joins and ACID transactions. **NoSQL** is a family: key-value, document, wide-column and graph stores, typically designed around partitioned, horizontal scale and specific access patterns.

## The real differences
| Aspect | Relational | NoSQL (typical) |
|---|---|---|
| Modelling | Normalise, query flexibly later | Model for the queries upfront (denormalise) |
| Transactions | Multi-row ACID | Often single-item/partition; some support more (DynamoDB, MongoDB) |
| Scaling writes | Vertical + read replicas; sharding is manual (Citus, Vitess) | Built-in partitioning |
| Schema | Enforced, migrations | Flexible, enforced in application |
| Consistency | Strong by default | Often tunable / eventual |

## When to use SQL
Business entities with relationships and invariants; reporting; when access patterns are not fully known.

## When to use NoSQL
Very high write throughput with simple key access (IoT, chat, timelines), flexible documents, or when automatic horizontal partitioning is essential.

## Nuances that score points
- "NoSQL scales, SQL does not" is wrong: Postgres handles tens of thousands of TPS on one node; Aurora, Spanner, CockroachDB and Vitess scale relational models horizontally.
- NoSQL shifts complexity into the application: denormalised copies must be kept in sync.
- Many systems use both: Postgres for orders, Cassandra for activity feeds.

## Spring Boot implementation
~~~java
// Same aggregate, two persistence styles
@Entity @Table(name = "orders") class OrderEntity { @Id UUID id; @OneToMany(mappedBy = "order", cascade = ALL) List<OrderLineEntity> lines; }

@Document("orders") record OrderDoc(@Id String id, String customerId, List<Line> lines, Instant createdAt) {} // lines embedded
interface OrderDocRepo extends MongoRepository<OrderDoc, String> { List<OrderDoc> findByCustomerIdOrderByCreatedAtDesc(String c, Pageable p); }
~~~

## Interview questions
?? A chat app stores messages. SQL or NoSQL?
Messages are append-heavy, accessed by conversation and time, rarely updated, huge volume: a wide-column store partitioned by conversation id with clustering by message time (Cassandra/Scylla/DynamoDB) is natural. Conversation membership and user profiles can live in SQL.
` },

{ id: 'indexing', title: 'Database Indexing', level: 'intermediate', tags: ['database', 'indexes', 'performance'],
  summary: 'B-tree internals, composite index ordering, covering indexes, selectivity, and the write cost of indexes.',
  body: md`
## Definition
An index is an auxiliary data structure (usually a B+tree) that maps column values to row locations, turning full scans into logarithmic lookups and ordered range scans.

## How it works
- **B+tree**: balanced, high fan-out, leaves linked for range scans. Lookup cost O(log n) page reads; with fan-out in the hundreds, a few levels cover millions of rows.
- **Hash index**: equality only.
- **GIN/inverted**: arrays, JSONB, full-text.
- **LSM trees** (Cassandra, RocksDB): write-optimised; reads may check several SSTables plus bloom filters.

## Composite indexes: order matters
Index {{(customer_id, status, created_at)}} serves:
- {{WHERE customer_id = ?}}
- {{WHERE customer_id = ? AND status = ?}}
- {{WHERE customer_id = ? AND status = ? ORDER BY created_at DESC}}
but **not** {{WHERE status = ?}} alone (leftmost prefix rule). Put equality columns first, then range/sort columns.

## Covering indexes
If the index contains every column the query needs, the DB can answer from the index alone (index-only scan). {{CREATE INDEX ... INCLUDE (total)}} in Postgres.

## When NOT to add an index
- Low-selectivity columns alone (a boolean {{is_active}}) unless partial index.
- Write-heavy tables where every index multiplies write cost and WAL volume.
- Columns wrapped in functions in queries ({{WHERE lower(email) = ?}}) unless you create a matching expression index.

## Real-world use case
~~~sql
-- "My orders" page: newest first, by customer, excluding cancelled
CREATE INDEX idx_orders_customer_created ON orders (customer_id, created_at DESC) WHERE status <> 'CANCELLED';
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, total, status FROM orders WHERE customer_id = $1 AND status <> 'CANCELLED' ORDER BY created_at DESC LIMIT 20;
-- keyset pagination for the next page
... AND created_at < $2 ORDER BY created_at DESC LIMIT 20;
~~~

## Spring Boot implementation
~~~java
@Entity
@Table(name = "orders", indexes = @Index(name = "idx_orders_customer_created", columnList = "customer_id, created_at DESC"))
class Order { ... }
// Prefer Flyway/Liquibase migrations for real index management (CONCURRENTLY, partial indexes).
~~~

## Interview questions
?? Query is slow despite an index. Why?
The planner may not use it: low selectivity, stale statistics, implicit type casts ({{varchar}} vs {{text}}/number), function on the column, leading-column mismatch, or an {{OR}} across columns. Read {{EXPLAIN ANALYZE}}.
?? How do you add an index to a 500M-row table in production?
{{CREATE INDEX CONCURRENTLY}} (Postgres) or online DDL (MySQL/gh-ost), during low traffic, monitoring replication lag and I/O.

## Advanced follow-ups
?? Why is offset pagination slow on deep pages?
{{OFFSET 100000}} still reads and discards 100k rows. Keyset (seek) pagination using the last seen sort key is O(page size).
` },

{ id: 'sharding', title: 'Partitioning & Sharding', level: 'advanced', tags: ['sharding', 'partitioning', 'scaling'], viz: 'sharding',
  summary: 'Range, hash and directory sharding, consistent hashing, choosing shard keys, hot spots and resharding.',
  body: md`
## Definition
**Partitioning** splits a dataset into parts. **Sharding** is horizontal partitioning across multiple database nodes so that each node holds a subset of rows, scaling storage and write throughput.

## Why it exists
A single primary eventually hits limits on write throughput, storage size, or working set in memory. Read replicas do not help writes.

## Strategies
| Strategy | How | Pros | Cons |
|---|---|---|---|
| Range | {{user_id 1..1M -> shard 1}} or by date | efficient range scans | hot spots on newest range |
| Hash | {{hash(key) mod N}} | even distribution | range queries scatter; resharding moves most keys |
| Consistent hashing | ring with virtual nodes | adding a node moves ~1/N keys | more complex routing |
| Directory / lookup | mapping table key -> shard | flexible, tenant moves | lookup service is critical path |
| Geo | by region/country | data residency (UAE, India DPDP) | cross-region queries hard |

## Choosing a shard key
- High cardinality, even distribution, present in most queries.
- Keep data that is queried/transacted together on one shard (e.g. {{tenant_id}} or {{user_id}}).
- Avoid monotonically increasing keys for range sharding (timestamp -> all writes to the last shard).

## When NOT to shard
When vertical scaling, read replicas, caching, archiving old data, or table partitioning on one node suffice. Sharding adds cross-shard query, transaction and operational complexity that you will live with forever.

## Real-world use case
A multi-tenant SaaS shards by {{tenant_id}} via a directory: small tenants share shards, a large enterprise tenant gets a dedicated shard, and moving a tenant is a controlled migration.

## Architecture
~~~mermaid
flowchart LR
  App --> Router["Shard router: hash(user_id) -> vnode -> shard"]
  Router --> S1[("Shard 1 + replica")] & S2[("Shard 2 + replica")] & S3[("Shard 3 + replica")]
  Router -. metadata .-> Dir[("Shard map (etcd / config)")]
~~~

## Spring Boot implementation
~~~java
// Route to a DataSource per shard using AbstractRoutingDataSource
public class ShardRoutingDataSource extends AbstractRoutingDataSource {
  @Override protected Object determineCurrentLookupKey() { return ShardContext.current(); } // set per request
}

@Component class ShardResolver {
  private final ConsistentHashRing<String> ring;   // virtual nodes per shard
  String shardFor(String userId) { return ring.nodeFor(userId); }
}

// In a filter/aspect: ShardContext.set(resolver.shardFor(userId)); try { chain.doFilter(..) } finally { ShardContext.clear(); }
~~~

## Interview questions
?? How do you query "top 10 orders by amount across all users" when sharded by user?
Scatter-gather: each shard returns its top 10, the coordinator merges. Or maintain a separate analytics store (OLAP) fed by CDC, which is usually better for cross-shard reporting.
?? Why consistent hashing instead of mod N?
With mod N, changing N remaps almost every key (massive data movement and cache misses). Consistent hashing moves only the keys between the new node and its predecessor, about K/N keys.

## Advanced follow-ups
?? How do you reshard live?
Double-write or CDC-based copy to the new layout, backfill, verify (checksums), switch reads gradually, then switch writes, keeping the old shard as fallback. Tools: Vitess, Citus rebalancer, DynamoDB does it automatically per partition.
?? How do you prevent a celebrity user from overloading one shard?
Detect hot keys, add a salt suffix to spread writes (key#0..key#9), cache reads, or give the hot tenant a dedicated shard.
` },

{ id: 'replication', title: 'Replication', level: 'intermediate', tags: ['replication', 'availability', 'consistency'], viz: 'replication',
  summary: 'Leader-follower, multi-leader and leaderless replication; sync vs async; lag, failover and split brain.',
  body: md`
## Definition
Replication keeps copies of data on multiple nodes for availability, durability and read scaling.

## Models
- **Single-leader** (Postgres, MySQL, MongoDB replica sets): writes to the leader, streamed to followers.
- **Multi-leader**: writes accepted in multiple regions; conflicts must be resolved (last-writer-wins, CRDTs, app logic).
- **Leaderless** (Cassandra, DynamoDB-style): writes to N replicas, success after W acknowledgements, reads from R; R + W > N gives overlap.

## Synchronous vs asynchronous
| | Synchronous | Asynchronous | Semi-sync |
|---|---|---|---|
| Durability on leader loss | no acknowledged data lost | recent writes may be lost | at least one replica has it |
| Write latency | + slowest replica RTT | lowest | + one replica RTT |
| Availability | a slow replica stalls writes | best | good |

## Problems you must address
- **Replication lag**: a user updates their profile then reads from a replica and sees old data. Fix: read-your-writes (route the user's reads to the leader for a few seconds, or wait for LSN).
- **Failover**: detecting leader death (timeouts) and promoting a follower; with async, acknowledged writes can be lost.
- **Split brain**: two leaders accept writes after a partition. Fix: fencing/STONITH, quorum-based election (Patroni with etcd, Raft).

## When NOT to rely on replicas
For read-modify-write logic that must see the latest state (balance checks): read from the leader.

## Architecture
~~~mermaid
flowchart LR
  App -- writes --> L[("Leader")]
  L -- WAL stream sync --> F1[("Follower AZ-b")]
  L -- WAL stream async --> F2[("Follower AZ-c / other region")]
  App -- reads --> F1 & F2
~~~

## Spring Boot implementation
~~~java
// Route read-only transactions to replicas
public class ReadWriteRoutingDataSource extends AbstractRoutingDataSource {
  @Override protected Object determineCurrentLookupKey() {
    return TransactionSynchronizationManager.isCurrentTransactionReadOnly() ? "replica" : "primary";
  }
}
// Wrap it in LazyConnectionDataSourceProxy so the routing decision happens after @Transactional(readOnly=true) is applied.

@Transactional(readOnly = true) public OrderView view(UUID id) { ... }   // goes to replica
@Transactional public void pay(UUID id) { ... }                          // goes to primary
~~~

## Interview questions
?? Users report they cannot see a comment right after posting it. Diagnose.
Read-after-write served by a lagging replica (or a cache). Route that user's subsequent reads to the primary for a short window, or return the created resource in the POST response and render it optimistically.
?? What do R and W mean in quorum replication?
With N replicas, a write succeeds after W acks and a read queries R replicas. If R + W > N, every read overlaps at least one replica with the latest write (assuming no sloppy quorum). For example N=3, W=2, R=2.

## Advanced follow-ups
?? Aurora vs standard Postgres replication?
Aurora separates compute from a distributed storage layer that replicates 6 ways across 3 AZs with a 4/6 write quorum; replicas share storage so lag is typically lower and failover faster. Standard Postgres ships WAL to each replica's own storage.
` },

{ id: 'consistency-models', title: 'Consistency Models', level: 'advanced', tags: ['consistency', 'distributed-systems'], viz: 'node-failure',
  summary: 'Linearizability, sequential, causal, read-your-writes, monotonic reads and eventual consistency, with practical examples.',
  body: md`
## Definition
A consistency model is the contract a distributed store gives about what values reads may return in the presence of concurrent writes and replication.

## The ladder (strongest to weakest)
1. **Linearizable (strong)**: once a write completes, every later read (in real time) sees it. Like one copy. Required for locks, leader election, unique usernames, balances.
2. **Sequential**: all nodes see operations in the same order, not necessarily real-time.
3. **Causal**: causally related operations are seen in order (a reply never appears before the message it replies to).
4. **Session guarantees**: read-your-writes, monotonic reads (never go back in time), monotonic writes, writes-follow-reads.
5. **Eventual**: if writes stop, replicas converge. No ordering promises in between.

## Why it matters
Stronger models need coordination (consensus, quorums), costing latency and availability under partitions. Weaker models are faster and more available but push anomalies to the application.

## When to use what
| Data | Model |
|---|---|
| Account balance, inventory decrement, seat booking | Linearizable / serializable transaction |
| Social feed, like counts, view counts | Eventual |
| Chat messages in a conversation | Causal ordering per conversation |
| User profile edits | Read-your-writes |

## Real-world use case
DynamoDB offers eventually consistent reads by default and strongly consistent reads at higher cost; Cassandra tunes per query ({{QUORUM}}, {{ONE}}); Postgres primary gives strong consistency while replicas are eventually consistent.

## Architecture
~~~mermaid
sequenceDiagram
  participant U as User
  participant P as Primary
  participant R as Replica (lagging)
  U->>P: update display name = "Kartik"
  P-->>U: 200 OK
  U->>R: GET profile
  R-->>U: old name (violates read-your-writes)
~~~

## Spring Boot implementation
~~~java
// Read-your-writes via a short-lived "recently wrote" marker
@PostMapping("/profile") ResponseEntity<?> update(@RequestBody ProfileUpdate u, HttpServletResponse res) {
  profiles.update(u);
  res.addCookie(new Cookie("rw", String.valueOf(Instant.now().plusSeconds(5).toEpochMilli()))); // pin reads to primary for 5s
  return ResponseEntity.noContent().build();
}
~~~

## Interview questions
?? Is eventual consistency acceptable for a shopping cart?
Usually yes with conflict resolution (Amazon Dynamo's original cart merged divergent versions, which could resurrect deleted items). Checkout itself must validate price and stock against strongly consistent sources.

## Advanced follow-ups
?? Linearizability vs serializability?
Serializability is a transaction isolation property (transactions appear in some serial order, not necessarily real-time). Linearizability is a single-object recency guarantee in real time. **Strict serializability** combines both (Spanner).
` },

{ id: 'cap', title: 'CAP Theorem (and PACELC)', level: 'intermediate', tags: ['cap', 'distributed-systems'], viz: 'node-failure',
  summary: 'During a network partition you choose consistency or availability; PACELC adds the latency trade-off when there is no partition.',
  body: md`
## Definition
**CAP**: in the presence of a network **P**artition, a distributed data store must choose between **C**onsistency (linearizability: every read sees the latest write) and **A**vailability (every non-failing node returns a non-error response).

## The precise reading
- Partitions are not optional in real networks, so the choice is really **CP vs AP during a partition**.
- When there is no partition you can have both C and A. "CA systems" only make sense for a single node.
- CAP's C is linearizability, not the C in ACID.

## PACELC
If **P**artition: choose **A** or **C**; **E**lse: choose **L**atency or **C**onsistency. This captures everyday behaviour: synchronous replication costs latency even when the network is healthy.
| System | Partition | Else |
|---|---|---|
| Cassandra / DynamoDB (default) | PA | EL |
| MongoDB (majority writes/reads) | PC | EC |
| Spanner / CockroachDB | PC | EC |
| ZooKeeper / etcd | PC | EC |

## When the choice matters
- Payment ledger, seat booking: prefer CP. Return an error rather than double-spend.
- Shopping cart, social likes, product reviews: prefer AP. Serve possibly stale data and reconcile.

## Architecture
~~~mermaid
flowchart LR
  subgraph DC1["Region A"]
    N1["Node 1"]
  end
  subgraph DC2["Region B"]
    N2["Node 2"]
  end
  N1 x--x|"partition"| N2
  C1["Client A writes x=2"] --> N1
  C2["Client B reads x"] --> N2
  N2 -->|"CP: error / timeout\nAP: returns x=1 (stale)"| C2
~~~

## Spring Boot implementation
~~~java
// Choosing per operation with Cassandra (Spring Data Cassandra)
@Consistency(DefaultConsistencyLevel.LOCAL_QUORUM)   // CP-ish within the region for balance-like data
Optional<Wallet> findById(UUID id);

@Consistency(DefaultConsistencyLevel.ONE)            // AP for feed reads: fast, may be stale
List<FeedItem> findByUserId(UUID userId);
~~~

## Interview questions
?? Is MongoDB CP or AP?
It depends on configuration: with a single primary and majority write/read concerns it behaves CP (minority side cannot accept writes). With {{w:1}} and secondary reads it can return stale data and lose acknowledged writes on failover. Answer with configuration, not a label.
?? Does CAP mean you lose consistency all the time in AP systems?
No, only during partitions (and replication delay). Most of the time replicas converge in milliseconds; the design question is what users see in the rare bad case.
` }
]);
})();
