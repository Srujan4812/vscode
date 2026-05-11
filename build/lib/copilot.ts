/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

/**
 * The platforms that @github/copilot ships platform-specific packages for.
 * These are the `@github/copilot-{platform}` optional dependency packages.
 */
export const copilotPlatforms = [
	'darwin-arm64', 'darwin-x64',
	'linux-arm64', 'linux-x64',
	'win32-arm64', 'win32-x64',
];

/**
 * Converts VS Code build platform/arch to the values that Node.js reports
 * at runtime via `process.platform` and `process.arch`.
 *
 * The copilot SDK's `loadNativeModule` looks up native binaries under
 * `prebuilds/${process.platform}-${process.arch}/`, so the directory names
 * must match these runtime values exactly.
 */
function toNodePlatformArch(platform: string, arch: string): { nodePlatform: string; nodeArch: string } {
	// alpine is musl-linux; Node still reports process.platform === 'linux'
	let nodePlatform = platform === 'alpine' ? 'linux' : platform;
	let nodeArch = arch;

	if (arch === 'armhf') {
		// VS Code build uses 'armhf'; Node reports process.arch === 'arm'
		nodeArch = 'arm';
	} else if (arch === 'alpine') {
		// Legacy: { platform: 'linux', arch: 'alpine' } means alpine-x64
		nodePlatform = 'linux';
		nodeArch = 'x64';
	}

	return { nodePlatform, nodeArch };
}

/**
 * Returns a glob filter that strips @github/copilot platform packages
 * for architectures other than the build target.
 *
 * For platforms the copilot SDK doesn't natively support (e.g. alpine, armhf),
 * ALL platform packages are stripped - that's fine because the copilot CLI SDK
 * resolves `node-pty` from the embedder (VS Code) first via `hostRequire`,
 * falling back to its bundled copy only if the embedder can't provide it.
 */
export function getCopilotExcludeFilter(platform: string, arch: string): string[] {
	const { nodePlatform, nodeArch } = toNodePlatformArch(platform, arch);
	const targetPlatformArch = `${nodePlatform}-${nodeArch}`;
	const nonTargetPlatforms = copilotPlatforms.filter(p => p !== targetPlatformArch);

	// Strip wrong-architecture @github/copilot-{platform} packages.
	// All copilot prebuilds are stripped by .moduleignore; the copilot CLI SDK
	// resolves `node-pty` from VS Code's own node_modules via `hostRequire`.
	const excludes = nonTargetPlatforms.map(p => `!**/node_modules/@github/copilot-${p}/**`);

	return ['**', ...excludes];
}

/**
 * All per-platform @vscode/ripgrep binary packages.
 */
const ripgrepPlatforms = [
	'darwin-arm64', 'darwin-x64',
	'linux-arm64', 'linux-arm', 'linux-x64',
	'win32-arm64', 'win32-x64',
];

/**
 * Returns a glob filter that strips @vscode/ripgrep-{platform} packages
 * for architectures other than the build target.
 */
export function getRipgrepExcludeFilter(platform: string, arch: string): string[] {
	const { nodePlatform, nodeArch } = toNodePlatformArch(platform, arch);
	const target = `${nodePlatform}-${nodeArch}`;
	const nonTargetPlatforms = ripgrepPlatforms.filter(p => p !== target);
	const excludes = nonTargetPlatforms.map(p => `!**/node_modules/@vscode/ripgrep-${p}/**`);
	return ['**', ...excludes];
}

/**
 * Materializes the copilot CLI ripgrep shim directly inside the built-in copilot extension.
 *
 * This is used when copilot is shipped as a built-in extension so startup does
 * not need to create the shim at runtime. The destination layout matches the
 * runtime shim logic in the copilot extension:
 * - ripgrep:  node_modules/@github/copilot/sdk/ripgrep/bin/{platform-arch}
 * - marker:   node_modules/@github/copilot/shims.txt
 *
 * Note: `node-pty` is no longer shimmed. The copilot CLI SDK resolves
 * `node-pty` from the embedder (VS Code) via `hostRequire` and falls back to
 * its bundled copy only if that fails.
 *
 * Failures throw to fail the build because built-in packaging must guarantee
 * this artifact is present.
 */
