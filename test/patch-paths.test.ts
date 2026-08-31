import { describe, expect, it } from "vitest";
import { extractPatchPaths } from "../src/patch-paths.js";

describe("extractPatchPaths", () => {
  it("extracts create, delete, and normal unified diff paths", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "diff --git a/deleted.txt b/deleted.txt",
      "--- a/deleted.txt",
      "+++ /dev/null",
      "diff --git a/new.txt b/new.txt",
      "--- /dev/null",
      "+++ b/new.txt",
    ].join("\n");
    expect(extractPatchPaths(patch)).toEqual(["src/a.ts", "deleted.txt", "new.txt"]);
  });

  it("extracts rename/copy paths and traversal targets", () => {
    const patch = [
      "diff --git a/old.txt b/new.txt",
      "similarity index 100%",
      "rename from old.txt",
      "rename to ../outside/new.txt",
      "copy from new.txt",
      "copy to copies/new.txt",
    ].join("\n");
    expect(extractPatchPaths(patch)).toEqual(["old.txt", "new.txt", "../outside/new.txt", "copies/new.txt"]);
  });

  it("decodes quoted Git paths including octal UTF-8 escapes", () => {
    const patch = [
      'diff --git "a/foo bar.txt" "b/foo bar.txt"',
      '--- "a/foo bar.txt"',
      '+++ "b/foo bar.txt"',
      'diff --git "a/\\355\\225\\234.txt" "b/\\355\\225\\234.txt"',
    ].join("\n");
    expect(extractPatchPaths(patch)).toEqual(["foo bar.txt", "한.txt"]);
  });

  it("fails closed when no target path can be determined", () => {
    expect(() => extractPatchPaths("@@ -1 +1 @@\n-old\n+new\n")).toThrow("Could not determine");
  });
});
