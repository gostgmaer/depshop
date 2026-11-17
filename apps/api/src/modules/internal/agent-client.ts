/** Minimal client for the Python agent's internal API (cancellation only). */
export function agentCanceller(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch) {
  return async (executionId: string): Promise<void> => {
    const res = await fetchImpl(
      `${baseUrl.replace(/\/+$/, "")}/internal/agent/search/${encodeURIComponent(executionId)}/cancel`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
      },
    );
    // 404: the execution already finished or never started on this instance.
    if (!res.ok && res.status !== 404) throw new Error(`Agent cancel failed: HTTP ${res.status}`);
  };
}
