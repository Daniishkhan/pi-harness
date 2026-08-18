import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	BTW_DIAGRAM_PARAMETERS,
	BTW_DIAGRAM_PROTOCOL_VERSION,
	BTW_DIAGRAM_TOOL_NAME,
	parseBtwDiagramRequest,
} from "./diagram-protocol.js";

/**
 * Declarative child-side capability. It never renders, writes a file, or talks
 * to a terminal; the parent /btw extension owns those effects and the UI.
 */
export default function btwDiagramTool(pi: ExtensionAPI): void {
	if (process.env.PI_SESSION_FORK_CHILD !== "1") return;

	pi.registerTool({
		name: BTW_DIAGRAM_TOOL_NAME,
		label: "Show BTW Diagram",
		description:
			"Attach or replace a typed diagram in the current /btw modal. Use this when the user asks to diagram, map, visualize, or explain a flow visually, or when a visual materially improves an exploratory answer. This tool only proposes structured data; the parent /btw UI performs rendering.",
		promptSnippet: "Show a typed diagram inside the current /btw exploration",
		promptGuidelines: [
			"Use show_btw_diagram when the user explicitly asks for a diagram, map, visualization, architecture view, sequence, journey, ERD, or structured JSON view.",
			"You may also use it when a visual is materially clearer during an exploratory or learning answer, but do not render decorative diagrams.",
			"Call it at most once per turn. Keep the prose answer self-contained; the diagram is a companion view.",
			"Use only schema_version 1 typed flow, sequence, journey, erd, or json data. Never emit raw PlantUML or Mermaid.",
		],
		parameters: BTW_DIAGRAM_PARAMETERS as never,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const request = parseBtwDiagramRequest(params);
			return {
				content: [{ type: "text", text: "The diagram is attached to the /btw modal. Continue with a concise prose explanation." }],
				details: {
					protocol: "btw-diagram",
					version: BTW_DIAGRAM_PROTOCOL_VERSION,
					request,
				},
			};
		},
	});
}
