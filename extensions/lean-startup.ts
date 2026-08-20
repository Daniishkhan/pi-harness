import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFERRED_GROUPS = ["web", "agents", "mcp", "teams"] as const;
type DeferredGroup = (typeof DEFERRED_GROUPS)[number];
type ToolGroup = DeferredGroup | "full";

const GROUP_PACKAGES: Record<DeferredGroup, string> = {
  web: "pi-web-access",
  agents: "pi-subagents",
  mcp: "pi-mcp-adapter",
  teams: "pi-teams",
};

const LEGACY_GROUP_TOOLS: Record<DeferredGroup, readonly string[]> = {
  web: ["web_search", "source_check", "fetch_content", "get_search_content"],
  agents: ["subagent", "subagent_wait", "subagent_supervisor"],
  mcp: ["mcpScript", "mcp"],
  teams: [],
};

// pi-teams is an auto-discovered extension, so its tools share the agentDir
// baseDir with every other user extension and cannot be identified by
// sourceInfo.source. Match by extension path or the team_ name prefix.
const TEAMS_EXTENSION_DIR = "/extensions/pi-teams";
const TEAMS_TOOL_PREFIX = "team_";

function isTeamsTool(tool: { name: string; sourceInfo?: { source?: string; path?: string; baseDir?: string } | null }): boolean {
  const src = tool.sourceInfo;
  if (src) {
    if (src.source === "npm:pi-teams") return true;
    const p = src.path?.replace(/\\/g, "/") ?? "";
    if (p.includes(`${TEAMS_EXTENSION_DIR}/`)) return true;
    const b = src.baseDir?.replace(/\\/g, "/") ?? "";
    if (b.endsWith(TEAMS_EXTENSION_DIR)) return true;
  }
  return tool.name.startsWith(TEAMS_TOOL_PREFIX);
}

const ALWAYS_ACTIVE_TOOLS = new Set(["subagent_supervisor"]);
const LOADER_TOOL = "load_tool_group";

function toolNamesForGroup(pi: ExtensionAPI, group: DeferredGroup): string[] {
  const tools = pi.getAllTools();
  if (group === "teams") {
    return tools
      .filter(isTeamsTool)
      .map((tool) => tool.name)
      .filter((name) => !ALWAYS_ACTIVE_TOOLS.has(name));
  }
  const packageName = GROUP_PACKAGES[group];
  const packageTools = tools.filter((tool) => {
    const source = tool.sourceInfo?.source;
    const baseDir = tool.sourceInfo?.baseDir?.replace(/\\/g, "/");
    return source === `npm:${packageName}`
      || baseDir?.endsWith(`/node_modules/${packageName}`)
      || baseDir?.endsWith(`/${packageName}`);
  });

  // Current Pi always supplies sourceInfo. Fall back to the historical names
  // only when source metadata is unavailable, so project overrides with the
  // same names are not accidentally deferred.
  const matchedTools = packageTools.length > 0
    ? packageTools
    : tools.filter((tool) => !tool.sourceInfo?.source && LEGACY_GROUP_TOOLS[group].includes(tool.name));

  return matchedTools
    .map((tool) => tool.name)
    .filter((name) => !ALWAYS_ACTIVE_TOOLS.has(name));
}

function inactiveToolNames(pi: ExtensionAPI, enabledGroups: ReadonlySet<DeferredGroup>): Set<string> {
  return new Set(
    DEFERRED_GROUPS
      .filter((group) => !enabledGroups.has(group))
      .flatMap((group) => toolNamesForGroup(pi, group)),
  );
}

function enforceToolProfile(pi: ExtensionAPI, enabledGroups: ReadonlySet<DeferredGroup>): string[] {
  const available = new Set(pi.getAllTools().map((tool) => tool.name));
  const inactive = inactiveToolNames(pi, enabledGroups);
  const current = pi.getActiveTools();
  const retained = current.filter((name) => !inactive.has(name));

  for (const required of [LOADER_TOOL, ...ALWAYS_ACTIVE_TOOLS]) {
    if (available.has(required)) retained.push(required);
  }

  const next = [...new Set(retained)];
  const changed = next.length !== current.length || next.some((name, index) => name !== current[index]);
  if (changed) pi.setActiveTools(next);
  return next;
}

function activateGroup(pi: ExtensionAPI, enabledGroups: Set<DeferredGroup>, group: ToolGroup): string[] {
  const groups: readonly DeferredGroup[] = group === "full" ? DEFERRED_GROUPS : [group];
  const requested = new Set(groups.flatMap((candidate) => toolNamesForGroup(pi, candidate)));
  const current = pi.getActiveTools();
  const additions = [...requested].filter((name) => !current.includes(name));

  // Keep this call purely additive so Pi can use native deferred-tool loading.
  if (additions.length > 0) pi.setActiveTools([...new Set([...current, ...additions])]);
  for (const candidate of groups) enabledGroups.add(candidate);
  return additions;
}

