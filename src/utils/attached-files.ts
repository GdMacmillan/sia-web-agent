/**
 * Files attached to a user message.
 *
 * A host that lets a person attach a file stores it in the directory named by
 * `SIA_INBOX_DIR` and adds one text block per file to the message. The whole
 * block is a single self-closing tag:
 *
 *   <attached-file name="report.csv" mime="text/csv" size="1234" path="/abs/report.csv"/>
 *
 * `name` is the person's label for the file; `path` is where it can be read.
 * Attribute values are XML-escaped. The model reads the tag as written. Text
 * that leaves the conversation (what is stored in shared memory, for one)
 * keeps the name and drops the rest, so a machine's paths stay on it.
 */

/** The tag a host uses for one attached file. */
export const ATTACHED_FILE_TAG = "attached-file";

const ATTACHED_FILE_PATTERN = new RegExp(
  `<${ATTACHED_FILE_TAG}\\b([^>]*?)/?>`,
  "g",
);

/** A tag cut off before its closing `>`, as a length-capped copy may end. */
const TRUNCATED_TAIL_PATTERN = new RegExp(`<${ATTACHED_FILE_TAG}\\b([^>]*)$`);

const ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  "&quot;": '"',
  "&apos;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
});

function unescapeAttribute(value: string): string {
  return value.replace(
    /&(?:quot|apos|lt|gt|amp);/g,
    (entity) => ENTITIES[entity] ?? entity,
  );
}

function attachedFileLabel(attributes: string): string {
  const name = /\bname="([^"]*)"/.exec(attributes)?.[1];
  const label = name ? unescapeAttribute(name).trim() : "";
  return label ? `[attached file: ${label}]` : "[attached file]";
}

/**
 * Replace every attached-file tag in `text` with `[attached file: <name>]`.
 * A tag cut off at the end of the text is replaced too.
 */
export function describeAttachedFiles(text: string): string {
  return text
    .replace(ATTACHED_FILE_PATTERN, (_tag, attributes: string) =>
      attachedFileLabel(attributes),
    )
    .replace(TRUNCATED_TAIL_PATTERN, (_tail, attributes: string) =>
      attachedFileLabel(attributes),
    );
}
