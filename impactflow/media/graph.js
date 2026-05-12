/*---------------------------------------------------------------------------------------------
 *  ImpactFlow — Architectural Impact Analysis
 *  MIT License — see LICENSE file at the project root.
 *
 *  This file runs inside a VS Code webview. It expects `cytoscape` to be
 *  available on the global scope (loaded via <script> tag from media/).
 *  If cytoscape is missing, the view falls back to a plain-HTML list so
 *  that the panel is still useful.
 *--------------------------------------------------------------------------------------------*/

(function () {
	'use strict';
	const vscode = acquireVsCodeApi();

	const badge = document.querySelector('.impactflow-badge');
	const seedLabel = document.getElementById('impactflow-seed-label');
	const summary = document.getElementById('impactflow-summary');
	const reasonsList = document.getElementById('impactflow-reasons');
	const cyEl = document.getElementById('cy');

	let cy = null;

	const levelColor = {
		critical: 'var(--impactflow-critical)',
		high: 'var(--impactflow-high)',
		medium: 'var(--impactflow-medium)',
		low: 'var(--impactflow-low)',
		seed: 'var(--impactflow-seed)',
	};

	function themeValue(cssVar) {
		return getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
	}

	function renderGraph(payload) {
		const hasCytoscape = typeof window.cytoscape === 'function';
		if (!hasCytoscape) {
			renderFallbackList(payload);
			return;
		}
		const elements = payload.elements.map(el => ({
			group: el.group,
			data: el.data,
		}));

		if (cy) {
			cy.elements().remove();
			cy.add(elements);
		} else {
			cy = window.cytoscape({
				container: cyEl,
				elements,
				wheelSensitivity: 0.2,
				style: buildStyleSheet(),
			});
			cy.on('tap', 'node', (evt) => {
				const uri = evt.target.data('uri');
				if (uri) {
					vscode.postMessage({ kind: 'openFile', uri });
				}
			});
		}

		const nodeCount = cy.nodes().length;
		const layoutName = nodeCount > 60 ? 'concentric' : 'cose';
		cy.layout({
			name: layoutName,
			animate: false,
			fit: true,
			padding: 30,
			// cose-specific tunings; harmless for 'concentric'.
			idealEdgeLength: 90,
			nodeRepulsion: 4500,
			edgeElasticity: 90,
		}).run();
	}

	function renderFallbackList(payload) {
		cyEl.innerHTML = '';
		const list = document.createElement('ol');
		list.style.padding = '24px 36px';
		list.style.margin = '0';
		for (const el of payload.elements) {
			if (el.group !== 'nodes') { continue; }
			const li = document.createElement('li');
			li.textContent = `${el.data.riskLevel.toUpperCase()} · ${el.data.id} (depth=${el.data.depth})`;
			li.style.padding = '4px 0';
			li.style.cursor = 'pointer';
			li.addEventListener('click', () => {
				if (el.data.uri) {
					vscode.postMessage({ kind: 'openFile', uri: el.data.uri });
				}
			});
			list.appendChild(li);
		}
		cyEl.appendChild(list);
	}

	function buildStyleSheet() {
		return [
			{
				selector: 'node',
				style: {
					'background-color': (ele) => themeColorForLevel(ele.data('riskLevel'), ele.data('kind') === 'seed'),
					'border-color': themeValue('--impactflow-border') || '#888',
					'border-width': 1,
					'label': 'data(label)',
					'color': themeValue('--impactflow-fg') || '#ddd',
					'font-size': 10,
					'text-valign': 'bottom',
					'text-margin-y': 6,
					'width': (ele) => nodeSize(ele),
					'height': (ele) => nodeSize(ele),
				},
			},
			{
				selector: 'node[kind = "seed"]',
				style: {
					'border-color': themeValue('--impactflow-seed') || '#b267e6',
					'border-width': 3,
					'shape': 'diamond',
				},
			},
			{
				selector: 'edge',
				style: {
					'curve-style': 'bezier',
					'target-arrow-shape': 'triangle',
					'line-color': themeValue('--impactflow-border') || '#888',
					'target-arrow-color': themeValue('--impactflow-border') || '#888',
					'width': (ele) => edgeWidthForKind(ele.data('kind')),
					'opacity': 0.65,
				},
			},
			{
				selector: 'edge[kind = "typeOnly"], edge[kind = "testOnly"]',
				style: { 'line-style': 'dashed', 'opacity': 0.4 },
			},
		];
	}

	function themeColorForLevel(level, isSeed) {
		if (isSeed) { return themeValue('--impactflow-seed') || '#b267e6'; }
		return themeValue('--impactflow-' + level) || '#61afef';
	}

	function nodeSize(ele) {
		const depth = ele.data('depth') || 0;
		const weight = ele.data('weight') || 0;
		return 18 + (1 - depth / 10) * 20 * Math.max(weight, 0.2);
	}

	function edgeWidthForKind(kind) {
		switch (kind) {
			case 'import': return 2.2;
			case 'reexport': return 2;
			case 'dynamicImport': return 1.6;
			case 'typeOnly': return 1.2;
			case 'testOnly': return 1;
			default: return 1.5;
		}
	}

	function updateHeader(payload) {
		const br = payload.blastRadius;
		badge.dataset.level = br.level;
		badge.textContent = br.level;
		seedLabel.textContent = payload.seed;
		summary.textContent = `Impacted modules: ${br.impactedCount} · score ${br.score.toFixed(2)}` +
			(br.hotspotsAffected.length > 0 ? ' · hotspots: ' + br.hotspotsAffected.join(', ') : '');
		reasonsList.innerHTML = '';
		for (const reason of br.reasons) {
			const li = document.createElement('li');
			li.innerHTML = `<code>${escapeHtml(reason)}</code>`;
			reasonsList.appendChild(li);
		}
	}

	function escapeHtml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (!msg || msg.kind !== 'setPayload' || !msg.payload) { return; }
		updateHeader(msg.payload);
		renderGraph(msg.payload);
	});
})();
