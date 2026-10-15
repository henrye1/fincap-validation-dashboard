/** Shapes shared by the audit runner and its renderers. Pure data — no entities, no services. */

export type CheckStatus = 'pass' | 'fail' | 'advice' | 'error' | 'skipped';
export type AuditStatus = 'pass' | 'fail';

export interface CheckResult {
    id: string;
    label: string;
    status: CheckStatus;
    /** One line per finding, as the validator phrased it. */
    details: string[];
    /** One line per suggested fix. Advice only — the audit never applies anything. */
    recommendations: string[];
}

export interface StatementHeader {
    id: string;
    organisation_id: string;
    client_id: string;
    client_name: string;
    obligor_key: string;
    description: string;
    /** yyyy-mm-dd, or '' when unknown. */
    period: string;
    previous_period: string;
    version: number;
    company_type_id: number;
    company_type: string;
    publish_date: string;
    /** The creator's email (creator_id). The app records no publisher. */
    creator: string;
    date_created: string;
    created_by_xero: boolean;
    line_count: number;
}

export interface AuditMetrics {
    gate_faults: number;
    unmapped_lines: number;
    sign_faults: number;
    missing_totals: number;
    /** Null when the check did not run. */
    translatable: boolean | null;
    /** "matched/scored" across every scanned section, or '' when the AI leg did not run. */
    ai_source_score: string;
}

/** A finding pinned to the captured line it is about, for colouring the statement view. */
export interface LineFinding {
    line_id: string | null;
    mapping_id: string | null;
    description: string;
    statement_type: string | null;
    check: string;
    severity: 'fail' | 'advice';
    message: string;
}

export interface StatementAudit {
    header: StatementHeader;
    status: AuditStatus;
    checks: CheckResult[];
    metrics: AuditMetrics;
    /** Absent when the statement could not be audited. */
    line_findings?: LineFinding[];
    /** Set when the statement could not be loaded or audited at all. */
    error?: string;
}

export function emptyMetrics(): AuditMetrics {
    return { gate_faults: 0, unmapped_lines: 0, sign_faults: 0, missing_totals: 0, translatable: null, ai_source_score: '' };
}
