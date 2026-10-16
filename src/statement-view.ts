/**
 * The statement laid out on the chart of accounts ("hint structure") of its company type: every
 * catalogue node of each statement type in reading order, with the captured lines placed under
 * the node they are mapped to. Pure — built from the loaded entity plus the reference data and
 * written next to the report so the UI can show the audit against the structure.
 *
 * Row kinds:
 *   line      a captured line under its mapping (one row per captured line)
 *   note      a note line under its parent line
 *   node      a catalogue node nothing was captured against; `used` says whether something was
 *             captured somewhere beneath it (a used parent with no own line is a missing total
 *             candidate — the publish gate's finding, matched by mapping id, says whether it is)
 *   heading   a captured line with no mapping and no values — a section title the operator typed
 *   nomap     a captured line parked on the catalogue's "No map" placeholder: deliberately excluded
 *   unmapped  a valued line with no mapping, or a mapping that is not in this statement's catalogue
 * The last three are listed after the structure. `sequence` is the captured order (the line's
 * sequence; a note takes its parent line's; a node has none) so the UI can also show the statement
 * as it was captured.
 */
import { FinancialStatement } from '@modules/financial-capture/entities/FinancialStatement';
import { FinancialStatementLine } from '@modules/financial-capture/entities/FinancialStatementLine';
import { FinancialStatementLineMapping } from '@modules/financial-capture/entities/FinancialStatementLineMapping';
import { buildPalette, flattenPalette, FlatPaletteNode, MappingRow, PALETTE_PATH_SEPARATOR, statementTypeRank } from '@modules/common/services/definition-palette';
import { FinancialsHelper } from '@modules/financial-capture/services/financials-helper';

export type ViewRowKind = 'line' | 'note' | 'node' | 'heading' | 'nomap' | 'unmapped';

const isNoMap = (m: FinancialStatementLineMapping | undefined): boolean =>
    !!m && (m.description ?? '').trim().toLowerCase() === 'no map';

export interface ViewRow {
    kind: ViewRowKind;
    depth: number;
    mapping_id: string | null;
    /** The hint text: the catalogue node's description. '' for an unmapped line. */
    hint: string;
    /** Ancestors joined by ' > ', this node last. '' for an unmapped line. */
    hint_path: string;
    has_children: boolean;
    /** Something was captured on this node or beneath it. Always true for line/note/unmapped. */
    used: boolean;
    line_id: string | null;
    /** The captured line's text. '' for a node row. */
    line: string;
    values: Record<string, number | null>;
    sign: 'positive' | 'negative' | null;
    /** The captured order: the line's sequence, its parent's for a note, null for a catalogue node. */
    sequence: number | null;
}

export interface ViewStatement {
    type_id: string;
    type: string;
    rows: ViewRow[];
}

export interface StatementView {
    /** yyyy-mm-dd, newest first. */
    periods: string[];
    statements: ViewStatement[];
}

const lc = (v: string | null | undefined): string => (v ?? '').toLowerCase();

const isoDay = (v: any): string => {
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
};

function valuesOf(facts: any[] | undefined, periods: Set<string>): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    (facts ?? []).filter(f => !f.deleted_date).forEach(f => {
        const key = isoDay(f.year);
        periods.add(key);
        const n = f.value == null ? null : Number(f.value);
        out[key] = n == null || Number.isNaN(n) ? null : n;
    });
    return out;
}

const signOf = (m: FinancialStatementLineMapping | undefined): ViewRow['sign'] =>
    m?.is_positive === true ? 'positive' : m?.is_positive === false ? 'negative' : null;

