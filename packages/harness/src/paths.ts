import path from "node:path";

/**
 * Paths coming from the model are untrusted. Resolve them against the session
 * root and refuse anything that escapes it.
 */
export function resolveInRoot(root: string, candidate: string): string {
  const target = path.resolve(root, candidate);
  const rel = path.relative(root, target);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(
      `path escapes the project root: ${candidate} (root is ${root})`,
    );
  }
  return target;
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
