# stupid-pi-providers

questionable model providers for the [pi coding agent](https://github.com/earendil-works/pi-mono) for when you're broke and can't afford an AI sub

## tiptap

Uses the chat endpoint behind Tiptap's public AI Toolkit demo (`template.tiptap.dev/api/chat`) as a pi model.

That endpoint is a Vercel AI SDK UI-message stream with its own document tools built in (`tiptapRead`, `tiptapEdit`, ...), and the model really wants to call them. So the provider:

- sends pi's system prompt and tool list in the `schemaAwareness` field, which the server adds to its system prompt
- repurposes `tiptapEdit` as a generic tool channel: each operation is `{target: <pi tool name>, content: <JSON args>}`
- sends tool results back as the `tiptapEdit` output
- answers calls to the other document tools with "disabled" and retries (up to 2 times)
- also parses a plain-text `<tool_call>{"name": ..., "arguments": ...}</tool_call>` format as a fallback

### Usage

```bash
pi -e ./tiptap --model tiptap/tiptap-chat
```

Or install it globally and pick it with `/model`:

```bash
mkdir -p ~/.pi/agent/extensions/tiptap && cp tiptap/index.ts ~/.pi/agent/extensions/tiptap/
```

In print mode with non-TTY stdin, pi waits on stdin, so add `< /dev/null`.

Set `TIPTAP_DEBUG=/path/to/log` to append raw requests and stream events to a file.

### Limitations

- Text only (images are replaced with a placeholder)
- No token usage reporting
- The 128k context window is a guess
- It's someone else's demo endpoint: it may be rate-limited, changed, or shut off at any time. Don't depend on it.

## ami

Uses "Ami, the About Me Virtual Twin guide": the chat widget at the bottom of the [about.me](https://about.me) landing page (a Vendasta webchat widget, `conversation-prod.apigateway.co`), as a pi model.

That widget is a plain chat. It has no tool calling and no streaming, the server keeps the conversation history, and messages are limited to 1000 characters. So the provider:

- teaches Ami a line protocol: `! <command>` runs a bash command, `> <text>` is shown to you, and any other line is a private note (shown as thinking). Heredocs on a `!` line can span several lines, for writing files.
- turns all `!` lines in one reply into a single pi `bash` tool call, so they run in order
- sends the tool output back as the next chat message (cut to 3000 characters)
- keeps one widget conversation per pi conversation and only sends what's new. If the history doesn't match (a new process, `/tree`, compaction), it starts a new conversation and replays the transcript.
- splits anything over 1000 characters into parts, asks Ami to answer early parts with `.`, and drops those acks
- reads replies the way the widget does: it lists message IDs from the widget's public Firestore collection, then fetches the bodies with `GetMultiWidgetMessages`

### Usage

```bash
pi -e ./ami --model ami/ami
```

Set `AMI_DEBUG=/path/to/log` to append raw requests and replies to a file.

### Limitations

- Text only. No real token usage reporting.
- A reply takes a few seconds and arrives all at once. Polling waits 4 seconds after Ami's last message in case more follow.
- Only bash. Other pi tools (`read`, `edit`, `write`) aren't exposed, because Ami does everything through the shell.
- Ami is a sales-assistant persona with its own system prompt, so it sometimes drifts back to talking about about.me plans.
- It's someone else's support widget: it may be rate-limited, changed, or shut off at any time. Don't depend on it.

## cs50

Uses [CS50's duck debugger](https://cs50.ai/chat) (ddb), the AI tutor for Harvard's CS50 course, as a pi model.

The chat (`POST cs50.ai/api/v1/chat`) takes an OpenAI-style message list and streams back plain text. It has no tool calling, it ignores system messages, and the duck is trained to teach rather than do the work. It won't "run commands", but it happily tells a student which command to type. So the provider:

- introduces you as a CS50 student at a terminal who runs whatever single command the duck puts in a ` ```bash ` block and pastes back the output
- turns that block into a pi `bash` tool call, and sends the output back as the next user message (cut to 8000 characters)
- puts the instructions in the first user message, since system messages are dropped
- splits messages over the server's 10,000-character limit into several user messages (the history itself isn't limited)
- keeps you on the right server: sessions only exist on one backend behind the load balancer and the others answer 403, so it retries without the sticky `AWSALB` cookie until a request lands on the right one, then keeps that cookie

### Usage

The chat needs a logged-in cs50.ai session. Log in at https://cs50.ai/chat with GitHub, open DevTools, and copy the value of the `session` cookie for `cs50.ai`.

```bash
CS50_SESSION=<cookie> pi -e ./cs50 --model cs50/ddb
```

Or keep the cookie in a file:

```bash
CS50_SESSION_FILE=~/.cs50-session pi -e ./cs50 --model cs50/ddb
```

Set `CS50_DEBUG=/path/to/log` to append raw requests and replies to a file. `CS50_CONFIG` picks the server-side config (default `chat_cs50`; `chat_cs50_tf` makes the duck play a student instead).

### Limitations

- Text only. No token usage reporting. The 128k context window is a guess.
- Only bash, one command per turn. Other pi tools (`read`, `edit`, `write`) aren't used.
- It's a tutor: it explores, explains and asks you guiding questions, but it usually won't write the fix for you.
- The cookie is tied to your GitHub account, and the site says conversations are logged. It expires when you log out; then you need a fresh one.
- It's a free service for CS50 students: it may be rate-limited, changed, or shut off at any time. Don't depend on it.
