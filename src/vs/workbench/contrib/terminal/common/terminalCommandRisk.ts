/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Risk classification levels for terminal commands.
 *
 * - `high`: Irreversible, destructive, or broadly impactful operations (e.g. `rm -rf /`,
 *   `git reset --hard`, `dd` writing to a block device).
 * - `medium`: Potentially destructive but more narrowly scoped, or operations that
 *   typically have mitigations (e.g. recursive `chmod`, `npm uninstall -g`).
 */
export type TerminalCommandRiskLevel = 'medium' | 'high';

/**
 * Categorisation of terminal command risks, kept intentionally small and
 * domain-oriented so that each category can map to a localised, human readable
 * explanation at the UI layer.
 */
export type TerminalCommandRiskCategory =
	| 'destructiveFilesystem'
	| 'destructiveGit'
	| 'destructiveContainer'
	| 'destructivePackage'
	| 'destructiveDisk'
	| 'privilegedPermission'
	| 'remoteCodeExecution'
	| 'forkBomb';

/**
 * The result of a risk analysis pass. `reasons` is a list of stable identifier
 * tokens (not user-facing text) so that the UI layer can map them to localised
 * strings independently of the detector.
 */
export interface ITerminalCommandRisk {
	readonly level: TerminalCommandRiskLevel;
	readonly category: TerminalCommandRiskCategory;
	/** The substring of the original (normalised) command that triggered the match. */
	readonly matched: string;
	/** Stable reason identifiers for UI localisation. */
	readonly reasons: readonly string[];
}

/**
 * A single detection rule. Rules are evaluated in order and the first match
 * wins — so more specific / higher severity rules should appear earlier in
 * the rule list.
 */
interface ITerminalCommandRiskRule {
	readonly pattern: RegExp;
	readonly level: TerminalCommandRiskLevel;
	readonly category: TerminalCommandRiskCategory;
	readonly reasons: readonly string[];
}

// -----------------------------------------------------------------------------
// Rule library
// -----------------------------------------------------------------------------
//
// Rules are intentionally conservative: they aim for a low false-positive rate
// on realistic command lines rather than exhaustive coverage of every possible
// dangerous invocation. The detector is a hint to the user, not a sandbox.
//
// Each `pattern` is expected to operate on a command that has been pre-trimmed
// and collapsed via {@link normalizeCommand}. The patterns use `[^|;&]*` as a
// "stay within this command" guard so that a dangerous tail after a pipe or
// command separator does not accidentally anchor to an earlier safe prefix.
//
// Reviewer notes:
//  - Full shell parsing is intentionally avoided; it would be a large source
//    of bugs and is unnecessary for a hinting feature gated behind a dialog.
//  - Each rule is designed to be auditable in isolation. Prefer adding a new
//    narrow rule over extending an existing broad one.

/** Match any combined short flag containing both `r` (or `R`) and `f`, in any order. */
const RM_COMBINED_FLAG = /-[a-zA-Z]*(?:[rR][a-zA-Z]*f|f[a-zA-Z]*[rR])[a-zA-Z]*/;

/** Match the recursive + force long/short flag pair when the two appear as separate tokens. */
const RM_SEPARATE_RF = /(?:-[rR]\s+-f|-f\s+-[rR]|--recursive\s+--force|--force\s+--recursive|--recursive\s+-f|-[rR]\s+--force|--force\s+-[rR]|-f\s+--recursive)/;

