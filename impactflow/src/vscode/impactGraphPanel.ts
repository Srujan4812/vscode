/*---------------------------------------------------------------------------------------------
 *  ImpactFlow — Architectural Impact Analysis
 *  MIT License — see LICENSE file at the project root.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { IWebviewPayload } from '../core/analysisService';

/**
 * Thin wrapper around a `vscode.WebviewPanel` that renders the impact graph.
 *
 * The panel is a singleton: opening a new analysis reuses the existing panel
 * if one is visible, otherwise a new one is created and revealed. This
 * matches the behaviour users expect from other VS Code visualization
 * panels (e.g. Git Graph, Markdown Preview).
 */
export class ImpactGraphPanel {
	private static _instance: ImpactGraphPanel | undefined;

	public static show(context: vscode.ExtensionContext, payload: IWebviewPayload): void {
		if (ImpactGraphPanel._instance) {
			ImpactGraphPanel._instance._update(payload);
			ImpactGraphPanel._instance._panel.reveal(vscode.ViewColumn.Beside, /* preserveFocus */ true);
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			'impactflow.graph',
			'ImpactFlow — Impact Graph',
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))],
			},
		);
		ImpactGraphPanel._instance = new ImpactGraphPanel(panel, context, payload);
	}

	private readonly _panel: vscode.WebviewPanel;
	private readonly _context: vscode.ExtensionContext;
	private readonly _disposables: vscode.Disposable[] = [];

	private constructor(
		panel: vscode.WebviewPanel,
		context: vscode.ExtensionContext,
		payload: IWebviewPayload,
	) {
		this._panel = panel;
		this._context = context;
		this._panel.webview.html = this._renderHtml();
		this._panel.webview.onDidReceiveMessage(msg => this._handleMessage(msg), undefined, this._disposables);
		this._panel.onDidDispose(() => this._dispose(), undefined, this._disposables);
		this._update(payload);
	}

	private _update(payload: IWebviewPayload): void {
		this._panel.webview.postMessage({ kind: 'setPayload', payload });
		const level = payload.blastRadius.level.toUpperCase();
		this._panel.title = `ImpactFlow — ${level} blast radius (${payload.blastRadius.impactedCount})`;
	}

	private _handleMessage(msg: unknown): void {
		if (!msg || typeof msg !== 'object') {
			return;
		}
		const m = msg as { kind?: string; uri?: string };
		if (m.kind === 'openFile' && typeof m.uri === 'string' && m.uri) {
			void vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(m.uri));
		}
	}

	private _renderHtml(): string {
		const mediaRoot = vscode.Uri.file(path.join(this._context.extensionPath, 'media'));
		const toWebviewUri = (name: string) =>
			this._panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, name));

		// Inline the cytoscape bundle if shipped locally; otherwise fall back
		// to a CDN reference via CSP-allowed unpkg. In the MVP we ship it via
		// the extension's `media/` folder to keep the UX fully offline.
		const nonce = createNonce();
		const csp = [
			`default-src 'none'`,
			`img-src ${this._panel.webview.cspSource} data:`,
			`style-src ${this._panel.webview.cspSource} 'unsafe-inline'`,
			`script-src 'nonce-${nonce}'`,
			`font-src ${this._panel.webview.cspSource}`,
		].join('; ');

		const cytoscapePath = path.join(this._context.extensionPath, 'media', 'cytoscape.min.js');
		const cytoscapeScriptTag = fs.existsSync(cytoscapePath)
			? `<script nonce="${nonce}" src="${toWebviewUri('cytoscape.min.js')}"></script>`
			: `<!-- cytoscape.min.js not bundled; drop it into media/ to enable the graph view -->`;

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<title>ImpactFlow — Impact Graph</title>
	<link rel="stylesheet" href="${toWebviewUri('graph.css')}" />
</head>
<body>
	<header id="impactflow-header">
		<div id="impactflow-title">
			<span class="impactflow-badge" data-level="low">Ready</span>
			<span id="impactflow-seed-label"></span>
		</div>
		<div id="impactflow-summary"></div>
	</header>
	<main>
		<div id="cy"></div>
		<aside id="impactflow-legend">
			<h3>Legend</h3>
			<ul class="impactflow-legend-list">
				<li><span class="dot seed"></span> Seed (selected)</li>
				<li><span class="dot critical"></span> Critical risk</li>
				<li><span class="dot high"></span> High risk</li>
				<li><span class="dot medium"></span> Medium risk</li>
				<li><span class="dot low"></span> Low risk</li>
			</ul>
			<h3>Reasons</h3>
			<ul id="impactflow-reasons"></ul>
		</aside>
	</main>
	${cytoscapeScriptTag}
	<script nonce="${nonce}" src="${toWebviewUri('graph.js')}"></script>
</body>
</html>`;
	}

	private _dispose(): void {
		ImpactGraphPanel._instance = undefined;
		while (this._disposables.length > 0) {
			this._disposables.pop()?.dispose();
		}
		this._panel.dispose();
	}
}

function createNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let s = '';
	for (let i = 0; i < 32; i++) {
		s += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return s;
}
