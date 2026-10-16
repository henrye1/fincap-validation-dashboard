#!/usr/bin/env node
/**
 * Launcher. Points module resolution at <anchorpoint-ts>/node_modules (default ../anchorpoint-suite/anchorpoint-ts, override with ANCHORPOINT_TS) (nothing is installed here,
 * on purpose: the app's validators and this audit must share ONE TypeORM instance, or the global
 * getRepository() the app services use cannot see the connection this audit opens), registers
 * ts-node with this folder's tsconfig, then runs the audit or the specs.
 *
 *   node run.js audit --db aprs_za_abl_db --limit 5
 *   node run.js test
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');

const ROOT = __dirname;
const APP_ROOT = process.env.ANCHORPOINT_TS || path.join(ROOT, '..', 'anchorpoint-suite', 'anchorpoint-ts');
process.env.ANCHORPOINT_TS = APP_ROOT;
const APP_NODE_MODULES = path.join(APP_ROOT, 'node_modules');

if (fs.existsSync(path.join(ROOT, 'node_modules'))) {
    console.error('financials-auditor must not have its own node_modules (it would load a second TypeORM). Delete financials-auditor/node_modules.');
    process.exit(1);
}
if (!fs.existsSync(path.join(APP_NODE_MODULES, 'typeorm'))) {
    console.error(`anchorpoint-ts is not installed (${APP_NODE_MODULES}). Run "npm install" in anchorpoint-ts first.`);
    process.exit(1);
}

process.env.NODE_PATH = [APP_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();

require('ts-node').register({ project: path.join(ROOT, 'tsconfig.json') });
require('tsconfig-paths').register({
    baseUrl: ROOT,
    paths: {
        '@modules/*': [path.join(APP_ROOT, 'src', 'modules', '*')],
        '@shared/*': [path.join(APP_ROOT, 'src', 'shared', '*')],
    },
});

const [command, ...rest] = process.argv.slice(2);

if (command === 'test') {
    const Mocha = require('mocha');
    const mocha = new Mocha();
    const srcDir = path.join(ROOT, 'src');
    fs.readdirSync(srcDir).filter(f => f.endsWith('.spec.ts')).forEach(f => mocha.addFile(path.join(srcDir, f)));
    mocha.run(failures => process.exit(failures ? 1 : 0));
} else if (command === 'audit' || command === undefined || command.startsWith('--')) {
    process.argv = [process.argv[0], path.join(ROOT, 'src', 'index.ts'), ...(command === 'audit' ? rest : process.argv.slice(2))];
    require('./src/index.ts');
} else if (command === 'serve') {
    serve(rest);
} else {
    console.error(`unknown command "${command}" (use: audit [flags] | serve [--port N] | test)`);
    process.exit(1);
}

/**
 * Hosts ui/ and audit-output/ on localhost so the page can fetch the run data (a file:// page cannot).
 * GET only, paths confined to those two folders — except the editor's drafts: PUT/DELETE
 * /api/draft/<db>/<run>/<report> writes or removes <report>.draft.json beside the audit's report.
 * Nothing here touches the database.
 */
function serve(argv) {
    const http = require('http');
    const portFlag = argv.indexOf('--port');
    const port = portFlag >= 0 ? parseInt(argv[portFlag + 1], 10) || 4310 : 4310;
    const UI = path.join(ROOT, 'ui');
    const OUT = path.join(ROOT, 'audit-output');
    const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.log': 'text/plain; charset=utf-8' };

    const confined = (base, rel) => { const file = path.resolve(base, rel); return file.startsWith(base + path.sep) ? file : null; };
    const sendFile = (res, base, rel) => {
        const file = confined(base, rel);
        if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            res.writeHead(404); res.end('not found'); return;
        }
        res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
        fs.createReadStream(file).pipe(res);
    };

    const listRuns = () => {
        const runs = [];
        if (!fs.existsSync(OUT)) return runs;
        for (const db of fs.readdirSync(OUT)) {
            const dbDir = path.join(OUT, db);
            if (!fs.statSync(dbDir).isDirectory()) continue;
            for (const run of fs.readdirSync(dbDir)) {
                const runFile = path.join(dbDir, run, 'run.json');
                if (!fs.existsSync(runFile)) continue;
                try {
                    const r = JSON.parse(fs.readFileSync(runFile, 'utf8'));
                    runs.push({ db, run, path: `${db}/${run}`, finished: r.finished, audited: r.audited, pass: r.pass, fail: r.fail, ai: !!(r.args && r.args.ai) });
                } catch { /* half-written run.json: skip it */ }
            }
        }
        return runs.sort((a, b) => String(b.finished).localeCompare(String(a.finished)));
    };

    const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    /** Draft files of one run: the report keys (path without extension) that have a <key>.draft.json. */
    const listDrafts = runRel => {
        const dir = confined(OUT, runRel);
        if (!dir || !fs.existsSync(dir)) return [];
        const out = [];
        const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.draft.json')) out.push(path.relative(dir, p).split(path.sep).join('/').replace(/.draft.json$/, ''));
        });
        walk(dir);
        return out;
    };
    const readBody = (req, limit) => new Promise((resolve, reject) => {
        let size = 0; const chunks = [];
        req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });

    http.createServer(async (req, res) => {
        const url = decodeURIComponent((req.url || '/').split('?')[0]);
        if (url.startsWith('/api/draft/')) {
            // The draft sits beside the report it edits: <report>.draft.json. Only that name is ever written.
            const file = confined(OUT, url.slice('/api/draft/'.length) + '.draft.json');
            if (!file || !/.draft.json$/.test(file) || !fs.existsSync(file.replace(/.draft.json$/, '.json'))) return json(res, 404, { error: 'no such report' });
            if (req.method === 'PUT') {
                let body;
                try { body = JSON.parse(await readBody(req, 4 * 1024 * 1024)); } catch (e) { return json(res, 400, { error: e.message }); }
                if (!body || !Array.isArray(body.statements)) return json(res, 400, { error: 'a draft has statements' });
                body.saved_at = new Date().toISOString();
                fs.writeFileSync(file, JSON.stringify(body));
                return json(res, 200, { saved_at: body.saved_at });
            }
            if (req.method === 'DELETE') { if (fs.existsSync(file)) fs.unlinkSync(file); return json(res, 200, { removed: true }); }
            res.writeHead(405); res.end(); return;
        }
        if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
        if (url.startsWith('/api/drafts/')) return json(res, 200, listDrafts(url.slice('/api/drafts/'.length)));
        if (url === '/' || url === '/index.html') return sendFile(res, UI, 'index.html');
        if (url === '/app.js' || url === '/gate.js' || url === '/style.css') return sendFile(res, UI, url.slice(1));
        if (url === '/api/runs') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(listRuns())); return; }
        if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
        if (url.startsWith('/data/')) return sendFile(res, OUT, url.slice('/data/'.length));
        res.writeHead(404); res.end('not found');
    }).listen(port, '127.0.0.1', () => console.log(`financials-auditor UI: http://localhost:${port}/`));
}
