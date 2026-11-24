(function () {
const md = LAB.md;
const S = 'Real-time, Storage & Platform';

LAB.add('sd', S, [
{ id: 'realtime-chat', title: 'Real-time Chat Application (Slack-style)', level: 'advanced', tags: ['websocket', 'pub-sub', 'multi-tenant'], viz: 'kafka',
  summary: 'Workspaces, channels, threads, presence, typing indicators, search and history at enterprise scale.',
  mock: { deep: 'How does a message posted in a channel with 5,000 members reach every online member\'s open client in real time across many WebSocket servers?',
          keys: [['WebSocket gateway servers holding connections', 'websocket|gateway|connection'], ['Pub/sub fan-out by channel (Redis pub/sub / Kafka / internal bus)', 'pub.?sub|subscribe|fan.?out|topic'], ['Gateway subscribes only to channels its users have open', 'subscri|interest|only channels|routing table'], ['Message persisted with per-channel ordering before broadcast', 'persist|sequence|order|ts|timestamp'], ['Clients catch up via history API after reconnect', 'reconnect|catch.?up|history|since']] },
  body: md`
## Step 1: Requirements gathering
### Functional
- Workspaces (tenants) with channels (public/private), DMs, threads, reactions, file sharing.
- Real-time delivery to open clients; unread counts; mentions and notifications.
- Presence and typing indicators; message edit/delete; full-text search.
### Non-functional
- Low latency to online clients; durable history; per-channel ordering.
- Tenant isolation, enterprise compliance (retention policies, eDiscovery, data residency).
- Clients on desktop/mobile/web, frequent reconnects.
### Differences from WhatsApp
Server-side history and search (not E2E by default), large channels, multi-tenancy, integrations/bots.
### Assumptions
- 20M DAU, 10M concurrent connections at peak, 1B messages/day.

## Step 2: Capacity estimation
- Messages: 1B/day ≈ **11.6k/s** average, peak ×3 ≈ 35k/s.
- Fan-out: average channel delivery to ~20 online members → ~700k deliveries/s at peak.
- Connections: 10M; at ~100k per gateway node that is ~100 nodes (estimate, validate).
- Storage: 1B × 1 KB (with metadata, reactions) ≈ 1 TB/day ≈ 365 TB/year before replication; search index similar order.

## Step 3: API design
~~~http
WS  /v1/rtm?token=...   events: message, message_changed, reaction_added, typing, presence_change, channel_marked
POST /v1/channels/{id}/messages { text, threadTs?, clientMsgId } -> { ts: "1764000000.000200" }
GET  /v1/channels/{id}/history?before=<ts>&limit=100
GET  /v1/search?q=deploy+in:#infra+from:@kartik&cursor=
POST /v1/channels/{id}/mark { ts }        (read position -> unread counts)
~~~

## Step 4: Database design
- Messages: sharded by workspace (and channel) e.g. Vitess/MySQL or Cassandra; key (channel_id, ts); ts is a per-channel sortable id.
- Channel membership and workspace metadata: relational, cached.
- Read cursors per (user, channel): key-value store.
- Search: Elasticsearch/OpenSearch per workspace (or shared with tenant routing), with ACL fields.
- Files: object storage with per-file ACL checks.

## Step 5: High-level architecture
~~~mermaid
flowchart LR
  Client <-->|WebSocket| GWS["Gateway servers"]
  Client --> API["HTTP API"]
  API --> MSG["Message svc"] --> MDB[("Messages DB (sharded by workspace/channel)")]
  MSG --> BUS{{"Channel pub/sub bus"}}
  BUS --> GWS
  GWS --> PRES["Presence svc"] --> PR[("Redis presence")]
  MSG -->|events| K{{"Kafka"}} --> IDX["Search indexer"] --> ES[("Search")]
  K --> NOTIF["Mentions / push notifications"]
  K --> UNR["Unread counters"]
~~~

## Step 6: Detailed component design
- **Posting**: API validates membership, assigns channel ts (monotonic per channel), persists, publishes to the channel topic on the bus, acks client with ts (client reconciles optimistic message by clientMsgId).
- **Fan-out**: each gateway maintains a routing table of channels its connected users have open/subscribed and subscribes to those channel topics on the bus; on event, it pushes to the relevant sockets. Large channels handled efficiently because each gateway receives one copy per channel, not per user.
- **Reconnect**: client calls history since last ts per channel to fill gaps; events carry ts for dedup.
- **Presence**: heartbeats to presence service; presence changes broadcast only to users who have that person visible, coalesced/throttled.
- **Typing indicators**: ephemeral, never persisted, best-effort.
- **Unread counts**: computed from read cursor vs latest ts per channel, with mention counts maintained by consumers.

## Step 7: Scalability
Shard by workspace for data locality and isolation; dedicated shards for the largest enterprises; gateways scale horizontally; bus partitioned by channel id; search indexing async.

## Step 8: Reliability
Gateway failure: clients reconnect elsewhere and backfill via history. Bus message loss: clients detect gaps by ts and refetch. DB replicated; workspace-level DR. Degrade presence/typing first under load.

## Step 9: Security
SSO (SAML/OIDC) per workspace via enterprise IdPs, SCIM provisioning, enterprise key management (customer-managed keys), retention and legal hold, DLP scanning, private channel ACLs enforced at API, search and file layers.

## Step 10: Trade-offs
| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| Fan-out | Per-channel pub/sub to gateways | Per-user queues | Large channels efficient |
| Data partition | Workspace | Global by channel | Tenant isolation, enterprise shards |
| Presence | Throttled, best effort | Exact real-time | Presence storms are expensive |

## Step 11: Interview follow-ups
?? How do you guarantee ordering within a channel?
A single writer per channel assigns ts (or a sequence from the channel's shard); clients sort by ts.
?? How do you handle a 100k-member announcement channel?
Restrict posting, fan-out via gateways (one copy per gateway), lazy-load for offline users, throttle notifications.
?? How do you implement message edits and deletes?
New events (message_changed/deleted) referencing ts; storage keeps edit history if retention policy requires.
?? How do you search only messages a user can access?
Index ACL fields (channel ids); filter by user's channel memberships at query time; private channels' membership cached.
?? How do you compute unread badges across many channels quickly?
Store latest ts per channel and user read cursors; compute on connect; maintain incrementally via events.
?? What happens during a gateway deploy?
Drain: stop accepting connections, notify clients to reconnect with jitter, wait for connections to move.
?? How would you support bots and integrations?
Events API (webhooks) and bot tokens with scopes; rate limits per app; outbound webhooks with retries and signatures.
?? How do you enforce data residency for a UAE government customer?
Workspace pinned to an in-country region (storage, search, backups), with metadata routing so the workspace's data never leaves.
?? Why not store messages in Kafka forever?
Kafka is excellent for streaming and replay, but random-access history by channel and time, edits and deletes are better served by a database.
?? How do you prevent a noisy tenant from affecting others?
Per-workspace rate limits, shard isolation for heavy tenants, separate search indices.
` },

{ id: 'google-drive', title: 'File Storage System (Google Drive)', level: 'advanced', tags: ['object-storage', 'sync', 'chunking'],
  summary: 'Upload/download, chunking and dedup, metadata hierarchy, sync across devices, sharing permissions and versioning.',
  mock: { deep: 'How does desktop sync work when a user edits a 2 GB file on one laptop, and how do other devices get the change efficiently?',
          keys: [['Split files into chunks with content hashes', 'chunk|block'], ['Upload only changed chunks (delta)', 'changed|delta|only.{0,20}(modified|new)'], ['Metadata service tracks file versions as chunk lists', 'metadata|version|manifest'], ['Notification / long-poll for change feed to other devices', 'notif|long.?poll|websocket|change (feed|log)|cursor'], ['Conflict handling for concurrent edits', 'conflict|copy|merge'], ['Deduplication by hash', 'dedup|hash']] },
  body: md`
## Step 1: Requirements gathering
### Functional
- Upload, download, organise files/folders; sync across devices; share with users/links (viewer/editor).
- Version history and restore; trash; previews.
### Non-functional
- Durability is paramount (no data loss); high availability for reads.
- Efficient sync over slow networks (resume, delta uploads).
- Strong consistency of metadata (renames/moves visible consistently); files can be huge.
### Assumptions
- 100M users, 10 GB average used → 1 EB logical; 10M DAU uploading 20 files/day averaging 1 MB.

## Step 2: Capacity estimation
- Uploads: 10M × 20 = 200M files/day ≈ 2.3k files/s; ≈ 200 TB/day of new data before dedup.
- Metadata ops (list, stat, sync polls) far higher: ~50k-100k/s.
- Storage: dedup and compression reduce physical storage; erasure coding (e.g. ~1.5× overhead) vs 3× replication matters at EB scale.

## Step 3: API design
~~~http
POST /v1/files/uploads { parentId, name, size, chunkHashes:[...] } -> { uploadId, missingChunks:[{hash, uploadUrl}] }
PUT  <uploadUrl>   (chunk bytes)
POST /v1/files/uploads/{uploadId}/commit -> { fileId, version }
GET  /v1/files/{id}/content?version=   (redirect to signed URLs per chunk or assembled stream)
GET  /v1/changes?cursor=...             (sync feed: created/modified/deleted entries)
POST /v1/files/{id}/permissions { principal, role }
~~~

## Step 4: Database design
- **Metadata** (strongly consistent, transactional): files/folders tree, versions, permissions. Sharded relational (by user/namespace) or a distributed SQL store.
~~~sql
file(id, namespace_id, parent_id, name, is_folder, current_version, deleted, updated_at, UNIQUE(namespace_id, parent_id, name))
file_version(file_id, version, size, chunk_list JSONB /* ordered hashes */, created_by, created_at)
chunk(hash PRIMARY KEY, size, ref_count, storage_location)
acl(file_id, principal, role)
change_log(namespace_id, seq, file_id, op, at)  -- drives the sync cursor
~~~
- **Blob storage**: chunks in object storage keyed by content hash.

## Step 5: High-level architecture
~~~mermaid
flowchart LR
  DC["Desktop sync client"] & WEB["Web / mobile"] --> GW["API gateway"]
  GW --> META["Metadata svc"] --> MDB[("Metadata DB (sharded)")]
  GW --> UP["Upload svc"] --> BLOB[("Object storage: chunks by hash")]
  META --> CL[("Change log")]
  GW --> NOTIF["Notification svc (long-poll / WebSocket)"]
  CL --> NOTIF
  UP -->|"FileCommitted"| K{{"Kafka"}} --> PREV["Preview / thumbnail / virus scan"] & IDX["Search indexing"]
~~~

## Step 6: Detailed component design
- **Chunking**: client splits files into chunks (fixed size, e.g. 4 MB, or content-defined chunking so inserts don't shift all boundaries), hashes each.
- **Upload**: server returns which hashes are missing (dedup across versions/users within security boundaries); client uploads only those; commit creates a new version pointing to the chunk list in one metadata transaction.
- **Sync**: each device keeps a cursor into its namespace's change log; long-poll/WebSocket notification says "changes available"; client fetches changes and downloads missing chunks.
- **Conflicts**: optimistic concurrency on version (commit with base version); if base is stale, create a "conflicted copy" rather than overwrite.
- **Sharing**: ACL check on every metadata/content request; shared folders mounted into other users' namespaces.
- **Garbage collection**: chunk ref counts; delete after versions expire and trash retention passes.

## Step 7: Scalability
Metadata sharded by namespace; hot shared folders cached; blob storage scales independently; notification service holds many idle connections; CDN for popular public links.

## Step 8: Reliability
Erasure coding across zones; checksums end to end (client hash verified on server); metadata DB replicated with PITR; resumable uploads; idempotent commits by uploadId.

## Step 9: Security
Encryption in transit and at rest (per-chunk keys wrapped by KMS); ACL enforcement and signed short-lived download URLs; malware scanning; link sharing with expiry/password; audit logs for enterprise; careful dedup scope (cross-user dedup can leak file existence: limit to same user/tenant).

## Step 10: Trade-offs
| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| Chunking | Content-defined | Fixed size | Better delta for inserts; more CPU |
| Dedup scope | Per tenant/user | Global | Privacy side-channel risk |
| Conflict policy | Conflicted copy | Last writer wins | Never lose user data |
| Durability | Erasure coding | 3× replication | Lower storage cost at scale |

## Step 11: Interview follow-ups
?? How do you upload a 50 GB file over a flaky connection?
Chunked, resumable uploads with per-chunk retries and server-side tracking of received chunks; commit only when all present.
?? Two devices edit the same file offline. What happens on sync?
Both commit against the same base version; the second fails the version check and is saved as a conflicted copy for the user to merge.
?? How do you implement "rename a folder with 1M files" efficiently?
Store parent ids, not full paths; rename updates one row. Path computed on read (cached).
?? How do you support real-time collaborative editing (Docs)?
Different system: operational transforms or CRDTs via a collaboration server per document; storage snapshots + op log.
?? How do you get notified of changes without constant polling?
Long-poll or WebSocket notification channels per namespace; clients fetch the change log with their cursor.
?? How do you handle deletes and restores?
Soft delete to trash with retention; versions retained per policy; GC removes unreferenced chunks later.
?? Why is metadata consistency more important than blob consistency?
Blobs are immutable and content-addressed; metadata defines what the user sees; inconsistency there shows wrong trees or loses files.
?? How do you generate previews?
Async workers on commit events; store preview artifacts; serve via CDN with ACL-bound signed URLs.
?? How would you implement storage quotas?
Per-user usage counters updated on commit/delete in the metadata transaction; enforce at upload start.
?? How do you search file contents?
Async text extraction and indexing with ACL fields; query filtered by user's accessible namespaces.
` },

{ id: 'search-autocomplete', title: 'Search Autocomplete', level: 'intermediate', tags: ['trie', 'caching', 'ranking'],
  summary: 'Top-K suggestions per prefix with low latency: trie with cached top-K, offline aggregation, personalisation and freshness.',
  mock: { deep: 'How do you return the top 10 suggestions for any prefix in a few milliseconds, and how do suggestions get updated as search trends change?',
          keys: [['Trie / prefix index', 'trie|prefix'], ['Precomputed top-K per node', 'top.?k|precomput|cached at (each|every) node'], ['Offline aggregation of query logs (batch/stream)', 'aggregat|query log|batch|spark|stream'], ['Serving from memory with replicas/sharding by prefix', 'memory|shard|replica|prefix range'], ['Browser/CDN caching and debounce', 'debounce|browser cache|cdn|client'], ['Freshness: trending updates / periodic rebuild', 'trend|rebuild|refresh|freshness']] },
  body: md`
## Step 1: Requirements gathering
### Functional
- As the user types, return top 10 suggestions for the prefix, ranked by popularity (and optionally personalisation, locale).
- Support English and Arabic/Hindi scripts; filter offensive suggestions.
### Non-functional
- Very low latency (each keystroke), high QPS, high availability.
- Freshness: trending queries appear within minutes to hours.
### Assumptions
- 100M DAU × 10 searches × 6 keystrokes after debounce ≈ 6B requests/day.

## Step 2: Capacity estimation
- 6B/day ≈ **70k QPS** average; peak ×3 ≈ 200k QPS.
- Unique queries: e.g. 1B distinct; keep only those above a frequency threshold (e.g. top 100M).
- Trie memory: nodes for 100M queries averaging 20 chars with shared prefixes plus top-10 lists per node; order of tens of GB: shard by prefix ranges or keep top-K only up to a depth.

## Step 3: API design
~~~http
GET /v1/suggest?q=burj%20k&locale=en-AE&limit=10
-> { "suggestions": ["burj khalifa tickets", "burj khalifa height", ...] }
Cache-Control: public, max-age=300
~~~

## Step 4: Database design
- Query logs to object storage/Kafka; aggregated counts table (query, locale, count, last_seen) in a data warehouse.
- Serving: in-memory trie snapshots built offline and loaded by suggestion servers; or a key-value store of prefix -> top-K list (Redis/RocksDB) for prefixes up to N chars.

## Step 5: High-level architecture
~~~mermaid
flowchart LR
  U["Browser (debounce 100-200 ms)"] --> CDN["CDN cache for common prefixes"] --> SUG["Suggestion servers (in-memory trie snapshot)"]
  U -->|"search submitted"| LOG{{"Kafka: query log"}}
  LOG --> BATCH["Batch aggregation (daily/hourly)"] --> BUILD["Trie builder: top-K per node"] --> SNAP[("Snapshot in object storage")] --> SUG
  LOG --> STREAM["Streaming trending detector"] --> TREND[("Trending overlay")] --> SUG
~~~

## Step 6: Detailed component design
- **Trie with top-K at each node**: lookup is O(prefix length) then return the cached list. Building: aggregate counts, insert queries, propagate top-K up the tree (heap merge).
- **Sharding**: by first characters (range-based with rebalancing for skew: "s" is far more common than "x"), or replicate the full trie if it fits.
- **Freshness**: rebuild snapshot periodically; trending overlay from streaming counts (sliding window with decay) merged at query time.
- **Personalisation**: blend global top-K with user's recent searches client-side or via a small per-user store.
- **Filtering**: blocklists and classifiers applied during build.

## Step 7: Scalability
Stateless replicas loading the same snapshot; CDN/browser caching for short prefixes (most requested); debouncing reduces calls; snapshot deploys rolled gradually.

## Step 8: Reliability
If suggestion service fails, search still works (autocomplete is non-critical: fail silently). Keep previous snapshot for rollback; health checks validate snapshot integrity.

## Step 9: Security
Prevent suggestion poisoning (bots inflating queries) with dedup per user/IP and anomaly detection; filter PII-looking queries from global suggestions; rate limit.

## Step 10: Trade-offs
| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| Serving | In-memory trie with precomputed top-K | Search engine prefix query | Lowest latency per keystroke |
| Updates | Periodic snapshots + trending overlay | Real-time trie updates | Simpler, consistent snapshots |
| Ranking | Frequency with time decay | ML ranking | Start simple, add learning-to-rank later |

## Step 11: Interview follow-ups
?? Why store top-K at each node instead of computing at query time?
Computing requires traversing the subtree (potentially millions of nodes); precomputation makes queries O(prefix length).
?? How do you handle typos?
Fuzzy matching with edit distance on a separate index or spelling correction model; usually a second-stage fallback when few results.
?? How do you support multiple languages?
Separate tries per locale/script, normalisation (Arabic diacritics, case folding), transliteration support.
?? How do you make trending queries appear fast?
Streaming counts with exponential decay per query; merge top trending with snapshot results.
?? How do you prevent offensive suggestions?
Filtering at build time plus a real-time blocklist checked at serve time.
?? How much does debouncing help?
It removes intermediate keystrokes for fast typists; combined with caching short prefixes it cuts backend load significantly.
?? How do you test ranking changes?
A/B testing with metrics like suggestion acceptance rate and keystrokes saved.
?? Where do you store user search history?
Per-user store with privacy controls; never mixed into global suggestions without aggregation thresholds.
?? What if the trie does not fit in memory?
Shard by prefix ranges, compress (radix tree), limit depth with top-K stored only for prefixes up to N chars and fall back to a disk-based store.
?? How do you roll out a new snapshot safely?
Canary a subset of servers, compare latency and acceptance metrics, then roll out; keep the old snapshot for rollback.
` },

{ id: 'news-feed', title: 'News Feed System', level: 'advanced', tags: ['feed', 'ranking', 'fan-out', 'caching'],
  summary: 'Generalised feed design: candidate generation, ranking, fan-out models, caching layers, pagination and freshness.',
  mock: { deep: 'Compare push, pull and hybrid feed generation and explain the read path step by step for a ranked feed.',
          keys: [['Push (fan-out on write) pros/cons', 'push|fan.?out on write'], ['Pull (fan-out on read) pros/cons', 'pull|fan.?out on read'], ['Hybrid for high-follower accounts', 'hybrid|celebrit|high.?follower'], ['Candidate generation then ranking', 'candidate|rank'], ['Hydration and caching of feed items', 'hydrat|cache'], ['Cursor pagination / dedup of seen items', 'cursor|seen|dedup']] },
  body: md`
## Step 1: Requirements gathering
### Functional
- Users see a feed of posts from friends, pages and groups, ranked by relevance; infinite scroll; new posts appear.
- Posting, reactions, comments, shares feed back into ranking.
### Non-functional
- Fast feed load; high availability; eventual consistency acceptable.
- Ranking must be explainable/controllable (integrity, policy).
### Assumptions
- 1B DAU, 300 friends average, feed opened 10×/day.

## Step 2: Capacity estimation
- Feed requests: 10B/day ≈ **115k/s** average.
- Posts: 500M/day ≈ 5.8k/s; push fan-out to 300 friends ≈ **1.7M inserts/s** if pure push.
- Candidate set per feed load: hundreds to thousands of items scored by ranking models.

## Step 3: API design
~~~http
GET /v1/feed?cursor=&limit=20 -> { items:[{ id, type, actor, content, reactions, reason }], cursor }
POST /v1/feed/seen { itemIds:[...] }    (impressions for ranking & dedup)
~~~

## Step 4: Database design
- Posts store (sharded by post id), social graph store, per-user inbox of candidate post ids (cache), impression store for seen-items, feature store for ranking features, and an aggregates store for engagement counts.

## Step 5: High-level architecture
~~~mermaid
flowchart LR
  App --> FEED["Feed service"]
  FEED --> CAND["Candidate generation: inbox + pull from pages/celebrities + recommendations"]
  CAND --> INBOX[("Per-user inbox cache")]
  FEED --> RANK["Ranking (light model -> heavy model)"] --> FS[("Feature store")]
  FEED --> HYD["Hydration + privacy filters"] --> PCACHE[("Post / user caches")]
  POST["Post service"] --> K{{"Kafka"}} --> FAN["Fan-out workers"] --> INBOX
  App -->|impressions| K2{{"Kafka"}} --> FS
~~~

## Step 6: Detailed component design
1. **Candidate generation**: union of inbox (pushed from friends), pulled recent posts from followed pages/celebrities, and recommended content.
2. **Filtering**: privacy (can viewer see it), blocked users, already seen, integrity policies.
3. **Ranking**: multi-stage: cheap model prunes thousands to hundreds, heavy model predicts engagement probabilities, final score with business rules and diversity (avoid five posts from one author in a row).
4. **Hydration**: batch-fetch post details and counters from caches.
5. **Pagination**: cursor references a ranked snapshot for the session; new items surface through "new posts" UI.

## Step 7: Scalability
Hybrid fan-out bounds write cost; caches at every layer (inbox, post objects, features); ranking scaled horizontally with model servers; regional deployments.

## Step 8: Reliability
Graceful degradation: if heavy ranking times out use light ranking; if inbox cache is cold, pull from graph; if hydration of some items fails, drop them rather than failing the feed.

## Step 9: Security
Privacy checks at hydration time (not only at fan-out, since audience settings change), integrity classifiers, rate limits on posting, abuse detection.

## Step 10: Trade-offs
| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| Fan-out | Hybrid | Pure push / pull | Bounds write amplification and read latency |
| Ranking | Multi-stage | Single heavy model | Latency budget |
| Consistency | Eventual | Strong | Feed tolerates seconds of lag |

## Step 11: Interview follow-ups
?? Why enforce privacy at read time if you already filtered at fan-out?
Settings change after fan-out (unfriend, audience change). Read-time checks are authoritative.
?? How do you avoid showing the same post again?
Seen-item store (recent impressions per user, bloom filter) used in filtering.
?? How do you handle a sudden viral post?
It enters many candidate sets through recommendations and shares; caches hot post objects; counters are approximate.
?? How do you measure feed quality?
Engagement and long-term satisfaction metrics, surveys, guardrails (integrity, diversity), A/B tests.
?? What happens when a user has not logged in for 6 months?
No materialised inbox; build on demand via pull with a slightly higher latency first load, then cache.
?? How do you rank fairly between friends and pages?
Ranking features include relationship strength; business rules cap page content share; diversity constraints.
?? How do you serve the feed under 200 ms with heavy models?
Precompute features, cache embeddings, limit candidates per stage, and parallelise hydration with ranking.
?? How does the feed show "new posts" without reordering what the user is reading?
New ranked items are fetched in the background and surfaced via a pill; current session snapshot remains stable.
?? How do you keep counters consistent across the feed?
They are approximate and eventually consistent; exactness is not required for display.
?? Pull-only would be simpler; why not use it?
Each feed load would query hundreds of followees' recent posts and merge, expensive at 100k+ feeds/s; push precomputes the common case.
` },

{ id: 'logging-monitoring', title: 'Logging & Monitoring Platform', level: 'advanced', tags: ['observability', 'kafka', 'time-series'], viz: 'kafka',
  summary: 'Centralised log ingestion and search, metrics time-series, alerting, retention tiers, multi-tenant quotas and cost control.',
  mock: { deep: 'Design the log ingestion pipeline from 50,000 pods to searchable logs within seconds, surviving spikes 10× during incidents.',
          keys: [['Agents on nodes (Fluent Bit / Vector / OTel collector)', 'agent|fluent|vector|collector|daemonset'], ['Kafka buffer to absorb spikes', 'kafka|buffer|queue'], ['Indexing tier (OpenSearch / Loki / ClickHouse) with partitioning by time', 'index|opensearch|elastic|loki|clickhouse|time.?based'], ['Retention tiers hot/warm/cold (object storage)', 'hot|warm|cold|retention|s3|tier'], ['Backpressure, sampling, quotas per tenant/service', 'backpressure|sampl|quota|drop|rate'], ['Schema / structured logs and labels', 'structured|json|label|schema']] },
  body: md`
## Step 1: Requirements gathering
### Functional
- Collect logs, metrics and traces from all services; search logs by time, service, level, traceId, free text.
- Dashboards and alerting rules; retention policies per team/environment.
### Non-functional
- Ingestion keeps up during incidents (exactly when volume spikes).
- Logs searchable within seconds; metrics queries fast for dashboards.
- Multi-tenant (teams) with quotas and cost attribution; the platform must not take down production (agents bounded).
### Assumptions
- 50k pods, average 50 log lines/s each, ~300 bytes per line; 10× spikes.

## Step 2: Capacity estimation
- Logs: 50k × 50 = **2.5M lines/s** × 300 B ≈ **750 MB/s** ≈ 65 TB/day raw; spikes ×10 ≈ 7.5 GB/s for short periods.
- Compressed (often 5-10× for logs) ≈ 7-13 TB/day stored; 30 days hot ≈ a few hundred TB.
- Metrics: 50k pods × 2,000 series ≈ 100M active series (cardinality is the main cost driver).

## Step 3: API design
~~~http
Ingest: OTLP/gRPC from collectors; HTTP bulk for legacy
Query:  GET /v1/logs/search?q=level:ERROR AND service:payment AND "timeout"&from=now-15m&limit=500
        GET /v1/metrics/query?expr=histogram_quantile(0.99, sum by (le, route)(rate(http_server_requests_seconds_bucket[5m])))
Alerts: POST /v1/alert-rules { expr, for, severity, routing }
~~~

## Step 4: Database design
- Logs: Loki (label index + compressed chunks in object storage: cheap, label-based search) or OpenSearch (full-text inverted index: powerful, more expensive) or ClickHouse (columnar, SQL). Partition by time and tenant.
- Metrics: Prometheus per cluster + long-term store (Mimir/Thanos/VictoriaMetrics) with object storage.
- Traces: Tempo/Jaeger with object storage.
- Metadata: tenants, quotas, alert rules in Postgres.

## Step 5: High-level architecture
~~~mermaid
flowchart LR
  P["Pods (stdout JSON)"] --> AG["Node agents (Fluent Bit / OTel collector): parse, enrich, buffer"]
  AG --> K{{"Kafka (per-tenant topics / partitions)"}}
  K --> ING["Ingesters / indexers"] --> HOT[("Hot store: Loki/OpenSearch")]
  HOT --> COLD[("Object storage: warm/cold")]
  PROM["Prometheus per cluster"] -->|remote write| LTS["Mimir / Thanos"]
  Q["Grafana / query API"] --> HOT & LTS
  RULES["Alert evaluator"] --> LTS
  RULES --> AM["Alertmanager -> PagerDuty / Slack"]
~~~

## Step 6: Detailed component design
- **Agents**: tail container logs, parse JSON, add Kubernetes metadata, batch, compress; bounded disk buffer; drop debug logs first under pressure; never block the application.
- **Kafka**: absorbs bursts, decouples indexing speed from ingestion; retention a few hours/days for replay.
- **Indexers**: consume per partition, build index segments by time; per-tenant rate limits.
- **Retention**: hot (days, SSD, indexed), warm/cold (object storage, slower queries), deletion per policy; compliance archives separate.
- **Alerting**: evaluate rules on metrics (preferred) and logs (for specific patterns), dedupe/group alerts, route by team.

## Step 7: Scalability
Horizontal ingesters scaled on Kafka lag; sharding by tenant/time; query fan-out across shards with limits; cardinality limits on metrics labels; sampling of traces and verbose logs.

## Step 8: Reliability
The platform's failure must not cascade: agents buffer and drop rather than block. Kafka replication. Ingesters idempotent by offset. Meta-monitoring (a separate small stack monitors the monitoring). Alert on ingestion lag.

## Step 9: Security
PII scrubbing at agents (mask tokens, emails, card numbers), per-tenant access control on queries, encryption, audit of log access, retention compliant with regulations.

## Step 10: Trade-offs
| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| Log store | Label index + object storage (Loki) | Full-text index everywhere | Cost at TB/day scale; full-text for a subset |
| Buffer | Kafka | Direct to store | Absorb spikes, replay |
| Metrics | Prometheus + long-term store | Logs-derived metrics | Efficient, standard ecosystem |

## Step 11: Interview follow-ups
?? Log volume triples during an incident and the cluster falls behind. What do you do?
Kafka absorbs; scale ingesters; temporarily drop DEBUG/INFO for noisy services via dynamic config; prioritise ERROR; alert on lag.
?? How do you control costs?
Per-team quotas and showback, sampling, shorter retention for low-value logs, metrics instead of logs for counts, cardinality limits.
?? Why not log everything at DEBUG in production?
Cost, noise, performance overhead and risk of leaking sensitive data; enable dynamically for a service temporarily.
?? How do you correlate logs with traces?
Include traceId/spanId in structured logs (MDC); query by traceId; Grafana links between traces and logs.
?? How do you detect a service that stopped logging?
Absence alerts on expected log/metric rates per service.
?? Where should alerting rules live?
In version control with code review, deployed by CI; owned by service teams; SLO-based burn-rate alerts preferred.
?? How do you handle multi-line stack traces?
Structured JSON logging puts the stack trace in one field; agents' multiline parsers for legacy text logs.
?? How do you protect against a service logging PII?
Agent-level redaction rules, logging library masking, scanning for PII patterns with alerts to the owning team.
?? Metrics cardinality explodes due to a new label. Impact and fix?
Memory and cost spike in TSDB, queries slow; enforce per-tenant series limits, reject the metric, and fix the instrumentation (move the id to logs/traces).
?? How do you make search fast over 30 days?
Time partitioning so queries scan only relevant chunks, label pre-filtering, bloom filters for terms, and parallel queriers.
` },

{ id: 'identity-platform', title: 'Identity & Authentication Platform', level: 'advanced', tags: ['iam', 'oauth', 'oidc', 'keycloak', 'cognito'], viz: 'oauth',
  summary: 'Central IdP for many apps and tenants: OIDC/OAuth2 flows, OTP/MFA, token issuance and validation, sessions, federation, revocation.',
  mock: { deep: 'Walk through login for a mobile app using your platform, including PKCE, OTP as a second factor, token issuance, and how APIs validate tokens without calling the IdP on every request.',
          keys: [['Authorization Code flow with PKCE (code_verifier/challenge)', 'pkce|code.?verifier|code.?challenge|authorization code'], ['OTP second factor with expiry, attempt limits, hashed storage', 'otp|second factor|mfa|attempt|expir'], ['Short-lived access token + refresh token rotation', 'refresh|rotation|short.?lived|access token'], ['Signed JWT validated locally via JWKS (kid, cache)', 'jwks|signature|public key|kid|locally'], ['Revocation strategy (short TTL, introspection, deny list)', 'revoc|introspect|deny.?list|blacklist'], ['Session at IdP / SSO cookie', 'session|sso|cookie']] },
  body: md`
## Step 1: Requirements gathering
### Functional
- Sign-up/sign-in for customers (phone OTP, email/password, social, UAE PASS / national ID federation) and employees (SSO with corporate IdP).
- OAuth 2.0 / OIDC for web, mobile, SPAs and machine clients; MFA (OTP, TOTP, passkeys); account recovery.
- Multi-tenant: many business units/tenants with branding and separate policies.
- Token revocation, session management, admin and audit.
### Non-functional
- Very high availability (auth outage = total outage); low latency for token validation.
- Security above all: brute force protection, credential stuffing defence, key rotation.
- Compliance: data residency, audit trails.
### Assumptions
- 20M users, 5M DAU; 2M logins/day; token validations ~ every API call (hundreds of thousands/s across services).

## Step 2: Capacity estimation
- Logins: 2M/day ≈ 23/s average, morning peaks ×10 ≈ 230/s; each login may send an OTP.
- Token refreshes: access token TTL 5-15 min → 5M DAU × active hours × 4-12 refreshes/hour → on the order of ~1k-5k/s at peak.
- Token validation: done **locally** by resource servers using cached JWKS: no IdP load per API call.
- Session storage: concurrent sessions (millions) × ~2 KB in a replicated cache/DB.

## Step 3: API design
~~~http
GET  /realms/{tenant}/protocol/openid-connect/auth?response_type=code&client_id=app&redirect_uri=...&scope=openid%20profile&code_challenge=...&code_challenge_method=S256&state=...&nonce=...
POST /realms/{tenant}/protocol/openid-connect/token   grant_type=authorization_code&code=...&code_verifier=...
POST /realms/{tenant}/protocol/openid-connect/token   grant_type=refresh_token&refresh_token=...
POST /realms/{tenant}/protocol/openid-connect/token   grant_type=client_credentials (machine clients, client auth via private_key_jwt / mTLS)
GET  /realms/{tenant}/protocol/openid-connect/certs   (JWKS)
POST /realms/{tenant}/protocol/openid-connect/revoke · /logout · /.well-known/openid-configuration
~~~

## Step 4: Database design
- Users, credentials (password hashes with Argon2/bcrypt/PBKDF2), MFA enrolments, clients, roles/groups: relational (Postgres), per-tenant partitioning.
- Sessions and short-lived state (auth codes, OTP challenges): distributed cache (Infinispan in Keycloak; Redis/DynamoDB for custom), replicated across AZs.
- Signing keys: KMS/HSM, rotated with overlapping validity (multiple kids in JWKS).
- Audit events: append-only, streamed to SIEM.

## Step 5: High-level architecture
~~~mermaid
flowchart LR
  MOB["Mobile app / SPA"] -->|"Auth Code + PKCE"| IDP["IdP cluster (Keycloak / Cognito) multi-AZ"]
  IDP --> UDB[("User store (Postgres)")]
  IDP --> SESS[("Session cache (replicated)")]
  IDP --> OTP["OTP service"] --> SMS["SMS / WhatsApp providers"]
  IDP --> FED["Federation: corporate AD (SAML/OIDC), Google, UAE PASS"]
  IDP --> KMS["Signing keys (KMS/HSM)"]
  MOB -->|"Bearer access token"| GW["API gateway (JWT validation via cached JWKS)"] --> SVC["Microservices (validate + authorize)"]
  IDP -->|"audit events"| SIEM["SIEM"]
~~~

## Step 6: Detailed component design
### Login with PKCE + OTP
1. App generates code_verifier, sends code_challenge in the authorize request (system browser / ASWebAuthenticationSession, not an embedded WebView).
2. User authenticates: phone number -> OTP challenge (6 digits, TTL ~ 3-5 min, max ~5 attempts, rate limited per phone/IP/device, OTP stored hashed) or password + OTP as second factor.
3. IdP creates SSO session, redirects with code; app exchanges code + code_verifier for tokens.
4. Tokens: access token (JWT, ~5-15 min, audience-scoped), refresh token (rotating, bound to client, sliding/absolute lifetimes), ID token (for the client only).
### Validation at APIs
Resource servers validate signature (cached JWKS, refresh on unknown kid), issuer, audience, expiry, and scopes; authorization uses roles/claims plus domain rules.
### Revocation
Short access token TTL; refresh token revocation on logout/password change; for immediate cut-off of sensitive operations use token introspection or a deny list of token ids/session ids checked at the gateway; back-channel logout to clients.
### Multi-tenancy
Realm per tenant (strong isolation, separate keys) for few large tenants, or organizations within a realm for many small tenants; tenant claim in tokens.
### Customisation
Keycloak custom authenticators (OTP via local SMS aggregator, risk-based step-up), event listeners (audit to Kafka), user storage SPI (legacy user DB); or Cognito Lambda triggers (pre sign-up, define/create/verify auth challenge for custom OTP, pre token generation for claims).

## Step 7: Scalability
IdP nodes stateless except for the distributed session cache; scale horizontally; database read replicas; JWT local validation keeps API traffic off the IdP; cache client and realm config.

## Step 8: Reliability
Multi-AZ cluster, cross-region DR (sessions may be lost on region failover: users re-login, tokens remain valid until expiry if keys replicated); OTP provider failover; graceful degradation (allow existing sessions/tokens when IdP is degraded); key rotation without downtime.

## Step 9: Security
Brute-force detection and lockouts with care (avoid easy account DoS), credential-stuffing defences (breached password checks, bot detection), MFA for risky actions (step-up via acr_values), secure cookies (HttpOnly, Secure, SameSite), strict redirect URI matching, PKCE everywhere, sender-constrained tokens (DPoP/mTLS) for high-value APIs, audit everything.

## Step 10: Trade-offs
| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| Token format | JWT access tokens | Opaque + introspection | Local validation scales; revocation latency trade-off |
| Platform | Keycloak (self-hosted) | Cognito (managed) | Flexibility/SPIs/on-prem residency vs zero ops and AWS integration |
| Tenancy | Realm per large tenant, orgs for small | One realm | Isolation vs operational overhead of many realms |

## Step 11: Interview follow-ups
?? A user's phone is stolen. How do you revoke access quickly?
Revoke all sessions and refresh tokens for the user (admin API), add session ids to a gateway deny list until access tokens expire, force re-authentication with step-up, notify the user.
?? Why not use long-lived JWT access tokens to reduce refresh load?
Revocation is hard for self-contained tokens; short TTL bounds the damage window. Refresh traffic is cheap compared with the risk.
?? How do you rotate signing keys without breaking clients?
Publish the new key in JWKS ahead of use, start signing with it, keep the old key in JWKS until all tokens it signed expire, then remove.
?? How do you stop OTP SMS pumping fraud?
Per-phone/IP/device rate limits, block premium/unused country prefixes, CAPTCHA/attestation (Play Integrity/App Attest), anomaly alerts on spend, prefer WhatsApp/push where possible.
?? How would you migrate users from a legacy DB into Keycloak without forcing password resets?
User Storage SPI federation or a custom provider that verifies against the legacy hash on first login, then migrates the credential (lazy migration).
?? How do services call each other securely?
Client credentials grant with per-service clients, audience-restricted tokens, mTLS in the mesh; token exchange to act on behalf of a user when needed.
?? Where should authorization decisions live: IdP or services?
Coarse-grained (roles/scopes) in tokens; fine-grained, data-dependent decisions in services or a policy engine (OPA), because the IdP lacks domain context.
?? How do you implement SSO across 10 apps?
OIDC with a shared IdP session cookie; each app is a client; logout via RP-initiated logout plus back-channel logout notifications.
?? What breaks if the IdP is down for 10 minutes?
New logins and refreshes fail; existing access tokens keep working until expiry; design apps to retry refresh with backoff and show a clear message.
?? Cognito or Keycloak for a bank in the UAE?
Depends on residency (in-country region availability), customisation needs (custom flows/SPIs), operational capacity, and integration with UAE PASS. Present the trade-off rather than a brand preference.
` }
]);
})();
