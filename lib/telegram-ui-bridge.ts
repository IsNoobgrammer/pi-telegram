/**
 * Telegram UI Bridge
 * Zone: telegram ui interception
 *
 * Implements ctx.ui interface for Telegram, enabling interactive tools
 * like ask_user_question to work via Telegram buttons and replies.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

// --- Types ---

export interface TelegramUIBridgeDeps {
  sendMessage: (
    chatId: number,
    text: string,
    options?: {
      replyMarkup?: unknown;
      parseMode?: "HTML" | "Markdown";
    },
  ) => Promise<number | undefined>;
  editMessage?: (
    chatId: number,
    messageId: number,
    text: string,
    options?: {
      replyMarkup?: unknown;
      parseMode?: "HTML" | "Markdown";
    },
  ) => Promise<void>;
  answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
  getActiveChatId: () => number | undefined;
}

export interface PendingUIPrompt {
  id: string;
  type: "select" | "confirm" | "input" | "multiSelect";
  chatId: number;
  messageId?: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
  options?: string[];
  selectedIndices?: Set<number>;
  multiSelect?: boolean;
  createdAt: number;
}

// --- Overlay Widget State ---

export interface OverlayWidget {
  id: string;
  chatId: number;
  messageId?: number;
  title: string;
  content: string[];
  createdAt: number;
}

const overlayWidgets = new Map<string, OverlayWidget>();
let overlayCounter = 0;

const pendingPrompts = new Map<string, PendingUIPrompt>();
let promptCounter = 0;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// --- Overlay Widget Functions ---

/**
 * Create an overlay widget that stays at the bottom of the chat.
 * Useful for tools like todo that persist until tasks are completed.
 */
export async function createOverlayWidget(
  deps: TelegramUIBridgeDeps,
  title: string,
  content: string[],
): Promise<string> {
  const chatId = deps.getActiveChatId();
  if (chatId === undefined) return "";

  const widgetId = `overlay-${++overlayCounter}`;

  // Format the overlay message
  const formattedContent = content.map((line) => `  ${line}`).join("\n");
  const messageText = `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(formattedContent)}`;

  // Send as a persistent message
  const messageId = await deps.sendMessage(chatId, messageText, {
    parseMode: "HTML",
  });

  // Store the widget
  const widget: OverlayWidget = {
    id: widgetId,
    chatId,
    messageId,
    title,
    content,
    createdAt: Date.now(),
  };
  overlayWidgets.set(widgetId, widget);

  return widgetId;
}

/**
 * Update an existing overlay widget's content.
 */
export async function updateOverlayWidget(
  deps: TelegramUIBridgeDeps,
  widgetId: string,
  content: string[],
): Promise<void> {
  const widget = overlayWidgets.get(widgetId);
  if (!widget || !widget.messageId) return;

  // Update content
  widget.content = content;

  // Format the updated message
  const formattedContent = content.map((line) => `  ${line}`).join("\n");
  const messageText = `<b>${escapeHtml(widget.title)}</b>\n\n${escapeHtml(formattedContent)}`;

  // Edit the message
  await deps.editMessage?.(widget.chatId, widget.messageId, messageText, {
    parseMode: "HTML",
  });
}

/**
 * Remove an overlay widget.
 */
export function removeOverlayWidget(widgetId: string): void {
  overlayWidgets.delete(widgetId);
}

/**
 * Get all active overlay widgets for a chat.
 */
export function getOverlayWidgets(chatId: number): OverlayWidget[] {
  return Array.from(overlayWidgets.values()).filter((w) => w.chatId === chatId);
}

// --- Factory ---

