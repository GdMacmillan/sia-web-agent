/**
 * Source-edit note middleware.
 *
 * Drives `wrapToolCall` directly against a real temp directory. The
 * contract under test: a successful `write_file` / `edit_file` inside the
 * installed source tree gains a note naming the path; everything else —
 * other tools, failed writes, scratch areas, paths outside the root, a
 * version-controlled working tree, the disabled flag, and a resolver that
 * throws — leaves the tool's own result untouched and never throws.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { ToolMessage } from "langchain";
import { Command } from "@langchain/langgraph";

import {
  createSourceEditNoteMiddleware,
  sourceEditNoteText,
} from "../../../src/middleware/source-edit-note.js";
import { resetConfig } from "../../../src/config/index.js";

let tmp: string;
let realRoot: string;
let linkRoot: string;

function request(name: string, args: Record<string, unknown>) {
  return {
    toolCall: { id: "call_1", name, args, type: "tool_call" },
    tool: undefined,
    state: {},
    runtime: {},
  } as any;
}

function ok(content = "Successfully wrote to 'x'") {
  return new ToolMessage({ content, tool_call_id: "call_1", name: "write_file" });
}

async function run(
  mw: ReturnType<typeof createSourceEditNoteMiddleware>,
  req: any,
  result: unknown = ok(),
) {
  const handler = jest.fn(async () => result);
  const out = await mw.wrapToolCall!(req, handler as any);
  return { out, handler };
}

function contentOf(out: unknown): string {
  const msg =
    out instanceof Command
      ? ((out.update as { messages: ToolMessage[] }).messages[0] as ToolMessage)
      : (out as ToolMessage);
  return msg.content as string;
}

beforeEach(() => {
  delete process.env.SOURCE_EDIT_NOTE_ENABLED;
  resetConfig();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "src-note-")));
  realRoot = path.join(tmp, ".versions", "1.0.0");
  fs.mkdirSync(path.join(realRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(realRoot, "src", "a.ts"), "export {};\n");
  linkRoot = path.join(tmp, "current");
  fs.symlinkSync(realRoot, linkRoot);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  resetConfig();
});

describe("createSourceEditNoteMiddleware", () => {
  it("appends the note to a successful write inside the tree", async () => {
    const mw = createSourceEditNoteMiddleware({ projectRoot: linkRoot });
    const result = ok();
    const { out, handler } = await run(
      mw,
      request("write_file", { file_path: path.join(linkRoot, "src", "a.ts") }),
      result,
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(out).toBe(result);
    expect(contentOf(out)).toBe(
      `Successfully wrote to 'x'\n\n${sourceEditNoteText("src/a.ts")}`,
    );
  });

  it("appends the note to a successful edit given a relative path", async () => {
    const mw = createSourceEditNoteMiddleware({ projectRoot: linkRoot });
    const { out } = await run(
      mw,
      request("edit_file", { file_path: "src/a.ts" }),
      ok("Successfully replaced 1 occurrence(s) in 'src/a.ts'"),
    );
    expect(contentOf(out)).toContain(sourceEditNoteText("src/a.ts"));
  });

  it("matches a path given through the versioned directory, and a new file", async () => {
    const mw = createSourceEditNoteMiddleware({ projectRoot: linkRoot });
    const { out } = await run(
      mw,
      request("write_file", {
        file_path: path.join(realRoot, "src", "new", "b.ts"),
      }),
    );
    expect(contentOf(out)).toContain(sourceEditNoteText("src/new/b.ts"));
  });

  it("appends the note through a Command result", async () => {
    const mw = createSourceEditNoteMiddleware({ projectRoot: linkRoot });
    const cmd = new Command({ update: { files: {}, messages: [ok()] } });
    const { out } = await run(
      mw,
      request("write_file", { file_path: path.join(linkRoot, "src", "a.ts") }),
      cmd,
    );
    expect(out).toBe(cmd);
    expect(contentOf(out)).toContain(sourceEditNoteText("src/a.ts"));
  });

  it.each([
    ["the code workspace", ".code-workspace/t1/x.ts"],
    ["installed dependencies", "node_modules/pkg/index.js"],
  ])("adds no note for %s", async (_label, rel) => {
    const mw = createSourceEditNoteMiddleware({ projectRoot: linkRoot });
    const { out } = await run(
      mw,
      request("write_file", { file_path: path.join(linkRoot, rel) }),
    );
    expect(contentOf(out)).toBe("Successfully wrote to 'x'");
  });

  it("adds no note for a path outside the root", async () => {
    const mw = createSourceEditNoteMiddleware({ projectRoot: linkRoot });
    const { out } = await run(
      mw,
      request("write_file", { file_path: path.join(tmp, "elsewhere.ts") }),
    );
    expect(contentOf(out)).toBe("Successfully wrote to 'x'");
  });

  it("adds no note for a failed write", async () => {
    const mw = createSourceEditNoteMiddleware({ projectRoot: linkRoot });
    const failed = new ToolMessage({
      content: "Error: file not found",
      tool_call_id: "call_1",
    });
    const { out } = await run(
      mw,
      request("edit_file", { file_path: path.join(linkRoot, "src", "a.ts") }),
      failed,
    );
    expect(contentOf(out)).toBe("Error: file not found");

    const errored = new ToolMessage({
      content: "Successfully wrote to 'x'",
      tool_call_id: "call_1",
      status: "error",
    });
    const second = await run(
      mw,
      request("write_file", { file_path: path.join(linkRoot, "src", "a.ts") }),
      errored,
    );
    expect(contentOf(second.out)).toBe("Successfully wrote to 'x'");
  });

  it("adds no note for any other tool", async () => {
    const mw = createSourceEditNoteMiddleware({ projectRoot: linkRoot });
    const { out } = await run(
      mw,
      request("read_file", { file_path: path.join(linkRoot, "src", "a.ts") }),
    );
    expect(contentOf(out)).toBe("Successfully wrote to 'x'");
  });

  it("adds no note in a version-controlled working tree", async () => {
    fs.mkdirSync(path.join(realRoot, ".git"));
    const mw = createSourceEditNoteMiddleware({ projectRoot: linkRoot });
    const { out } = await run(
      mw,
      request("write_file", { file_path: path.join(linkRoot, "src", "a.ts") }),
    );
    expect(contentOf(out)).toBe("Successfully wrote to 'x'");
  });

  it("adds no note when disabled by option", async () => {
    const mw = createSourceEditNoteMiddleware({
      projectRoot: linkRoot,
      enabled: false,
    });
    const { out } = await run(
      mw,
      request("write_file", { file_path: path.join(linkRoot, "src", "a.ts") }),
    );
    expect(contentOf(out)).toBe("Successfully wrote to 'x'");
  });

  it("adds no note when SOURCE_EDIT_NOTE_ENABLED=false", async () => {
    process.env.SOURCE_EDIT_NOTE_ENABLED = "false";
    resetConfig();
    const mw = createSourceEditNoteMiddleware({ projectRoot: linkRoot });
    const { out } = await run(
      mw,
      request("write_file", { file_path: path.join(linkRoot, "src", "a.ts") }),
    );
    expect(contentOf(out)).toBe("Successfully wrote to 'x'");
  });

  it("is on by default through config", async () => {
    const mw = createSourceEditNoteMiddleware({ projectRoot: linkRoot });
    const { out } = await run(
      mw,
      request("write_file", { file_path: path.join(linkRoot, "src", "a.ts") }),
    );
    expect(contentOf(out)).toContain("installed source");
  });

  it("passes the result through when the resolver throws", async () => {
    const mw = createSourceEditNoteMiddleware({
      projectRoot: linkRoot,
      realpath: () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    });
    const result = ok();
    const { out } = await run(
      mw,
      request("write_file", { file_path: path.join(linkRoot, "src", "a.ts") }),
      result,
    );
    expect(out).toBe(result);
    expect(contentOf(out)).toBe("Successfully wrote to 'x'");
  });

  it("never alters the request passed to the tool", async () => {
    const mw = createSourceEditNoteMiddleware({ projectRoot: linkRoot });
    const req = request("write_file", { file_path: "src/a.ts" });
    const { handler } = await run(mw, req);
    expect(handler).toHaveBeenCalledWith(req);
    expect(req.toolCall.args).toEqual({ file_path: "src/a.ts" });
  });
});
