/**
 * financials-auditor — READ-ONLY audit of every PUBLISHED financial statement in a database.
 *
 * Runs the app's own validations (publish gate, structural checks, ratio translatability, and on
 * request the Gemini source-document comparison and ratio analysis) and writes one Markdown report
 * per statement plus summary.csv / run.json. Recommendations only — nothing is written to the DB.
 *
 * Start it through run.js (which wires module resolution and ts-node); see README.md:
 *
 *   node run.js audit --db aprs_za_abl_db --limit 5          # smoke
 *   node run.js audit --db aprs_za_abl_db                    # everything
 *   node run.js audit --db aprs_za_abl_db --out <dir> --resume   # continue an interrupted run
 *   node run.js audit --db aprs_za_abl_db --ids <id>,<id> --ai
 *
 * Flags: --db <name>  --org <id>  --client <id>  --ids a,b,c  --limit N  --ai  --out <dir>  --resume
 *        --concurrency N (default 4; 2 with --ai)
 * Connection and keys come from financials-auditor/.env (copy .env.example).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { createConnection, Connection } from 'typeorm';
import { FinancialStatement } from '@modules/financial-capture/entities/FinancialStatement';
import { FinancialStatementCompanyTypeDescriptions } from '@modules/financial-capture/models/FinancialStatementCompanyType.Enum';
import { mapWithConcurrency } from '@shared/util/concurrency';
import { toCSV } from '@shared/util/array-to-csv';
import { buildDeps } from './services';
import { errMessage, runChecks } from './checks';
import { renderMarkdown, reportRelativePath, summaryRow, SUMMARY_HEADER, SummaryRow } from './report';
import { StatementAudit, StatementHeader, emptyMetrics } from './types';
import { buildStatementView, StatementView } from './statement-view';

interface Args {
    db: string;
    org?: string;
    client?: string;
    ids?: string[];
    limit?: number;
    ai: boolean;
    out: string;
    resume: boolean;
    concurrency: number;
}

interface Target {
    id: string;
    client_id: string;
    organisation_id: string;
    period: string;
    version: number;
}

interface ClientRow { id: string; company_name: string; obligor_key: string; }

const PACKAGE_ROOT = path.join(__dirname, '..');
const APP_ROOT = process.env.ANCHORPOINT_TS || path.join(PACKAGE_ROOT, '..', 'anchorpoint-suite', 'anchorpoint-ts');

/** Connection options from this package's own .env — the app's ormconfig/.env.secrets are not read. */
function connectionOptions(db: string): any {
    const env = process.env;
    const missing = ['TYPEORM_HOST', 'TYPEORM_USERNAME', 'TYPEORM_PASSWORD'].filter(k => !env[k]);
    if (missing.length) throw new Error(`missing ${missing.join(', ')} in financials-auditor/.env (copy .env.example)`);
    return {
        type: 'mssql',
        host: env.TYPEORM_HOST,
        port: parseInt(env.TYPEORM_PORT ?? '1433', 10),
        database: db,
        username: env.TYPEORM_USERNAME,
        password: env.TYPEORM_PASSWORD,
        logging: false,
        synchronize: false,
        migrationsRun: false,
        connectionTimeout: 60000 * 5,
        requestTimeout: 60000 * 5,
        pool: { max: 8, min: 1, idleTimeoutMillis: 30000 },
        // The app's entities, read from its source; ts-node compiles them on load.
        entities: [`${APP_ROOT}/src/modules/**/entities/*.ts`],
        options: {
            enableArithAbort: true,
            trustServerCertificate: env.TYPEORM_TRUST_SERVER_CERT === 'true',
        },
    };
}

function usage(): never {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
    process.exit(0);
}

