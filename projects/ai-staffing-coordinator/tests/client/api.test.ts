import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../src/client/api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("client API", () => {
  it("sends cookie-authenticated login requests and unwraps the user", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      user: { id: "u1", name: "Alex Rivera", email: "alex@example.com", role: "admin" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.login("alex@example.com", "secret")).resolves.toMatchObject({ id: "u1" });
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/login", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ email: "alex@example.com", password: "secret" }),
    }));
  });

  it("maps worker filters to the server query contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ workers: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await api.workers({ search: "CNA", status: "active" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workers?search=CNA&status=active",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("normalizes assignment names returned as first and last name columns", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      assignments: [{
        id: "a1",
        workerId: "w1",
        firstName: "Maya",
        lastName: "Thompson",
        shiftId: "s1",
        shiftRole: "CNA",
        shiftStartsAt: "2026-08-01T12:00:00.000Z",
        status: "accepted",
        acceptedAt: null,
        declineReason: null,
      }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const assignments = await api.assignments();
    expect(assignments[0]?.workerName).toBe("Maya Thompson");
  });

  it("runs the server-owned safe demo scenario as a single request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      simulation: { callId: "call-1", status: "completed", message: "Accepted" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.simulate({ workerId: "worker-1", shiftId: "shift-1", response: "accept" }))
      .resolves.toMatchObject({ callId: "call-1", status: "completed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/demo/simulate", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ workerId: "worker-1", shiftId: "shift-1", response: "accept" }),
    }));
  });
});
