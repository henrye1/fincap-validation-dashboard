/**
 * Turns a validator finding into one sentence of advice. Pure: no DB, no services.
 *
 * Wording leans on what the capture screen already tells an operator, so a fix recommended here
 * reads the same as the panel they will see when they open the statement.
 */
import { BalanceFault, ValidationResult } from '@modules/financial-capture/services/financial-validator';

export function fmt(n: number | null | undefined): string {
    if (n == null || Number.isNaN(n)) return 'n/a';
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function recommendForFault(f: BalanceFault): string {
    const name = f.mapping_description || f.line_description;
    switch (f.rule) {
        case 'total_vs_children':
            return `Re-capture "${name}" (${f.statement_type}) for ${f.period}: captured ${fmt(f.actual)}, `
                + `the lines under it total ${fmt(f.expected)} (difference ${fmt(f.difference)}). `
                + 'Correct either the total or one of its child lines.';
        case 'assets_vs_equity_and_liabilities':
            return `Balance the balance sheet for ${f.period}: assets and equity-and-liabilities differ by ${fmt(f.difference)}. `
                + 'Look for a missing liability or equity line, or a sign error on one side.';
        case 'missing_total':
            return `Capture a total line for "${name}" (${f.statement_type}) for ${f.period}; its captured lines sum to ${fmt(f.expected)}.`;
        default:
            return f.message;
    }
}

export function recommendForResult(r: ValidationResult): string[] {
    if (r.valid) return [];
    const lines = (r.details ?? []) as any[];
    const names = lines.map(l => `"${l.description ?? ''}"`).filter(n => n !== '""');
    switch (r.label) {
        case 'No Blank Values':
            return ['Map the first non-heading line to a real chart-of-accounts entry, or remove the placeholder line. '
                + 'The statement currently starts with "No Map" or an unmapped line.'];
        case 'Chart of Accounts Mapping':
            return names.length
                ? [`Map these lines to a chart-of-accounts entry: ${names.join(', ')}.`]
                : ['Map every non-heading line to a chart-of-accounts entry.'];
        case 'Mapping Cardinality':
            return lines.map(l => `${l.validationError ?? l.description}.`
                + (l.suggestion ? ` ${l.suggestion}` : '')
                + ' Flip the sign, or move the line to the counterpart mapping if it was captured under the wrong one.');
        case 'Missing Subtotals':
            return lines.map(l => `Capture a total line for "${l.description}"`
                + (l.statementType ? ` (${l.statementType})` : '')
                + '; its child lines are captured but the total is not.');
        case 'Balance Sheet Equality':
            return ['Total Equity & Liabilities does not equal the sum of its equity and liability components. '
                + 'Re-check the listed contributing lines for a missing or mis-signed value.'];
        case 'Cash Ties':
            return ['Advisory: cash on the cash flow statement does not agree with cash on the balance sheet. '
                + 'Confirm the closing cash line on the cash flow statement.'];
        case 'Profit Ties':
            return ['Advisory: profit before tax on the cash flow statement does not agree with the income statement. '
                + 'Confirm the opening profit line on the cash flow statement.'];
        default:
            return [r.description ?? r.label];
    }
}

export function recommendForTranslatorError(message: string, periods: string[]): string {
    const m = (message ?? '').toLowerCase();
    const periodList = periods.filter(Boolean).join(', ') || 'each period';
    if (m.includes('no useable lines')) {
        return 'Map at least one line that holds a value; the ratio translator found no mapped lines with facts.';
    }
    if (m.includes('valid data') || m.includes("reading 'value'")) {
        return `Every mapped line needs a value for each period (${periodList}); the translator found a line with fewer facts than the statement has periods. Capture the missing values, 0 where there are none.`;
    }
    if (m.includes("reading 'description'")) {
        return "A note line references a mapping that is not in this company type's catalogue. Re-map the note lines.";
    }
    return `Ratios cannot be computed for this statement: ${message}`;
}
