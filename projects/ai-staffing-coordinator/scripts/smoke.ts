const baseUrl = (process.env.SMOKE_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const email = process.env.ADMIN_EMAIL ?? "admin@example.com";
const password = process.env.ADMIN_PASSWORD ?? "ChangeMe123!";

async function json(path: string, init: RequestInit = {}, cookie?: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} returned ${response.status}: ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
}

const ready = await json("/health/ready") as { status: string };
if (ready.status !== "ready") throw new Error("Readiness did not report ready");

const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { accept: "application/json", "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
});
if (!loginResponse.ok) throw new Error(`Login returned ${loginResponse.status}: ${await loginResponse.text()}`);
const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0];
if (!cookie) throw new Error("Login did not set the session cookie");

const [dashboard, workers, shifts, calls] = await Promise.all([
  json("/api/dashboard/summary", {}, cookie),
  json("/api/workers?limit=5", {}, cookie),
  json("/api/shifts?limit=5", {}, cookie),
  json("/api/calls?limit=5", {}, cookie),
]) as Array<Record<string, unknown>>;

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  activeWorkers: dashboard.activeWorkers,
  openShifts: dashboard.openShifts,
  sampledWorkers: Array.isArray(workers.workers) ? workers.workers.length : 0,
  sampledShifts: Array.isArray(shifts.shifts) ? shifts.shifts.length : 0,
  sampledCalls: Array.isArray(calls.calls) ? calls.calls.length : 0,
}, null, 2));
