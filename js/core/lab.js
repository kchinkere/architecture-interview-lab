/* Global namespace + content registry.
 * Content files call LAB.add(moduleId, sectionTitle, [topics]) and LAB.addQuestions([...]).
 * Topic shape: { id, title, summary, level, tags[], body (markdown), viz?, followups?: [[q,a],...], rubric? }
 * Markdown conventions (content is authored in String.raw templates):
 *   ~~~lang fences for code, {{inline code}}, \${ for a literal ${ inside code.
 */
window.LAB = {
  md: String.raw,
  modules: [
    { id: 'lld',  title: 'Low-Level Design',        icon: '▦', blurb: 'OOP, SOLID, 13 GoF patterns, clean architecture, DDD, concurrency and 15 full LLD problems with Java implementations.' },
    { id: 'hld',  title: 'High-Level Design',       icon: '⬡', blurb: '30 distributed-systems building blocks: when to use them, when not to, failure modes and Spring Boot examples.' },
    { id: 'sd',   title: 'System Design Problems',  icon: '◎', blurb: '20 end-to-end interview walkthroughs following the 11-step structure, with estimation maths and follow-ups.' },
    { id: 'java', title: 'Java & Spring Boot',      icon: '☕', blurb: 'JVM, GC, JMM, concurrency, Spring internals, JPA/Hibernate, transactions, microservices and testing.' },
    { id: 'iam',  title: 'Identity & Access',       icon: '🔐', blurb: 'OAuth 2.0, OIDC, SAML, JWT, PKCE, Keycloak SPIs, Cognito + Lambda triggers, OTP, RBAC/ABAC, multi-tenant IAM.' }
  ],
  sections: {},   // moduleId -> [{title, topics:[]}]
  topics: {},     // "module:id" -> topic
  questions: [],
  viz: {},        // id -> {title, desc, create(el)}
  add(mod, section, topics) {
    const list = (this.sections[mod] = this.sections[mod] || []);
    let sec = list.find(s => s.title === section);
    if (!sec) { sec = { title: section, topics: [] }; list.push(sec); }
    topics.forEach(t => {
      t.module = mod; t.key = mod + ':' + t.id; t.section = section;
      t.tags = t.tags || []; t.level = t.level || 'intermediate';
      sec.topics.push(t); this.topics[t.key] = t;
    });
  },
  addQuestions(qs) { qs.forEach(q => { q.level = q.level || 'intermediate'; q.type = q.type || 'direct'; this.questions.push(q); }); },
  topicsOf(mod) { return (this.sections[mod] || []).flatMap(s => s.topics); },
  allTopics() { return this.modules.flatMap(m => this.topicsOf(m.id)); },
  esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
};
