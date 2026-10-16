# financials-auditor

Read-only audit of every **published** financial statement in a database. It runs the app's own
validations and writes one Markdown report per statement plus `summary.csv` and `run.json`.
Recommendations only: nothing is written to the database and nothing in `anchorpoint-ts` changes.

Standalone package. It is not wired into the app; it imports the validator, translator and entity
*source* from `../anchorpoint-suite/anchorpoint-ts` read-only, and borrows its `node_modules` so TypeORM
is a single instance. Do **not** run `npm install` here.

## Checks per statement

| Check | Source | Headline? |
|---|---|---|
| Publish gate (totals balance) | `FinancialStatementValidator.computeTotalBalanceFaults` — the rule that blocks publishing today | yes |
| No Blank Values, Chart of Accounts Mapping, Mapping Cardinality, Missing Subtotals, Balance Sheet Equality | `FinancialStatementValidator.validateFull` | yes |
| Cash Ties, Profit Ties | `validateFull`, advisory | no (ADVICE) |
| Ratios can be computed | `RiskCalcFinancialTranslator.translateToRiskFinancials`, in memory | yes |
| AI: source document comparison | Gemini scan of the attached PDF vs captured lines (`--ai`) | no (ADVICE, score in CSV) |
| AI: ratio analysis | Gemini ratio read, corporate statements only (`--ai`) | no |

A statement is FAIL when any headline check fails or errors.

## Setup

1. `npm install` in `anchorpoint-suite/anchorpoint-ts` (once). The app is expected at `../anchorpoint-suite/anchorpoint-ts`; set `ANCHORPOINT_TS=<path>` to point elsewhere (the `tsconfig.json` paths must then be edited to match).
2. Copy `.env.example` to `.env` and fill in the SQL Server login. `GEMINI_API_KEY` only for `--ai`.

## Run

```
cd financials-auditor
node run.js audit --db aprs_za_abl_db --limit 5                 # smoke
node run.js audit --db aprs_za_abl_db                           # everything
node run.js audit --db aprs_za_abl_db --out audit-output/x --resume   # continue an interrupted run
node run.js audit --db aprs_za_abl_db --ids <id>,<id> --ai      # with the AI legs
node run.js test                                                # specs
node run.js serve                                               # UI at http://localhost:4310/
```

Flags: `--db <name>` (default `AUDIT_DB`), `--org <id>`, `--client <id>`, `--ids a,b,c`, `--limit N`,
`--ai`, `--out <dir>` (default `audit-output/<db>/<timestamp>`), `--resume`, `--concurrency N`
(default 4, capped at 2 with `--ai`). Ctrl+C finishes the in-flight statements and still writes the summary.

## UI

`node run.js serve` hosts a small page at http://localhost:4310/ over `audit-output/`: pick a run, see one card per
statement (status, failed checks, fault counts), filter by status or search, and click into a statement for the
full audit plus the Balance Sheet, Income Statement and Cash Flow stacked with every line, its mapping (optionally
the full mapping path), its sign rule and its value per period. Unmapped lines are highlighted; note lines sit under
their parent line. The statements have two layouts, switched with the View toggle and remembered in the browser:
**APR** lays the lines out on the chart of accounts (hint structure, indented, unused mappings optional); **Original**
shows them in the order they were captured, with a missing total placed after its last child line. Runs made
before the UI existed have no per-statement JSON, and runs made before the Original view have no captured order;
re-run the audit to get them.

### Editing a statement (drafts)

**Edit statement** opens the Original view with every line editable: text, mapping (the statement's chart of
accounts, "No map", or none), and the value per period; lines can be added (**Add line**, or **Add total line** on a
missing total, which pre-fills the sum of its children) and removed. Validation re-runs on every change in the
browser (`ui/gate.js`): the publish gate's three rules, Missing Subtotals, Chart of Accounts Mapping, Mapping
Cardinality and No Blank Values, with the same tolerance and wording as the app. Cash Ties, Profit Ties, the ratio
translation and the AI legs need the database and keep the audit run's result. **Save draft** writes
`<report>.draft.json` beside the audit's report (the whole edited statement plus a list of changes); the page then
shows the draft with its live checks, the list marks it "Draft", and **Revert to audited** removes it. Nothing is
ever written to the database: a draft is a worked proposal to apply in the capture screen.

`gate.js` was checked against the audit of all 223 statements: it rebuilds every statement view exactly and
reproduces the publish gate's findings on every statement (three differ only in float rounding or in which of two
lines on the same total is named). No Blank Values depends on the app's database row order, which the view does not
carry; it disagreed on 6 of 223 statements.

## Output

```
audit-output/<db>/<run>/
  <organisation_id>/<obligor_key>/<period>_v<version>_<id8>.md   one report per statement
  <organisation_id>/<obligor_key>/<period>_v<version>_<id8>.json the audit plus the statement view, for the UI
  index.json       the summary rows as JSON, for the UI
  summary.csv      one row per statement: status, failed checks, fault counts, translatable, AI score
  summary.jsonl    the same rows, appended as the run goes (what --resume builds the CSV from)
  run.json         arguments, host/db, counts, per-check tallies, statements that could not be audited
```

## Read-only guarantees

- The audit only calls `find` / `findOne` / `query(SELECT …)`. The translator is run through
  `translateToRiskFinancials` (in memory), never `translate` (which persists).
- The AI legs call the service's compute methods directly and skip its cache write.
- One statement is loaded per worker; the whole set is never loaded at once.
- Safer still: give the login only `db_datareader` on the audited database.
