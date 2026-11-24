import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { writeFile } from "./fs.ts";

/**
 * Collects file writes and directory swaps so a failure part way through puts every one back, and a success
 * discards the backups. The sync touches the core, the lock, mapping files, the history, and reports together,
 * and a half-applied sync would leave the core and the adapter disagreeing.
 */
export function transaction() {
	const undo: (() => void)[] = [];
	const cleanup: (() => void)[] = [];
	return {
		writeFile(path: string, content: string): void {
			const previous = existsSync(path) ? readFileSync(path) : null;
			undo.push(() => (previous === null ? rmSync(path, { force: true }) : writeFile(path, previous)));
			writeFile(path, content);
		},
		swapDir(target: string, staged: string): void {
			const backup = `${target}.previous-${process.pid}`;
			rmSync(backup, { recursive: true, force: true });
			const had = existsSync(target);
			if (had) renameSync(target, backup);
			renameSync(staged, target);
			undo.push(() => {
				rmSync(target, { recursive: true, force: true });
				if (had) renameSync(backup, target);
			});
			cleanup.push(() => rmSync(backup, { recursive: true, force: true }));
		},
		commit(): void {
			for (const step of cleanup) step();
		},
		rollback(): void {
			for (const step of undo.reverse()) {
				try {
					step();
				} catch {
					/* keep restoring the rest */
				}
			}
		},
	};
}
