import * as assert from "assert";
import * as vscode from "vscode";
import { LemonadeChatModelProvider } from "../provider";
import { filterModels, findMissingModels } from "../utils";
import type { LemonadeModel } from "../types";

const model = (id: string): LemonadeModel => ({ id, object: "model" });

suite("Model allow-list", () => {
	suite("filterModels", () => {
		const models = [model("a"), model("b"), model("c")];

		test("keeps all models when the allow-list is unset or empty", () => {
			assert.deepStrictEqual(filterModels(models, undefined), models);
			assert.deepStrictEqual(filterModels(models, []), models);
		});

		test("keeps only listed ids in server order and ignores unknown names", () => {
			assert.deepStrictEqual(filterModels(models, ["c", "missing", "a"]).map((m) => m.id), ["a", "c"]);
		});

		test("matches ids exactly", () => {
			assert.deepStrictEqual(filterModels(models, ["A", "a "]), []);
		});
	});

	suite("findMissingModels", () => {
		const models = [model("a"), model("b")];

		test("returns nothing when the allow-list is unset or empty", () => {
			assert.deepStrictEqual(findMissingModels(models, undefined), []);
			assert.deepStrictEqual(findMissingModels(models, []), []);
		});

		test("returns unknown names once, in allow-list order", () => {
			assert.deepStrictEqual(findMissingModels(models, ["z", "a", "typo", "z"]), ["z", "typo"]);
		});
	});

	suite("provider configuration", () => {
		let originalFetch: typeof fetch;
		let requested: string[];

		setup(() => {
			originalFetch = global.fetch;
			requested = [];
			(global as unknown as Record<string, unknown>).fetch = async (url: string) => {
				requested.push(url);
				return {
					ok: true,
					json: async () => url.endsWith("/models")
						? { object: "list", data: [model("a"), model("b"), model("c")] }
						: undefined,
				};
			};
		});

		teardown(() => {
			(global as unknown as Record<string, unknown>).fetch = originalFetch;
		});

		function newProvider() {
			return new LemonadeChatModelProvider({
				get: async () => undefined,
				store: async () => {},
				delete: async () => {},
				onDidChange: (_listener: unknown) => ({ dispose() {} }),
			} as unknown as vscode.SecretStorage, "test/test");
		}

		async function listIds(configuration: Record<string, unknown>): Promise<string[]> {
			const infos = await newProvider().prepareLanguageModelChatInformation(
				{ silent: true, group: "node", configuration },
				new vscode.CancellationTokenSource().token
			);
			return infos.map((info) => info.id);
		}

		test("shows only configured models", async () => {
			const ids = await listIds({ url: "http://localhost:13305/api/v1", models: ["b", 7, " c ", ""] });
			assert.deepStrictEqual(ids, ["b", "c"]);
		});

		test("shows every model when none are configured", async () => {
			assert.deepStrictEqual(await listIds({ url: "http://localhost:13305/api/v1" }), ["a", "b", "c"]);
			assert.deepStrictEqual(await listIds({ url: "http://localhost:13305/api/v1", models: [] }), ["a", "b", "c"]);
		});

		test("does not resolve context for hidden models", async () => {
			await listIds({ url: "http://localhost:13305/api/v1", models: ["b"] });
			assert.ok(!requested.some((url) => url.includes("/models/a/") || url.includes("/models/c/")));
		});

		suite("warnings", () => {
			let warnings: string[];
			let originalShowWarning: typeof vscode.window.showWarningMessage;

			setup(() => {
				warnings = [];
				originalShowWarning = vscode.window.showWarningMessage;
				(vscode.window as unknown as Record<string, unknown>).showWarningMessage = async (message: string) => {
					warnings.push(message);
					return undefined;
				};
			});

			teardown(() => {
				(vscode.window as unknown as Record<string, unknown>).showWarningMessage = originalShowWarning;
			});

			async function prepare(configuration: Record<string, unknown>) {
				return newProvider().prepareLanguageModelChatInformation(
					{ silent: false, group: "node", configuration },
					new vscode.CancellationTokenSource().token
				);
			}

			test("explains an allow-list mismatch and names the missing models", async () => {
				const infos = await prepare({ url: "http://localhost:13305/api/v1", models: ["typo", "other"] });
				assert.strictEqual(infos.length, 0);
				assert.strictEqual(warnings.length, 1);
				assert.match(warnings[0], /allow-listed models were found/);
				assert.match(warnings[0], /node \(typo, other\)/);
				assert.doesNotMatch(warnings[0], /server is running/);
			});

			test("does not warn when at least one allow-listed model matches", async () => {
				const infos = await prepare({ url: "http://localhost:13305/api/v1", models: ["a", "typo"] });
				assert.deepStrictEqual(infos.map((info) => info.id), ["a"]);
				assert.strictEqual(warnings.length, 0);
			});

			test("keeps the server-down warning when the endpoint is unreachable", async () => {
				(global as unknown as Record<string, unknown>).fetch = async () => { throw new Error("ECONNREFUSED"); };
				await prepare({ url: "http://localhost:13305/api/v1", models: ["a"] });
				assert.strictEqual(warnings.length, 1);
				assert.match(warnings[0], /server is running/);
			});
		});
	});
});
