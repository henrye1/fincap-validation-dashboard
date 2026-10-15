import { expect } from 'chai';
import { collectLineFindings } from './line-findings';

describe('collectLineFindings', () => {
    it('keys every gate fault by mapping and description, missing totals included', () => {
        const findings = collectLineFindings([
            { rule: 'total_vs_children', mapping_id: 'M1', line_description: 'Total assets', mapping_description: 'Total Assets', statement_type: 'Balance Sheet', period: '2024', expected: 2, actual: 1, difference: -1, message: 'out by 1' },
            { rule: 'missing_total', mapping_id: 'M2', line_description: 'Current Liabilities', mapping_description: 'Current Liabilities', statement_type: 'Balance Sheet', period: '2024', expected: 5, actual: null, difference: null, message: 'no total' },
        ] as any, []);
        expect(findings).to.deep.equal([
            { line_id: null, mapping_id: 'M1', description: 'Total assets', statement_type: 'Balance Sheet', check: 'Publish gate (totals balance)', severity: 'fail', message: 'out by 1' },
            { line_id: null, mapping_id: 'M2', description: 'Current Liabilities', statement_type: 'Balance Sheet', check: 'Publish gate (totals balance)', severity: 'fail', message: 'no total' },
        ]);
    });

    it('keys a structural detail by line id with the result severity', () => {
        const findings = collectLineFindings([], [
            { valid: true, details: [{ id: 'ok' }], type: 'mapping', label: 'Chart of Accounts Mapping', description: '' },
            { valid: false, details: [{ id: 'l1', description: 'Sundry', financial_statement_line_mapping_id: null }], type: 'mapping', label: 'Chart of Accounts Mapping', description: 'must map' },
            { valid: false, severity: 'advice', details: [{ id: 'l2', description: 'Cash', financial_statement_line_mapping_id: 'M9', statementType: 'Cash Flow Statement', validationError: 'Cash differs' }], type: 'equal', label: 'Cash Ties', description: '' },
            { valid: false, details: [{ description: 'Current Liabilities', statementType: 'Balance Sheet' }], type: 'mapping', label: 'Missing Subtotals', description: '' },
        ] as any);
        expect(findings).to.deep.equal([
            { line_id: 'l1', mapping_id: null, description: 'Sundry', statement_type: null, check: 'Chart of Accounts Mapping', severity: 'fail', message: 'Sundry' },
            { line_id: 'l2', mapping_id: 'M9', description: 'Cash', statement_type: 'Cash Flow Statement', check: 'Cash Ties', severity: 'advice', message: 'Cash differs' },
        ]);
    });
});
