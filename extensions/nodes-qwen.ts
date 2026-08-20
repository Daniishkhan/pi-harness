/**
 * nodes-qwen — self-hosted Qwen 3.8 27B behind a vLLM (OpenAI-compatible) endpoint.
 *
 * Serves as the bulk/parallel/subagent workhorse, not the main driver:
 * 32k context and 27B reasoning don't replace a flagship on hard multi-file
 * work, but high single-stream throughput, clean tool calls, and $0 marginal
 * cost make it ideal for fan-out subagents, mechanical bulk tasks, and
 * PII-sensitive work on infrastructure you control.
 *
 * Verified against a live vLLM deployment (2025 bench):
 *   - /v1/models: qwen-27b, max_model_len 32768
 *   - chat_template_kwargs {enable_thinking, preserve_thinking} accepted
 *   - thinking streams via delta.reasoning (pi parses natively)
 *   - structured tool_calls work first try
 *   - max_tokens accepted (not max_completion_tokens)
 *
 * Configuration (no defaults are committed):
 *   QWEN_BASE_URL  e.g. https://your-vllm-host.example/v1
 *   QWEN_API_KEY   the deployment key
 * The provider is only registered when QWEN_BASE_URL is set.
 *
 * Switch with: /model nodes-qwen/qwen-27b
 * Thinking levels map to the Qwen toggle: off = no thinking, any level = thinking on.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = process.env.QWEN_BASE_URL?.trim();
const API_KEY = process.env.QWEN_API_KEY?.trim() || "";

export default function (pi: ExtensionAPI) {
	if (!BASE_URL) return; // no endpoint configured; register nothing

	pi.registerProvider("nodes-qwen", {
		name: "NODES Qwen (self-hosted)",
		baseUrl: BASE_URL,
		apiKey: API_KEY,
		api: "openai-completions",
		models: [
			{
				id: "qwen-27b",
				name: "Qwen 3.8 27B",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32768,
				maxTokens: 8192,
				compat: {
					maxTokensField: "max_tokens",
					supportsDeveloperRole: false, // Qwen chat template expects "system"
					thinkingFormat: "qwen-chat-template", // chat_template_kwargs.enable_thinking
				},
			},
		],
	});
}
