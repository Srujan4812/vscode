/*---------------------------------------------------------------------------------------------
 *  ImpactFlow — Architectural Impact Analysis
 *  MIT License — see LICENSE file at the project root.
 *--------------------------------------------------------------------------------------------*/

import { DependencyGraph } from './graph';
import { IIndexResult, IIndexerOptions, WorkspaceIndexer, matcherFromGlobs } from './indexer';
import { IPropagationOptions, propagateImpact } from './propagation';
import { IBlastRadius, INodeRisk, scoreBlastRadius, scoreNode } from './riskScorer';

/**
 * User-facing configuration for the analysis service. The VS Code layer
 * translates settings into this interface so that nothing in the core
 * references the `vscode` module.
 */
export interface IAnalysisConfig {
	readonly workspaceRoot: string;
	readonly include: readonly string[];
	readonly exclude: readonly string[];
	readonly hotspotKeywords: readonly string[];
	readonly maxDepth: number;
	readonly decayFactor: number;
}

export interface IAnalysisReport {
	readonly seedId: string;
	readonly blastRadius: IBlastRadius;
	readonly nodeRisks: readonly INodeRisk[];
	readonly impact: ReturnType<typeof propagateImpact>;
	readonly stats: IIndexResult['stats'];
	readonly generatedAt: number;
}

/**
 * Stateful analysis service. Owns the latest {@link DependencyGraph} and can
 * serve multiple impact queries against it without re-indexing. The VS Code
 * integration is responsible for deciding when to re-index (on activation,
 * on explicit refresh, on file save) and calls the corresponding methods
 * here.
 */
export class AnalysisService {
	private _graph: DependencyGraph | undefined;
	private _lastIndexedAt = 0;
	private readonly _indexer = new WorkspaceIndexer();

	get graph(): DependencyGraph | undefined {
		return this._graph;
	}

	get lastIndexedAt(): number {
		return this._lastIndexedAt;
	}

	/**
	 * Build a fresh workspace index. Any prior graph is discarded atomically
	 * once the new graph has been constructed, so callers that hold a
	 * reference to {@link graph} during indexing continue to see the old
	 * snapshot until this method returns.
	 */
	public async reindex(
		config: IAnalysisConfig,
		onProgress?: (processed: number, total: number) => void,
	): Promise<IIndexResult> {
		const options: IIndexerOptions = {
			workspaceRoot: config.workspaceRoot,
			includeMatchers: [matcherFromGlobs(config.include)],
			excludeMatchers: [matcherFromGlobs(config.exclude)],
			hotspotKeywords: config.hotspotKeywords,
			onProgress,
		};
		const result = await this._indexer.index(options);
		this._graph = result.graph;
		this._lastIndexedAt = Date.now();
		return result;
	}

	/**
	 * Run an impact analysis for a single seed file. Returns `undefined` if
	 * no graph is available (caller must reindex first) or if the seed is
	 * not known to the graph (file outside the workspace, excluded file,
	 * untracked file).
	 */
	public analyze(
		seedId: string,
		config: IAnalysisConfig,
	): IAnalysisReport | undefined {
		if (!this._graph || !this._graph.hasNode(seedId)) {
			return undefined;
		}
		const propagationOptions: IPropagationOptions = {
			maxDepth: config.maxDepth,
			decayFactor: config.decayFactor,
		};
		const impact = propagateImpact(this._graph, [seedId], propagationOptions);
		const nodeRisks = impact.impacted.map(i => scoreNode(this._graph!, i));
		const blastRadius = scoreBlastRadius(this._graph, impact);
		return {
			seedId,
			blastRadius,
			nodeRisks,
			impact,
			stats: { filesVisited: this._graph.nodeCount, edgesEmitted: this._graph.edgeCount, durationMs: 0 },
			generatedAt: Date.now(),
		};
	}

	/**
	 * Serialise the entire graph plus the given report into a JSON-safe
	 * payload suitable for feeding the webview visualization. Kept here
	 * (rather than in the webview layer) so that the contract between the
	 * algorithmic core and the UI is in one place and easy to evolve.
	 */
	public serializeForWebview(report: IAnalysisReport): IWebviewPayload {
		const graph = this._graph!;
		const nodeRiskMap = new Map(report.nodeRisks.map(r => [r.id, r]));

		const elements: IWebviewElement[] = [];
		for (const impacted of report.impact.impacted) {
			const risk = nodeRiskMap.get(impacted.id);
			const node = impacted.node;
			elements.push({
				group: 'nodes',
				data: {
					id: impacted.id,
					label: shortLabel(impacted.id),
					uri: node?.uri ?? '',
					depth: impacted.depth,
					weight: impacted.weight,
					riskLevel: risk?.level ?? 'low',
					riskScore: risk?.score ?? 0,
					hotspots: node?.hotspotMatches ?? [],
					sizeBytes: node?.sizeBytes ?? 0,
					kind: 'impacted',
				},
			});
		}
		// Seed nodes rendered separately so the webview can style them distinctly.
		for (const seedId of report.impact.seeds) {
			const node = graph.getNode(seedId);
			elements.push({
				group: 'nodes',
				data: {
					id: seedId,
					label: shortLabel(seedId),
					uri: node?.uri ?? '',
					depth: 0,
					weight: 1,
					riskLevel: 'critical',
					riskScore: 1,
					hotspots: node?.hotspotMatches ?? [],
					sizeBytes: node?.sizeBytes ?? 0,
					kind: 'seed',
				},
			});
		}
		// Edges: only those that participate in the impact set (otherwise the graph becomes unreadable).
		const includedIds = new Set<string>([...report.impact.seeds, ...report.impact.impacted.map(i => i.id)]);
		for (const edge of graph.edges()) {
			if (includedIds.has(edge.from) && includedIds.has(edge.to)) {
				elements.push({
					group: 'edges',
					data: {
						id: `${edge.from}->${edge.to}`,
						source: edge.from,
						target: edge.to,
						kind: edge.kind,
					},
				});
			}
		}
		return {
			elements,
			seed: report.seedId,
			blastRadius: report.blastRadius,
			generatedAt: report.generatedAt,
		};
	}
}

export interface IWebviewPayload {
	readonly elements: readonly IWebviewElement[];
	readonly seed: string;
	readonly blastRadius: IBlastRadius;
	readonly generatedAt: number;
}

export interface IWebviewElement {
	readonly group: 'nodes' | 'edges';
	readonly data: Record<string, unknown>;
}

function shortLabel(id: string): string {
	const slash = id.lastIndexOf('/');
	return slash >= 0 ? id.slice(slash + 1) : id;
}
