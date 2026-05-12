/*---------------------------------------------------------------------------------------------
 *  ImpactFlow — Architectural Impact Analysis
 *  MIT License — see LICENSE file at the project root.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { DependencyGraph, EdgeKind, IGraphNode } from './graph';

/**
 * Configuration for a single indexing pass. Kept deliberately small — the
 * indexer owns no global state and no service references, so callers supply
 * everything it needs.
 */
export interface IIndexerOptions {
	/** Absolute root directory of the workspace to index. */
	readonly workspaceRoot: string;
	/** Files considered in-scope. The indexer will NOT descend into paths matched by {@link excludeMatchers}. */
	readonly includeMatchers: readonly IFileMatcher[];
	readonly excludeMatchers: readonly IFileMatcher[];
	/**
	 * Case-insensitive substrings that, when matched against the node's
	 * workspace-relative path, mark the node as an architectural hotspot.
	 * Typical examples: 'auth', 'middleware', 'config', 'payment'.
	 */
	readonly hotspotKeywords: readonly string[];
	/**
	 * Optional progress callback invoked after every batch of files. Used by
	 * the VS Code integration to drive a progress indicator; safe to ignore
	 * in headless / test scenarios.
	 */
	readonly onProgress?: (processed: number, total: number) => void;
}

/** A simple predicate used for glob-like matching without pulling in a full glob library. */
export interface IFileMatcher {
	matches(absolutePath: string, workspaceRoot: string): boolean;
}

/**
 * Result of an indexing pass. The graph contains every node that was visited
 * plus placeholder nodes for any external module that was imported from a
 * visited file. Diagnostics capture non-fatal issues (missing files, unparsed
 * imports, etc.) so the UI layer can decide whether to surface them.
 */
export interface IIndexResult {
	readonly graph: DependencyGraph;
	readonly diagnostics: readonly IIndexDiagnostic[];
	readonly stats: IIndexStats;
}

export interface IIndexDiagnostic {
	readonly severity: 'info' | 'warning' | 'error';
	readonly file: string;
	readonly message: string;
}

export interface IIndexStats {
	readonly filesVisited: number;
	readonly edgesEmitted: number;
	readonly durationMs: number;
}

/**
 * Index a TypeScript/JavaScript workspace into a {@link DependencyGraph}.
 *
 * The indexer walks the workspace on disk, filters via the supplied matchers,
 * and for each file uses the TypeScript compiler API to enumerate import and
 * export declarations. Edges are created pointing from the importing file to
 * the imported file (resolved to an absolute workspace-relative path where
 * possible). When resolution fails — typically because the import refers to
 * a third-party module — the indexer records a placeholder node keyed by the
 * import specifier and tags the edge as an external edge; the visualization
 * can choose whether to render those or collapse them into a single bucket.
 *
 * The indexer does NOT spin up a full TypeScript program because doing so
 * is both slow on large workspaces and imports significant type-checking
 * cost that the impact analysis does not need. Instead it parses each file
 * individually with `ts.createSourceFile` and walks the AST directly.
 */
export class WorkspaceIndexer {
	public async index(options: IIndexerOptions): Promise<IIndexResult> {
		const started = Date.now();
		const graph = new DependencyGraph();
		const diagnostics: IIndexDiagnostic[] = [];
		const files = this._collectFiles(options);
		let processed = 0;
		let edgesEmitted = 0;

		for (const absPath of files) {
			processed++;
			options.onProgress?.(processed, files.length);
			try {
				const nodeId = toWorkspaceRelativeId(options.workspaceRoot, absPath);
				const node = this._buildNode(nodeId, absPath, options.hotspotKeywords);
				graph.addNode(node);
				const emitted = this._extractEdges(graph, absPath, nodeId, options);
				edgesEmitted += emitted;
			} catch (err) {
				diagnostics.push({
					severity: 'warning',
					file: absPath,
					message: err instanceof Error ? err.message : String(err),
				});
			}
		}

		return {
			graph,
			diagnostics,
			stats: {
				filesVisited: processed,
				edgesEmitted,
				durationMs: Date.now() - started,
			},
		};
	}