function parseArgs(argv: string[]): Args {
    const args: Args = { db: process.env.AUDIT_DB || 'aprs_za_abl_db', ai: false, out: '', resume: false, concurrency: 0 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = (): string => {
            const v = argv[++i];
            if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
            return v;
        };
        switch (a) {
            case '--db': args.db = next(); break;
            case '--org': args.org = next().toLowerCase(); break;
            case '--client': args.client = next().toLowerCase(); break;
            case '--ids': args.ids = next().split(',').map(s => s.trim().toLowerCase()).filter(Boolean); break;
            case '--limit': args.limit = parseInt(next(), 10); break;
            case '--ai': args.ai = true; break;
            case '--out': args.out = next(); break;
            case '--resume': args.resume = true; break;
            case '--concurrency': args.concurrency = parseInt(next(), 10); break;
            case '--help': case '-h': usage();
            default: throw new Error(`unknown argument ${a} (try --help)`);
        }
    }
    if (!args.db) throw new Error('--db is required');
    if (args.limit !== undefined && !(args.limit > 0)) throw new Error('--limit must be a positive number');
    if (!(args.concurrency > 0)) args.concurrency = args.ai ? 2 : 4;
    if (args.ai) args.concurrency = Math.min(args.concurrency, 2);
    if (!args.out) args.out = path.join(PACKAGE_ROOT, 'audit-output', args.db, stamp());
    return args;
}

function stamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function isoDate(v: any): string {
    if (!v) return '';
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
    const s = String(v);
    return s.length >= 10 ? s.slice(0, 10) : s;
}

async function selectTargets(connection: Connection, args: Args): Promise<Target[]> {
    const where: string[] = ['fs.publish_date IS NOT NULL', 'fs.deleted_date IS NULL'];
    const params: any[] = [];
    if (args.org) { where.push(`fs.organisation_id = @${params.length}`); params.push(args.org); }
    if (args.client) { where.push(`fs.client_id = @${params.length}`); params.push(args.client); }
    if (args.ids?.length) {
        const slots = args.ids.map(id => { params.push(id); return `@${params.length - 1}`; });
        where.push(`fs.id IN (${slots.join(', ')})`);
    }
    const top = args.limit ? `TOP (${args.limit}) ` : '';
    const sql = `SELECT ${top}
            LOWER(CONVERT(varchar(36), fs.id)) AS id,
            LOWER(CONVERT(varchar(36), fs.client_id)) AS client_id,
            LOWER(CONVERT(varchar(36), fs.organisation_id)) AS organisation_id,
            CONVERT(varchar(10), fs.period, 23) AS period,
            fs.version
        FROM financial_statement fs
        WHERE ${where.join(' AND ')}
        ORDER BY fs.organisation_id, fs.client_id, fs.period, fs.version`;
    return connection.query(sql, params);
}

async function loadClients(connection: Connection, clientIds: string[]): Promise<Map<string, ClientRow>> {
    const unique = [...new Set(clientIds.filter(Boolean))];
    const out = new Map<string, ClientRow>();
    for (let i = 0; i < unique.length; i += 500) {
        const chunk = unique.slice(i, i + 500);
        const slots = chunk.map((_, j) => `@${j}`).join(', ');
        const rows: ClientRow[] = await connection.query(
            `SELECT LOWER(CONVERT(varchar(36), id)) AS id, company_name, obligor_key FROM clients WHERE id IN (${slots})`,
            chunk,
        );
        rows.forEach(r => out.set(r.id, r));
    }
    return out;
}

function buildHeader(fin: FinancialStatement, client: ClientRow | undefined): StatementHeader {
    const companyTypeId = fin.company_type_id;
    return {
        id: (fin.id ?? '').toLowerCase(),
        organisation_id: (fin.organisation_id ?? '').toLowerCase(),
        client_id: (fin.client_id ?? '').toLowerCase(),
        client_name: client?.company_name ?? '',
        obligor_key: client?.obligor_key ?? '',
        description: fin.description ?? '',
        period: isoDate(fin.period),
        previous_period: isoDate(fin.previous_period),
        version: fin.version,
        company_type_id: companyTypeId,
        company_type: (FinancialStatementCompanyTypeDescriptions as any)[companyTypeId] ?? String(companyTypeId),
        publish_date: isoDate(fin.publish_date),
        line_count: (fin.lines ?? []).filter(l => !l.deleted_date).length,
    };
}

function headerFromTarget(t: Target, client: ClientRow | undefined): StatementHeader {
    return {
        id: t.id, organisation_id: t.organisation_id, client_id: t.client_id,
        client_name: client?.company_name ?? '', obligor_key: client?.obligor_key ?? '',
        description: '', period: t.period ?? '', previous_period: '', version: t.version,
        company_type_id: 0, company_type: '', publish_date: '', line_count: 0,
    };
}

