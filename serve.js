#!/usr/bin/env node
/**
 * Hosts ui/ and the audit results over HTTP. Zero dependencies — runs anywhere Node runs, including
 * Render, without anchorpoint-ts or a database (only the `audit` command needs those).
 *
 *   node serve.js                       local: audit-output/ on http://127.0.0.1:4310/, drafts writable
 *   node run.js serve [--port N]        same, through the launcher
 *
 * Environment (all optional):
 *   PORT            listen port (default 4310)
 *   HOST            bind address (default 127.0.0.1; 0.0.0.0 when HOST is set or Render's RENDER env is present)
 *   DATA_DIR        the results folder (default audit-output; the deployment uses the committed `published/`)
 *   READ_ONLY=1     drafts cannot be saved or removed (PUT/DELETE /api/draft answer 403) and the UI hides editing
 *   SITE_USER       basic-auth username (default "reviewer"); auth is on only when SITE_PASSWORD is set
 *   SITE_PASSWORD   basic-auth password: when set, every route needs it
 *   DEFAULT_FILTER  the list filter the UI opens on: all | fail | pass (default all)
 *
 * Routes: GET /, /app.js, /gate.js, /style.css, /favicon.ico, /healthz, /api/config, /api/runs,
 * /api/drafts/<db>/<run>, /data/<db>/<run>/...; PUT|DELETE /api/draft/<db>/<run>/<report> (unless READ_ONLY).
 * Paths are confined to ui/ and DATA_DIR; the only file ever written is <report>.draft.json beside a report.
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = __dirname;
const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
    '.jsonl': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
};

function start(options = {}) {
    const env = process.env;
    const port = options.port || parseInt(env.PORT, 10) || 4310;
    const host = options.host || env.HOST || (env.RENDER ? '0.0.0.0' : '127.0.0.1');
    const UI = path.join(ROOT, 'ui');
    const OUT = path.resolve(ROOT, options.dataDir || env.DATA_DIR || 'audit-output');
    const readOnly = options.readOnly != null ? !!options.readOnly : env.READ_ONLY === '1' || env.READ_ONLY === 'true';
    const defaultFilter = ['all', 'fail', 'pass'].includes(env.DEFAULT_FILTER) ? env.DEFAULT_FILTER : 'all';
    const siteUser = env.SITE_USER || 'reviewer';
    const sitePassword = env.SITE_PASSWORD || '';

    const confined = (base, rel) => { const file = path.resolve(base, rel); return file.startsWith(base + path.sep) ? file : null; };
    const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)); };
    const sendFile = (res, base, rel) => {
        const file = confined(base, rel);
        if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
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

    /** Draft files of one run: the report keys (path without extension) that have a <key>.draft.json. */
    const listDrafts = runRel => {
        const dir = confined(OUT, runRel);
        if (!dir || !fs.existsSync(dir)) return [];
        const out = [];
        const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.draft.json')) out.push(path.relative(dir, p).split(path.sep).join('/').replace(/\.draft\.json$/, ''));
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

    /** Basic auth when a password is configured. Constant-time compare; a missing header gets the browser prompt. */
    const authorised = req => {
        if (!sitePassword) return true;
        const header = req.headers.authorization || '';
        if (!header.startsWith('Basic ')) return false;
        const expected = Buffer.from(`${siteUser}:${sitePassword}`);
        const given = Buffer.from(header.slice(6), 'base64');
        return given.length === expected.length && crypto.timingSafeEqual(given, expected);
    };

    const server = http.createServer(async (req, res) => {
        const url = decodeURIComponent((req.url || '/').split('?')[0]);
        if (url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
        if (!authorised(req)) { res.writeHead(401, { 'www-authenticate': 'Basic realm="Financials Auditor", charset="UTF-8"', 'cache-control': 'no-store' }); res.end('authentication required'); return; }

        if (url.startsWith('/api/draft/')) {
            if (readOnly) return json(res, 403, { error: 'this site is read-only; drafts cannot be saved here' });
            // The draft sits beside the report it edits: <report>.draft.json. Only that name is ever written.
            const file = confined(OUT, url.slice('/api/draft/'.length) + '.draft.json');
            if (!file || !/\.draft\.json$/.test(file) || !fs.existsSync(file.replace(/\.draft\.json$/, '.json'))) return json(res, 404, { error: 'no such report' });
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
        if (url === '/' || url === '/index.html') return sendFile(res, UI, 'index.html');
        if (url === '/app.js' || url === '/gate.js' || url === '/style.css') return sendFile(res, UI, url.slice(1));
        if (url === '/api/config') return json(res, 200, { readOnly, defaultFilter });
        if (url === '/api/runs') return json(res, 200, listRuns());
        if (url.startsWith('/api/drafts/')) return json(res, 200, readOnly ? [] : listDrafts(url.slice('/api/drafts/'.length)));
        if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
        if (url.startsWith('/data/')) return sendFile(res, OUT, url.slice('/data/'.length));
        res.writeHead(404); res.end('not found');
    });

    server.listen(port, host, () => {
        console.log(`financials-auditor UI: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/  (data: ${OUT}${readOnly ? ', read-only' : ''}${sitePassword ? ', password protected' : ''})`);
    });
    return server;
}

module.exports = { start };

if (require.main === module) {
    const portFlag = process.argv.indexOf('--port');
    start({ port: portFlag >= 0 ? parseInt(process.argv[portFlag + 1], 10) || undefined : undefined });
}
