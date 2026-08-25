import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AppConfig } from "./config.js";
import { FileService } from "./file-service.js";
import { runTool } from "./tool-result.js";
import { TOOL_ANNOTATIONS, toolAuthMetadata } from "./tool-metadata.js";

const cwdSchema = z
  .string()
  .optional()
  .describe("Base directory used to resolve relative paths.");

const pathSchema = z
  .string()
  .min(1)
  .describe("Absolute path, ~/ path, or a path relative to cwd/default cwd.");

const fileModeSchema = z
  .string()
  .regex(/^(?:0o)?[0-7]{3,4}$/)
  .optional()
  .describe("Unix mode written as an octal string, for example 0755.");

function parseMode(mode: string | undefined): number | undefined {
  if (mode === undefined) {
    return undefined;
  }
  return Number.parseInt(mode.replace(/^0o/, ""), 8);
}

export function registerFileTools(
  server: McpServer,
  config: AppConfig,
  files: FileService,
): void {
  const authMetadata = toolAuthMetadata(config);

  server.registerTool(
    "list_directory",
    {
      title: "List directory",
      description:
        "List any host directory. Recursive listing does not follow directory symlinks.",
      inputSchema: {
        path: pathSchema,
        cwd: cwdSchema,
        recursive: z
          .boolean()
          .default(false)
          .describe("Descend into child directories without following directory symlinks."),
        maxDepth: z
          .number()
          .int()
          .min(0)
          .max(100)
          .default(8)
          .describe(
            "Maximum directory depth below the requested root when recursive=true. Zero lists only direct children.",
          ),
        maxEntries: z
          .number()
          .int()
          .min(1)
          .max(50_000)
          .default(1000)
          .describe("Maximum total entries returned; truncated=true indicates the limit was reached."),
        includeHidden: z
          .boolean()
          .default(true)
          .describe("Include entries whose names begin with a dot."),
        includeMetadata: z
          .boolean()
          .default(false)
          .describe("Include size, Unix mode, and modification time for each entry."),
      },
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async ({ path, cwd, recursive, maxDepth, maxEntries, includeHidden, includeMetadata }) =>
      runTool(() =>
        files.listDirectory(path, cwd, {
          recursive,
          maxDepth,
          maxEntries,
          includeHidden,
          includeMetadata,
        }),
      ),
  );

  server.registerTool(
    "stat_path",
    {
      title: "Inspect path",
      description: "Return metadata for any file, directory, or symbolic link.",
      inputSchema: { path: pathSchema, cwd: cwdSchema },
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async ({ path, cwd }) => runTool(() => files.getInfo(path, cwd)),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description:
        "Read a bounded chunk of any host file as UTF-8 text or base64. UTF-8 reads preserve character boundaries and may exceed maxBytes by up to three bytes only when one complete character would otherwise not fit. Continue with nextOffset until eof=true.",
      inputSchema: {
        path: pathSchema,
        cwd: cwdSchema,
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Starting byte offset. A value past end of file is clamped to end of file."),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(config.maxFileChunkBytes)
          .default(Math.min(256 * 1024, config.maxFileChunkBytes))
          .describe(
            "Maximum raw bytes requested. UTF-8 mode may adjust the returned size at a character boundary.",
          ),
        encoding: z
          .enum(["utf8", "base64"])
          .default("utf8")
          .describe("Return valid text as UTF-8 or arbitrary bytes as base64."),
      },
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async ({ path, cwd, offset, maxBytes, encoding }) =>
      runTool(() => files.readFileChunk(path, cwd, offset, maxBytes, encoding)),
  );

  server.registerTool(
    "write_file",
    {
      title: "Write file",
      description:
        "Create, overwrite, or append to any host file using UTF-8 or base64 content.",
      inputSchema: {
        path: pathSchema,
        cwd: cwdSchema,
        content: z
          .string()
          .describe("File content encoded according to encoding."),
        encoding: z
          .enum(["utf8", "base64"])
          .default("utf8")
          .describe("Interpret content as UTF-8 text or strictly validated base64."),
        mode: z
          .enum(["overwrite", "append"])
          .default("overwrite")
          .describe("Overwrite and truncate the file, or append content to its current end."),
        createParents: z
          .boolean()
          .default(true)
          .describe("Create missing parent directories before writing."),
        fileMode: fileModeSchema.describe(
          "Unix mode as an octal string, for example 0644. When provided, it is applied to both new and existing files.",
        ),
      },
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ path, cwd, content, encoding, mode, createParents, fileMode }) =>
      runTool(() =>
        files.writeFileContent(
          path,
          cwd,
          content,
          encoding,
          mode,
          createParents,
          parseMode(fileMode),
        ),
      ),
  );

  server.registerTool(
    "replace_in_file",
    {
      title: "Replace text in file",
      description:
        "Perform an exact text replacement in a UTF-8 file. By default exactly one occurrence must exist, preventing ambiguous edits.",
      inputSchema: {
        path: pathSchema,
        cwd: cwdSchema,
        oldText: z
          .string()
          .min(1)
          .describe("Exact non-empty UTF-8 text to find."),
        newText: z.string().describe("Replacement UTF-8 text."),
        replaceAll: z
          .boolean()
          .default(false)
          .describe("Replace every occurrence instead of only the first occurrence."),
        expectedOccurrences: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Required total oldText occurrence count before editing. When omitted, the default is one for a single replacement and the observed count for replaceAll=true.",
          ),
      },
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ path, cwd, oldText, newText, replaceAll, expectedOccurrences }) =>
      runTool(() =>
        files.replaceInFile(
          path,
          cwd,
          oldText,
          newText,
          replaceAll,
          expectedOccurrences,
        ),
      ),
  );

  server.registerTool(
    "apply_patch",
    {
      title: "Apply unified diff",
      description:
        "Validate and apply a standard unified diff with git apply. Paths are unrestricted and --unsafe-paths is enabled.",
      inputSchema: {
        patch: z.string().min(1).describe("Standard unified diff text."),
        cwd: cwdSchema,
        checkOnly: z
          .boolean()
          .default(false)
          .describe("Validate the patch with git apply --check without applying it."),
        reverse: z
          .boolean()
          .default(false)
          .describe("Reverse the patch before checking or applying it."),
        threeWay: z
          .boolean()
          .default(false)
          .describe(
            "Pass --3way to git apply. This requires applicable Git index data and may leave conflict markers when application conflicts.",
          ),
      },
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ patch, cwd, checkOnly, reverse, threeWay }) =>
      runTool(() => files.applyPatch(patch, cwd, { checkOnly, reverse, threeWay })),
  );

  server.registerTool(
    "upload_file",
    {
      title: "Upload file chunk",
      description:
        "Write a base64 file chunk at an exact byte offset. Use truncate=true for the first chunk of a replacement upload, then continue with nextOffset.",
      inputSchema: {
        path: pathSchema,
        cwd: cwdSchema,
        dataBase64: z
          .string()
          .describe("Strictly validated base64 data for this chunk."),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe(
            "Exact byte offset at which to write the chunk. Writing past end of file may create a sparse zero-filled gap.",
          ),
        truncate: z
          .boolean()
          .default(false)
          .describe("Truncate the file to zero bytes before writing this chunk."),
        createParents: z
          .boolean()
          .default(true)
          .describe("Create missing parent directories before opening the file."),
      },
      annotations: TOOL_ANNOTATIONS.destructiveIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ path, cwd, dataBase64, offset, truncate, createParents }) =>
      runTool(() =>
        files.uploadChunk(path, cwd, dataBase64, offset, truncate, createParents),
      ),
  );

  server.registerTool(
    "download_file",
    {
      title: "Download file chunk",
      description:
        "Read a file chunk as base64. Continue with nextOffset until eof=true.",
      inputSchema: {
        path: pathSchema,
        cwd: cwdSchema,
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Starting byte offset. A value past end of file is clamped to end of file."),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(config.maxFileChunkBytes)
          .default(config.maxFileChunkBytes)
          .describe("Maximum raw file bytes encoded into this base64 chunk."),
      },
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async ({ path, cwd, offset, maxBytes }) =>
      runTool(() => files.downloadChunk(path, cwd, offset, maxBytes)),
  );

  server.registerTool(
    "make_directory",
    {
      title: "Create directory",
      description: "Create any host directory.",
      inputSchema: {
        path: pathSchema,
        cwd: cwdSchema,
        recursive: z
          .boolean()
          .default(true)
          .describe(
            "When true, create missing parent directories and succeed when the target directory already exists.",
          ),
        mode: fileModeSchema.describe(
          "Creation mode as an octal string, for example 0755. Existing directories are not chmodded.",
        ),
      },
      annotations: TOOL_ANNOTATIONS.additiveIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ path, cwd, recursive, mode }) =>
      runTool(() => files.makeDirectory(path, cwd, recursive, parseMode(mode))),
  );

  server.registerTool(
    "copy_path",
    {
      title: "Copy path",
      description: "Copy a file or directory anywhere on the host.",
      inputSchema: {
        sourcePath: pathSchema,
        destinationPath: pathSchema,
        cwd: cwdSchema,
        recursive: z
          .boolean()
          .default(true)
          .describe("Allow directory trees to be copied. A directory source requires true."),
        force: z
          .boolean()
          .default(true)
          .describe(
            "Allow existing destination entries to be overwritten or merged. When false, fail if the destination path already exists.",
          ),
      },
      annotations: TOOL_ANNOTATIONS.destructiveIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ sourcePath, destinationPath, cwd, recursive, force }) =>
      runTool(() => files.copyPath(sourcePath, destinationPath, cwd, recursive, force)),
  );

  server.registerTool(
    "move_path",
    {
      title: "Move path",
      description: "Move or rename a file or directory anywhere on the host.",
      inputSchema: {
        sourcePath: pathSchema,
        destinationPath: pathSchema,
        cwd: cwdSchema,
        overwrite: z
          .boolean()
          .default(false)
          .describe("Replace an existing destination path. When false, an existing destination is an error."),
      },
      annotations: TOOL_ANNOTATIONS.destructiveIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ sourcePath, destinationPath, cwd, overwrite }) =>
      runTool(() => files.movePath(sourcePath, destinationPath, cwd, overwrite)),
  );

  server.registerTool(
    "remove_path",
    {
      title: "Remove path",
      description:
        "Permanently remove any host file or directory. This operation is not restricted to a workspace and does not use trash.",
      inputSchema: {
        path: pathSchema,
        cwd: cwdSchema,
        recursive: z
          .boolean()
          .default(false)
          .describe("Recursively remove a directory and all of its contents."),
        force: z
          .boolean()
          .default(false)
          .describe("Ignore a missing target. This does not suppress other filesystem errors."),
      },
      annotations: TOOL_ANNOTATIONS.destructiveIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ path, cwd, recursive, force }) =>
      runTool(() => files.removePath(path, cwd, recursive, force)),
  );

  server.registerTool(
    "chmod_path",
    {
      title: "Change path mode",
      description: "Change Unix permission bits on any host path.",
      inputSchema: {
        path: pathSchema,
        cwd: cwdSchema,
        mode: z
          .string()
          .regex(/^(?:0o)?[0-7]{3,4}$/)
          .describe("Unix mode as a three- or four-digit octal string, optionally prefixed with 0o."),
      },
      annotations: TOOL_ANNOTATIONS.destructiveIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ path, cwd, mode }) =>
      runTool(() => files.changeMode(path, cwd, parseMode(mode) ?? 0)),
  );

  server.registerTool(
    "hash_file",
    {
      title: "Hash file",
      description: "Calculate a digest for any host file, useful for transfer verification.",
      inputSchema: {
        path: pathSchema,
        cwd: cwdSchema,
        algorithm: z
          .enum(["sha256", "sha512", "md5"])
          .default("sha256")
          .describe("Digest algorithm used to hash the file bytes."),
      },
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async ({ path, cwd, algorithm }) =>
      runTool(() => files.hashFile(path, cwd, algorithm)),
  );
}
