/*---------------------------------------------------------------------------------------------
 *  ImpactFlow — Architectural Impact Analysis
 *  MIT License — see LICENSE file at the project root.
 *--------------------------------------------------------------------------------------------*/

/**
 * Kind of dependency edge. Different edge kinds contribute different weights to
 * the propagation algorithm — for example a runtime import should propagate more
 * strongly than a type-only import or a test-only import.
 */
export type EdgeKind = 'import' | 'reexport' | 'typeOnly' | 'dynamicImport' | 'testOnly';

/**
 * An edge between two modules in the dependency graph. Edges are directed:
 * `from` depends on `to`. In the impact propagation algorithm we traverse in
 * the reverse direction — starting from a seed node, we follow incoming
 * edges to find who would be affected by a change.
 */
export interface IGraphEdge {
	readonly from: string;
	readonly to: string;
	readonly kind: EdgeKind;
}

/**
 * A node in the dependency graph. Each node corresponds to a source file
 * (identified by its workspace-relative POSIX path). Additional metadata
 * computed during indexing — fan-in / fan-out / hotspot score — is persisted
 * so that consumers of the graph do not have to recompute it.
 */
export interface IGraphNode {
	readonly id: string;
	/** Absolute file URI string (e.g. `file:///...`) for navigation. */
	readonly uri: string;
	/** Size of the file in bytes at index time, used as a rough complexity hint. */
	readonly sizeBytes: number;
	/** Matched hotspot keywords (lowercased), empty when none matched. */
	readonly hotspotMatches: readonly string[];
}

/**
 * Relative weight of each edge kind. Values are in the range (0, 1] and were
 * chosen by intuition — a runtime import has maximum effect, a type-only
 * import is typically erased at build time so its runtime blast radius is
 * smaller, and a test-only edge should not cause an "affected service"
 * classification on its own.
 *
 * Exposed as a readonly record so callers can inspect and, if necessary,
 * compose a different weighting scheme.
 */
export const DEFAULT_EDGE_WEIGHTS: Readonly<Record<EdgeKind, number>> = Object.freeze({
	import: 1.0,
	reexport: 0.9,
	dynamicImport: 0.8,
	typeOnly: 0.4,
	testOnly: 0.2,
});

/**
 * Directed dependency graph with adjacency lists in both directions. Kept
 * intentionally minimal — no fancy query interface, just the primitives that
 * the propagation algorithm and the visualization need.
 *
 * Node identity is a string (workspace-relative POSIX path). All edges are
 * stored in a flat `Map<fromId, Map<toId, EdgeKind>>` structure; the reverse
 * adjacency is maintained incrementally so that the impact algorithm (which
 * walks reverse edges) does not have to rebuild an inverted index each run.
 *
 * Mutation is only exposed through the explicit methods — there is no way to
 * reach inside and corrupt invariants. `clone()` produces a shallow copy that
 * shares node metadata objects but has its own adjacency maps, which is
 * enough for the "snapshot the graph then mutate without affecting running
 * consumers" use case.
 */
export class DependencyGraph {
	private readonly _nodes = new Map<string, IGraphNode>();
	private readonly _forward = new Map<string, Map<string, EdgeKind>>();
	private readonly _reverse = new Map<string, Map<string, EdgeKind>>();

	get nodeCount(): number {
		return this._nodes.size;
	}

	get edgeCount(): number {
		let count = 0;
		for (const adj of this._forward.values()) {
			count += adj.size;
		}
		return count;
	}

	addNode(node: IGraphNode): void {
		this._nodes.set(node.id, node);
		if (!this._forward.has(node.id)) {
			this._forward.set(node.id, new Map());
		}
		if (!this._reverse.has(node.id)) {
			this._reverse.set(node.id, new Map());
		}
	}

	hasNode(id: string): boolean {
		return this._nodes.has(id);
	}

	getNode(id: string): IGraphNode | undefined {
		return this._nodes.get(id);
	}

	/**
	 * Add a directed edge. If either endpoint does not yet have a node
	 * registered, a placeholder node is created automatically — this keeps
	 * the indexer simple, which can record edges to e.g. `node_modules`
	 * entries without also having to create node metadata for them.
	 */
	addEdge(from: string, to: string, kind: EdgeKind): void {
		if (!this._nodes.has(from)) {
			this.addNode({ id: from, uri: '', sizeBytes: 0, hotspotMatches: [] });
		}
		if (!this._nodes.has(to)) {
			this.addNode({ id: to, uri: '', sizeBytes: 0, hotspotMatches: [] });
		}
		// If the same edge is recorded multiple times with different kinds,
		// keep the strongest (runtime > reexport > dynamic > type > test).
		const existing = this._forward.get(from)!.get(to);
		if (existing && edgeKindPriority(existing) >= edgeKindPriority(kind)) {
			return;
		}
		this._forward.get(from)!.set(to, kind);
		this._reverse.get(to)!.set(from, kind);
	}

	/** All node ids in insertion order. */
	nodes(): IterableIterator<IGraphNode> {
		return this._nodes.values();
	}

	/** Outgoing neighbors of the given node (empty iterable when node missing). */
	outgoing(id: string): ReadonlyMap<string, EdgeKind> {
		return this._forward.get(id) ?? emptyMap;
	}

	/** Incoming neighbors of the given node (used by reverse BFS). */
	incoming(id: string): ReadonlyMap<string, EdgeKind> {
		return this._reverse.get(id) ?? emptyMap;
	}

	/** Fan-out: number of modules this one depends on. */
	outDegree(id: string): number {
		return this._forward.get(id)?.size ?? 0;
	}

	/** Fan-in: number of modules that depend on this one (strong centrality signal). */
	inDegree(id: string): number {
		return this._reverse.get(id)?.size ?? 0;
	}

	/**
	 * Produce an iterable of all edges. Order is not guaranteed to be stable
	 * across graph rebuilds but is deterministic for a fixed graph snapshot.
	 */
	*edges(): IterableIterator<IGraphEdge> {
		for (const [from, adj] of this._forward) {
			for (const [to, kind] of adj) {
				yield { from, to, kind };
			}
		}
	}

	/**
	 * Basic cycle detection via DFS. Returns an array of cycles where each
	 * cycle is the sequence of node ids that form it (the first id is
	 * repeated at the end to make the cycle visually explicit). Intended
	 * for architectural inspection — surfacing circular dependencies is a
	 * useful diagnostic for the visualization layer.
	 */
	findCycles(): readonly (readonly string[])[] {
		const cycles: string[][] = [];
		const onStack = new Set<string>();
		const visited = new Set<string>();
		const stack: string[] = [];

		const dfs = (node: string): void => {
			onStack.add(node);
			stack.push(node);
			for (const [neighbor] of this.outgoing(node)) {
				if (!visited.has(neighbor) && !onStack.has(neighbor)) {
					dfs(neighbor);
				} else if (onStack.has(neighbor)) {
					const idx = stack.indexOf(neighbor);
					if (idx >= 0) {
						cycles.push([...stack.slice(idx), neighbor]);
					}
				}
			}
			onStack.delete(node);
			visited.add(node);
			stack.pop();
		};

		for (const id of this._nodes.keys()) {
			if (!visited.has(id)) {
				dfs(id);
			}
		}

		return cycles;
	}
}

function edgeKindPriority(kind: EdgeKind): number {
	switch (kind) {
		case 'import': return 5;
		case 'reexport': return 4;
		case 'dynamicImport': return 3;
		case 'typeOnly': return 2;
		case 'testOnly': return 1;
	}
}

const emptyMap: ReadonlyMap<string, EdgeKind> = new Map();