export function buildStatementView(
    fin: FinancialStatement,
    mappings: FinancialStatementLineMapping[],
    statementTypes: { id: string; description: string }[],
): StatementView {
    const byId = new Map<string, FinancialStatementLineMapping>();
    mappings.forEach(m => { if (m.id) byId.set(lc(m.id), m); });
    const typeName = new Map(statementTypes.map(t => [lc(t.id), t.description]));
    const periods = new Set<string>();

    const activeLines = (fin.lines ?? [])
        .filter(l => !l.deleted_date)
        .slice()
        .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));

    const linesByType = new Map<string, FinancialStatementLine[]>();
    activeLines.forEach(l => {
        const key = lc(l.financial_statement_type_id);
        if (!linesByType.has(key)) linesByType.set(key, []);
        linesByType.get(key)!.push(l);
    });

    const statements: ViewStatement[] = [];

    for (const [typeId, lines] of linesByType) {
        const type = typeName.get(typeId) ?? 'Unknown statement';
        const rowsForType: MappingRow[] = mappings
            .filter(m => lc(m.financial_statement_type_id) === typeId)
            .map(m => ({ id: m.id, description: m.description, parent_id: m.parent_id ?? null, financial_statement_type_id: m.financial_statement_type_id ?? null }));
        const nodes: FlatPaletteNode[] = flattenPalette(
            FinancialsHelper.orderStatementRoots(buildPalette(rowsForType, 'SELECTION', null), type),
        );
        const nodeByMapping = new Map(nodes.map(n => [lc(n.mapping_id), n]));
        const nodeByPath = new Map(nodes.map(n => [n.path, n]));

        // Captured lines per catalogue node; anything whose mapping is not in this statement's
        // catalogue is unmapped as far as the structure is concerned.
        const linesByNode = new Map<string, FinancialStatementLine[]>();
        const unmapped: FinancialStatementLine[] = [];
        lines.forEach(l => {
            const key = lc(l.financial_statement_line_mapping_id);
            if (key && nodeByMapping.has(key)) {
                if (!linesByNode.has(key)) linesByNode.set(key, []);
                linesByNode.get(key)!.push(l);
            } else {
                unmapped.push(l);
            }
        });

        // A node is used when a line sits on it or anywhere beneath it.
        const used = new Set<string>();
        for (const key of linesByNode.keys()) {
            let node: FlatPaletteNode | undefined = nodeByMapping.get(key);
            while (node) {
                used.add(node.path);
                node = node.parent_path ? nodeByPath.get(node.parent_path) : undefined;
            }
        }

        const hintPath = (n: FlatPaletteNode): string => n.path.split(PALETTE_PATH_SEPARATOR).join(' > ');

        const noteRows = (line: FinancialStatementLine, depth: number): ViewRow[] =>
            (line.notes ?? []).filter(n => !n.deleted_date).flatMap(n => {
                const label = [n.number, n.text].filter(Boolean).join(' ').trim() || 'Note';
                return (n.lines ?? []).filter(nl => !nl.deleted_date)
                    .slice().sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
                    .map(nl => {
                        const nm = byId.get(lc(nl.financial_statement_line_mapping_id));
                        const nn = nodeByMapping.get(lc(nl.financial_statement_line_mapping_id));
                        return {
                            kind: 'note' as const, depth,
                            mapping_id: nl.financial_statement_line_mapping_id ?? null,
                            hint: nm?.description ?? '', hint_path: nn ? hintPath(nn) : (nm?.description ?? ''),
                            has_children: false, used: true,
                            line_id: nl.id ?? null, line: label,
                            values: valuesOf(nl.facts, periods), sign: signOf(nm),
                            sequence: line.sequence ?? null,
                        };
                    });
            });

        const rows: ViewRow[] = [];
        for (const node of nodes) {
            const own = linesByNode.get(lc(node.mapping_id)) ?? [];
            const mapping = byId.get(lc(node.mapping_id));
            if (own.length === 0) {
                rows.push({
                    kind: 'node', depth: node.depth, mapping_id: node.mapping_id,
                    hint: node.description, hint_path: hintPath(node), has_children: node.has_children,
                    used: used.has(node.path), line_id: null, line: '', values: {}, sign: signOf(mapping),
                    sequence: null,
                });
                continue;
            }
            for (const line of own) {
                rows.push({
                    kind: 'line', depth: node.depth, mapping_id: node.mapping_id,
                    hint: node.description, hint_path: hintPath(node), has_children: node.has_children,
                    used: true, line_id: line.id ?? null, line: line.description ?? '',
                    values: valuesOf(line.facts, periods), sign: signOf(mapping),
                    sequence: line.sequence ?? null,
                });
                rows.push(...noteRows(line, node.depth + 1));
            }
        }
        for (const line of unmapped) {
            const mapping = byId.get(lc(line.financial_statement_line_mapping_id));
            const values = valuesOf(line.facts, periods);
            const kind: ViewRowKind = isNoMap(mapping) ? 'nomap'
                // A 0 counts as no value, as FinancialsHelper.isFinancialHeading reads it.
                : (!line.financial_statement_line_mapping_id && Object.values(values).every(v => v == null || v === 0)) ? 'heading'
                : 'unmapped';
            rows.push({
                kind, depth: 0, mapping_id: line.financial_statement_line_mapping_id ?? null,
                hint: mapping?.description ?? '', hint_path: mapping?.description ?? '', has_children: false,
                used: true, line_id: line.id ?? null, line: line.description ?? '',
                values, sign: signOf(mapping),
                sequence: line.sequence ?? null,
            });
            rows.push(...noteRows(line, 1));
        }

        statements.push({ type_id: typeId, type, rows });
    }

    statements.sort((a, b) => {
        const rank = statementTypeRank(a.type) - statementTypeRank(b.type);
        return rank !== 0 ? rank : a.type.localeCompare(b.type);
    });

    return { periods: [...periods].sort().reverse(), statements };
}
