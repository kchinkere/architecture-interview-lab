/* Minimal, dependency-free Markdown renderer + syntax highlighter tuned for this content. */
(function () {
  const esc = s => LAB.esc(s);

  const KW = {
    java: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record sealed permits yield null true false',
    sql: 'select from where insert into values update set delete create table index primary key foreign references unique not null on join left right inner outer group by order having limit offset as and or in is begin commit rollback transaction partition range hash for share nowait skip locked default constraint check text varchar bigint int integer timestamp timestamptz boolean numeric decimal uuid serial bigserial jsonb exists returning conflict do nothing with cascade asc desc using gin btree',
    js: 'const let var function return if else for while new class extends import export from await async true false null undefined this typeof',
    yaml: 'true false null',
    bash: 'curl echo export cd ls docker kubectl java mvn gradle python3 npx',
    http: 'GET POST PUT PATCH DELETE HTTP Host Authorization Content-Type Location Cookie Set-Cookie'
  };
  const kwSets = {};
  Object.keys(KW).forEach(k => kwSets[k] = new Set(KW[k].split(' ')));
  kwSets.kotlin = kwSets.java; kwSets.json = new Set(['true', 'false', 'null']);

  function highlight(code, lang) {
    lang = (lang || '').toLowerCase();
    if (lang === 'text' || lang === 'txt' || lang === '') return esc(code);
    const set = kwSets[lang] || kwSets.java;
    const ci = lang === 'sql';
    const comment = (lang === 'yaml' || lang === 'bash' || lang === 'properties') ? '#.*$' : lang === 'sql' ? '--.*$' : '\\/\\/.*$|\\/\\*[\\s\\S]*?\\*\\/';
    const re = new RegExp('(' + comment + ')|("(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\')|(@[A-Za-z_][\\w.]*)|\\b(\\d[\\d_]*(?:\\.\\d+)?[LlFfDd]?)\\b|\\b([A-Za-z_][\\w-]*)\\b', 'gm');
    let out = '', last = 0, m;
    while ((m = re.exec(code))) {
      out += esc(code.slice(last, m.index));
      const t = m[0];
      if (m[1]) out += '<span class="k-com">' + esc(t) + '</span>';
      else if (m[2]) out += '<span class="k-str">' + esc(t) + '</span>';
      else if (m[3]) out += (lang === 'java' || lang === 'kotlin' || !lang) ? '<span class="k-ann">' + esc(t) + '</span>' : esc(t);
      else if (m[4]) out += '<span class="k-num">' + esc(t) + '</span>';
      else if (m[5]) {
        const w = ci ? t.toLowerCase() : t;
        if (set.has(w)) out += '<span class="k-kw">' + esc(t) + '</span>';
        else if ((lang === 'java' || lang === 'kotlin') && /^[A-Z][A-Za-z0-9_]*$/.test(t) && /[a-z]/.test(t)) out += '<span class="k-type">' + esc(t) + '</span>';
        else if (lang === 'yaml' && /^\s*$/.test(code.slice(code.lastIndexOf('\n', m.index - 1) + 1, m.index)) && code[m.index + t.length] === ':') out += '<span class="k-kw">' + esc(t) + '</span>';
        else out += esc(t);
      }
      last = m.index + t.length;
    }
    return out + esc(code.slice(last));
  }

  function inline(s) {
    const codes = [];
    const stash = c => { codes.push('<code class="i">' + esc(c) + '</code>'); return '\u0000' + (codes.length - 1) + '\u0000'; };
    s = s.replace(/\{\{([\s\S]+?)\}\}/g, (_, c) => stash(c)).replace(/`([^`]+)`/g, (_, c) => stash(c));
    s = esc(s);
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
         .replace(/(^|[\s(])_(.+?)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
         .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => '<a href="' + u + '"' + (/^https?:/.test(u) ? ' target="_blank" rel="noopener"' : '') + '>' + t + '</a>')
         .replace(/ -&gt; /g, ' → ').replace(/ &lt;-&gt; /g, ' ↔ ');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i]);
  }

  const slug = s => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

  function render(src) {
    src = String(src || '').replace(/\\\$\{/g, '${').replace(/\r/g, '');
    // strip common indentation
    const rawLines = src.split('\n');
    const ind = Math.min(...rawLines.filter(l => l.trim()).map(l => l.match(/^ */)[0].length));
    const lines = rawLines.map(l => l.slice(isFinite(ind) ? ind : 0));
    let html = '', i = 0; const used = {};
    const isBlockStart = l => /^(~~~|```|#{1,4}\s|\s*([-*]|\d+\.)\s|>|\||<\/?(details|summary|div)|---\s*$|\?\?)/.test(l);

    while (i < lines.length) {
      let line = lines[i];
      if (!line.trim()) { i++; continue; }

      let f = line.match(/^(~~~|```)\s*([\w+-]*)/);
      if (f) {
        const fence = f[1], lang = f[2]; const buf = []; i++;
        while (i < lines.length && !lines[i].startsWith(fence)) buf.push(lines[i++]);
        i++;
        const code = buf.join('\n');
        if (lang === 'mermaid') html += '<div class="mermaid-wrap"><pre class="mermaid">' + esc(code) + '</pre></div>';
        else html += '<pre class="code"><div class="code-head"><span>' + (lang || 'text') + '</span><button data-copy>Copy</button></div><code>' + highlight(code, lang) + '</code></pre>';
        continue;
      }
      let h = line.match(/^(#{1,4})\s+(.*)/);
      if (h) {
        let id = slug(h[2]); if (used[id]) id += '-' + (++used[id]); else used[id] = 1;
        html += '<h' + h[1].length + ' id="' + id + '">' + inline(h[2]) + '</h' + h[1].length + '>'; i++; continue;
      }
      // Q&A reveal: "?? question" ... until next "??" or "??/"
      if (line.startsWith('??')) {
        if (line.startsWith('??/')) { i++; continue; }
        const q = line.slice(2).trim(); const buf = []; i++;
        while (i < lines.length && !lines[i].startsWith('??') && !/^#{1,3}\s/.test(lines[i])) buf.push(lines[i++]);
        html += '<details class="qa"><summary>' + inline(q) + '</summary><div class="qa-body">' + render(buf.join('\n')) + '</div></details>';
        continue;
      }
      if (/^<\/?(details|summary|div)/.test(line)) { html += line; i++; continue; }
      if (/^---\s*$/.test(line)) { html += '<hr>'; i++; continue; }
      if (line.startsWith('|') && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const row = l => l.replace(/^\||\|\s*$/g, '').split(/(?<!\\)\|/).map(c => inline(c.trim().replace(/\\\|/g, '|')));
        const head = row(line); i += 2; let body = '';
        while (i < lines.length && lines[i].startsWith('|')) { body += '<tr>' + row(lines[i]).map(c => '<td>' + c + '</td>').join('') + '</tr>'; i++; }
        html += '<table><thead><tr>' + head.map(c => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>' + body + '</tbody></table>';
        continue;
      }
      if (line.startsWith('>')) {
        const buf = [];
        while (i < lines.length && lines[i].startsWith('>')) buf.push(lines[i++].replace(/^>\s?/, ''));
        const first = buf[0] || ''; let cls = '';
        if (/^\*\*(Warning|Pitfall|Mistake|Avoid|Danger)/i.test(first)) cls = 'warn';
        else if (/^\*\*(Wrong|Incorrect)/i.test(first)) cls = 'bad';
        else if (/^\*\*(Interview tip|Tip|Good answer|Production)/i.test(first)) cls = 'ok';
        html += '<blockquote class="' + cls + '">' + render(buf.join('\n')) + '</blockquote>';
        continue;
      }
      if (/^\s*([-*]|\d+\.)\s/.test(line)) {
        // nested list parsing by indentation
        const items = [];
        while (i < lines.length && (/^\s*([-*]|\d+\.)\s/.test(lines[i]) || (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length))) {
          const l = lines[i]; const m2 = l.match(/^(\s*)([-*]|\d+\.)\s+(.*)/);
          if (m2) items.push({ ind: m2[1].length, ord: /\d/.test(m2[2]), text: m2[3] });
          else items[items.length - 1].text += ' ' + l.trim();
          i++;
        }
        html += buildList(items);
        continue;
      }
      // paragraph
      const buf = [line]; i++;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++]);
      html += '<p>' + inline(buf.join(' ')) + '</p>';
    }
    return html;
  }

  function buildList(items) {
    let html = '', stack = [];
    items.forEach((it, idx) => {
      while (stack.length && it.ind < stack[stack.length - 1].ind) { html += '</li></' + stack.pop().tag + '>'; }
      if (!stack.length || it.ind > stack[stack.length - 1].ind) {
        const tag = it.ord ? 'ol' : 'ul'; stack.push({ ind: it.ind, tag }); html += '<' + tag + '><li>';
      } else html += '</li><li>';
      html += inline(it.text);
    });
    while (stack.length) html += '</li></' + stack.pop().tag + '>';
    return html;
  }

  LAB.render = render;
  LAB.highlight = highlight;
  LAB.slug = slug;
  LAB.plain = src => String(src || '').replace(/~~~[\s\S]*?~~~/g, ' ').replace(/[#*>|{}`_\-]/g, ' ').replace(/\s+/g, ' ');
})();