	/**
	 * Build the on-disk file set that will be visited. Uses a BFS walk with
	 * the include/exclude matchers evaluated at every step so that large
	 * excluded trees (node_modules) are never descended into.
	 */
	private _collectFiles(options: IIndexerOptions): readonly string[] {
		const root = options.workspaceRoot;
		const result: string[] = [];
		const queue: string[] = [root];

		while (queue.length > 0) {
			const dir = queue.shift()!;
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				const full = path.join(dir, entry.name);
				if (options.excludeMatchers.some(m => m.matches(full, root))) {
					continue;
				}
				if (entry.isDirectory()) {
					queue.push(full);
				} else if (entry.isFile()) {
					if (options.includeMatchers.some(m => m.matches(full, root))) {
						result.push(full);
					}
				}
			}
		}
		return result;
	}

	private _buildNode(id: string, absPath: string, hotspotKeywords: readonly string[]): IGraphNode {
		let size = 0;
		try {
			size = fs.statSync(absPath).size;
		} catch {
			size = 0;
		}
		const lowered = id.toLowerCase();
		const hotspotMatches: string[] = [];
		for (const keyword of hotspotKeywords) {
			if (keyword && lowered.includes(keyword.toLowerCase())) {
				hotspotMatches.push(keyword.toLowerCase());
			}
		}
		return {
			id,
			uri: toFileUri(absPath),
			sizeBytes: size,
			hotspotMatches,
		};
	}

	/**
	 * Extract dependency edges from a single source file. The TypeScript
	 * scanner is used in lightweight `createSourceFile` mode — no full
	 * program is constructed. This keeps indexing O(file count) instead of
	 * O(file count * transitive symbol resolution) and is sufficient for
	 * the file-level granularity of the MVP.
	 */
	private _extractEdges(
		graph: DependencyGraph,
		absPath: string,
		nodeId: string,
		options: IIndexerOptions,
	): number {
		const sourceText = fs.readFileSync(absPath, 'utf8');
		const sourceFile = ts.createSourceFile(
			absPath,
			sourceText,
			ts.ScriptTarget.Latest,
			/* setParentNodes */ true,
			this._scriptKindFor(absPath),
		);
		let emitted = 0;

		const recordEdge = (spec: string, kind: EdgeKind): void => {
			const resolved = this._resolveModuleSpecifier(absPath, spec, options);
			if (resolved) {
				const toId = toWorkspaceRelativeId(options.workspaceRoot, resolved);
				graph.addEdge(nodeId, toId, kind);
				emitted++;
			} else {
				// External / unresolved — still record the edge so the graph
				// captures the structural relationship; the UI can collapse
				// external buckets if it wants to.
				graph.addEdge(nodeId, `external:${spec}`, kind);
				emitted++;
			}
		};

		ts.forEachChild(sourceFile, function walk(node: ts.Node) {
			if (ts.isImportDeclaration(node)) {
				if (ts.isStringLiteral(node.moduleSpecifier)) {
					const kind: EdgeKind = (node.importClause && node.importClause.isTypeOnly)
						? 'typeOnly'
						: 'import';
					recordEdge(node.moduleSpecifier.text, kind);
				}
			} else if (ts.isExportDeclaration(node)) {
				if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
					recordEdge(node.moduleSpecifier.text, node.isTypeOnly ? 'typeOnly' : 'reexport');
				}
			} else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
				const arg = node.arguments[0];
				if (arg && ts.isStringLiteral(arg)) {
					recordEdge(arg.text, 'dynamicImport');
				}
			}
			ts.forEachChild(node, walk);
		});

		return emitted;
	}

	private _scriptKindFor(absPath: string): ts.ScriptKind {
		const ext = path.extname(absPath).toLowerCase();
		switch (ext) {
			case '.tsx': return ts.ScriptKind.TSX;
			case '.ts': case '.mts': case '.cts': return ts.ScriptKind.TS;
			case '.jsx': return ts.ScriptKind.JSX;
			case '.js': case '.mjs': case '.cjs': return ts.ScriptKind.JS;
			default: return ts.ScriptKind.Unknown;
		}
	}

	/**
	 * Resolve a module specifier to an on-disk absolute path if possible.
	 *
	 * The strategy is deliberately simple:
	 *  1. Relative specifiers (starting with ./ or ../) are resolved against
	 *     the directory of the importing file, with extension probing in the
	 *     standard TS order.
	 *  2. Everything else is left to the caller — typically meaning the edge
	 *     will point at a synthetic `external:<spec>` node.
	 *
	 * A full TypeScript resolver (respecting tsconfig paths, node_modules
	 * lookup, exports maps, etc.) would be more accurate but substantially
	 * more expensive and harder to keep correct; the MVP trades that off.
	 */
	private _resolveModuleSpecifier(
		importerAbsPath: string,
		specifier: string,
		options: IIndexerOptions,
	): string | undefined {
		if (!specifier.startsWith('.')) {
			return undefined;
		}
		const base = path.dirname(importerAbsPath);
		const joined = path.resolve(base, specifier);
		const candidates = [
			joined,
			`${joined}.ts`,
			`${joined}.tsx`,
			`${joined}.js`,
			`${joined}.jsx`,
			`${joined}.mts`,
			`${joined}.cts`,
			path.join(joined, 'index.ts'),
			path.join(joined, 'index.tsx'),
			path.join(joined, 'index.js'),
		];
		for (const candidate of candidates) {
			if (options.excludeMatchers.some(m => m.matches(candidate, options.workspaceRoot))) {
				continue;
			}
			try {
				const stat = fs.statSync(candidate);
				if (stat.isFile()) {
					return candidate;
				}
			} catch {
				// not this candidate, try next
			}
		}
		return undefined;
	}
}

