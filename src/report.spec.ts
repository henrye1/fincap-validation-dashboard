import { expect } from 'chai';
import { recommendForFault, recommendForResult, recommendForTranslatorError } from './recommendations';
import { renderMarkdown, reportRelativePath, summaryRow, SUMMARY_COLUMNS } from './report';
import { StatementAudit, StatementHeader, emptyMetrics } from './types';

const header: StatementHeader = {
    id: 'ABCDEF12-3456-7890-ABCD-EF1234567890',
    organisation_id: 'org-1',
    client_id: 'client-1',
    client_name: 'Acme | Holdings',
    obligor_key: 'ACME/01',
    description: 'FY2024 audited',
    period: '2024-12-31',
    previous_period: '2023-12-31',
    version: 2,
    company_type_id: 5,
    company_type: 'Corporate',
    publish_date: '2025-02-01',
    line_count: 31,
};

function passing(): StatementAudit {
    return {
        header,
        status: 'pass',
        metrics: { ...emptyMetrics(), translatable: true },
        checks: [
            { id: 'publish_gate', label: 'Publish gate (totals balance)', status: 'pass', details: [], recommendations: [] },
            { id: 'ratios_translatable', label: 'Ratios can be computed', status: 'pass', details: ['2 period row(s) translated'], recommendations: [] },
            { id: 'ai_source_comparison', label: 'AI: source document comparison', status: 'skipped', details: ['not requested (run with --ai)'], recommendations: [] },
        ],
    };
}

function failing(): StatementAudit {
    return {
        header,
        status: 'fail',
        metrics: { gate_faults: 2, unmapped_lines: 1, sign_faults: 0, missing_totals: 1, translatable: false, ai_source_score: '' },
        checks: [
            {
                id: 'publish_gate', label: 'Publish gate (totals balance)', status: 'fail',
                details: ['"Total Assets" is 10 but its captured lines total 12 for 2024', '"Current Liabilities" has no captured total for 2024, but the lines under it total 5'],
                recommendations: ['Re-capture "Total Assets"', 'Capture a total line for "Current Liabilities"'],
            },
            { id: 'chart_of_accounts_mapping', label: 'Chart of Accounts Mapping', status: 'fail', details: ['Sundry is unmapped'], recommendations: ['Map these lines to a chart-of-accounts entry: "Sundry".'] },
            { id: 'cash_ties', label: 'Cash Ties', status: 'advice', details: ['Cash differs'], recommendations: ['Advisory: confirm cash'] },
            { id: 'ratios_translatable', label: 'Ratios can be computed', status: 'error', details: ['boom'], recommendations: [] },
        ],
    };
}

