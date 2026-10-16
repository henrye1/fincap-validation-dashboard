/**
 * The browser-side statement logic (ui/gate.js) that the editor re-validates with. The rules are
 * the publish gate's; the whole-run comparison against the audit (223 statements) is in the README.
 */
import { expect } from 'chai';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const FA = require(path.join(__dirname, '..', 'ui', 'gate.js'));

const BS = 'Balance Sheet';
const node = (depth: number, hint: string, hint_path: string, has_children: boolean, mapping_id: string, extra: any = {}) =>
    ({ kind: 'node', depth, mapping_id, hint, hint_path, has_children, used: false, line_id: null, line: '', values: {}, sign: null, sequence: null, ...extra });
const line = (depth: number, hint: string, hint_path: string, has_children: boolean, mapping_id: string, line_id: string, text: string, values: any, sequence: number, extra: any = {}) =>
    ({ kind: 'line', depth, mapping_id, hint, hint_path, has_children, used: true, line_id, line: text, values, sign: null, sequence, ...extra });

/* A balance sheet the way statement-view.ts lays one out: assets root with a current-assets subtotal,
 * a fixed-assets node with a line under it but no total, the E&L root, a heading, a No map line. */
function rows() {
    return [
        line(0, 'Total Assets', 'Total Assets', true, 'M-TA', 'L-TA', 'Total assets', { '2024': 300, '2023': 200 }, 6),
        line(1, 'Current Assets', 'Total Assets > Current Assets', true, 'M-CA', 'L-CA', 'Total current assets', { '2024': 100, '2023': 80 }, 3),
        line(2, 'Cash', 'Total Assets > Current Assets > Cash', false, 'M-CASH', 'L-CASH', 'Bank', { '2024': 60, '2023': 50 }, 1, { sign: 'positive' }),
        line(2, 'Debtors', 'Total Assets > Current Assets > Debtors', false, 'M-DEB', 'L-DEB', 'Receivables', { '2024': 40, '2023': 30 }, 2, { sign: 'positive' }),
        node(1, 'Fixed Assets', 'Total Assets > Fixed Assets', true, 'M-FA', { used: true }),
        line(2, 'PPE', 'Total Assets > Fixed Assets > PPE', false, 'M-PPE', 'L-PPE', 'Property', { '2024': 200, '2023': 120 }, 5, { sign: 'positive' }),
        node(2, 'Goodwill', 'Total Assets > Fixed Assets > Goodwill', false, 'M-GW'),
        line(0, 'Equity and Liabilities', 'Equity and Liabilities', true, 'M-EL', 'L-EL', 'Total equity and liabilities', { '2024': 300, '2023': 190 }, 9),
        line(1, 'Equity', 'Equity and Liabilities > Equity', false, 'M-EQ', 'L-EQ', 'Equity', { '2024': 300, '2023': 190 }, 8),
        { kind: 'heading', depth: 0, mapping_id: null, hint: '', hint_path: '', has_children: false, used: true, line_id: 'L-HEAD', line: 'ASSETS', values: { '2024': null, '2023': null }, sign: null, sequence: 4 },
        { kind: 'nomap', depth: 0, mapping_id: 'M-NOMAP', hint: 'No map', hint_path: 'No map', has_children: false, used: true, line_id: 'L-NM', line: 'Rounding', values: { '2024': 1, '2023': 1 }, sign: null, sequence: 7 },
    ];
}

