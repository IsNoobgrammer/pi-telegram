# Telegram Bridge Architecture

## Overview

`pi-telegram` is a session-local π extension that binds one Telegram DM to one running π session. The bridge owns four main responsibilities:

- Poll Telegram updates and enforce single-user pairing
- Translate Telegram messages and media into π inputs
- Stream and deliver π responses back to Telegram
- Manage Telegram-specific controls such as queue reactions, π prompt-template commands, `/start` application menu sections, `/compact`, `/next`, `/abort`, and `/stop`

## Runtime Structure

`index.ts` remains the extension entrypoint and composition root. Reusable runtime logic is split into flat domain files under `/lib` rather than into a deep local module tree.

Architecture shorthand: this repository uses a `Flat Domain DAG`: cohesive bridge domains live as flat `/lib/*.ts` modules, local imports must form a directed acyclic graph, shared buckets are avoided, and `index.ts` wires live π/Telegram ports plus session state. Source-module opening comments include `Zones:` tags such as `telegram`, `pi agent`, `tui`, or `shared utils` so cross-cutting responsibility areas stay visible without folder nesting.

Domain grouping rule: prefer cohesive domain files over atomizing every helper into its own file. A `shared` domain is allowed only for types or constants that genuinely span multiple bridge domains.

Interface consistency rule: when two modules mean the same runtime entity, they should converge on the owning domain's exported contract. Local structural `*Like` or view contracts are appropriate only when a domain intentionally needs a narrow projection to avoid unnecessary coupling; they should not become duplicate source-of-truth shapes for the same entity.

Naming rule: because the repository already scopes this codebase to Telegram, extracted module and test filenames use bare domain names such as `api.ts`, `queue.ts`, `updates.ts`, and `queue.test.ts` rather than repeating `telegram-*` in every filename.

Current runtime areas use these ownership boundaries:

- `index.ts`: single composition root for live π/Telegram ports, session state, API-bound transport adapters, and status updates.
- `api`: Bot API transport shapes/helpers, retries, file download, temp-dir lifecycle, inbound limits, chat actions, lazy bot-token clients, runtime error recording, and the `TELEGRAM_API_BASE` constant for the Bot API endpoint.
- `config` / `setup`: persisted bot/session pairing state, authorization, first-user pairing, token prompting, env fallback, validation, and config persistence.
- `locks` / `polling`: singleton `locks.json` ownership, takeover/restart semantics, long-poll controller state, update offset persistence, and poll-loop runtime wiring.
- `updates` / `routing`: update classification/execution planning, paired authorization, reactions, edits, callbacks, and inbound route composition.
- `media` / `text-groups` / `time-injection` / `turns` / `inbound-handlers`: text/media extraction, media-group debounce, long-text split coalescing, optional per-chat wall-clock prompt context, inbound downloads, configured and programmatic inbound text/media handler execution, turn building/editing, image reads, and legacy `attachmentHandlers` compatibility.
- `queue`: queue item contracts, lane admission/order, stores, mutations, dispatch readiness/runtime, prompt/control enqueueing, and session/agent/tool lifecycle sequencing.
- `runtime`: session-local coordination primitives: counters, lifecycle flags, setup guard, abort handler, typing-loop timers, prompt-dispatch flags, and agent-end reset binding.
- `model` / `menu-model` / `menu-thinking` / `menu-status` / `menu` / `menu-queue` / `menu-settings` / `commands`: model identity/thinking levels, scoped model resolution, in-flight switching, model/thinking/status/queue/settings menu UI, inline application callback composition, slash commands, and bot command registration.
- `extension-sections`: structured external Telegram menu sections registered by ordinary pi extensions; owns section registry, compact section callback tokens, section render/callback dispatch, safe section runtime ports, and diagnostics.
- `keyboard`: shared Telegram inline-keyboard reply-markup structure; feature domains own callback semantics and button construction.
- `preview` / `replies` / `rendering`: preview lifecycle/transports, final reply delivery and reply parameters, Telegram HTML Markdown rendering, chunking, and stable-preview snapshots.
- `outbound-handlers`: outbound text transformation, assistant-authored outbound comments, generated reply artifacts, inline-keyboard callbacks, and post-`agent_end` outbound action delivery.
- `outbound-attachments`: `telegram_attach` registration, outbound attachment queueing, stat/limit checks, and photo/document delivery classification.
- `status`: status-bar/status-message rendering, queue-lane status views, redacted runtime event ring, and grouped π diagnostics.
- `lifecycle` / `prompts` / `prompt-templates` / `pi`: π hook registration, Telegram-specific before-agent prompt injection, π prompt-template discovery/expansion, and centralized direct pi SDK imports/context adapters.
- `command-templates`: portable shell-free command-template standard helpers, composition expansion, placeholder substitution, and executable resolution.

