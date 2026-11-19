/** First-run admin setup page. */
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SetupForm } from "@/app/(guest)/setup/setup-form";
import { SetupNotice } from "@/components/auth/setup-notice";
import { ApiError } from "@/lib/api";
import * as services from "@/services";
import { renderWithQuery } from "./render";

vi.mock("@/services", () => ({ setup: { status: vi.fn(), claim: vi.fn() } }));
const svc = (services as unknown as { setup: Record<string, ReturnType<typeof vi.fn>> }).setup;

const PASSWORD = "Correct-horse-42!";

async function fill(user: ReturnType<typeof userEvent.setup>, token = "the-setup-token-123") {
  await user.type(await screen.findByLabelText("Setup token"), token);
  await user.type(screen.getByLabelText("Name"), "Site Owner");
  await user.type(screen.getByLabelText("Email"), "owner@example.com");
  await user.type(screen.getByLabelText("Password"), PASSWORD);
  await user.type(screen.getByLabelText("Confirm password"), PASSWORD);
  await user.click(screen.getByRole("button", { name: "Create administrator" }));
}

beforeEach(() => {
  svc.status!.mockResolvedValue({ required: true });
});

describe("first-run setup", () => {
  it("creates the administrator and explains the next step (first sign-in)", async () => {
    const user = userEvent.setup();
    svc.claim!.mockResolvedValue({ email: "owner@example.com", existingAccount: false });
    renderWithQuery(<SetupForm />);
    await fill(user);
    expect(svc.claim).toHaveBeenCalledWith({
      token: "the-setup-token-123",
      name: "Site Owner",
      email: "owner@example.com",
      password: PASSWORD,
    });
    expect(await screen.findByText(/was created/)).toHaveTextContent("owner@example.com");
    expect(screen.getByRole("link", { name: "Go to sign in" })).toHaveAttribute(
      "href",
      "/login?next=%2Fadmin",
    );
  });

  it("warns when the e-mail already had an account (its existing password applies)", async () => {
    const user = userEvent.setup();
    svc.claim!.mockResolvedValue({ email: "owner@example.com", existingAccount: true });
    renderWithQuery(<SetupForm />);
    await fill(user);
    expect(await screen.findByText(/already has an account/)).toHaveTextContent(
      "existing password",
    );
  });

  it("shows the API's refusal for a wrong token", async () => {
    const user = userEvent.setup();
    svc.claim!.mockRejectedValue(new ApiError(403, "FORBIDDEN", "That setup token isn't valid."));
    renderWithQuery(<SetupForm />);
    await fill(user, "wrong-token-000");
    expect(await screen.findByRole("alert")).toHaveTextContent("That setup token isn't valid.");
  });

  it("says setup is complete once an administrator exists (no form)", async () => {
    svc.status!.mockResolvedValue({ required: false });
    renderWithQuery(<SetupForm />);
    expect(await screen.findByText(/Setup is complete/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Setup token")).toBeNull();
  });

  it("the sign-in page notice appears only while setup is required", async () => {
    const { unmount } = renderWithQuery(<SetupNotice />);
    expect(await screen.findByRole("link", { name: /Set up the administrator/ })).toHaveAttribute(
      "href",
      "/setup",
    );
    unmount();
    svc.status!.mockResolvedValue({ required: false });
    renderWithQuery(<SetupNotice />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("link", { name: /Set up the administrator/ })).toBeNull();
  });
});
