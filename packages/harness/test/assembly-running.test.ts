import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createHarnessAssembly } from "../src/assembly";
import { createSessionStore } from "../src/core/session";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, readFile: vi.fn(fs.readFile), open: vi.fn(fs.open) };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["history", "creation"] as const)(
  "keeps the current Harness when it starts running during Session %s IO",
  async (phase) => {
    const root = await mkdtemp(join(tmpdir(), "susan-assembly-running-"));
    const server = createServer();
    const entered = deferred();
    const release = deferred();
    let response: ServerResponse | undefined;
    let run: Promise<unknown> | undefined;
    let switching: Promise<unknown> | undefined;
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Missing port");
      await mkdir(join(root, ".susan"));
      const otherCwd = join(root, "other");
      await mkdir(otherCwd);
      await writeFile(
        join(root, ".susan", "config.json"),
        JSON.stringify({
          defaultProvider: "local",
          defaultModel: "test",
          defaultReasoningEffort: "minimal",
          providers: {
            local: {
              type: "openai-completion",
              apiKey: "test-secret",
              baseURL: `http://127.0.0.1:${address.port}/v1`,
              models: [{ id: "test" }],
            },
          },
        }),
      );
      const assembly = createHarnessAssembly({ susanHomeParent: root });
      const first = await assembly.assemble({
        session: { kind: "new" },
        newSessionCwd: root,
      });
      if (first.kind !== "ready") throw new Error(JSON.stringify(first));
      const fs =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      // Pause real filesystem IO, without replacing Assembly or Session Store collaborators.
      if (phase === "history") {
        vi.mocked(readFile).mockImplementationOnce(async (...args) => {
          const value = await fs.readFile(...args);
          entered.resolve();
          await release.promise;
          return value;
        });
      } else {
        vi.mocked(open).mockImplementationOnce(async (...args) => {
          entered.resolve();
          await release.promise;
          return fs.open(...args);
        });
      }
      switching = assembly.assemble({
        session: { kind: "new" },
        newSessionCwd: otherCwd,
      });
      await entered.promise;
      const requested = once(server, "request");
      run = first.harness.dispatch({
        type: "submit",
        content: "keep this Session",
      });
      [, response] = (await requested) as [unknown, ServerResponse];
      expect(first.harness.getSnapshot().status).toBe("running");
      release.resolve();
      expect(await switching).toMatchObject({
        kind: "startup-error",
        error: { stage: "operation", code: "SUSAN_ASSEMBLY_BUSY" },
      });
      // A rejected switch must still leave operations guarded by the old running Harness.
      expect(await assembly.reload()).toMatchObject({
        kind: "startup-error",
        error: { code: "SUSAN_ASSEMBLY_BUSY" },
      });
      const store = createSessionStore({
        sessionsDirectory: join(root, ".susan", "sessions"),
      });
      const sessions = await store.listSessions();
      if (!sessions.ok) throw new Error(sessions.error.message);
      // Before creation, busy rejection must not create a Session. After creation, no rollback is promised.
      expect(sessions.value).toHaveLength(phase === "history" ? 1 : 2);
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "test failure", type: "invalid_request_error" },
        }),
      );
      await run;
      const pending = first.harness.getSnapshot();
      expect(pending.status).toBe("pending");
      expect((await assembly.reload()).kind).toBe("updated");
      expect(first.harness.getSnapshot()).toEqual(pending);
    } finally {
      release.resolve();
      vi.mocked(readFile).mockReset();
      vi.mocked(open).mockReset();
      if (response && !response.writableEnded) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "test cleanup", type: "invalid_request_error" },
          }),
        );
      }
      await Promise.allSettled([run, switching]);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