export function createTelegramUIHandler(
  deps: TelegramUIBridgeDeps,
): ExtensionUIContext {
  return {
    select: (title, options, opts) =>
      handleSelect(deps, title, options, opts?.signal, opts?.timeout),
    confirm: (title, message, opts) =>
      handleConfirm(deps, title, message, opts?.signal, opts?.timeout),
    input: (title, placeholder, opts) =>
      handleInput(deps, title, placeholder, opts?.signal, opts?.timeout),
    notify: (message, type) => handleNotify(deps, message, type),
    setStatus: (_key, _text) => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    onTerminalInput: () => () => {},
    custom: () => {
      throw new Error("custom() not supported in Telegram mode");
    },
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: {} as any,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Not supported in Telegram mode" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  } as ExtensionUIContext;
}

// --- Select Handler ---

async function handleSelect(
  deps: TelegramUIBridgeDeps,
  title: string,
  options: string[],
  signal?: AbortSignal,
  timeout?: number,
): Promise<string | undefined> {
  const chatId = deps.getActiveChatId();
  if (chatId === undefined) return undefined;

  const promptId = `select-${++promptCounter}`;

  // Truncate long options for Telegram buttons
  const truncatedOptions = options.map((opt) =>
    opt.length > 50 ? `${opt.slice(0, 47)}...` : opt,
  );

  // Build inline keyboard - one option per row for better readability
  const inlineKeyboard = {
    inline_keyboard: truncatedOptions.map((opt, i) => [
      { text: `${i + 1}. ${opt}`, callback_data: `ui:${promptId}:${i}` },
    ]),
  };

  // Format message with options list
  const optionsList = truncatedOptions
    .map((opt, i) => `${i + 1}. ${opt}`)
    .join("\n");
  const messageText = `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(optionsList)}`;

  // Send message with buttons
  const messageId = await deps.sendMessage(chatId, messageText, {
    replyMarkup: inlineKeyboard,
    parseMode: "HTML",
  });

  // Create pending promise
  return new Promise<string | undefined>((resolve, reject) => {
    const prompt: PendingUIPrompt = {
      id: promptId,
      type: "select",
      chatId,
      messageId,
      resolve: resolve as (value: unknown) => void,
      reject,
      options,
      createdAt: Date.now(),
    };

    // Set up timeout (default 5 minutes)
    const timeoutMs = timeout ?? DEFAULT_TIMEOUT_MS;
    prompt.timeout = setTimeout(() => {
      pendingPrompts.delete(promptId);
      deps.sendMessage(chatId, "⏰ Selection timed out.", { parseMode: "HTML" }).catch(() => {});
      resolve(undefined);
    }, timeoutMs);

    // Handle abort signal
    if (signal) {
      signal.addEventListener("abort", () => {
        pendingPrompts.delete(promptId);
        if (prompt.timeout) clearTimeout(prompt.timeout);
        resolve(undefined);
      }, { once: true });
    }

    pendingPrompts.set(promptId, prompt);
  });
}

// --- Multi-Select Handler ---

/**
 * Handle multi-select prompts with toggle buttons.
 * User can select multiple options, then confirm with Done button.
 */
export async function handleMultiSelect(
  deps: TelegramUIBridgeDeps,
  title: string,
  options: string[],
  signal?: AbortSignal,
  timeout?: number,
): Promise<string[]> {
  const chatId = deps.getActiveChatId();
  if (chatId === undefined) return [];

  const promptId = `multi-${++promptCounter}`;
  const selectedIndices = new Set<number>();

  // Truncate long options for Telegram buttons
  const truncatedOptions = options.map((opt) =>
    opt.length > 40 ? `${opt.slice(0, 37)}...` : opt,
  );

  // Build inline keyboard with toggle buttons
  const buildKeyboard = () => {
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    
    for (let i = 0; i < truncatedOptions.length; i++) {
      const isSelected = selectedIndices.has(i);
      const prefix = isSelected ? "✅" : "⬜";
      rows.push([
        { text: `${prefix} ${truncatedOptions[i]}`, callback_data: `ui:${promptId}:toggle:${i}` },
      ]);
    }
    
    // Add Done button at the bottom
    rows.push([
      { text: "✔️ Done", callback_data: `ui:${promptId}:done` },
    ]);
    
    return { inline_keyboard: rows };
  };

  // Format message
  const optionsList = truncatedOptions
    .map((opt, i) => `${selectedIndices.has(i) ? "✅" : "⬜"} ${opt}`)
    .join("\n");
  const messageText = `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(optionsList)}\n\n_Select multiple options, then tap Done_`;

  // Send message with buttons
  const messageId = await deps.sendMessage(chatId, messageText, {
    replyMarkup: buildKeyboard(),
    parseMode: "HTML",
  });

  // Create pending promise
  return new Promise<string[]>((resolve, reject) => {
    const prompt: PendingUIPrompt = {
      id: promptId,
      type: "multiSelect",
      chatId,
      messageId,
      resolve: resolve as (value: unknown) => void,
      reject,
      options,
      selectedIndices,
      createdAt: Date.now(),
    };

    // Set up timeout
    const timeoutMs = timeout ?? DEFAULT_TIMEOUT_MS;
    prompt.timeout = setTimeout(() => {
      pendingPrompts.delete(promptId);
      deps.sendMessage(chatId, "⏰ Selection timed out.", { parseMode: "HTML" }).catch(() => {});
      resolve([]);
    }, timeoutMs);

    // Handle abort signal
    if (signal) {
      signal.addEventListener("abort", () => {
        pendingPrompts.delete(promptId);
        if (prompt.timeout) clearTimeout(prompt.timeout);
        resolve([]);
      }, { once: true });
    }

    pendingPrompts.set(promptId, prompt);
  });
}

// --- Confirm Handler ---

async function handleConfirm(
  deps: TelegramUIBridgeDeps,
  title: string,
  message: string,
  signal?: AbortSignal,
  timeout?: number,
): Promise<boolean> {
  const chatId = deps.getActiveChatId();
  if (chatId === undefined) return false;

  const promptId = `confirm-${++promptCounter}`;

  // Build Yes/No buttons with better styling
  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: "✅ Yes", callback_data: `ui:${promptId}:yes` },
        { text: "❌ No", callback_data: `ui:${promptId}:no` },
      ],
    ],
  };

  // Format message
  const messageText = `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(message)}`;

  // Send message with buttons
  const messageId = await deps.sendMessage(chatId, messageText, {
    replyMarkup: inlineKeyboard,
    parseMode: "HTML",
  });

  // Create pending promise
  return new Promise<boolean>((resolve, reject) => {
    const prompt: PendingUIPrompt = {
      id: promptId,
      type: "confirm",
      chatId,
      messageId,
      resolve: resolve as (value: unknown) => void,
      reject,
      createdAt: Date.now(),
    };

    // Set up timeout (default 5 minutes)
    const timeoutMs = timeout ?? DEFAULT_TIMEOUT_MS;
    prompt.timeout = setTimeout(() => {
      pendingPrompts.delete(promptId);
      deps.sendMessage(chatId, "⏰ Confirmation timed out.", { parseMode: "HTML" }).catch(() => {});
      resolve(false);
    }, timeoutMs);

    // Handle abort signal
    if (signal) {
      signal.addEventListener("abort", () => {
        pendingPrompts.delete(promptId);
        if (prompt.timeout) clearTimeout(prompt.timeout);
        resolve(false);
      }, { once: true });
    }

    pendingPrompts.set(promptId, prompt);
  });
}

