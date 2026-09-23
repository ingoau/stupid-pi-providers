# stupid-pi-providers

Questionable model providers for the [pi coding agent](https://github.com/earendil-works/pi-mono).

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
