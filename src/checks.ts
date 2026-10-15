/**
 * Runs every check over one loaded statement. Each check is isolated: one that throws becomes an
 * `error` row in that report and never aborts the run or the other checks.
 */
import { FinancialStatement } from '@modules/financial-capture/entities/FinancialStatement';
import { FinancialStatementSourceData } from '@modules/financial-capture/entities/FinancialStatementSourceData';
import { FinancialRatioAnalysis, SourceStatementSection } from '@modules/financial-capture/services/financial-validator';
import { RequestContextStore } from '@shared/middleware/request-context';
import { AuditDeps } from './services';
import { CheckResult, LineFinding, StatementAudit, StatementHeader, emptyMetrics } from './types';
import { fmt, recommendForFault, recommendForResult, recommendForTranslatorError } from './recommendations';
import { collectLineFindings } from './line-findings';

const AUDIT_USER = 'fincap-audit@local';
const CORPORATE = 5;

export function errMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

const errored = (id: string, label: string, err: unknown): CheckResult =>
    ({ id, label, status: 'error', details: [errMessage(err)], recommendations: [] });

const skipped = (id: string, label: string, why: string): CheckResult =>
    ({ id, label, status: 'skipped', details: [why], recommendations: [] });

const slug = (label: string): string => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/**
 * The shape listFinancialStatementsByIds hands the translator on the publish path: deleted lines
 * and deleted note lines removed, facts untouched. Shallow copies — the loaded entity is left alone
 * for the validators, which filter for themselves.
 */
export function stripDeletedForTranslation(fin: FinancialStatement): FinancialStatement {
    return {
        ...fin,
        lines: (fin.lines ?? [])
            .filter(line => !line.deleted_date)
            .map(line => ({
                ...line,
                notes: (line.notes ?? []).map(note => ({
                    ...note,
                    lines: (note.lines ?? []).filter(noteLine => !noteLine.deleted_date),
                })),
            })),
    } as FinancialStatement;
}

export async function runChecks(
    fin: FinancialStatement,
    header: StatementHeader,
    deps: AuditDeps,
    opts: { ai: boolean },
): Promise<StatementAudit> {
    const checks: CheckResult[] = [];
    const metrics = emptyMetrics();
    let lineFindings: LineFinding[] = [];

    // 1. The publish gate — the only rule that blocks publishing today.
    try {
        const faults = await deps.validator.computeTotalBalanceFaults(fin);
        lineFindings = lineFindings.concat(collectLineFindings(faults, []));
        metrics.gate_faults = faults.length;
        metrics.missing_totals = faults.filter(f => f.rule === 'missing_total').length;
        checks.push({
            id: 'publish_gate',
            label: 'Publish gate (totals balance)',
            status: faults.length > 0 ? 'fail' : 'pass',
            details: faults.map(f => f.message),
            recommendations: faults.map(recommendForFault),
        });
    } catch (err) {
        checks.push(errored('publish_gate', 'Publish gate (totals balance)', err));
    }

    // 2. The structural checks the validation panel shows.
    try {
        const full = await deps.validator.validateFull(fin);
        lineFindings = lineFindings.concat(collectLineFindings([], full.results));
        for (const r of full.results) {
            const details = ((r.details ?? []) as any[])
                .map(d => d?.validationError ?? d?.description ?? '')
                .filter(Boolean);
            if (r.label === 'Chart of Accounts Mapping') metrics.unmapped_lines = details.length;
            if (r.label === 'Mapping Cardinality') metrics.sign_faults = details.length;
            checks.push({
                id: slug(r.label),
                label: r.label,
                status: r.valid ? 'pass' : (r.severity === 'advice' ? 'advice' : 'fail'),
                details,
                recommendations: recommendForResult(r),
            });
        }
    } catch (err) {
        checks.push(errored('structural', 'Structural checks', err));
    }

    // 3. Can the ratio translator consume it? The same pipeline publish runs, in memory only.
    const periods = [header.period, header.previous_period].filter(Boolean);
    try {
        const forTranslation = stripDeletedForTranslation(fin);
        const rows = await RequestContextStore.run(
            { organisationId: fin.organisation_id, auth0Id: null, token: null, tenantId: null, user: { email: AUDIT_USER } },
            () => deps.translator.translateToRiskFinancials([forTranslation], null as any, fin.organisation_id, false, fin.company_type_id),
        );
        const ok = Array.isArray(rows) && rows.length > 0;
        metrics.translatable = ok;
        checks.push({
            id: 'ratios_translatable',
            label: 'Ratios can be computed',
            status: ok ? 'pass' : 'fail',
            details: ok ? [`${rows.length} period row(s) translated`] : ['The translator returned no rows'],
            recommendations: ok ? [] : ['Map at least one line that holds a value for each period.'],
        });
    } catch (err) {
        metrics.translatable = false;
        const message = errMessage(err);
        checks.push({
            id: 'ratios_translatable',
            label: 'Ratios can be computed',
            status: 'fail',
            details: [message],
            recommendations: [recommendForTranslatorError(message, periods)],
        });
    }

    // 4 + 5. The AI legs, only on request.
    if (opts.ai) {
        try {
            const report = await runAiLegs(deps, fin);
            checks.push(sourceCheck(report.sourceSections));
            checks.push(ratioCheck(report.ratios, fin.company_type_id));
            metrics.ai_source_score = scoreOf(report.sourceSections);
        } catch (err) {
            checks.push(errored('ai_source_comparison', 'AI: source document comparison', err));
            checks.push(errored('ai_ratio_analysis', 'AI: ratio analysis', err));
        }
    } else {
        checks.push(skipped('ai_source_comparison', 'AI: source document comparison', 'not requested (run with --ai)'));
        checks.push(skipped('ai_ratio_analysis', 'AI: ratio analysis', 'not requested (run with --ai)'));
    }

    const status = checks.some(c => c.status === 'fail' || c.status === 'error') ? 'fail' : 'pass';
    return { header, status, checks, metrics, line_findings: lineFindings };
}