// --- Input Handler ---

async function handleInput(
  deps: TelegramUIBridgeDeps,
  title: string,
  placeholder?: string,
  signal?: AbortSignal,
  timeout?: number,
): Promise<string | undefined> {
  const chatId = deps.getActiveChatId();
  if (chatId === undefined) return undefined;

  const promptId = `input-${++promptCounter}`;

  // Send prompt message
  const message = placeholder
    ? `<b>${escapeHtml(title)}</b>\n\n_${escapeHtml(placeholder)}_`
    : `<b>${escapeHtml(title)}</b>\n\nType your response below:`;

  const messageId = await deps.sendMessage(chatId, message, {
    parseMode: "HTML",
  });

  // Create pending promise
  return new Promise<string | undefined>((resolve, reject) => {
    const prompt: PendingUIPrompt = {
      id: promptId,
      type: "input",
      chatId,
      messageId,
      resolve: resolve as (value: unknown) => void,
      reject,
      createdAt: Date.now(),
    };

    // Set up timeout
    if (timeout) {
      prompt.timeout = setTimeout(() => {
        pendingPrompts.delete(promptId);
        resolve(undefined);
      }, timeout);
    }

    // Handle abort signal
    if (signal) {
      signal.addEventListener("abort", () => {
        pendingPrompts.delete(promptId);
        if (prompt.timeout) clearTimeout(prompt.timeout);
        resolve(undefined);
      });
    }

    pendingPrompts.set(promptId, prompt);
  });
}

