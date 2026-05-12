/*---------------------------------------------------------------------------------------------
 *  ImpactFlow — Architectural Impact Analysis
 *  MIT License — see LICENSE file at the project root.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { DependencyGraph, IGraphNode } from '../../src/core/graph';
import { propagateImpact } from '../../src/core/propagation';
import { scoreBlastRadius, scoreNode } from '../../src/core/riskScorer';

const node = (id: string, hotspot: readonly string[] = []): IGraphNode => ({
	id,
	uri: `file:///${id}`,
	sizeBytes: 100,
	hotspotMatches: hotspot,
});

suite('ImpactFlow / propagation', () => {
	test('seed with no reverse edges has empty impact', () => {
		const g = new DependencyGraph();
		g.addNode(node('seed.ts'));
		const result = propagateImpact(g, ['seed.ts'], { maxDepth: 5, decayFactor: 0.8 });
		assert.strictEqual(result.impacted.length, 0);
	});

	test('one-hop dependent is discovered', () => {
		const g = new DependencyGraph();
		g.addNode(node('lib.ts'));
		g.addNode(node('caller.ts'));
		g.addEdge('caller.ts', 'lib.ts', 'import');

		const result = propagateImpact(g, ['lib.ts'], { maxDepth: 5, decayFactor: 0.8 });
		assert.strictEqual(result.impacted.length, 1);
		assert.strictEqual(result.impacted[0].id, 'caller.ts');
		assert.strictEqual(result.impacted[0].depth, 1);
	});

	test('propagation respects decay and ordering', () => {
		const g = new DependencyGraph();
		// a <- b <- c <- d
		g.addEdge('b.ts', 'a.ts', 'import');
		g.addEdge('c.ts', 'b.ts', 'import');
		g.addEdge('d.ts', 'c.ts', 'import');
		const result = propagateImpact(g, ['a.ts'], { maxDepth: 5, decayFactor: 0.75 });
		const ids = result.impacted.map(i => i.id);
		assert.deepStrictEqual(ids, ['b.ts', 'c.ts', 'd.ts'], 'ordered by descending weight');
		assert.ok(result.impacted[0].weight > result.impacted[1].weight);
		assert.ok(result.impacted[1].weight > result.impacted[2].weight);
	});

	test('maxDepth truncates far-away nodes', () => {
		const g = new DependencyGraph();
		g.addEdge('b.ts', 'a.ts', 'import');
		g.addEdge('c.ts', 'b.ts', 'import');
		g.addEdge('d.ts', 'c.ts', 'import');
		const result = propagateImpact(g, ['a.ts'], { maxDepth: 2, decayFactor: 0.9 });
		const ids = result.impacted.map(i => i.id);
		assert.deepStrictEqual(ids.sort(), ['b.ts', 'c.ts']);
		assert.strictEqual(result.stats.truncatedAtDepth, true);
	});

	test('edge kind affects propagation strength', () => {
		const g = new DependencyGraph();
		g.addEdge('strong.ts', 'core.ts', 'import');
		g.addEdge('weak.ts', 'core.ts', 'typeOnly');
		const result = propagateImpact(g, ['core.ts'], { maxDepth: 5, decayFactor: 0.9 });
		const strong = result.impacted.find(i => i.id === 'strong.ts')!;
		const weak = result.impacted.find(i => i.id === 'weak.ts')!;
		assert.ok(strong.weight > weak.weight, 'runtime edge should outweigh type-only edge');
	});

	test('multiple seeds merge into a single traversal', () => {
		const g = new DependencyGraph();
		g.addEdge('shared.ts', 'a.ts', 'import');
		g.addEdge('shared.ts', 'b.ts', 'import');
		const result = propagateImpact(g, ['a.ts', 'b.ts'], { maxDepth: 3, decayFactor: 0.9 });
		// shared.ts should appear once, not twice.
		const sharedEntries = result.impacted.filter(i => i.id === 'shared.ts');
		assert.strictEqual(sharedEntries.length, 1);
	});
});

suite('ImpactFlow / riskScorer', () => {
	test('hotspot node is flagged in reasons', () => {
		const g = new DependencyGraph();
		g.addNode(node('core/auth.ts', ['auth']));
		g.addNode(node('app.ts'));
		g.addEdge('app.ts', 'core/auth.ts', 'import');
		const result = propagateImpact(g, ['core/auth.ts'], { maxDepth: 3, decayFactor: 0.9 });
		const risk = scoreNode(g, result.impacted[0]);
		assert.ok(risk.level !== 'low', `expected risk level above low, got ${risk.level}`);
	});

	test('blast radius level grows with impacted count', () => {
		const gSmall = new DependencyGraph();
		gSmall.addEdge('one.ts', 'seed.ts', 'import');
		const smallImpact = propagateImpact(gSmall, ['seed.ts'], { maxDepth: 3, decayFactor: 0.8 });
		const smallRadius = scoreBlastRadius(gSmall, smallImpact);

		const gLarge = new DependencyGraph();
		for (let i = 0; i < 40; i++) {
			gLarge.addEdge(`dep-${i}.ts`, 'seed.ts', 'import');
		}
		const largeImpact = propagateImpact(gLarge, ['seed.ts'], { maxDepth: 3, decayFactor: 0.8 });
		const largeRadius = scoreBlastRadius(gLarge, largeImpact);

		assert.ok(largeRadius.score > smallRadius.score, 'larger impact set should yield a higher blast radius');
	});

	test('blast radius surfaces affected hotspots', () => {
		const g = new DependencyGraph();
		g.addNode(node('seed.ts'));
		g.addNode(node('core/auth.ts', ['auth']));
		g.addNode(node('core/payment.ts', ['payment']));
		g.addEdge('core/auth.ts', 'seed.ts', 'import');
		g.addEdge('core/payment.ts', 'seed.ts', 'import');
		const impact = propagateImpact(g, ['seed.ts'], { maxDepth: 3, decayFactor: 0.9 });
		const radius = scoreBlastRadius(g, impact);
		assert.deepStrictEqual(radius.hotspotsAffected.sort(), ['auth', 'payment']);
	});
});