Boundary invariants:

- Constants and state types live with their owning domains; do not reintroduce shared buckets such as `lib/constants.ts` or `lib/types.ts`
- Shared Telegram inline-keyboard structure belongs to `keyboard`; application-control labels, callback data, and callback behavior stay in `menu`/`menu-model`/`menu-thinking`/`menu-status`/`menu-queue`; external section labels, callbacks, and dispatch stay in `extension-sections`; core queue mechanics stay in `queue`
- Domain helpers use narrow structural projections when that avoids importing concrete wire DTOs or broader runtime objects unnecessarily
- Preview appearance stays in `rendering`; preview transport/lifecycle stays in `preview`
- Direct `node:*` file-operation imports stay in owning domains, not in `index.ts`
- `index.ts` uses namespace imports for local bridge domains so orchestration reads as `Queue.*`, `Turns.*`, and `Rendering.*`
- Architecture-invariant tests guard the acyclic import graph, pi SDK centralization, entrypoint purity, runtime-domain isolation, structural leaf-domain isolation, menu/model boundaries, API/config separation, media/update/API separation, and outbound-attachment boundary isolation
- Mirrored domain regression coverage lives in `/tests/*.test.ts`; test helpers stay local to the mirrored suite by default, and shared fixture folders are justified only by reuse across multiple domain suites

## Configuration UX

`/telegram-setup` uses a progressive-enhancement flow for the bot token prompt:

1. Show the locally saved token from `~/.pi/agent/telegram.json` when one already exists
2. Otherwise use the first configured environment variable from the supported Telegram token list
3. Fall back to the example placeholder when no real value exists

Because `ctx.ui.input()` only exposes placeholder text, the bridge uses `ctx.ui.editor()` whenever a real default value must appear already filled in. The persisted `telegram.json` config is written through a private temp file plus atomic rename, then left with `0600` permissions because it contains the bot token.

## Runtime Ownership

Telegram bot configuration stays in `~/.pi/agent/telegram.json`. Singleton runtime ownership lives separately in `~/.pi/agent/locks.json` under `@llblab/pi-telegram`.

Ownership lifecycle:

- `/telegram-connect` acquires or moves the singleton lock before polling starts.
- `/telegram-disconnect` stops polling and releases the lock.
- Session start resumes polling when the existing lock already points at the current `pid`/`cwd`.
- After a full π process restart, session start may replace a stale lock from the same `cwd` and resume polling automatically.
- Session start does not create new ownership from an inactive lock, a live external lock, or a stale lock from another directory.
- Session replacement suspends polling and ownership watchers without releasing the lock, allowing the next session-start hook in the same `pid`/`cwd` to resume from explicit ownership.
- When a live external owner exists, `/telegram-connect` asks whether to move singleton ownership to the current π instance.

Active owners poll the lock through a snapshotted ownership context. Long-lived timers therefore avoid stale π contexts after `/new`; they stop local polling when `locks.json` no longer points at their own `pid`/`cwd`, without deleting the new owner lock. Deleting `locks.json` resets runtime ownership without deleting Telegram configuration.

## Message And Queue Flow

### Inbound Path

