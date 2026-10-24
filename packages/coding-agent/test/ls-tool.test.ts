import { getEventListeners } from "node:events";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createLsTool, type LsOperations } from "../src/core/tools/ls.ts";

const cwd = process.cwd();

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// Regression coverage for https://github.com/earendil-works/pi/issues/11357.
describe("ls tool cancellation", () => {
	it.each(["missing path", "not a directory", "readdir failure", "stat failure"])(
		"removes its abort listener after %s",
		async (failure) => {
			const controller = new AbortController();
			const operations: LsOperations = {
				exists: () => failure !== "missing path",
				stat: () => {
					if (failure === "stat failure") throw new Error("stat failed");
					return { isDirectory: () => failure !== "not a directory" };
				},
				readdir: () => {
					throw new Error("readdir failed");
				},
			};
			const tool = createLsTool(cwd, { operations });

			await expect(tool.execute("ls", {}, controller.signal)).rejects.toThrow();
			expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		},
	);

	it.each(["exists", "directory stat", "readdir", "entry stat", "unreadable entry"])(
		"rejects promptly and starts no more operations after abort during %s",
		async (stage) => {
			const controller = new AbortController();
			const started = deferred();
			const finish = deferred();
			const calls: string[] = [];
			const operations: LsOperations = {
				exists: async () => {
					calls.push("exists");
					if (stage === "exists") {
						started.resolve();
						await finish.promise;
					}
					return true;
				},
				stat: async (path) => {
					calls.push(path);
					if (
						(stage === "directory stat" && path === cwd) ||
						((stage === "entry stat" || stage === "unreadable entry") && path === join(cwd, "a"))
					) {
						started.resolve();
						await finish.promise;
						if (stage === "unreadable entry") throw new Error("cannot stat entry");
					}
					return { isDirectory: () => true };
				},
				readdir: async () => {
					calls.push("readdir");
					if (stage === "readdir") {
						started.resolve();
						await finish.promise;
					}
					return ["a", "b", "c"];
				},
			};
			const tool = createLsTool(cwd, { operations });
			const pending = tool.execute("ls", {}, controller.signal);
			await started.promise;
			const callsAtAbort = [...calls];
			controller.abort();
			try {
				await expect(pending).rejects.toThrow("Operation aborted");
			} finally {
				finish.resolve();
			}
			// Drain continuations of the in-flight operation before checking for further reads.
			await setImmediate();
			expect(calls).toEqual(callsAtAbort);
			expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		},
	);

	it("does not start operations when already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const exists = vi.fn(() => true);
		const tool = createLsTool(cwd, {
			operations: { exists, stat: () => ({ isDirectory: () => true }), readdir: () => [] },
		});

		await expect(tool.execute("ls", {}, controller.signal)).rejects.toThrow("Operation aborted");
		expect(exists).not.toHaveBeenCalled();
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("keeps listing readable entries and cleans up after success", async () => {
		const controller = new AbortController();
		const tool = createLsTool(cwd, {
			operations: {
				exists: () => true,
				readdir: () => ["file.txt", "unreadable", ".hidden", "directory"],
				stat: (path) => {
					if (path === join(cwd, "unreadable")) throw new Error("cannot stat entry");
					return { isDirectory: () => path === cwd || path === join(cwd, "directory") };
				},
			},
		});

		const result = await tool.execute("ls", {}, controller.signal);
		expect(result.content).toEqual([{ type: "text", text: ".hidden\ndirectory/\nfile.txt" }]);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});
});