// --- Notify Handler ---

function handleNotify(
  deps: TelegramUIBridgeDeps,
  message: string,
  type?: "info" | "warning" | "error",
): void {
  const chatId = deps.getActiveChatId();
  if (chatId === undefined) return;

  const icon = type === "error" ? "❌" : type === "warning" ? "⚠️" : "ℹ️";
  deps.sendMessage(chatId, `${icon} ${message}`).catch(() => {});
}

// --- Status Handler ---

function handleSetStatus(_key: string, _text: string | undefined): void {
  // Could update bot status or ignore for now
}

// --- Callback Query Handler ---

export function handleUICallbackQuery(
  callbackQueryId: string,
  data: string,
  deps?: TelegramUIBridgeDeps,
): boolean {
  // Parse callback data: ui:{promptId}:{value}
  const match = data.match(/^ui:([^:]+):(.+)$/);
  if (!match) return false;

  const [, promptId, value] = match;
  const prompt = pendingPrompts.get(promptId);
  if (!prompt) return false;

  // Handle multiSelect toggle/done separately
  if (prompt.type === "multiSelect") {
    return handleMultiSelectCallback(prompt, value, deps);
  }

  // Clean up for single-select/confirm
  if (prompt.timeout) clearTimeout(prompt.timeout);
  pendingPrompts.delete(promptId);

  // Resolve based on type
  switch (prompt.type) {
    case "select": {
      const index = parseInt(value, 10);
      const selected = prompt.options?.[index];
      prompt.resolve(selected);
      break;
    }
    case "confirm": {
      prompt.resolve(value === "yes");
      break;
    }
    default:
      prompt.resolve(value);
  }

  return true;
}

// --- Multi-Select Callback Handler ---

function handleMultiSelectCallback(
  prompt: PendingUIPrompt,
  value: string,
  deps?: TelegramUIBridgeDeps,
): boolean {
  // Toggle: ui:{promptId}:toggle:{index}
  if (value.startsWith("toggle:")) {
    const index = parseInt(value.split(":")[1], 10);
    if (!prompt.selectedIndices) prompt.selectedIndices = new Set();
    
    if (prompt.selectedIndices.has(index)) {
      prompt.selectedIndices.delete(index);
    } else {
      prompt.selectedIndices.add(index);
    }
    
    // Update the message to reflect selection
    if (deps && prompt.messageId) {
      const optionsList = (prompt.options ?? [])
        .map((opt, i) => `${prompt.selectedIndices?.has(i) ? "✅" : "⬜"} ${opt}`)
        .join("\n");
      const messageText = `<b>${escapeHtml("Select options")}</b>\n\n${escapeHtml(optionsList)}\n\n_Select multiple options, then tap Done_`;
      
      const keyboard = buildMultiSelectKeyboard(prompt);
      deps.editMessage?.(prompt.chatId, prompt.messageId, messageText, {
        replyMarkup: keyboard,
        parseMode: "HTML",
      }).catch(() => {});
    }
    
    // Don't resolve yet, keep prompt active
    return true;
  }
  
  // Done: ui:{promptId}:done
  if (value === "done") {
    if (prompt.timeout) clearTimeout(prompt.timeout);
    
    // Resolve with selected options
    const selected = (prompt.selectedIndices ?? new Set());
    const result = (prompt.options ?? []).filter((_, i) => selected.has(i));
    prompt.resolve(result);
    pendingPrompts.delete(prompt.id);
    return true;
  }
  
  return false;
}

