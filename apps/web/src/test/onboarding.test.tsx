/** Prompt 25 Stage 4: first-time introduction (docs/onboarding-flow.md). */
import type { PublicUser } from "@dealmind/shared";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ONBOARDING_STEPS, OnboardingPanel } from "@/components/onboarding/onboarding-panel";
import type * as ApiModule from "@/lib/api";
import { ME_KEY } from "@/lib/auth-hooks";
import { renderWithQuery } from "./render";
import { navigation } from "./setup";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof ApiModule>()),
  api: apiMock,
}));

const NEW_USER: PublicUser = {
  id: "60000000-0000-7000-8000-000000000010",
  email: "neha@example.com",
  name: "Neha",
  role: "USER",
  emailVerified: true,
  onboardingCompleted: false,
  createdAt: "2026-11-18T00:00:00.000Z",
};

function renderPanel(user: PublicUser) {
  apiMock.mockImplementation(async (method: string, path: string, body?: { outcome: string }) => {
    if (method === "GET" && path === "/auth/me") return { user };
    if (method === "POST" && path === "/users/me/onboarding")
      return { user: { ...user, onboardingCompleted: true, _outcome: body?.outcome } };
    throw new Error(`unexpected ${method} ${path}`);
  });
  const r = renderWithQuery(<OnboardingPanel />);
  r.client.setQueryData(ME_KEY, user);
  return r;
}

const postedOutcomes = () =>
  apiMock.mock.calls
    .filter(([m, p]) => m === "POST" && p === "/users/me/onboarding")
    .map(([, , b]) => (b as { outcome: string }).outcome);

beforeEach(() => {
  navigation.search = new URLSearchParams();
});

describe("onboarding panel", () => {
  it("walks a new user through every step and records 'completed' once", async () => {
    const user = userEvent.setup();
    renderPanel(NEW_USER);
    expect(await screen.findByRole("heading", { name: ONBOARDING_STEPS[0].title })).toBeVisible();
    expect(screen.getByText(/step 1 of 5/i)).toBeVisible();
    expect(screen.getByRole("list", { name: "Example searches" })).toBeVisible();

    for (let i = 1; i < ONBOARDING_STEPS.length; i++) {
      await user.click(screen.getByRole("button", { name: "Next" }));
      expect(screen.getByRole("heading", { name: ONBOARDING_STEPS[i]!.title })).toHaveFocus();
    }
    expect(screen.getByRole("link", { name: /preferred brands/i })).toHaveAttribute(
      "href",
      "/settings/profile",
    );
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(postedOutcomes()).toEqual(["completed"]));
    expect(screen.queryByRole("heading", { name: ONBOARDING_STEPS[4].title })).toBeNull();
  });

  it("can be skipped from any step, recording 'skipped'", async () => {
    const user = userEvent.setup();
    renderPanel(NEW_USER);
    await user.click(await screen.findByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Skip introduction" }));
    await waitFor(() => expect(postedOutcomes()).toEqual(["skipped"]));
    expect(screen.queryByText(/step \d of 5/i)).toBeNull();
  });

  it("has a Back button after the first step", async () => {
    const user = userEvent.setup();
    renderPanel(NEW_USER);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: ONBOARDING_STEPS[0].title })).toBeVisible();
  });

  it("is never shown again once completed", () => {
    renderPanel({ ...NEW_USER, onboardingCompleted: true });
    expect(screen.queryByText(/getting started/i)).toBeNull();
  });

  it("can be reopened from Settings (?tour=1) without recording anything", async () => {
    const user = userEvent.setup();
    navigation.search = new URLSearchParams("tour=1");
    renderPanel({ ...NEW_USER, onboardingCompleted: true });
    expect(await screen.findByText(/step 1 of 5/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Skip introduction" }));
    expect(postedOutcomes()).toEqual([]);
    expect(navigation.replace).toHaveBeenCalledWith("/dashboard");
  });

  it("asks for no personal information", () => {
    renderPanel(NEW_USER);
    expect(document.querySelectorAll("input, select, textarea")).toHaveLength(0);
  });
});
