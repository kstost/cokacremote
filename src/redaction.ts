const ASSIGNMENT_SECRET = /\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Za-z0-9_]*)=(?:'[^']*'|"[^"]*"|[^\s;|&]+)/gi;
const AUTH_HEADER = /\b(authorization\s*:\s*)(?:bearer\s+)?[^\s'";|&]+/gi;
const COMMON_FLAGS = /(\s(?:--?(?:token|password|passwd|secret|api-key|access-key))(?:=|\s+))(?:'[^']*'|"[^"]*"|[^\s;|&]+)/gi;

export function redactCommand(value: string): string {
  return value
    .replace(ASSIGNMENT_SECRET, (_match, name: string) => `${name}=<redacted>`)
    .replace(AUTH_HEADER, (_match, prefix: string) => `${prefix}<redacted>`)
    .replace(COMMON_FLAGS, (_match, prefix: string) => `${prefix}<redacted>`);
}
