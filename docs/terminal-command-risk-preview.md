# Terminal Command Risk Preview — Design Notes

> Contribution notes for `feature/terminal-risk-preview` in this fork. Target repo: [microsoft/vscode](https://github.com/microsoft/vscode).

This document explains what the change does, where it hooks in, why that hook point was chosen, and what was deliberately left alone. It is written in the same shape as an upstream PR description — a maintainer can read this file and make a merge decision on it.

---

## 1. Problem statement

The VS Code integrated terminal will execute any command that a task, an extension, or a command contributor hands to it via `ITerminalInstance.sendText(text, shouldExecute: true)`. There is no ambient safety check on the command string. Historically that is fine — the terminal is a tool, not a sandbox, and the user always sees the command before pressing Enter.

The failure mode this change addresses is the class of situations where the command does **not** come from a user keystroke but still runs immediately:

- A task (`tasks.json`) with a misconfigured command line.
- An extension that resolves a template into a `rm -rf` and calls `sendText`.
- An AI-assisted agent that submits a command programmatically.
- A developer pasting a multi-command script that includes a destructive statement.

In every one of those cases, the user never had an opportunity to stop the command. Command Risk Preview reintroduces that opportunity — narrowly, opt-in, and without changing the terminal's interactive behaviour.

---

## 2. Scope

**In scope:**

- Matching command strings against a curated, reviewed list of destructive patterns (recursive/forced deletes, `git reset --hard`, `docker system prune`, raw `dd` writes, recursive chmod, `curl | sh`, fork bombs, etc.).
- Showing a confirmation dialog before executing a matched command.
- Honouring the user's decision — a cancelled confirmation drops the command silently; no events fire.

**Explicitly out of scope:**

- Intercepting raw keystrokes typed directly into the terminal.
- Parsing shell syntax (no AST, no quoting-aware analysis) — the detector is a set of regexes chosen for a low false-positive rate on realistic command lines.
- Running a sandbox, copy-on-write filesystem, or any kind of actual execution trap.
- Telemetry of any kind.

---

## 3. Where the change hooks in

The single integration point is `ITerminalInstance.sendText` (defined at `src/vs/workbench/contrib/terminal/browser/terminal.ts:1175`, implemented at `src/vs/workbench/contrib/terminal/browser/terminalInstance.ts:1372`).

Why this point:

- **User keystrokes do not go through it.** Typed characters flow through the xterm → PTY path directly. Only programmatic submissions — tasks, extensions, `runCommand`, drag-and-drop handlers — land at `sendText`. That is exactly the surface we want to guard.
- **The `shouldExecute` parameter already distinguishes the two cases we care about.** `runCommand` sends `\x03` to clear the prompt first (`sendText('\x03', false)`) and then the actual command (`sendText(commandLine, true)`). Keying the risk check off `shouldExecute === true` means control signals, partial input insertion, and bracketed-paste chunks are never intercepted.
- **There is already one call per submission.** No loop, no per-character cost. When the setting is off, the check is a single `getValue` lookup.

---

## 4. Implementation shape

### 4.1 Detector module (no VS Code imports)

`src/vs/workbench/contrib/terminal/common/terminalCommandRisk.ts`

- Exports one primary function: `detectCommandRisk(command: string): ITerminalCommandRisk | undefined`.
- Exports the `ITerminalCommandRisk` interface, the `TerminalCommandRiskLevel` union (`'medium' | 'high'`), and the `TerminalCommandRiskCategory` union (8 categories).
- Internal state: a single `rules` array of `{ pattern, level, category, reasons }` objects. Rules are evaluated in order; the first match wins.
- Normalisation: `\s+` collapsed to a single space and trimmed before matching. Keeps patterns simple.

Rules are grouped by category and sorted with "high-severity, unambiguous" first (fork bomb, recursive force delete, raw disk write, `git reset --hard`, `docker system prune`, raw chmod /) so that ambiguous medium-severity matches never mask a clear high-severity one.

### 4.2 Configuration schema

`src/vs/platform/terminal/common/terminal.ts` — adds `TerminalSettingId.CommandRiskPreviewEnabled = 'terminal.integrated.commandRiskPreview.enabled'`.

`src/vs/workbench/contrib/terminal/common/terminalConfiguration.ts` — registers the setting:

- `type: boolean`
- `default: false`
- `tags: ['preview']`
- `markdownDescription`: explains what the setting does and explicitly states that interactive keystrokes are not affected.

### 4.3 Integration

`src/vs/workbench/contrib/terminal/browser/terminalInstance.ts` — three surgical changes:

1. Import `IDialogService` and the risk detector.
2. Constructor: one new `@IDialogService private readonly _dialogService: IDialogService` parameter. `IConfigurationService` is already there.
3. `sendText`: a single `if (shouldExecute && <config on>)` guard at the very top. If the guard fires, it calls `this._confirmCommandRiskPreview(text)`; on `false` it returns immediately, preserving every existing event-firing semantic for the "allowed" path.
4. Three private helpers: `_confirmCommandRiskPreview`, `_formatCommandRiskDetail`, `_commandRiskCategoryLabel`. All strings are localised through `nls.localize` with stable keys.

No existing code path changes its behaviour when the setting is off.

---

## 5. Commit series

Three commits, each independently revertable:

| Commit | Purpose | Size |
|---|---|---|
| `cde14519a80` | `terminal: add command risk detector module` | 630 insertions (detector + 60+ unit tests) |
| `4f9c3e79eff` | `terminal: register commandRiskPreview.enabled setting` | 7 insertions (enum + schema only; zero behavior change) |
| `637358b7d14` | `terminal: gate sendText on command risk preview` | 74 insertions (the actual integration) |

Reviewers who disagree with the chosen hook point can drop the third commit and keep the detector as a library.

---

## 6. Tests

`src/vs/workbench/contrib/terminal/test/common/terminalCommandRisk.test.ts` — ~60 test cases covering:

- **Positive matches** for every category: `rm -rf /`, `rm -fr`, `rm --recursive --force`, `Remove-Item -Recurse -Force`, `rmdir /s /q`, `dd of=/dev/sda`, `mkfs.ext4 /dev/sdb1`, `git reset --hard`, `git clean -fd`, `git push --force`, `git branch -D`, `docker system prune`, `docker volume rm`, `docker rm -f`, `kubectl delete --all`, `npm uninstall -g`, `apt-get purge`, `chmod -R 777`, `chmod 777 /`, `curl | sh`, `curl | sudo bash`, `iex (iwr ...)`, fork bombs.
- **Negative (safe) cases:** `rm file.txt`, `rm -i`, `rm -r` alone, `git reset --soft`, `git push origin main`, `git push --force-with-lease`, `chmod 644`, `chmod +x`, `dd if=/dev/random of=file.bin`, `curl -o file`, `curl | jq`, `docker ps`, `docker run`, `npm install`, `npm uninstall` (local).
- **Edge cases:** empty input, whitespace-only input, `sudo` prefix, `echo "rm -rf /"`, commit messages.

No disposables are created in the test file, but `ensureNoDisposablesAreLeakedInTestSuite()` is called so future additions to the suite stay consistent with the rest of the terminal test infrastructure.

Regex correctness was independently verified against .NET's regex engine outside the build; see the commit history for the sanity-check script (it was removed before committing).

---

## 7. Risks and rollback plan

| Risk | Mitigation |
|---|---|
| False positive on a benign command | Dialog is an informational prompt with a "Run Command" button — never a hard block. The user can always proceed. |
| Performance regression in the terminal | The gate is `shouldExecute && getValue(...)` — a single configuration lookup when disabled. When enabled, the cost is one regex walk per submission (not per keystroke). |
| Localisation regressions | All user-facing strings use `nls.localize` with stable keys and comments for mnemonics; the category label helper is an exhaustive `switch` that TypeScript's strict-mode compiler enforces at type-check time. |
| Merge conflicts with other terminal work | The three commits are small and target well-separated files (`terminal.ts` enum tail, `terminalConfiguration.ts` near the existing `EnableMultiLinePasteWarning` entry, `terminalInstance.ts` sendText method + constructor). |

Rollback = revert the three commits in order. The detector module becomes a standalone utility with no callers.

---

## 8. What would be a v2

- A category-level opt-out (`terminal.integrated.commandRiskPreview.categories: string[]`) for users who want the detector for disk/RCE only and explicitly trust their docker/git usage.
- A "show pattern that matched" affordance in the dialog (currently the `matched` substring is computed but only used internally).
- Telemetry — *only* if the maintainer team requested it, and only counts of matches by category, never the command strings themselves.
- Shell-aware normalisation (strip `sudo`, normalise long/short flags) to broaden match coverage without rewriting every rule.

None of these are needed for the minimal maintainer-mergeable contribution. They are natural follow-ups if the opt-in feature graduates out of `preview`.
