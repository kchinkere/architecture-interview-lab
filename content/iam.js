(function () {
const md = LAB.md;

LAB.add('iam', 'Protocols & Tokens', [
{ id: 'oauth2', title: 'OAuth 2.0', level: 'intermediate', tags: ['oauth2', 'authorization'], viz: 'oauth',
  summary: 'Delegated authorization: roles, grant types, scopes, tokens, and what OAuth is not (authentication).',
  body: md`
## What it is
OAuth 2.0 (RFC 6749) is a **delegated authorization** framework: a resource owner lets a client access protected resources on a resource server, via an access token issued by an authorization server, without sharing credentials.

## Roles
- **Resource owner**: the user.
- **Client**: the app (confidential: can keep a secret, e.g. backend; public: cannot, e.g. SPA, mobile).
- **Authorization server (AS)**: issues tokens (Keycloak, Cognito, Okta, Entra ID).
- **Resource server (RS)**: the API validating tokens.

## Grant types (current best practice, OAuth 2.1 direction)
| Grant | Use | Status |
|---|---|---|
| Authorization Code + PKCE | users in web, SPA, mobile | recommended for all user flows |
| Client Credentials | machine-to-machine | recommended |
| Refresh Token | renew access without user interaction | with rotation for public clients |
| Device Authorization | TVs, CLIs | for input-constrained devices |
| Token Exchange (RFC 8693) | service acting on behalf of user, impersonation | advanced |
| Implicit | tokens in URL fragment | **deprecated** |
| Resource Owner Password Credentials | app collects password | **deprecated** (only legacy migration) |

## Scopes and audience
Scopes limit what the token permits ({{orders:read}}); audience ({{aud}}) names which API the token is for. Resource servers must check both.

## Architecture
~~~mermaid
sequenceDiagram
  participant U as User
  participant C as Client app
  participant AS as Authorization server
  participant RS as Resource server (API)
  U->>C: use app
  C->>AS: authorize request (client_id, scope, redirect_uri, PKCE)
  AS->>U: login + consent
  AS-->>C: authorization code (via redirect)
  C->>AS: exchange code (+ verifier / client auth)
  AS-->>C: access token (+ refresh token)
  C->>RS: API call with Bearer access token
  RS-->>C: protected resource
~~~

## Interview questions
?? Is OAuth 2.0 an authentication protocol?
No. It authorizes access to APIs; the access token is meant for the resource server, not to tell the client who the user is. OpenID Connect adds authentication (ID token, userinfo, standard claims) on top.
?? Why is the implicit flow deprecated?
Tokens are returned in the URL fragment (leaks via history, referrers, logs), no client authentication or PKCE binding, and no refresh tokens. Authorization Code + PKCE solves these for SPAs.
?? What does the "state" parameter protect against?
CSRF on the redirect: the client generates an unguessable value, stores it, and verifies it on callback so an attacker cannot inject their own authorization code into the victim's session.
` },

{ id: 'oidc', title: 'OpenID Connect', level: 'intermediate', tags: ['oidc', 'authentication', 'id-token'],
  summary: 'Identity layer on OAuth 2.0: ID token, nonce, discovery, userinfo, claims and logout.',
  body: md`
## What OIDC adds
- {{scope=openid}} turns an OAuth flow into authentication.
- **ID token**: a JWT for the **client**, asserting who the user is ({{sub}}, {{iss}}, {{aud}}=client_id, {{exp}}, {{iat}}, {{nonce}}, {{auth_time}}, {{acr}}, {{amr}}).
- **UserInfo endpoint** for additional claims.
- **Discovery** ({{/.well-known/openid-configuration}}) and **JWKS** for keys.
- Standard scopes: profile, email, phone, address.
- **Logout**: RP-initiated, front-channel, back-channel logout.

## ID token vs access token
| | ID token | Access token |
|---|---|---|
| Audience | the client | the API (resource server) |
| Purpose | authenticate user to the client | authorize API calls |
| Send to APIs? | **no** | yes |

## Validation the client must do
Signature (JWKS), {{iss}} matches, {{aud}} contains client_id, {{exp}}, and {{nonce}} equals the value sent (prevents replay/injection).

## Spring Boot OIDC login (confidential web client)
~~~yaml
spring:
  security:
    oauth2:
      client:
        registration:
          keycloak:
            client-id: portal
            client-secret: \${PORTAL_SECRET}
            scope: openid,profile,email
            authorization-grant-type: authorization_code
        provider:
          keycloak:
            issuer-uri: https://idp.example.com/realms/retail
~~~
~~~java
@Bean SecurityFilterChain web(HttpSecurity http, ClientRegistrationRepository repo) throws Exception {
  var logout = new OidcClientInitiatedLogoutSuccessHandler(repo);
  logout.setPostLogoutRedirectUri("{baseUrl}/");
  return http.authorizeHttpRequests(a -> a.anyRequest().authenticated())
             .oauth2Login(Customizer.withDefaults())          // PKCE is applied for confidential clients too in recent versions
             .logout(l -> l.logoutSuccessHandler(logout))
             .build();
}
~~~

?? Why shouldn't an API accept ID tokens as bearer tokens?
The audience is the client, not the API; it may lack scopes; accepting it enables token substitution across clients. APIs must require access tokens with their audience.
?? What are acr and amr?
{{acr}}: authentication context class (level of assurance, e.g. MFA achieved). {{amr}}: methods used (pwd, otp, hwk). APIs can demand a minimum acr for sensitive operations (step-up).
` },

{ id: 'saml', title: 'SAML 2.0', level: 'intermediate', tags: ['saml', 'federation', 'enterprise-sso'],
  summary: 'XML-based enterprise SSO: IdP/SP, assertions, bindings, SP- vs IdP-initiated flows, and SAML vs OIDC.',
  body: md`
## Concepts
- **IdP** (e.g. ADFS, Entra ID, Okta) authenticates users; **SP** (service provider, your app or Keycloak acting as SP) consumes signed **assertions**.
- Assertion contains subject (NameID), attributes (email, groups), conditions (audience, validity), authentication statement.
- **Bindings**: HTTP-Redirect (AuthnRequest), HTTP-POST (assertion via auto-submitted form), Artifact.
- Metadata XML exchanges entity IDs, endpoints and certificates.

## SP-initiated flow
~~~mermaid
sequenceDiagram
  participant B as Browser
  participant SP as App / Keycloak (SP)
  participant IdP as Corporate IdP
  B->>SP: access app
  SP-->>B: redirect with AuthnRequest
  B->>IdP: AuthnRequest
  IdP->>B: login (corporate credentials, MFA)
  IdP-->>B: auto-POST SAMLResponse (signed assertion)
  B->>SP: POST to ACS URL
  SP->>SP: validate signature, audience, time, InResponseTo
  SP-->>B: session established
~~~

## SAML vs OIDC
| | SAML | OIDC |
|---|---|---|
| Format | XML, XML-DSig | JSON, JWT |
| Clients | browser-centric | browser, mobile, SPA, APIs |
| Typical use | enterprise SSO, legacy | modern apps, mobile, APIs |
| Complexity | higher (XML canonicalisation pitfalls) | lower |

Common pattern: Keycloak brokers SAML from corporate IdPs and issues OIDC tokens to modern apps.

?? Name SAML security pitfalls.
XML signature wrapping attacks, not validating audience/recipient/InResponseTo, accepting unsigned assertions, clock skew too generous, and replay without tracking assertion IDs. Use mature libraries.
` },

{ id: 'jwt', title: 'JWT (JSON Web Tokens)', level: 'intermediate', tags: ['jwt', 'jws', 'jwe'],
  summary: 'Structure, signing algorithms, validation checklist, key rotation, size and revocation trade-offs, and common attacks.',
  body: md`
## Structure
{{base64url(header).base64url(payload).base64url(signature)}}. Header: {{alg}}, {{kid}}, {{typ}}. Payload: registered claims ({{iss}}, {{sub}}, {{aud}}, {{exp}}, {{nbf}}, {{iat}}, {{jti}}) + custom claims. Signed (JWS) is not encrypted: anyone can read the payload. Use JWE if contents are confidential (or keep secrets out of tokens).

## Algorithms
- **RS256/PS256/ES256** (asymmetric): IdP signs with private key; APIs verify with public keys from JWKS. Standard for IdPs.
- **HS256** (shared secret): every verifier can also mint tokens; only for single-party scenarios.

## Validation checklist (resource server)
1. Parse header; reject {{alg: none}}; allow-list expected algorithms.
2. Find key by {{kid}} in cached JWKS (refresh on unknown kid, rate limited).
3. Verify signature.
4. Check {{iss}}, {{aud}}, {{exp}}/{{nbf}} with small clock skew, token type (access vs ID).
5. Check scopes/roles for the endpoint; then domain-level authorization.

~~~java
@Bean JwtDecoder jwtDecoder() {
  NimbusJwtDecoder d = JwtDecoders.fromIssuerLocation("https://idp.example.com/realms/retail");
  OAuth2TokenValidator<Jwt> audience = jwt -> jwt.getAudience().contains("orders-api")
      ? OAuth2TokenValidatorResult.success()
      : OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token", "wrong audience", null));
  d.setJwtValidator(new DelegatingOAuth2TokenValidator<>(JwtValidators.createDefaultWithIssuer("https://idp.example.com/realms/retail"), audience));
  return d;
}
~~~

## Known attacks
{{alg: none}}, RS256 -> HS256 confusion (using the public key as HMAC secret), {{kid}} injection (path traversal / SQL), {{jku}}/{{x5u}} header pointing to attacker keys, missing audience check, accepting expired tokens due to large skew.

## Trade-offs
Self-contained tokens scale (no lookup per request) but cannot be revoked before expiry without extra state; large tokens (many roles/groups) bloat every request header (watch header size limits on proxies).

?? Where should a SPA store tokens?
Ideally not in JavaScript-accessible storage at all: use a Backend-for-Frontend that keeps tokens server-side and gives the browser an HttpOnly, Secure, SameSite cookie. If tokens must be in the SPA, keep them in memory, use short lifetimes and refresh token rotation; avoid localStorage (XSS exfiltration).
` },

{ id: 'access-refresh', title: 'Access Tokens vs Refresh Tokens', level: 'intermediate', tags: ['tokens', 'rotation'],
  summary: 'Lifetimes, rotation and reuse detection, sliding vs absolute expiry, binding, storage per client type.',
  body: md`
## Roles
- **Access token**: short-lived (5-15 min typical), sent to APIs, ideally audience-scoped.
- **Refresh token**: longer-lived, sent **only** to the authorization server to get new access tokens; must be protected more strictly.

## Rotation and reuse detection
Each refresh returns a new refresh token and invalidates the old one. If an old token is reused (stolen copy), the AS revokes the whole token family/session. Keycloak: "Revoke Refresh Token" with "Refresh Token Max Reuse = 0"; Cognito supports refresh token rotation configuration in newer versions.

## Lifetimes
| Setting | Purpose |
|---|---|
| Access token lifespan | revocation window, load on refresh |
| SSO session idle | logs out inactive users |
| SSO session max | absolute cap regardless of activity |
| Offline tokens | long-lived for background apps (handle with care) |

## Binding (sender-constrained tokens)
DPoP (proof-of-possession with a client key) or mTLS-bound tokens prevent stolen tokens from being replayed elsewhere: required in high-security profiles (FAPI for open banking).

## Storage per client
| Client | Access token | Refresh token |
|---|---|---|
| Backend web app | server session | server session (encrypted) |
| SPA | memory (or BFF) | BFF cookie or rotation in memory |
| Mobile | memory | Keychain / Android Keystore-backed storage |

?? Why not just use a 24-hour access token?
A leaked token stays valid for a day and APIs cannot revoke it without lookups. Short access tokens bound the risk; refresh tokens are checked centrally and can be revoked.
?? What happens if two tabs refresh at the same time with rotation enabled?
One uses the token first; the second presents an already-rotated token and may trigger reuse detection. Mitigate with a short grace period, single-flight refresh in the client (shared lock/BroadcastChannel), or a BFF.
` },

{ id: 'pkce', title: 'Authorization Code Flow with PKCE', level: 'intermediate', tags: ['pkce', 'mobile', 'spa'], viz: 'oauth',
  summary: 'Step-by-step flow, code_verifier/challenge maths, why it stops code interception, and mobile/SPA implementation details.',
  body: md`
## Why PKCE
Public clients cannot keep a client secret. An attacker who intercepts the authorization code (malicious app registering the same custom URL scheme, logs, referrers) could redeem it. PKCE binds the code to a secret only the legitimate client knows.

## The flow
1. Client creates {{code_verifier}}: high-entropy random string (43-128 chars).
2. {{code_challenge = BASE64URL(SHA256(code_verifier))}}, method {{S256}}.
3. Authorize request includes code_challenge (+ state, nonce).
4. AS stores the challenge with the code.
5. Token request includes code_verifier; AS hashes and compares. Mismatch -> {{invalid_grant}}.

~~~java
SecureRandom rnd = new SecureRandom();
byte[] bytes = new byte[32]; rnd.nextBytes(bytes);
String verifier = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
String challenge = Base64.getUrlEncoder().withoutPadding()
    .encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)));
~~~
~~~http
GET /realms/retail/protocol/openid-connect/auth?response_type=code&client_id=mobile-app
    &redirect_uri=com.acme.app:/callback&scope=openid%20offline_access
    &code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=af0ifjsldkj&nonce=n-0S6

POST /realms/retail/protocol/openid-connect/token
grant_type=authorization_code&code=SplxlOBeZQQYbYS6WxSbIA&redirect_uri=com.acme.app:/callback&client_id=mobile-app
&code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
~~~

## Mobile specifics
Use the system browser ({{ASWebAuthenticationSession}} / Custom Tabs) via AppAuth, not an embedded WebView (phishing, no SSO, credential capture). Prefer claimed HTTPS redirect URIs (Universal/App Links) over custom schemes.

## Keycloak configuration
Client: public, Standard Flow on, Direct Access Grants off, "Proof Key for Code Exchange Code Challenge Method" = S256, exact redirect URIs (no wildcards in production).

?? Does PKCE replace the client secret for confidential clients?
No, it complements it. OAuth 2.1 recommends PKCE for all clients, including confidential ones, because it also prevents authorization code injection.
?? Why S256 instead of plain?
With plain, the challenge equals the verifier, so anyone who sees the authorize request (logs, proxies) learns the verifier. S256 sends only a hash.
` },

{ id: 'client-credentials', title: 'Client Credentials Flow', level: 'beginner', tags: ['m2m', 'service-accounts'],
  summary: 'Machine-to-machine tokens, client authentication methods, token caching, audience scoping and service accounts.',
  body: md`
## When
A service calls another service as itself (no user): batch jobs, internal integrations, partner backends.

## Flow
~~~http
POST /realms/internal/protocol/openid-connect/token
Content-Type: application/x-www-form-urlencoded
grant_type=client_credentials&client_id=billing-svc&client_secret=***&scope=payments:write
-> { "access_token": "...", "expires_in": 300, "token_type": "Bearer" }
~~~
Prefer stronger client authentication than shared secrets: {{private_key_jwt}} (client signs an assertion) or mTLS.

## Spring Boot client with automatic token caching
~~~yaml
spring:
  security:
    oauth2:
      client:
        registration:
          payments:
            provider: internal
            client-id: billing-svc
            client-secret: \${BILLING_CLIENT_SECRET}
            authorization-grant-type: client_credentials
            scope: payments:write
        provider:
          internal: { token-uri: https://idp.example.com/realms/internal/protocol/openid-connect/token }
~~~
~~~java
@Bean RestClient paymentsClient(RestClient.Builder b, OAuth2AuthorizedClientManager mgr) {
  var interceptor = new OAuth2ClientHttpRequestInterceptor(mgr);   // Spring Security 6.4+
  interceptor.setClientRegistrationIdResolver(req -> "payments");
  return b.baseUrl("https://payments.internal").requestInterceptor(interceptor).build();
}
~~~

## Best practices
One client per service (least privilege), audience-restricted tokens, cache tokens until near expiry (do not request per call), rotate secrets, monitor token issuance rates.

?? When should a service propagate the user's token instead?
When the downstream needs the end user's identity and permissions (e.g. fetching "my orders"). Use token exchange to obtain a token with the right audience rather than forwarding the original token everywhere.
` }
]);

LAB.add('iam', 'Keycloak', [
{ id: 'keycloak-architecture', title: 'Keycloak Architecture', level: 'intermediate', tags: ['keycloak', 'quarkus', 'infinispan'],
  summary: 'Quarkus-based server, DB + Infinispan caches, clustering, hostname/proxy config, deployment and scaling.',
  body: md`
## Components
- **Keycloak server** (Quarkus distribution since v17): stateless-ish HTTP nodes.
- **Relational database** (Postgres recommended): realms, clients, users, credentials, persistent sessions (v25+ persists user sessions by default).
- **Infinispan**: embedded distributed caches for sessions, authentication sessions, action tokens, and local caches for realms/users (invalidated across the cluster). Multi-site setups use an external Infinispan.
- **SPIs**: extension points (authenticators, user storage, event listeners, protocol mappers, themes).

~~~mermaid
flowchart LR
  LB["Load balancer (sticky by AUTH_SESSION_ID cookie optional)"] --> K1["Keycloak node 1"] & K2["Keycloak node 2"] & K3["Keycloak node 3"]
  K1 <--> IS["Infinispan cluster (JGroups / external ISPN for multi-site)"]
  K2 <--> IS
  K3 <--> IS
  K1 & K2 & K3 --> PG[("PostgreSQL (HA)")]
  K1 -.-> LDAP["LDAP / AD (user federation)"]
  K1 -.-> EXT["External IdPs (Google, SAML corporate, UAE PASS)"]
~~~

## Production configuration essentials
~~~bash
bin/kc.sh build --db=postgres --features=token-exchange --health-enabled=true --metrics-enabled=true
bin/kc.sh start --optimized --hostname=https://idp.example.com --proxy-headers=xforwarded \
  --db-url=jdbc:postgresql://pg:5432/keycloak --db-username=kc --db-password=*** --cache=ispn --cache-stack=kubernetes
~~~
- Run behind TLS-terminating proxy with correct hostname and forwarded headers (wrong config breaks redirects and token {{iss}}).
- Use the Keycloak Operator on Kubernetes; readiness/health endpoints on the management port.
- Scale horizontally; DB connection pool sized per node; token signing and password hashing are CPU-heavy (password hashing iterations affect login throughput).

## Performance considerations
Login throughput is dominated by password hashing cost and DB writes for sessions/events; token refresh and introspection are cheaper; JWKS-based validation at APIs removes most runtime load from Keycloak.

?? Users get logged out when a Keycloak pod restarts. Why?
Sessions only in memory with insufficient owners/replication, or older versions without persistent sessions. Configure distributed cache owners ≥ 2 or persistent user sessions (default in recent versions), and graceful rolling restarts.
?? Why is "iss" in tokens wrong after deploying behind a load balancer?
Hostname/proxy settings: Keycloak builds URLs from the hostname option and forwarded headers. Set {{--hostname}} and {{--proxy-headers}} correctly so issuer matches what clients and resource servers expect.
` },

{ id: 'realms-clients-roles', title: 'Realms, Clients, Roles & Groups', level: 'beginner', tags: ['keycloak', 'rbac', 'configuration'],
  summary: 'The Keycloak data model: realms as tenants, client types and settings, realm vs client roles, composite roles, groups and mappers.',
  body: md`
## Model
- **Realm**: isolated namespace (users, clients, roles, keys, flows, themes). Often one per tenant/environment. The {{master}} realm is for administration only.
- **Client**: an application or service registered in a realm. Types: confidential (has secret/key), public (SPA/mobile), bearer-only concept now represented by clients without flows enabled.
- **Roles**: realm roles (global in the realm) and client roles (scoped to one client/API). **Composite roles** contain other roles.
- **Groups**: hierarchical; users inherit group roles and attributes (e.g. {{/acme/finance}}).
- **Client scopes**: reusable sets of protocol mappers and role scope mappings; default vs optional scopes control what goes into tokens.
- **Protocol mappers**: add claims (user attribute -> claim, group membership, audience mapper, hardcoded claim).

## Designing roles for APIs
~~~text
Client "orders-api": client roles  order:read, order:write, order:refund
Client "portal" (frontend): client scope "orders" maps order:* roles + Audience mapper (aud=orders-api)
Group "/support": client role order:read, order:refund
User alice in group /support
=> access token for portal: aud=[orders-api], resource_access.orders-api.roles=[order:read, order:refund]
~~~

## Client settings that matter
Valid redirect URIs (exact), web origins (CORS), PKCE method, access token lifespan overrides, consent, service accounts enabled (client credentials), full scope allowed (turn **off** to limit roles in tokens).

~~~json
{
  "realm_access": { "roles": ["customer"] },
  "resource_access": { "orders-api": { "roles": ["order:read"] } },
  "aud": ["orders-api"], "azp": "portal", "scope": "openid profile orders"
}
~~~

?? Realm roles or client roles for API permissions?
Client roles on the API's client keep permissions scoped to that API and avoid a giant global role list. Realm roles for cross-cutting personas (admin, customer).
?? Why turn off "Full scope allowed"?
Otherwise every role the user has across all clients is included in every token (bloat and over-privilege). Restrict via client scope role mappings.
` },

{ id: 'keycloak-spi', title: 'Custom Keycloak SPIs', level: 'advanced', tags: ['keycloak', 'spi', 'extensions'],
  summary: 'SPI/Provider/ProviderFactory model, common extension points, packaging/deploying providers, and an event listener example.',
  body: md`
## The model
- **SPI**: an extension point interface (e.g. {{EventListenerProvider}}).
- **ProviderFactory**: singleton per server, created at startup ({{init}}, {{postInit}}, {{create(session)}}).
- **Provider**: per-request instance created by the factory with a {{KeycloakSession}}.
- Registered via {{META-INF/services/<FactoryInterface>}}; packaged as a jar in {{providers/}} then {{kc.sh build}}.

## Common SPIs
| SPI | Use |
|---|---|
| Authenticator | custom login steps (OTP via local SMS gateway, risk checks) |
| RequiredAction | force an action after login (accept terms, verify phone) |
| User Storage | federate users from a legacy DB/API |
| EventListener | push login/admin events to Kafka/SIEM |
| ProtocolMapper | custom token claims (e.g. entitlements from an external service) |
| Theme / FreeMarker | branding, localisation (Arabic RTL) |
| REST resource (RealmResourceProvider) | custom endpoints within a realm |

## Event listener to Kafka (sketch)
~~~java
public class KafkaEventListenerProvider implements EventListenerProvider {
  private final KafkaProducer<String, String> producer; private final ObjectMapper om = new ObjectMapper();
  KafkaEventListenerProvider(KafkaProducer<String, String> p) { this.producer = p; }

  @Override public void onEvent(Event e) {
    if (e.getType() == EventType.LOGIN || e.getType() == EventType.LOGIN_ERROR) {
      Map<String, Object> m = Map.of("type", e.getType().name(), "realm", e.getRealmId(), "user", String.valueOf(e.getUserId()),
                                     "ip", String.valueOf(e.getIpAddress()), "time", e.getTime());
      producer.send(new ProducerRecord<>("iam.events", e.getRealmId(), write(m)));   // async; never block the login thread
    }
  }
  @Override public void onEvent(AdminEvent e, boolean includeRepresentation) { /* audit admin changes */ }
  @Override public void close() {}
  private String write(Object o) { try { return om.writeValueAsString(o); } catch (Exception ex) { return "{}"; } }
}

public class KafkaEventListenerProviderFactory implements EventListenerProviderFactory {
  private KafkaProducer<String, String> producer;
  public EventListenerProvider create(KeycloakSession s) { return new KafkaEventListenerProvider(producer); }
  public void init(Config.Scope config) { producer = new KafkaProducer<>(props(config.get("bootstrapServers"))); }
  public void postInit(KeycloakSessionFactory f) {}
  public void close() { producer.close(); }
  public String getId() { return "kafka-events"; }
}
// META-INF/services/org.keycloak.events.EventListenerProviderFactory -> com.acme.kc.KafkaEventListenerProviderFactory
~~~

## Engineering practices
- Pin to the Keycloak version; SPIs are not all stable public APIs, so upgrades need regression tests (Testcontainers Keycloak).
- Never block request threads on slow remote calls without timeouts; use circuit breakers.
- Expose config via {{Config.Scope}} (spi options) rather than hardcoding.

?? How do you test a custom provider?
Unit-test logic separately; integration-test by building the jar into a Keycloak Testcontainer ({{dasniko/testcontainers-keycloak}}) and driving flows via HTTP/Selenium/Playwright.
` },

{ id: 'custom-authenticator', title: 'Custom Authenticators', level: 'advanced', tags: ['keycloak', 'authenticator', 'otp', 'mfa'],
  summary: 'Building an SMS/WhatsApp OTP authenticator: Authenticator + Factory, auth session notes, forms, attempt limits and configuration.',
  body: md`
## Lifecycle of an Authenticator
- {{authenticate(context)}}: called when the execution is reached (generate OTP, render form, or skip).
- {{action(context)}}: called on form submission (validate input).
- {{requiresUser()}}, {{configuredFor(...)}}, {{setRequiredActions(...)}}.
- Outcomes: {{context.success()}}, {{context.failureChallenge(...)}}, {{context.attempted()}}, {{context.challenge(form)}}.
- State across steps: **authentication session notes** ({{context.getAuthenticationSession().setAuthNote(...)}}).

## SMS OTP authenticator
~~~java
public class SmsOtpAuthenticator implements Authenticator {
  private static final String CODE = "otp-hash", EXP = "otp-exp", TRIES = "otp-tries";

  @Override public void authenticate(AuthenticationFlowContext ctx) {
    UserModel user = ctx.getUser();
    String phone = user.getFirstAttribute("phone_number");
    if (phone == null) { ctx.attempted(); return; }                            // let flow decide (e.g. alternative)
    AuthenticatorConfigModel cfg = ctx.getAuthenticatorConfig();
    int length = Integer.parseInt(cfg.getConfig().getOrDefault("length", "6"));
    int ttl = Integer.parseInt(cfg.getConfig().getOrDefault("ttlSeconds", "300"));

    String code = SecretGenerator.getInstance().randomString(length, SecretGenerator.DIGITS);
    AuthenticationSessionModel as = ctx.getAuthenticationSession();
    as.setAuthNote(CODE, sha256(code));                                       // never store the raw code
    as.setAuthNote(EXP, String.valueOf(Time.currentTime() + ttl));
    as.setAuthNote(TRIES, "0");
    SmsGateway.from(ctx.getSession(), cfg).send(phone, msg(ctx, code));        // provider behind an interface, with timeout

    ctx.challenge(ctx.form().setAttribute("phoneMasked", mask(phone)).createForm("sms-otp.ftl"));
  }

  @Override public void action(AuthenticationFlowContext ctx) {
    AuthenticationSessionModel as = ctx.getAuthenticationSession();
    String entered = ctx.getHttpRequest().getDecodedFormParameters().getFirst("code");
    int tries = Integer.parseInt(as.getAuthNote(TRIES)) + 1;
    as.setAuthNote(TRIES, String.valueOf(tries));

    if (Time.currentTime() > Long.parseLong(as.getAuthNote(EXP))) {
      ctx.failureChallenge(AuthenticationFlowError.EXPIRED_CODE, ctx.form().setError("otpExpired").createForm("sms-otp.ftl")); return;
    }
    if (tries > 5) { ctx.failure(AuthenticationFlowError.INVALID_CREDENTIALS); return; }      // brute-force cap
    if (entered != null && MessageDigest.isEqual(sha256(entered).getBytes(), as.getAuthNote(CODE).getBytes())) {
      ctx.success(); return;                                                                  // constant-time compare
    }
    ctx.failureChallenge(AuthenticationFlowError.INVALID_CREDENTIALS, ctx.form().setError("otpInvalid").createForm("sms-otp.ftl"));
  }

  @Override public boolean requiresUser() { return true; }
  @Override public boolean configuredFor(KeycloakSession s, RealmModel r, UserModel u) { return u.getFirstAttribute("phone_number") != null; }
  @Override public void setRequiredActions(KeycloakSession s, RealmModel r, UserModel u) {}
  @Override public void close() {}
}
~~~
The factory ({{AuthenticatorFactory}}) declares id, display type, configurable properties (length, TTL, provider), requirement choices (REQUIRED, ALTERNATIVE, CONDITIONAL, DISABLED) and registers via {{META-INF/services/org.keycloak.authentication.AuthenticatorFactory}}.

## Production concerns
- Rate limit OTP sends per user/phone/IP (resend cooldown) to stop SMS pumping.
- Brute-force detection integration (Keycloak's built-in brute-force protection counts failures).
- Localised templates (English/Arabic) and accessibility.
- Provider failover and timeouts; do not leak whether a phone number exists.

?? Where do you keep OTP state: auth notes or user attributes?
Auth session notes: scoped to this login attempt, expire with the auth session, and do not persist to the user record. User attributes would persist and leak across sessions.
?? How do you make OTP conditional (only for new devices)?
Put it under a Conditional sub-flow with a custom condition authenticator (device cookie/fingerprint known?), or use Keycloak's "Condition - user configured"/"Condition - user attribute" plus a custom risk condition.
` },

{ id: 'auth-flows', title: 'Authentication Flows', level: 'intermediate', tags: ['keycloak', 'flows', 'step-up'],
  summary: 'Browser/direct-grant/registration/reset flows, executions and requirements, conditional sub-flows, step-up with acr/LoA.',
  body: md`
## Flow structure
A flow is a tree of **executions** (authenticators or sub-flows) each with a requirement:
- **REQUIRED**: must succeed.
- **ALTERNATIVE**: one alternative at this level must succeed.
- **CONDITIONAL**: sub-flow executed only if its condition executions evaluate true.
- **DISABLED**.

## Example: browser flow with conditional OTP
~~~text
Browser (custom)
 ├─ Cookie                                   ALTERNATIVE   (existing SSO session)
 ├─ Identity Provider Redirector             ALTERNATIVE   (kc_idp_hint)
 └─ Forms                                    ALTERNATIVE
     ├─ Username Password Form               REQUIRED
     └─ Second factor                        CONDITIONAL
         ├─ Condition - user role (customer) REQUIRED
         ├─ Condition - Level of Authentication (LoA 2)  REQUIRED
         └─ SMS OTP (custom)                 REQUIRED
~~~

## Step-up authentication
Clients request a higher level via {{acr_values}} or the {{claims}} parameter; Keycloak maps acr to Level of Authentication in conditional flows; tokens carry {{acr}}. The API demands a minimum acr for sensitive actions (e.g. adding a beneficiary) and returns an error that makes the client re-authenticate with higher acr.

## Other flows
- **Direct grant** (password grant): disable for public clients; legacy only.
- **Registration**: add terms acceptance, phone verification required action.
- **Reset credentials**: protect with OTP/email verification and rate limiting.
- **First broker login**: what happens when a user arrives from an external IdP (link existing account, review profile).

?? A user logs in with Google and an account with the same email exists. What should happen?
Do not auto-link blindly (account takeover risk if the external IdP does not verify email). Configure first broker login to require verification of the existing account (password/email confirmation) before linking, or trust only IdPs that assert verified emails.
` },

{ id: 'federation', title: 'Identity Federation & Brokering', level: 'intermediate', tags: ['federation', 'idp-brokering', 'ldap'],
  summary: 'Identity brokering (OIDC/SAML IdPs), user federation (LDAP/AD, custom storage), claim mapping and account linking.',
  body: md`
## Two different things
- **Identity brokering**: Keycloak delegates authentication to an external IdP (Google, Entra ID via OIDC/SAML, national ID such as UAE PASS or DigiLocker-based eKYC flows) and then issues its own tokens. Users are imported/linked locally.
- **User federation**: Keycloak validates credentials against an external user store (LDAP/AD, or a custom User Storage SPI over a legacy DB) and optionally syncs users.

~~~mermaid
flowchart LR
  App["Apps (OIDC clients)"] --> KC["Keycloak (broker)"]
  KC -->|OIDC| G["Google"]
  KC -->|SAML| AD["Corporate Entra ID / ADFS"]
  KC -->|OIDC| NID["National digital ID"]
  KC -->|"LDAP federation"| LDAP["Active Directory"]
  KC -->|"User Storage SPI"| LEG["Legacy customer DB"]
~~~

## Mappers
IdP mappers transform external claims/attributes into local user attributes, roles or groups (e.g. AD group "Finance" -> client role invoice:approve). Keep mapping explicit and minimal.

## Benefits
Apps integrate once (OIDC with Keycloak) regardless of upstream IdPs; central policies (MFA, session lifetimes); tenant-specific IdPs via {{kc_idp_hint}} or organization domains.

## Risks
Trusting unverified emails for linking, mapping too many privileges from external groups, outages of upstream IdPs (communicate dependency), attribute drift between systems.

?? How do you migrate users from a legacy system without a big-bang password reset?
Custom User Storage provider validating against legacy hashes on login and importing the user (lazy migration), plus a bulk import of profiles without credentials; decommission once most active users migrated.
` }
]);

LAB.add('iam', 'AWS Cognito & OTP', [
{ id: 'cognito', title: 'AWS Cognito', level: 'intermediate', tags: ['cognito', 'aws', 'user-pools'],
  summary: 'User pools vs identity pools, app clients, hosted UI, tokens, groups, limits/quotas and when Cognito fits.',
  body: md`
## Building blocks
- **User pool**: user directory + OIDC/OAuth2 authorization server (hosted UI / managed login, app clients, groups, MFA, federation with SAML/OIDC/social IdPs).
- **Identity pool**: exchanges tokens (from user pool or other IdPs) for temporary **AWS credentials** (STS) to call AWS services directly (S3 uploads from mobile).
- **App clients**: per application; public (no secret) for SPA/mobile, confidential for backends; allowed OAuth flows and scopes; token validity settings.
- **Resource servers & custom scopes**: for API authorization ({{orders/read}}).
- **Groups**: appear in {{cognito:groups}} claim; can map to IAM roles in identity pools.

## Tokens
ID token (identity claims), access token (scopes, groups; audience is via {{client_id}} claim rather than {{aud}}), refresh token (configurable validity, rotation supported in newer configurations). APIs validate using the pool's JWKS ({{https://cognito-idp.<region>.amazonaws.com/<poolId>/.well-known/jwks.json}}).

~~~yaml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://cognito-idp.me-central-1.amazonaws.com/me-central-1_AbCdEf
~~~
~~~java
// Cognito access tokens carry client_id instead of aud: validate it explicitly
OAuth2TokenValidator<Jwt> clientIdValidator = jwt -> "6v1h2abcd3efgh".equals(jwt.getClaimAsString("client_id"))
    ? OAuth2TokenValidatorResult.success() : OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token"));
~~~

## When Cognito fits / doesn't
Fits: AWS-native apps, zero IdP operations, Lambda-based customisation, API Gateway authorizers. Consider Keycloak or others when you need deep flow customisation, on-prem/in-country hosting where the region is unavailable, complex multi-tenant realms, or fine control over token formats. Check quotas (API request rates per category) for high-volume login/OTP scenarios.

?? How do you protect an API Gateway endpoint with Cognito?
Cognito user pool authorizer (validates JWT, scopes) on REST APIs, or JWT authorizer on HTTP APIs with issuer and audience/client id; the backend still performs object-level authorization.
` },

{ id: 'lambda-triggers', title: 'Cognito Lambda Triggers', level: 'advanced', tags: ['cognito', 'lambda', 'custom-auth'],
  summary: 'Pre sign-up, post confirmation, pre/post authentication, pre token generation, user migration and custom auth challenge triggers.',
  body: md`
## Trigger catalogue
| Trigger | Typical use |
|---|---|
| Pre sign-up | validate/deny registrations, auto-confirm (e.g. phone verified elsewhere), block disposable emails |
| Post confirmation | create customer profile in your DB, send welcome |
| Pre authentication | block suspended users, geo/risk checks |
| Post authentication | audit, last-login tracking |
| **Pre token generation** | add/override claims (tenant id, entitlements), suppress claims; V2 events can customise access tokens |
| **User migration** | lazy migration from a legacy store on sign-in/forgot password |
| **Define / Create / Verify auth challenge** | custom authentication flows (passwordless OTP, magic link) |
| Custom message / custom SMS sender | localise messages, use your own SMS provider (with KMS-encrypted codes) |

## Practices
- Triggers are on the login critical path: keep them fast (Cognito enforces a short timeout, about 5 seconds), avoid cold-start-heavy runtimes or use provisioned concurrency/SnapStart for Java.
- Idempotency (retries can happen), structured logs without secrets, least-privilege IAM roles.
- Errors thrown from triggers surface as authentication failures: map to user-friendly messages.

## Pre token generation (Java)
~~~java
public class PreTokenHandler implements RequestHandler<Map<String, Object>, Map<String, Object>> {
  @SuppressWarnings("unchecked")
  public Map<String, Object> handleRequest(Map<String, Object> event, Context ctx) {
    var request = (Map<String, Object>) event.get("request");
    var attrs = (Map<String, String>) request.get("userAttributes");
    String tenant = attrs.getOrDefault("custom:tenant_id", "default");
    var claims = Map.of("tenant_id", tenant, "plan", entitlementCache.planFor(tenant));     // cached lookup, no slow calls
    event.put("response", Map.of("claimsOverrideDetails", Map.of("claimsToAddOrOverride", claims)));
    return event;
  }
}
~~~

?? How would you migrate 2M users from a legacy DB to Cognito without password resets?
User Migration trigger: on sign-in for an unknown user, Cognito calls the Lambda with username/password; the Lambda verifies against the legacy hash and returns attributes; Cognito creates the user with that password. Bulk-import inactive users without passwords and force reset for them.
` },

{ id: 'otp-auth', title: 'OTP Authentication', level: 'advanced', tags: ['otp', 'mfa', 'passwordless', 'security'],
  summary: 'SMS/WhatsApp/email OTP and TOTP: generation, storage, expiry, attempts, resend, delivery, fraud, and Cognito custom auth implementation.',
  body: md`
## Design requirements
- Cryptographically random codes (6 digits typical), short TTL (3-5 min), single use.
- Store **hashed** (with per-challenge salt or HMAC) bound to the challenge/session, not just to the phone.
- Attempt limits per challenge (e.g. 3-5), resend cooldown (e.g. 30-60s) and daily caps per phone/device/IP.
- Constant-time comparison; generic error messages (no user enumeration).
- Delivery: SMS (operator routes, local aggregators in UAE/India; India requires DLT-registered templates), WhatsApp, email; failover.
- Fraud: SMS pumping (artificially inflated traffic to premium numbers), SIM swap risks: treat SMS OTP as weaker than TOTP/passkeys for high-value actions.

## TOTP (authenticator apps)
RFC 6238: HMAC-SHA1 over time steps of 30s, shared secret enrolled via QR; verify with a small window (±1 step), prevent reuse of the same step.

## Passwordless OTP with Cognito custom auth
~~~mermaid
sequenceDiagram
  participant App
  participant Cog as Cognito user pool
  participant Def as Define auth challenge
  participant Cre as Create auth challenge
  participant Ver as Verify auth challenge
  participant SMS as SMS provider
  App->>Cog: InitiateAuth(CUSTOM_AUTH, phone)
  Cog->>Def: session history = []
  Def-->>Cog: issue CUSTOM_CHALLENGE
  Cog->>Cre: create challenge
  Cre->>SMS: send code (private params keep hash)
  Cog-->>App: challenge + session
  App->>Cog: RespondToAuthChallenge(code)
  Cog->>Ver: verify(answer vs private params)
  Ver-->>Cog: answerCorrect
  Cog->>Def: history = [correct]
  Def-->>Cog: issueTokens = true
  Cog-->>App: ID, access, refresh tokens
~~~
~~~java
// Define auth challenge: allow up to 3 attempts, then fail
public Map<String, Object> handleRequest(Map<String, Object> e, Context c) {
  var session = (List<Map<String, Object>>) ((Map<String, Object>) e.get("request")).get("session");
  var resp = new HashMap<String, Object>();
  boolean lastCorrect = !session.isEmpty() && Boolean.TRUE.equals(session.get(session.size() - 1).get("challengeResult"));
  if (lastCorrect) { resp.put("issueTokens", true); resp.put("failAuthentication", false); }
  else if (session.size() >= 3) { resp.put("issueTokens", false); resp.put("failAuthentication", true); }
  else { resp.put("issueTokens", false); resp.put("failAuthentication", false); resp.put("challengeName", "CUSTOM_CHALLENGE"); }
  e.put("response", resp); return e;
}
~~~
Create challenge generates the code, sends it, and stores the hash in {{privateChallengeParameters}} (never returned to the client); verify compares. Add a rate limiter (DynamoDB/Redis) keyed by phone in Create challenge.

## Spring Boot OTP service (custom, outside an IdP)
~~~java
public OtpChallenge start(String phone) {
  rateLimiter.check("otp:send:" + phone, 3, Duration.ofMinutes(10));
  String code = String.format("%06d", secureRandom.nextInt(1_000_000));
  OtpChallenge ch = OtpChallenge.create(phone, hmac(code), clock.instant().plus(Duration.ofMinutes(5)));
  repo.save(ch);                                                     // TTL in Redis/DynamoDB
  sms.send(phone, templates.render("otp", Map.of("code", code)));    // never log the code
  return ch;                                                         // return challengeId only
}
public boolean verify(String challengeId, String code) {
  OtpChallenge ch = repo.lockById(challengeId).orElseThrow();
  if (ch.isUsed() || ch.expired(clock.instant()) || ch.attempts() >= 5) return false;
  ch.incrementAttempts();
  boolean ok = MessageDigest.isEqual(ch.codeHash(), hmac(code));
  if (ok) ch.markUsed();
  repo.save(ch);
  return ok;
}
~~~

?? Why bind the OTP to a challenge id instead of only the phone number?
Prevents replay across sessions and attempts racing on the same phone, and lets you cap attempts per challenge; the client must hold the challenge id from the same session.
?? How do you avoid user enumeration with OTP?
Return the same response whether the phone exists or not ("if this number is registered you will receive a code"), apply the same timing, and rate limit.
` }
]);

LAB.add('iam', 'Sessions & Authorization', [
{ id: 'session-management', title: 'Session Management', level: 'intermediate', tags: ['sessions', 'cookies', 'sso'],
  summary: 'IdP sessions vs application sessions vs tokens, cookie security, idle/absolute timeouts, concurrent sessions and BFF.',
  body: md`
## Three layers of "session"
1. **IdP SSO session** (Keycloak cookie {{KEYCLOAK_SESSION}}/{{KEYCLOAK_IDENTITY}}): enables SSO across clients.
2. **Application session** (server-side session or BFF cookie) holding tokens.
3. **Tokens** themselves (stateless access tokens, refresh tokens tied to the IdP session).

Logging out of one does not automatically end the others: design logout across all layers (RP-initiated logout + back-channel logout + token revocation).

## Cookie security
{{HttpOnly}}, {{Secure}}, {{SameSite=Lax/Strict}} (None only with Secure for cross-site), narrow Path/Domain, short-lived, rotate session id on login (session fixation protection).

## Timeouts
Idle timeout (inactivity) and absolute timeout (max lifetime). Banking apps in the UAE/India commonly use short idle timeouts (minutes) with re-authentication for sensitive actions.

## Concurrent sessions
Limit sessions per user (e.g. one active mobile session), show active devices and allow remote logout; Spring Session with Redis for clustered server sessions.

## BFF pattern for SPAs
~~~mermaid
flowchart LR
  SPA["SPA (no tokens in JS)"] -->|"HttpOnly session cookie"| BFF["BFF (Spring Cloud Gateway + oauth2Login, TokenRelay)"]
  BFF -->|"Auth Code + PKCE, holds tokens"| IdP["Keycloak"]
  BFF -->|"Bearer access token"| API["APIs"]
~~~

?? Why can a user still call APIs for a few minutes after logging out?
Their access token remains valid until expiry (stateless JWT). Mitigate with short lifetimes, revoking refresh tokens, back-channel logout to BFFs, and deny lists for high-risk APIs.
` },

{ id: 'token-revocation', title: 'Token Revocation', level: 'advanced', tags: ['revocation', 'introspection', 'logout'],
  summary: 'Revoking refresh vs access tokens, introspection, deny lists, not-before policies, back-channel logout and trade-offs.',
  body: md`
## Options
| Technique | Effect | Cost |
|---|---|---|
| Short access token TTL | bounds exposure window | more refreshes |
| Revoke refresh token (RFC 7009) | stops new access tokens | none per API call |
| Token introspection (RFC 7662) | APIs ask AS if token is active | network call per request (cache briefly) |
| Deny list of jti/sid at gateway | near-immediate cut-off | shared fast store (Redis), TTL = token remaining life |
| Not-before / session revocation | invalidates tokens issued before a timestamp | IdP-side; APIs need a check |
| Back-channel logout | IdP notifies clients/BFFs to end sessions | client endpoints |
| Key rotation (emergency) | invalidates all tokens signed by a key | everyone re-authenticates |

## Recommended hybrid
JWT access tokens (5 min) validated locally, refresh token rotation, IdP session revocation on password change/compromise, and a gateway deny list keyed by session id ({{sid}}) for urgent cut-off of high-risk accounts.

~~~java
@Component class DenyListFilter extends OncePerRequestFilter {
  private final StringRedisTemplate redis;
  protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws IOException, ServletException {
    Authentication a = SecurityContextHolder.getContext().getAuthentication();
    if (a instanceof JwtAuthenticationToken jwt) {
      String sid = jwt.getToken().getClaimAsString("sid");
      if (sid != null && Boolean.TRUE.equals(redis.hasKey("revoked:sid:" + sid))) { res.sendError(401, "session revoked"); return; }
    }
    chain.doFilter(req, res);
  }
}
~~~

?? Introspection everywhere vs JWT validation: when do you choose introspection?
High-value APIs needing immediate revocation and the latest token state (payments, admin), opaque tokens for third parties, or when token contents must not be visible to clients. Cache results for seconds to control load.
` },

{ id: 'rbac-abac', title: 'RBAC vs ABAC (and ReBAC)', level: 'advanced', tags: ['authorization', 'rbac', 'abac', 'opa'],
  summary: 'Role-based, attribute-based and relationship-based authorization; role explosion; policy engines; where to enforce.',
  body: md`
## Models
- **RBAC**: permissions assigned to roles, roles to users. Simple to audit. Problem: **role explosion** when access depends on context (region, amount, department, ownership).
- **ABAC**: decisions from attributes of subject (department, clearance), resource (owner, classification, tenant), action, and environment (time, IP, device risk). Expressive; harder to audit.
- **ReBAC**: decisions from relationships (user is editor of folder that contains doc) as in Google Zanzibar (OpenFGA, SpiceDB). Great for sharing models.

## Practical hybrid
Coarse RBAC in tokens (role: loan_officer) + ABAC rules in the service/policy engine (can approve if amount ≤ officer.limit and loan.branch == officer.branch and not self-owned).

~~~java
@PreAuthorize("hasRole('LOAN_OFFICER') and @loanPolicy.canApprove(authentication, #loanId)")
public void approve(UUID loanId) { ... }

@Component("loanPolicy")
class LoanPolicy {
  boolean canApprove(Authentication auth, UUID loanId) {
    Jwt jwt = (Jwt) auth.getPrincipal();
    Loan loan = loans.get(loanId);
    long limit = Long.parseLong(jwt.getClaimAsString("approval_limit"));
    return loan.amount() <= limit && loan.branch().equals(jwt.getClaimAsString("branch"))
        && !loan.createdBy().equals(jwt.getSubject());                 // segregation of duties
  }
}
~~~
~~~text
# OPA / Rego equivalent (central policy, decision via sidecar)
allow { input.user.roles[_] == "loan_officer"; input.loan.amount <= input.user.approval_limit; input.loan.branch == input.user.branch; input.loan.created_by != input.user.id }
~~~

## Where to enforce
Gateway: authentication + coarse scopes. Service: object-level and attribute checks (it has the data). Database: row-level security as defence in depth for multi-tenancy.

?? When do you move from RBAC to a policy engine?
When rules depend on resource attributes or relationships, multiply roles, need consistency across many services, or require auditable policy changes without redeploying services.
` },

{ id: 'sso', title: 'Single Sign-On (SSO)', level: 'beginner', tags: ['sso', 'oidc', 'saml'],
  summary: 'How SSO works with an IdP session, SSO across domains, single logout, and enterprise SSO for B2B SaaS.',
  body: md`
## How it works
The user authenticates once at the IdP, which sets an IdP session cookie. When another application redirects to the IdP, the cookie is presented and the IdP issues an authorization code without prompting again.

~~~mermaid
sequenceDiagram
  participant B as Browser
  participant A as App A
  participant C as App B
  participant I as IdP
  B->>A: visit
  A-->>B: redirect to IdP
  B->>I: authorize (no session) -> login
  I-->>B: set IdP session cookie, code for A
  B->>C: visit App B later
  C-->>B: redirect to IdP
  B->>I: authorize (cookie present)
  I-->>B: code for B (no login prompt)
~~~

## Single logout
Hard in practice: RP-initiated logout ends the IdP session; front-channel logout uses browser iframes (blocked by third-party cookie restrictions); **back-channel logout** (server-to-server logout tokens) is more reliable.

## Browser privacy changes
Third-party cookie blocking breaks silent token renewal via hidden iframes ({{prompt=none}} in iframe) in SPAs; use refresh tokens with rotation or a BFF.

## B2B SaaS enterprise SSO
Each customer connects their IdP (Entra ID, Okta) via SAML/OIDC; home realm discovery by email domain routes users to the right IdP; SCIM for provisioning/deprovisioning.

?? A customer wants employees removed from your SaaS immediately when they leave. How?
SCIM deprovisioning from their IdP to deactivate users, short sessions/tokens, and back-channel logout/revocation on deactivation.
` },

{ id: 'multi-tenant-iam', title: 'Multi-tenant IAM', level: 'advanced', tags: ['multi-tenancy', 'keycloak', 'cognito', 'saas'],
  summary: 'Realm-per-tenant vs shared realm with organizations, tenant claims, per-tenant IdPs and branding, and isolation risks.',
  body: md`
## Options in Keycloak
| Model | Pros | Cons |
|---|---|---|
| Realm per tenant | strong isolation (keys, users, policies, IdPs, themes) | hundreds/thousands of realms strain admin UX, startup, caches; cross-tenant users need multiple accounts |
| Shared realm + Organizations (Keycloak 25+) | scalable for many tenants; users can belong to orgs; org-specific IdPs and domains | weaker isolation; tenant authorization must be enforced in apps |
| Shared realm + groups/attributes | simple | tenant isolation entirely in claims and app logic |

## Options in Cognito
User pool per tenant (isolation, per-tenant settings; quotas on number of pools) vs shared pool with a {{custom:tenant_id}} attribute and groups (simple, scalable; isolation in app logic), or a hybrid for premium tenants.

## Tenant context in tokens
~~~json
{ "sub": "f3c1...", "tenant_id": "acme", "organization": { "acme": { "roles": ["admin"] } }, "aud": ["billing-api"] }
~~~
Services must **derive tenant from the verified token**, never from a request parameter alone, and check that the resource's tenant matches.

## Architecture
~~~mermaid
flowchart LR
  U1["acme.app.com"] & U2["globex.app.com"] --> GW["Gateway: resolve tenant from host, validate token tenant matches"]
  GW --> KC["Keycloak: shared realm with Organizations"]
  KC -->|"acme uses Entra ID"| AZ["Acme Entra ID (SAML/OIDC)"]
  KC -->|"globex uses local accounts + OTP"| LOC["Local users"]
  GW --> SVC["Services: tenant filter + RLS"]
~~~

## Per-tenant requirements to plan for
Custom domains and branding (themes), tenant-specific MFA policies, data residency (UAE/India tenants in-region), tenant admins with delegated user management (fine-grained admin permissions), audit separation, and offboarding (delete all tenant identities).

?? A user belongs to two tenants. How do tokens represent that?
Either one token per selected tenant (user chooses org at login; token has single tenant_id) or a token listing memberships with the active tenant passed and validated per request. Single active tenant per token is simpler and safer.
?? How do you prevent a tenant admin from escalating to another tenant?
Scope admin permissions to their organization/realm, validate tenant on every admin API, never accept tenant ids from the client without checking token membership, and test cross-tenant access explicitly.
` }
]);
})();