export function prepareBuiltInCopilotRipgrepShim(platform: string, arch: string, builtInCopilotExtensionDir: string, appNodeModulesDir: string): void {
	const { nodePlatform, nodeArch } = toNodePlatformArch(platform, arch);
	const platformArch = `${nodePlatform}-${nodeArch}`;

	const extensionNodeModules = path.join(builtInCopilotExtensionDir, 'node_modules');
	const copilotBase = path.join(extensionNodeModules, '@github', 'copilot');
	const copilotSdkBase = path.join(copilotBase, 'sdk');
	if (!fs.existsSync(copilotSdkBase)) {
		throw new Error(`[prepareBuiltInCopilotRipgrepShim] Copilot SDK directory not found at ${copilotSdkBase}`);
	}

	// After asar packaging, native binaries are unpacked into
	// `node_modules.asar.unpacked/`. Try that first, then fall back to
	// `node_modules/` for development builds that skip asar.
	const unpackedNodeModulesDir = appNodeModulesDir.replace(/\bnode_modules$/, 'node_modules.asar.unpacked');
	const ripgrepPkg = path.join('@vscode', `ripgrep-${nodePlatform}-${nodeArch}`, 'bin');

	console.log(`[prepareBuiltInCopilotRipgrepShim] host: process.platform=${process.platform}, process.arch=${process.arch}`);
	console.log(`[prepareBuiltInCopilotRipgrepShim] target: platform=${platform}, arch=${arch} => nodePlatform=${nodePlatform}, nodeArch=${nodeArch}`);
	console.log(`[prepareBuiltInCopilotRipgrepShim] appNodeModulesDir=${appNodeModulesDir}`);
	console.log(`[prepareBuiltInCopilotRipgrepShim] unpackedNodeModulesDir=${unpackedNodeModulesDir}`);
	console.log(`[prepareBuiltInCopilotRipgrepShim] appNodeModulesDir exists: ${fs.existsSync(appNodeModulesDir)}`);
	console.log(`[prepareBuiltInCopilotRipgrepShim] unpackedNodeModulesDir exists: ${fs.existsSync(unpackedNodeModulesDir)}`);

	// List what's inside the app base to understand the packaging layout
	const appBase = path.dirname(appNodeModulesDir);
	try {
		const appBaseContents = fs.readdirSync(appBase).filter(e => e.startsWith('node_modules'));
		console.log(`[prepareBuiltInCopilotRipgrepShim] app base node_modules entries: ${JSON.stringify(appBaseContents)}`);
	} catch (e) {
		console.log(`[prepareBuiltInCopilotRipgrepShim] could not list app base: ${e}`);
	}

	// List @vscode packages in both possible locations
	for (const dir of [appNodeModulesDir, unpackedNodeModulesDir]) {
		const vscodePkgDir = path.join(dir, '@vscode');
		try {
			if (fs.existsSync(vscodePkgDir)) {
				const entries = fs.readdirSync(vscodePkgDir);
				console.log(`[prepareBuiltInCopilotRipgrepShim] ${vscodePkgDir} contents: ${JSON.stringify(entries)}`);
			} else {
				console.log(`[prepareBuiltInCopilotRipgrepShim] ${vscodePkgDir} does not exist`);
			}
		} catch (e) {
			console.log(`[prepareBuiltInCopilotRipgrepShim] error listing ${vscodePkgDir}: ${e}`);
		}
	}

	const ripgrepSource = fs.existsSync(path.join(unpackedNodeModulesDir, ripgrepPkg))
		? path.join(unpackedNodeModulesDir, ripgrepPkg)
		: path.join(appNodeModulesDir, ripgrepPkg);
	console.log(`[prepareBuiltInCopilotRipgrepShim] chosen ripgrepSource=${ripgrepSource}, exists=${fs.existsSync(ripgrepSource)}`);
	if (!fs.existsSync(ripgrepSource)) {
		throw new Error(`[prepareBuiltInCopilotRipgrepShim] ripgrep source not found at ${ripgrepSource}`);
	}

	const ripgrepDest = path.join(copilotSdkBase, 'ripgrep', 'bin', platformArch);
	const shimMarkerPath = path.join(copilotBase, 'shims.txt');

	try {
		fs.mkdirSync(ripgrepDest, { recursive: true });
		fs.cpSync(ripgrepSource, ripgrepDest, { recursive: true });

		fs.writeFileSync(shimMarkerPath, 'Shims created successfully');
		console.log(`[prepareBuiltInCopilotRipgrepShim] Materialized ripgrep shim for ${platformArch} in ${builtInCopilotExtensionDir}`);
	} catch (err) {
		throw new Error(`[prepareBuiltInCopilotRipgrepShim] Failed to materialize ripgrep shim for ${platformArch}: ${err}`);
	}
}
