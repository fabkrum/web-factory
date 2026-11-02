/**
 * The Factory holds secrets the Site's own commands never need: the GitHub token, the Agent
 * CLIs' keys and logins. What a Site's test or build prints can end up in a park comment on a
 * public repository, so the Site's commands run without them, and whatever goes to the tracker
 * is masked once more on the way out.
 */

/** An environment variable whose name says it holds a secret: a token, key, password or credential. */
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|(^|_)(KEY|APIKEY|PASS|AUTH)(_|$)/i;

/** Values shorter than this are left alone: masking "abc" everywhere would garble ordinary text. */
const MIN_SECRET_LENGTH = 8;

/** Tokens by their shape, so one the Factory never held (in a `.env` the tests print) is masked too. */
const TOKEN_SHAPES = [
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
];

const REDACTED = "[redacted]";

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** The environment for the Site's own commands: the Factory's without anything secret. */
export function siteEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !isSecretName(name)) kept[name] = value;
  }
  return kept;
}

/** `text` with every secret of `env` and every token-shaped string replaced by `[redacted]`. */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const values = Object.entries(env)
    .filter(([name, value]) => value !== undefined && value.length >= MIN_SECRET_LENGTH && isSecretName(name))
    .map(([, value]) => value!)
    // Longest first, so a secret that contains another is masked whole.
    .sort((a, b) => b.length - a.length);
  let masked = text;
  for (const value of values) masked = masked.split(value).join(REDACTED);
  for (const shape of TOKEN_SHAPES) masked = masked.replace(shape, REDACTED);
  return masked;
}

/** Every string inside `value` (an API body) redacted, the rest unchanged. */
export function redactDeep<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === "string") return redactSecrets(value, env) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, env)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, env)])) as T;
  }
  return value;
}