describe('fincap-audit report', () => {
    describe('renderMarkdown', () => {
        it('leads with the client, the status and the statement facts', () => {
            const md = renderMarkdown(passing());
            expect(md.split('\n')[0]).to.equal('# Acme | Holdings — FY2024 audited (2024-12-31, v2)');
            expect(md).to.include('**Status: PASS**');
            expect(md).to.include('| Client | Acme \\| Holdings |');
            expect(md).to.include('| Statement id | ABCDEF12-3456-7890-ABCD-EF1234567890 |');
            expect(md).to.include('| Company type | Corporate (5) |');
        });

        it('lists every check with its badge and does not invent a recommendations section', () => {
            const md = renderMarkdown(passing());
            expect(md).to.include('| Publish gate (totals balance) | PASS | — |');
            expect(md).to.include('| Ratios can be computed | PASS | 2 period row(s) translated |');
            expect(md).to.include('| AI: source document comparison | SKIPPED | not requested (run with --ai) |');
            expect(md).to.not.include('## Recommended fixes');
            expect(md).to.not.include('<details>');
        });

        it('keeps passing and skipped checks out of the findings block', () => {
            const md = renderMarkdown(failing());
            const block = md.slice(md.indexOf('<details>'));
            expect(block).to.include('**Publish gate (totals balance)** (FAIL)');
            expect(block).to.include('**Cash Ties** (ADVICE)');
            expect(block).to.include('**Ratios can be computed** (ERROR)');
            expect(block).to.not.include('(PASS)');
            expect(block).to.not.include('(SKIPPED)');
        });

        it('renders recommendations per failed check and the full findings in a collapsed block', () => {
            const md = renderMarkdown(failing());
            expect(md).to.include('**Status: FAIL**');
            expect(md).to.include('| Publish gate (totals balance) | FAIL | 2 findings |');
            expect(md).to.include('## Recommended fixes');
            expect(md).to.include('### Publish gate (totals balance) — FAIL');
            expect(md).to.include('- Re-capture "Total Assets"');
            expect(md).to.include('### Cash Ties — ADVICE');
            expect(md).to.include('<details>');
            expect(md).to.include('- "Current Liabilities" has no captured total for 2024, but the lines under it total 5');
            expect(md).to.include('| Ratios can be computed | ERROR | boom |');
        });

        it('surfaces an audit-level error', () => {
            const md = renderMarkdown({ ...failing(), checks: [], error: 'statement not found when loading' });
            expect(md).to.include('> Audit error: statement not found when loading');
        });
    });

    describe('summaryRow', () => {
        it('has exactly the summary columns, in order', () => {
            expect(Object.keys(summaryRow(passing()))).to.deep.equal([...SUMMARY_COLUMNS]);
        });

        it('flattens the metrics and names the failed checks', () => {
            const row = summaryRow(failing());
            expect(row.status).to.equal('fail');
            expect(row.failed_checks).to.equal('Publish gate (totals balance); Chart of Accounts Mapping; Ratios can be computed');
            expect(row.gate_faults).to.equal(2);
            expect(row.unmapped_lines).to.equal(1);
            expect(row.missing_totals).to.equal(1);
            expect(row.translatable).to.equal('no');
            expect(row.error).to.equal('');
            expect(row.report).to.equal('org-1/ACME_01/2024-12-31_v2_abcdef12.md');
        });

        it('leaves translatable blank when the check did not run', () => {
            const row = summaryRow({ ...passing(), metrics: emptyMetrics() });
            expect(row.translatable).to.equal('');
        });
    });

    describe('reportRelativePath', () => {
        it('uses org / obligor / period_version_id8 with unsafe characters replaced', () => {
            expect(reportRelativePath({ ...header })).to.equal('org-1/ACME_01/2024-12-31_v2_abcdef12.md');
        });

        it('falls back to the client id without an obligor key and to no-period without a period', () => {
            expect(reportRelativePath({ ...header, obligor_key: '', period: '' })).to.equal('org-1/client-1/no-period_v2_abcdef12.md');
        });
    });

    describe('recommendations', () => {
        it('phrases each publish-gate rule as an action', () => {
            const base = { statement_type: 'Balance Sheet', line_description: 'Total Assets', mapping_description: 'Total Assets', period: '2024', message: 'm' };
            expect(recommendForFault({ ...base, rule: 'total_vs_children', expected: 12, actual: 10, difference: -2 } as any))
                .to.equal('Re-capture "Total Assets" (Balance Sheet) for 2024: captured 10.00, the lines under it total 12.00 (difference -2.00). Correct either the total or one of its child lines.');
            expect(recommendForFault({ ...base, rule: 'assets_vs_equity_and_liabilities', expected: 12, actual: 10, difference: -2 } as any))
                .to.include('Balance the balance sheet for 2024: assets and equity-and-liabilities differ by -2.00');
            expect(recommendForFault({ ...base, rule: 'missing_total', expected: 5, actual: null, difference: null } as any))
                .to.equal('Capture a total line for "Total Assets" (Balance Sheet) for 2024; its captured lines sum to 5.00.');
        });

        it('names the lines for mapping and sign findings and says nothing for a pass', () => {
            expect(recommendForResult({ valid: true, details: [], type: 'mapping', label: 'Chart of Accounts Mapping', description: '' })).to.deep.equal([]);
            expect(recommendForResult({ valid: false, details: [{ description: 'Sundry' }, { description: 'Other' }] as any, type: 'mapping', label: 'Chart of Accounts Mapping', description: '' }))
                .to.deep.equal(['Map these lines to a chart-of-accounts entry: "Sundry", "Other".']);
            const sign = recommendForResult({ valid: false, details: [{ description: 'Revenue', validationError: 'Revenue must be Positive (2024)', suggestion: 'It may belong under Cost of sales.' }] as any, type: 'limit', label: 'Mapping Cardinality', description: '' });
            expect(sign[0]).to.equal('Revenue must be Positive (2024). It may belong under Cost of sales. Flip the sign, or move the line to the counterpart mapping if it was captured under the wrong one.');
        });

        it('maps the translator crash messages the publish path produces', () => {
            expect(recommendForTranslatorError('Error: There are no useable lines in the selected financial', ['2024-12-31']))
                .to.include('Map at least one line');
            expect(recommendForTranslatorError('Error: Please make sure your Financial has valid data', ['2024-12-31', '2023-12-31']))
                .to.include('(2024-12-31, 2023-12-31)');
            expect(recommendForTranslatorError("Cannot read properties of undefined (reading 'description')", []))
                .to.include('note line');
            expect(recommendForTranslatorError('something else', [])).to.equal('Ratios cannot be computed for this statement: something else');
        });
    });
});
