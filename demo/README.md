# Interactive demos

Two self-contained HTML pages that let you see the features in this fork
**running in a browser**, without installing Node, without building VS Code,
without setting up any extension development host.

Open either file with a double-click (or `Open with → Browser`).

## `track1-terminal-risk-preview.html`

A faithful port of the real command-risk detector
([`terminalCommandRisk.ts`](../src/vs/workbench/contrib/terminal/common/terminalCommandRisk.ts)),
wrapped in a VS Code-styled confirmation dialog. Type any command — or click
one of the preset buttons — and the page shows exactly what the integrated
terminal would show when the setting is enabled.

- **What the demo proves:** the detection logic correctly classifies realistic
  destructive commands across 8 categories, and correctly *ignores* safe
  lookalikes (`rm file.txt`, `git reset --soft`, `chmod 644`, `curl -o file`).
- **What it omits:** the actual terminal process write — the dialog's "Run" and
  "Cancel" buttons only report which code path would fire in the real extension.

## `track2-impactflow.html`

A standalone Cytoscape.js visualization of a sample ImpactFlow analysis. The
seed is a fictional `src/core/auth.ts`; ~15 downstream modules are shown with
the real styling, colors, node sizing, and edge weighting from the extension.

- **What the demo proves:** the visualization layer (colors, node sizes, edge
  styles, layout) works independently of the VS Code webview — the same CSS
  and Cytoscape configuration runs in any browser.
- **What it omits:** the real indexer and propagation algorithm — this page
  uses a hardcoded sample impact set so you don't need a TypeScript workspace
  to see the graph.

Requires an internet connection the first time (pulls Cytoscape from unpkg).

## Running the real thing

See [`../README.md`](../README.md) → *Running the code locally* for the full
Node-based setup. These demos are a shortcut for when you want to show
someone the result in 10 seconds.
