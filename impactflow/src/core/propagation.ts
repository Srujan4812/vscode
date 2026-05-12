/*---------------------------------------------------------------------------------------------
 *  ImpactFlow — Architectural Impact Analysis
 *  MIT License — see LICENSE file at the project root.
 *--------------------------------------------------------------------------------------------*/

import { DEFAULT_EDGE_WEIGHTS, DependencyGraph, EdgeKind, IGraphNode } from './graph';

/**
 * Knob-set for the propagation algorithm. Defaults are tuned for
 * mid-sized TypeScript projects — on very large codebases you likely want
 * a lower `decayFactor` and/or a smaller `maxDepth` so the blast radius
 * stops exploding.
 */
export interface IPropagationOptions {
	readonly maxDepth: number;
	readonly decayFactor: number;
	/** Optional override for per-edge-kind weights. */
	readonly edgeWeights?: Readonly<Record<EdgeKind, number>>;
	/**
	 * Minimum propagation weight below which a node is no longer considered
	 * impacted. Small positive value prevents an effectively-infinite
	 * exploration caused by a very gentle decay.
	 */
	readonly minWeight?: number;
}

/**
 * A single affected node in the impact set. `depth` is the shortest reverse-
 * edge path from the seed to this node; `weight` is the accumulated
 * propagation weight (in (0, 1]) for that path.
 */
export interface IImpactNode {
	readonly id: string;
	readonly node: IGraphNode | undefined;
	readonly depth: number;
	readonly weight: number;
	/** The incoming edge kind of the first step towards this node (for UI styling). */
	readonly entryEdge: EdgeKind | undefined;
}

export interface IImpactResult {
	readonly seeds: readonly string[];
	readonly impacted: readonly IImpactNode[];
	readonly stats: {
		readonly visitedCount: number;
		readonly truncatedAtDepth: boolean;
	};
}

const DEFAULT_OPTIONS = {
	minWeight: 0.05,
} as const;

/**
 * Compute the downstream impact of changing the supplied seed files.
 *
 * The algorithm is a weighted reverse breadth-first search:
 *  - Start with every seed node at depth 0, weight 1.0.
 *  - For each node in the queue, look at its incoming edges (modules that
 *    import it).
 *  - For each incoming edge, compute the neighbor's weight as
 *    `currentWeight * edgeWeight * decayFactor`. If that weight is greater
 *    than any previously-recorded weight for the neighbor, update it and
 *    enqueue.
 *  - Stop descending once depth exceeds `maxDepth` or weight falls below
 *    `minWeight`.
 *
 * The result is ordered by descending weight so that the UI can trivially
 * show the "top-N most affected" modules without further sorting.
 */
export function propagateImpact(
	graph: DependencyGraph,
	seeds: readonly string[],
	options: IPropagationOptions,
): IImpactResult {
	const edgeWeights = options.edgeWeights ?? DEFAULT_EDGE_WEIGHTS;
	const minWeight = options.minWeight ?? DEFAULT_OPTIONS.minWeight;
	const best = new Map<string, { depth: number; weight: number; entryEdge: EdgeKind | undefined }>();
	const queue: { id: string; depth: number; weight: number; entryEdge: EdgeKind | undefined }[] = [];

	for (const seed of seeds) {
		best.set(seed, { depth: 0, weight: 1.0, entryEdge: undefined });
		queue.push({ id: seed, depth: 0, weight: 1.0, entryEdge: undefined });
	}

	let truncated = false;
	while (queue.length > 0) {
		const current = queue.shift()!;
		if (current.depth >= options.maxDepth) {
			truncated = true;
			continue;
		}
		for (const [fromId, kind] of graph.incoming(current.id)) {
			const edgeWeight = edgeWeights[kind];
			const nextWeight = current.weight * edgeWeight * options.decayFactor;
			if (nextWeight < minWeight) {
				continue;
			}
			const prior = best.get(fromId);
			if (prior && prior.weight >= nextWeight) {
				continue;
			}
			const record = {
				depth: current.depth + 1,
				weight: nextWeight,
				entryEdge: current.entryEdge ?? kind,
			};
			best.set(fromId, record);
			queue.push({ id: fromId, ...record });
		}
	}

	// Seeds are not part of the impact set — they are the cause, not the effect.
	const impacted: IImpactNode[] = [];
	for (const [id, record] of best) {
		if (seeds.includes(id)) {
			continue;
		}
		impacted.push({
			id,
			node: graph.getNode(id),
			depth: record.depth,
			weight: record.weight,
			entryEdge: record.entryEdge,
		});
	}
	impacted.sort((a, b) => b.weight - a.weight || a.depth - b.depth || a.id.localeCompare(b.id));

	return {
		seeds,
		impacted,
		stats: {
			visitedCount: best.size,
			truncatedAtDepth: truncated,
		},
	};
}