/**
 * The two AI legs of FinancialValidatorService.validateFinCapFinancialFull, without its cache write
 * (that method persists `last_validation_result`, which this audit must never do). Both legs are
 * private on the service, so they are reached by cast; the guard fails loudly if the app renames them.
 */
async function runAiLegs(
    deps: AuditDeps,
    fin: FinancialStatement,
): Promise<{ sourceSections: SourceStatementSection[] | null; ratios: FinancialRatioAnalysis[] | null }> {
    const svc: any = deps.validatorService;
    if (typeof svc.runSourceValidation !== 'function' || typeof svc.runRatioValidation !== 'function') {
        throw new Error('FinancialValidatorService no longer has runSourceValidation/runRatioValidation; update financials-auditor');
    }
    const statementTypes = await deps.refData.listFinancialStatementTypes();
    const sourceDataRepo = deps.connection.getRepository(FinancialStatementSourceData);
    const [sourceSections, ratioResult] = await Promise.all([
        svc.runSourceValidation(fin, sourceDataRepo, statementTypes) as Promise<SourceStatementSection[] | null>,
        // Returns null ratios for anything but a corporate statement.
        svc.runRatioValidation(fin, statementTypes) as Promise<{ ratios: FinancialRatioAnalysis[] | null }>,
    ]);
    return { sourceSections, ratios: ratioResult?.ratios ?? null };
}

function scoreOf(sections: SourceStatementSection[] | null): string {
    if (!sections) return '';
    const matched = sections.reduce((n, s) => n + s.matched, 0);
    const scored = sections.reduce((n, s) => n + s.scored, 0);
    return `${matched}/${scored}`;
}

/**
 * Advisory, not a failure: the scanner reads a PDF, and a mismatch is as often a reading error as a
 * capture error. The score lands in the summary so the noisy statements can still be sorted out.
 */
function sourceCheck(sections: SourceStatementSection[] | null): CheckResult {
    const id = 'ai_source_comparison';
    const label = 'AI: source document comparison';
    if (!sections) return skipped(id, label, 'no readable source document attached');

    const details: string[] = [];
    const recommendations: string[] = [];
    let mismatches = 0;

    for (const s of sections) {
        details.push(`${s.statement_type}: ${s.matched}/${s.scored} cells agree${s.scan_error ? ' (scan error)' : ''}`);
        for (const node of s.nodes) {
            for (const c of node.cells) {
                if (c.matched || (!c.scanned_found && !c.captured_found)) continue;
                mismatches++;
                const where = `"${node.path.replace(/::/g, ' > ')}" ${c.period}`;
                const scanned = c.scanned_found ? fmt(c.scanned_value) : 'not found';
                const captured = c.captured_found ? fmt(c.captured_value) : 'not captured';
                details.push(`${s.statement_type} — ${where}: document ${scanned}, captured ${captured}`);
                if (c.captured_found && !c.scanned_found) {
                    recommendations.push(`Confirm ${where}: captured ${fmt(c.captured_value)} but the document shows no such line.`);
                } else if (!c.captured_found) {
                    recommendations.push(`Capture ${where}: the document shows ${fmt(c.scanned_value)} but nothing was captured against it.`);
                } else {
                    recommendations.push(`Re-check ${where}: document shows ${fmt(c.scanned_value)}, captured ${fmt(c.captured_value)} (difference ${fmt(c.captured_value - c.scanned_value)}).`);
                }
            }
        }
    }

    return { id, label, status: mismatches > 0 ? 'advice' : 'pass', details, recommendations };
}

function ratioCheck(ratios: FinancialRatioAnalysis[] | null, companyTypeId: number): CheckResult {
    const id = 'ai_ratio_analysis';
    const label = 'AI: ratio analysis';
    if (companyTypeId !== CORPORATE) return skipped(id, label, 'corporate statements only');
    if (!ratios || ratios.length === 0) return skipped(id, label, 'the model returned no ratios');

    const details = ratios.map(r => {
        const values = Object.entries(r)
            .filter(([k, v]) => k !== 'period' && typeof v === 'number' && Number.isFinite(v))
            .map(([k, v]) => `${k}=${fmt(v as number)}`);
        return `${r.period}: ${values.join(', ') || 'no numeric ratios'}`;
    });
    return { id, label, status: 'pass', details, recommendations: [] };
}
