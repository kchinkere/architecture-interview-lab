(function () {
const md = LAB.md;
const S = 'Core Problems';

LAB.add('sd', S, [
{ id: 'url-shortener', title: 'URL Shortener (Bitly)', level: 'intermediate', tags: ['read-heavy', 'cache', 'id-generation'],
  summary: 'Short code generation, 100:1 read-heavy redirects, caching, analytics pipeline and abuse protection.',
  mock: { deep: 'How exactly do you generate short codes so they are unique, short, and not guessable? Compare at least two approaches.',
          keys: [['Base62 encoding of an ID', 'base.?62'], ['Unique ID source (counter ranges / Snowflake / KGS)', 'counter|range|snowflake|kgs|key generation|sequence'], ['Collision handling for hash-based codes', 'collision|retry|unique constraint'], ['Code length vs keyspace maths', '62\\^|\\d+\\s*(chars|characters)|trillion|billion'], ['Non-guessability / enumeration concern', 'guess|enumerat|sequential|random|predict']] },
  body: md`
## Step 1: Requirements gathering
### Functional
- Create a short URL for a long URL (optional custom alias, optional expiry).
- Redirect {{GET /{code}}} to the long URL.
- Basic analytics: click counts by day, referrer, country.
- Users can list and delete their links.

### Non-functional
- Redirect latency low (p99 tens of milliseconds at the server, excluding client network).
- High availability for redirects (a broken short link in an SMS campaign is very visible); creation can tolerate brief degradation.
- Codes must be unique and should not be trivially enumerable.
- Durable: links live for years.

### Scope
In scope: creation, redirect, analytics aggregation. Out of scope: link-in-bio pages, QR rendering, billing.

### Assumptions (state them)
- 100M new links/month, read:write about 100:1.
- Average long URL ~ 200 bytes; record with metadata ~ 500 bytes.
- Retention 5 years.

## Step 2: Capacity estimation
- Writes: 100M / month ÷ (30 × 86,400 s) ≈ 100M / 2.6M s ≈ **~40 writes/s** average; assume peak ×5 ≈ 200/s.
- Reads: 100 × 40 ≈ **~4,000 redirects/s** average; peak ×5 ≈ 20,000/s.
- Storage: 100M × 12 months × 5 years = 6B links × 500 B ≈ **3 TB** (plus indexes and replicas, plan ~10 TB raw).
- Keyspace: base62 with 7 chars = 62^7 ≈ 3.5 × 10^12 codes, ample for 6B.
- Bandwidth: redirect response ~ 500 B × 20k/s ≈ 10 MB/s at peak; trivial.
- Cache: 20% of links get 80% of traffic. Caching the hottest ~ 100M records × 500 B ≈ 50 GB, fits a small Redis cluster.
- Analytics events: 4k/s average click events × ~200 B ≈ 0.8 MB/s ≈ 70 GB/day raw before aggregation.

## Step 3: API design
~~~http
POST /api/v1/links                     Authorization: Bearer <token>   Idempotency-Key: <uuid>
{ "longUrl": "https://example.com/very/long?utm=x", "customAlias": "summer-sale", "expiresAt": "2027-01-01T00:00:00Z" }
201 { "code": "aZ3k9Qx", "shortUrl": "https://sho.rt/aZ3k9Qx", "expiresAt": "..." }
409 alias taken · 422 invalid / blocked URL · 429 rate limited

GET /{code}                            -> 301/302 Location: <longUrl>   (404 unknown, 410 expired)
GET /api/v1/links?cursor=...&limit=50  -> { "items": [...], "nextCursor": "..." }
GET /api/v1/links/{code}/stats?from=2026-11-01&to=2026-11-24&granularity=day
DELETE /api/v1/links/{code}
~~~
- **301 vs 302**: 301 is cached by browsers (fewer hits, lost analytics); 302 keeps every click visible. Most shorteners use 302 (or 301 with short cache headers) when analytics matter.
- Auth: OAuth2 bearer tokens for API users; anonymous creation heavily rate limited.

## Step 4: Database design
- Access pattern is a **key-value lookup by code**; no joins on the hot path. A key-value / wide-column store (DynamoDB, Cassandra) fits well; PostgreSQL also works at this scale with the code as primary key and partitioning.
~~~sql
CREATE TABLE link (
  code        VARCHAR(16) PRIMARY KEY,
  long_url    TEXT NOT NULL,
  owner_id    UUID,
  created_at  TIMESTAMPTZ NOT NULL,
  expires_at  TIMESTAMPTZ,
  is_deleted  BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX idx_link_owner ON link(owner_id, created_at DESC);   -- "my links" page
-- Analytics: aggregated table in a columnar store (ClickHouse / BigQuery)
-- click_agg(code, day, country, referrer_domain, clicks)
~~~
- Sharding: hash of {{code}} spreads evenly; owner listing uses a secondary index (or a separate owner->codes table).

## Step 5: High-level architecture
~~~mermaid
flowchart LR
  U["Browser / SMS recipient"] --> CDN["CDN / edge"] --> LB["Load balancer"]
  LB --> RS["Redirect service (stateless)"]
  LB --> API["Link API service"]
  RS --> C[("Redis cache")]
  RS --> DB[("Links DB: DynamoDB / Postgres")]
  API --> IDG["ID allocator (range leases)"]
  API --> DB
  API --> SB["Safe-browsing check"]
  RS -- "click event (async)" --> K{{"Kafka: clicks"}}
  K --> AGG["Stream aggregator (Flink / Kafka Streams)"] --> OLAP[("ClickHouse: click_agg")]
~~~

## Step 6: Detailed component design
### Short code generation
1. **Counter + base62** (preferred): each API instance leases a range of IDs (e.g. 1,000,000 at a time) from a coordinator (a DB sequence row with {{UPDATE ... RETURNING}}, or ZooKeeper/etcd). IDs are converted to base62. No collisions, no coordination per request. To avoid enumerable sequential codes, apply a reversible permutation (e.g. multiply by a large odd number modulo 62^7, or a Feistel cipher) before encoding.
2. **Hash (MD5/SHA-256 of URL) truncated to 7 chars**: same URL maps to the same code (natural dedup), but truncation collides; on unique-constraint violation append a salt and retry.
3. **Pre-generated key service (KGS)**: generate random unique codes offline into a pool; servers take batches. Adds a component to operate.
~~~java
public final class Base62 {
  private static final char[] A = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".toCharArray();
  public static String encode(long n) { StringBuilder sb = new StringBuilder(); do { sb.append(A[(int) (n % 62)]); n /= 62; } while (n > 0); return sb.reverse().toString(); }
}
@Component class IdAllocator {
  private final AtomicLong next = new AtomicLong(), end = new AtomicLong();
  synchronized long nextId() {
    if (next.get() >= end.get()) { long start = rangeRepo.lease(1_000_000); next.set(start); end.set(start + 1_000_000); } // UPDATE counter SET v=v+1e6 RETURNING v-1e6
    return next.getAndIncrement();
  }
}
~~~
### Redirect path
Cache-aside lookup in Redis by code -> on miss read DB -> populate with TTL (honour expiry) -> respond 302. Negative caching for unknown codes (short TTL) prevents DB hammering by scanners. Click event is published asynchronously (fire-and-forget into a local buffer, then Kafka) so analytics never slow the redirect.
### Analytics
Stream processor aggregates per (code, minute/day, country, referrer) and writes to a columnar store; raw events kept in S3 for reprocessing.

## Step 7: Scalability
- Redirect service is stateless: scale horizontally behind the LB; cache hit rate is the main lever.
- Hot links (a viral campaign): in-process Caffeine cache in front of Redis; CDN caching of redirects for popular codes if 301/short {{Cache-Control}} is acceptable.
- DB: partition by code; read replicas for owner listings; DynamoDB scales partitions automatically.
- Analytics decoupled via Kafka; scale consumers with partitions.

## Step 8: Reliability
- Redis down: fall back to DB (with a circuit breaker and limited concurrency to protect the DB).
- DB replicated across AZs; backups with PITR.
- ID allocator unavailable: instances still have leased ranges; lease size gives a buffer of minutes to hours.
- Kafka unavailable: buffer click events locally with bounded memory, drop if needed (analytics is lossy-tolerant; say so).
- Multi-region read replicas for redirects (codes are immutable after creation, which makes replication easy).

## Step 9: Security
- Malicious URL detection (Google Safe Browsing / internal blocklists) at creation and periodically after.
- Rate limiting creation per user/IP; CAPTCHA for anonymous use.
- Non-enumerable codes for private links; optional password-protected links.
- Open redirect abuse: phishing via your domain hurts deliverability; maintain takedown tooling.
- TLS everywhere; HSTS on the short domain.

## Step 10: Trade-offs
| Decision | Chosen | Alternative | Why |
|---|---|---|---|
| Code generation | Range-leased counter + permutation | Hash + collision retry | No collisions, O(1), no DB round-trip per create |
| Redirect status | 302 | 301 | Keeps analytics accurate; costs more traffic |
| Store | Key-value (DynamoDB) | Postgres | Pure key access at large scale; Postgres fine at lower scale and simpler for listings |
| Analytics | Async stream aggregation | Synchronous counter increment | Keeps redirect latency independent of analytics |

## Step 11: Interview follow-ups
?? How do you support custom aliases without conflicts?
Insert with a unique constraint on code; if it exists return 409. Reserve a namespace (e.g. custom aliases must contain a dash, or check against generated code alphabet patterns) so generated codes never collide with future custom ones.
?? The same long URL is shortened twice. Same code or different?
Product decision. Per-user dedup via a unique index on (owner_id, hash(long_url)) is common; global dedup leaks that someone else shortened the URL and breaks per-user analytics.
?? How do you expire links?
Store expires_at; the redirect path checks it (410 Gone). Cache TTL = min(default TTL, time to expiry). A background job or DynamoDB TTL physically deletes later.
?? A link goes viral with 200k clicks/second. What breaks?
The single Redis key's shard and the analytics partition for that code. Mitigate with in-process caching (Caffeine, few seconds TTL) in every redirect instance, CDN caching, and pre-aggregation of clicks in memory before publishing (per instance per second).
?? How would you guarantee analytics counts are exactly right?
Usually you do not need exact; if billing depends on it, use idempotent event ids, exactly-once stream processing (Kafka transactions / Flink checkpoints) and reconcile against raw logs.
?? Why not use UUIDs as codes?
Too long (22+ chars base64) for SMS and print. The whole point is a short, typeable code.
?? How do you handle deletes with caching and CDN?
Soft delete in DB, explicit cache delete, CDN purge API for that path; short CDN TTL limits the window.
?? Could you make redirects work during a full database outage?
Yes for cached codes. Additionally replicate the code->url mapping into a second store (e.g. a read-only replica in another region or an S3-backed snapshot), since data is immutable and append-only.
?? How do you prevent counter-based codes from leaking business volume?
Apply a keyed bijective permutation to the ID before base62 encoding so consecutive IDs look random but remain collision-free.
?? What would change for a 10× larger scale?
More cache, more redirect instances, partitioning by code is already linear; the ID allocator lease size grows; analytics moves to pre-aggregation at the edge. The architecture does not change fundamentally, which is a good sign.
` },

{ id: 'whatsapp', title: 'WhatsApp / Messaging System', level: 'advanced', tags: ['websocket', 'fan-out', 'delivery-guarantees'], viz: 'kafka',
  summary: '1:1 and group messaging with persistent connections, delivery/read receipts, offline delivery and ordering.',
  mock: { deep: 'Walk me through what happens from the moment user A presses send until user B (currently offline) sees the message and A sees two ticks.',
          keys: [['Persistent connection (WebSocket/MQTT) to a gateway', 'websocket|mqtt|persistent connection|long.?lived'], ['Session registry: which gateway holds user B', 'session|registry|presence|which (server|gateway)'], ['Message persisted before ACK to sender', 'persist|store|write.{0,30}(before|then)'], ['Offline queue / push notification', 'offline|push|apns|fcm|inbox'], ['Client message id for dedup + server sequence per conversation', 'client.?(message)?.?id|dedup|sequence|ordering'], ['Delivered/read receipts as separate messages', 'receipt|delivered|read|tick']] },
  body: md`
## Step 1: Requirements gathering
### Functional
- 1:1 messaging, group messaging (up to e.g. 1,024 members).
- Delivery states: sent (server received), delivered (recipient device received), read.
- Offline users receive messages when they reconnect; push notification while offline.
- Online/last-seen presence; media (images/video) via separate upload.
- Multi-device (phone + web) for the same account.

### Non-functional
- Low end-to-end latency for online recipients (sub-second typical).
- No message loss once the sender sees "sent"; no duplicates shown to users.
- Per-conversation ordering.
- Highly available; tolerate mobile networks with frequent disconnects.
- End-to-end encryption (server cannot read content).

### Scope
Out of scope: voice/video calling, payments, stories.

### Assumptions
- 500M DAU, each sends 40 messages/day; average message 100 bytes text (+ metadata ~ 300 B stored).
- Peak concurrent connections ~ 30% of DAU.

## Step 2: Capacity estimation
- Messages/day: 500M × 40 = **20B/day** ≈ 20B / 86,400 ≈ **~230k msgs/s** average; peak ×3 ≈ 700k/s.
- Each message produces at least one delivery and one read receipt: total events ≈ 3× messages.
- Concurrent connections: 150M. If one gateway server holds ~ 100k-500k connections (depends on tuning, memory per connection), that is on the order of hundreds to ~1,500 gateway servers. State this as an estimate to validate with load tests.
- Storage: if the server keeps messages until delivered plus a retention window (WhatsApp historically deletes after delivery), 20B × 300 B ≈ **6 TB/day**; with 30-day retention ≈ 180 TB (before replication). Media is separate (object storage), far larger.
- Bandwidth: 700k/s × ~1 KB on the wire ≈ 0.7 GB/s at peak for text.

## Step 3: API design
- Real-time over a persistent **WebSocket** (or MQTT) connection; REST for history, media, groups.
~~~json
// client -> server (frame)
{ "type": "send", "clientMsgId": "c-7f3a", "conversationId": "conv-123", "ciphertext": "...", "sentAt": 1764000000000 }
// server -> sender
{ "type": "ack", "clientMsgId": "c-7f3a", "messageId": "m-9b1", "seq": 4812, "status": "SENT" }
// server -> recipient
{ "type": "message", "messageId": "m-9b1", "conversationId": "conv-123", "seq": 4812, "from": "u1", "ciphertext": "..." }
// recipient -> server
{ "type": "receipt", "messageIds": ["m-9b1"], "status": "DELIVERED" }
~~~
~~~http
GET  /v1/conversations/{id}/messages?afterSeq=4700&limit=100     (sync after reconnect)
POST /v1/media/uploads -> { uploadUrl (pre-signed S3), mediaId }
POST /v1/groups  · POST /v1/groups/{id}/members
~~~
- Auth: device-bound long-lived credentials + short-lived session tokens on connect.

## Step 4: Database design
- Messages: write-heavy, accessed by conversation and sequence. **Wide-column store** (Cassandra/ScyllaDB/HBase): partition key {{conversation_id}} (bucketed by time to avoid huge partitions), clustering key {{seq}}.
~~~sql
-- CQL
CREATE TABLE messages (
  conversation_id text, bucket int, seq bigint, message_id text, sender_id text,
  ciphertext blob, created_at timestamp,
  PRIMARY KEY ((conversation_id, bucket), seq)
) WITH CLUSTERING ORDER BY (seq ASC);

CREATE TABLE inbox (                      -- pending deliveries per device
  device_id text, message_id text, conversation_id text, seq bigint, PRIMARY KEY (device_id, message_id));
~~~
- Users, groups and membership: relational (Postgres/MySQL), cached.
- Session registry (user/device -> gateway node): Redis with TTL heartbeats.
- Per-conversation sequence: allocated by the conversation's owner shard (single writer) or by Redis {{INCR}} per conversation.

## Step 5: High-level architecture
~~~mermaid
flowchart LR
  A["Sender app"] <-->|WebSocket| GW1["Gateway node 1"]
  B["Recipient app"] <-->|WebSocket| GW2["Gateway node 2"]
  GW1 --> MS["Message service"]
  MS --> SEQ["Sequencer (per conversation)"]
  MS --> MDB[("Cassandra: messages")]
  MS --> SR[("Redis: session registry")]
  MS -->|"route to node 2"| GW2
  MS --> IB[("Inbox / pending")]
  MS --> PN["Push service: APNs / FCM"]
  MS --> GS["Group service (members)"]
  A --> MED["Media service"] --> S3[("S3 + CDN")]
~~~

## Step 6: Detailed component design
### Send path (1:1)
1. Client sends frame with {{clientMsgId}} over WebSocket to its gateway.
2. Message service dedupes on (sender, clientMsgId), assigns {{seq}} for the conversation, **persists** the message, then ACKs the sender (single tick). Persist-before-ack is what makes "sent" mean durable.
3. Looks up recipient devices in the session registry. If online, forwards to their gateway node (internal RPC or per-node queue); else writes an inbox entry and triggers a push notification.
4. Recipient device receives, stores locally, sends DELIVERED receipt; server forwards receipt to sender (double tick) and deletes the inbox entry.
5. READ receipts are just another message type.

### Reconnect and sync
Client tracks last seen {{seq}} per conversation; on reconnect it calls sync for gaps. Dedup by messageId on the client handles redelivery.

### Groups
Small groups: fan-out on write (one inbox entry per member device). Group membership cached. Very large groups/channels switch to fan-out on read.

### Gateway design
Event-loop servers (Netty / Spring WebFlux / Erlang historically) holding connections with heartbeats; connection-to-node mapping in Redis with TTL refreshed by heartbeats.

### E2E encryption
Signal protocol: clients exchange keys via a key directory; server stores ciphertext only; group messages use sender keys. Server-side features (search, spam scanning) are therefore limited.

## Step 7: Scalability
- Gateways scale horizontally; connection count per node is the key metric (memory per connection, file descriptors, kernel tuning).
- Message service is stateless; Cassandra scales linearly by partitions.
- Partition Kafka/internal queues by conversation id to keep ordering.
- Hot groups: rate limit sends; large group fan-out handled asynchronously by workers.
- Regional deployments; users connect to nearest region; cross-region routing for conversations spanning regions.

## Step 8: Reliability
- Gateway crash: clients reconnect (with jittered backoff) to another node; unacked messages are resent by the client with the same clientMsgId (dedup makes it safe).
- Message service crash after persist but before ack: client retries; dedup returns the existing messageId.
- Recipient gateway lost: inbox entry still exists until DELIVERED receipt, so the message is redelivered on reconnect.
- Cassandra RF=3 with LOCAL_QUORUM writes; multi-DC replication.
- Push provider outages: retry with backoff; messages are still in inbox.

## Step 9: Security
- E2E encryption, server stores only ciphertext.
- Device registration with phone OTP and optional PIN (two-step verification).
- TLS for transport (in addition to E2E), certificate pinning in apps.
- Rate limits on sends and new-contact messaging (spam); abuse reporting sends the reported messages from the reporter's device.
- Metadata minimisation and retention limits.

## Step 10: Trade-offs
| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| Transport | WebSocket/MQTT persistent | Long polling | Lower latency and overhead per message |
| Storage | Cassandra by conversation | Relational | Write volume and partitioned access pattern |
| Group fan-out | Write (small groups) | Read | Fast reads, simple delivery tracking; switch for huge groups |
| Ordering | Per-conversation sequence | Global ordering | Global ordering does not scale and is not needed |
| Delivery | At-least-once + client dedup | Exactly-once | Exactly-once delivery is impractical over unreliable networks |

## Step 11: Interview follow-ups
?? How do you guarantee ordering when two group members send at the same time?
The server assigns a monotonically increasing seq per conversation from a single sequencer for that conversation (owner shard or atomic INCR). All clients display by seq. Clients show their own pending messages optimistically and reorder when the ack with seq arrives.
?? How does multi-device work?
Each device is a separate recipient with its own inbox and keys; sender encrypts per device (or uses sender keys). The sender's other devices also receive a copy so history stays in sync.
?? How do you implement "last seen" and online presence at scale?
Gateways publish connect/disconnect and heartbeats to a presence service that stores last-seen in Redis; subscribers get presence only for contacts with open chats, and updates are throttled/coalesced to avoid a storm.
?? A gateway node with 300k connections is being deployed. How do you avoid a reconnect storm?
Drain gradually: stop accepting new connections, ask clients to reconnect in batches with randomised delay, and keep capacity headroom on other nodes.
?? How do you know which gateway to forward a message to?
Session registry (user/device -> node id) in Redis, updated on connect and expired by heartbeat TTL. Forward via node-specific queue or RPC. If the entry is stale, delivery fails and the message stays in the inbox for the reconnect.
?? How would you support message search with E2E encryption?
Server-side search is not possible on ciphertext; search is done on the device's local database. Server only searches metadata, which you would minimise.
?? How do you handle a 1M-member broadcast channel?
Fan-out on read: store the message once per channel, clients pull/stream from the channel's log; push notifications batched and throttled.
?? What happens when a user is offline for 30 days?
Messages remain in inbox up to a retention limit; after that they are dropped, and the sender's message stays at single tick. Product decision, stated clearly.
?? How do you prevent duplicate messages on flaky networks?
Client-generated clientMsgId per message, server dedup window keyed by (sender device, clientMsgId), and receivers dedupe by messageId.
?? Why not use Kafka directly as the user inbox?
Kafka partitions are not designed for hundreds of millions of tiny per-user queues; you would multiplex users onto partitions and still need per-user offsets. A wide-column store keyed by device is a better inbox; Kafka can still carry internal events.
` },

{ id: 'youtube', title: 'YouTube / Video Streaming Platform', level: 'advanced', tags: ['video', 'cdn', 'transcoding', 'object-storage'],
  summary: 'Resumable uploads, transcoding pipeline into adaptive bitrate renditions, CDN delivery, metadata, views and recommendations.',
  mock: { deep: 'Explain the video processing pipeline from upload complete to a video playable at multiple resolutions worldwide.',
          keys: [['Resumable / chunked upload to object storage', 'chunk|resumable|multipart|pre.?signed'], ['Event triggers async transcoding jobs', 'queue|event|async|job'], ['Split into segments, transcode in parallel to renditions', 'segment|parallel|rendition|resolution|bitrate|1080|720'], ['Adaptive bitrate streaming (HLS/DASH manifests)', 'hls|dash|manifest|adaptive|abr'], ['CDN distribution and caching', 'cdn|edge'], ['Status tracking and retries for failed tasks', 'status|retry|dag|workflow']] },
  body: md`
## Step 1: Requirements gathering
### Functional
- Upload videos (up to e.g. several GB), with title/description/thumbnail.
- Process into multiple resolutions and formats; play with adaptive bitrate on any device.
- Search, view counts, likes, comments, subscriptions, home feed recommendations.

### Non-functional
- Playback start quickly with minimal rebuffering worldwide.
- Uploads resumable over unreliable networks.
- Extremely read-heavy for popular content; very long tail of rarely watched videos.
- Durable storage of originals.

### Scope
Focus on upload, processing, playback, metadata, views. Live streaming, monetisation and recommendation ML internals out of scope (mention interfaces).

### Assumptions
- 500k videos uploaded/day, average original 500 MB (5-10 min).
- 1B video views/day, average watched ~ 5 min at ~ 3 Mbps.

## Step 2: Capacity estimation
- Upload ingest: 500k × 500 MB = **250 TB/day** of originals ≈ 250 TB / 86,400 s ≈ **~3 GB/s** ingest.
- Processed renditions: roughly 1-2× original size across ladders (say 1.5×) ≈ 375 TB/day; total new storage ≈ 625 TB/day ≈ **~230 PB/year** before replication; this is why cold storage tiers and deleting unwatched renditions matter.
- Egress: 1B views × 5 min × 60 s × 3 Mbps ≈ 1B × 112 MB ≈ **112 PB/day** ≈ 112 PB / 86,400 ≈ **~10 Tbps** average. Only a CDN with edge caching can serve this.
- Metadata reads: 1B views/day ≈ 12k/s average, plus browsing/search several × that.
- Transcoding compute: each minute of video at several renditions costs minutes of CPU; parallelising per segment is required to keep processing time near real time.

## Step 3: API design
~~~http
POST /v1/uploads                           -> { uploadId, parts:[{partNumber, presignedUrl}] }   (S3 multipart)
PUT  <presignedUrl>                        (client uploads chunks directly to object storage)
POST /v1/uploads/{uploadId}/complete       { title, description, visibility } -> { videoId, status: "PROCESSING" }
GET  /v1/videos/{videoId}                  -> { title, channel, durations, status, manifestUrl, thumbnails }
GET  /v1/videos/{videoId}/manifest.m3u8    (served via CDN, signed URL / token)
POST /v1/videos/{videoId}/views            { sessionId, watchedSeconds }    (batched, async)
GET  /v1/feed?cursor=...                   -> recommendations page
~~~

## Step 4: Database design
- **Object storage (S3/GCS)**: originals (infrequent access / archive tier after processing) and renditions/segments.
- **Video metadata**: relational or wide-column, keyed by video_id; sharded by video_id. Fields: owner, title, status, durations, rendition list, created_at.
- **Channel/subscriptions**: relational, sharded by user.
- **View counts**: not updated per view in the metadata DB. Stream into Kafka, aggregate, and write periodic counters (Redis + batch flush).
- **Search**: Elasticsearch/OpenSearch indexes title, description, tags, captions.
- **Comments**: wide-column partitioned by video_id, clustered by time.

## Step 5: High-level architecture
~~~mermaid
flowchart LR
  Up["Uploader app"] -->|"multipart presigned PUT"| RAW[("S3: originals")]
  Up --> API["Upload API"] --> META[("Video metadata DB")]
  RAW -->|"object created event"| Q{{"Queue / Kafka"}} --> ORCH["Transcode orchestrator (DAG)"]
  ORCH --> W["Transcode workers (autoscaled, spot)"] --> OUT[("S3: segments + HLS/DASH manifests")]
  ORCH --> META
  OUT --> CDN["CDN edge caches"]
  V["Viewer"] --> CDN
  V --> PAPI["Playback / metadata API"] --> CACHE[("Redis")]
  V -->|"view events"| K{{"Kafka"}} --> AGG["Aggregators"] --> CNT[("View counters")]
  META -->|CDC| SEARCH["Search index"]
~~~

## Step 6: Detailed component design
### Upload
Client requests an upload session; uploads parts directly to object storage using pre-signed URLs (no app-server bandwidth), resumes failed parts. Completion verifies checksums.
### Processing pipeline (a DAG)
1. Validate and probe (codec, duration, malware/content checks).
2. Split into segments (e.g. a few seconds each, at keyframes).
3. Transcode segments **in parallel** into a bitrate ladder (e.g. 240p to 1080p/4K, H.264 and VP9/AV1 for supported clients).
4. Package into HLS/DASH: segment files + manifests per rendition + master manifest.
5. Generate thumbnails, extract captions (speech-to-text), content moderation.
6. Update status to READY; publish {{VideoReady}} event (notify subscribers, index search).
Each task is idempotent and retried; the orchestrator tracks task state (Step Functions / Temporal / custom with a DB).
### Playback
The player downloads the master manifest, picks a rendition based on bandwidth, and switches renditions per segment (adaptive bitrate). Segments are static files: perfect for CDN caching. Popular videos are pre-warmed to edges; long-tail fetched from origin (origin shield reduces origin load).
### View counting
Client sends periodic heartbeats; server dedupes per session, aggregates in streaming jobs, updates counters periodically. Exact real-time counts are unnecessary; anti-fraud filters invalid views before monetisation.

## Step 7: Scalability
- CDN handles egress; multiple CDN providers for capacity and resilience.
- Transcoding workers autoscale on queue depth; use spot/preemptible instances (tasks are retryable).
- Metadata DB sharded by video_id; cached heavily (hot videos).
- Search and recommendations are separate scalable services fed by events.
- Storage tiers: move rarely watched renditions to colder storage; regenerate on demand for extreme long tail.

## Step 8: Reliability
- Originals stored durably (object storage provides very high durability via replication/erasure coding); processing can always be re-run.
- Worker failure: task times out, orchestrator retries elsewhere.
- CDN or edge failures: multi-CDN with DNS/steering; player retries segments from alternate host.
- Metadata DB multi-AZ with replicas; graceful degradation (if recommendations fail, show trending).

## Step 9: Security
- Signed URLs / tokens for manifests and segments (time-limited) to prevent hotlinking of private videos; DRM (Widevine/FairPlay) for premium content.
- Malware and content moderation in the pipeline; copyright matching (fingerprints).
- AuthN via OAuth/OIDC; authorization on private/unlisted visibility.
- Rate limit uploads per account.

## Step 10: Trade-offs
| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| Upload path | Direct-to-S3 presigned | Through app servers | Avoids huge bandwidth through APIs |
| Delivery | HLS/DASH segments via CDN | Progressive MP4 | Adaptive quality, cacheable segments |
| Transcoding | Per-segment parallel | Whole file per worker | Faster processing; more orchestration |
| View counts | Async aggregated | Synchronous DB increment | Write amplification and hot rows |
| Codec ladder | Multiple codecs | Single H.264 | Better compression for modern clients vs more storage/compute |

## Step 11: Interview follow-ups
?? How do you decide which renditions to generate?
Based on source resolution (never upscale) and expected demand: generate a base ladder for all; generate expensive codecs (AV1) only for videos that become popular. This saves compute and storage on the long tail.
?? A creator with 50M subscribers uploads. What happens at publish time?
A burst of views for one video: pre-warm the CDN with the first segments, cache metadata aggressively, fan-out notifications asynchronously in batches, and protect the metadata DB with request coalescing.
?? How do you resume an upload after the network dropped at 80%?
Multipart upload: the client lists already uploaded parts and uploads only missing ones, then completes. The upload session expires after a period, with abandoned parts cleaned up by lifecycle rules.
?? How does adaptive bitrate decide quality?
The player measures throughput and buffer level, choosing the highest rendition that keeps the buffer healthy; switching happens at segment boundaries using the manifest.
?? How do you avoid processing the same upload twice when events are delivered twice?
The orchestrator keys jobs by videoId (idempotent create), and each task writes outputs to deterministic paths, so re-execution overwrites identical results.
?? How would you design view count to show "1.2M views" quickly but be roughly right?
Approximate real-time counters in Redis updated by aggregators every few seconds, with periodic reconciliation from the durable stream. Display rounded values.
?? How do you protect premium content?
DRM licence servers issuing keys per session, encrypted segments, short-lived signed URLs, concurrent stream limits per account.
?? Where would you store thumbnails and how do you serve them?
Object storage, served through an image CDN with resizing at the edge; several sizes pre-generated for common layouts.
?? How would you implement live streaming differently?
Ingest via RTMP/SRT to regional ingest servers, transcode in real time into short segments (low-latency HLS/CMAF), push to CDN continuously; latency budget measured in seconds; no full-file processing.
?? How do you reduce storage costs at this scale?
Lifecycle policies (originals to archive tier), delete or recompute rarely watched renditions, better codecs for popular content, deduplicate identical uploads by content hash.
` },

{ id: 'instagram', title: 'Instagram / Social Media Feed', level: 'advanced', tags: ['feed', 'fan-out', 'media'],
  summary: 'Photo posts, follow graph, home feed with hybrid fan-out, likes/comments counters and media delivery.',
  mock: { deep: 'How is the home feed generated? Handle both a normal user and a celebrity with 50M followers.',
          keys: [['Fan-out on write to followers\' feed caches', 'fan.?out on write|push model|precomput'], ['Fan-out on read for celebrities', 'fan.?out on read|pull model|celebrit'], ['Hybrid approach and threshold', 'hybrid|threshold'], ['Feed stored as list of post IDs in cache', 'post.?ids|redis|list|sorted set|timeline cache'], ['Ranking step', 'rank|score|relevance'], ['Pagination with cursor', 'cursor|pagina']] },
  body: md`
## Step 1: Requirements gathering
### Functional
- Post photos/videos with captions; follow/unfollow users.
- Home feed of posts from followed accounts, ranked; infinite scroll.
- Like, comment; counters shown on posts.
- User profile grid of their posts.

### Non-functional
- Feed load fast (p99 a few hundred ms server-side), highly available.
- Eventual consistency acceptable for feeds and counters (seconds).
- Read-heavy: feed reads >> posts.

### Scope
Stories, reels ranking ML, direct messages, ads out of scope.

### Assumptions
- 500M DAU; each opens feed ~10 times/day; 100M new posts/day; average 200 followers, but power-law with some accounts at tens of millions.

## Step 2: Capacity estimation
- Feed reads: 500M × 10 = 5B/day ≈ **~58k/s** average, peak ×3 ≈ 175k/s.
- Posts: 100M/day ≈ **~1,200/s**, peak ~4k/s.
- Fan-out on write cost: 1,200 posts/s × 200 followers ≈ **240k feed inserts/s** average (celebrities excluded via hybrid).
- Media storage: 100M × 2 MB (multiple sizes) ≈ **200 TB/day**.
- Feed cache: keep the latest 500 post IDs × 8 bytes for each active user: 500M × 4 KB ≈ **2 TB** in Redis (sharded); fine for a cluster, and you can store only for active users.

## Step 3: API design
~~~http
POST /v1/media/uploads -> { mediaId, uploadUrl }
POST /v1/posts { mediaIds: [...], caption } -> 201 { postId }
GET  /v1/feed?cursor=<opaque>&limit=20 -> { items: [ { postId, author, mediaUrls, caption, likeCount, commentCount, likedByMe } ], nextCursor }
POST /v1/posts/{id}/likes   (idempotent per user) · DELETE /v1/posts/{id}/likes
POST /v1/posts/{id}/comments { text } · GET /v1/posts/{id}/comments?cursor=
POST /v1/users/{id}/follow · DELETE /v1/users/{id}/follow
~~~

## Step 4: Database design
- **Posts**: sharded by post_id (Snowflake IDs embed time, sortable). Wide-column or sharded MySQL/Postgres.
- **Follow graph**: two tables for both directions: {{followers(user_id, follower_id)}} and {{following(user_id, followee_id)}}, partitioned by user_id.
- **Feed timeline cache**: Redis sorted set / list per user of post IDs (score = time or rank).
- **Likes**: {{post_likes(post_id, user_id)}} unique (idempotent likes); counters stored separately and updated asynchronously (sharded counters for hot posts).
- **Comments**: partitioned by post_id, clustered by time.
- Media in object storage + CDN.

## Step 5: High-level architecture
~~~mermaid
flowchart LR
  App --> GW["API gateway"]
  GW --> PS["Post service"] --> PDB[("Posts DB")]
  PS -->|PostCreated| K{{"Kafka"}}
  K --> FO["Fan-out workers"]
  FO --> GRAPH["Graph service"] --> GDB[("Follow graph")]
  FO --> TL[("Redis: timelines")]
  GW --> FS["Feed service"]
  FS --> TL
  FS --> CEL["Celebrity posts (pull)"] --> PDB
  FS --> RANK["Ranking service"]
  FS --> HYD["Hydration: posts, users, counters (cache)"]
  GW --> MS["Media service"] --> S3[("S3")] --> CDN["CDN"]
  GW --> LS["Like/comment service"] --> K
~~~

## Step 6: Detailed component design
### Hybrid fan-out
- **Normal authors**: on post, fan-out workers read follower list in pages and push post_id into each follower's timeline (only for followers active in the last N days, to save work).
- **Celebrities** (followers above a threshold, e.g. 100k+): no push. At read time, the feed service merges the user's cached timeline with recent posts from the celebrities they follow (small set, cached per celebrity).
### Feed read
1. Read top K post IDs from the timeline cache + celebrity candidates.
2. Rank (recency, affinity, engagement prediction). Ranking can be a separate service; fall back to chronological if it is slow.
3. Hydrate posts, authors, counters, likedByMe in batch from caches (multi-get).
4. Return a page with an opaque cursor encoding position/score.
### Counters
Likes write the like row (idempotent) and emit an event; counters aggregated and updated in Redis (sharded counter for hot posts) and persisted periodically.

## Step 7: Scalability
- Fan-out workers scale with Kafka partitions; skip inactive followers.
- Timeline cache sharded by user_id; only active users get materialised timelines; inactive users get feed built on demand (pull).
- Media via CDN with multiple sizes; images resized at upload.
- Hydration via batch multi-get and caches for hot posts/users.

## Step 8: Reliability
- Timeline cache loss: rebuild by pulling recent posts from followees (slower but correct) and repopulate.
- Fan-out backlog: feed still serves (stale by minutes); author's own posts shown immediately via read-your-writes merge.
- Kafka and DB replicated; idempotent fan-out (sorted set add is idempotent).
- Ranking service down: chronological fallback.

## Step 9: Security
- AuthZ for private accounts: feed and post reads check follow approval.
- Signed CDN URLs for private content; EXIF stripping (location privacy).
- Rate limit follows/likes/comments (bots); spam and abuse classifiers.
- Content moderation pipeline on upload.

## Step 10: Trade-offs
| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| Feed generation | Hybrid push/pull | Pure push or pure pull | Push is fast to read but explodes for celebrities; pull is cheap to write but slow to read |
| Timeline storage | Post IDs only | Full post objects | Small memory, one source of truth for post data |
| Counters | Async approximate | Synchronous exact | Avoid hot-row contention; small display lag acceptable |
| Ranking | Separate service with fallback | Inline | Independent iteration; feed survives ranking outages |

## Step 11: Interview follow-ups
?? A user unfollows someone. How do their posts disappear from the feed?
Filter at read time (check current following set during hydration) and lazily remove from the timeline; an async job can clean up. Pushing deletes to every timeline is expensive.
?? A post is deleted by its author. How do you handle it in millions of timelines?
Mark deleted in the posts store; hydration drops missing/deleted posts. Timelines self-heal as they are trimmed.
?? How do you paginate a ranked feed without duplicates?
Snapshot the candidate list for the session (feed session id + cursor index) or use stable score + id cursors. New posts appear via "new posts" pill rather than shifting pages.
?? How do you count likes on a post with millions of likes per hour?
Sharded counters (N sub-counters incremented randomly, summed on read), periodic aggregation from the like-events stream, displayed approximately.
?? How would you show "liked by me" efficiently?
Batch check of (user, postIds) against a per-user recent-likes cache or a bloom filter, falling back to the likes table for misses.
?? How do you choose the celebrity threshold?
Based on cost: when fan-out writes per post exceed what the system handles within the freshness target. It can be dynamic per account.
?? What is the cost of storing timelines for inactive users?
Wasted memory; store timelines only for users active within N days and rebuild on login for others.
?? How does the feed handle new users with no follows?
Cold-start: popular/trending and interest-based recommendations from onboarding choices.
?? How do you ensure a user sees their own new post immediately?
Merge the author's own recent posts at read time (read-your-writes), independent of fan-out progress.
?? Where does eventual consistency show up to the user, and is it acceptable?
Counters lag by seconds, followers' feeds update within seconds to minutes. Acceptable for social content; not for privacy changes, which are enforced at read time.
` },

{ id: 'uber', title: 'Uber / Ride Booking', level: 'advanced', tags: ['geo', 'matching', 'real-time'], viz: 'load-balancer',
  summary: 'Driver location ingestion, geo indexing, matching/dispatch, trip state machine, surge pricing and payments.',
  mock: { deep: 'How do you find and assign the best nearby driver for a ride request within a couple of seconds, without double-assigning drivers?',
          keys: [['Geospatial index (geohash / H3 / S2 / Redis GEO / quadtree)', 'geohash|h3|s2|quadtree|redis geo|geo.?index|grid'], ['Driver location updates every few seconds in memory store', 'location update|every \\d+|in.?memory|redis'], ['Candidate filtering by ETA, not straight distance', 'eta|road|route|travel time'], ['Atomic driver reservation / lock to avoid double assignment', 'lock|atomic|cas|reserve|conditional|double'], ['Offer timeout and fallback to next driver', 'timeout|next driver|declin|reject'], ['Partitioning by city / region', 'city|region|partition|shard']] },
  body: md`
## Step 1: Requirements gathering
### Functional
- Riders request rides (pickup, destination, vehicle type) and see price estimates.
- Drivers go online and share location continuously.
- Match a rider with a nearby driver; driver accepts/declines.
- Trip lifecycle: requested, matched, arriving, in progress, completed, cancelled; live location for rider.
- Fare calculation with surge; payment after trip.

### Non-functional
- Matching latency of a few seconds.
- High write rate of location updates.
- A driver must never be assigned two concurrent trips; payments must be exact.
- Available across city outages; data residency per country (UAE, India).

### Scope
Pooling, scheduled rides and driver onboarding out of scope.

### Assumptions
- 5M active drivers globally, 1M online at peak; location update every 4 s.
- 20M trips/day.

## Step 2: Capacity estimation
- Location updates: 1M online / 4 s = **250k updates/s** at peak, each ~100 bytes ≈ 25 MB/s ingest.
- Ride requests: 20M/day ≈ 230/s average; peak (rush hour, events) ×5 ≈ ~1,200/s; each triggers geo queries and ETA calls.
- Location history storage (for trips, disputes): if kept for trips only: 20M trips × 20 min × 15 updates/min × 100 B ≈ 600 GB/day.
- Live state memory: 1M drivers × ~200 B ≈ 200 MB per copy: fits in memory easily; partition by city for isolation.

## Step 3: API design
~~~http
POST /v1/estimates { pickup:{lat,lng}, dropoff:{lat,lng}, product:"COMFORT" } -> { fare:{min,max,currency}, surge:1.4, etaSeconds, estimateId }
POST /v1/rides { estimateId, paymentMethodId } (Idempotency-Key) -> 201 { rideId, status:"REQUESTED" }
GET  /v1/rides/{id}                         -> { status, driver, vehicle, driverLocation, etaSeconds }
POST /v1/rides/{id}/cancel
WS   /v1/drivers/stream   driver -> server: { lat, lng, heading, speed, ts }   server -> driver: { type:"OFFER", rideId, pickup, expiresAt }
POST /v1/offers/{rideId}/accept   (driver)
~~~

## Step 4: Database design
- **Live driver locations**: in-memory geo index (Redis GEO or custom service using H3 cells), partitioned by city; ephemeral.
- **Trips**: relational (Postgres/MySQL, sharded by city or trip id) for state transitions with strong consistency; append-only trip events.
- **Location history**: time-series / wide-column (Cassandra) partitioned by trip_id.
- **Pricing/surge**: per-cell surge multipliers in Redis, recomputed periodically.
- **Payments**: separate service with its own ledger DB.

## Step 5: High-level architecture
~~~mermaid
flowchart LR
  D["Driver app"] <-->|"WebSocket"| DGW["Driver gateway"]
  R["Rider app"] --> API["API gateway"]
  DGW --> LOC["Location service"] --> GEO[("Geo index: Redis / H3 cells (per city)")]
  LOC -->|stream| K{{"Kafka: locations"}} --> HIST[("Cassandra: trip traces")]
  K --> SURGE["Surge calculator"] --> SC[("Surge per cell")]
  API --> PR["Pricing service"] --> SC
  API --> TRIP["Trip service"] --> TDB[("Trips DB")]
  TRIP --> DISP["Dispatch / matching service"] --> GEO
  DISP --> ETA["ETA / routing service"]
  DISP --> DGW
  TRIP -->|TripCompleted| PAY["Payment service"]
~~~

## Step 6: Detailed component design
### Location ingestion
Drivers send updates over persistent connections. The location service updates the driver's cell in the geo index (remove from old cell if changed), and publishes to Kafka for surge, ETA models and trip traces. Updates are idempotent and last-write-wins by timestamp.
### Matching
1. Trip service creates trip (REQUESTED) and asks dispatch.
2. Dispatch queries geo index for available drivers in the pickup cell and neighbour rings (expanding until enough candidates).
3. Computes ETA for top candidates via routing service (road network, traffic), filters by vehicle type and rating.
4. **Reserves** the best driver atomically: {{driver status AVAILABLE -> OFFERED}} via CAS (Redis Lua or conditional DB update).
5. Sends offer with a 10-15 s expiry; on decline/timeout releases and tries next. Batch matching (assign many requests to many drivers every couple of seconds to optimise global ETA) is a refinement.
### Trip state machine
Conditional updates on status prevent races (rider cancels while driver accepts). Each transition emits events (notifications, analytics).
### Surge
Per H3 cell, ratio of demand (requests, app opens) to supply (available drivers) over a sliding window, smoothed and capped; price estimate stores the surge used so the charged fare matches what the rider accepted.

## Step 7: Scalability
- Partition everything real-time by **city/region**: geo index, dispatch, surge. A city is a natural shard and failure domain.
- Location service scales horizontally; Kafka partitioned by driver id.
- Dispatch is CPU-heavy (ETA computations): cache ETAs for cell pairs; limit candidates.
- Trips DB sharded by city/trip id; read replicas for history.

## Step 8: Reliability
- Geo index loss: rebuilt within seconds because drivers resend locations continuously.
- Dispatch instance crash: offers expire; trip remains REQUESTED and is retried by another instance (idempotent by trip id).
- Double assignment prevented by CAS on driver status; trip-driver link created with conditional update.
- Region outage: city cells fail over to another region with replicated trip state; ongoing trips continue on clients and sync later.
- Payments decoupled: trip completion event via outbox; payment retries do not affect trip completion.

## Step 9: Security
- Strong auth for drivers (device binding, periodic selfie checks), riders via OTP + tokens.
- Location privacy: precise locations only shared during active trips; masked phone numbers (proxy calling).
- Fraud detection (GPS spoofing, fake trips), rate limits on requests/cancellations.
- PCI: card tokens with payment provider; no PAN storage.

## Step 10: Trade-offs
| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| Geo index | H3/geohash cells in memory | PostGIS queries | Update rate too high for DB indexes; ephemeral data |
| Matching | Greedy nearest-ETA with reservation | Global batch optimisation | Simpler, lower latency; batch improves efficiency at high density |
| Partitioning | By city | Global | Locality, isolation, residency |
| Trip state | Relational with conditional updates | Event-sourced store | Simpler consistency; events still emitted |

## Step 11: Interview follow-ups
?? Why not query PostGIS for nearby drivers?
250k location writes/s would thrash spatial indexes and WAL; the data is ephemeral. In-memory cell indexes give O(1) updates and fast neighbour lookups. PostGIS is fine for static geo data (zones, airports).
?? How do you choose geohash vs H3?
Geohash cells are rectangles with distortion and edge effects (neighbours have different prefixes). H3 hexagons have uniform neighbour distances, better for surge and supply/demand smoothing. Both work; mention edge handling.
?? How do you prevent two riders from getting the same driver?
Atomic reservation on driver status (CAS) before sending the offer, with expiry, and a unique constraint that a driver has at most one active trip.
?? Driver app loses connectivity mid-trip. What happens?
The trip continues; the app buffers locations and syncs later; fare is computed from the route reconstructed from buffered points or estimated from the map route.
?? How do you compute ETA quickly?
Precomputed road graph with contraction hierarchies, live traffic speeds per segment, ML corrections; cache results between cells for short periods.
?? How do you avoid a thundering herd when a concert ends?
Surge pricing smooths demand, batch matching improves assignment, queueing at pickup zones, and rate limiting of repeated requests.
?? How would you implement driver heat maps for drivers?
Aggregate demand per cell from the request stream every minute and publish to drivers' apps; read-only, eventually consistent.
?? Where would you use Kafka vs direct calls?
Kafka for location streams, trip events, analytics and payments triggers; direct (gRPC) calls for latency-critical request/response like ETA and dispatch decisions.
?? How do you handle cross-border data residency?
Deploy per region; user and trip data stored in the country's region; global services only see anonymised aggregates.
?? How do you test dispatch changes safely?
Shadow mode (run new algorithm without acting), city-level A/B tests with guardrail metrics (ETA, cancellation rate, driver earnings).
` },

{ id: 'amazon', title: 'Amazon / E-commerce Platform', level: 'advanced', tags: ['e-commerce', 'saga', 'inventory', 'search'], viz: 'saga',
  summary: 'Catalog, search, cart, checkout saga with inventory reservation and payment, order management, flash-sale protection.',
  mock: { deep: 'Walk through checkout: how do you prevent overselling and make sure the customer is charged exactly once even if services fail midway?',
          keys: [['Inventory reservation with conditional decrement / hold + expiry', 'reserv|hold|conditional|decrement'], ['Payment authorization with idempotency key', 'idempot|authoriz'], ['Saga with compensations (release stock / void payment)', 'saga|compensat|release|void|refund'], ['Order state machine (PENDING -> CONFIRMED)', 'pending|state|status'], ['Outbox / reliable events', 'outbox|event|kafka'], ['Price and stock re-validation at checkout', 'revalidat|re-?check|snapshot|price']] },
  body: md`
## Step 1: Requirements gathering
### Functional
- Browse catalogue, search with filters, product detail pages.
- Cart (guest and logged in), checkout with address, delivery options, payment.
- Inventory per warehouse; order tracking; cancellations and returns.
- Promotions/coupons; reviews.

### Non-functional
- Product pages and search highly available and fast (cached).
- Checkout strongly consistent for stock and payment: no overselling, no double charge.
- Scale for sales events (10× traffic spikes).
- Region-specific: VAT/GST, currencies (AED/INR), COD in India/UAE.

### Assumptions
- 50M DAU, 2M orders/day; browse:order ratio very high (~100+ page views per order).

## Step 2: Capacity estimation
- Orders: 2M/day ≈ **~23/s** average; sale peak ×20 ≈ 500/s.
- Product page views: 50M × 20 pages = 1B/day ≈ **~12k/s**, peak ~100k/s: served mostly from CDN/cache.
- Search: ~3k/s average.
- Catalogue: 100M SKUs × 10 KB document ≈ 1 TB (+ images in object storage/CDN).
- Orders storage: 2M × 5 KB ≈ 10 GB/day ≈ 3.6 TB/year.

## Step 3: API design
~~~http
GET  /v1/products/{sku}                        (cacheable; price & stock fetched separately)
GET  /v1/search?q=iphone&brand=apple&priceMax=4000&cursor=
POST /v1/cart/items { sku, qty }  · GET /v1/cart
POST /v1/checkout/quote { cartId, addressId, coupon } -> { quoteId, lines, shipping, tax, total, expiresAt }
POST /v1/orders { quoteId, paymentMethod } Idempotency-Key -> 202 { orderId, status:"PENDING_PAYMENT", nextAction }
GET  /v1/orders/{id} · POST /v1/orders/{id}/cancel · POST /v1/orders/{id}/returns
~~~
The **quote** freezes prices, taxes and promotions for a short window so the charged amount equals the shown amount.

## Step 4: Database design
- **Catalogue**: document store or Postgres JSONB (attributes vary per category) + search index (OpenSearch).
- **Price**: separate service/table (changes often, per region/seller).
- **Inventory**: relational, (sku, warehouse) rows with on_hand/reserved and conditional updates (see Inventory LLD).
- **Cart**: Redis/DynamoDB keyed by user/session (high write, TTL for guests).
- **Orders**: relational, sharded by customer_id or order_id; order lines; status history; outbox table.
- **Payments**: separate service with ledger.

## Step 5: High-level architecture
~~~mermaid
flowchart LR
  C["Web / App"] --> CDN["CDN"] --> GW["API gateway / BFF"]
  GW --> CAT["Catalog svc"] --> CDB[("Catalog DB")]
  CDB -->|CDC| SRCH["Search (OpenSearch)"]
  GW --> SRCH
  GW --> CART["Cart svc"] --> CR[("Redis / DynamoDB")]
  GW --> CHK["Checkout / Order svc (saga orchestrator)"] --> ODB[("Orders DB + outbox")]
  CHK --> INV["Inventory svc"] --> IDB[("Inventory DB")]
  CHK --> PAY["Payment svc"] --> PSP["Payment providers"]
  CHK --> PRICE["Pricing & promotions"]
  ODB -->|outbox -> Kafka| K{{"Kafka"}}
  K --> FUL["Fulfilment / WMS"] & NOTIF["Notifications"] & ANA["Analytics"]
~~~

## Step 6: Detailed component design
### Checkout saga (orchestrated)
1. Create order PENDING from quote (idempotency key).
2. Reserve inventory (conditional update per line, with expiry).
3. Authorise payment (idempotency key = order id). 3-DS may return "requires action"; order waits in PENDING_PAYMENT.
4. On success: confirm order, commit reservation (or keep reserved until shipment), emit OrderConfirmed via outbox.
5. On failure/timeout: release inventory (compensation), mark order FAILED/CANCELLED.
6. Capture payment at shipment (common for physical goods) or immediately depending on policy.
### Flash sales
Virtual waiting room / queue tokens, pre-allocated stock buckets, rate limiting per user, and pre-warmed caches. The "Buy" button path is kept minimal.
### Search
Index product documents with category-specific facets, synonyms, Arabic/English analyzers; ranking combines text relevance and business signals.

## Step 7: Scalability
- Read path: CDN for static/product content, Redis for product/pricing, search cluster scaled by shards/replicas.
- Write path: order service partitioned by customer id; inventory hot SKUs handled with bucketed stock.
- Async: fulfilment, emails, analytics via Kafka.
- Autoscale stateless services ahead of planned sales (pre-scale; autoscaling reacts too slowly to step changes).

## Step 8: Reliability
- Payment provider outage: route to secondary provider; circuit breakers; orders wait in pending with timeouts.
- Inventory service slow: checkout fails fast (do not oversell); product pages show cached availability.
- Duplicate submits: idempotency keys on order creation and payment.
- Outbox guarantees events after DB commit; consumers idempotent.
- Multi-AZ databases, backups, DR region.

## Step 9: Security
- OAuth2/OIDC for customers; step-up auth for sensitive actions (changing address/payment).
- PCI: tokenised payments, hosted fields; no PAN on our servers.
- Object-level authorization on orders; rate limiting and bot protection on checkout and coupons.
- Fraud scoring before capture.

## Step 10: Trade-offs
| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| Stock decrement | Reserve at checkout | At add-to-cart | Avoids abandoned carts locking stock |
| Consistency | Saga + reservations | 2PC across services | Availability and service autonomy |
| Catalogue store | Document + search index | Normalised SQL only | Flexible attributes, faceted search |
| Payment timing | Authorise then capture at ship | Immediate capture | Fewer refunds for unshippable orders |

## Step 11: Interview follow-ups
?? Two customers buy the last unit at the same time. What happens?
Both reach inventory; the conditional decrement succeeds for one; the other's saga gets OutOfStock and fails before payment authorisation. No oversell, no charge for the loser.
?? Payment authorised but the order service crashed before recording it. How do you recover?
Payment used the order id as idempotency key; the orchestrator's saga state is persisted, and on restart it re-queries payment status (or receives the webhook) and continues. Reconciliation jobs catch stragglers.
?? How do you show stock on product pages without hammering inventory?
Cached availability buckets (in stock / few left / out) updated by inventory events; exact check only at checkout.
?? How do you handle price changes between cart and checkout?
Quote freezes price for a few minutes; if expired, re-quote and show the change to the customer before charging.
?? Cash on delivery is common in UAE/India. What changes?
No payment authorisation step; risk controls (COD limits, OTP confirmation), order confirmed after reservation; settlement reconciled from courier.
?? How do you implement order history at scale?
Orders sharded by customer id, so "my orders" is a single-shard query with keyset pagination; older orders archived to cheaper storage.
?? How would you design coupons to prevent abuse?
Validate in the pricing service with per-user usage counters (atomic), unique codes, rate limits; redeem coupon as part of the saga (reserve then commit).
?? How do you handle a 10× traffic spike at 00:00 for a sale?
Pre-scale, warm caches, waiting room, feature-flag non-essential features off (recommendations), and load test the exact flow beforehand.
?? Why separate price from catalogue?
Different change rates and ownership: catalogue changes rarely and is cached long; prices change frequently and must be fresh at checkout.
?? How do returns and refunds integrate?
Returns create a return order; after inspection, refund via payment service with idempotency; inventory restocked through an adjust movement.
` },

{ id: 'netflix', title: 'Netflix / Video Streaming', level: 'advanced', tags: ['cdn', 'video', 'personalization', 'multi-region'],
  summary: 'Subscription streaming: control plane in the cloud, data plane via ISP-embedded CDN, playback licensing, resilience and personalization.',
  mock: { deep: 'Explain what happens when a user presses Play until video frames appear, including how the right CDN server is chosen.',
          keys: [['Playback API authorises entitlement and device', 'entitle|subscription|device|authoriz'], ['DRM licence acquisition', 'drm|licen[cs]e|widevine|fairplay'], ['Steering to best CDN/edge (Open Connect / ISP-embedded)', 'steer|open connect|isp|nearest|edge|cdn'], ['Manifest with multiple bitrates; ABR', 'manifest|bitrate|abr|adaptive'], ['Pre-positioning popular content off-peak', 'pre.?position|off.?peak|fill|popular']] },
  body: md`
## Step 1: Requirements gathering
### Functional
- Subscriptions and profiles; browse personalised home rows; search.
- Play titles with adaptive quality on TVs, phones, browsers; resume where left off.
- Downloads for offline viewing; parental controls.

### Non-functional
- Fast start and minimal rebuffering at very high concurrency.
- Control plane highly available (browse/play must work even if some services fail).
- Content protection (DRM); regional licensing restrictions.

### Difference from YouTube
Curated catalogue (tens of thousands of titles, not billions), so content can be **pre-encoded and pre-positioned** to edges ahead of demand; no user uploads.

### Assumptions
- 200M+ subscribers, peak concurrent streams in the tens of millions, average bitrate ~ 5 Mbps.

## Step 2: Capacity estimation
- Peak egress: 20M concurrent × 5 Mbps = **100 Tbps**. Impossible to serve from a few cloud regions economically; requires edge appliances inside ISPs/IXPs.
- Catalogue storage: e.g. 20k titles × average 2 hours × multiple encodes (resolutions, codecs, audio tracks, subtitles) per title ≈ order of hundreds of TB to low PB total. Small relative to egress, so full catalogue can be replicated widely.
- Control-plane calls: browse/home, playback start, heartbeats; tens of thousands to hundreds of thousands of requests/s at peak.

## Step 3: API design
~~~http
GET  /v1/home?profileId=...           -> rows: [ { title:"Trending in UAE", items:[...] } ]   (personalised)
POST /v1/playback/start { titleId, profileId, deviceCaps } -> { manifestUrl (signed), licenseUrl, steeringUrls:[...], resumeAt }
POST /v1/playback/heartbeat { sessionId, positionSec, bitrate, rebufferEvents }
POST /v1/license (DRM challenge) -> licence
~~~

## Step 4: Database design
- Subscriber/billing: relational (strong consistency).
- Viewing history, bookmarks: wide-column (Cassandra) partitioned by profile, multi-region replicated.
- Catalogue metadata: replicated read-optimised store + cache.
- Personalisation features and precomputed rows: key-value store (EVCache/Redis-like) per profile.
- Content: encoded files on object storage (origin) and on edge appliances.

## Step 5: High-level architecture
~~~mermaid
flowchart LR
  Dev["TV / phone / browser"] --> EDGEAPI["Edge API gateway (cloud, multi-region)"]
  EDGEAPI --> HOME["Personalisation / home rows"] --> FEAT[("Precomputed rows cache")]
  EDGEAPI --> PLAY["Playback service"] --> ENT["Entitlements & licensing"]
  PLAY --> STEER["Steering: pick best edge servers"]
  PLAY --> DRM["DRM licence service"]
  Dev -->|"segments"| OCA["Edge appliances inside ISPs / IXPs"]
  OCA -->|"off-peak fill"| ORIGIN[("Origin object storage")]
  ENC["Encoding pipeline"] --> ORIGIN
  Dev -->|heartbeats| K{{"Event stream"}} --> HIST[("Viewing history")] & ML["Recommendation training"]
~~~

## Step 6: Detailed component design
### Encoding
Per-title (and per-shot) encoding optimises bitrate ladders by content complexity; multiple codecs (H.264, HEVC, VP9, AV1) for device support; encoded once, stored at origin.
### Content distribution
Popular titles are **pre-positioned** to edge appliances during off-peak hours based on predicted demand per region. Each appliance holds a subset; steering service knows which appliances hold which files and their health/load.
### Playback start
Playback service checks entitlement (subscription, region licensing, concurrent stream limit), returns a signed manifest and a ranked list of edge URLs (steering considers network proximity, appliance load and content presence). The player fetches the DRM licence, then segments; ABR adapts quality; it can fail over to the next edge URL.
### Personalisation
Offline/nearline ML computes candidate rows per profile; online service assembles, applies business rules and artwork personalisation; cached per profile.

## Step 7: Scalability
- Data plane scales by adding edge appliances near users; most traffic never reaches the cloud.
- Control plane: stateless services autoscaled across multiple cloud regions, heavy caching.
- Event streams for heartbeats/analytics partitioned and processed asynchronously.

## Step 8: Reliability
- Multi-region active-active control plane; region evacuation by redirecting traffic.
- Fallbacks everywhere: if personalisation fails, serve popular rows; if bookmarks fail, start from the beginning.
- Chaos engineering (killing instances, latency injection) to verify resilience continuously.
- Client retries segments from alternate edges.

## Step 9: Security
- DRM with hardware-backed security levels determining max resolution.
- Signed, short-lived URLs; device authentication; account sharing controls.
- Regional licensing enforced at entitlement time.

## Step 10: Trade-offs
| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| CDN | Own ISP-embedded appliances | Commercial CDN only | At this egress, cost and quality favour own edge; commercial CDN is right for smaller players |
| Distribution | Proactive pre-positioning | Pull-through caching | Curated catalogue and predictable demand |
| Control plane | Multi-region active-active | Single region + DR | Availability at global scale; more complexity |
| Personalisation | Precomputed + online assembly | Fully online inference | Latency and cost |

## Step 11: Interview follow-ups
?? How is this different from designing YouTube?
Curated catalogue vs user uploads; proactive distribution vs long-tail pull; heavier DRM and licensing; no upload/processing at internet scale.
?? An ISP appliance fails during peak. What happens?
Steering stops returning it; active players fail over to the next URL in their list within seconds; traffic shifts to other appliances or upstream.
?? How do you enforce "2 screens at a time"?
Playback start acquires a stream lease per account (atomic counter with TTL refreshed by heartbeats); exceeding the limit returns an error; leases expire if heartbeats stop.
?? How do you resume playback across devices?
Heartbeats write bookmark positions to viewing history (last write wins per title/profile); playback start returns resumeAt.
?? How do you reduce startup time?
Steering to close edges, small initial segments at lower bitrate, prefetching the first segments of likely titles when users hover, and fast licence acquisition.
?? How do you design A/B testing for artwork?
Allocate profiles to test cells deterministically, log impressions/plays via events, analyse offline; serve artwork via CDN with variant IDs.
?? How do you protect the control plane from a retry storm after an outage?
Client backoff with jitter, server-side load shedding by priority (playback over browse), and admission control at the edge gateway.
?? Where would Kafka fit?
Heartbeat and event ingestion, viewing history updates, analytics and ML pipelines.
?? How do you handle content licensing by region?
Entitlement service checks title availability windows per country; catalogue and home rows filtered per region.
?? What would you do differently for a small streaming startup in the Middle East?
Use a commercial multi-CDN, managed encoding (AWS Elemental MediaConvert), managed DRM, and a single-region control plane with DR; build own edge only if egress cost justifies it.
` }
]);
})();
