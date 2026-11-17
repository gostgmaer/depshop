"use client";

import { AI_PROVIDERS, type AiModelConfigView } from "@dealmind/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ShieldCheck } from "lucide-react";
import { useState } from "react";
import {
  HealthBadge,
  QueryState,
  StatGrid,
  StatTile,
  TableWrap,
  num,
  td,
  th,
} from "@/components/admin/admin-ui";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, PageHeader } from "@/components/ui/misc";
import { errorMessage } from "@/lib/auth-hooks";
import { formatDateTime, rupees } from "@/lib/format";
import { admin } from "@/services/admin";

const PROVIDER_LABEL: Record<string, string> = {
  google: "Google Gemini",
  openai: "OpenAI",
  rules: "Rules only (no LLM)",
};
const optInt = (s: string) => (s.trim() === "" ? null : Number(s));

function ConfigForm({ config }: { config: AiModelConfigView }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    provider: config.provider,
    model: config.model,
    temperature: String(config.temperature),
    maxTokens: String(config.maxTokens),
    enabled: config.enabled,
    fallbackProvider: config.fallbackProvider ?? "",
    fallbackModel: config.fallbackModel ?? "",
    monthlyTokenLimit: config.monthlyTokenLimit == null ? "" : String(config.monthlyTokenLimit),
    inputPrice:
      config.inputPaisePerMillionTokens == null ? "" : String(config.inputPaisePerMillionTokens),
    outputPrice:
      config.outputPaisePerMillionTokens == null ? "" : String(config.outputPaisePerMillionTokens),
    reason: "",
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const m = useMutation({
    mutationFn: () =>
      admin.saveAiModels({
        provider: f.provider,
        model: f.provider === "rules" ? "" : f.model.trim(),
        temperature: Number(f.temperature),
        maxTokens: Number(f.maxTokens),
        enabled: f.enabled,
        fallbackProvider: f.fallbackProvider || null,
        fallbackModel: f.fallbackProvider ? f.fallbackModel.trim() || null : null,
        monthlyTokenLimit: optInt(f.monthlyTokenLimit),
        inputPaisePerMillionTokens: optInt(f.inputPrice),
        outputPaisePerMillionTokens: optInt(f.outputPrice),
        reason: f.reason.trim(),
      }),
    onSuccess: (data) => {
      qc.setQueryData(["admin", "ai-models"], data);
      setF((x) => ({ ...x, reason: "" }));
    },
  });
  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <Field label="Provider">
        {(p) => (
          <NativeSelect {...p} value={f.provider} onChange={set("provider")}>
            {AI_PROVIDERS.map((v) => (
              <option key={v} value={v}>
                {PROVIDER_LABEL[v]}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <Field label="Model" hint="The provider's model name, e.g. as listed in its console.">
        {(p) => (
          <Input
            {...p}
            value={f.model}
            onChange={set("model")}
            disabled={f.provider === "rules"}
            maxLength={100}
            required={f.provider !== "rules"}
          />
        )}
      </Field>
      <Field label="Temperature" hint="0–2. Lower is more deterministic.">
        {(p) => (
          <Input
            {...p}
            type="number"
            step="0.05"
            min={0}
            max={2}
            value={f.temperature}
            onChange={set("temperature")}
          />
        )}
      </Field>
      <Field label="Max output tokens" hint="256–200,000">
        {(p) => (
          <Input
            {...p}
            type="number"
            min={256}
            max={200000}
            value={f.maxTokens}
            onChange={set("maxTokens")}
          />
        )}
      </Field>
      <Field label="Fallback provider" hint="Used when the primary fails.">
        {(p) => (
          <NativeSelect {...p} value={f.fallbackProvider} onChange={set("fallbackProvider")}>
            <option value="">None</option>
            {AI_PROVIDERS.map((v) => (
              <option key={v} value={v}>
                {PROVIDER_LABEL[v]}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <Field label="Fallback model">
        {(p) => (
          <Input
            {...p}
            value={f.fallbackModel}
            onChange={set("fallbackModel")}
            disabled={!f.fallbackProvider}
            maxLength={100}
          />
        )}
      </Field>
      <Field
        label="Monthly token budget"
        hint="Empty = no limit. When used up, the agent switches to rules-only."
      >
        {(p) => (
          <Input
            {...p}
            type="number"
            min={1}
            value={f.monthlyTokenLimit}
            onChange={set("monthlyTokenLimit")}
          />
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Input price (paise / 1M tokens)" hint="For the cost estimate.">
          {(p) => (
            <Input {...p} type="number" min={0} value={f.inputPrice} onChange={set("inputPrice")} />
          )}
        </Field>
        <Field label="Output price (paise / 1M tokens)">
          {(p) => (
            <Input
              {...p}
              type="number"
              min={0}
              value={f.outputPrice}
              onChange={set("outputPrice")}
            />
          )}
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input
          type="checkbox"
          className="size-4"
          checked={f.enabled}
          onChange={(e) => setF((x) => ({ ...x, enabled: e.target.checked }))}
        />
        LLM calls enabled (off = rule-based intent extraction only)
      </label>
      <Field label="Reason (recorded in the audit log)" className="sm:col-span-2">
        {(p) => (
          <Input
            {...p}
            required
            minLength={3}
            maxLength={500}
            value={f.reason}
            onChange={set("reason")}
          />
        )}
      </Field>
      {m.error ? (
        <div className="sm:col-span-2">
          <Alert tone="error">{errorMessage(m.error)}</Alert>
        </div>
      ) : m.isSuccess ? (
        <div className="sm:col-span-2">
          <Alert tone="success">Saved. The agent applies it within about a minute.</Alert>
        </div>
      ) : null}
      <div className="sm:col-span-2">
        <Button type="submit" disabled={m.isPending || f.reason.trim().length < 3}>
          {m.isPending ? "Saving…" : "Save configuration"}
        </Button>
      </div>
    </form>
  );
}

export default function AdminAiModelsPage() {
  const q = useQuery({ queryKey: ["admin", "ai-models"], queryFn: admin.aiModels });
  const health = useMutation({ mutationFn: admin.aiHealth });
  return (
    <>
      <PageHeader
        title="AI models"
        description="The LLM the search agent uses to understand queries and write summaries."
        actions={
          <Button variant="outline" disabled={health.isPending} onClick={() => health.mutate()}>
            <Activity aria-hidden className="size-4" />{" "}
            {health.isPending ? "Checking…" : "Check agent"}
          </Button>
        }
      />
      <Alert>
        <span className="flex items-start gap-2">
          <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
          API keys stay in the agent&apos;s server environment and are never stored or shown here.
          The model never sets prices, discounts or rankings; those come from deterministic
          services.
        </span>
      </Alert>
      {health.data ? (
        <Card className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-medium">Agent</span>
          <HealthBadge value={health.data.status} />
          {health.data.agent ? (
            <span className="text-muted-foreground">
              In use: {health.data.agent.provider ?? "—"} {health.data.agent.model ?? ""}
            </span>
          ) : null}
          {health.data.error ? <span className="text-danger">{health.data.error}</span> : null}
        </Card>
      ) : health.error ? (
        <Alert tone="error">{errorMessage(health.error)}</Alert>
      ) : null}
      <QueryState query={q} label="AI configuration">
        {({ config, usage }) => (
          <>
            <StatGrid>
              <StatTile
                label={`Agent runs (${usage.month})`}
                value={num(usage.runs)}
                hint={`${num(usage.failedRuns)} failed`}
              />
              <StatTile label="Input tokens" value={num(usage.inputTokens)} />
              <StatTile label="Output tokens" value={num(usage.outputTokens)} />
              <StatTile
                label="Estimated cost"
                value={usage.estimatedCostPaise == null ? "—" : rupees(usage.estimatedCostPaise)}
                hint={
                  usage.estimatedCostPaise == null
                    ? "Set token prices to estimate"
                    : "From the prices you entered"
                }
                tone={usage.limitReached ? "warning" : undefined}
              />
            </StatGrid>
            {usage.limitReached ? (
              <Alert tone="warning">
                The monthly token budget is used up: the agent is running rules-only until next
                month or a higher budget.
              </Alert>
            ) : null}
            <div className="grid gap-4 xl:grid-cols-[3fr_2fr]">
              <Card>
                <CardHeader
                  title="Configuration"
                  description={
                    config.stored && config.updatedAt
                      ? `Last changed ${formatDateTime(config.updatedAt)}`
                      : "Not set yet: the agent uses its environment defaults."
                  }
                />
                <ConfigForm key={config.updatedAt ?? "default"} config={config} />
              </Card>
              <Card>
                <CardHeader title="Usage by model this month" />
                {usage.byModel.length ? (
                  <TableWrap label="Usage by model">
                    <table className="w-full text-sm">
                      <thead>
                        <tr>
                          <th scope="col" className={th}>
                            Model
                          </th>
                          <th scope="col" className={`${th} text-right`}>
                            Runs
                          </th>
                          <th scope="col" className={`${th} text-right`}>
                            Tokens in / out
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {usage.byModel.map((r) => (
                          <tr key={`${r.provider}:${r.model}`} className="border-t border-border">
                            <td className={td}>
                              {r.model}
                              <p className="text-xs text-muted-foreground">{r.provider}</p>
                            </td>
                            <td className={`${td} text-right tabular`}>{num(r.runs)}</td>
                            <td className={`${td} text-right tabular whitespace-nowrap`}>
                              {num(r.inputTokens)} / {num(r.outputTokens)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                ) : (
                  <p className="text-sm text-muted-foreground">No agent runs this month.</p>
                )}
              </Card>
            </div>
          </>
        )}
      </QueryState>
    </>
  );
}
