export const BTW_DIAGRAM_TOOL_NAME = "show_btw_diagram";
export const BTW_DIAGRAM_PROTOCOL_VERSION = 1 as const;
export const MAX_BTW_DIAGRAM_REQUEST_BYTES = 1024 * 1024;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KINDS = new Set(["flow", "sequence", "journey", "erd", "json"]);
const THEMES = new Set(["light", "dark"]);

export interface BtwDiagramOptions {
	theme?: "light" | "dark";
	timeout_ms?: number;
}

export interface BtwDiagramRequest {
	spec: Record<string, unknown>;
	options?: BtwDiagramOptions;
}

export interface BtwDiagramCall {
	key: string;
	request: BtwDiagramRequest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], description: string): void {
	const unknown = Object.keys(value).find((key) => !allowed.includes(key));
	if (unknown) throw new Error(`${description} contains unsupported field ${JSON.stringify(unknown)}.`);
}

/**
 * Validate the small parent/child capability envelope. The Rust renderer remains
 * authoritative for the complete DiagramSpec schema and semantic checks.
 */
export function parseBtwDiagramRequest(value: unknown): BtwDiagramRequest {
	if (typeof value === "string") {
		if (Buffer.byteLength(value, "utf8") > MAX_BTW_DIAGRAM_REQUEST_BYTES) {
			throw new Error("The diagram request is too large.");
		}
		try {
			value = JSON.parse(value) as unknown;
		} catch {
			throw new Error("The diagram request is not valid JSON.");
		}
	}
	if (!isRecord(value)) throw new Error("The diagram request must be an object.");
	exactKeys(value, ["spec", "options"], "The diagram request");
	if (!isRecord(value.spec)) throw new Error("The diagram request requires a spec object.");

	let encoded: string;
	try {
		encoded = JSON.stringify(value);
	} catch {
		throw new Error("The diagram request is not JSON-serializable.");
	}
	if (typeof encoded !== "string") throw new Error("The diagram request is not JSON-serializable.");
	if (Buffer.byteLength(encoded, "utf8") > MAX_BTW_DIAGRAM_REQUEST_BYTES) {
		throw new Error("The diagram request is too large.");
	}

	const spec = value.spec;
	if (spec.schema_version !== BTW_DIAGRAM_PROTOCOL_VERSION) {
		throw new Error(`The diagram spec must use schema_version ${BTW_DIAGRAM_PROTOCOL_VERSION}.`);
	}
	if (typeof spec.kind !== "string" || !KINDS.has(spec.kind)) {
		throw new Error("The diagram kind must be flow, sequence, journey, erd, or json.");
	}
	if (typeof spec.id !== "string" || !IDENTIFIER_PATTERN.test(spec.id)) {
		throw new Error("The diagram id is invalid.");
	}
	if (spec.kind === "flow" && (!Array.isArray(spec.nodes) || !Array.isArray(spec.edges))) {
		throw new Error("A flow diagram requires nodes and edges arrays.");
	}
	if (spec.kind === "sequence" && (!Array.isArray(spec.participants) || !Array.isArray(spec.messages))) {
		throw new Error("A sequence diagram requires participants and messages arrays.");
	}
	if (spec.kind === "journey" && (!Array.isArray(spec.lanes) || !Array.isArray(spec.steps))) {
		throw new Error("A journey diagram requires lanes and steps arrays.");
	}
	if (spec.kind === "erd" && !Array.isArray(spec.entities)) {
		throw new Error("An ERD requires an entities array.");
	}
	if (spec.kind === "json") {
		const hasValue = Object.hasOwn(spec, "value");
		const hasPath = Object.hasOwn(spec, "path");
		if (hasValue === hasPath) throw new Error("A JSON diagram requires exactly one of value or path.");
	}

	let options: BtwDiagramOptions | undefined;
	if (value.options !== undefined) {
		if (!isRecord(value.options)) throw new Error("Diagram options must be an object.");
		exactKeys(value.options, ["theme", "timeout_ms"], "Diagram options");
		if (value.options.theme !== undefined && (typeof value.options.theme !== "string" || !THEMES.has(value.options.theme))) {
			throw new Error("Diagram theme must be light or dark.");
		}
		const timeoutMs = value.options.timeout_ms;
		if (
			timeoutMs !== undefined
			&& (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000)
		) {
			throw new Error("Diagram timeout_ms must be an integer from 100 through 30000.");
		}
		options = {
			...(value.options.theme === "light" || value.options.theme === "dark" ? { theme: value.options.theme } : {}),
			...(typeof timeoutMs === "number" ? { timeout_ms: timeoutMs } : {}),
		};
	}

	// Clone through the bounded JSON representation so callers cannot mutate a
	// parsed request after validation.
	const cloned = JSON.parse(encoded) as { spec: Record<string, unknown> };
	return {
		spec: cloned.spec,
		...(options ? { options } : {}),
	};
}

const strict = { additionalProperties: false } as const;
const identifier = {
	type: "string",
	minLength: 1,
	maxLength: 64,
	pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
} as const;
const label = {
	type: "string",
	minLength: 1,
	maxLength: 512,
	pattern: "^(?=[\\x20-\\x7E]*\\S)[\\x20-\\x7E]*$",
} as const;
const source = {
	type: "object",
	properties: {
		path: { type: "string", minLength: 1, maxLength: 4096 },
		line: { type: "integer", minimum: 1 },
		end_line: { type: "integer", minimum: 1 },
	},
	required: ["path", "line"],
	...strict,
} as const;