const rules: readonly ITerminalCommandRiskRule[] = [
	// ---- Fork bomb (must be matched before generic filesystem rules) ------
	{
		pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
		level: 'high',
		category: 'forkBomb',
		reasons: ['forkBomb'],
	},

	// ---- Destructive filesystem -------------------------------------------
	// rm with recursive + force (combined flag form).
	{
		pattern: new RegExp(String.raw`\brm\b[^|;&]*\s` + RM_COMBINED_FLAG.source + String.raw`\b`),
		level: 'high',
		category: 'destructiveFilesystem',
		reasons: ['recursiveForceDelete'],
	},

	// rm with recursive + force split across multiple flags.
	{
		pattern: new RegExp(String.raw`\brm\b[^|;&]*\s` + RM_SEPARATE_RF.source + String.raw`\b`),
		level: 'high',
		category: 'destructiveFilesystem',
		reasons: ['recursiveForceDelete'],
	},

	// Windows rmdir with /s and /q in any order.
	{
		pattern: /\brmdir\b[^|;&]*\s\/s\b[^|;&]*\s\/q\b|\brmdir\b[^|;&]*\s\/q\b[^|;&]*\s\/s\b/i,
		level: 'high',
		category: 'destructiveFilesystem',
		reasons: ['recursiveForceDelete'],
	},

	// Windows del with /s and /q in any order.
	{
		pattern: /\bdel\b[^|;&]*\s\/[sS]\b[^|;&]*\s\/[qQ]\b|\bdel\b[^|;&]*\s\/[qQ]\b[^|;&]*\s\/[sS]\b/,
		level: 'high',
		category: 'destructiveFilesystem',
		reasons: ['recursiveForceDelete'],
	},

	// PowerShell Remove-Item with -Recurse and -Force in any order.
	{
		pattern: /\bRemove-Item\b[^|;&]*-Recurse\b[^|;&]*-Force\b|\bRemove-Item\b[^|;&]*-Force\b[^|;&]*-Recurse\b/i,
		level: 'high',
		category: 'destructiveFilesystem',
		reasons: ['recursiveForceDelete'],
	},

	// ---- Destructive disk / block-device writes ---------------------------
	// dd writing to a raw block device. Requires of=/dev/... to avoid flagging
	// `dd if=/dev/random of=file.bin`.
	{
		pattern: /\bdd\b[^|;&]*\bof=\/dev\/(?:sd[a-z]\d*|nvme\d+n\d+(?:p\d+)?|hd[a-z]\d*|disk\d+|rdisk\d+)\b/,
		level: 'high',
		category: 'destructiveDisk',
		reasons: ['blockDeviceWrite'],
	},

	// mkfs on a raw device.
	{
		pattern: /\bmkfs(?:\.[a-z0-9]+)?\b\s+\/dev\/[a-z0-9]+/,
		level: 'high',
		category: 'destructiveDisk',
		reasons: ['filesystemFormat'],
	},

	// ---- Destructive git ---------------------------------------------------
	{
		pattern: /\bgit\s+reset\s+(?:--\S+\s+)*--hard\b/,
		level: 'high',
		category: 'destructiveGit',
		reasons: ['gitResetHard'],
	},
	{
		pattern: /\bgit\s+clean\s+(?:-[a-zA-Z]*[fd][a-zA-Z]*|--force)\b/,
		level: 'high',
		category: 'destructiveGit',
		reasons: ['gitCleanForce'],
	},
	{
		pattern: /\bgit\s+push\s+(?:[^|;&]*\s)?(?:--force(?!-with-lease)\b|-f\b)/,
		level: 'medium',
		category: 'destructiveGit',
		reasons: ['gitForcePush'],
	},
	{
		pattern: /\bgit\s+branch\s+-D\b|\bgit\s+branch\s+--delete\s+--force\b|\bgit\s+branch\s+--force\s+--delete\b/,
		level: 'medium',
		category: 'destructiveGit',
		reasons: ['gitBranchForceDelete'],
	},

	// ---- Destructive container ops ----------------------------------------
	{
		pattern: /\bdocker\s+system\s+prune\b/,
		level: 'high',
		category: 'destructiveContainer',
		reasons: ['containerSystemPrune'],
	},
	{
		pattern: /\bdocker\s+volume\s+prune\b|\bdocker\s+volume\s+rm\b/,
		level: 'high',
		category: 'destructiveContainer',
		reasons: ['containerVolumeRemove'],
	},
	{
		pattern: /\bdocker\s+(?:rm|container\s+rm)\b[^|;&]*\s(?:--force|-[a-zA-Z]*f[a-zA-Z]*)\b/,
		level: 'medium',
		category: 'destructiveContainer',
		reasons: ['containerForceRemove'],
	},
	{
		pattern: /\bkubectl\s+delete\b[^|;&]*--all\b/,
		level: 'high',
		category: 'destructiveContainer',
		reasons: ['kubectlDeleteAll'],
	},

	// ---- Package manager destructive ops ----------------------------------
	{
		pattern: /\bnpm\s+(?:uninstall|rm|remove)\s+(?:[^|;&]*\s)?(?:-g|--global)\b/,
		level: 'medium',
		category: 'destructivePackage',
		reasons: ['globalPackageRemove'],
	},
	{
		pattern: /\b(?:brew|apt|apt-get|yum|dnf|pacman)\s+(?:remove|uninstall|purge|autoremove)\b/,
		level: 'medium',
		category: 'destructivePackage',
		reasons: ['systemPackageRemove'],
	},

	// ---- Privileged permission changes ------------------------------------
	// chmod targeting the filesystem root specifically.
	{
		pattern: /\bchmod\s+(?:-R\s+)?(?:[0-7]{3,4}|[ugoa]*=?[rwx]+)\s+\/\s*$/,
		level: 'high',
		category: 'privilegedPermission',
		reasons: ['chmodRoot'],
	},
	// chmod -R with a permissive mode (anything granting world-writable or +w recursively).
	{
		pattern: /\bchmod\s+-R\s+(?:\d*[2367]\d{0,2}|[ugoa]*\+[rwx]*w[rwx]*)\b/,
		level: 'medium',
		category: 'privilegedPermission',
		reasons: ['chmodRecursivePermissive'],
	},
	{
		pattern: /\bchown\s+-R\s+\S+\s+\/\s*$/,
		level: 'high',
		category: 'privilegedPermission',
		reasons: ['chownRoot'],
	},

	// ---- Piping remote content into a shell (classic RCE vector) ----------
	// curl/wget ... | sh | bash | zsh | fish | dash | ksh (optionally via sudo).
	{
		pattern: /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish|dash|ksh)\b/,
		level: 'high',
		category: 'remoteCodeExecution',
		reasons: ['pipeRemoteToShell'],
	},
	// PowerShell iex against a web request.
	{
		pattern: /\b(?:iex|Invoke-Expression)\b[^|;&]*(?:iwr|Invoke-WebRequest|New-Object\s+Net\.WebClient|DownloadString)/i,
		level: 'high',
		category: 'remoteCodeExecution',
		reasons: ['pipeRemoteToShell'],
	},
];

