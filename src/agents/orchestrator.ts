/**
 * Runs the Orchestrator (with its specialist subagents) via the Claude Agent SDK.
 * Built-in Claude Code tools (Bash, file edits, web) are disabled: the agents can only use The Liwan's MCP tools
 * and delegate to each other. Anything not on the allow-list is denied ('dontAsk').
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import type { DB } from "../db/index.js";
import { AGENTS, ORCHESTRATOR_PROMPT, ORCHESTRATOR_TOOLS } from "./definitions.js";
import { createLiwanMcpServer, SERVER_NAME } from "./tools.js";

export interface AgentRunResult { text: string; costUsd: number | null; turns: number }

export async function runOrchestrator(db: DB, prompt: string, kind = "ask", opts: { verbose?: boolean } = {}): Promise<AgentRunResult> {
  if (!config.anthropicKeyPresent) throw new Error("ANTHROPIC_API_KEY is not set — add it to .env to use the agents.");
  const runId = Number(db.prepare("INSERT INTO agent_runs (kind, prompt, started_at) VALUES (?, ?, ?)").run(kind, prompt, new Date().toISOString()).lastInsertRowid);

  const subagentTools = Object.values(AGENTS).flatMap((a) => a.tools ?? []);
  const allowed = [...new Set(["Agent", ...ORCHESTRATOR_TOOLS, ...subagentTools])];

  try {
    let result: AgentRunResult | null = null;
    for await (const msg of query({
      prompt,
      options: {
        model: config.model,
        systemPrompt: ORCHESTRATOR_PROMPT,
        agents: AGENTS,
        mcpServers: { [SERVER_NAME]: createLiwanMcpServer(db) },
        tools: ["Agent"],
        allowedTools: allowed,
        permissionMode: "dontAsk",
        settingSources: [],
        maxTurns: 25,
      },
    })) {
      if (opts.verbose && msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "tool_use") console.error(`  → ${block.name} ${JSON.stringify(block.input)}`);
        }
      }
      if (msg.type === "result") {
        if (msg.subtype !== "success") throw new Error(`Agent run ended: ${msg.subtype}`);
        result = { text: msg.result, costUsd: msg.total_cost_usd, turns: msg.num_turns };
      }
    }
    if (!result) throw new Error("Agent returned no result");
    db.prepare("UPDATE agent_runs SET output = ?, cost_usd = ?, finished_at = ? WHERE id = ?").run(result.text, result.costUsd, new Date().toISOString(), runId);
    return result;
  } catch (e) {
    db.prepare("UPDATE agent_runs SET error = ?, finished_at = ? WHERE id = ?").run((e as Error).message, new Date().toISOString(), runId);
    throw e;
  }
}
