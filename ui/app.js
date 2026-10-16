/* Financials Auditor UI. Vanilla JS, no build. Data comes from `node run.js serve`:
 *   /api/config                          { readOnly, defaultFilter } — read-only deployments hide editing and drafts
 *   /api/runs                            the audit runs under audit-output/
 *   /api/drafts/<db>/<run>               the statements of a run that have a saved draft
 *   /data/<db>/<run>/index.json          one row per statement (what summary.csv holds, plus the report path)
 *   /data/<db>/<run>/<report>.json       the audit, its line findings and the statement view for one statement
 *   /data/<db>/<run>/<report>.draft.json the editor's saved draft of that statement, when there is one
 *   PUT/DELETE /api/draft/<db>/<run>/<report>   save or remove that draft
 *
 * The statement logic (layout, publish gate, structural rules) is in gate.js (window.FA); the editor
 * re-runs it on every change, so what the operator sees is what the app's gate would say.
 */
(() => {
  const app = document.getElementById('app');
  const runSelect = document.getElementById('run-select');
  const navStats = document.getElementById('nav-stats');
  const state = {
    runs: [], run: null, meta: null, rows: [], drafts: new Set(),
    filter: 'all', query: '',
    tab: 0, problemsOnly: false, showPath: false, showUnused: false, checkFilter: null, hl: null,
    sview: (() => { try { return localStorage.getItem('fa.sview') === 'orig' ? 'orig' : 'apr'; } catch { return 'apr'; } })(), // statement layout: apr (chart of accounts) | orig (as captured)
    editing: false,
    config: { readOnly: false, defaultFilter: 'all' },
  };

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => v == null || v === '' ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const icon = (name, cls) => `<span class="ms-icon ${cls || ''}">${name}</span>`;
  const pill = s => `<span class="pill ${s === 'pass' ? 'pass' : 'fail'}">${s === 'pass' ? 'Pass' : 'Fail'}</span>`;
  const lc = v => String(v || '').toLowerCase();
  const get = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };
  const reportKey = r => r.report.replace(/\.md$/, '');
  const reportHash = r => `#/${state.run}/s/${encodeURIComponent(reportKey(r))}`;
  const when = iso => iso ? String(iso).slice(0, 16).replace('T', ' ') : '';

  /* ---------- runs ---------- */
  async function loadRuns() {
    state.config = await get('/api/config').catch(() => state.config); // an older server has no /api/config
    if (['all', 'fail', 'pass'].includes(state.config.defaultFilter)) state.filter = state.config.defaultFilter;
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
    state.drafts = state.config.readOnly ? new Set() : new Set(await get(`/api/drafts/${runPath}`).catch(() => []));
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
          <div><h1>Statements</h1><div class="sub">Run ${esc(m.db)} / ${esc(m.run)}${m.finished ? ` · ${esc(when(m.finished))}` : ''}${state.drafts.size ? ` · ${state.drafts.size} draft${state.drafts.size === 1 ? '' : 's'}` : ''}</div></div>
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
                <td><div class="name">${esc(r.client_name || r.client_id)}${state.drafts.has(reportKey(r)) ? '<span class="draft" title="A draft of this statement was saved in the editor">Draft</span>' : ''}</div><div class="type">${esc(r.company_type)}</div></td>
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
  /* current: { report, audit, view, base: [{type_id, type, cat, lines}], draft: saved draft | null,
   *            work: the lines being edited | null, eff: cached effective(), decorated: cached decorate() } */
  let current = null;

  async function renderDetail(report) {
    if (!current || current.report !== report) {
      app.innerHTML = '<p class="muted pad">Loading statement…</p>';
      let data;
      try { data = await get(`/data/${state.run}/${report}.json`); }
      catch (e) { app.innerHTML = `<div class="page"><a class="back" href="#/${esc(state.run)}">${icon('arrow_back')}All statements</a><p class="muted">Could not load ${esc(report)}.json (${esc(e.message)}). Re-run the audit to produce statement JSON.</p></div>`; return; }
      const draft = state.drafts.has(report) ? await get(`/data/${state.run}/${report}.draft.json`).catch(() => null) : null;
      const base = data.view ? data.view.statements.map(s => ({ type_id: s.type_id, type: s.type, cat: FA.catalogueOf(s.rows), lines: FA.linesOf(s.rows).map(l => ({ ...l, key: l.line_id })) })) : [];
      current = { report, audit: data.audit, view: data.view, base, draft, work: null, eff: null, decorated: null, nextKey: 1 };
      state.tab = 0; state.checkFilter = null; state.hl = null; state.problemsOnly = false; state.editing = false;
    }
    const { audit, view } = current;
    const eff = effective();
    const h = audit.header;
    const later = state.rows.find(r => lc(r.client_id) === lc(h.client_id) && r.period === h.period && Number(r.version) > Number(h.version) && r.status === 'pass');
    const draft = current.draft;

    app.innerHTML = `
      <div class="page">
        <div style="display:flex;flex-direction:column;gap:10px">
          <a class="back" href="#/${esc(state.run)}">${icon('arrow_back')}All statements</a>
          <div class="title-row">
            <div class="l"><h1>${esc(h.client_name || h.client_id)}</h1><span id="status-pill">${pill(eff.status)}</span></div>
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
        ${draft && !state.editing ? `<div class="draft-bar">${icon('edit_note')}<span>Showing the <b>saved draft</b> (${esc(when(draft.saved_at))}, ${draft.changes.length} change${draft.changes.length === 1 ? '' : 's'} to the audited statement). The checks are re-validated on the draft; nothing has been written to the database.</span><span class="actions"><a data-revert>Revert to audited</a></span></div>` : ''}

        <div class="split">
          <div class="card checks" id="checks">${renderChecks()}</div>
          <div class="issues" id="issues">${renderIssues()}</div>
        </div>

        <div id="stmts">${view ? renderStatements() : '<p class="muted">No statement view in this run. Re-run the audit to produce it.</p>'}</div>
      </div>`;
    wireDetail(report);
  }

  /* The lines and checks the page shows: the audit's own, or — with a draft or an edit in progress —
   * the lines re-laid-out and re-validated in the browser. */
  function effective() {
    if (current.eff) return current.eff;
    const model = current.work || (current.draft && current.draft.statements);
    if (!model || !current.view) {
      current.eff = { statements: current.view ? current.view.statements : [], findings: current.audit.line_findings || [], checks: current.audit.checks, status: current.audit.status, live: false };
    } else {
      const sts = current.base.map(b => ({ ...b, lines: ((model.find(m => m.type_id === b.type_id) || b).lines).filter(l => !l.deleted) }));
      const rc = FA.recompute(current.audit, sts);
      current.eff = { statements: sts.map(s => ({ type: s.type, type_id: s.type_id, rows: FA.layout(s.lines, s.cat) })), findings: rc.findings, checks: rc.checks, status: rc.status, live: true, sts };
    }
    return current.eff;
  }
  const invalidate = () => { current.eff = null; current.decorated = null; };

  function renderChecks() {
    const eff = effective();
    const counts = { fail: 0, pass: 0, advice: 0, error: 0, skipped: 0 };
    eff.checks.forEach(c => counts[c.status]++);
    return `
      <div class="card-head"><span>Checks</span><span class="meta">${[counts.fail && `${counts.fail} fail`, counts.error && `${counts.error} error`, counts.advice && `${counts.advice} advisory`, counts.pass && `${counts.pass} pass`, counts.skipped && `${counts.skipped} skipped`].filter(Boolean).join(' · ')}</span></div>
      <div class="bar">${[['f', counts.fail + counts.error], ['a', counts.advice], ['p', counts.pass], ['s', counts.skipped]].filter(([, n]) => n).map(([c, n]) => `<div class="${c}" style="flex:${n}"></div>`).join('')}</div>
      ${eff.checks.map((c, i) => checkRow(c, i)).join('')}
      ${eff.live ? `<div class="check" style="grid-template-columns:1fr"><div class="note">Totals, mapping, sign and blank rules are re-validated in the browser on the ${state.editing ? 'edited' : 'draft'} lines. Ties, ratios and AI checks show the audit run's result.</div></div>` : ''}`;
  }

  function checkRow(c, i) {
    const m = { fail: ['cancel', 'v fail'], error: ['error', 'v fail'], advice: ['warning', 'v amber'], pass: ['check_circle', 'v ok'], skipped: ['do_not_disturb_on', 'v dim'] }[c.status];
    const clickable = c.status !== 'pass' && c.status !== 'skipped';
    const note = c.status === 'pass' ? (c.details[0] || 'Passed') : c.status === 'skipped' ? c.details[0] : `${c.details.length} finding${c.details.length === 1 ? '' : 's'}`;
    return `<div class="check ${clickable ? 'click' : ''} ${state.checkFilter === i ? 'on' : ''}" data-check="${i}">
      ${icon(m[0], m[1])}<div style="min-width:0"><div class="n">${esc(c.label)}${c.live ? ' <span class="muted" style="font-weight:500;font-size:11px">live</span>' : ''}</div><div class="note">${esc(note)}</div></div>
      <span class="c ${m[1]}">${clickable ? c.details.length : ''}</span></div>`;
  }

  function renderIssues() {
    const eff = effective();
    const attention = eff.checks.map((c, i) => ({ c, i })).filter(({ c }) => c.status === 'fail' || c.status === 'error' || c.status === 'advice');
    const shown = state.checkFilter == null ? attention : attention.filter(({ i }) => i === state.checkFilter);
    const findingsTotal = attention.reduce((n, { c }) => n + c.details.length, 0);
    const title = attention.length === 0 ? 'All checks pass' : `${attention.length} check${attention.length === 1 ? '' : 's'} need attention · ${findingsTotal} finding${findingsTotal === 1 ? '' : 's'}`;
    return `
      <div class="issues-head"><div><h2>${esc(title)}</h2><div class="sub">Recommendations only. Nothing has been applied.</div></div></div>
      ${state.checkFilter != null && eff.checks[state.checkFilter] ? `<div class="filtered"><span>Filtered to</span><b>${esc(eff.checks[state.checkFilter].label)}</b><a href="#" data-clear>Clear</a></div>` : ''}
      ${shown.length === 0 ? '<div class="card"><div class="empty">Nothing to fix on this statement.</div></div>' : shown.map(({ c }) => `
        <div class="card">
          <div class="card-head"><span><span class="tag ${c.status === 'advice' ? 'advice' : 'fail'}">${c.status === 'advice' ? 'Advisory' : c.status === 'error' ? 'Error' : 'Fail'}</span>&nbsp; ${esc(c.label)}</span><span class="meta">${c.details.length} finding${c.details.length === 1 ? '' : 's'}</span></div>
          <div class="issue-grid">
            <div><div class="k">Findings</div>${c.details.map(d => { const t = rowForMessage(d); return `<div class="i ${t ? 'link' : ''}" ${t ? `data-goto="${t.tab}:${t.idx}" title="Show in ${esc(eff.statements[t.tab].type)}"` : ''}>${esc(d)}${t ? ` ${icon('arrow_downward', '')}` : ''}</div>`; }).join('')}</div>
            <div><div class="k">Recommended fixes</div>${c.recommendations.length ? c.recommendations.map(r => `<div class="i">${esc(r)}</div>`).join('') : '<div class="i muted">—</div>'}</div>
          </div>
        </div>`).join('')}`;
  }

  /* ---------- statements ---------- */
  function findingsFor(row, statementType) {
    const sameType = f => !f.statement_type || lc(f.statement_type) === lc(statementType);
    return effective().findings.filter(f => {
      if (row.kind === 'note') return false;
      if (row.kind === 'heading' || row.kind === 'nomap') return !!f.line_id && row.line_id && lc(f.line_id) === lc(row.line_id);
      if (f.line_id) return row.line_id && lc(f.line_id) === lc(row.line_id);
      if (f.mapping_id) return row.mapping_id && lc(f.mapping_id) === lc(row.mapping_id) && sameType(f);
      return row.kind !== 'node' && f.description && lc(f.description) === lc(row.line) && sameType(f);
    });
  }

  /* Each statement's rows decorated with their findings and a display kind. Computed once per model. */
  function decorate() {
    if (current.decorated) return current.decorated;
    current.decorated = effective().statements.map(s => s.rows.map(r => {
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

  /* Display order for one statement. APR: the chart-of-accounts order the rows already come in.
   * Original: the captured order (line sequence); a used node with no own line (missing total,
   * not captured) sits after the last line beneath it; unused nodes are never shown. */
  function orderRows(rows, orig) {
    const all = rows.map((x, idx) => ({ x, idx }));
    if (!orig) return all;
    const LAST = 1e12;
    const seqOf = x => {
      if (x.r.sequence != null) return x.r.sequence;
      const path = x.r.hint_path, prefix = `${path} > `;
      const under = rows.filter(y => y.r.sequence != null && (y.r.hint_path === path || y.r.hint_path.startsWith(prefix))).map(y => y.r.sequence);
      return under.length ? Math.max(...under) + 0.5 : LAST;
    };
    return all.filter(({ x }) => x.r.kind !== 'node' || x.r.used)
      .map(o => ({ ...o, seq: seqOf(o.x) }))
      .sort((a, b) => (a.seq - b.seq) || (a.idx - b.idx));
  }

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
  const valCell = x => { const v = V[x.kind]; return v[0] ? `<div class="v ${v[1]}" title="${esc(x.hits.map(h => `${h.check}: ${h.message}`).join('\n'))}">${icon(v[0])}<span>${esc(vText(x))}</span></div>` : ''; };
  /* The sum of the captured child lines for a period, from the gate's fault. */
  const subFor = (x, p) => {
    const f = x.hits.find(h => h.expected != null && h.period && (h.period === p || h.period.slice(0, 4) === p.slice(0, 4)) && /captured lines total|no captured total/i.test(h.message));
    return f ? `lines ${num(f.expected)}` : '';
  };
  const isTotal = r => r.has_children || r.depth === 0 && r.kind !== 'heading' && r.kind !== 'nomap' && r.kind !== 'unmapped';
  const mapLabel = r => r.kind === 'heading' ? '' : r.kind === 'unmapped' ? (r.hint ? `${r.hint} (not in this statement)` : r.mapping_id ? 'Unknown mapping' : 'No mapping') : r.hint;

  function renderStatements() {
    const eff = effective();
    const d = decorate();
    const tab = Math.min(state.tab, eff.statements.length - 1);
    const periods = current.view.periods;
    const rows = d[tab];
    const unused = rows.filter(x => x.r.kind === 'node' && !x.r.used).length;
    const hasSeq = rows.some(x => x.r.sequence != null);
    const editing = state.editing;
    const orig = editing || (state.sview === 'orig' && hasSeq);

    const body = editing ? '' : orderRows(rows, orig).map(({ x, idx }) => {
      const r = x.r;
      if (r.kind === 'node' && !r.used && !state.showUnused) return '';
      if (state.problemsOnly && !PROBLEM.has(x.kind)) return '';
      const total = isTotal(r);
      const crumb = state.showPath && r.hint_path && r.hint_path.includes(' > ') ? r.hint_path.split(' > ').slice(0, -1).join(' › ') : '';
      const mapCell = `<td style="padding-left:${orig ? 12 : 12 + r.depth * 20}px">${crumb ? `<div class="crumb">${esc(crumb)}</div>` : ''}<span class="lab ${total ? 'total' : ''} ${r.kind === 'nomap' || r.kind === 'unmapped' ? 'dim' : ''}">${esc(mapLabel(r))}</span>${r.sign ? `<span class="sign">${r.sign === 'positive' ? '≥ 0' : '≤ 0'}</span>` : ''}</td>`;
      const textCell = `<td style="font-weight:${r.kind === 'heading' || (orig && total) ? 700 : 500}">${r.kind === 'node' ? '<span class="ph">No line captured</span>' : esc(r.line)}</td>`;
      return `<tr id="row-${tab}-${idx}" class="k-${x.kind} ${state.hl === `${tab}:${idx}` ? 'hl' : ''}">
        ${orig ? textCell + mapCell : mapCell + textCell}
        ${periods.map(p => `<td class="num tnum"><div style="font-weight:${total ? 700 : 500}">${x.kind === 'missing' ? '—' : num(r.values[p])}</div>${subFor(x, p) ? `<div class="sub">${esc(subFor(x, p))}</div>` : ''}</td>`).join('')}
        <td>${valCell(x)}</td>
      </tr>`;
    }).join('');

    const changes = editing ? diffModel(current.work, baselineModel()).length : 0;
    return `
      <div class="stmts-head">
        <h2>Statements</h2>
        <div class="right">
          <div class="view-pick"><span>View</span><div class="seg sm ${editing ? 'off' : ''}" id="sview" ${editing ? 'title="The editor works in the original view"' : ''}>
            ${[['orig', 'Original'], ['apr', 'APR']].map(([k, l]) => `<button data-v="${k}" class="${(editing ? 'orig' : state.sview) === k ? 'on' : ''}" ${editing ? 'disabled' : ''}>${l}</button>`).join('')}
          </div></div>
          ${!editing && !state.config.readOnly ? `<button class="btn" id="edit-start">${icon('edit')}Edit statement</button>` : ''}
        </div>
      </div>
      <div class="options">
        <label><input type="checkbox" id="opt-problems" ${state.problemsOnly ? 'checked' : ''} ${editing ? 'disabled' : ''}>Problems only</label>
        <label><input type="checkbox" id="opt-path" ${state.showPath ? 'checked' : ''} ${editing ? 'disabled' : ''}>Show mapping path</label>
        <label class="${orig ? 'off' : ''}" ${orig ? 'title="Unused mappings are not part of the captured statement"' : ''}><input type="checkbox" id="opt-unused" ${state.showUnused && !orig ? 'checked' : ''} ${orig ? 'disabled' : ''}>Unused mappings (${unused})</label>
      </div>
      ${state.sview === 'orig' && !hasSeq && !editing ? `<div class="banner">${icon('info')}<span>This run has no captured order. Re-run the audit to use the Original view; showing the APR order.</span></div>` : ''}
      <div class="tabs" id="tabs">${renderTabs(tab)}</div>
      ${editing ? `
        <div class="edit-bar">${icon('edit_note')}<div><b>Editing ${esc(eff.statements[tab].type)}</b> in original view · <span id="changes">${changes} change${changes === 1 ? '' : 's'}</span>. Validation updates as you type.</div>
          <div class="actions"><button class="btn sm" id="edit-add">${icon('add')}Add line</button><button class="btn sm ghost" id="edit-discard">Discard</button><button class="btn sm primary" id="edit-save" ${changes ? '' : 'disabled'}>${icon('save')}Save draft</button></div></div>
        <div class="card stmt-card scroll"><table class="stmt-table edit-table" id="edit-table">
          <thead><tr><th style="width:26%">Line text</th><th>Mapping</th>${periods.map(p => `<th class="num" style="width:140px">${esc(p)}</th>`).join('')}<th class="val">Validation</th><th style="width:32px"></th></tr></thead>
          <tbody>${renderEditRows(tab)}</tbody>
        </table></div>` : `
      <div class="card stmt-card scroll">
        <table class="stmt-table">
          <thead><tr>${orig ? '<th>Line text</th><th>Mapping</th>' : '<th>Mapping</th><th>Line text</th>'}${periods.map(p => `<th class="num">${esc(p)}</th>`).join('')}<th class="val">Validation</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
        ${!body.trim() ? '<div class="empty">No problems in this statement</div>' : ''}
      </div>`}
      <div class="legend"><span>Red figures under a value are the sum of its captured child lines.</span><span>${editing ? 'Edits are a draft for this auditor only; apply them in the capture screen.' : orig ? 'Lines in the order they were captured; a missing total sits after its last child line.' : 'Totals and subtotals are coloured by their own check; detail lines are plain.'}</span></div>`;
  }

  function renderTabs(tab) {
    const d = decorate();
    return effective().statements.map((st, t) => {
      const prob = d[t].filter(x => PROBLEM.has(x.kind)).length;
      const lines = d[t].filter(x => x.r.kind !== 'node' && x.r.kind !== 'note').length;
      return `<button class="tab ${t === tab ? 'on' : ''}" data-tab="${t}"><span>${esc(st.type)}</span><span class="n">${lines} lines</span>${prob ? `<span class="prob">${prob}</span>` : ''}</button>`;
    }).join('');
  }

  /* ---------- editor ---------- */
  const baselineModel = () => (current.draft && current.draft.statements) || current.base;
  const clone = v => JSON.parse(JSON.stringify(v));
  const parseNum = raw => {
    const s = String(raw ?? '').trim().replace(/[,\s]/g, '').replace(/^\((.+)\)$/, '-$1');
    if (s === '' || s === '-') return null;
    const n = Number(s);
    return Number.isNaN(n) ? undefined : n;
  };

  /* Field-level differences between two models, for the change count and the saved draft. */
  function diffModel(work, base) {
    const out = [];
    work.forEach(w => {
      const b = base.find(x => x.type_id === w.type_id);
      const bl = new Map((b ? b.lines : []).map(l => [l.key, l]));
      w.lines.forEach(l => {
        const o = bl.get(l.key);
        if (!o) { if (!l.deleted) out.push({ type: w.type, line: l.line, field: 'added', from: null, to: { line: l.line, mapping: l.hint || null, values: l.values } }); return; }
        if (l.deleted) { out.push({ type: w.type, line: o.line, field: 'removed', from: { line: o.line, mapping: o.hint || null, values: o.values }, to: null }); return; }
        if (l.line !== o.line) out.push({ type: w.type, line: o.line, field: 'line text', from: o.line, to: l.line });
        if (lc(l.mapping_id) !== lc(o.mapping_id)) out.push({ type: w.type, line: o.line, field: 'mapping', from: o.hint || null, to: l.hint || null });
        Object.keys({ ...o.values, ...l.values }).forEach(p => { if ((l.values[p] ?? null) !== (o.values[p] ?? null)) out.push({ type: w.type, line: o.line, field: p, from: o.values[p] ?? null, to: l.values[p] ?? null }); });
      });
    });
    return out;
  }

  function startEdit() {
    current.work = clone(baselineModel()).map((m, i) => ({ type_id: m.type_id, type: m.type || current.base[i].type, lines: m.lines }));
    state.editing = true; state.hl = null; state.problemsOnly = false;
    invalidate();
  }

  function renderEditRows(tab) {
    const eff = effective();
    const s = eff.sts[tab];
    const periods = current.view.periods;
    const d = decorate();
    const work = current.work.find(m => m.type_id === s.type_id);
    const base = baselineModel().find(m => m.type_id === s.type_id);
    const baseLine = key => base && base.lines.find(l => l.key === key);
    const options = l => {
      const opts = [`<option value="" ${!l.mapping_id ? 'selected' : ''}>— no mapping —</option>`];
      if (s.cat.noMapId) opts.push(`<option value="${esc(s.cat.noMapId)}" ${lc(l.mapping_id) === lc(s.cat.noMapId) ? 'selected' : ''}>No map (excluded)</option>`);
      if (l.mapping_id && !s.cat.byMapping.has(lc(l.mapping_id)) && lc(l.mapping_id) !== lc(s.cat.noMapId)) opts.push(`<option value="${esc(l.mapping_id)}" selected>${esc(l.hint || 'Unknown mapping')} (not in this statement)</option>`);
      s.cat.order.forEach(p => { const n = s.cat.nodes.get(p); opts.push(`<option value="${esc(n.mapping_id)}" title="${esc(p)}" ${lc(l.mapping_id) === lc(n.mapping_id) ? 'selected' : ''}>${'   '.repeat(n.depth)}${esc(n.hint)}</option>`); });
      return opts.join('');
    };
    return orderRows(d[tab], true).map(({ x, idx }) => {
      const r = x.r;
      if (r.kind === 'note') return `<tr id="row-${tab}-${idx}" class="k-note"><td colspan="2" style="padding-left:28px">${esc(r.line)}</td>${periods.map(p => `<td class="num tnum">${num(r.values[p])}</td>`).join('')}<td></td><td></td></tr>`;
      if (r.kind === 'node') {
        return `<tr id="row-${tab}-${idx}" class="k-${x.kind}" data-node="${esc(r.hint_path)}">
          <td><div class="ph">No line captured<a data-add-total="${esc(r.hint_path)}" title="Add a line on this mapping with the sum of its child lines">Add total line</a></div></td>
          <td><div class="map-static">${esc(r.hint)}</div></td>
          ${periods.map(p => `<td class="num tnum"><div style="padding:6px 8px 0;font-weight:700">—</div><div class="sub">${esc(subFor(x, p))}</div></td>`).join('')}
          <td class="val-cell">${valCell(x)}</td><td></td></tr>`;
      }
      const l = work.lines.find(w => w.key === r.key);
      const o = baseLine(l.key);
      const ch = f => (o ? f(o) !== f(l) : true) ? 'changed' : '';
      return `<tr id="row-${tab}-${idx}" class="k-${x.kind} ${o ? '' : 'new'}" data-k="${esc(l.key)}">
        <td><input data-f="line" class="${ch(v => v.line)}" value="${esc(l.line)}" style="font-weight:${isTotal(r) ? 700 : 500}"></td>
        <td><select data-f="mapping" class="${ch(v => lc(v.mapping_id))}">${options(l)}</select></td>
        ${periods.map(p => `<td class="num"><input data-f="v:${esc(p)}" class="num ${ch(v => v.values[p] ?? null)}" inputmode="decimal" value="${l.values[p] == null ? '' : esc(l.values[p])}"><div class="sub">${esc(subFor(x, p))}</div></td>`).join('')}
        <td class="val-cell">${valCell(x)}</td>
        <td><button class="rm" data-rm title="Remove this line from the draft">${icon('close')}</button></td>
      </tr>`;
    }).join('');
  }

  /* After a text or value edit: re-validate and patch the parts that changed, leaving the inputs alone. */
  function refreshEdit(report) {
    invalidate();
    const eff = effective();
    const tab = Math.min(state.tab, eff.statements.length - 1);
    const d = decorate();
    const periods = current.view.periods;
    const work = current.work.find(m => m.type_id === eff.sts[tab].type_id);
    const base = baselineModel().find(m => m.type_id === eff.sts[tab].type_id);
    orderRows(d[tab], true).forEach(({ x, idx }) => {
      const tr = document.getElementById(`row-${tab}-${idx}`);
      if (!tr) return;
      tr.className = `k-${x.kind} ${tr.classList.contains('new') ? 'new' : ''}`;
      const val = tr.querySelector('.val-cell'); if (val) val.innerHTML = valCell(x);
      tr.querySelectorAll('.sub').forEach((el, i) => { el.textContent = subFor(x, periods[i]); });
      if (tr.dataset.k) {
        const l = work.lines.find(w => w.key === tr.dataset.k), o = base && base.lines.find(w => w.key === tr.dataset.k);
        tr.querySelectorAll('[data-f]').forEach(el => {
          const f = el.dataset.f;
          const cur = f === 'line' ? l.line : f === 'mapping' ? lc(l.mapping_id) : (l.values[f.slice(2)] ?? null);
          const was = !o ? undefined : f === 'line' ? o.line : f === 'mapping' ? lc(o.mapping_id) : (o.values[f.slice(2)] ?? null);
          el.classList.toggle('changed', !o || cur !== was);
        });
      }
    });
    document.getElementById('checks').innerHTML = renderChecks();
    document.getElementById('issues').innerHTML = renderIssues();
    document.getElementById('tabs').innerHTML = renderTabs(tab);
    document.getElementById('status-pill').innerHTML = pill(eff.status);
    const changes = diffModel(current.work, baselineModel()).length;
    document.getElementById('changes').textContent = `${changes} change${changes === 1 ? '' : 's'}`;
    document.getElementById('edit-save').disabled = !changes;
    wireShared(report);
  }

  async function saveDraft(report) {
    const statements = current.work.map(m => ({ type_id: m.type_id, type: m.type, lines: m.lines.filter(l => !l.deleted) }));
    const body = { statement_id: current.audit.header.id, statements, changes: diffModel(statements, current.base) };
    const r = await fetch(`/api/draft/${state.run}/${report}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) { alert(`Could not save the draft (${r.status}).`); return; }
    const { saved_at } = await r.json();
    current.draft = { ...body, saved_at }; current.work = null; state.editing = false;
    state.drafts.add(report);
    invalidate();
    await renderDetail(report);
  }

  async function revertDraft(report) {
    if (!confirm('Remove the saved draft and show the audited statement again?')) return;
    const r = await fetch(`/api/draft/${state.run}/${report}`, { method: 'DELETE' });
    if (!r.ok) { alert(`Could not remove the draft (${r.status}).`); return; }
    current.draft = null; state.drafts.delete(report);
    invalidate();
    await renderDetail(report);
  }

  /* Handlers on the regions refreshEdit() re-renders. */
  function wireShared(report) {
    const rerender = () => renderDetail(report);
    const repaint = () => { if (state.editing) { document.getElementById('checks').innerHTML = renderChecks(); document.getElementById('issues').innerHTML = renderIssues(); wireShared(report); } else rerender(); };
    app.querySelectorAll('.check.click').forEach(el => { el.onclick = () => { const i = Number(el.dataset.check); state.checkFilter = state.checkFilter === i ? null : i; repaint(); }; });
    const clear = app.querySelector('[data-clear]'); if (clear) clear.onclick = e => { e.preventDefault(); state.checkFilter = null; repaint(); };
    app.querySelectorAll('[data-goto]').forEach(el => { el.onclick = () => { const [t, i] = el.dataset.goto.split(':').map(Number); state.tab = t; state.hl = `${t}:${i}`; state.problemsOnly = false; rerender().then(() => { const row = document.getElementById(`row-${t}-${i}`); if (row) { row.classList.add('hl'); window.scrollTo({ top: row.getBoundingClientRect().top + window.scrollY - 140, behavior: 'smooth' }); } }); }; });
    app.querySelectorAll('.tab').forEach(el => { el.onclick = () => { state.tab = Number(el.dataset.tab); state.hl = null; rerender(); }; });
  }

  function wireDetail(report) {
    const rerender = () => renderDetail(report);
    wireShared(report);
    const opt = (id, key) => { const el = document.getElementById(id); if (el) el.onchange = () => { state[key] = el.checked; rerender(); }; };
    opt('opt-problems', 'problemsOnly'); opt('opt-path', 'showPath'); opt('opt-unused', 'showUnused');
    app.querySelectorAll('#sview button:not([disabled])').forEach(el => { el.onclick = () => { state.sview = el.dataset.v; try { localStorage.setItem('fa.sview', state.sview); } catch { /* private mode */ } rerender(); }; });
    const revert = app.querySelector('[data-revert]'); if (revert) revert.onclick = () => revertDraft(report);
    const start = document.getElementById('edit-start'); if (start) start.onclick = () => { startEdit(); rerender(); };
    if (!state.editing) return;

    const eff = effective();
    const tab = Math.min(state.tab, eff.statements.length - 1);
    const s = eff.sts[tab];
    const work = current.work.find(m => m.type_id === s.type_id);
    const maxSeq = () => Math.max(0, ...work.lines.filter(l => !l.deleted).map(l => l.sequence || 0));
    const newLine = fields => ({ key: `new-${Date.now().toString(36)}-${current.nextKey++}`, line_id: null, line: '', mapping_id: null, hint: '', hint_path: '', sign: null, values: Object.fromEntries(current.view.periods.map(p => [p, null])), sequence: maxSeq() + 1, notes: [], ...fields });
    const setMapping = (l, id) => {
      const n = id ? s.cat.byMapping.get(lc(id)) : null;
      l.mapping_id = id || null;
      l.hint = n ? n.hint : (id && lc(id) === lc(s.cat.noMapId) ? 'No map' : (id ? l.hint : ''));
      l.hint_path = n ? n.path : l.hint;
      l.sign = n ? n.sign : null;
    };
    const focusLine = l => { const el = app.querySelector(`tr[data-k="${l.key}"] input[data-f="line"]`); if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); } };

    document.getElementById('edit-discard').onclick = () => { if (diffModel(current.work, baselineModel()).length && !confirm('Discard the changes made in this edit?')) return; current.work = null; state.editing = false; invalidate(); rerender(); };
    document.getElementById('edit-save').onclick = () => saveDraft(report);
    document.getElementById('edit-add').onclick = () => { const l = newLine({}); work.lines.push(l); invalidate(); rerender().then(() => focusLine(l)); };

    const table = document.getElementById('edit-table');
    table.onchange = e => {
      const el = e.target;
      const tr = el.closest('tr[data-k]');
      if (!tr || !el.dataset.f) return;
      const l = work.lines.find(w => w.key === tr.dataset.k);
      const f = el.dataset.f;
      if (f === 'line') { l.line = el.value; refreshEdit(report); return; }
      if (f.startsWith('v:')) {
        const n = parseNum(el.value);
        if (n === undefined) { el.value = l.values[f.slice(2)] == null ? '' : l.values[f.slice(2)]; return; } // not a number: keep the old value
        l.values[f.slice(2)] = n; el.value = n == null ? '' : n;
        refreshEdit(report); return;
      }
      if (f === 'mapping') { setMapping(l, el.value); invalidate(); rerender(); }
    };
    table.onclick = e => {
      const rm = e.target.closest('[data-rm]');
      if (rm) { const l = work.lines.find(w => w.key === rm.closest('tr').dataset.k); if (l.line_id) l.deleted = true; else work.lines.splice(work.lines.indexOf(l), 1); invalidate(); rerender(); return; }
      const add = e.target.closest('[data-add-total]');
      if (add) {
        const path = add.dataset.addTotal, n = s.cat.nodes.get(path);
        const children = s.lines.filter(l => l.mapping_id && s.cat.byMapping.has(lc(l.mapping_id)) && s.cat.byMapping.get(lc(l.mapping_id)).parent === path);
        const values = Object.fromEntries(current.view.periods.map(p => { const vs = children.map(c => c.values[p]).filter(v => v != null); return [p, vs.length ? Math.round(vs.reduce((a, b) => a + b, 0) * 100) / 100 : null]; }));
        const seqs = s.lines.filter(l => l.hint_path === path || l.hint_path.startsWith(`${path} > `)).map(l => l.sequence || 0);
        const l = newLine({ line: n.hint, values, sequence: (seqs.length ? Math.max(...seqs) : maxSeq()) + 0.5 });
        setMapping(l, n.mapping_id);
        work.lines.push(l); invalidate(); rerender().then(() => focusLine(l));
      }
    };
  }

  window.addEventListener('beforeunload', e => { if (state.editing && current && current.work && diffModel(current.work, baselineModel()).length) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('hashchange', () => route().catch(err => { app.innerHTML = `<p class="muted pad">${esc(err.message)}</p>`; }));
  loadRuns().then(route).catch(err => { app.innerHTML = `<p class="muted pad">${esc(err.message)}</p>`; });
})();
