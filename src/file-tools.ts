import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AppConfig } from "./config.js";
import { FileService } from "./file-service.js";
import { runTool } from "./tool-result.js";
import { TaskJournal } from "./task-journal.js";

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

const cwdSchema = z
  .string()
  .optional()
  .describe("Base directory used to resolve relative paths.");

const pathSchema = z
  .string()
  .min(1)
  .describe("Absolute path, ~/ path, or a path relative to cwd/default cwd.");

const taskIdSchema = z.string().uuid().optional().describe("Optional development task journal ID.");

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
  journal: TaskJournal,
): void {
  server.registerTool(
    "list_directory",
    {
      title: "List directory",
      description:
        "List any host directory. Recursive listing does not follow directory symlinks.",
      inputSchema: {
        path: pathSchema,
        cwd: cwdSchema,
        recursive: z.boolean().default(false),
        maxDepth: z.number().int().min(0).max(100).default(8),
        maxEntries: z.number().int().min(1).max(50_000).default(1000),
        includeHidden: z.boolean().default(true),
        includeMetadata: z.boolean().default(false),
      },
      annotations: readAnnotations,
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
      annotations: readAnnotations,
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
        offset: z.number().int().min(0).default(0),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(config.maxFileChunkBytes)
          .default(Math.min(256 * 1024, config.maxFileChunkBytes)),
        encoding: z.enum(["utf8", "base64"]).default("utf8"),
      },
      annotations: readAnnotations,
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
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).default("utf8"),
        mode: z.enum(["overwrite", "append"]).default("overwrite"),
        createParents: z.boolean().default(true),
        fileMode: fileModeSchema,
        taskId: taskIdSchema,
      },
      annotations: writeAnnotations,
    },
    async ({ path, cwd, content, encoding, mode, createParents, fileMode, taskId }) =>
      runTool(async () => {
        if (taskId && !(await journal.getTask(taskId))) throw new Error(`Unknown task: ${taskId}`);
        const result = await files.writeFileContent(path, cwd, content, encoding, mode, createParents, parseMode(fileMode));
        if (taskId) await journal.record("file.changed", { taskId, path: files.resolve(path, cwd), operation: "write_file" });
        return result;
      }),
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
        oldText: z.string().min(1),
        newText: z.string(),
        replaceAll: z.boolean().default(false),
        expectedOccurrences: z.number().int().min(0).optional(),
        taskId: taskIdSchema,
      },
      annotations: writeAnnotations,
    },
    async ({ path, cwd, oldText, newText, replaceAll, expectedOccurrences, taskId }) =>
      runTool(async () => {
        if (taskId && !(await journal.getTask(taskId))) throw new Error(`Unknown task: ${taskId}`);
        const result = await files.replaceInFile(path, cwd, oldText, newText, replaceAll, expectedOccurrences);
        if (taskId) await journal.record("file.changed", { taskId, path: files.resolve(path, cwd), operation: "replace_in_file" });
        return result;
      }),
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
        checkOnly: z.boolean().default(false),
        reverse: z.boolean().default(false),
        threeWay: z.boolean().default(false),
        taskId: taskIdSchema,
      },
      annotations: writeAnnotations,
    },
    async ({ patch, cwd, checkOnly, reverse, threeWay, taskId }) =>
      runTool(async () => {
        if (taskId && !(await journal.getTask(taskId))) throw new Error(`Unknown task: ${taskId}`);
        const result = await files.applyPatch(patch, cwd, { checkOnly, reverse, threeWay });
        if (taskId && !checkOnly) {
          const names = [...patch.matchAll(/^\+\+\+\s+(?:b\/)?(.+)$/gm)].map((match) => match[1]!).filter((name) => name !== "/dev/null");
          for (const name of new Set(names)) await journal.record("file.changed", { taskId, path: files.resolve(name, cwd), operation: "apply_patch" });
        }
        return result;
      }),
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
        dataBase64: z.string(),
        offset: z.number().int().min(0).default(0),
        truncate: z.boolean().default(false),
        createParents: z.boolean().default(true),
        taskId: taskIdSchema,
      },
      annotations: writeAnnotations,
    },
    async ({ path, cwd, dataBase64, offset, truncate, createParents, taskId }) =>
      runTool(async () => {
        if (taskId && !(await journal.getTask(taskId))) throw new Error(`Unknown task: ${taskId}`);
        const result = await files.uploadChunk(path, cwd, dataBase64, offset, truncate, createParents);
        if (taskId) await journal.record("file.changed", { taskId, path: files.resolve(path, cwd), operation: "upload_file" });
        return result;
      }),
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
        offset: z.number().int().min(0).default(0),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(config.maxFileChunkBytes)
          .default(config.maxFileChunkBytes),
      },
      annotations: readAnnotations,
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
        recursive: z.boolean().default(true),
        mode: fileModeSchema,
      },
      annotations: writeAnnotations,
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
        recursive: z.boolean().default(true),
        force: z.boolean().default(true),
      },
      annotations: writeAnnotations,
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
        overwrite: z.boolean().default(false),
      },
      annotations: writeAnnotations,
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
        recursive: z.boolean().default(false),
        force: z.boolean().default(false),
      },
      annotations: writeAnnotations,
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
        mode: z.string().regex(/^(?:0o)?[0-7]{3,4}$/),
      },
      annotations: writeAnnotations,
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
        algorithm: z.enum(["sha256", "sha512", "md5"]).default("sha256"),
      },
      annotations: readAnnotations,
    },
    async ({ path, cwd, algorithm }) =>
      runTool(() => files.hashFile(path, cwd, algorithm)),
  );
}
