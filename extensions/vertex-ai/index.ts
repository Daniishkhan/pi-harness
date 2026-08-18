import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "google-vertex";
const MODEL_ID = "gemini-3.6-flash";
const CONFIG_PATH = fileURLToPath(new URL("./vertex-ai.config.json", import.meta.url));

interface VertexConfig {
	project?: string;
	location?: string;
}

interface LoadedVertexConfig {
	config: VertexConfig;
	invalid: boolean;
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed || undefined;
}

function loadConfig(): LoadedVertexConfig {
	if (!existsSync(CONFIG_PATH)) return { config: {}, invalid: false };
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<VertexConfig>;
		return {
			config: {
				...(nonEmpty(parsed.project) ? { project: nonEmpty(parsed.project) } : {}),
				...(nonEmpty(parsed.location) ? { location: nonEmpty(parsed.location) } : {}),
			},
			invalid: false,
		};
	} catch {
		return { config: {}, invalid: true };
	}
}

function applyEnvironmentDefaults(config: VertexConfig): void {
	// Pi's native provider resolves stored provider-scoped values before process.env,
	// so /login credentials still take precedence over these optional defaults.
	if (!nonEmpty(process.env.GOOGLE_CLOUD_PROJECT) && !nonEmpty(process.env.GCLOUD_PROJECT) && config.project) {
		process.env.GOOGLE_CLOUD_PROJECT = config.project;
	}
	if (!nonEmpty(process.env.GOOGLE_CLOUD_LOCATION) && config.location) {
		process.env.GOOGLE_CLOUD_LOCATION = config.location;
	}
}

export default function vertexAiExtension(pi: ExtensionAPI) {
	const loadedConfig = loadConfig();
	const config = loadedConfig.config;
	applyEnvironmentDefaults(config);

	pi.registerCommand("vertex-ai-status", {
		description: "Show Vertex AI authentication, project, location, and Gemini 3.6 Flash availability",
		handler: async (_args, ctx) => {
			const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
			const model = ctx.modelRegistry.find(PROVIDER_ID, MODEL_ID);
			const usesApiKey = Boolean(auth?.auth.apiKey);
			const project =
				nonEmpty(auth?.env?.GOOGLE_CLOUD_PROJECT) ??
				nonEmpty(auth?.env?.GCLOUD_PROJECT) ??
				nonEmpty(process.env.GOOGLE_CLOUD_PROJECT) ??
				nonEmpty(process.env.GCLOUD_PROJECT) ??
				config.project;
			const location =
				nonEmpty(auth?.env?.GOOGLE_CLOUD_LOCATION) ??
				nonEmpty(process.env.GOOGLE_CLOUD_LOCATION) ??
				config.location;
			const routing = usesApiKey
				? "Project/location: managed by Vertex API-key routing"
				: `Project: ${project ?? "not set"}\nLocation: ${location ?? "not set"}`;
			const status = [
				`Provider: ${PROVIDER_ID} (Pi native)`,
				routing,
				`Auth: ${auth ? `configured (${auth.source ?? "resolved"})` : "not configured"}`,
				`${MODEL_ID}: ${model ? "available" : "missing from this Pi catalog"}`,
				...(loadedConfig.invalid ? ["Local config: invalid JSON (ignored)"] : []),
			].join("\n");

			ctx.ui.notify(status, auth && model && !loadedConfig.invalid ? "info" : "warning");
		},
	});
}
