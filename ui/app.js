/* Financials Auditor UI. Vanilla JS, no build. Data comes from `node run.js serve`:
 *   /api/runs                      the audit runs under audit-output/
 *   /data/<db>/<run>/index.json    one row per statement (what summary.csv holds, plus the report path)
 *   /data/<db>/<run>/<report>.json the audit and the statement view for one statement
 */
(() => {
  const app = document.getElementById('app');
  const runSelect = document.getElementById('run-select');
  const state = { runs: [], run: null, rows: [], filter: 'all', query: '', showPath: false, showUnused: false };

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => v == null ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const badge = s => `<span class="badge ${esc(s)}">${esc(String(s).toUpperCase())}</span>`;
  const get = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };

  async function loadRuns() {
    state.runs = await get('/api/runs');
    runSelect.innerHTML = state.runs.map(r =>
      `<option value="${esc(r.path)}">${esc(r.db)} / ${esc(r.run)} — ${r.audited} audited, ${r.fail} fail</option>`).join('');
    runSelect.onchange = () => { location.hash = `#/${runSelect.value}`; };
  }

  async function route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (!state.runs.length) { app.innerHTML = '<p class="muted">No audit runs found under audit-output/. Run <code>node run.js audit</code> first.</p>'; return; }
    const runPath = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : state.runs[0].path;
    if (!state.runs.some(r => r.path === runPath)) { location.hash = `#/${state.runs[0].path}`; return; }
    runSelect.value = runPath;
    if (state.run !== runPath) {
      state.run = runPath;
      state.rows = await get(`/data/${runPath}/index.json`);
    }
    const detail = parts[2] === 's' ? decodeURIComponent(parts.slice(3).join('/')) : null;
    if (detail) await renderDetail(detail); else renderList();
  }

  function renderList() {
    const q = state.query.trim().toLowerCase();
    const rows = state.rows.filter(r =>
      (state.filter === 'all' || r.status === state.filter) &&
      (!q || [r.client_name, r.obligor_key, r.description, r.statement_id, r.period].some(v => String(v ?? '').toLowerCase().includes(q))));
    const pass = state.rows.filter(r => r.status === 'pass').length;
    app.innerHTML = `
      <div class="toolbar">
        <input type="search" id="q" placeholder="Search client, obligor key, description, id…" value="${esc(state.query)}">
        <select id="f">
          ${['all', 'fail', 'pass'].map(v => `<option value="${v}" ${state.filter === v ? 'selected' : ''}>${v === 'all' ? 'All statuses' : v.toUpperCase()}</option>`).join('')}
        </select>
        <span class="counts">${rows.length} of ${state.rows.length} shown · ${pass} pass · ${state.rows.length - pass} fail</span>
      </div>
      <div class="grid">${rows.map(card).join('') || '<p class="muted">Nothing matches.</p>'}</div>`;
    const qEl = document.getElementById('q');
    qEl.oninput = () => { state.query = qEl.value; renderList(); document.getElementById('q').focus(); document.getElementById('q').setSelectionRange(state.query.length, state.query.length); };
    document.getElementById('f').onchange = e => { state.filter = e.target.value; renderList(); };
  }

  function card(r) {
    const metrics = [
      ['gate faults', r.gate_faults], ['missing totals', r.missing_totals], ['unmapped', r.unmapped_lines], ['sign', r.sign_faults],
    ].filter(([, v]) => Number(v) > 0).map(([k, v]) => `<span class="chip bad">${v} ${k}</span>`).join('');
    const translatable = r.translatable === 'no' ? '<span class="chip bad">ratios blocked</span>' : '';
    return `<a class="card" href="#/${esc(state.run)}/s/${encodeURIComponent(r.report.replace(/\.md$/, ''))}">
      <h3><span>${esc(r.client_name || r.client_id)}</span>${badge(r.status)}</h3>
      <div class="sub">${esc(r.period)} · v${esc(r.version)} · ${esc(r.company_type)} · obligor ${esc(r.obligor_key || '—')}</div>
      <div class="sub">${esc(r.description)}</div>
      ${r.failed_checks ? `<div class="fails">${esc(r.failed_checks)}</div>` : ''}
      ${r.error ? `<div class="fails">Audit error: ${esc(r.error)}</div>` : ''}
      <div class="metrics">${metrics}${translatable}</div>
    </a>`;
  }

  async function renderDetail(report) {
    app.innerHTML = '<p class="muted">Loading statement…</p>';
    let data;
    try { data = await get(`/data/${state.run}/${report}.json`); }
    catch (e) { app.innerHTML = `<a class="back" href="#/${esc(state.run)}">← Back</a><p class="muted">Could not load ${esc(report)}.json (${esc(e.message)}). Re-run the audit to produce statement JSON.</p>`; return; }
    const { audit, view } = data;
    const h = audit.header;
    const failing = audit.checks.filter(c => c.recommendations.length);
    app.innerHTML = `
      <div class="detail">
        <a class="back" href="#/${esc(state.run)}">← All statements</a>
        <h1>${esc(h.client_name || h.client_id)} ${badge(audit.status)}</h1>
        <div class="muted">${esc(h.description)}</div>
        <div class="facts">
          <div><span>Period</span>${esc(h.period)}${h.previous_period ? ` (prev ${esc(h.previous_period)})` : ''}</div>
          <div><span>Version</span>v${esc(h.version)}</div>
          <div><span>Company type</span>${esc(h.company_type)}</div>
          <div><span>Published</span>${esc(h.publish_date)}</div>
          <div><span>Obligor key</span>${esc(h.obligor_key || '—')}</div>
          <div><span>Lines</span>${esc(h.line_count)}</div>
          <div><span>Statement id</span><code>${esc(h.id)}</code></div>
          <div><span>Report</span><a href="/data/${esc(state.run)}/${esc(report)}.md" target="_blank">Markdown</a></div>
        </div>
        ${audit.error ? `<p class="fails">Audit error: ${esc(audit.error)}</p>` : ''}

        <section>
          <h2>Checks</h2>
          <table>
            <thead><tr><th>Check</th><th>Status</th><th>Findings</th></tr></thead>
            <tbody>${audit.checks.map(c => `<tr>
              <td>${esc(c.label)}</td><td>${badge(c.status)}</td>
              <td>${c.details.length === 0 ? '—' : c.details.length === 1 ? esc(c.details[0])
                : `<details><summary>${c.details.length} findings</summary><ul class="check-findings">${c.details.map(d => `<li>${esc(d)}</li>`).join('')}</ul></details>`}</td>
            </tr>`).join('')}</tbody>
          </table>
        </section>

        ${failing.length ? `<section><h2>Recommended fixes <span class="muted" style="font-weight:400">(recommendations only, nothing applied)</span></h2>
          ${failing.map(c => `<h3 style="font-size:14px;margin:12px 0 4px">${esc(c.label)} ${badge(c.status)}</h3><ul class="recs">${c.recommendations.map(r => `<li>${esc(r)}</li>`).join('')}</ul>`).join('')}
        </section>` : ''}

        ${view ? renderStatements(view, audit.line_findings || []) : '<p class="muted">No statement view in this run. Re-run the audit to produce it.</p>'}
      </div>`;
    const t = document.getElementById('toggle-path');
    if (t) t.onchange = () => { state.showPath = t.checked; renderDetail(report); };
    const u = document.getElementById('toggle-unused');
    if (u) u.onchange = () => { state.showUnused = u.checked; renderDetail(report); };
  }

  /* The findings about one row. A captured line matches by its id (structural checks hand us the
   * line) or, for a publish-gate fault, by the mapping of the total it names. A catalogue node
   * matches by mapping only — that is how a missing total lands on the node nothing was captured
   * against. Statement type is checked when the finding carries one. */
  function findingsFor(row, statementType, findings) {
    const lc = v => String(v || '').toLowerCase();
    const sameType = f => !f.statement_type || lc(f.statement_type) === lc(statementType);
    return findings.filter(f => {
      if (row.kind === 'note') return false;
      if (row.kind === 'heading' || row.kind === 'nomap') return !!f.line_id && row.line_id && lc(f.line_id) === lc(row.line_id);
      if (f.line_id) return row.line_id && lc(f.line_id) === lc(row.line_id);
      if (f.mapping_id) return row.mapping_id && lc(f.mapping_id) === lc(row.mapping_id) && sameType(f);
      return row.kind !== 'node' && f.description && lc(f.description) === lc(row.line) && sameType(f);
    });
  }

  function renderStatements(view, findings) {
    const periods = view.periods;
    const header = `<thead><tr><th>Hint text (mapping)</th><th>Line text</th>${periods.map(p => `<th class="num">${esc(p)}</th>`).join('')}<th>Validation</th></tr></thead>`;
    const indent = d => `style="padding-left:${10 + d * 18}px"`;
    const hintCell = r => {
      if (r.kind === 'heading') return '';
      if (r.kind === 'unmapped' && !r.hint) return '<span class="mapping">— no mapping —</span>';
      if (r.kind === 'unmapped') return `<span class="mapping">${esc(r.hint)} (not in this statement)</span>`;
      const text = state.showPath && r.hint_path ? r.hint_path : r.hint;
      return `<span class="hint ${r.has_children ? 'parent' : ''}">${esc(text)}</span>${r.sign ? `<span class="sign">${r.sign === 'positive' ? '≥ 0' : '≤ 0'}</span>` : ''}`;
    };
    const row = (r, statementType) => {
      if (r.kind === 'node' && !r.used && !state.showUnused) return '';
      const hits = findingsFor(r, statementType, findings);
      const worst = hits.some(h => h.severity === 'fail') ? 'fail' : hits.length ? 'advice' : null;
      let cls, validation;
      if (r.kind === 'note') {
        cls = 'note'; validation = '';
      } else if (r.kind === 'heading') {
        cls = worst ? `row-${worst}` : 'heading';
        validation = hits.length ? hits.map(h => `<div class="issue ${h.severity}">${esc(h.check)}: ${esc(h.message)}</div>`).join('') : '<span class="muted">heading</span>';
      } else if (r.kind === 'nomap') {
        cls = worst ? `row-${worst}` : 'nomap';
        validation = hits.length ? hits.map(h => `<div class="issue ${h.severity}">${esc(h.check)}: ${esc(h.message)}</div>`).join('') : '<span class="muted">No map — excluded from totals and ratios</span>';
      } else if (r.kind === 'node') {
        cls = worst ? `row-${worst}` : (r.used ? 'node-used' : 'node-unused');
        validation = hits.length ? hits.map(h => `<div class="issue ${h.severity}">${esc(h.message)}</div>`).join('')
          : (r.used ? '<span class="muted">no line captured against this mapping</span>' : '<span class="muted">not used</span>');
      } else if (r.kind === 'unmapped') {
        cls = 'row-fail';
        validation = hits.length ? hits.map(h => `<div class="issue fail">${esc(h.message)}</div>`).join('')
          : `<div class="issue fail">${r.mapping_id ? 'Mapped to an entry outside this statement\'s chart of accounts' : 'Line is not mapped to the chart of accounts'}</div>`;
      } else {
        cls = worst ? `row-${worst}` : 'row-pass';
        validation = hits.length ? hits.map(h => `<div class="issue ${h.severity}">${esc(h.check)}: ${esc(h.message)}</div>`).join('') : '<span class="ok">✓</span>';
      }
      return `<tr class="${cls}">
        <td ${indent(r.depth)}>${hintCell(r)}</td>
        <td>${esc(r.line)}</td>
        ${periods.map(p => `<td class="num">${num(r.values[p])}</td>`).join('')}
        <td class="issues">${validation}</td>
      </tr>`;
    };
    return `<section>
      <div class="stmt-head"><h2>Statements</h2>
        <span class="legend"><i class="sw fail"></i> fails a check <i class="sw advice"></i> advisory <i class="sw pass"></i> passes <i class="sw node"></i> structure</span>
        <span class="toggles">
          <label class="toggle"><input type="checkbox" id="toggle-unused" ${state.showUnused ? 'checked' : ''}> show unused mappings</label>
          <label class="toggle"><input type="checkbox" id="toggle-path" ${state.showPath ? 'checked' : ''}> show full mapping path</label>
        </span></div>
      ${view.statements.map(s => {
        const lines = s.rows.filter(r => r.kind !== 'node' && r.kind !== 'note').length;
        const unused = s.rows.filter(r => r.kind === 'node' && !r.used).length;
        return `<h3 style="font-size:15px;margin:16px 0 6px">${esc(s.type)} <span class="muted" style="font-weight:400">· ${lines} captured lines${unused ? ` · ${unused} unused mappings hidden` : ''}</span></h3>
        <table>${header}<tbody>${s.rows.map(r => row(r, s.type)).join('')}</tbody></table>`;
      }).join('')}
    </section>`;
  }

  window.addEventListener('hashchange', () => route().catch(err => { app.innerHTML = `<p class="fails">${esc(err.message)}</p>`; }));
  loadRuns().then(route).catch(err => { app.innerHTML = `<p class="fails">${esc(err.message)}</p>`; });
})();
