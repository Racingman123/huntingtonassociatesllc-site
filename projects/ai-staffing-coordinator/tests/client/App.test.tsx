// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { App } from "../../src/client/App";
import { api, ApiClientError } from "../../src/client/api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("application authentication shell", () => {
  it("loads the dashboard directly and hides logout for a public demo identity", async () => {
    vi.spyOn(api, "me").mockResolvedValue({
      id: "public-demo",
      name: "Portfolio Demo",
      email: "demo@relay.example",
      role: "scheduler",
      publicDemo: true,
    });
    vi.spyOn(api, "dashboard").mockReturnValue(new Promise(() => undefined));

    render(<MemoryRouter initialEntries={["/login"]}><App /></MemoryRouter>);

    expect(await screen.findByLabelText("Public demo session")).toBeTruthy();
    expect(screen.queryByText("Welcome back")).toBeNull();
    expect(screen.queryByRole("button", { name: /sign out/i })).toBeNull();
    expect(screen.getByText("Public demo")).toBeTruthy();
  });

  it("preserves the login screen when normal authentication has no session", async () => {
    vi.spyOn(api, "me").mockRejectedValue(new ApiClientError("Authentication required", 401));

    render(<MemoryRouter initialEntries={["/"]}><App /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText("Welcome back")).toBeTruthy());
    expect(screen.getByRole("button", { name: /sign in/i })).toBeTruthy();
  });
});