1. Telegram updates are polled through `getUpdates`
2. Each update offset is persisted only after the update handler succeeds; repeated handler failures are bounded so one poisoned update cannot stall polling forever
3. The bridge filters to the paired private user
4. Media groups are coalesced into a single Telegram turn when needed
5. Slash command parsing uses only the new message text/caption, while Telegram `reply_to_message` text/caption is injected later as prompt-only `[reply]` context for normal queued turns
6. Files are streamed into `~/.pi/agent/tmp/telegram` with a default 50 MiB size limit, partial-download cleanup on failures, and stale temp cleanup on session start; operators can tune the limit with `PI_TELEGRAM_INBOUND_FILE_MAX_BYTES` or `TELEGRAM_MAX_FILE_SIZE_BYTES`
7. Configured inbound handlers may run on raw text or downloaded files by MIME wildcard, Telegram attachment type, or generic match selector; command templates receive safe command-arg substitution for `{text}`, `{file}`, `{mime}`, and `{type}` where applicable
8. Matching media/file handlers are tried in config order: a non-zero exit records diagnostics and falls back to the next matching handler, while the first successful handler stops the chain
9. Local attachments stay visible under `[attachments] <directory>` with relative file entries, and handler stdout is appended under `[outputs]` before the agent sees the turn; failed handlers omit output while keeping the attachment entry
10. Optional `time` config may add a compact final `[time]` prompt line after attachment/output/voice sections, either every turn or per-chat after the configured millisecond interval, using the system timezone
11. A `PendingTelegramTurn` is created and queued locally
12. Telegram `edited_message` updates are routed separately and update a matching queued turn when the original message has not been dispatched yet
13. The queue dispatcher sends the turn into π only when dispatch is safe

### Queue Safety Model

The bridge keeps its own Telegram queue and does not rely only on π's internal pending-message state.

Queued items now use two explicit dimensions:

- `kind`: prompt vs control
- `queueLane`: control vs priority vs default

Admission contract:

- Immediate execution: `/compact`, `/queue`, `/stop`, `/help`, and `/start` do not enter the Telegram queue. `/help` opens the same menu as `/start`; `/stop` also clears queued items. Dispatch rank: N/A.
- Queued prompt command: `/continue` enqueues a priority Telegram-owned `continue` prompt. Prompt-template commands such as `/template_name args` expand the matching π template before entering the normal prompt queue. Dispatch rank: priority for `/continue`, otherwise default.
- Control queue: model-switch continuation turns and future deferred controls use `queueLane: control`, accept control items and continuation prompts, and dispatch at rank `0`.
- Priority prompt queue: a waiting prompt promoted by `👍`, `⚡️`, `❤️`, `🕊`, or `🔥` uses `kind: prompt`, `queueLane: priority`, and dispatches at rank `1`.
- Default prompt queue: normal Telegram text/media turns use `kind: prompt`, `queueLane: default`, and dispatch at rank `2`.

The command action itself carries its execution mode. The queue domain exposes lane contracts for admission mode, dispatch rank, and allowed item kinds.

Queue validation rules:

- Queue append and planning paths validate lane admission.
- Malformed control/default or other invalid lane pairings fail predictably instead of silently changing priority.
- Synthetic control actions and Telegram prompts share one stable ordering model while still rendering distinctly in status output.

Status rendering rules:

- Busy labels distinguish `active`, `dispatching`, `queued`, `tool running`, `model`, and `compacting`.
- Priority prompts and priority control items are marked with `⚡`.
- If a queue mutation removes the last waiting item while Telegram-owned work still has running tools, the status remains yellow `active` instead of degrading to green `connected`.

A dispatched prompt remains in the queue until `agent_start` consumes it. That keeps the active Telegram turn bound correctly for previews, attachments, abort handling, and final reply delivery.

Dispatch is gated by:

- No active Telegram turn
- No pending Telegram dispatch already sent to π
- No compaction in progress
- `ctx.isIdle()` being true
- `ctx.hasPendingMessages()` being false

These gates prevent queue races around rapid follow-ups, `/compact`, and mixed local plus Telegram activity.

Post-agent-end dispatch retries use a session-bound deferred dispatcher:

- It activates on session start.
- It cancels timers on session shutdown.
- It skips callbacks from older generations before they touch `ExtensionContext`.

Telegram `/start` and hidden compatibility shortcuts `/status`, `/model`, `/thinking`, `/queue`, and `/settings` execute immediately. The dispatch controller still serializes deferred control items so a queued control action must settle before the next queued action can dispatch.

