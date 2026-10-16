#!/usr/bin/env node
/**
 * Launcher. Points module resolution at <anchorpoint-ts>/node_modules (default ../anchorpoint-suite/anchorpoint-ts, override with ANCHORPOINT_TS) (nothing is installed here,
 * on purpose: the app's validators and this audit must share ONE TypeORM instance, or the global
 * getRepository() the app services use cannot see the connection this audit opens), registers
 * ts-node with this folder's tsconfig, then runs the audit or the specs.
 *
 *   node run.js audit --db aprs_za_abl_db --limit 5
 *   node run.js test
 *   node run.js serve [--port N]            the results UI (serve.js; needs neither the app nor a database)
 *   node run.js publish <db>/<run>          copy a run into published/ for deployment
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');

const ROOT = __dirname;

// serve and publish need neither anchorpoint-ts nor ts-node: dispatch them before the checks below.
{
    const [cmd, ...rest] = process.argv.slice(2);
    if (cmd === 'serve') {
        const portFlag = rest.indexOf('--port');
        require('./serve').start({ port: portFlag >= 0 ? parseInt(rest[portFlag + 1], 10) || undefined : undefined });
        return;
    }
    if (cmd === 'publish') { publish(rest[0]); return; }
}

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
} else {
    console.error(`unknown command "${command}" (use: audit [flags] | serve [--port N] | test)`);
    process.exit(1);
}

/**
 * Copies one run out of audit-output/ into published/ — the folder the deployment serves (committed to git,
 * unlike audit-output/). Drafts are left behind. Replaces what was there for that run.
 */
function publish(runRel) {
    const parts = (runRel || '').split('/');
    if (parts.length !== 2 || parts.some(p => !p || p === '..' || p.includes('\\'))) {
        console.error('usage: node run.js publish <db>/<run>   e.g. node run.js publish aprs_za_abl_db/full');
        process.exit(1);
    }
    const src = path.join(ROOT, 'audit-output', runRel);
    const dest = path.join(ROOT, 'published', runRel);
    if (!fs.existsSync(path.join(src, 'run.json'))) { console.error(`no finished run at ${src}`); process.exit(1); }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true, filter: f => !f.endsWith('.draft.json') });
    const count = [];
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => e.isDirectory() ? walk(path.join(d, e.name)) : count.push(e.name));
    walk(dest);
    console.log(`published ${count.length} files to ${dest}`);
}
