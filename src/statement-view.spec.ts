import { expect } from 'chai';
import { buildStatementView } from './statement-view';

const BS = 'type-bs';
const IS = 'type-is';
const types = [
    { id: IS, description: 'Income Statement' },
    { id: BS, description: 'Balance Sheet' },
];
// A small balance-sheet catalogue: two roots, one with a child and grandchild.
const mappings: any[] = [
    { id: 'M-EQL', description: 'Total Equity and Liabilities', parent_id: null, financial_statement_type_id: BS, is_positive: true },
    { id: 'M-ASSETS', description: 'Total Assets', parent_id: null, financial_statement_type_id: BS, is_positive: true },
    { id: 'M-CUR', description: 'Current Assets', parent_id: 'M-ASSETS', financial_statement_type_id: BS, is_positive: true },
    { id: 'M-CASH', description: 'Cash', parent_id: 'M-CUR', financial_statement_type_id: BS, is_positive: true },
    { id: 'M-PPE', description: 'Property, Plant and Equipment', parent_id: 'M-ASSETS', financial_statement_type_id: BS, is_positive: true },
    { id: 'M-REV', description: 'Revenue', parent_id: null, financial_statement_type_id: IS, is_positive: null },
    { id: 'M-NOMAP', description: 'No map', parent_id: 'M-NOMAP', financial_statement_type_id: BS, is_positive: null },
];

function fin(): any {
    return {
        lines: [
            { id: 'l-cash', sequence: 2, description: 'Cash at bank', financial_statement_type_id: BS, financial_statement_line_mapping_id: 'm-cash',
              facts: [{ year: '2024-12-31', value: '100.5' }, { year: '2023-12-31', value: 90 }],
              notes: [{ number: '3', text: 'Cash breakdown', lines: [{ sequence: 1, financial_statement_line_mapping_id: 'M-CASH', facts: [{ year: '2024-12-31', value: 100.5 }] }] }] },
            { id: 'l-total', sequence: 3, description: 'Total assets', financial_statement_type_id: BS, financial_statement_line_mapping_id: 'M-ASSETS', facts: [{ year: '2024-12-31', value: 100.5 }], notes: [] },
            { id: 'l-sundry', sequence: 4, description: 'Sundry', financial_statement_type_id: BS, financial_statement_line_mapping_id: null, facts: [{ year: '2024-12-31', value: 1 }], notes: [] },
            { id: 'l-head', sequence: 1, description: 'ASSETS', financial_statement_type_id: BS, financial_statement_line_mapping_id: null, facts: [{ year: '2024-12-31', value: null }], notes: [] },
            { id: 'l-nomap', sequence: 5, description: 'Rounding', financial_statement_type_id: BS, financial_statement_line_mapping_id: 'M-NOMAP', facts: [{ year: '2024-12-31', value: 2 }], notes: [] },
            { id: 'l-foreign', sequence: 6, description: 'Sales', financial_statement_type_id: BS, financial_statement_line_mapping_id: 'M-REV', facts: [{ year: '2024-12-31', value: 3 }], notes: [] },
            { id: 'l-rev', sequence: 1, description: 'Turnover', financial_statement_type_id: IS, financial_statement_line_mapping_id: 'M-REV', facts: [{ year: '2024-12-31', value: 5 }, { year: '2022-12-31', value: 4, deleted_date: '2024-01-01' }], notes: [] },
            { id: 'gone', sequence: 9, description: 'Deleted', financial_statement_type_id: IS, deleted_date: '2024-01-01', facts: [], notes: [] },
        ],
    };
}

describe('buildStatementView', () => {
    const view = () => buildStatementView(fin(), mappings, types);
    const bs = () => view().statements[0];

    it('stacks the statements balance sheet first', () => {
        expect(view().statements.map(s => s.type)).to.deep.equal(['Balance Sheet', 'Income Statement']);
    });

    it('lays the whole catalogue out in reading order, assets before equity and liabilities', () => {
        expect(bs().rows.map(r => `${r.kind}:${r.hint}`)).to.deep.equal([
            'line:Total Assets',
            'node:Current Assets',
            'line:Cash',
            'note:Cash',
            'node:Property, Plant and Equipment',
            'node:Total Equity and Liabilities',
            'heading:',
            'unmapped:',
            'nomap:No map',
            'unmapped:Revenue',
        ]);
    });

    it('tells a heading, a No map line and a line on another statement\'s mapping apart', () => {
        const rows = bs().rows;
        expect(rows.find(r => r.line_id === 'l-head')).to.include({ kind: 'heading', line: 'ASSETS', hint: '' });
        expect(rows.find(r => r.line_id === 'l-nomap')).to.include({ kind: 'nomap', line: 'Rounding', hint: 'No map' });
        expect(rows.find(r => r.line_id === 'l-foreign')).to.include({ kind: 'unmapped', line: 'Sales', hint: 'Revenue', mapping_id: 'M-REV' });
    });

    it('places a captured line under its node with the hint, the line text, the values and the sign', () => {
        const cash = bs().rows.find(r => r.line_id === 'l-cash')!;
        expect(cash).to.include({ kind: 'line', depth: 2, mapping_id: 'M-CASH', hint: 'Cash', line: 'Cash at bank', sign: 'positive', used: true });
        expect(cash.hint_path).to.equal('Total Assets > Current Assets > Cash');
        expect(cash.values).to.deep.equal({ '2024-12-31': 100.5, '2023-12-31': 90 });
    });

    it('marks a node used when something is captured beneath it, and unused otherwise', () => {
        const node = (hint: string) => bs().rows.find(r => r.kind === 'node' && r.hint === hint)!;
        expect(node('Current Assets').used).to.equal(true);
        expect(node('Current Assets').has_children).to.equal(true);
        expect(node('Property, Plant and Equipment').used).to.equal(false);
        expect(node('Total Equity and Liabilities').used).to.equal(false);
    });

    it('lists an unmapped captured line after the structure', () => {
        const sundry = bs().rows.find(r => r.line_id === 'l-sundry')!;
        expect(sundry).to.include({ kind: 'unmapped', line: 'Sundry', hint: '', mapping_id: null });
    });

    it('carries note lines under their parent line, one level deeper', () => {
        const note = bs().rows.find(r => r.kind === 'note')!;
        expect(note).to.include({ depth: 3, hint: 'Cash', line: '3 Cash breakdown', mapping_id: 'M-CASH' });
        expect(note.values).to.deep.equal({ '2024-12-31': 100.5 });
    });

    it('keeps the captured order on every line so the statement can be shown as captured', () => {
        const rows = bs().rows;
        const seq = (id: string) => rows.find(r => r.line_id === id)!.sequence;
        expect([seq('l-head'), seq('l-cash'), seq('l-total'), seq('l-sundry'), seq('l-nomap'), seq('l-foreign')]).to.deep.equal([1, 2, 3, 4, 5, 6]);
        expect(rows.find(r => r.kind === 'note')!.sequence).to.equal(2);
        expect(rows.filter(r => r.kind === 'node').every(r => r.sequence === null)).to.equal(true);
    });

    it('collects the periods newest first, ignoring deleted facts and deleted lines', () => {
        const v = view();
        expect(v.periods).to.deep.equal(['2024-12-31', '2023-12-31']);
        expect(v.statements[1].rows.map(r => r.line)).to.deep.equal(['Turnover']);
    });
});
