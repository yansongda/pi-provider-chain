import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRef, refOf, refText } from "../src/model-ref.ts";

test("parseRef: 合法引用", () => {
	assert.deepEqual(parseRef("volcengine/deepseek-v4.1-flash"), { provider: "volcengine", id: "deepseek-v4.1-flash" });
	assert.deepEqual(parseRef("  workbuddy/glm-5.3  "), { provider: "workbuddy", id: "glm-5.3" });
});

test("parseRef: id 中允许出现 /", () => {
	assert.deepEqual(parseRef("openrouter/vendor/model"), { provider: "openrouter", id: "vendor/model" });
});

test("parseRef: 非法引用返回 undefined", () => {
	for (const raw of ["", "   ", "noslash", "/leading", "trailing/"]) {
		assert.equal(parseRef(raw), undefined, `应拒绝：${JSON.stringify(raw)}`);
	}
});

test("refText: 往返一致", () => {
	const ref = { provider: "volcengine", id: "glm-5.3" };
	assert.equal(refText(ref), "volcengine/glm-5.3");
	assert.deepEqual(parseRef(refText(ref)), ref);
});

test("refOf: 提取 provider/id", () => {
	assert.equal(refOf({ provider: "volcengine", id: "glm-5.3" }), "volcengine/glm-5.3");
	assert.equal(refOf({ provider: "workbuddy", model: "glm-5.3" }), "workbuddy/glm-5.3");
	assert.equal(refOf({ provider: "workbuddy", id: "glm-5.3", model: "ignored" }), "workbuddy/glm-5.3");
});

test("refOf: 非法输入返回空串", () => {
	for (const value of [undefined, null, "volcengine/glm-5.3", {}, { provider: "volcengine" }, { id: "glm-5.3" }, 42]) {
		assert.equal(refOf(value), "");
	}
});
