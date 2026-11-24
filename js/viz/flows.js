/* Scripted flow simulations: microservice request path, Saga, OAuth 2.0, Spring MVC lifecycle. */
(function () {
  const C = (el, cfg) => new LAB.SeqSim(el, cfg);

  /* ============ 1. Request through a microservices architecture ============ */
  LAB.defineViz('request-flow', {
    title: 'Request Flow through Microservices',
    desc: 'Follow POST /orders from the client through load balancer, gateway, order service, cache, database, payment service and Kafka. Toggle cache misses, an expired token, a slow or dead payment service, and explode the order service into its layers.',
    guide: LAB.md`
### What to try
1. Run the happy path once and read each step's explanation on the right.
2. Switch **Cache** to *miss* and notice the extra round trips (DB read, cache populate).
3. Set **Payment service** to *slow*: the call times out and is retried with backoff using the **same idempotency key**.
4. Set it to *down*: the circuit breaker is open, the call fails fast, and the order is saved as PENDING_PAYMENT.
5. Tick **Exploded view** to see filter -> controller -> service -> repository inside the order service.
6. Set **Token** to *expired*: the gateway rejects the request before any service work is done.`,
    create(el) {
      C(el, {
        title: 'POST /api/orders: end-to-end path', height: 470,
        hint: 'Click any component for its role. Use Pause + Step to go one hop at a time.',
        controls: [
          { id: 'cache', type: 'seg', label: 'Product cache', value: 'hit', options: [['hit', 'Hit'], ['miss', 'Miss']] },
          { id: 'payment', type: 'seg', label: 'Payment service', value: 'healthy', options: [['healthy', 'Healthy'], ['slow', 'Slow'], ['down', 'Down']] },
          { id: 'token', type: 'seg', label: 'Access token', value: 'valid', options: [['valid', 'Valid'], ['expired', 'Expired']] },
          { id: 'explode', type: 'check', label: 'Exploded view of order service', value: false, reset: true }
        ],
        nodes: p => {
          const X = p.explode;
          const n = [
            { id: 'client', x: 15, y: 200, w: 110, label: 'Client', sub: 'mobile / web', info: 'Sends HTTPS requests with a bearer token and an Idempotency-Key for the order.' },
            { id: 'lb', x: 150, y: 200, w: 120, label: 'Load balancer', sub: 'L7 · multi-AZ', info: 'Distributes traffic across healthy gateway instances; health checks remove failed targets.' },
            { id: 'gw', x: 295, y: 200, w: 140, label: 'API Gateway', sub: 'JWT · rate limit · routing', info: 'Validates tokens early, applies quotas, routes by path and injects trace headers.' },
            { id: 'order', x: 470, y: 190, w: 160, h: 74, label: 'Order service', sub: 'Spring Boot', hidden: X, info: 'Owns the order aggregate and its database. Calls payment synchronously and publishes events via the outbox.' },
            { id: 'redis', x: 690, y: 40, w: 130, label: 'Redis', sub: 'cache-aside', info: 'Caches product price/stock snapshots with TTL. A miss falls through to the database.' },
            { id: 'pg', x: 690, y: 200, w: 130, label: 'PostgreSQL', sub: 'orders + outbox', info: 'Source of truth. Order and outbox row are written in one local transaction.' },
            { id: 'payment', x: 690, y: 360, w: 130, label: 'Payment svc', sub: 'Resilience4j guarded', info: 'Called with a 2s timeout, retry with jitter, and a circuit breaker.' },
            { id: 'kafka', x: 860, y: 200, w: 125, label: 'Kafka', sub: 'orders.events', info: 'Receives OrderPlaced from the outbox relay (Debezium CDC). Consumers process independently.' },
            { id: 'notif', x: 860, y: 360, w: 125, label: 'Notification', sub: 'consumer group', info: 'Consumes OrderPlaced idempotently (dedup by event id) and sends the confirmation e-mail.' }
          ];
          if (X) n.push(
            { id: 'o-filter', x: 470, y: 110, w: 160, h: 42, label: 'Security filter', sub: '', info: 'Re-validates the JWT (zero trust), builds the SecurityContext.' },
            { id: 'o-ctrl', x: 470, y: 170, w: 160, h: 42, label: 'OrderController', info: '@Valid request body, maps DTOs, returns 201 with Location.' },
            { id: 'o-svc', x: 470, y: 230, w: 160, h: 42, label: 'OrderService', info: '@Transactional proxy; business rules; orchestrates cache, payment and persistence.' },
            { id: 'o-repo', x: 470, y: 290, w: 160, h: 42, label: 'OrderRepository', info: 'Spring Data JPA; HikariCP connection from the pool.' });
          return n;
        },
        edges: p => { const O = p.explode ? 'o-svc' : 'order'; return [['client', 'lb'], ['lb', 'gw'], ['gw', p.explode ? 'o-filter' : 'order'], [O, 'redis'], [p.explode ? 'o-repo' : 'order', 'pg'], [O, 'payment'], ['pg', 'kafka'], ['kafka', 'notif']]; },
        drawBg(sim, ctx, c) {
          if (!sim.params.explode) return;
          sim.rrect(458, 80, 184, 268, 12); ctx.setLineDash([6, 5]); ctx.strokeStyle = c.accent; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
          sim.text(550, 94, 'Order service (exploded)', { size: 11, color: c.accent, align: 'center', bold: true });
        },
        script(p) {
          const X = p.explode, O = id => (X ? id : 'order');
          const s = [
            { from: 'client', to: 'lb', label: 'POST /api/orders over HTTPS', short: 'POST', detail: 'Headers: <code>Authorization: Bearer &lt;JWT&gt;</code>, <code>Idempotency-Key: 7f3a…</code>. TLS is terminated at the load balancer.' },
            { from: 'lb', to: 'gw', label: 'Route to a healthy gateway instance', detail: 'Least-outstanding-requests algorithm; targets failing health checks are not eligible.' },
            { from: 'gw', to: 'gw', label: 'Validate JWT, apply rate limit, add traceparent', detail: 'Signature checked with cached JWKS (no IdP call per request); iss/aud/exp verified; token bucket per user in Redis.' }
          ];
          if (p.token === 'expired') {
            s.push({ from: 'gw', to: 'client', via: ['lb'], label: '401 Unauthorized: token expired', cls: 'bad', short: '401', detail: 'Rejected at the edge: no service resources spent. The client uses its refresh token to get a new access token and retries.' });
            return s;
          }
          s.push({ from: 'gw', to: O('o-filter'), label: 'Forward to order-service', detail: 'Path-based routing; W3C <code>traceparent</code> propagated so every hop appears in one trace.' });
          if (X) s.push(
            { from: 'o-filter', to: 'o-ctrl', label: 'Security filter re-validates token', detail: 'Zero trust: the service does not assume the gateway checked everything. SecurityContext populated from JWT claims.' },
            { from: 'o-ctrl', to: 'o-svc', label: 'Controller validates body, calls OrderService.place()', detail: 'Bean Validation on the DTO; the call goes through the @Transactional proxy, which opens a DB transaction.' });
          s.push({ from: O('o-svc'), to: 'redis', label: 'GET product:42 (price & stock snapshot)', short: 'GET' });
          if (p.cache === 'hit') s.push({ from: 'redis', to: O('o-svc'), label: 'Cache HIT', cls: 'ok', detail: 'Sub-millisecond read; the database is not touched.' });
          else s.push(
            { from: 'redis', to: O('o-svc'), label: 'Cache MISS', cls: 'warn', detail: 'Key absent or expired: fall through to the source of truth.' },
            { from: O('o-repo'), to: 'pg', label: 'SELECT product WHERE id = 42', detail: 'Uses a pooled connection (HikariCP).' },
            { from: 'pg', to: O('o-svc'), label: 'Row returned' },
            { from: O('o-svc'), to: 'redis', label: 'SET product:42 … EX 600 (+ jitter)', detail: 'Populate the cache; TTL jitter avoids synchronized expiry (stampedes).' });
          if (p.payment === 'healthy') s.push(
            { from: O('o-svc'), to: 'payment', label: 'POST /authorizations (Idempotency-Key)', short: 'auth' },
            { from: 'payment', to: O('o-svc'), label: '200 AUTHORIZED', cls: 'ok' });
          else if (p.payment === 'slow') s.push(
            { from: O('o-svc'), to: 'payment', label: 'POST /authorizations (attempt 1)', short: 'auth', status: { payment: 'warn' } },
            { from: 'payment', to: 'payment', label: 'No response within 2s: TimeLimiter fires', cls: 'warn', detail: 'The timeout protects our thread and DB connection. The breaker records a slow call.' },
            { from: O('o-svc'), to: 'payment', label: 'Retry after backoff + jitter (same Idempotency-Key)', short: 'retry', cls: 'warn', detail: 'Safe because the key makes the operation idempotent: if attempt 1 actually succeeded, the provider returns the same result instead of charging twice.' },
            { from: 'payment', to: O('o-svc'), label: '200 AUTHORIZED (retry succeeded)', cls: 'ok' });
          else s.push(
            { from: O('o-svc'), to: O('o-svc'), label: 'Circuit breaker OPEN: call not permitted', cls: 'bad', status: { payment: 'down' }, detail: 'Failure rate exceeded the threshold, so calls fail fast for the wait duration instead of piling up threads.' },
            { from: O('o-svc'), to: O('o-svc'), label: 'Fallback: accept order as PENDING_PAYMENT', cls: 'warn', detail: 'Graceful degradation: the order is persisted and payment is retried asynchronously; the user sees "payment pending".' });
          s.push(
            { from: O('o-repo'), to: 'pg', label: 'BEGIN; INSERT order; INSERT outbox; COMMIT', short: 'tx', detail: 'One local transaction: either both rows exist or neither. This avoids the dual-write problem.' },
            { from: X ? 'o-ctrl' : 'order', to: 'client', via: ['gw', 'lb'], label: '201 Created + Location: /orders/9001', cls: 'ok', short: '201', detail: 'The response does not wait for e-mail or analytics.' },
            { from: 'pg', to: 'kafka', label: 'Outbox relay publishes OrderPlaced', short: 'event', cls: 'info', detail: 'Debezium reads the WAL (CDC) and publishes to Kafka with the order id as key (ordering per order).' },
            { from: 'kafka', to: 'notif', label: 'Notification service consumes & e-mails', cls: 'info', detail: 'At-least-once delivery: the consumer dedupes by event id before sending.' });
          return s;
        }
      });
    }
  });

  /* ============ 2. Saga ============ */
  LAB.defineViz('saga', {
    title: 'Saga: Distributed Transaction with Compensation',
    desc: 'Order -> Inventory -> Payment -> Shipping as local transactions. Inject a failure at any step and watch compensations run in reverse, in orchestration or choreography style.',
    guide: LAB.md`
### What to observe
- Each step is a **local transaction** in its own service; there is no global lock.
- On failure, the saga runs **compensations in reverse order** (void payment, release stock). Compensations are semantic undos, not database rollbacks.
- In **choreography** there is no coordinator: services react to events on the bus. Notice how the overall flow is harder to see in one place.
- Irreversible steps (shipping) are placed **last** so they rarely need compensation.`,
    create(el) {
      C(el, {
        title: 'Place order saga', height: 470,
        controls: [
          { id: 'style', type: 'seg', label: 'Coordination', value: 'orch', options: [['orch', 'Orchestration'], ['chor', 'Choreography']] },
          { id: 'fail', type: 'select', label: 'Inject failure at', value: 'payment', reset: true, options: [['none', 'No failure'], ['inventory', 'Inventory: out of stock'], ['payment', 'Payment: declined'], ['shipping', 'Shipping: no courier']] }
        ],
        nodes: p => [
          { id: 'client', x: 20, y: 205, w: 110, label: 'Customer', info: 'Places an order and receives the final outcome asynchronously (push / polling).' },
          { id: 'order', x: 190, y: 195, w: 170, h: 70, label: p.style === 'orch' ? 'Order svc (orchestrator)' : 'Order service', sub: p.style === 'orch' ? 'persisted saga state' : 'emits/consumes events', info: p.style === 'orch' ? 'Holds the saga state machine (STARTED, STOCK_RESERVED, PAYMENT_AUTHORIZED, COMPLETED / COMPENSATING, CANCELLED) and sends commands via the outbox.' : 'Publishes OrderCreated and updates its status from other services\' events.' },
          { id: 'bus', x: 440, y: 205, w: 120, label: 'Kafka', sub: 'events / commands', hidden: p.style === 'orch', info: 'Event bus for choreography.' },
          { id: 'inv', x: 640, y: 60, w: 150, label: 'Inventory', sub: 'reserve / release', info: 'Reserve = conditional decrement of available stock; Release = compensation.' },
          { id: 'pay', x: 640, y: 205, w: 150, label: 'Payment', sub: 'authorize / void', info: 'Authorize with Idempotency-Key = orderId; Void = compensation (cheaper than refund).' },
          { id: 'ship', x: 640, y: 350, w: 150, label: 'Shipping', sub: 'schedule', info: 'Last step: shipping is hard to compensate, so it runs only after everything else succeeded.' }
        ],
        edges: p => p.style === 'orch' ? [['client', 'order'], ['order', 'inv'], ['order', 'pay'], ['order', 'ship']] : [['client', 'order'], ['order', 'bus'], ['bus', 'inv'], ['bus', 'pay'], ['bus', 'ship']],
        script(p) {
          const f = p.fail, s = [];
          s.push({ from: 'client', to: 'order', label: 'POST /orders', short: 'order' },
                 { from: 'order', to: 'order', label: 'Local tx: INSERT order (PENDING) + saga/outbox row', detail: 'Status PENDING acts as a semantic lock: other operations know the order is in flight.' });
          if (p.style === 'orch') {
            s.push({ from: 'order', to: 'inv', label: 'Command: ReserveStock', short: 'cmd' });
            if (f === 'inventory') { s.push({ from: 'inv', to: 'order', label: 'Reply: OutOfStock', cls: 'bad', status: { inv: 'warn' } }, { from: 'order', to: 'order', label: 'Order CANCELLED (nothing to compensate)', cls: 'warn' }, { from: 'order', to: 'client', label: 'Notify: item out of stock', cls: 'warn' }); return s; }
            s.push({ from: 'inv', to: 'inv', label: 'Local tx: reserved += qty WHERE available >= qty' }, { from: 'inv', to: 'order', label: 'Reply: StockReserved', cls: 'ok' },
                   { from: 'order', to: 'pay', label: 'Command: AuthorizePayment (key = orderId)', short: 'cmd' });
            if (f === 'payment') { s.push({ from: 'pay', to: 'order', label: 'Reply: PaymentDeclined', cls: 'bad', status: { pay: 'warn' } }, { from: 'order', to: 'inv', label: 'COMPENSATE: ReleaseStock', cls: 'warn', short: 'undo', detail: 'Compensations run in reverse order of completed steps and must be idempotent.' }, { from: 'inv', to: 'order', label: 'Reply: StockReleased', cls: 'ok' }, { from: 'order', to: 'order', label: 'Saga CANCELLED, order CANCELLED', cls: 'warn' }, { from: 'order', to: 'client', label: 'Notify: payment declined', cls: 'warn' }); return s; }
            s.push({ from: 'pay', to: 'order', label: 'Reply: PaymentAuthorized', cls: 'ok' }, { from: 'order', to: 'ship', label: 'Command: ScheduleShipment', short: 'cmd' });
            if (f === 'shipping') { s.push({ from: 'ship', to: 'order', label: 'Reply: NoCourierAvailable', cls: 'bad', status: { ship: 'warn' } }, { from: 'order', to: 'pay', label: 'COMPENSATE: VoidAuthorization', cls: 'warn', short: 'undo' }, { from: 'pay', to: 'order', label: 'Reply: Voided', cls: 'ok' }, { from: 'order', to: 'inv', label: 'COMPENSATE: ReleaseStock', cls: 'warn', short: 'undo' }, { from: 'inv', to: 'order', label: 'Reply: StockReleased', cls: 'ok' }, { from: 'order', to: 'order', label: 'Saga CANCELLED', cls: 'warn' }, { from: 'order', to: 'client', label: 'Notify: cannot deliver, no charge made', cls: 'warn' }); return s; }
            s.push({ from: 'ship', to: 'order', label: 'Reply: ShipmentScheduled', cls: 'ok' }, { from: 'order', to: 'order', label: 'Order CONFIRMED, saga COMPLETED', cls: 'ok' }, { from: 'order', to: 'client', label: 'Notify: order confirmed', cls: 'ok' });
            return s;
          }
          // choreography
          s.push({ from: 'order', to: 'bus', label: 'Event: OrderCreated', short: 'evt' }, { from: 'bus', to: 'inv', label: 'Inventory consumes OrderCreated' });
          if (f === 'inventory') { s.push({ from: 'inv', to: 'bus', label: 'Event: StockReservationFailed', cls: 'bad', status: { inv: 'warn' } }, { from: 'bus', to: 'order', label: 'Order consumes, marks CANCELLED', cls: 'warn' }, { from: 'order', to: 'client', label: 'Notify: out of stock', cls: 'warn' }); return s; }
          s.push({ from: 'inv', to: 'bus', label: 'Event: StockReserved', cls: 'ok', short: 'evt' }, { from: 'bus', to: 'pay', label: 'Payment consumes StockReserved' });
          if (f === 'payment') { s.push({ from: 'pay', to: 'bus', label: 'Event: PaymentDeclined', cls: 'bad', status: { pay: 'warn' } }, { from: 'bus', to: 'inv', label: 'Inventory consumes PaymentDeclined: release stock', cls: 'warn', detail: 'In choreography each service must know which events require compensation, which spreads saga logic across services.' }, { from: 'bus', to: 'order', label: 'Order consumes PaymentDeclined: CANCELLED', cls: 'warn' }, { from: 'order', to: 'client', label: 'Notify: payment declined', cls: 'warn' }); return s; }
          s.push({ from: 'pay', to: 'bus', label: 'Event: PaymentAuthorized', cls: 'ok', short: 'evt' }, { from: 'bus', to: 'ship', label: 'Shipping consumes PaymentAuthorized' });
          if (f === 'shipping') { s.push({ from: 'ship', to: 'bus', label: 'Event: ShipmentFailed', cls: 'bad', status: { ship: 'warn' } }, { from: 'bus', to: 'pay', label: 'Payment consumes: void authorization', cls: 'warn' }, { from: 'bus', to: 'inv', label: 'Inventory consumes: release stock', cls: 'warn' }, { from: 'bus', to: 'order', label: 'Order: CANCELLED', cls: 'warn' }, { from: 'order', to: 'client', label: 'Notify: cannot deliver', cls: 'warn' }); return s; }
          s.push({ from: 'ship', to: 'bus', label: 'Event: ShipmentScheduled', cls: 'ok', short: 'evt' }, { from: 'bus', to: 'order', label: 'Order consumes: CONFIRMED', cls: 'ok' }, { from: 'order', to: 'client', label: 'Notify: order confirmed', cls: 'ok' });
          return s;
        }
      });
    }
  });

  /* ============ 3. OAuth 2.0 ============ */
  LAB.defineViz('oauth', {
    title: 'OAuth 2.0 / OIDC Flows',
    desc: 'Authorization Code + PKCE for a mobile app/SPA and Client Credentials for services, with Keycloak as the authorization server. Inject attacks and errors: stolen code, bad redirect URI, expired token with refresh rotation, wrong audience.',
    guide: LAB.md`
### What to observe
- The **code_verifier never leaves the app** until the token request; a stolen code alone is useless.
- The API validates tokens **locally** with cached JWKS: Keycloak is not on the hot path of every API call.
- With **refresh token rotation**, every refresh returns a new refresh token and invalidates the old one; reuse of an old one signals theft.
- **Audience** checks stop tokens minted for other APIs from being accepted.`,
    create(el) {
      C(el, {
        title: 'OAuth 2.0 with Keycloak', height: 470,
        controls: [
          { id: 'flow', type: 'seg', label: 'Flow', value: 'pkce', options: [['pkce', 'Auth Code + PKCE'], ['cc', 'Client Credentials']] },
          { id: 'fault', type: 'select', label: 'Scenario', value: 'none', reset: true, options: [['none', 'Happy path'], ['intercept', 'Attacker intercepts the code'], ['redirect', 'Unregistered redirect_uri'], ['expired', 'Access token expired (refresh)'], ['aud', 'Token for another API (wrong aud)']] }
        ],
        nodes: p => p.flow === 'cc' ? [
          { id: 'svc', x: 40, y: 200, w: 160, label: 'Billing service', sub: 'confidential client', info: 'Machine client authenticating as itself (no user).' },
          { id: 'as', x: 420, y: 60, w: 180, label: 'Keycloak', sub: 'authorization server', info: 'Issues tokens; publishes JWKS; enforces client scopes.' },
          { id: 'api', x: 420, y: 330, w: 180, label: 'Payments API', sub: 'resource server', info: 'Spring Boot resource server validating JWTs locally.' }
        ] : [
          { id: 'user', x: 30, y: 50, w: 130, label: 'User', info: 'Resource owner; authenticates at Keycloak, never gives the password to the app.' },
          { id: 'app', x: 30, y: 250, w: 150, label: 'Mobile app / SPA', sub: 'public client', info: 'Cannot keep a secret, so it uses PKCE. Uses the system browser for login.' },
          { id: 'as', x: 430, y: 50, w: 180, label: 'Keycloak', sub: 'authorization server', info: 'Login + OTP flow, SSO session, code issuance, token endpoint, JWKS.' },
          { id: 'api', x: 430, y: 330, w: 180, label: 'Orders API', sub: 'resource server', info: 'Validates signature, iss, aud, exp, scopes; then object-level authorization.' },
          { id: 'attacker', x: 800, y: 200, w: 150, label: 'Attacker', sub: 'malicious app', hidden: p.fault !== 'intercept', info: 'Registered the same custom URL scheme and grabbed the authorization code.' }
        ],
        edges: p => p.flow === 'cc' ? [['svc', 'as'], ['svc', 'api'], ['api', 'as', { dash: [4, 4] }]] : [['user', 'as'], ['app', 'as'], ['app', 'api'], ['api', 'as', { dash: [4, 4] }]],
        script(p) {
          const s = [], f = p.fault;
          if (p.flow === 'cc') {
            s.push({ from: 'svc', to: 'svc', label: 'Load client credentials', detail: 'Prefer <code>private_key_jwt</code> or mTLS over a shared secret; secrets come from a secrets manager.' },
                   { from: 'svc', to: 'as', label: 'POST /token grant_type=client_credentials scope=payments:write', short: 'token' },
                   { from: 'as', to: 'as', label: 'Authenticate client, check allowed scopes, add audience', detail: 'Audience mapper sets <code>aud=payments-api</code>.' },
                   { from: 'as', to: 'svc', label: 'access_token (JWT, 5 min). No refresh token.', cls: 'ok' },
                   { from: 'svc', to: 'svc', label: 'Cache token until ~30s before expiry', detail: 'Requesting a token per call would overload the IdP.' },
                   { from: 'svc', to: 'api', label: 'POST /payments Authorization: Bearer …', short: 'call' },
                   { from: 'api', to: 'as', label: 'GET /certs (JWKS) only if kid unknown', cls: 'info', detail: 'Keys are cached; Keycloak is not called on every request.' },
                   { from: 'api', to: 'api', label: f === 'aud' ? 'aud = reporting-api ≠ payments-api' : 'Verify signature, iss, aud, exp, scope', cls: f === 'aud' ? 'bad' : '' });
            if (f === 'aud') s.push({ from: 'api', to: 'svc', label: '401 invalid_token (audience)', cls: 'bad' });
            else s.push({ from: 'api', to: 'svc', label: '201 Created', cls: 'ok' });
            return s;
          }
          s.push({ from: 'app', to: 'app', label: 'Create code_verifier & code_challenge = BASE64URL(SHA256(verifier))', detail: 'Random 43-128 char verifier kept in memory; plus <code>state</code> (CSRF) and <code>nonce</code> (ID token replay).' },
                 { from: 'app', to: 'as', label: 'GET /auth?response_type=code&code_challenge=…&method=S256&state&nonce', short: 'authorize', detail: 'Opened in the system browser (ASWebAuthenticationSession / Custom Tabs), not a WebView.' });
          if (f === 'redirect') { s.push({ from: 'as', to: 'as', label: 'redirect_uri not registered for this client', cls: 'bad', detail: 'Exact matching of redirect URIs prevents codes being sent to attacker-controlled URLs. Keycloak shows an error page and issues no code.' }, { from: 'as', to: 'app', label: 'Error: invalid redirect_uri (no code issued)', cls: 'bad' }); return s; }
          s.push({ from: 'as', to: 'user', label: 'Login page (password, then OTP via conditional flow)', short: 'login' },
                 { from: 'user', to: 'as', label: 'Credentials + OTP', short: 'creds' },
                 { from: 'as', to: 'as', label: 'Create SSO session; store code + code_challenge (one-time, ~60s)' },
                 { from: 'as', to: 'app', label: '302 redirect_uri?code=…&state=…', short: 'code' },
                 { from: 'app', to: 'app', label: 'Verify state matches', detail: 'Protects against CSRF / code injection into the user\'s session.' });
          if (f === 'intercept') s.push(
                 { from: 'app', to: 'attacker', label: 'Malicious app intercepts the code', cls: 'bad', short: 'stolen' },
                 { from: 'attacker', to: 'as', label: 'POST /token with stolen code (no verifier)', cls: 'bad', short: 'token?' },
                 { from: 'as', to: 'attacker', label: 'invalid_grant: PKCE verification failed', cls: 'ok', detail: 'Without the verifier the hash cannot match the stored challenge. This is exactly what PKCE prevents.' });
          s.push({ from: 'app', to: 'as', label: 'POST /token grant_type=authorization_code + code_verifier', short: 'token' },
                 { from: 'as', to: 'as', label: 'SHA256(verifier) == challenge? code unused? redirect_uri same?' },
                 { from: 'as', to: 'app', label: 'access_token (5 min, aud=orders-api) + rotating refresh_token + id_token', cls: 'ok', short: 'tokens' },
                 { from: 'app', to: 'api', label: 'GET /orders Authorization: Bearer <access_token>', short: 'call' },
                 { from: 'api', to: 'as', label: 'JWKS fetched once and cached (refresh on unknown kid)', cls: 'info' });
          if (f === 'aud') { s.push({ from: 'api', to: 'api', label: 'aud = loyalty-api ≠ orders-api', cls: 'bad' }, { from: 'api', to: 'app', label: '401 invalid_token (audience)', cls: 'bad', detail: 'Without this check any token from the same issuer would be accepted (token substitution).' }); return s; }
          if (f === 'expired') s.push(
                 { from: 'api', to: 'app', label: '401 token expired', cls: 'warn' },
                 { from: 'app', to: 'as', label: 'POST /token grant_type=refresh_token', short: 'refresh' },
                 { from: 'as', to: 'as', label: 'Rotate: invalidate old refresh token; reuse of old one => revoke family', cls: 'info' },
                 { from: 'as', to: 'app', label: 'New access_token + new refresh_token', cls: 'ok' },
                 { from: 'app', to: 'api', label: 'Retry GET /orders with new token', short: 'retry' });
          s.push({ from: 'api', to: 'api', label: 'Verify signature, iss, aud, exp, scope; then ownership check' },
                 { from: 'api', to: 'app', label: '200 OK: only this user\'s orders', cls: 'ok' });
          return s;
        }
      });
    }
  });

  /* ============ 4. Spring Boot request lifecycle ============ */
  LAB.defineViz('spring-request', {
    title: 'Spring Boot Request Lifecycle',
    desc: 'Tomcat thread, servlet filters and Spring Security, DispatcherServlet, handler mapping, interceptors, argument resolution and validation, controller, transactional service, repository, message converters and @ControllerAdvice. Switch scenarios to see where 401, 403, 400 and rollbacks happen.',
    guide: LAB.md`
### Scenarios
- **Missing token**: rejected by {{BearerTokenAuthenticationFilter}} / {{ExceptionTranslationFilter}} before Spring MVC is involved (401). {{@ControllerAdvice}} never sees it.
- **Wrong role**: authenticated but {{AuthorizationFilter}} (or {{@PreAuthorize}}) denies: 403.
- **Validation error**: argument resolution with {{@Valid}} throws {{MethodArgumentNotValidException}}, mapped by {{@RestControllerAdvice}} to 400 ProblemDetail.
- **Business exception**: the {{@Transactional}} proxy rolls back the transaction, then advice maps it to 409/404.`,
    create(el) {
      C(el, {
        title: 'POST /api/orders inside one Spring Boot service', height: 470,
        controls: [{ id: 'sc', type: 'select', label: 'Scenario', value: 'happy', options: [['happy', 'Happy path (201)'], ['noauth', 'Missing token (401)'], ['forbidden', 'Wrong role (403)'], ['invalid', 'Validation error (400)'], ['exception', 'Business exception -> rollback (409)']] }],
        nodes: [
          { id: 'client', x: 10, y: 205, w: 95, label: 'Client' },
          { id: 'tomcat', x: 125, y: 205, w: 120, label: 'Tomcat', sub: 'connector + thread', info: 'NIO connector accepts the socket; a worker (or virtual) thread processes the request end to end.' },
          { id: 'filters', x: 265, y: 190, w: 150, h: 84, label: 'Filter chain', sub: 'CORS · Security · tracing', info: 'Servlet filters incl. Spring Security FilterChainProxy: BearerTokenAuthenticationFilter, ExceptionTranslationFilter, AuthorizationFilter.' },
          { id: 'ds', x: 440, y: 205, w: 140, label: 'DispatcherServlet', info: 'Front controller of Spring MVC.' },
          { id: 'hm', x: 440, y: 70, w: 140, label: 'HandlerMapping', sub: 'finds controller', info: 'RequestMappingHandlerMapping matches path + method to a handler method.' },
          { id: 'ic', x: 610, y: 70, w: 140, label: 'Interceptor', sub: 'preHandle', info: 'HandlerInterceptor.preHandle/postHandle/afterCompletion (e.g. tenant resolution, timing).' },
          { id: 'ha', x: 610, y: 205, w: 140, label: 'HandlerAdapter', sub: 'args · @Valid', info: 'Argument resolvers bind @PathVariable/@RequestBody (Jackson HttpMessageConverter) and run Bean Validation.' },
          { id: 'ctrl', x: 780, y: 205, w: 130, label: '@RestController', info: 'Thin: maps DTOs and delegates to the service.' },
          { id: 'svc', x: 780, y: 330, w: 130, label: 'OrderService', sub: '@Transactional proxy', info: 'Proxy opens a transaction, invokes the target, commits or rolls back on RuntimeException.' },
          { id: 'repo', x: 610, y: 400, w: 140, label: 'Repository', sub: 'JPA · HikariCP', info: 'Spring Data JPA; connection bound to the transaction.' },
          { id: 'db', x: 440, y: 400, w: 120, label: 'PostgreSQL' },
          { id: 'adv', x: 265, y: 330, w: 150, label: '@ControllerAdvice', sub: 'ProblemDetail', info: 'Maps exceptions thrown during handler execution to RFC 7807 responses.' },
          { id: 'conv', x: 440, y: 315, w: 140, label: 'MessageConverter', sub: 'Jackson', info: 'Serialises the return value to JSON.' }
        ],
        edges: () => [['client', 'tomcat'], ['tomcat', 'filters'], ['filters', 'ds'], ['ds', 'hm'], ['hm', 'ic'], ['ds', 'ha'], ['ha', 'ctrl'], ['ctrl', 'svc'], ['svc', 'repo'], ['repo', 'db'], ['ds', 'conv'], ['ds', 'adv']],
        script(p) {
          const sc = p.sc, s = [
            { from: 'client', to: 'tomcat', label: 'HTTP request arrives', short: 'POST' },
            { from: 'tomcat', to: 'filters', label: 'Worker thread enters the servlet filter chain' }];
          if (sc === 'noauth') { s.push({ from: 'filters', to: 'filters', label: 'No/invalid bearer token: AuthenticationException', cls: 'bad', detail: 'ExceptionTranslationFilter calls the AuthenticationEntryPoint, which writes 401 + WWW-Authenticate.' }, { from: 'filters', to: 'client', via: ['tomcat'], label: '401 Unauthorized (controller never invoked)', cls: 'bad' }); return s; }
          s.push({ from: 'filters', to: 'filters', label: 'JWT validated; SecurityContext populated', cls: 'ok', detail: 'Authorities mapped from Keycloak realm_access / resource_access claims.' });
          if (sc === 'forbidden') { s.push({ from: 'filters', to: 'filters', label: 'AuthorizationFilter: hasAuthority(SCOPE_orders:write) fails', cls: 'bad', detail: 'Authenticated but not permitted -> AccessDeniedException -> AccessDeniedHandler -> 403.' }, { from: 'filters', to: 'client', via: ['tomcat'], label: '403 Forbidden', cls: 'bad' }); return s; }
          s.push({ from: 'filters', to: 'ds', label: 'DispatcherServlet.doDispatch()' },
                 { from: 'ds', to: 'hm', label: 'Find handler: OrderController#create' },
                 { from: 'hm', to: 'ic', label: 'Interceptor preHandle (tenant, timing)' },
                 { from: 'ic', to: 'ha', via: ['ds'], label: 'HandlerAdapter resolves arguments', detail: 'Jackson reads @RequestBody; @Valid triggers Bean Validation.' });
          if (sc === 'invalid') { s.push({ from: 'ha', to: 'ha', label: 'MethodArgumentNotValidException (quantity must be > 0)', cls: 'bad' }, { from: 'ha', to: 'adv', via: ['ds'], label: '@ExceptionHandler builds ProblemDetail', cls: 'warn' }, { from: 'adv', to: 'client', via: ['filters', 'tomcat'], label: '400 Bad Request (problem+json with field errors)', cls: 'bad' }); return s; }
          s.push({ from: 'ha', to: 'ctrl', label: 'Invoke controller method' },
                 { from: 'ctrl', to: 'svc', label: 'Call through @Transactional proxy: BEGIN', detail: 'Connection borrowed from HikariCP and bound to the thread.' },
                 { from: 'svc', to: 'repo', label: 'orderRepository.save(order)' },
                 { from: 'repo', to: 'db', label: 'INSERT (flushed at commit)' });
          if (sc === 'exception') { s.push({ from: 'svc', to: 'svc', label: 'Throws InsufficientStockException (RuntimeException)', cls: 'bad' }, { from: 'svc', to: 'db', via: ['repo'], label: 'Proxy: ROLLBACK', cls: 'warn', detail: 'Unchecked exceptions roll back by default; checked ones do not unless rollbackFor is set.' }, { from: 'svc', to: 'adv', via: ['ctrl', 'ha', 'ds'], label: 'Exception propagates to @ControllerAdvice', cls: 'warn' }, { from: 'adv', to: 'client', via: ['filters', 'tomcat'], label: '409 Conflict (ProblemDetail)', cls: 'bad' }); return s; }
          s.push({ from: 'svc', to: 'db', via: ['repo'], label: 'Proxy: COMMIT, connection returned to pool', cls: 'ok' },
                 { from: 'svc', to: 'ds', via: ['ctrl', 'ha'], label: 'Return OrderDto' },
                 { from: 'ds', to: 'conv', label: 'Jackson writes JSON body' },
                 { from: 'conv', to: 'client', via: ['ds', 'filters', 'tomcat'], label: '201 Created + Location header', cls: 'ok' });
          return s;
        }
      });
    }
  });
})();
