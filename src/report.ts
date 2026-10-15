/** Renderers for one audited statement: the Markdown report, the summary row, the file path. Pure. */
import { CheckResult, StatementAudit } from './types';

export const SUMMARY_COLUMNS = [
    'organisation_id', 'client_id', 'client_name', 'obligor_key', 'statement_id', 'description', 'period',
    'version', 'company_type', 'publish_date', 'creator', 'date_created', 'status', 'failed_checks', 'gate_faults', 'unmapped_lines',
    'sign_faults', 'missing_totals', 'translatable', 'ai_source_score', 'error', 'report',
] as const;

export type SummaryRow = Record<typeof SUMMARY_COLUMNS[number], string | number>;

/** Header map for toCSV: csv-writer only emits a header line for id/title pairs, not bare keys. */
export const SUMMARY_HEADER = Object.fromEntries(SUMMARY_COLUMNS.map(c => [c, c])) as Record<typeof SUMMARY_COLUMNS[number], string>;

const BADGE: Record<CheckResult['status'], string> = {
    pass: 'PASS', fail: 'FAIL', advice: 'ADVICE', error: 'ERROR', skipped: 'SKIPPED',
};

const cell = (s: string): string => (s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function renderMarkdown(a: StatementAudit): string {
    const h = a.header;
    const out: string[] = [];

    out.push(`# ${h.client_name || h.client_id} — ${h.description || 'Financial statement'} (${h.period || 'no period'}, v${h.version})`);
    out.push('');
    out.push(`**Status: ${a.status.toUpperCase()}**`);
    out.push('');
    out.push('| Field | Value |');
    out.push('|---|---|');
    out.push(`| Client | ${cell(h.client_name)} |`);
    out.push(`| Obligor key | ${cell(h.obligor_key)} |`);
    out.push(`| Organisation | ${h.organisation_id} |`);
    out.push(`| Statement id | ${h.id} |`);
    out.push(`| Company type | ${cell(h.company_type)} (${h.company_type_id}) |`);
    out.push(`| Period | ${h.period} |`);
    out.push(`| Previous period | ${h.previous_period || 'n/a'} |`);
    out.push(`| Created by | ${cell(h.creator) || 'unknown'}${h.created_by_xero ? ' (via Xero)' : ''} on ${h.date_created || 'unknown date'} |`);
    out.push(`| Published on | ${h.publish_date} (publisher not recorded by the app) |`);
    out.push(`| Lines | ${h.line_count} |`);
    out.push('');

    if (a.error) {
        out.push(`> Audit error: ${cell(a.error)}`);
        out.push('');
    }

    out.push('## Checks');
    out.push('');
    out.push('| Check | Status | Findings |');
    out.push('|---|---|---|');
    a.checks.forEach(c => {
        const findings = c.details.length === 0 ? '—'
            : c.details.length === 1 ? cell(c.details[0])
            : `${c.details.length} findings`;
        out.push(`| ${cell(c.label)} | ${BADGE[c.status]} | ${findings} |`);
    });
    out.push('');

    const withRecs = a.checks.filter(c => c.recommendations.length > 0);
    if (withRecs.length > 0) {
        out.push('## Recommended fixes');
        out.push('');
        out.push('Recommendations only. Nothing below has been applied.');
        out.push('');
        withRecs.forEach(c => {
            out.push(`### ${c.label} — ${BADGE[c.status]}`);
            out.push('');
            c.recommendations.forEach(r => out.push(`- ${r}`));
            out.push('');
        });
    }

    // Only what needs attention. A passing check's detail ("2 rows translated") is not a finding.
    const withDetails = a.checks.filter(c => c.details.length > 0 && c.status !== 'pass' && c.status !== 'skipped');
    if (withDetails.length > 0) {
        out.push('<details>');
        out.push('<summary>All findings</summary>');
        out.push('');
        withDetails.forEach(c => {
            out.push(`**${c.label}** (${BADGE[c.status]})`);
            out.push('');
            c.details.forEach(d => out.push(`- ${d}`));
            out.push('');
        });
        out.push('</details>');
        out.push('');
    }

    return out.join('\n');
}

export function summaryRow(a: StatementAudit): SummaryRow {
    const h = a.header;
    const m = a.metrics;
    return {
        organisation_id: h.organisation_id,
        client_id: h.client_id,
        client_name: h.client_name,
        obligor_key: h.obligor_key,
        statement_id: h.id,
        description: h.description,
        period: h.period,
        version: h.version,
        company_type: h.company_type,
        publish_date: h.publish_date,
        creator: h.created_by_xero ? `${h.creator} (via Xero)` : h.creator,
        date_created: h.date_created,
        status: a.status,
        failed_checks: a.checks.filter(c => c.status === 'fail' || c.status === 'error').map(c => c.label).join('; '),
        gate_faults: m.gate_faults,
        unmapped_lines: m.unmapped_lines,
        sign_faults: m.sign_faults,
        missing_totals: m.missing_totals,
        translatable: m.translatable == null ? '' : (m.translatable ? 'yes' : 'no'),
        ai_source_score: m.ai_source_score,
        error: a.error ?? '',
        report: reportRelativePath(h),
    };
}

export interface PathParts {
    id: string;
    organisation_id: string;
    client_id: string;
    obligor_key?: string;
    period: string;
    version: number;
}

/** `<org>/<obligor|client>/<period>_v<version>_<id8>.md`, every segment made filesystem-safe. */
export function reportRelativePath(p: PathParts): string {
    const safe = (s: string | undefined): string =>
        ((s ?? '').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[_.]+|[_.]+$/g, '')) || 'unknown';
    const client = safe(p.obligor_key || p.client_id);
    return `${safe(p.organisation_id)}/${client}/${safe(p.period || 'no-period')}_v${p.version}_${(p.id ?? '').slice(0, 8).toLowerCase()}.md`;
}
