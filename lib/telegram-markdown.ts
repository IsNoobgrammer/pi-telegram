/**
 * Telegram Markdown Beautifier
 * Zone: telegram outbound formatting
 *
 * Rule-based, deterministic transformations to make LLM responses
 * render well on Telegram mobile.
 *
 * Outputs Telegram-compatible markdown:
 * - *bold* (single asterisk, not double)
 * - _italic_ (underscore)
 * - `code` (inline)
 * - ```code``` (block)
 *
 * NO LLM calls — pure string transforms, fast and debuggable.
 */

// --- Constants ---

const TELEGRAM_CODE_BLOCK_MAX = 2000;
const TELEGRAM_MSG_MAX = 4000;

// --- Main Export ---

/**
 * Beautify markdown text for Telegram rendering.
 * Converts standard markdown to Telegram-compatible markdown.
 */
export function beautifyTelegramMarkdown(text: string): string {
  let result = text;

  // Extract and convert tables inside code blocks first
  result = extractTablesFromCodeBlocks(result);

  // Transform remaining markdown tables
  result = transformTables(result);

  // Convert markdown to Telegram-compatible format
  result = convertToTelegramMarkdown(result);

  // Clean up excessive blank lines
  result = cleanBlankLines(result);

  // Trim to Telegram message limit
  result = trimToLimit(result, TELEGRAM_MSG_MAX);

  return result;
}

// --- Table Extraction from Code Blocks ---

/**
 * Extract tables from markdown code blocks and convert to readable format.
 */
function extractTablesFromCodeBlocks(text: string): string {
  return text.replace(
    /```(?:markdown|md)?\n([\s\S]*?)```/g,
    (match, content) => {
      if (content.includes("|") && content.match(/\|.*\|/)) {
        const lines = content.split("\n");
        const tableLines = lines.filter(
          (l: string) => l.trim().startsWith("|") && l.trim().endsWith("|"),
        );

        if (tableLines.length >= 2) {
          return transformTableLines(tableLines);
        }
      }
      return content.trim();
    },
  );
}

function transformTableLines(lines: string[]): string {
  const dataLines = lines.filter(
    (l: string) => !l.trim().match(/^\|[\s\-:|]+\|$/),
  );

  if (dataLines.length < 2) return lines.join("\n");

  const headerCells = parseTableRow(dataLines[0]);
  const result: string[] = [];

  if (headerCells.length === 2) {
    result.push(`*${headerCells[0]}* — ${headerCells[1]}`);
    for (let i = 1; i < dataLines.length; i++) {
      const cells = parseTableRow(dataLines[i]);
      result.push(`• ${cells[0]} — ${cells[1] || ""}`);
    }
  } else {
    for (let i = 1; i < dataLines.length; i++) {
      const cells = parseTableRow(dataLines[i]);
      const parts: string[] = [];
      for (let j = 0; j < Math.min(headerCells.length, cells.length); j++) {
        if (cells[j]) {
          parts.push(`*${headerCells[j]}*: ${cells[j]}`);
        }
      }
      result.push(`• ${parts.join(" | ")}`);
    }
  }

  return result.join("\n");
}

// --- Table Transform ---

function transformTables(text: string): string {
  if (!text.match(/\|.*\|/)) return text;

  const lines = text.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isTableRow(line)) {
      const tableLines: string[] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      result.push(transformTableLines(tableLines));
    } else {
      result.push(line);
      i++;
    }
  }

  return result.join("\n");
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("|") &&
    trimmed.endsWith("|") &&
    !trimmed.match(/^\|[\s\-:|]+\|$/)
  );
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

// --- Markdown Conversion ---

/**
 * Convert standard markdown to Telegram-compatible markdown.
 *
 * Telegram markdown rules:
 * - *bold* (single asterisk)
 * - _italic_ (underscore)
 * - `code` (inline)
 * - ```code``` (block)
 * - [text](url) (links)
 * - No **bold**, no # headers
 */
function convertToTelegramMarkdown(text: string): string {
  let result = text;

  // Convert **bold** to *bold* (Telegram uses single asterisk)
  result = result.replace(/\*\*([^*]+)\*\*/g, "*$1*");

  // Convert # Headers to bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Convert __bold__ to *bold*
  result = result.replace(/__([^_]+)__/g, "*$1*");

  // Convert _italic_ (keep as-is, Telegram supports it)

  // Convert ~~strikethrough~~ to ~strikethrough~
  result = result.replace(/~~([^~]+)~~/g, "~$1~");

  // Convert bullet lists: - item or * item to • item
  result = result.replace(/^[\s]*[-*]\s+/gm, "• ");

  // Convert numbered lists: 1. item to 1. item (keep as-is)

  // Truncate long code blocks
  result = result.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (match, lang, code) => {
      if (code.length > TELEGRAM_CODE_BLOCK_MAX) {
        const truncated = code.slice(0, TELEGRAM_CODE_BLOCK_MAX - 20);
        return `\`\`\`${lang}\n${truncated}\n... (truncated)\n\`\`\``;
      }
      return match;
    },
  );

  return result;
}

// --- Utility Functions ---

function cleanBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

function trimToLimit(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit - 20) + "\n\n... (truncated)";
}

/**
 * Format a tool name for display (underscores → spaces).
 */
export function formatToolNameForDisplay(toolName: string): string {
  return toolName.replace(/_/g, " ");
}

/**
 * Extract a preview from tool args.
 */
export function extractToolArgsPreview(
  args: Record<string, unknown> | undefined,
): string {
  if (!args || typeof args !== "object") return "";

  const priorityKeys = [
    "text",
    "command",
    "path",
    "query",
    "content",
    "description",
    "url",
  ];

  for (const key of priorityKeys) {
    const val = args[key];
    if (typeof val === "string" && val.length > 0) {
      return val;
    }
  }

  for (const val of Object.values(args)) {
    if (typeof val === "string" && val.length > 0) {
      return val;
    }
  }

  return JSON.stringify(args);
}
