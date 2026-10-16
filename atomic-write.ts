import {existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";

/**
 * Write a whole file by staging a sibling temp file and renaming it into
 * place. `rename` is atomic within a filesystem, so an interrupted write
 * (crash, ENOSPC, signal) leaves the PREVIOUS contents intact instead of a
 * truncated file. Truncated `settings.json` is the worst case for this
 * extension: Pi would come back with compaction switched off, silently.
 *
 * Options:
 *  - `mode`: octal mode for the staged file. Defaults to the existing
 *    target's mode, or 0600 when creating. Passing 0o600 forces it.
 *  - `backup`: when true (default) and the target already exists, its
 *    previous bytes are kept in `<target>.bak` immediately before the
 *    rename, so a bad write is recoverable. Only the newest backup is kept.
 *  - `suffix`: extra infix for the temp name, so concurrent writers in the
 *    same directory cannot collide on one staging path.
 *
 * Throws whatever the filesystem throws after cleaning up the staged file.
 */
export function writeFileAtomic(
	target: string,
	contents: string,
	options: {mode?: number; backup?: boolean; suffix?: string} = {},
): void {
	const {backup = true, suffix = `${process.pid}`} = options;
	const existed = existsSync(target);
	const mode = options.mode ?? (existed ? statSync(target).mode & 0o7777 : 0o600);
	const directory = dirname(target);
	if (!existed) mkdirSync(directory, {recursive: true, mode: 0o700});
	const temporary = join(directory, `.${basenameOf(target)}.${suffix}.tmp`);
	try {
		writeFileSync(temporary, contents, {mode});
		if (existed && backup) writeFileSync(join(directory, `${basenameOf(target)}.bak`), readFileSync(target, "utf8"), {mode});
		renameSync(temporary, target);
	} catch (error) {
		// Never leave staging debris behind; the original file is untouched.
		try {
			if (existsSync(temporary)) unlinkSync(temporary);
		} catch {
			/* Best effort. */
		}
		throw error;
	}
}

function basenameOf(target: string): string {
	return target.slice(target.lastIndexOf("/") + 1);
}