function readJsonl(file: string): SummaryRow[] {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function main(): Promise<void> {
    dotenv.config({ path: path.join(PACKAGE_ROOT, '.env') });
    const args = parseArgs(process.argv.slice(2));
    const options = connectionOptions(args.db);
    const started = new Date();

    const connection = await createConnection(options);
    console.log(`connected to ${options.host}/${args.db} (read-only audit)`);

    try {
        const deps = buildDeps(connection, args.ai);
        if (args.ai) console.log(`AI legs on (model ${deps.geminiModel})`);

        const targets = await selectTargets(connection, args);
        console.log(`${targets.length} published statement(s) selected`);
        const clients = await loadClients(connection, targets.map(t => t.client_id));

        const outDir = path.resolve(args.out);
        fs.mkdirSync(outDir, { recursive: true });
        const jsonl = path.join(outDir, 'summary.jsonl');
        console.log(`writing to ${outDir}`);

        let stopping = false;
        process.on('SIGINT', () => {
            if (stopping) process.exit(130);
            stopping = true;
            console.log('\nstopping after the in-flight statements (Ctrl+C again to abort)...');
        });

        const repo = connection.getRepository(FinancialStatement);
        const tallies: Record<string, Record<string, number>> = {};
        const errors: { id: string; message: string }[] = [];
        let done = 0;
        let pass = 0;
        let skippedExisting = 0;

        await mapWithConcurrency(targets, args.concurrency, async (t) => {
            if (stopping) return;
            const client = clients.get(t.client_id);
            const file = path.join(outDir, reportRelativePath({ ...t, obligor_key: client?.obligor_key }));
            if (args.resume && fs.existsSync(file)) { skippedExisting++; return; }

            let audit: StatementAudit;
            let view: StatementView | null = null;
            try {
                const fin = await repo.findOne(t.id);
                if (!fin) throw new Error('statement not found when loading');
                audit = await runChecks(fin, buildHeader(fin, client), deps, { ai: args.ai });
                // The statement as captured, for the UI. A view failure must not fail the audit.
                try {
                    const [mappings, statementTypes] = await Promise.all([
                        deps.refData.listFinancialStatementLineMapping(fin.company_type_id),
                        deps.refData.listFinancialStatementTypes(),
                    ]);
                    view = buildStatementView(fin, mappings, statementTypes);
                } catch (viewErr) {
                    console.warn(`[${t.id}] statement view not built: ${errMessage(viewErr)}`);
                }
            } catch (err) {
                const message = errMessage(err);
                errors.push({ id: t.id, message });
                audit = { header: headerFromTarget(t, client), status: 'fail', checks: [], metrics: emptyMetrics(), error: message };
            }

            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, renderMarkdown(audit));
            fs.writeFileSync(file.replace(/\.md$/, '.json'), JSON.stringify({ audit, view }));
            fs.appendFileSync(jsonl, JSON.stringify(summaryRow(audit)) + '\n');

            audit.checks.forEach(c => {
                const tally = tallies[c.id] ?? (tallies[c.id] = { pass: 0, fail: 0, advice: 0, error: 0, skipped: 0 });
                tally[c.status]++;
            });
            if (audit.status === 'pass') pass++;
            done++;
            const h = audit.header;
            console.log(`[${done}/${targets.length}] ${audit.status.toUpperCase().padEnd(4)} ${h.client_name || h.client_id} ${h.period} v${h.version}${audit.error ? ` — ${audit.error}` : ''}`);
        });

        const rows = readJsonl(jsonl);
        fs.writeFileSync(path.join(outDir, 'summary.csv'), rows.length ? toCSV(rows, { map: SUMMARY_HEADER }) : '');
        fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(rows));
        const run = {
            args, host: options.host, db: args.db,
            started: started.toISOString(), finished: new Date().toISOString(),
            interrupted: stopping,
            selected: targets.length, audited: done, skipped_existing: skippedExisting,
            pass, fail: done - pass, rows_in_summary: rows.length,
            checks: tallies, errors,
        };
        fs.writeFileSync(path.join(outDir, 'run.json'), JSON.stringify(run, null, 2));

        console.log(`\naudited ${done}/${targets.length} (${pass} pass, ${done - pass} fail, ${skippedExisting} already done, ${errors.length} audit errors)`);
        console.log(`summary: ${path.join(outDir, 'summary.csv')}`);
    } finally {
        await connection.close();
    }
}

main().catch(err => {
    console.error(err?.stack ?? err);
    process.exit(1);
});
