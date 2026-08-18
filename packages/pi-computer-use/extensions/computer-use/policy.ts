export const COMPUTER_ACTIONS = [
  "status", "connect", "tabs", "inspect", "act", "screenshot", "console", "network", "trace", "disconnect",
] as const;
export type ComputerAction = (typeof COMPUTER_ACTIONS)[number];

export const BROWSER_TARGETS = ["current", "dev"] as const;
export type BrowserTarget = (typeof BROWSER_TARGETS)[number];

export const RISKS = ["normal", "submit", "delete", "purchase", "message", "account", "upload", "secret"] as const;
export type Risk = (typeof RISKS)[number];

export const ACT_OPERATIONS = [
  "goto", "click", "dblclick", "fill", "type", "press", "hover", "select", "check", "uncheck", "drag", "scroll",
  "reload", "back", "forward", "tab-new", "tab-select", "tab-close", "dialog-accept", "dialog-dismiss", "resize",
] as const;
export type ActOperation = (typeof ACT_OPERATIONS)[number];

export interface PolicyInput {
  action: ComputerAction;
  target?: BrowserTarget;
  operation?: ActOperation;
  url?: string;
  pageUrls?: string[];
  text?: string;
  ref?: string;
  risk?: Risk;
  snapshotText?: string;
  allowedOrigins: string[];
}

export interface PolicyDecision {
  requiresApproval: boolean;
  reasons: string[];
  denyReason?: string;
  inferredRisk: Risk;
}

const RISK_KEYWORDS: Array<{ risk: Exclude<Risk, "normal">; pattern: RegExp }> = [
  { risk: "upload", pattern: /\b(upload|attach(?:ment)?|choose file|drop file)\b/i },
  { risk: "secret", pattern: /\b(password|passcode|secret|token|api[ _-]?key|credit card|card number|cvv|ssn|bank account)\b/i },
  { risk: "delete", pattern: /\b(delete|remove|destroy|archive|cancel subscription|erase)\b/i },
  { risk: "purchase", pattern: /\b(buy|purchase|pay(?:ment)?|checkout|place order|confirm order|transfer)\b/i },
  { risk: "message", pattern: /\b(send|message|email|post comment|publish|reply)\b/i },
  { risk: "account", pattern: /\b(account|profile|security settings|change password|enable 2fa|disable 2fa|permissions?|sign[ -]?(?:in|out|up)|log[ -]?(?:in|out))\b/i },
  { risk: "submit", pattern: /\b(submit|save changes|confirm|continue|apply)\b/i },
];

const RISK_PRIORITY: Risk[] = ["upload", "secret", "delete", "purchase", "account", "message", "submit", "normal"];
const ALWAYS_APPROVE_OPERATIONS = new Set<ActOperation>(ACT_OPERATIONS);

export function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

export function isAllowedOrigin(origin: string, allowedOrigins: string[]): boolean {
  try {
    const exactOrigin = new URL(origin).origin;
    return isLocalOrigin(exactOrigin) || allowedOrigins.includes(exactOrigin);
  } catch {
    return false;
  }
}

export function isAllowedPageUrl(url: string | undefined, allowedOrigins: string[]): boolean {
  if (url === "about:blank") return true;
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && isAllowedOrigin(parsed.origin, allowedOrigins);
  } catch {
    return false;
  }
}

export function isExternalUrl(url: string | undefined, allowedOrigins: string[]): boolean {
  return !isAllowedPageUrl(url, allowedOrigins);
}

export function referencedSnapshotLine(snapshotText: string | undefined, ref: string | undefined): string | undefined {
  if (!snapshotText || !ref) return undefined;
  const escapedRef = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:\\[ref=|^|\\s)${escapedRef}(?:\\]|\\s|$|[,:])`);
  return snapshotText.split("\n").find((line) => pattern.test(line));
}

export function inferRisk(input: Pick<PolicyInput, "operation" | "text" | "ref" | "risk" | "snapshotText">): Risk {
  const candidates: Risk[] = [];
  if (input.risk && input.risk !== "normal") candidates.push(input.risk);
  const pressedKey = input.text?.trim().toLowerCase();
  if (input.operation === "dialog-accept" || input.operation === "dialog-dismiss" ||
      (input.operation === "press" && Boolean(pressedKey?.split("+").includes("enter")))) {
    candidates.push("submit");
  }
  const line = referencedSnapshotLine(input.snapshotText, input.ref);
  const text = [input.text, line ?? (!input.ref ? input.snapshotText : undefined)].filter((part): part is string => Boolean(part)).join("\n");
  for (const { risk, pattern } of RISK_KEYWORDS) {
    if (pattern.test(text)) candidates.push(risk);
  }
  return RISK_PRIORITY.find((risk) => candidates.includes(risk)) ?? "normal";
}

export function isAmbiguousMutatingOperation(operation: ActOperation | undefined): boolean {
  return operation === "click" || operation === "dblclick" || operation === "fill" || operation === "type" ||
    operation === "press" || operation === "select" || operation === "check" || operation === "uncheck" || operation === "drag";
}

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const inferredRisk = inferRisk(input);
  if (inferredRisk === "upload") {
    return {
      requiresApproval: false,
      reasons: ["File upload execution is not available in this milestone."],
      denyReason: "File upload requests are refused. Ask the user to upload the file manually, then inspect the resulting page.",
      inferredRisk,
    };
  }

  const reasons: string[] = [];
  const externalPages = [...new Set((input.pageUrls ?? []).filter((url) => isExternalUrl(url, input.allowedOrigins)))];
  if (externalPages.length > 0) {
    const labels = externalPages.map((url) => url || "unknown page").slice(0, 3).join(", ");
    reasons.push(`This operation can read or act on external browser content (${labels}).`);
  }

  if (input.action === "act" && input.operation && ALWAYS_APPROVE_OPERATIONS.has(input.operation)) {
    reasons.push(`${input.operation} is mutating or navigation-capable and requires approval.`);
  }

  const explicitNavigation = input.action === "act" && (input.operation === "goto" || input.operation === "tab-new");
  if (explicitNavigation && isExternalUrl(input.url, input.allowedOrigins)) reasons.push("The requested destination is external.");

  if (inferredRisk !== "normal") reasons.push(`This action is classified as ${inferredRisk} risk.`);
  if (input.action === "trace") reasons.push("Trace artifacts can contain sensitive page, network, and console data.");

  return { requiresApproval: reasons.length > 0, reasons: [...new Set(reasons)], inferredRisk };
}