/** JSON Schema exposed only to the isolated /btw child. */
export const BTW_DIAGRAM_PARAMETERS = {
	type: "object",
	properties: {
		spec: {
			type: "object",
			description: "A typed diagram. Flow requires nodes+edges; sequence requires participants+messages; journey requires lanes+steps; ERD requires entities; JSON requires exactly one of value or path.",
			properties: {
				schema_version: { type: "integer", const: 1 },
				kind: { type: "string", enum: ["flow", "sequence", "journey", "erd", "json"] },
				id: identifier,
				title: { ...label, maxLength: 256 },
				direction: { type: "string", enum: ["left-to-right", "top-to-bottom"] },
				nodes: {
					type: "array",
					minItems: 1,
					maxItems: 256,
					items: {
						type: "object",
						properties: {
							id: identifier,
							label,
							group: { ...label, maxLength: 128 },
							shape: { type: "string", enum: ["box", "component", "database", "actor", "queue", "note"] },
							source,
						},
						required: ["id", "label"],
						...strict,
					},
				},
				edges: {
					type: "array",
					maxItems: 512,
					items: {
						type: "object",
						properties: {
							from: identifier,
							to: identifier,
							label,
							style: { type: "string", enum: ["solid", "dashed"] },
							direction: { type: "string", enum: ["forward", "bidirectional", "none"] },
						},
						required: ["from", "to"],
						...strict,
					},
				},
				participants: {
					type: "array",
					minItems: 1,
					maxItems: 64,
					items: {
						type: "object",
						properties: {
							id: identifier,
							label,
							kind: { type: "string", enum: ["actor", "participant", "boundary", "control", "entity", "database", "collections", "queue"] },
							source,
						},
						required: ["id", "label"],
						...strict,
					},
				},
				messages: {
					type: "array",
					minItems: 1,
					maxItems: 512,
					items: {
						type: "object",
						properties: {
							from: identifier,
							to: identifier,
							label,
							kind: { type: "string", enum: ["sync", "async", "return", "create"] },
							note: label,
						},
						required: ["from", "to", "label"],
						...strict,
					},
				},
				lanes: {
					type: "array",
					minItems: 1,
					maxItems: 32,
					items: {
						type: "object",
						properties: { id: identifier, label: { ...label, maxLength: 128 } },
						required: ["id", "label"],
						...strict,
					},
				},
				steps: {
					type: "array",
					minItems: 1,
					maxItems: 256,
					items: {
						type: "object",
						properties: {
							id: identifier,
							lane: identifier,
							label,
							detail: label,
							state: { type: "string", enum: ["normal", "success", "warning", "failure"] },
							source,
						},
						required: ["id", "lane", "label"],
						...strict,
					},
				},
				entities: {
					type: "array",
					minItems: 1,
					maxItems: 128,
					items: {
						type: "object",
						properties: {
							id: identifier,
							label: { ...label, maxLength: 128 },
							fields: {
								type: "array",
								maxItems: 1024,
								items: {
									type: "object",
									properties: {
										name: { ...label, maxLength: 128 },
										type: { ...label, maxLength: 128 },
										key: { type: "string", enum: ["primary", "foreign", "unique"] },
										nullable: { type: "boolean" },
									},
									required: ["name"],
									...strict,
								},
							},
							source,
						},
						required: ["id", "label"],
						...strict,
					},
				},
				relations: {
					type: "array",
					maxItems: 512,
					items: {
						type: "object",
						properties: {
							from: identifier,
							to: identifier,
							label: { ...label, maxLength: 256 },
							from_cardinality: { type: "string", enum: ["one", "zero_or_one", "many", "one_or_many", "zero_or_many"] },
							to_cardinality: { type: "string", enum: ["one", "zero_or_one", "many", "one_or_many", "zero_or_many"] },
						},
						required: ["from", "to"],
						...strict,
					},
				},
				value: { description: "Inline JSON value. Use exactly one of value or path." },
				path: { type: "string", minLength: 1, maxLength: 4096 },
				max_depth: { type: "integer", minimum: 1, maximum: 16 },
				collapse_arrays_after: { type: "integer", minimum: 1, maximum: 100 },
			},
			required: ["schema_version", "kind", "id"],
			anyOf: [
				{
					properties: { kind: { const: "flow" } },
					required: ["kind", "nodes", "edges"],
				},
				{
					properties: { kind: { const: "sequence" } },
					required: ["kind", "participants", "messages"],
				},
				{
					properties: { kind: { const: "journey" } },
					required: ["kind", "lanes", "steps"],
				},
				{
					properties: { kind: { const: "erd" } },
					required: ["kind", "entities"],
				},
				{
					properties: { kind: { const: "json" } },
					required: ["kind"],
					oneOf: [{ required: ["value"] }, { required: ["path"] }],
				},
			],
			...strict,
		},
		options: {
			type: "object",
			properties: {
				theme: { type: "string", enum: ["light", "dark"] },
				timeout_ms: { type: "integer", minimum: 100, maximum: 30_000 },
			},
			...strict,
		},
	},
	required: ["spec"],
	...strict,
} as const;
