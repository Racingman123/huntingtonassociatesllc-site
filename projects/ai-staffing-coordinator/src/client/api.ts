import type {
  AssignmentSummary,
  CallStatus,
  DashboardSummary,
  ShiftSummary,
  WorkerStatus,
  WorkerSummary,
} from "@shared/contracts";

const API_ROOT = "/api";

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: "admin" | "scheduler" | "viewer";
  organizationName?: string;
  publicDemo?: boolean;
}

export interface WorkerProfile extends WorkerSummary {
  address?: string | null;
  notes?: string | null;
  voiceConsentSource?: string | null;
  smsConsentSource?: string | null;
  certifications?: Array<{ name: string; expiresAt?: string }>;
  availability?: Record<string, Array<{ start: string; end: string }>>;
}

export type WorkerInput = {
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
  status: WorkerStatus;
  roles: string[];
  skills: string[];
  timezone: string;
  address: string | null;
  notes: string | null;
  voiceConsent: boolean;
  voiceConsentSource: string | null;
  smsConsent: boolean;
  smsConsentSource: string | null;
  doNotCall: boolean;
  doNotText: boolean;
};

export interface ShiftDetail extends ShiftSummary {
  clientId?: string;
  locationId?: string;
  requiredSkills?: string[];
  notes?: string | null;
  assignments?: AssignmentSummary[];
}

export interface ClientRecord {
  id: string;
  name: string;
  active: boolean;
}

export interface LocationRecord {
  id: string;
  clientId: string;
  clientName?: string;
  name: string;
  address: string;
  timezone: string;
}

export type ShiftInput = {
  clientId: string;
  locationId: string;
  role: string;
  requiredSkills: string[];
  startsAt: string;
  endsAt: string;
  headcount: number;
  payRateCents: number | null;
  status: "draft" | "open";
  notes: string | null;
  autoFillEnabled: boolean;
};

export interface CallRecord {
  id: string;
  workerId: string;
  workerName: string;
  shiftId: string | null;
  shiftLabel?: string | null;
  status: CallStatus;
  direction: "outbound" | "inbound";
  attempt: number;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  outcome: string | null;
  errorMessage?: string | null;
  durationSeconds?: number | null;
  transcript?: ConversationTurn[];
}

export interface ConversationTurn {
  id: string;
  speaker: "agent" | "worker" | "system";
  text: string;
  createdAt: string;
}

export interface MessageRecord {
  id: string;
  workerId: string;
  workerName: string;
  assignmentId: string | null;
  direction: "outbound" | "inbound";
  body: string;
  status: "queued" | "sent" | "delivered" | "failed" | "received" | "suppressed";
  sentAt: string | null;
  createdAt: string;
}

export interface SimulationInput {
  workerId: string;
  shiftId: string;
  response: "accept" | "decline" | "no_answer" | "busy";
}

export interface SimulationResult {
  callId: string;
  assignmentId?: string;
  status: string;
  message: string;
}

export class ApiClientError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      ...init,
      headers,
      credentials: "include",
    });
  } catch {
    throw new ApiClientError("Unable to reach the server. Check your connection and try again.", 0);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const isJson = response.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const errorBody = typeof body === "object" && body ? body as Record<string, unknown> : {};
    const message = typeof errorBody.message === "string"
      ? errorBody.message
      : typeof body === "string" && body
        ? body
        : `Request failed (${response.status})`;
    throw new ApiClientError(message, response.status, errorBody.details);
  }

  return body as T;
}

function entity<T>(payload: unknown, key: string): T {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (key in record) return record[key] as T;
    if ("data" in record) {
      const data = record.data;
      if (data && typeof data === "object" && key in (data as Record<string, unknown>)) {
        return (data as Record<string, unknown>)[key] as T;
      }
      return data as T;
    }
  }
  return payload as T;
}

function collection<T>(payload: unknown, key: string): T[] {
  const value = entity<unknown>(payload, key);
  return Array.isArray(value) ? value as T[] : [];
}

function queryString(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value) query.set(key, value);
  });
  const value = query.toString();
  return value ? `?${value}` : "";
}

function normalizeAssignment(value: unknown): AssignmentSummary {
  const record = value as Record<string, unknown>;
  return {
    ...record,
    workerName: typeof record.workerName === "string"
      ? record.workerName
      : `${String(record.firstName ?? "")} ${String(record.lastName ?? "")}`.trim() || "Worker",
  } as unknown as AssignmentSummary;
}