### Application Menu Shape

`/start` opens the main application menu. It contains visible command help, compact command-only prompt-template rows when π exposes Telegram-compatible prompt-template names, status rows (`Status`, `Usage`, `Cost`, `Context`), and top-level buttons for model, thinking, and queue sections.

Menu rules:

- The `Status` row reports `compacting` while a Telegram `/compact` run is active, and the bridge sends Telegram's native `typing` chat action as a keepalive for the same compaction window.
- The Queue button includes the current queued-item count.
- Hidden compatibility shortcuts `/help`, `/status`, `/model`, `/thinking`, and `/queue` jump directly to their corresponding menu screens.
- `/settings` opens the hidden settings menu for bridge toggles such as proactive push, voice reply mode, and `time.injectionMode`.
- Settings options open detail submenus. Boolean settings use Back plus green/black/yellow `on` and `off` controls; list-like settings such as time injection use explicit mode names like `hidden`, `always`, and `interval`.
- Command emoji come from the `commands` domain map so visible command descriptions and matching menu buttons share one fixed adornment source.
- Prompt-template commands use a fixed `🧩` marker, map π template names to Telegram-safe aliases such as `fix-tests` → `/fix_tests`, stay visible only inside the `/start` menu, and expand before queueing because `ExtensionAPI.sendUserMessage()` bypasses π prompt-template expansion for extension-originated messages.

Navigation and ownership:

- Every submenu starts with a top Back row so navigation stays anchored near the original user message above the inline keyboard.
- Model-menu pagination controls sit near the top; tapping the pagination indicator opens a compact page picker headed by `<b>Choose a page:</b>`.
- Tapping a model opens a detail submenu with Back, ☑️ Activate/🟢 Active selection, and yellow/black-marked Scoped/All membership tabs.
- `model` owns core model identity/switching semantics.
- `menu-model` owns model-menu state, scoped model pages, model detail rendering, scoped-list persistence planning, and model-menu rendering.
- `menu-thinking` owns thinking-menu text, reply markup, callback handling, and message rendering.
- `menu-status` owns status-menu payloads, status callback handling, and status-message rendering.
- `menu-queue` owns queue-menu UI only.

Queue menu rendering:

- Queue items render under a compact `<b>Queue:</b>` heading, top-to-bottom in dispatch order.
- Items are numbered and marked with `⚡` for priority prompts or `📎` for prompts with attachments.
- An empty queue renders bold message text with the bottom-filled `⌛` hourglass plus the top Main menu button.
- Non-empty queue states keep the running `⏳` hourglass.
- Selecting an item opens a submenu with the queue item number, full queued prompt text, Back, side-by-side Priority/Normal tabs, and Cancel.
- If a callback targets an item that has already left the queue, the menu refreshes the list instead of applying a stale mutation.

### Abort Behavior

When `/stop` runs from Telegram, it clears pending model-switch state, clears every waiting Telegram queue item, resets aborted-turn history preservation, and then aborts the active Telegram turn when an abort handler exists. This intentionally favors recovery over preservation: priority/default/control queue items are dropped so the next Telegram message can enter a clean queue and dispatch like a fresh TUI prompt after an interrupted run.

## Rendering Model

Telegram replies are rendered as Telegram HTML rather than raw Markdown.

Key rules:

