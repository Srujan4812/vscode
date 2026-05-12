/*---------------------------------------------------------------------------------------------
 *  ImpactFlow — Architectural Impact Analysis
 *  MIT License — see LICENSE file at the project root.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IAnalysisReport } from '../core/analysisService';
import { RiskLevel } from '../core/riskScorer';

/**
 * A tree node in the ImpactFlow explorer view. Two variants:
 *  - `group`: a risk-level bucket ("Critical (2)", "High (5)", ...).
 *  - `file`: a single impacted file, shown inside the group it belongs to.
 */
type TreeNode =
	| { kind: 'group'; level: RiskLevel; count: number }
	| { kind: 'file'; id: string; uri: string; label: string; description: string; level: RiskLevel };

export class ImpactTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
	public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private _report: IAnalysisReport | undefined;

	public setReport(report: IAnalysisReport | undefined): void {
		this._report = report;
		this._onDidChangeTreeData.fire();
	}

	public getTreeItem(element: TreeNode): vscode.TreeItem {
		if (element.kind === 'group') {
			const label = `${levelLabel(element.level)} (${element.count})`;
			const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
			item.iconPath = new vscode.ThemeIcon(levelIcon(element.level), levelColor(element.level));
			item.contextValue = 'impactflow.group';
			return item;
		}
		const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
		item.description = element.description;
		item.tooltip = new vscode.MarkdownString(
			`**${element.id}**\n\n- Risk level: \`${element.level}\`\n- Click to open`,
		);
		item.iconPath = new vscode.ThemeIcon('file-code');
		item.resourceUri = vscode.Uri.parse(element.uri);
		item.contextValue = 'impactflow.file';
		item.command = {
			command: 'vscode.open',
			title: 'Open File',
			arguments: [vscode.Uri.parse(element.uri)],
		};
		return item;
	}

	public getChildren(element?: TreeNode): vscode.ProviderResult<TreeNode[]> {
		if (!this._report) {
			return [];
		}
		if (!element) {
			// Top-level: one group per risk level that actually has members.
			const buckets = this._bucketByLevel();
			const order: RiskLevel[] = ['critical', 'high', 'medium', 'low'];
			return order
				.filter(l => (buckets.get(l)?.length ?? 0) > 0)
				.map(level => ({ kind: 'group' as const, level, count: buckets.get(level)!.length }));
		}
		if (element.kind === 'group') {
			return this._bucketByLevel().get(element.level) ?? [];
		}
		return [];
	}

	private _bucketByLevel(): Map<RiskLevel, TreeNode[]> {
		const buckets = new Map<RiskLevel, TreeNode[]>();
		if (!this._report) {
			return buckets;
		}
		const riskById = new Map(this._report.nodeRisks.map(r => [r.id, r]));
		for (const impacted of this._report.impact.impacted) {
			const risk = riskById.get(impacted.id);
			const level: RiskLevel = risk?.level ?? 'low';
			if (!buckets.has(level)) {
				buckets.set(level, []);
			}
			const uri = impacted.node?.uri ?? '';
			if (!uri) {
				continue;
			}
			buckets.get(level)!.push({
				kind: 'file',
				id: impacted.id,
				uri,
				label: shortLabel(impacted.id),
				description: `depth ${impacted.depth} · w=${impacted.weight.toFixed(2)}`,
				level,
			});
		}
		return buckets;
	}
}

function shortLabel(id: string): string {
	const slash = id.lastIndexOf('/');
	return slash >= 0 ? id.slice(slash + 1) : id;
}

function levelLabel(level: RiskLevel): string {
	switch (level) {
		case 'critical': return 'Critical';
		case 'high': return 'High';
		case 'medium': return 'Medium';
		case 'low': return 'Low';
	}
}

function levelIcon(level: RiskLevel): string {
	switch (level) {
		case 'critical': return 'error';
		case 'high': return 'warning';
		case 'medium': return 'info';
		case 'low': return 'circle-outline';
	}
}

function levelColor(level: RiskLevel): vscode.ThemeColor {
	switch (level) {
		case 'critical': return new vscode.ThemeColor('charts.red');
		case 'high': return new vscode.ThemeColor('charts.orange');
		case 'medium': return new vscode.ThemeColor('charts.yellow');
		case 'low': return new vscode.ThemeColor('charts.blue');
	}
}
