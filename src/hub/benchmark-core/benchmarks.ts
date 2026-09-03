import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface BenchmarkDefinition {
  id: string;
  title: string;
  description: string;
  prompt: string;
  sourcePath: string;
}

interface BenchmarkFrontmatter {
  id?: unknown;
  title?: unknown;
  description?: unknown;
}

interface ParsedFrontmatter {
  data: Record<string, unknown>;
  content: string;
}

const FRONTMATTER_DELIMITER = "---";

/**
 * Parse a `---`-delimited frontmatter block from the start of a markdown file.
 *
 * Replaces gray-matter (which pulled in vulnerable js-yaml 3.x with no
 * upgrade path). This project's benchmark frontmatter is always simple
 * `key: value` string pairs, so a minimal line-based parser is sufficient.
 */
function parseFrontmatter(raw: string): ParsedFrontmatter {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    return { data: {}, content: raw };
  }

  const data: Record<string, unknown> = {};
  let index = 1;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() === FRONTMATTER_DELIMITER) {
      index++;
      break;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) data[key] = value;
  }

  const content = lines.slice(index).join("\n");
  return { data, content };
}

export async function loadBenchmarks(
  benchmarkDirectory: string
): Promise<BenchmarkDefinition[]> {
  const entries = await readdir(benchmarkDirectory, { withFileTypes: true });
  const markdownFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const benchmarks: BenchmarkDefinition[] = [];
  const seenIds = new Map<string, string>();

  for (const filename of markdownFiles) {
    const sourcePath = join(benchmarkDirectory, filename);
    const raw = await readFile(sourcePath, "utf8");
    const parsed = parseFrontmatter(raw);
    const frontmatter = parsed.data as BenchmarkFrontmatter;

    const id = readRequiredString(frontmatter, "id", filename);
    const title = readRequiredString(frontmatter, "title", filename);
    const description = readRequiredString(frontmatter, "description", filename);

    const duplicateSource = seenIds.get(id);
    if (duplicateSource) {
      throw new Error(
        `Duplicate benchmark id "${id}" in ${duplicateSource} and ${filename}.`
      );
    }

    seenIds.set(id, filename);
    benchmarks.push({
      id,
      title,
      description,
      prompt: parsed.content.trim(),
      sourcePath
    });
  }

  return benchmarks;
}

function readRequiredString(
  frontmatter: BenchmarkFrontmatter,
  field: keyof BenchmarkFrontmatter,
  filename: string
): string {
  const value = frontmatter[field];

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Benchmark ${filename} is missing required frontmatter field "${field}".`
    );
  }

  return value.trim();
}
