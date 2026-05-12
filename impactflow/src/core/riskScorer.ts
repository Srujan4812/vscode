/*---------------------------------------------------------------------------------------------
 *  ImpactFlow — Architectural Impact Analysis
 *  MIT License — see LICENSE file at the project root.
 *--------------------------------------------------------------------------------------------*/

import { DependencyGraph } from './graph';
import { IImpactNode, IImpactResult } from './propagation';

/** Bucketed risk level for a single node or a whole impact set. */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface INodeRisk {
	readonly id: string;
	readonly score: number;
	readonly level: RiskLevel;
	readonly reasons: readonly string[];
}

export interface IBlastRadius {
	readonly level: RiskLevel;
	readonly score: number;
	readonly impactedCount: number;
	readonly hotspotsAffected: readonly string[];
	readonly reasons: readonly string[];
}

/**
 * Scoring constants. Exposed as named constants — not magic numbers — so
 * their influence on the final score is visible at a glance and so the
 * scoring model can be tuned independently of the algorithmic core.
 */
const FAN_IN_WEIGHT = 0.45;
const PROPAGATION_WEIGHT = 0.30;
const DEPTH_PENALTY = 0.10; // nodes closer to the seed contribute more
const HOTSPOT_BONUS = 0.15;

/** Fan-in count above which the node is considered "maximally central". Used to normalise the raw count into [0, 1]. */
const FAN_IN_CEILING = 50;

/**
 * Score a single impacted node. The returned score is in [0, 1] where 1
 * represents the worst-case impact — a highly central, hotspot-tagged module
 * that lives directly adjacent to the seed.
 *
 * The formula is a weighted sum, intentionally additive so that its
 * contributors are individually interpretable: a reader can reason about
 * "this node is high-risk because it has 37 reverse deps AND matches the
 * `auth` keyword" without having to reverse-engineer a product of terms.
 */
export function scoreNode(graph: DependencyGraph, impacted: IImpactNode): INodeRisk {
	const reasons: string[] = [];
	const fanIn = graph.inDegree(impacted.id);
	const fanInNorm = Math.min(fanIn / FAN_IN_CEILING, 1);
	const depthNorm = 1 / (1 + impacted.depth);
	const hotspotCount = impacted.node?.hotspotMatches.length ?? 0;
	const hotspotNorm = hotspotCount > 0 ? 1 : 0;

	let score = 0;
	score += FAN_IN_WEIGHT * fanInNorm;
	score += PROPAGATION_WEIGHT * impacted.weight;
	score += DEPTH_PENALTY * depthNorm;
	score += HOTSPOT_BONUS * hotspotNorm;
	score = Math.min(score, 1);

	if (fanIn >= FAN_IN_CEILING / 2) {
		reasons.push(`highFanIn:${fanIn}`);
	}
	if (impacted.depth <= 1) {
		reasons.push('directDependent');
	}
	if (hotspotCount > 0 && impacted.node) {
		reasons.push(`hotspot:${impacted.node.hotspotMatches.join(',')}`);
	}
	if (impacted.weight > 0.7) {
		reasons.push('strongPropagation');
	}

	return {
		id: impacted.id,
		score,
		level: toLevel(score),
		reasons,
	};
}

/**
 * Score the entire impact set as a blast radius. This is the number the UI
 * displays as a banner ("Risk Level: HIGH") — it is not a simple max over
 * nodes because a single unimportant high-scorer should not drive the whole
 * blast radius to critical. We use a combination of:
 *  - The top-k average of per-node scores (robust against a single outlier).
 *  - A size factor based on how many modules are impacted.
 *  - A hotspot factor that counts how many distinct hotspots appear in the set.
 */
export function scoreBlastRadius(graph: DependencyGraph, impact: IImpactResult): IBlastRadius {
	const reasons: string[] = [];
	const nodeScores = impact.impacted.map(i => scoreNode(graph, i));
	const topK = Math.min(5, nodeScores.length);
	const topAvg = topK === 0
		? 0
		: nodeScores.slice(0, topK).reduce((acc, n) => acc + n.score, 0) / topK;

	const size = impact.impacted.length;
	const sizeNorm = Math.min(size / 30, 1);
	const hotspots = new Set<string>();
	for (const node of impact.impacted) {
		if (node.node) {
			for (const h of node.node.hotspotMatches) {
				hotspots.add(h);
			}
		}
	}
	const hotspotNorm = hotspots.size === 0 ? 0 : Math.min(hotspots.size / 3, 1);

	const score = Math.min(1, 0.55 * topAvg + 0.25 * sizeNorm + 0.20 * hotspotNorm);

	if (impact.stats.truncatedAtDepth) {
		reasons.push('truncatedDepth');
	}
	if (size >= 30) {
		reasons.push(`largeBlastRadius:${size}`);
	}
	if (hotspots.size > 0) {
		reasons.push(`hotspotsAffected:${Array.from(hotspots).join(',')}`);
	}
	if (topK > 0 && topAvg > 0.6) {
		reasons.push('strongCentralImpact');
	}

	return {
		level: toLevel(score),
		score,
		impactedCount: size,
		hotspotsAffected: Array.from(hotspots).sort(),
		reasons,
	};
}

function toLevel(score: number): RiskLevel {
	if (score >= 0.75) { return 'critical'; }
	if (score >= 0.55) { return 'high'; }
	if (score >= 0.30) { return 'medium'; }
	return 'low';
}
