import path from "node:path";

/**
 * Paths coming from the model are untrusted. Resolve them against the session
 * root and refuse anything that escapes it.
 */
export function resolveInRoot(root: string, candidate: string): string {
  const target = path.resolve(root, candidate);
  if (!isInside(root, target)) {
    throw new Error(
      `path escapes the project root: ${candidate} (root is ${root})`,
    );
  }
  return target;
}

/** Like resolveInRoot, but also accepts paths inside any read-only root. */
export function resolveReadable(
  root: string,
  candidate: string,
  readOnlyRoots: readonly string[] = [],
): string {
  const target = path.resolve(root, candidate);
  if (readOnlyRoots.some((extra) => isInside(extra, target))) return target;
  return resolveInRoot(root, candidate);
}

function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return !(rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel));
}

/** Display form of a path: relative to root, so the UI stays readable. */
export function displayPath(root: string, absolute: string): string {
  const rel = path.relative(root, absolute);
  return rel === "" ? "." : rel;
}

const ALWAYS_IGNORED = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
  ".cache",
]);

export function isIgnored(name: string): boolean {
  return ALWAYS_IGNORED.has(name);
}
