/** Phase 7.1 UI: data download link and the guarded account-deletion form. */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  DELETE_CONFIRMATION,
  DeleteAccountCard,
  ExportDataCard,
} from "@/app/(dashboard)/settings/privacy/privacy-forms";
import * as apiModule from "@/lib/api";
import { renderWithQuery } from "./render";
import { navigation } from "./setup";

describe("privacy settings", () => {
  it("links the export through the same-origin API proxy", () => {
    renderWithQuery(<ExportDataCard />);
    expect(screen.getByRole("link", { name: /Download my data/ })).toHaveAttribute(
      "href",
      "/api/v1/users/me/export",
    );
  });

  it("enables deletion only after the password and the exact confirmation, then signs out", async () => {
    const api = vi.spyOn(apiModule, "api").mockResolvedValue(null);
    renderWithQuery(<DeleteAccountCard />);
    const button = screen.getByRole("button", { name: /Delete my account/ });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Password"), "Correct-horse-42!");
    await userEvent.type(screen.getByLabelText(/Type DELETE MY ACCOUNT/), "delete my account");
    expect(button).toBeDisabled(); // case matters
    await userEvent.clear(screen.getByLabelText(/Type DELETE MY ACCOUNT/));
    await userEvent.type(screen.getByLabelText(/Type DELETE MY ACCOUNT/), DELETE_CONFIRMATION);
    await userEvent.click(button);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("POST", "/users/me/delete", {
        password: "Correct-horse-42!",
        confirm: DELETE_CONFIRMATION,
      }),
    );
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/login?deleted=1"));
  });
});