function normalizeCall(value: unknown): CallRecord {
  const record = value as Record<string, unknown>;
  const startedAt = typeof record.startedAt === "string" ? record.startedAt : null;
  const endedAt = typeof record.endedAt === "string" ? record.endedAt : null;
  const durationSeconds = startedAt && endedAt
    ? Math.max(0, Math.round((new Date(endedAt).valueOf() - new Date(startedAt).valueOf()) / 1000))
    : null;
  return {
    ...(record as unknown as CallRecord),
    workerName: typeof record.workerName === "string"
      ? record.workerName
      : `${String(record.firstName ?? "")} ${String(record.lastName ?? "")}`.trim() || "Worker",
    shiftLabel: typeof record.shiftLabel === "string"
      ? record.shiftLabel
      : typeof record.shiftRole === "string" ? record.shiftRole : null,
    durationSeconds,
  };
}

export const api = {
  async login(email: string, password: string): Promise<CurrentUser> {
    return entity(await request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }), "user");
  },

  async me(): Promise<CurrentUser> {
    return entity(await request("/auth/me"), "user");
  },

  logout(): Promise<void> {
    return request("/auth/logout", { method: "POST" });
  },

  async dashboard(): Promise<DashboardSummary> {
    return entity(await request("/dashboard"), "dashboard");
  },

  async workers(filters: { search?: string; status?: string } = {}): Promise<WorkerProfile[]> {
    return collection(await request(`/workers${queryString({ search: filters.search, status: filters.status })}`), "workers");
  },

  async worker(id: string): Promise<WorkerProfile> {
    return entity(await request(`/workers/${id}`), "worker");
  },

  async createWorker(input: WorkerInput): Promise<WorkerProfile> {
    return entity(await request("/workers", { method: "POST", body: JSON.stringify(input) }), "worker");
  },

  async updateWorker(id: string, input: Partial<WorkerInput>): Promise<WorkerProfile> {
    return entity(await request(`/workers/${id}`, { method: "PATCH", body: JSON.stringify(input) }), "worker");
  },

  async shifts(filters: { status?: string } = {}): Promise<ShiftDetail[]> {
    return collection(await request(`/shifts${queryString({ status: filters.status })}`), "shifts");
  },

  async shift(id: string): Promise<ShiftDetail> {
    const payload = await request<Record<string, unknown>>(`/shifts/${id}`);
    const shift = entity<ShiftDetail>(payload, "shift");
    const assignments = collection<unknown>(payload, "assignments").map(normalizeAssignment);
    return {
      ...shift,
      acceptedCount: assignments.filter((assignment) => assignment.status === "accepted").length,
      assignments: assignments.map((assignment) => ({
        ...assignment,
        shiftRole: assignment.shiftRole || shift.role,
        shiftStartsAt: assignment.shiftStartsAt || shift.startsAt,
      })),
    };
  },

  async createShift(input: ShiftInput): Promise<ShiftDetail> {
    return entity(await request("/shifts", { method: "POST", body: JSON.stringify(input) }), "shift");
  },

  async autoFillShift(id: string): Promise<void> {
    await request(`/shifts/${id}/auto-fill`, { method: "POST" });
  },

  async clients(): Promise<ClientRecord[]> {
    return collection(await request("/clients?active=true"), "clients");
  },

  async locations(clientId: string): Promise<LocationRecord[]> {
    return collection(await request(`/locations${queryString({ clientId })}`), "locations");
  },

  async assignments(filters: { status?: string } = {}): Promise<AssignmentSummary[]> {
    return collection<unknown>(await request(`/assignments${queryString({ status: filters.status })}`), "assignments").map(normalizeAssignment);
  },

  async calls(): Promise<CallRecord[]> {
    return collection<unknown>(await request("/calls"), "calls").map(normalizeCall);
  },

  async call(id: string): Promise<CallRecord> {
    const payload = await request<Record<string, unknown>>(`/calls/${id}`);
    const call = normalizeCall(entity(payload, "call"));
    return { ...call, transcript: collection<ConversationTurn>(payload, "turns") };
  },

  async messages(): Promise<MessageRecord[]> {
    return collection(await request("/messages"), "messages");
  },

  async simulate(input: SimulationInput): Promise<SimulationResult> {
    return entity(await request("/demo/simulate", {
      method: "POST",
      body: JSON.stringify(input),
    }), "simulation");
  },
};
