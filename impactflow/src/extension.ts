/*---------------------------------------------------------------------------------------------
 *  ImpactFlow — Architectural Impact Analysis
 *  MIT License — see LICENSE file at the project root.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { AnalysisService, IAnalysisConfig } from './core/analysisService';
import { ImpactGraphPanel } from './vscode/impactGraphPanel';
import { ImpactTreeDataProvider } from './vscode/impactTreeView';

const IMPACTFLOW_SECTION = 'impactflow';

export function activate(context: vscode.ExtensionContext): void {
	const service = new AnalysisService();
	const tree = new ImpactTreeDataProvider();

	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('impactflow.impactView', tree),
	);

	const outputChannel = vscode.window.createOutputChannel('ImpactFlow');
	context.subscriptions.push(outputChannel);

	const ensureIndexed = async (config: IAnalysisConfig): Promise<boolean> => {
		if (service.graph) {
			return true;
		}
		return await rebuildIndex(service, config, outputChannel);
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('impactflow.rebuildIndex', async () => {
			const config = readConfig();
			if (!config) {
				void vscode.window.showWarningMessage('ImpactFlow: open a folder to index.');
				return;
			}
			await rebuildIndex(service, config, outputChannel);
		}),

		vscode.commands.registerCommand('impactflow.analyzeCurrentFile', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				void vscode.window.showInformationMessage('ImpactFlow: open a file to analyze.');
				return;
			}
			const config = readConfig();
			if (!config) {
				void vscode.window.showWarningMessage('ImpactFlow: open a folder to index.');
				return;
			}
			const ok = await ensureIndexed(config);
			if (!ok) {
				return;
			}
			const seedId = toSeedId(config.workspaceRoot, editor.document.uri.fsPath);
			const report = service.analyze(seedId, config);
			if (!report) {
				void vscode.window.showInformationMessage(
					`ImpactFlow: ${path.basename(editor.document.uri.fsPath)} is not in the workspace index. ` +
					`Check your include/exclude settings or run "ImpactFlow: Rebuild Workspace Index".`,
				);
				return;
			}
			tree.setReport(report);
			ImpactGraphPanel.show(context, service.serializeForWebview(report));
			outputChannel.appendLine(
				`[${new Date().toISOString()}] analyzed ${seedId}: ${report.blastRadius.level.toUpperCase()} blast radius, ${report.blastRadius.impactedCount} modules impacted.`,
			);
		}),

		vscode.commands.registerCommand('impactflow.showImpactGraph', async () => {
			void vscode.commands.executeCommand('impactflow.analyzeCurrentFile');
		}),

		vscode.commands.registerCommand('impactflow.revealFile', (node: { uri?: string }) => {
			if (node?.uri) {
				void vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(node.uri));
			}
		}),
	);

	// Re-index opportunistically when files relevant to the graph change.
	// Debounced so that a batched save (e.g. "Save All") only triggers once.
	const reindexDebounce = new Debouncer(1500);
	const watcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,js,jsx,mts,cts}');
	const scheduleReindex = () => {
		reindexDebounce.schedule(async () => {
			const config = readConfig();
			if (config && service.graph) {
				await rebuildIndex(service, config, outputChannel, /* silent */ true);
			}
		});
	};
	watcher.onDidChange(scheduleReindex);
	watcher.onDidCreate(scheduleReindex);
	watcher.onDidDelete(scheduleReindex);
	context.subscriptions.push(watcher, reindexDebounce);
}

export function deactivate(): void {
	// Nothing to tear down — everything is registered as a subscription on
	// the extension context and will be disposed automatically.
}

async function rebuildIndex(
	service: AnalysisService,
	config: IAnalysisConfig,
	output: vscode.OutputChannel,
	silent = false,
): Promise<boolean> {
	try {
		const reporter = silent
			? Promise.resolve(await service.reindex(config))
			: vscode.window.withProgress<ReturnType<AnalysisService['reindex']> extends Promise<infer R> ? R : never>(
				{ location: vscode.ProgressLocation.Notification, title: 'ImpactFlow: indexing workspace...', cancellable: false },
				async (progress) => {
					return await service.reindex(config, (processed, total) => {
						progress.report({ message: `${processed} / ${total} files` });
					});
				},
			);
		const result = await reporter;
		output.appendLine(
			`[${new Date().toISOString()}] indexed ${result.stats.filesVisited} files, ` +
			`${result.stats.edgesEmitted} edges in ${result.stats.durationMs} ms`,
		);
		return true;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		output.appendLine(`[${new Date().toISOString()}] index failed: ${message}`);
		if (!silent) {
			void vscode.window.showErrorMessage(`ImpactFlow: indexing failed — ${message}`);
		}
		return false;
	}
}

function readConfig(): IAnalysisConfig | undefined {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		return undefined;
	}
	const root = folders[0].uri.fsPath;
	const cfg = vscode.workspace.getConfiguration(IMPACTFLOW_SECTION);
	return {
		workspaceRoot: root,
		include: cfg.get<string[]>('include') ?? [],
		exclude: cfg.get<string[]>('exclude') ?? [],
		hotspotKeywords: cfg.get<string[]>('hotspotKeywords') ?? [],
		maxDepth: cfg.get<number>('maxDepth') ?? 5,
		decayFactor: cfg.get<number>('decayFactor') ?? 0.75,
	};
}

function toSeedId(workspaceRoot: string, absPath: string): string {
	const rel = path.relative(workspaceRoot, absPath);
	return rel.split(path.sep).join('/');
}

class Debouncer implements vscode.Disposable {
	private _timer: NodeJS.Timeout | undefined;

	constructor(private readonly _delay: number) { }

	schedule(fn: () => void | Promise<void>): void {
		if (this._timer) {
			clearTimeout(this._timer);
		}
		this._timer = setTimeout(() => { void fn(); }, this._delay);
	}

	dispose(): void {
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = undefined;
		}
	}
}