/**
 * Convert an absolute path to a workspace-relative, POSIX-style id. The id is
 * stable across platforms and is used as the canonical node identity in the
 * graph.
 */
export function toWorkspaceRelativeId(workspaceRoot: string, absolutePath: string): string {
	const rel = path.relative(workspaceRoot, absolutePath);
	return rel.split(path.sep).join('/');
}

function toFileUri(absolutePath: string): string {
	const normalized = absolutePath.replace(/\\/g, '/');
	return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
}

/**
 * Build a lightweight include/exclude matcher from an array of glob-ish
 * patterns. Supports `**` (any sub-path including empty), `*` (no path
 * separator), and literal segments. Enough for the patterns that appear in
 * the extension's default configuration; for arbitrary glob expressions the
 * caller should drop in a proper implementation.
 */
export function matcherFromGlobs(patterns: readonly string[]): IFileMatcher {
	const compiled = patterns.map(compileGlob);
	return {
		matches(absolutePath: string, workspaceRoot: string): boolean {
			const rel = toWorkspaceRelativeId(workspaceRoot, absolutePath);
			return compiled.some(r => r.test(rel));
		},
	};
}

function compileGlob(pattern: string): RegExp {
	let re = '^';
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === '*' && pattern[i + 1] === '*') {
			re += '.*';
			i += 2;
			if (pattern[i] === '/') {
				i++;
			}
		} else if (ch === '*') {
			re += '[^/]*';
			i++;
		} else if (ch === '?') {
			re += '[^/]';
			i++;
		} else if ('.+()|^$[]{}\\'.includes(ch)) {
			re += '\\' + ch;
			i++;
		} else {
			re += ch;
			i++;
		}
	}
	re += '$';
	return new RegExp(re);
}
