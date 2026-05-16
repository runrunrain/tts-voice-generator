import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "../..");
const themeCssPath = path.join(projectRoot, "src", "styles", "theme.css");
const frontendSourceRoot = path.join(projectRoot, "src", "app");

function collectSourceFiles(directory: string): string[] {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (/\.(tsx|ts)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("frontend Tailwind layout regression tokens", () => {
  it("keeps named max-width utilities on rem container tokens instead of pixel spacing tokens", () => {
    const themeCss = fs.readFileSync(themeCssPath, "utf8");
    const expectedContainers: Record<string, string> = {
      sm: "24rem",
      md: "28rem",
      lg: "32rem",
      xl: "36rem",
      "2xl": "42rem",
      "3xl": "48rem",
      "4xl": "56rem",
    };

    for (const [name, value] of Object.entries(expectedContainers)) {
      expect(themeCss).toMatch(new RegExp(`--container-${name}:\\s*${value};`));
    }
    expect(themeCss).toMatch(/--spacing-3xl:\s*var\(--space-3xl\);/);
  });

  it("uses explicit rem max-width classes for named width cases affected by the spacing scale", () => {
    const source = collectSourceFiles(frontendSourceRoot)
      .map((filePath) => fs.readFileSync(filePath, "utf8"))
      .join("\n");

    expect(source).not.toMatch(/(?:^|[\s:"])(?:sm:)?max-w-(?:sm|md|lg|xl|2xl|3xl|4xl)(?:[\s"]|$)/);
    expect(source).not.toMatch(/data-\[[^\]]+\]:(?:sm:)?max-w-(?:sm|md|lg|xl|2xl|3xl|4xl)/);
    expect(source).toContain("max-w-[48rem]");
    expect(source).toContain("max-w-[28rem]");
    expect(source).toContain("sm:max-w-[32rem]");
    expect(source).toContain("sm:max-w-[24rem]");
  });
});