/**
 * Collapse runs of whitespace into single spaces and trim. Normalisation is
 * applied before pattern matching so that rules can be written in a single
 * canonical form.
 */
function normalizeCommand(command: string): string {
	return command.replace(/\s+/g, ' ').trim();
}

/**
 * Detect a potentially destructive or dangerous command pattern.
 *
 * The detector is deliberately opinionated and small: it returns the first
 * match from a curated rule library rather than a full static analysis.
 * Callers are expected to gate their use on a user-facing setting so that
 * the behaviour can be disabled entirely.
 *
 * @returns The matched {@link ITerminalCommandRisk}, or `undefined` when no
 * rule matched. Returns `undefined` for empty or whitespace-only input.
 */
export function detectCommandRisk(command: string): ITerminalCommandRisk | undefined {
	if (!command) {
		return undefined;
	}
	const normalized = normalizeCommand(command);
	if (normalized.length === 0) {
		return undefined;
	}
	for (const rule of rules) {
		const match = rule.pattern.exec(normalized);
		if (match) {
			return {
				level: rule.level,
				category: rule.category,
				matched: match[0],
				reasons: rule.reasons,
			};
		}
	}
	return undefined;
}

/**
 * Exposed for tests and for UI layers that want to enumerate all known
 * categories (e.g. a settings page that lets the user opt out of specific
 * categories). Returns categories in registration order with duplicates
 * removed.
 */
export function getTerminalCommandRiskCategories(): readonly TerminalCommandRiskCategory[] {
	const seen = new Set<TerminalCommandRiskCategory>();
	const result: TerminalCommandRiskCategory[] = [];
	for (const rule of rules) {
		if (!seen.has(rule.category)) {
			seen.add(rule.category);
			result.push(rule.category);
		}
	}
	return result;
}
