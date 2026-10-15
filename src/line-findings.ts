/**
 * The findings re-keyed by the line they are about, so the UI can colour each captured line. Pure.
 *
 * A structural result's details ARE lines (ValidatedFinancialStatementLine), so they carry the line
 * id. A publish-gate fault names a total by mapping id and description instead; the UI matches on
 * whichever key it has. A `missing_total` fault is about a node nothing was captured against, and
 * the statement view lays the whole catalogue out, so it lands on that node's row.
 */
import { BalanceFault, ValidationResult } from '@modules/financial-capture/services/financial-validator';
import { LineFinding } from './types';

export function collectLineFindings(faults: BalanceFault[], results: ValidationResult[]): LineFinding[] {
    const out: LineFinding[] = [];

    for (const f of faults) {
        out.push({
            line_id: null,
            mapping_id: f.mapping_id ?? null,
            description: f.line_description ?? f.mapping_description ?? '',
            statement_type: f.statement_type ?? null,
            check: 'Publish gate (totals balance)',
            severity: 'fail',
            message: f.message,
            period: f.period,
            expected: f.expected,
            actual: f.actual,
        });
    }

    for (const r of results) {
        if (r.valid) continue;
        const severity = r.severity === 'advice' ? 'advice' : 'fail';
        for (const d of (r.details ?? []) as any[]) {
            // Missing Subtotals repeats the gate's missing_total faults without the mapping id.
            if (r.label === 'Missing Subtotals') continue;
            out.push({
                line_id: d?.id ?? null,
                mapping_id: d?.financial_statement_line_mapping_id ?? null,
                description: d?.description ?? '',
                statement_type: d?.statementType ?? null,
                check: r.label,
                severity,
                message: d?.validationError ?? d?.description ?? r.description ?? r.label,
            });
        }
    }

    return out;
}
