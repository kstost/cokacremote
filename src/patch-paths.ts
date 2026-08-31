function decodeQuotedPath(token: string): string {
  if (!token.startsWith('"') || !token.endsWith('"')) return token;
  const body = token.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]!;
    if (char !== "\\") {
      bytes.push(...Buffer.from(char));
      continue;
    }
    i += 1;
    if (i >= body.length) throw new Error("Invalid quoted patch path escape");
    const escaped = body[i]!;
    const mapped: Record<string, number> = {
      a: 0x07,
      b: 0x08,
      t: 0x09,
      n: 0x0a,
      v: 0x0b,
      f: 0x0c,
      r: 0x0d,
      '"': 0x22,
      "\\": 0x5c,
    };
    if (escaped in mapped) {
      bytes.push(mapped[escaped]!);
      continue;
    }
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      for (let count = 0; count < 2 && i + 1 < body.length && /[0-7]/.test(body[i + 1]!); count += 1) {
        i += 1;
        octal += body[i]!;
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    throw new Error(`Unsupported quoted patch path escape: \\${escaped}`);
  }
  return Buffer.from(bytes).toString("utf8");
}

function readToken(input: string, start = 0): { token: string; next: number } {
  let index = start;
  while (index < input.length && /\s/.test(input[index]!)) index += 1;
  if (index >= input.length) throw new Error("Missing patch path");
  if (input[index] !== '"') {
    const begin = index;
    while (index < input.length && !/\s/.test(input[index]!)) index += 1;
    return { token: input.slice(begin, index), next: index };
  }
  const begin = index;
  index += 1;
  let escaped = false;
  while (index < input.length) {
    const char = input[index]!;
    if (!escaped && char === '"') {
      index += 1;
      return { token: input.slice(begin, index), next: index };
    }
    if (!escaped && char === "\\") escaped = true;
    else escaped = false;
    index += 1;
  }
  throw new Error("Unterminated quoted patch path");
}

function normalizeHeaderPath(raw: string, stripPrefix: boolean): string | undefined {
  const decoded = decodeQuotedPath(raw);
  if (decoded === "/dev/null") return undefined;
  if (decoded.includes("\0")) throw new Error("Patch path contains NUL");
  if (stripPrefix && (decoded.startsWith("a/") || decoded.startsWith("b/"))) return decoded.slice(2);
  return decoded;
}

export function extractPatchPaths(patch: string): string[] {
  const paths = new Set<string>();
  const add = (raw: string, stripPrefix: boolean) => {
    const value = normalizeHeaderPath(raw, stripPrefix);
    if (value !== undefined && value !== "") paths.add(value);
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const rest = line.slice("diff --git ".length);
      const first = readToken(rest);
      const second = readToken(rest, first.next);
      add(first.token, true);
      add(second.token, true);
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const token = readToken(line.slice(4));
      add(token.token, true);
      continue;
    }
    for (const prefix of ["rename from ", "rename to ", "copy from ", "copy to "] as const) {
      if (line.startsWith(prefix)) {
        const raw = line.slice(prefix.length).trim();
        if (!raw) throw new Error(`Missing patch path after ${prefix.trim()}`);
        add(raw, false);
        break;
      }
    }
  }

  if (paths.size === 0) throw new Error("Could not determine any target paths from patch headers");
  return [...paths];
}
