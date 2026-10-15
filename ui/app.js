/* Financials Auditor UI. Vanilla JS, no build. Data comes from `node run.js serve`:
 *   /api/runs                      the audit runs under audit-output/
 *   /data/<db>/<run>/index.json    one row per statement (what summary.csv holds, plus the report path)
 *   /data/<db>/<run>/<report>.json the audit, its line findings and the statement view for one statement
 */
(() => {
  const app = document.getElementById('app');
  const runSelect = document.getElementById('run-select');
  const navStats = document.getElementById('nav-stats');
  const state = {
    runs: [], run: null, meta: null, rows: [],
    filter: 'all', query: '',
    tab: 0, problemsOnly: false, showPath: false, showUnused: false, checkFilter: null, hl: null,
  };

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => v == null || v === '' ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const icon = (name, cls) => `<span class="ms-icon ${cls || ''}">${name}</span>`;
  const pill = s => `<span class="pill ${s === 'pass' ? 'pass' : 'fail'}">${s === 'pass' ? 'Pass' : 'Fail'}</span>`;
  const lc = v => String(v || '').toLowerCase();
  const get = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };
  const reportHash = r => `#/${state.run}/s/${encodeURIComponent(r.report.replace(/\.md$/, ''))}`;

  /* ---------- runs ---------- */
  async function loadRuns() {
    state.runs = await get('/api/runs');
    runSelect.innerHTML = state.runs.map(r =>
      `<option value="${esc(r.path)}">${esc(r.db)} / ${esc(r.run)}</option>`).join('');
    runSelect.onchange = () => { location.hash = `#/${runSelect.value}`; };
  }

  async function route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (!state.runs.length) { app.innerHTML = '<p class="muted pad">No audit runs found under audit-output/. Run <code>node run.js audit</code> first.</p>'; return; }
    const runPath = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : state.runs[0].path;
    const meta = state.runs.find(r => r.path === runPath);
    if (!meta) { location.hash = `#/${state.runs[0].path}`; return; }
    runSelect.value = runPath;
    if (state.run !== runPath) {
      state.run = runPath; state.meta = meta;
      state.rows = await get(`/data/${runPath}/index.json`);
      navStats.innerHTML = `<span>${meta.audited} audited</span><span>${meta.pass} pass</span><span>${meta.fail} fail</span>`;
    }
    const detail = parts[2] === 's' ? decodeURIComponent(parts.slice(3).join('/')) : null;
    if (detail) await renderDetail(detail); else renderList();
  }

  /* ---------- list ---------- */
  function renderList() {
    const q = state.query.trim().toLowerCase();
    const rows = state.rows
      .filter(r => (state.filter === 'all' || r.status === state.filter) &&
        (!q || [r.client_name, r.obligor_key, r.description, r.statement_id, r.period, r.creator, r.account_type].some(v => lc(v).includes(q))))
      .sort((a, b) => (a.status === 'fail' ? 0 : 1) - (b.status === 'fail' ? 0 : 1) || lc(a.client_name).localeCompare(lc(b.client_name)) || lc(a.period).localeCompare(lc(b.period)));
    const m = state.meta;
    app.innerHTML = `
      <div class="page">
        <div class="page-head">
          <div><h1>Statements</h1><div class="sub">Run ${esc(m.db)} / ${esc(m.run)}${m.finished ? ` · ${esc(String(m.finished).slice(0, 16).replace('T', ' '))}` : ''}</div></div>
          <div class="tiles">
            <div class="tile"><div class="k">Audited</div><div class="v">${m.audited}</div></div>
            <div class="tile"><div class="k">Pass</div><div class="v pass">${m.pass}</div></div>
            <div class="tile"><div class="k">Fail</div><div class="v fail">${m.fail}</div></div>
          </div>
        </div>
        <div class="card">
          <div class="toolbar">
            <label class="search">${icon('search')}<input id="q" type="search" placeholder="Search client, obligor key, description, creator, id" value="${esc(state.query)}"></label>
            <div class="seg" id="f">
              ${[['all', 'All'], ['fail', 'Failing'], ['pass', 'Passing']].map(([k, l]) => `<button data-f="${k}" class="${state.filter === k ? 'on' : ''}">${l}</button>`).join('')}
            </div>
          </div>
          <div class="scroll">
            <table class="list-table">
              <thead><tr><th>Client</th><th>Period</th><th>Ver.</th><th>Accounts</th><th>Obligor</th><th>Created by</th><th>Status</th><th>Failing checks</th></tr></thead>
              <tbody>${rows.map(r => `<tr data-href="${esc(reportHash(r))}">
                <td><div class="name">${esc(r.client_name || r.client_id)}</div><div class="type">${esc(r.company_type)}</div></td>
                <td class="tnum">${esc(r.period)}</td>
                <td>v${esc(r.version)}</td>
                <td>${esc(r.account_type || '')}</td>
                <td class="tnum">${esc(r.obligor_key || '')}</td>
                <td><div>${esc(r.creator || '')}</div><div class="type">${esc(r.date_created || '')}</div></td>
                <td>${pill(r.status)}</td>
                <td class="fails">${esc(r.failed_checks || '')}${r.error ? ` · audit error: ${esc(r.error)}` : ''}</td>
              </tr>`).join('') || '<tr><td colspan="8" class="empty">Nothing matches.</td></tr>'}</tbody>
            </table>
          </div>
          <div class="foot">Showing ${rows.length} of ${state.rows.length} statements</div>
        </div>
      </div>`;
    const qEl = document.getElementById('q');
    qEl.oninput = () => { state.query = qEl.value; renderList(); const e = document.getElementById('q'); e.focus(); e.setSelectionRange(e.value.length, e.value.length); };
    document.getElementById('f').onclick = e => { const b = e.target.closest('button'); if (b) { state.filter = b.dataset.f; renderList(); } };
    app.querySelectorAll('tr[data-href]').forEach(tr => { tr.onclick = () => { location.hash = tr.dataset.href; }; });
  }

  /* ---------- detail ---------- */
  let current = null; // { report, audit, view, rows: [{row, kind, hits, ...}] per statement }

  async function renderDetail(report) {
    if (!current || current.report !== report) {
      app.innerHTML = '<p class="muted pad">Loading statement…</p>';
      let data;
      try { data = await get(`/data/${state.run}/${report}.json`); }
      catch (e) { app.innerHTML = `<div class="page"><a class="back" href="#/${esc(state.run)}">${icon('arrow_back')}All statements</a><p class="muted">Could not load ${esc(report)}.json (${esc(e.message)}). Re-run the audit to produce statement JSON.</p></div>`; return; }
      current = { report, audit: data.audit, view: data.view, findings: data.audit.line_findings || [] };
      state.tab = 0; state.checkFilter = null; state.hl = null; state.problemsOnly = false;
    }
    const { audit, view } = current;
    const h = audit.header;
    const later = state.rows.find(r => lc(r.client_id) === lc(h.client_id) && r.period === h.period && Number(r.version) > Number(h.version) && r.status === 'pass');
    const counts = { fail: 0, pass: 0, advice: 0, error: 0, skipped: 0 };
    audit.checks.forEach(c => counts[c.status]++);

    app.innerHTML = `
      <div class="page">
        <div style="display:flex;flex-direction:column;gap:10px">
          <a class="back" href="#/${esc(state.run)}">${icon('arrow_back')}All statements</a>
          <div class="title-row">
            <div class="l"><h1>${esc(h.client_name || h.client_id)}</h1>${pill(audit.status)}</div>
            <a class="btn" href="/data/${esc(state.run)}/${esc(report)}.md" target="_blank">${icon('description')}Markdown report</a>
          </div>
          <div class="muted" style="font-size:14px">${esc(h.description)}</div>
        </div>

        <div class="card facts">
          <div><div class="k">Period</div><div class="v">${esc(h.period)}</div></div>
          <div><div class="k">Prior period</div><div class="v">${esc(h.previous_period || '—')}</div></div>
          <div><div class="k">Version</div><div class="v">v${esc(h.version)}</div></div>
          <div><div class="k">Company type</div><div class="v">${esc(h.company_type)}</div></div>
          <div><div class="k">Accounts</div><div class="v">${esc(h.account_type || '—')}</div></div>
          <div><div class="k">Obligor key</div><div class="v">${esc(h.obligor_key || '—')}</div></div>
          <div><div class="k">Lines</div><div class="v">${esc(h.line_count)}</div></div>
          <div class="wide"><div class="k">Created by</div><div class="v">${esc(h.creator || 'unknown')}${h.created_by_xero ? ' <span class="muted">(via Xero)</span>' : ''} <span class="muted">on ${esc(h.date_created || '?')}</span></div></div>
          <div class="wide"><div class="k">Published on</div><div class="v">${esc(h.publish_date)} <span class="muted" title="financial_statement has no published_by column and no history table">· publisher not recorded</span></div></div>
          <div class="wide"><div class="k">Statement id</div><div class="v"><code>${esc(h.id)}</code></div></div>
        </div>

        ${audit.error ? `<div class="banner">${icon('error')}<span>Audit error: ${esc(audit.error)}</span></div>` : ''}
        ${later ? `<div class="banner">${icon('info')}<span>A later version of this statement (v${esc(later.version)}, ${esc(later.period)}) passes all checks.</span><a href="${esc(reportHash(later))}">Open v${esc(later.version)}</a></div>` : ''}

        <div class="split">
          <div class="card checks" id="checks">
            <div class="card-head"><span>Checks</span><span class="meta">${[counts.fail && `${counts.fail} fail`, counts.error && `${counts.error} error`, counts.advice && `${counts.advice} advisory`, counts.pass && `${counts.pass} pass`, counts.skipped && `${counts.skipped} skipped`].filter(Boolean).join(' · ')}</span></div>
            <div class="bar">${[['f', counts.fail + counts.error], ['a', counts.advice], ['p', counts.pass], ['s', counts.skipped]].filter(([, n]) => n).map(([c, n]) => `<div class="${c}" style="flex:${n}"></div>`).join('')}</div>
            ${audit.checks.map((c, i) => checkRow(c, i)).join('')}
          </div>
          <div class="issues" id="issues">${renderIssues()}</div>
        </div>

        <div id="stmts">${view ? renderStatements() : '<p class="muted">No statement view in this run. Re-run the audit to produce it.</p>'}</div>
      </div>`;
    wireDetail(report);
  }

  function checkRow(c, i) {
    const m = { fail: ['cancel', 'v fail'], error: ['error', 'v fail'], advice: ['warning', 'v amber'], pass: ['check_circle', 'v ok'], skipped: ['do_not_disturb_on', 'v dim'] }[c.status];
    const clickable = c.status !== 'pass' && c.status !== 'skipped';
    const note = c.status === 'pass' ? (c.details[0] || 'Passed') : c.status === 'skipped' ? c.details[0] : `${c.details.length} finding${c.details.length === 1 ? '' : 's'}`;
    return `<div class="check ${clickable ? 'click' : ''} ${state.checkFilter === i ? 'on' : ''}" data-check="${i}">
      ${icon(m[0], m[1])}<div style="min-width:0"><div class="n">${esc(c.label)}</div><div class="note">${esc(note)}</div></div>
      <span class="c ${m[1]}">${clickable ? c.details.length : ''}</span></div>`;
  }

  function renderIssues() {
    const { audit } = current;
    const attention = audit.checks.map((c, i) => ({ c, i })).filter(({ c }) => c.status === 'fail' || c.status === 'error' || c.status === 'advice');
    const shown = state.checkFilter == null ? attention : attention.filter(({ i }) => i === state.checkFilter);
    const findingsTotal = attention.reduce((n, { c }) => n + c.details.length, 0);
    const title = attention.length === 0 ? 'All checks pass' : `${attention.length} check${attention.length === 1 ? '' : 's'} need attention · ${findingsTotal} finding${findingsTotal === 1 ? '' : 's'}`;
    return `
      <div class="issues-head"><div><h2>${esc(title)}</h2><div class="sub">Recommendations only. Nothing has been applied.</div></div></div>
      ${state.checkFilter != null ? `<div class="filtered"><span>Filtered to</span><b>${esc(audit.checks[state.checkFilter].label)}</b><a href="#" data-clear>Clear</a></div>` : ''}
      ${shown.length === 0 ? '<div class="card"><div class="empty">Nothing to fix on this statement.</div></div>' : shown.map(({ c, i }) => `
        <div class="card">
          <div class="card-head"><span><span class="tag ${c.status === 'advice' ? 'advice' : 'fail'}">${c.status === 'advice' ? 'Advisory' : c.status === 'error' ? 'Error' : 'Fail'}</span>&nbsp; ${esc(c.label)}</span><span class="meta">${c.details.length} finding${c.details.length === 1 ? '' : 's'}</span></div>
          <div class="issue-grid">
            <div><div class="k">Findings</div>${c.details.map(d => { const t = rowForMessage(d); return `<div class="i ${t ? 'link' : ''}" ${t ? `data-goto="${t.tab}:${t.idx}" title="Show in ${esc(current.view.statements[t.tab].type)}"` : ''}>${esc(d)}${t ? ` ${icon('arrow_downward', '')}` : ''}</div>`; }).join('')}</div>
            <div><div class="k">Recommended fixes</div>${c.recommendations.length ? c.recommendations.map(r => `<div class="i">${esc(r)}</div>`).join('') : '<div class="i muted">—</div>'}</div>
          </div>
        </div>`).join('')}`;
  }

  /* ---------- statements ---------- */
  function findingsFor(row, statementType) {
    const sameType = f => !f.statement_type || lc(f.statement_type) === lc(statementType);
    return current.findings.filter(f => {
      if (row.kind === 'note') return false;
      if (row.kind === 'heading' || row.kind === 'nomap') return !!f.line_id && row.line_id && lc(f.line_id) === lc(row.line_id);
      if (f.line_id) return row.line_id && lc(f.line_id) === lc(row.line_id);
      if (f.mapping_id) return row.mapping_id && lc(f.mapping_id) === lc(row.mapping_id) && sameType(f);
      return row.kind !== 'node' && f.description && lc(f.description) === lc(row.line) && sameType(f);
    });
  }

  /* Each statement's rows decorated with their findings and a display kind. Computed once per statement. */
  function decorate() {
    if (current.decorated) return current.decorated;
    current.decorated = current.view.statements.map(s => s.rows.map(r => {
      const hits = findingsFor(r, s.type);
      const fail = hits.filter(h => h.severity === 'fail');
      let kind;
      if (r.kind === 'note') kind = 'note';
      else if (r.kind === 'heading') kind = fail.length ? 'fail' : 'heading';
      else if (r.kind === 'nomap') kind = fail.length ? 'fail' : 'nomap';
      else if (r.kind === 'unmapped') kind = 'unmapped';
      else if (r.kind === 'node') kind = fail.length ? 'missing' : hits.length ? 'advisory' : 'notcaptured';
      else if (r.has_children) kind = fail.length ? 'fail' : hits.length ? 'advisory' : 'ok';
      else kind = fail.length ? 'fail' : hits.length ? 'advisory' : 'line';
      return { r, hits, kind };
    }));
    return current.decorated;
  }

  function labelFor(h) {
    const m = h.message || '';
    if (/captured lines total/i.test(m) || /assets total .* equity/i.test(m) || h.check === 'Balance Sheet Equality') return 'Does not balance';
    if (/no captured total/i.test(m)) return 'Missing total';
    if (/is unmapped/i.test(m) || h.check === 'Chart of Accounts Mapping') return 'Unmapped';
    if (/must be (positive|negative)/i.test(m) || h.check === 'Mapping Cardinality') return 'Wrong sign';
    if (h.check === 'No Blank Values') return 'Placeholder';
    if (h.severity === 'advice') return 'Advisory';
    return h.check;
  }

  const PROBLEM = new Set(['fail', 'missing', 'nomap', 'advisory', 'unmapped']);

  function rowForMessage(message) {
    const d = decorate();
    for (let t = 0; t < d.length; t++) {
      const idx = d[t].findIndex(x => x.hits.some(h => h.message === message));
      if (idx >= 0) return { tab: t, idx };
    }
    return null;
  }

  function renderStatements() {
    const { view } = current;
    const d = decorate();
    const tab = Math.min(state.tab, view.statements.length - 1);
    const s = view.statements[tab];
    const periods = view.periods;
    const rows = d[tab];
    const unused = rows.filter(x => x.r.kind === 'node' && !x.r.used).length;

    const V = {
      fail: ['error', 'fail'], missing: ['error', 'fail'], unmapped: ['link_off', 'fail'], ok: ['check', 'ok'],
      nomap: ['link_off', 'amber'], advisory: ['warning', 'amber'], notcaptured: ['remove', 'dim'], heading: ['title', 'dim'], line: ['', ''], note: ['', ''],
    };
    const vText = x => {
      if (x.kind === 'ok') return 'Balances';
      if (x.kind === 'notcaptured') return 'Not captured';
      if (x.kind === 'heading') return 'Heading';
      if (x.kind === 'nomap') return 'No map';
      if (x.kind === 'unmapped') return x.hits.length ? labelFor(x.hits[0]) : 'Unmapped';
      if (x.kind === 'missing') return 'Missing total';
      if (x.hits.length) return [...new Set(x.hits.map(labelFor))].join(', ');
      return '';
    };
    const subFor = (x, p) => {
      // The sum of the captured child lines, from the gate's fault for this period.
      const f = x.hits.find(h => h.expected != null && h.period && (h.period === p || h.period.slice(0, 4) === p.slice(0, 4)) && /captured lines total|no captured total/i.test(h.message));
      return f ? `lines ${num(f.expected)}` : '';
    };

    const body = rows.map((x, idx) => {
      const r = x.r;
      if (r.kind === 'node' && !r.used && !state.showUnused) return '';
      if (state.problemsOnly && !PROBLEM.has(x.kind)) return '';
      const total = r.has_children || r.depth === 0 && r.kind !== 'heading' && r.kind !== 'nomap' && r.kind !== 'unmapped';
      const label = r.kind === 'heading' ? '' : r.kind === 'unmapped' ? (r.hint ? `${r.hint} (not in this statement)` : 'No mapping') : r.hint;
      const crumb = state.showPath && r.hint_path && r.hint_path.includes(' > ') ? r.hint_path.split(' > ').slice(0, -1).join(' › ') : '';
      const v = V[x.kind];
      const title = x.hits.map(h => `${h.check}: ${h.message}`).join('\n');
      return `<tr id="row-${tab}-${idx}" class="k-${x.kind} ${state.hl === `${tab}:${idx}` ? 'hl' : ''}">
        <td style="padding-left:${12 + r.depth * 20}px">${crumb ? `<div class="crumb">${esc(crumb)}</div>` : ''}<span class="lab ${total ? 'total' : ''} ${r.kind === 'nomap' || r.kind === 'unmapped' ? 'dim' : ''}">${esc(label)}</span>${r.sign ? `<span class="sign">${r.sign === 'positive' ? '≥ 0' : '≤ 0'}</span>` : ''}</td>
        <td style="font-weight:${r.kind === 'heading' ? 700 : 500}">${esc(r.line)}</td>
        ${periods.map(p => `<td class="num tnum"><div style="font-weight:${total ? 700 : 500}">${x.kind === 'missing' ? '—' : num(r.values[p])}</div>${subFor(x, p) ? `<div class="sub">${esc(subFor(x, p))}</div>` : ''}</td>`).join('')}
        <td>${v[0] ? `<div class="v ${v[1]}" title="${esc(title)}">${icon(v[0])}<span>${esc(vText(x))}</span></div>` : ''}</td>
      </tr>`;
    }).join('');

    return `
      <div class="stmts-head">
        <h2>Statements</h2>
        <div class="options">
          <label><input type="checkbox" id="opt-problems" ${state.problemsOnly ? 'checked' : ''}>Problems only</label>
          <label><input type="checkbox" id="opt-path" ${state.showPath ? 'checked' : ''}>Show mapping path</label>
          <label><input type="checkbox" id="opt-unused" ${state.showUnused ? 'checked' : ''}>Unused mappings (${unused})</label>
        </div>
      </div>
      <div class="tabs">${view.statements.map((st, t) => {
        const prob = d[t].filter(x => PROBLEM.has(x.kind)).length;
        const lines = d[t].filter(x => x.r.kind !== 'node' && x.r.kind !== 'note').length;
        return `<button class="tab ${t === tab ? 'on' : ''}" data-tab="${t}"><span>${esc(st.type)}</span><span class="n">${lines} lines</span>${prob ? `<span class="prob">${prob}</span>` : ''}</button>`;
      }).join('')}</div>
      <div class="card stmt-card scroll">
        <table class="stmt-table">
          <thead><tr><th>Mapping</th><th>Line text</th>${periods.map(p => `<th class="num">${esc(p)}</th>`).join('')}<th class="val">Validation</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
        ${!body.trim() ? '<div class="empty">No problems in this statement</div>' : ''}
      </div>
      <div class="legend"><span>Red figures under a value are the sum of its captured child lines.</span><span>Totals and subtotals are coloured by their own check; detail lines are plain.</span></div>`;
  }

  function wireDetail(report) {
    const rerender = () => renderDetail(report);
    app.querySelectorAll('.check.click').forEach(el => { el.onclick = () => { const i = Number(el.dataset.check); state.checkFilter = state.checkFilter === i ? null : i; rerender(); }; });
    const clear = app.querySelector('[data-clear]'); if (clear) clear.onclick = e => { e.preventDefault(); state.checkFilter = null; rerender(); };
    app.querySelectorAll('[data-goto]').forEach(el => { el.onclick = () => { const [t, i] = el.dataset.goto.split(':').map(Number); state.tab = t; state.hl = `${t}:${i}`; state.problemsOnly = false; rerender().then(() => { const row = document.getElementById(`row-${t}-${i}`); if (row) window.scrollTo({ top: row.getBoundingClientRect().top + window.scrollY - 140, behavior: 'smooth' }); }); }; });
    app.querySelectorAll('.tab').forEach(el => { el.onclick = () => { state.tab = Number(el.dataset.tab); state.hl = null; rerender(); }; });
    const opt = (id, key) => { const el = document.getElementById(id); if (el) el.onchange = () => { state[key] = el.checked; rerender(); }; };
    opt('opt-problems', 'problemsOnly'); opt('opt-path', 'showPath'); opt('opt-unused', 'showUnused');
  }

  window.addEventListener('hashchange', () => route().catch(err => { app.innerHTML = `<p class="muted pad">${esc(err.message)}</p>`; }));
  loadRuns().then(route).catch(err => { app.innerHTML = `<p class="muted pad">${esc(err.message)}</p>`; });
})();
