/**
 * 模型引用（`provider/id`）的解析与格式化。
 *
 * 该模块是纯函数模块：无 IO、无 pi 依赖，供 config / routing / 入口层共用。
 */

export interface ModelRef {
	provider: string;
	id: string;
}

/** 解析 `provider/id`；provider 与 id 均非空才合法。id 中允许出现 `/`。 */
export function parseRef(raw: string): ModelRef | undefined {
	const text = String(raw ?? "").trim();
	if (!text) return undefined;
	const slash = text.indexOf("/");
	if (slash <= 0 || slash === text.length - 1) return undefined;
	const provider = text.slice(0, slash);
	const id = text.slice(slash + 1);
	if (!provider || !id) return undefined;
	return { provider, id };
}

export function refText(ref: ModelRef): string {
	return `${ref.provider}/${ref.id}`;
}

/** 从 pi 的 model 对象（或相似结构）中提取 `provider/id`；无法提取时返回空串。 */
export function refOf(value: unknown): string {
	if (!value || typeof value !== "object") return "";
	const v = value as { provider?: unknown; id?: unknown; model?: unknown };
	const provider = typeof v.provider === "string" ? v.provider : "";
	const id = typeof v.id === "string" ? v.id : typeof v.model === "string" ? v.model : "";
	return provider && id ? `${provider}/${id}` : "";
}