- Rich text should render cleanly in Telegram chats
- Real code blocks must remain literal and escaped
- Supported absolute HTTP(S) and mailto links should stay clickable, with generated HTML attributes escaped separately from text content, while unsupported link forms such as unresolved references, footnotes, or relative links without a known base should degrade safely instead of producing broken Telegram anchors
- Markdown tables should keep their internal separators but drop the outer left and right borders when rendered as monospace blocks so narrow Telegram clients keep more usable width; table padding should count grapheme/display width for multi-codepoint emoji, combining marks, and wide Unicode where possible, and the Telegram before-agent prompt suffix also asks the assistant to prefer narrow table columns because many chats are read on phone-width screens
- Unordered Markdown lists should render with a monospace `-` marker and ordered Markdown lists should render with monospace numeric markers so list indentation stays more predictable on narrow Telegram clients
- Real Markdown task-list items should render with checkbox markers, while standalone `[x]` and `[ ]` prose should stay literal instead of being reinterpreted as checklists
- Nested Markdown quotes should flatten into one Telegram blockquote with added non-breaking-space indentation because Telegram does not render nested blockquotes reliably
- Original blank-line spacing between Markdown blocks should stay intact in both preview and final rendering instead of being collapsed to one generic block separator, while headings should still keep readable separation from following blocks such as code fences even when source Markdown omits a blank line
- Long replies, including raw HTML-mode replies used by interactive/status flows, must be split below Telegram's 4096-character limit
- Raw HTML chunking lives with the rendering helpers in `/lib/rendering.ts` and should preserve/reopen active tags across chunk boundaries where possible
- Preview rendering uses stable top-level Markdown blocks for rich Telegram HTML and appends the still-growing tail conservatively as readable plain text so the preview stays valid even when the answer is incomplete

The renderer is a Telegram-specific formatter, not a general Markdown engine, so rendering changes should be treated as regression-prone.

## Streaming And Delivery

During generation, the bridge streams previews back to Telegram.

Preferred order:

1. Re-render the current Markdown buffer into a preview snapshot that renders closed top-level blocks as rich Telegram HTML and keeps the unstable tail conservative and readable
2. Send or update that preview through `sendMessage` plus `editMessageText`, because `sendMessageDraft` is text-only for rich previews
3. Serialize overlapping preview flushes so older Telegram edit calls cannot race newer streamed snapshots
4. Replace the preview with the final rendered reply when generation ends

Draft streaming can remain as a plain-text fallback path, but rich Telegram previews are driven through editable messages and stable-block snapshot selection.

### Response Context

Telegram prompt responses use explicit delivery context to attach outbound text, rich previews, errors, attachment notices, and uploads as Telegram replies to the source prompt when possible.

Reply metadata rules:

- Reply metadata is opt-in per delivery path.
- It uses `reply_parameters` with `allow_sending_without_reply: true`.
- It is applied only to the first chunk of split long responses; continuation chunks are sent as normal adjacent messages.
- Media-group turns reply to the turn's representative `replyToMessageId`, not to every source message in the group.

Long text split coalescing is intentionally conservative. Only human text messages at or above the 3600-character near-limit threshold open the short debounce window. Immediate same-chat/user contiguous text tails join that prompt; commands, bot messages, captions, media groups, and normal short follow-ups bypass the coalescer.

### Outbound Files

Outbound files are sent only after the active Telegram turn completes. They must be staged through the `telegram_attach` tool, are staged atomically per tool call, and are checked against a default 50 MiB limit configurable through `PI_TELEGRAM_OUTBOUND_ATTACHMENT_MAX_BYTES` or `TELEGRAM_MAX_ATTACHMENT_SIZE_BYTES`. Delivery uses file-backed multipart blobs so large sends do not require preloading whole files into memory.

### Assistant-Authored Actions

Assistant-authored outbound actions use final-message markup instead of agent tool calls. Preview updates strip closed top-level HTML comments and currently open/partial top-level comment starts before rendering, so users do not see transient metadata even when streaming flushes happen after only `<`, `<!`, or `<!--`.

On `agent_end`, the bridge removes top-level comments from the Markdown text reply, but treats these column-zero top-level blocks specially before delivery:

- `<!-- telegram_voice ... -->`
- `<!-- telegram_button ... -->`

Comments inside fenced code, quotes, lists, or indented examples stay literal, including fenced blocks with Markdown-valid indented closing fences.

Voice delivery uses one fallback pipeline:

1. Configured `outboundHandlers` with `type: "voice"`
2. Programmatic `voice` handlers
3. Registered synthesis providers from `lib/voice.ts`

The bridge extracts body text, `text="..."`, or colon shorthand, asks the pipeline for an `.ogg`/`.opus` artifact, validates native voice format, and uploads the generated file via Telegram `sendVoice`. When delivery fails, the queue runtime records diagnostics and falls back to the planned text reply when no text was already delivered. Synthesis providers own TTS, speech rewriting, transcript choice, and format conversion.

