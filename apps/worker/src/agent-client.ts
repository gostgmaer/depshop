/**
 * Client for the Python agent's internal API (apps/agent):
 *   POST /internal/agent/search                    start (idempotent per execution id)
 *   GET  /internal/agent/search/{execution_id}     status
 *   POST /internal/agent/search/{execution_id}/cancel
 * Service-to-service bearer auth; a correlation id travels with every call.
 */
import { z } from "zod";

export const agentExecutionStatus = z.enum([
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "NEEDS_CLARIFICATION",
  "CANCELLED",
]);
export type AgentExecutionStatus = z.infer<typeof agentExecutionStatus>;
export const AGENT_TERMINAL: readonly AgentExecutionStatus[] = [
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "NEEDS_CLARIFICATION",
  "CANCELLED",
];

export const agentStatusSchema = z
  .object({
    execution_id: z.string(),
    status: agentExecutionStatus,
    persisted: z.boolean(),
    error: z.string().nullable().optional(),
  })
  .passthrough();
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export interface StartRequest {
  executionId: string;
  searchId: string;
  userContext: string;
  query: string;
  filters: Record<string, unknown>;
}

export class AgentUnavailableError extends Error {
  override readonly name = "AgentUnavailableError";
}

export class AgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  private async call(
    method: "GET" | "POST",
    path: string,
    correlationId: string,
    body?: unknown,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          "x-correlation-id": correlationId,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new AgentUnavailableError(`Agent service unreachable: ${(err as Error).message}`);
    }
  }

  private async parse(res: Response): Promise<AgentStatus> {
    if (res.status >= 500)
      throw new AgentUnavailableError(`Agent service error: HTTP ${res.status}`);
    if (!res.ok) throw new Error(`Agent rejected the request: HTTP ${res.status}`);
    return agentStatusSchema.parse(await res.json());
  }

  async start(r: StartRequest): Promise<AgentStatus> {
    return this.parse(
      await this.call("POST", "/internal/agent/search", r.executionId, {
        execution_id: r.executionId,
        search_id: r.searchId,
        user_context: r.userContext,
        query: r.query,
        filters: r.filters,
      }),
    );
  }

  /** Null when the agent doesn't know the execution (e.g. it restarted). */
  async status(executionId: string): Promise<AgentStatus | null> {
    const res = await this.call(
      "GET",
      `/internal/agent/search/${encodeURIComponent(executionId)}`,
      executionId,
    );
    if (res.status === 404) return null;
    return this.parse(res);
  }

  async cancel(executionId: string): Promise<void> {
    const res = await this.call(
      "POST",
      `/internal/agent/search/${encodeURIComponent(executionId)}/cancel`,
      executionId,
    );
    if (!res.ok && res.status !== 404)
      throw new AgentUnavailableError(`Agent cancel failed: HTTP ${res.status}`);
  }
}
