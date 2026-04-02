export interface TokenUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly total_cost_usd: number;
  readonly num_turns: number;
  readonly duration_ms: number;
}

export type ParsedStreamEvent =
  | { type: "text"; text: string }
  | { type: "result"; result: string; usage: TokenUsage | null }
  | { type: "tool_call"; name: string; args: string };

const shellEscape = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

const extractUsage = (obj: Record<string, unknown>): TokenUsage | null => {
  const usage = obj.usage as Record<string, unknown> | undefined;
  if (
    !usage ||
    typeof usage.input_tokens !== "number" ||
    typeof usage.output_tokens !== "number"
  ) {
    return null;
  }
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_input_tokens:
      typeof usage.cache_read_input_tokens === "number"
        ? usage.cache_read_input_tokens
        : 0,
    cache_creation_input_tokens:
      typeof usage.cache_creation_input_tokens === "number"
        ? usage.cache_creation_input_tokens
        : 0,
    total_cost_usd:
      typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : 0,
    num_turns: typeof obj.num_turns === "number" ? obj.num_turns : 0,
    duration_ms: typeof obj.duration_ms === "number" ? obj.duration_ms : 0,
  };
};

/** Maps allowlisted tool names to the input field containing the display arg */
const TOOL_ARG_FIELDS: Record<string, string> = {
  Bash: "command",
  WebSearch: "query",
  WebFetch: "url",
  Agent: "description",
};

const parseStreamJsonLine = (line: string): ParsedStreamEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);
    if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
      const events: ParsedStreamEvent[] = [];
      const texts: string[] = [];
      for (const block of obj.message.content as {
        type: string;
        text?: string;
        name?: string;
        input?: Record<string, unknown>;
      }[]) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (
          block.type === "tool_use" &&
          typeof block.name === "string" &&
          block.input !== undefined
        ) {
          const argField = TOOL_ARG_FIELDS[block.name];
          if (argField === undefined) continue; // not allowlisted
          const argValue = block.input[argField];
          if (typeof argValue !== "string") continue; // missing/wrong arg field
          if (texts.length > 0) {
            events.push({ type: "text", text: texts.join("") });
            texts.length = 0;
          }
          events.push({
            type: "tool_call",
            name: block.name,
            args: argValue,
          });
        }
      }
      if (texts.length > 0) {
        events.push({ type: "text", text: texts.join("") });
      }
      return events;
    }
    if (obj.type === "result" && typeof obj.result === "string") {
      return [{ type: "result", result: obj.result, usage: extractUsage(obj) }];
    }
  } catch {
    // Not valid JSON — skip
  }
  return [];
};

export interface AgentProvider {
  readonly name: string;
  buildPrintCommand(prompt: string): string;
  buildInteractiveArgs(prompt: string): string[];
  parseStreamLine(line: string): ParsedStreamEvent[];
}

/** Internal scaffolding configuration — not part of the public API. */
export interface AgentScaffoldConfig {
  readonly envManifest: Record<string, string>;
  readonly dockerfileTemplate: string;
}

export const DEFAULT_MODEL = "claude-opus-4-6";

const CLAUDE_CODE_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \\
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\
  && apt-get update && apt-get install -y gh \\
  && rm -rf /var/lib/apt/lists/*

# Create a non-root user for Claude to run as
RUN useradd -m -s /bin/bash agent
USER agent

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at \${SANDBOX_WORKSPACE_DIR}
# and overrides the working directory to \${SANDBOX_WORKSPACE_DIR} at container start.
# Structure your Dockerfile so that \${SANDBOX_WORKSPACE_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

/** Scaffolding config for Claude Code — used by \`init\` and CLI, not part of the runtime AgentProvider. */
export const CLAUDE_CODE_SCAFFOLD_CONFIG: AgentScaffoldConfig = {
  envManifest: {
    ANTHROPIC_API_KEY: "Anthropic API key",
    GH_TOKEN: "GitHub personal access token",
  },
  dockerfileTemplate: CLAUDE_CODE_DOCKERFILE,
};

// ---------------------------------------------------------------------------
// Pi agent provider
// ---------------------------------------------------------------------------

/** Maps allowlisted pi tool names to the input field containing the display arg */
const PI_TOOL_ARG_FIELDS: Record<string, string> = {
  Bash: "command",
  WebSearch: "query",
  WebFetch: "url",
  Agent: "description",
};

const parsePiStreamLine = (line: string): ParsedStreamEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);
    if (obj.type === "message_update" && Array.isArray(obj.content)) {
      const texts: string[] = [];
      for (const block of obj.content as {
        type: string;
        text?: string;
      }[]) {
        if (block.type === "text_delta" && typeof block.text === "string") {
          texts.push(block.text);
        }
      }
      if (texts.length > 0) {
        return [{ type: "text", text: texts.join("") }];
      }
      return [];
    }
    if (obj.type === "tool_execution_start") {
      const toolName = obj.tool_name;
      if (typeof toolName !== "string") return [];
      const argField = PI_TOOL_ARG_FIELDS[toolName];
      if (argField === undefined) return [];
      const input = obj.input as Record<string, unknown> | undefined;
      if (!input) return [];
      const argValue = input[argField];
      if (typeof argValue !== "string") return [];
      return [{ type: "tool_call", name: toolName, args: argValue }];
    }
    if (
      obj.type === "agent_end" &&
      typeof obj.last_assistant_message === "string"
    ) {
      return [
        {
          type: "result",
          result: obj.last_assistant_message,
          usage: extractUsage(obj),
        },
      ];
    }
  } catch {
    // Not valid JSON — skip
  }
  return [];
};

const PI_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \\
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\
  && apt-get update && apt-get install -y gh \\
  && rm -rf /var/lib/apt/lists/*

# Create a non-root user
RUN useradd -m -s /bin/bash agent
USER agent

# Install pi coding agent
RUN npm install -g @mariozechner/pi-coding-agent

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at \${SANDBOX_WORKSPACE_DIR}
# and overrides the working directory to \${SANDBOX_WORKSPACE_DIR} at container start.
# Structure your Dockerfile so that \${SANDBOX_WORKSPACE_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

/** Scaffolding config for pi — used by \`init\` and CLI, not part of the runtime AgentProvider. */
export const PI_SCAFFOLD_CONFIG: AgentScaffoldConfig = {
  envManifest: {
    ANTHROPIC_API_KEY: "Anthropic API key",
    GH_TOKEN: "GitHub personal access token",
  },
  dockerfileTemplate: PI_DOCKERFILE,
};

export const pi = (model: string): AgentProvider => ({
  name: "pi",

  buildPrintCommand(prompt: string): string {
    return `pi -p --mode json --no-session --model ${shellEscape(model)} ${shellEscape(prompt)}`;
  },

  buildInteractiveArgs(_prompt: string): string[] {
    return ["pi", "--model", model];
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parsePiStreamLine(line);
  },
});

// ---------------------------------------------------------------------------
// Claude Code agent provider
// ---------------------------------------------------------------------------

export const claudeCode = (model: string): AgentProvider => ({
  name: "claude-code",

  buildPrintCommand(prompt: string): string {
    return `claude --print --verbose --dangerously-skip-permissions --output-format stream-json --model ${shellEscape(model)} -p ${shellEscape(prompt)}`;
  },

  buildInteractiveArgs(_prompt: string): string[] {
    return ["claude", "--dangerously-skip-permissions", "--model", model];
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parseStreamJsonLine(line);
  },
});