Button blocks are built in. Each `telegram_button` block becomes one inline-keyboard button on the final text, and callback clicks enqueue the configured prompt text as a normal Telegram prompt turn. The `telegram_button: Label` shorthand uses the same text for label and prompt, `prompt="..."` supports explicit one-line prompts, and body-form buttons use the body as the prompt.

Unknown callback data that does not match pi-telegram-owned prefixes (`tgbtn:`, `menu:`, `model:`, `thinking:`, `status:`, `queue:`, `section:`) is forwarded to π as `[callback] <data>` after built-in handlers decline it. Layered callback payloads should follow the [Callback Namespace Standard](./callback-namespaces.md). Structured menu integrations should use the [Telegram Extension Sections Standard](./extension-sections.md) instead of hand-rolled fallback callbacks.

### Proactive Push And Mobile Guidance

When proactive push is enabled, successful local non-Telegram final replies are sent to the paired chat. Local prompt text is not sent because the bot does not own or mirror terminal user messages. This keeps terminal-originated results visible in Telegram without changing Telegram-originated turn delivery.

Technical Markdown, code, tables, formulas, and numbered lists stay in the text channel when appropriate while TTS-friendly voice messages and tappable continuations do not require `telegram_attach` or extra transport tools. Telegram prompt guidance targets about 37 visible cells for tables, dense list items, and compact text blocks because emoji and other wide glyphs make raw character counts misleading on mobile screens.

## Interactive Controls

The bridge exposes Telegram-side session controls in addition to regular chat forwarding. Menu layout details live in [Application Menu Shape](#application-menu-shape); this section summarizes the command/control surface.

Telegram chat controls:

- `/start`: opens the main application menu and runs immediately even while generation is active.
- `/model`, `/thinking`, `/queue`: hidden shortcuts for opening the matching menu sections directly.
- `/compact`: triggers π session compaction when the bridge is idle.
- `/next`: dispatches the next queued turn, aborting the active run first when π is busy.
- `/continue`: enqueues a Telegram-owned priority `continue` prompt without aborting the current turn.
- `/abort`: aborts the active Telegram-owned run while preserving queued items for manual continuation.
- `/stop`: aborts the active Telegram-owned run and clears waiting Telegram queue items.

Pi-side diagnostics and settings:

- `/telegram-status`: renders grouped diagnostics for connection, polling, execution, queue, and the recent redacted runtime/API event ring.
- `/telegram-settings`: exposes π-side bridge settings; currently this includes proactive push backed by the same `telegram.json` flag as the hidden Telegram `/settings` menu.

Queue reactions are shortcut controls for waiting text, voice, file, image, and media-group turns. Matching uses the turn's source Telegram message ids. `👍`, `⚡️`, `❤️`, `🕊`, and `🔥` promote waiting prompts; `👎`, `👻`, `💔`, `💩`, and `🗑` remove waiting turns because ordinary Telegram DM message deletions are not exposed through the Bot API polling path this bridge uses.

The `/telegram-status` event ring records transport/API, polling/update, prompt-dispatch, control-action, typing, compaction, setup, session-lifecycle, and attachment queue/delivery failures. Benign unchanged edit responses and unsupported empty draft-clear attempts are filtered out so expected preview transport noise does not obscure real failures.

## In-Flight Model Switching

When `/model` is used during an active Telegram-owned run, the bridge can emulate the interactive π workflow of stopping, switching model, and continuing.

The current implementation does this by:

1. Applying the newly selected model immediately
2. Queuing or staging a synthetic Telegram continuation turn
3. Aborting the active Telegram turn immediately, or delaying the abort until the current tool finishes when a tool call is in flight
4. Dispatching the continuation turn after the abort completes

This behavior is intentionally limited to runs currently owned by the Telegram bridge. If π is busy with non-Telegram work, the bridge still refuses the switch instead of hijacking unrelated session activity.

## Related

- [README.md](../README.md)
- [Project Context](../AGENTS.md)
- [Project Backlog](../BACKLOG.md)
- [Changelog](../CHANGELOG.md)
