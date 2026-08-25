import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

import type { AppConfig } from "./config.js";

export const OAUTH_SCOPES = ["mcp:tools"] as const;

export const TOOL_ANNOTATIONS = {
  readOnlyClosed: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  additiveIdempotentClosed: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  destructiveIdempotentClosed: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  destructiveNonIdempotentClosed: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  destructiveNonIdempotentOpen: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
} as const satisfies Record<string, ToolAnnotations>;

type ToolSecurityScheme = { type: "oauth2"; scopes: string[] };

/**
 * OpenAI's tool auth extension currently supports only noauth and OAuth 2.0.
 * Static-bearer-only and built-in-auth-disabled deployments intentionally omit
 * securitySchemes instead of inferring an external authentication policy that
 * the process cannot observe. Authentication, if any, remains a connection- or
 * deployment-level concern.
 */
export function toolAuthMetadata(
  config: AppConfig,
): { securitySchemes: ToolSecurityScheme[] } | undefined {
  if (config.oauthEnabled) {
    return {
      securitySchemes: [
        { type: "oauth2", scopes: [...OAUTH_SCOPES] },
      ],
    };
  }
  return undefined;
}
