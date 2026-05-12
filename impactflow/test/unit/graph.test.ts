/*---------------------------------------------------------------------------------------------
 *  ImpactFlow — Architectural Impact Analysis
 *  MIT License — see LICENSE file at the project root.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { DependencyGraph, IGraphNode } from '../../src/core/graph';

const node = (id: string): IGraphNode => ({ id, uri: `file:///${id}`, sizeBytes: 0, hotspotMatches: [] });

suite('ImpactFlow / DependencyGraph', () => {
	test('addNode / hasNode / getNode', () => {
		const g = new DependencyGraph();
		g.addNode(node('a.ts'));
		assert.strictEqual(g.hasNode('a.ts'), true);
		assert.strictEqual(g.getNode('a.ts')!.id, 'a.ts');
		assert.strictEqual(g.hasNode('missing.ts'), false);
	});

	test('addEdge creates endpoints automatically', () => {
		const g = new DependencyGraph();
		g.addEdge('a.ts', 'b.ts', 'import');
		assert.strictEqual(g.hasNode('a.ts'), true);
		assert.strictEqual(g.hasNode('b.ts'), true);
		assert.strictEqual(g.edgeCount, 1);
	});

	test('outgoing and incoming adjacency', () => {
		const g = new DependencyGraph();
		g.addEdge('a.ts', 'b.ts', 'import');
		g.addEdge('a.ts', 'c.ts', 'typeOnly');
		g.addEdge('c.ts', 'b.ts', 'import');

		assert.strictEqual(g.outDegree('a.ts'), 2);
		assert.strictEqual(g.inDegree('b.ts'), 2);
		assert.strictEqual(g.inDegree('a.ts'), 0);

		const aOut = Array.from(g.outgoing('a.ts').keys()).sort();
		assert.deepStrictEqual(aOut, ['b.ts', 'c.ts']);
	});

	test('duplicate edges keep the strongest kind', () => {
		const g = new DependencyGraph();
		g.addEdge('a.ts', 'b.ts', 'typeOnly');
		g.addEdge('a.ts', 'b.ts', 'import');
		g.addEdge('a.ts', 'b.ts', 'reexport'); // weaker than existing 'import'
		assert.strictEqual(g.outgoing('a.ts').get('b.ts'), 'import');
	});

	test('findCycles detects a simple cycle', () => {
		const g = new DependencyGraph();
		g.addEdge('a.ts', 'b.ts', 'import');
		g.addEdge('b.ts', 'c.ts', 'import');
		g.addEdge('c.ts', 'a.ts', 'import');
		const cycles = g.findCycles();
		assert.strictEqual(cycles.length >= 1, true);
	});

	test('findCycles returns empty for a DAG', () => {
		const g = new DependencyGraph();
		g.addEdge('a.ts', 'b.ts', 'import');
		g.addEdge('b.ts', 'c.ts', 'import');
		g.addEdge('a.ts', 'c.ts', 'import');
		assert.strictEqual(g.findCycles().length, 0);
	});
});
