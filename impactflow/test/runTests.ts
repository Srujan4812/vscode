/*---------------------------------------------------------------------------------------------
 *  ImpactFlow — Architectural Impact Analysis
 *  MIT License — see LICENSE file at the project root.
 *
 *  Simple Mocha test runner. Run with `npm test` after compiling via `tsc`.
 *--------------------------------------------------------------------------------------------*/

import Mocha from 'mocha';
import * as path from 'path';
import * as fs from 'fs';

function collectTestFiles(root: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) {
			out.push(...collectTestFiles(full));
		} else if (entry.isFile() && entry.name.endsWith('.test.js')) {
			out.push(full);
		}
	}
	return out;
}

async function run(): Promise<void> {
	const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 10000 });
	const testsRoot = path.resolve(__dirname, '..');
	const files = collectTestFiles(testsRoot);
	for (const f of files) {
		mocha.addFile(f);
	}
	await new Promise<void>((resolve, reject) => {
		mocha.run(failures => {
			if (failures > 0) { reject(new Error(`${failures} test(s) failed`)); } else { resolve(); }
		});
	});
}

run().catch(err => {
	console.error(err);
	process.exit(1);
});