function writePromptAudit(pi: ExtensionAPI, ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1], requestedPath: string): string {
  const outputPath = requestedPath
    ? resolve(ctx.cwd, requestedPath)
    : resolve(getAgentDir(), "state", "prompt-audit.json");
  const systemPrompt = ctx.getSystemPrompt();
  const options = ctx.getSystemPromptOptions();
  const active = new Set(pi.getActiveTools());
  const tools = pi.getAllTools().map((tool) => ({
    name: tool.name,
    active: active.has(tool.name),
    descriptionChars: tool.description.length,
    parameterSchemaChars: JSON.stringify(tool.parameters).length,
    promptGuidelines: tool.promptGuidelines ?? [],
    sourceInfo: tool.sourceInfo,
  }));
  const activeTools = tools.filter((tool) => tool.active);
  const toolDefinitionChars = activeTools.reduce(
    (total, tool) => total + tool.name.length + tool.descriptionChars + tool.parameterSchemaChars,
    0,
  );

  const audit = {
    capturedAt: new Date().toISOString(),
    cwd: ctx.cwd,
    systemPrompt,
    systemPromptChars: systemPrompt.length,
    estimatedSystemPromptTokens: Math.ceil(systemPrompt.length / 4),
    activeToolCount: activeTools.length,
    estimatedActiveToolDefinitionTokens: Math.ceil(toolDefinitionChars / 4),
    inputs: {
      customPromptChars: options.customPrompt?.length ?? 0,
      appendSystemPromptChars: options.appendSystemPrompt?.length ?? 0,
      contextFiles: options.contextFiles?.map((file) => ({ path: file.path, chars: file.content.length })) ?? [],
      skills: options.skills?.map((skill) => ({
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        disableModelInvocation: skill.disableModelInvocation ?? false,
        sourceInfo: skill.sourceInfo,
      })) ?? [],
      selectedTools: options.selectedTools ?? [],
      toolSnippets: options.toolSnippets ?? {},
      promptGuidelines: options.promptGuidelines ?? [],
    },
    tools,
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(audit, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(outputPath, 0o600);
  return outputPath;
}

export default function leanStartup(pi: ExtensionAPI) {
  const enabledGroups = new Set<DeferredGroup>();

  const resetToLeanProfile = (): string[] => {
    enabledGroups.clear();
    return enforceToolProfile(pi, enabledGroups);
  };

  pi.registerTool({
    name: LOADER_TOOL,
    label: "Load Tool Group",
    description: "Enable deferred tools. Use web for online research or URLs, agents for delegation and independent review, mcp for connected services, teams for agent-team workflows (pi-teams), and full only when several groups are required.",
    promptSnippet: "Enable deferred web, subagent, MCP, or team tools only when a task needs them",
    promptGuidelines: ["Use load_tool_group before a task requires web research, subagents, MCP services, or agent teams."],
    parameters: Type.Object({
      group: StringEnum(["web", "agents", "mcp", "teams", "full"] as const, {
        description: "Deferred capability group to enable for the rest of this session",
      }),
    }),
    async execute(_toolCallId, params) {
      const additions = activateGroup(pi, enabledGroups, params.group);
      return {
        content: [{
          type: "text",
          text: additions.length > 0
            ? `Enabled ${params.group} tools: ${additions.join(", ")}`
            : `${params.group} tools are already enabled or unavailable.`,
        }],
        details: {
          group: params.group,
          additions,
          enabledGroups: [...enabledGroups],
          activeTools: pi.getActiveTools(),
        },
      };
    },
  });

  pi.on("session_start", () => {
    resetToLeanProfile();
  });

  // Some packages register or reactivate session-scoped tools during
  // session_start. resources_discover runs afterward, so reapply once all
  // session initialization handlers have completed.
  pi.on("resources_discover", () => {
    resetToLeanProfile();
  });

  // Package metadata refreshes and reconnects can reactivate their tools later.
  // Enforce before a user prompt is assembled, then again after each completed
  // turn so Pi snapshots the requested profile for any following tool turn.
  pi.on("input", () => {
    enforceToolProfile(pi, enabledGroups);
  });
  pi.on("turn_end", () => {
    enforceToolProfile(pi, enabledGroups);
  });

  pi.registerCommand("tool-profile", {
    description: "Set the lean tool profile or enable a deferred group",
    handler: async (args, ctx) => {
      const requested = args.trim();
      if (requested === "core" || !requested) {
        const active = resetToLeanProfile();
        ctx.ui.notify(`Lean tool profile: ${active.join(", ")}`, "info");
        return;
      }
      if (requested !== "full" && !Object.hasOwn(GROUP_PACKAGES, requested)) {
        ctx.ui.notify("Usage: /tool-profile core|web|agents|mcp|teams|full", "warning");
        return;
      }
      const group = requested as ToolGroup;
      const additions = activateGroup(pi, enabledGroups, group);
      ctx.ui.notify(
        additions.length > 0 ? `Enabled: ${additions.join(", ")}` : `${group} tools already enabled or unavailable`,
        "info",
      );
    },
  });

  pi.registerCommand("tool-status", {
    description: "Show active and deferred tools",
    handler: async (_args, ctx) => {
      const active = enforceToolProfile(pi, enabledGroups);
      const deferred = DEFERRED_GROUPS
        .flatMap((group) => toolNamesForGroup(pi, group))
        .filter((name) => !active.includes(name));
      ctx.ui.notify(
        `Active (${active.length}): ${active.join(", ")}\nEnabled groups: ${[...enabledGroups].join(", ") || "none"}\nDeferred: ${deferred.join(", ") || "none"}`,
        "info",
      );
    },
  });

  pi.registerCommand("prompt-audit", {
    description: "Write the assembled prompt and tool footprint to a local JSON audit",
    handler: async (args, ctx) => {
      enforceToolProfile(pi, enabledGroups);
      const outputPath = writePromptAudit(pi, ctx, args.trim());
      ctx.ui.notify(`Prompt audit written to ${outputPath}`, "info");
    },
  });
}
