import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join, relative } from "node:path";

const EXCLUDED_NAMES = new Set([".git", "node_modules"]);

export async function computeHarnessPayloadHash(repoRoot) {
  const hash = createHash("sha256");
  async function visit(path) {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (EXCLUDED_NAMES.has(entry.name) || entry.name.endsWith(".tgz")) continue;
      const child = join(path, entry.name);
      const name = relative(repoRoot, child).split("\\").join("/");
      const info = await lstat(child);
      if (info.isDirectory()) {
        hash.update(`d\0${name}\0`);
        await visit(child);
      } else if (info.isFile()) {
        hash.update(`f\0${name}\0${info.mode & 0o111}\0`);
        hash.update(await readFile(child));
        hash.update("\0");
      } else if (info.isSymbolicLink()) {
        hash.update(`l\0${name}\0${await readlink(child)}\0`);
      } else {
        throw new Error(`Unsupported file type in Pi Harness image payload: ${child}`);
      }
    }
  }
  await visit(repoRoot);
  return hash.digest("hex");
}
