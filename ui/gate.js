/* Pure statement logic shared by the page and the specs (plain script in the browser, CommonJS in node).
 *
 *  catalogueOf(rows)         the chart-of-accounts nodes a statement view was laid out on
 *  linesOf(rows)             the captured lines (with their notes) out of a statement view
 *  layout(lines, cat)        the view rows again: every node in catalogue order with the lines under it,
 *                            then headings / No map / unmapped lines — what statement-view.ts produces
 *  gateFaults(lines, cat, type)  the publish gate of financial-statement-validator.ts, same three rules,
 *                            same tolerance, same messages
 *  structuralFindings(lines, cat, type)  Chart of Accounts Mapping, Mapping Cardinality, No Blank Values
 *
 * The editor re-runs these as the operator types. Checks that need the database (ties, ratios, AI)
 * are not here; the page keeps the audit run's findings for those.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FA = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const SEP = ' > ';
  const lc = v => String(v || '').toLowerCase();
  const TOLERANCE = 1;
  const GATE = 'Publish gate (totals balance)';

  /** Nodes keyed by path, in reading order. Built from every node/line row the view carries. */
  function catalogueOf(rows) {
    const nodes = new Map();
    rows.forEach(r => {
      if (r.kind !== 'node' && r.kind !== 'line') return;
      if (!r.hint_path || nodes.has(r.hint_path)) return;
      nodes.set(r.hint_path, {
        path: r.hint_path, mapping_id: r.mapping_id, hint: r.hint, depth: r.depth, has_children: r.has_children, sign: r.sign,
        parent: r.hint_path.includes(SEP) ? r.hint_path.split(SEP).slice(0, -1).join(SEP) : null, order: nodes.size,
      });
    });
    const noMap = rows.find(r => r.kind === 'nomap' && r.mapping_id);
    const byMapping = new Map([...nodes.values()].map(n => [lc(n.mapping_id), n]));
    return { nodes, byMapping, order: [...nodes.keys()], noMapId: noMap ? noMap.mapping_id : null };
  }

  /** Captured lines in sequence order; each note row is attached to the line it followed. */
  function linesOf(rows) {
    const lines = [];
    rows.forEach(r => {
      if (r.kind === 'node') return;
      if (r.kind === 'note') { if (lines.length) lines[lines.length - 1].notes.push({ ...r }); return; }
      lines.push({ line_id: r.line_id, line: r.line, mapping_id: r.mapping_id, hint: r.hint, hint_path: r.hint_path, sign: r.sign,
        values: { ...r.values }, sequence: r.sequence, notes: [] });
    });
    return lines.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || 0);
  }

  /* The app (FinancialsHelper.isFinancialHeading) reads a 0 as no value, so a zero-valued unmapped line is a heading too. */
  const allNull = values => Object.values(values || {}).every(v => v == null || v === 0);

  /** line | nomap | heading | unmapped, as statement-view.ts decides it. */
  function classify(l, cat) {
    if (l.mapping_id && cat.byMapping.has(lc(l.mapping_id))) return 'line';
    if (l.mapping_id && (lc(l.mapping_id) === lc(cat.noMapId) || lc(l.hint) === 'no map')) return 'nomap';
    if (!l.mapping_id && allNull(l.values)) return 'heading';
    return 'unmapped';
  }

  function layout(lines, cat) {
    const byPath = new Map();
    const rest = [];
    lines.forEach(l => {
      const kind = classify(l, cat);
      if (kind === 'line') { const p = cat.byMapping.get(lc(l.mapping_id)).path; if (!byPath.has(p)) byPath.set(p, []); byPath.get(p).push(l); }
      else rest.push({ l, kind });
    });
    const used = new Set();
    byPath.forEach((_, p) => { const parts = p.split(SEP); for (let i = 1; i <= parts.length; i++) used.add(parts.slice(0, i).join(SEP)); });
    const noteRows = (l, depth) => l.notes.map(n => ({ ...n, kind: 'note', depth, sequence: l.sequence }));
    const rows = [];
    cat.order.forEach(p => {
      const n = cat.nodes.get(p);
      const own = byPath.get(p) || [];
      if (own.length === 0) {
        rows.push({ kind: 'node', depth: n.depth, mapping_id: n.mapping_id, hint: n.hint, hint_path: p, has_children: n.has_children, used: used.has(p), line_id: null, line: '', values: {}, sign: n.sign, sequence: null });
        return;
      }
      own.forEach(l => {
        rows.push({ kind: 'line', depth: n.depth, mapping_id: n.mapping_id, hint: n.hint, hint_path: p, has_children: n.has_children, used: true, line_id: l.line_id, line: l.line, values: l.values, sign: n.sign, sequence: l.sequence, key: l.key });
        rows.push(...noteRows(l, n.depth + 1));
      });
    });
    rest.forEach(({ l, kind }) => {
      rows.push({ kind, depth: 0, mapping_id: l.mapping_id, hint: l.hint || '', hint_path: l.hint_path || l.hint || '', has_children: false, used: true, line_id: l.line_id, line: l.line, values: l.values, sign: l.sign, sequence: l.sequence, key: l.key });
      rows.push(...noteRows(l, 1));
    });
    return rows;
  }

  const periodsOf = l => Object.keys(l.values).filter(p => l.values[p] != null);
  const sum = vs => vs.reduce((s, v) => s + v, 0);

  function gateFaults(lines, cat, typeName) {
    const faults = [];
    const mapped = lines.filter(l => classify(l, cat) === 'line').map(l => ({ l, node: cat.byMapping.get(lc(l.mapping_id)) }));
    const fault = (f) => faults.push({ line_id: null, check: GATE, severity: 'fail', statement_type: typeName, ...f });
    const cashFlow = lc(typeName).includes('cash flow');
    const childrenOf = p => mapped.filter(x => x.node.parent === p);
    const linesOn = p => mapped.filter(x => x.node.path === p);

    if (!cashFlow) {
      // Rule 1: each captured total against the sum of its captured children.
      const totalPaths = [...new Set(mapped.filter(x => x.node.has_children).map(x => x.node.path))];
      totalPaths.forEach(p => {
        const children = childrenOf(p);
        if (!children.length) return;
        const totals = linesOn(p);
        const periods = [...new Set(totals.flatMap(x => periodsOf(x.l)))];
        periods.forEach(period => {
          const contributing = children.map(x => x.l.values[period]).filter(v => v != null);
          if (!contributing.length) return;
          const expected = sum(contributing);
          const captured = totals.filter(x => x.l.values[period] != null);
          if (!captured.length) return;
          if (captured.some(x => Math.abs(x.l.values[period] - expected) <= TOLERANCE)) return;
          const t = captured[0];
          const actual = t.l.values[period];
          const name = t.l.line ?? t.node.hint;
          fault({ mapping_id: t.node.mapping_id, description: name, period, expected, actual, rule: 'total_vs_children',
            message: `"${name}" is ${actual} but its captured lines total ${expected} for ${period}` });
        });
      });
    }

    // Rule 2: assets against equity and liabilities, on the roots.
    const roots = mapped.filter(x => x.node.parent === null && x.node.has_children);
    const el = roots.find(x => lc(x.node.hint).includes('equity and liabilit'));
    const assets = roots.find(x => lc(x.node.hint).includes('assets') && !lc(x.node.hint).includes('equity and liabilit'));
    if (el && assets) {
      periodsOf(assets.l).forEach(period => {
        const actual = assets.l.values[period], expected = el.l.values[period];
        if (actual == null || expected == null) return;
        if (Math.abs(actual - expected) <= TOLERANCE) return;
        fault({ mapping_id: null, description: assets.l.line ?? 'Total Assets', period, expected, actual, rule: 'assets_vs_equity_and_liabilities',
          message: `Assets total ${actual} but equity and liabilities total ${expected} for ${period}` });
      });
    }

    if (!cashFlow) {
      // Rule 3: a total whose children were captured must itself be captured.
      cat.order.forEach(p => {
        const n = cat.nodes.get(p);
        if (!n.has_children) return;
        const children = childrenOf(p);
        if (!children.length) return;
        const parents = linesOn(p);
        const childPeriods = [...new Set(children.flatMap(x => periodsOf(x.l)))];
        childPeriods.forEach(period => {
          if (parents.some(x => x.l.values[period] != null)) return;
          const expected = sum(children.map(x => x.l.values[period]).filter(v => v != null));
          fault({ mapping_id: n.mapping_id, description: n.hint, period, expected, actual: null, rule: 'missing_total',
            message: `"${n.hint}" has no captured total for ${period}, but the lines under it total ${expected}` });
        });
      });
    }
    return faults;
  }

  /* The app's heading test (FinancialsHelper.isFinancialHeading): a described line with no values, whatever its mapping. */
  const isHeading = l => !!String(l.line || '').trim() && allNull(l.values);

  /** Chart of Accounts Mapping and Mapping Cardinality for one statement type. */
  function structuralFindings(lines, cat, typeName) {
    const out = [];
    lines.filter(l => !isHeading(l) && l.mapping_id == null).forEach(l => {
      out.push({ line_id: l.line_id, mapping_id: null, description: l.line, statement_type: typeName, check: 'Chart of Accounts Mapping', severity: 'fail', message: `${l.line} is unmapped` });
    });
    lines.forEach(l => {
      const node = l.mapping_id && cat.byMapping.get(lc(l.mapping_id));
      if (!node || !node.sign) return;
      const offending = periodsOf(l).filter(p => node.sign === 'positive' ? l.values[p] < 0 : l.values[p] > 0).sort().reverse();
      if (!offending.length) return;
      out.push({ line_id: l.line_id, mapping_id: l.mapping_id, description: l.line, statement_type: typeName, check: 'Mapping Cardinality', severity: 'fail',
        message: `${l.line} must be ${node.sign === 'positive' ? 'Positive' : 'Negative'} (${offending.join(', ')})` });
    });
    return out;
  }

  /** No Blank Values: the statement's first non-heading line must be mapped to a real entry. The app reads its lines in
   *  database order, which the view does not have; this reads them statement by statement in captured order. */
  function blankFinding(statements) {
    let s = null, first = null;
    for (const st of statements) { const f = st.lines.filter(l => !isHeading(l))[0]; if (f) { s = st; first = f; break; } }
    if (!s) s = statements[0];
    const bad = !first || !first.mapping_id || classify(first, s.cat) === 'nomap';
    if (!bad) return [];
    return [{ line_id: first ? first.line_id : null, mapping_id: null, description: first ? first.line : '', statement_type: s ? s.type : null, check: 'No Blank Values', severity: 'fail',
      message: first ? `The first line, "${first.line}", is not mapped to a chart-of-accounts entry` : 'The statement has no mapped, non-placeholder line' }];
  }

  const fmt = n => n == null || Number.isNaN(n) ? 'n/a' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /** One sentence of advice per finding — the wording of recommendations.ts. */
  function recommend(f) {
    const name = f.hint || f.description;
    switch (f.rule) {
      case 'total_vs_children':
        return `Re-capture "${name}" (${f.statement_type}) for ${f.period}: captured ${fmt(f.actual)}, the lines under it total ${fmt(f.expected)} (difference ${fmt(f.actual - f.expected)}). Correct either the total or one of its child lines.`;
      case 'assets_vs_equity_and_liabilities':
        return `Balance the balance sheet for ${f.period}: assets and equity-and-liabilities differ by ${fmt(f.actual - f.expected)}. Look for a missing liability or equity line, or a sign error on one side.`;
      case 'missing_total':
        return `Capture a total line for "${name}" (${f.statement_type}) for ${f.period}; its captured lines sum to ${fmt(f.expected)}.`;
      default: break;
    }
    switch (f.check) {
      case 'No Blank Values':
        return 'Map the first non-heading line to a real chart-of-accounts entry, or remove the placeholder line. The statement currently starts with "No Map" or an unmapped line.';
      case 'Mapping Cardinality':
        return `${f.message}. Flip the sign, or move the line to the counterpart mapping if it was captured under the wrong one.`;
      default:
        return f.message;
    }
  }

  const LIVE = { publish_gate: 1, missing_subtotals: 1, chart_of_accounts_mapping: 1, mapping_cardinality: 1, no_blank_values: 1 };

  /**
   * The audit's checks again, with the rules this module can run replaced by their result on the
   * given lines. Checks that need the database keep the audit's verdict. Returns the checks, the
   * line findings for the view, and the overall status.
   */
  function recompute(audit, statements) {
    const faults = [], structural = [];
    statements.forEach(s => {
      faults.push(...gateFaults(s.lines, s.cat, s.type).map(f => ({ ...f, hint: f.mapping_id ? (s.cat.byMapping.get(lc(f.mapping_id)) || {}).hint : null })));
      structural.push(...structuralFindings(s.lines, s.cat, s.type));
    });
    structural.push(...blankFinding(statements));
    // One Missing Subtotals finding per node, however many periods lack the total.
    const missing = faults.filter((f, i, all) => f.rule === 'missing_total' && all.findIndex(o => o.rule === 'missing_total' && lc(o.mapping_id) === lc(f.mapping_id)) === i);
    const byLabel = label => structural.filter(f => f.check === label);
    const live = {
      publish_gate: { status: faults.length ? 'fail' : 'pass', details: faults.map(f => f.message), recommendations: faults.map(recommend) },
      missing_subtotals: { status: missing.length ? 'fail' : 'pass', details: missing.map(f => `Children of "${f.hint || f.description}" are captured but no total line exists`),
        recommendations: missing.map(f => `Capture a total line for "${f.hint || f.description}" (${f.statement_type}); its child lines are captured but the total is not.`) },
      chart_of_accounts_mapping: (() => { const fs = byLabel('Chart of Accounts Mapping'); return { status: fs.length ? 'fail' : 'pass', details: fs.map(f => f.message), recommendations: fs.length ? [`Map these lines to a chart-of-accounts entry: ${fs.map(f => `"${f.description}"`).join(', ')}.`] : [] }; })(),
      mapping_cardinality: (() => { const fs = byLabel('Mapping Cardinality'); return { status: fs.length ? 'fail' : 'pass', details: fs.map(f => f.message), recommendations: fs.map(recommend) }; })(),
      no_blank_values: (() => { const fs = byLabel('No Blank Values'); return { status: fs.length ? 'fail' : 'pass', details: fs.map(f => f.message), recommendations: fs.map(recommend) }; })(),
    };
    const labels = { publish_gate: 'Publish gate (totals balance)', missing_subtotals: 'Missing Subtotals', chart_of_accounts_mapping: 'Chart of Accounts Mapping', mapping_cardinality: 'Mapping Cardinality', no_blank_values: 'No Blank Values' };
    const checks = audit.checks.map(c => LIVE[c.id] ? { ...c, ...live[c.id], live: true } : c);
    Object.keys(live).forEach(id => { if (!checks.some(c => c.id === id)) checks.splice(1, 0, { id, label: labels[id], ...live[id], live: true }); });
    const keep = (audit.line_findings || []).filter(f => f.check !== GATE && !Object.values(labels).includes(f.check));
    const findings = [...faults, ...structural, ...keep];
    const status = checks.some(c => c.status === 'fail' || c.status === 'error') ? 'fail' : 'pass';
    return { checks, findings, status };
  }

  return { catalogueOf, linesOf, classify, isHeading, layout, gateFaults, structuralFindings, blankFinding, recommend, recompute, GATE, LIVE };
});
