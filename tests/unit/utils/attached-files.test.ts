/**
 * An attached-file tag is reduced to the file's name wherever message text
 * leaves the conversation.
 */
import { describe, it, expect } from "@jest/globals";
import {
  ATTACHED_FILE_TAG,
  describeAttachedFiles,
} from "../../../src/utils/attached-files.js";

const TAG =
  '<attached-file name="report.csv" mime="text/csv" size="1234" path="/home/u/inbox/ab12.csv"/>';

describe("describeAttachedFiles", () => {
  it("replaces a tag with the file's name", () => {
    expect(describeAttachedFiles(`Look at this\n${TAG}`)).toBe(
      "Look at this\n[attached file: report.csv]",
    );
  });

  it("replaces every tag in the text", () => {
    const second = TAG.replace("report.csv", "notes.md");
    expect(describeAttachedFiles(`${TAG}\n${second}`)).toBe(
      "[attached file: report.csv]\n[attached file: notes.md]",
    );
  });

  it("unescapes the name", () => {
    const tag =
      '<attached-file name="a &amp; b &lt;final&gt; &quot;v2&quot;.txt" mime="text/plain" size="1" path="/p/x.txt"/>';
    expect(describeAttachedFiles(tag)).toBe(
      '[attached file: a & b <final> "v2".txt]',
    );
  });

  it("falls back to a bare label when the name is missing or empty", () => {
    expect(describeAttachedFiles('<attached-file path="/p/x"/>')).toBe(
      "[attached file]",
    );
    expect(describeAttachedFiles('<attached-file name="" path="/p/x"/>')).toBe(
      "[attached file]",
    );
  });

  it("replaces a tag cut off at the end of the text", () => {
    const partial = TAG.slice(0, TAG.indexOf("path=") + 12);
    expect(partial).toContain('path="/home');
    const cut = `intro ${partial}`;
    expect(describeAttachedFiles(cut)).toBe(
      "intro [attached file: report.csv]",
    );
    expect(describeAttachedFiles("intro <attached-file na")).toBe(
      "intro [attached file]",
    );
  });

  it("leaves other text alone, including similar tag names", () => {
    const text = "a <attached-files> b <code>x</code> c";
    expect(describeAttachedFiles(text)).toBe(text);
    expect(ATTACHED_FILE_TAG).toBe("attached-file");
  });
});