describe('ui/gate.js', () => {
    it('rebuilds the view rows from the lines and the catalogue', () => {
        const r = rows();
        const cat = FA.catalogueOf(r);
        expect(cat.order).to.deep.equal(['Total Assets', 'Total Assets > Current Assets', 'Total Assets > Current Assets > Cash', 'Total Assets > Current Assets > Debtors',
            'Total Assets > Fixed Assets', 'Total Assets > Fixed Assets > PPE', 'Total Assets > Fixed Assets > Goodwill', 'Equity and Liabilities', 'Equity and Liabilities > Equity']);
        expect(cat.noMapId).to.equal('M-NOMAP');
        const again = FA.layout(FA.linesOf(r), cat);
        expect(JSON.parse(JSON.stringify(again))).to.deep.equal(r);
    });

    it('keeps the captured order on the lines and attaches notes to the line they follow', () => {
        const r = rows();
        r.splice(3, 0, { kind: 'note', depth: 3, mapping_id: 'M-CASH', hint: 'Cash', hint_path: 'Total Assets > Current Assets > Cash', has_children: false, used: true, line_id: 'N-1', line: '1 Cash note', values: { '2024': 60 }, sign: 'positive', sequence: 1 });
        const lines = FA.linesOf(r);
        expect(lines.map((l: any) => l.sequence)).to.deep.equal([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(lines[0].notes).to.have.length(1);
        expect(FA.layout(lines, FA.catalogueOf(r))[3]).to.include({ kind: 'note', depth: 3, line: '1 Cash note', sequence: 1 });
    });

    it('runs the three publish-gate rules with the gate\'s tolerance and messages', () => {
        const r = rows();
        const faults = FA.gateFaults(FA.linesOf(r), FA.catalogueOf(r), BS);
        expect(faults.map((f: any) => `${f.rule}|${f.period}|${f.message}`)).to.have.members([
            // Rule 1 reads the DIRECT children: Fixed Assets has no line, so Total assets is compared with Current Assets alone.
            'total_vs_children|2024|"Total assets" is 300 but its captured lines total 100 for 2024',
            'total_vs_children|2023|"Total assets" is 200 but its captured lines total 80 for 2023',
            'missing_total|2024|"Fixed Assets" has no captured total for 2024, but the lines under it total 200',
            'missing_total|2023|"Fixed Assets" has no captured total for 2023, but the lines under it total 120',
            'assets_vs_equity_and_liabilities|2023|Assets total 200 but equity and liabilities total 190 for 2023',
        ]);
        // Rule 1 within tolerance: a 1-unit rounding difference is not a fault.
        const r2 = rows(); (r2[1] as any).values = { '2024': 101, '2023': 80 };
        expect(FA.gateFaults(FA.linesOf(r2), FA.catalogueOf(r2), BS).filter((f: any) => /current assets/i.test(f.message))).to.have.length(0);
        (r2[1] as any).values = { '2024': 102, '2023': 80 };
        expect(FA.gateFaults(FA.linesOf(r2), FA.catalogueOf(r2), BS).map((f: any) => f.message)).to.include('"Total current assets" is 102 but its captured lines total 100 for 2024');
    });

    it('does not gate the cash flow statement, apart from nothing to compare', () => {
        const r = rows();
        expect(FA.gateFaults(FA.linesOf(r), FA.catalogueOf(r), 'Cash Flow Statement').map((f: any) => f.rule)).to.deep.equal(['assets_vs_equity_and_liabilities']);
    });

    it('flags unmapped valued lines, wrong signs and a placeholder first line like the app does', () => {
        const r = rows();
        (r[2] as any).values = { '2024': -5, '2023': 50 };
        r.push({ kind: 'unmapped', depth: 0, mapping_id: null, hint: '', hint_path: '', has_children: false, used: true, line_id: 'L-X', line: 'Sundry', values: { '2024': 3, '2023': 0 }, sign: null, sequence: 10 });
        const cat = FA.catalogueOf(r), lines = FA.linesOf(r);
        const s = FA.structuralFindings(lines, cat, BS);
        expect(s.map((f: any) => `${f.check}: ${f.message}`)).to.have.members(['Chart of Accounts Mapping: Sundry is unmapped', 'Mapping Cardinality: Bank must be Positive (2024)']);
        expect(FA.blankFinding([{ lines, cat, type: BS }])).to.deep.equal([]);
        // Move the No map line to the front: the statement now starts with a placeholder.
        (lines.find((l: any) => l.line_id === 'L-NM') as any).sequence = 0;
        lines.sort((a: any, b: any) => a.sequence - b.sequence);
        expect(FA.blankFinding([{ lines, cat, type: BS }])[0].message).to.equal('The first line, "Rounding", is not mapped to a chart-of-accounts entry');
    });

    it('recomputes the live checks over the audit\'s and keeps the ones it cannot run', () => {
        const r = rows();
        const audit = {
            status: 'fail',
            checks: [
                { id: 'publish_gate', label: 'Publish gate (totals balance)', status: 'fail', details: ['old'], recommendations: ['old'] },
                { id: 'missing_subtotals', label: 'Missing Subtotals', status: 'fail', details: ['old'], recommendations: [] },
                { id: 'cash_ties', label: 'Cash Ties', status: 'advice', details: ['Opening cash differs'], recommendations: ['Advisory'] },
            ],
            line_findings: [{ line_id: 'L-CASH', mapping_id: 'M-CASH', description: 'Bank', statement_type: 'Cash Flow Statement', check: 'Cash Ties', severity: 'advice', message: 'Opening cash differs' }],
        };
        const sts = [{ type_id: 'bs', type: BS, cat: FA.catalogueOf(r), lines: FA.linesOf(r) }];
        const rc = FA.recompute(audit, sts);
        const by = (id: string) => rc.checks.find((c: any) => c.id === id);
        expect(by('publish_gate').status).to.equal('fail');
        expect(by('publish_gate').details).to.have.length(5);
        expect(by('publish_gate').recommendations.find((r: string) => r.startsWith('Capture'))).to.match(/^Capture a total line for "Fixed Assets" \(Balance Sheet\) for 20\d\d; its captured lines sum to/);
        expect(by('missing_subtotals').details).to.deep.equal(['Children of "Fixed Assets" are captured but no total line exists']);
        expect(by('cash_ties')).to.deep.equal(audit.checks[2]);
        expect(by('chart_of_accounts_mapping').status).to.equal('pass');
        expect(rc.findings.filter((f: any) => f.check === 'Cash Ties')).to.have.length(1);
        expect(rc.status).to.equal('fail');

        // Capture the missing total and fix equity: everything the browser can check passes.
        sts[0].lines.push({ key: 'new-1', line_id: null, line: 'Fixed assets', mapping_id: 'M-FA', hint: 'Fixed Assets', hint_path: 'Total Assets > Fixed Assets', sign: null, values: { '2024': 200, '2023': 120 }, sequence: 5.5, notes: [] });
        (sts[0].lines.find((l: any) => l.line_id === 'L-EQ') as any).values = { '2024': 300, '2023': 200 };
        (sts[0].lines.find((l: any) => l.line_id === 'L-EL') as any).values = { '2024': 300, '2023': 200 };
        const fixed = FA.recompute(audit, sts);
        expect(fixed.checks.filter((c: any) => c.live).every((c: any) => c.status === 'pass')).to.equal(true);
        expect(fixed.status).to.equal('pass'); // the advisory does not fail a statement
        expect(FA.layout(sts[0].lines, sts[0].cat).find((x: any) => x.hint === 'Fixed Assets')).to.include({ kind: 'line', line: 'Fixed assets', key: 'new-1' });
    });
});