function buildMultiSelectKeyboard(prompt: PendingUIPrompt): unknown {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  
  for (let i = 0; i < (prompt.options ?? []).length; i++) {
    const isSelected = prompt.selectedIndices?.has(i) ?? false;
    const prefix = isSelected ? "✅" : "⬜";
    const opt = prompt.options?.[i] ?? "";
    const truncated = opt.length > 40 ? `${opt.slice(0, 37)}...` : opt;
    rows.push([
      { text: `${prefix} ${truncated}`, callback_data: `ui:${prompt.id}:toggle:${i}` },
    ]);
  }
  
  rows.push([
    { text: "✔️ Done", callback_data: `ui:${prompt.id}:done` },
  ]);
  
  return { inline_keyboard: rows };
}

// --- Reply Handler (for input prompts) ---

export function handleUIReply(
  chatId: number,
  replyToMessageId: number | undefined,
  text: string,
): boolean {
  // Find pending input prompt for this chat
  for (const [id, prompt] of pendingPrompts) {
    if (
      prompt.type === "input" &&
      prompt.chatId === chatId &&
      prompt.messageId === replyToMessageId
    ) {
      // Clean up
      if (prompt.timeout) clearTimeout(prompt.timeout);
      pendingPrompts.delete(id);

      // Resolve with text
      prompt.resolve(text);
      return true;
    }
  }

  return false;
}

// --- Utilities ---

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function hasPendingUIPrompt(): boolean {
  return pendingPrompts.size > 0;
}

// --- Tool Interception ---

/**
 * Intercept tools that use ctx.ui and redirect to Telegram.
 *
 * This function is called from tool_call event handler.
 * It checks if the tool is one that uses ctx.ui (like ask_user_question)
 * and handles it via Telegram instead.
 *
 * Returns: { intercepted: true, result } if handled, null otherwise
 */
export async function interceptToolForTelegram(
  toolName: string,
  toolInput: Record<string, unknown>,
  deps: TelegramUIBridgeDeps,
): Promise<{ intercepted: boolean; result?: unknown }> {
  // Only intercept specific tools that use ctx.ui
  if (toolName !== "ask_user_question") {
    return { intercepted: false };
  }

  const chatId = deps.getActiveChatId();
  if (chatId === undefined) {
    return { intercepted: false };
  }

  // Parse the question from tool input
  const questions = toolInput.questions as Array<{
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }> | undefined;

  if (!questions || questions.length === 0) {
    return { intercepted: false };
  }

  // Handle first question (simplified for now)
  const q = questions[0];
  const options = q.options?.map((o) => o.label) ?? ["Yes", "No"];

  // Send question to Telegram with buttons
  const promptId = `tool-${++promptCounter}`;
  const truncatedOptions = options.map((opt) =>
    opt.length > 50 ? `${opt.slice(0, 47)}...` : opt,
  );

  const inlineKeyboard = {
    inline_keyboard: truncatedOptions.map((opt, i) => [
      { text: opt, callback_data: `ui:${promptId}:${i}` },
    ]),
  };

  const messageId = await deps.sendMessage(
    chatId,
    `<b>${escapeHtml(q.header ?? q.question)}</b>\n\n${escapeHtml(q.question)}`,
    {
      replyMarkup: inlineKeyboard,
      parseMode: "HTML",
    },
  );

  // Wait for response
  const result = await new Promise<unknown>((resolve, reject) => {
    const prompt: PendingUIPrompt = {
      id: promptId,
      type: "select",
      chatId,
      messageId,
      resolve: resolve as (value: unknown) => void,
      reject,
      options,
      createdAt: Date.now(),
    };

    // Timeout after 5 minutes
    prompt.timeout = setTimeout(() => {
      pendingPrompts.delete(promptId);
      resolve(undefined);
    }, 5 * 60 * 1000);

    pendingPrompts.set(promptId, prompt);
  });

  if (result === undefined) {
    return { intercepted: true, result: "No response provided" };
  }

  // Return formatted result
  return {
    intercepted: true,
    result: `User selected: ${options[result as number] ?? result}`,
  };
}
