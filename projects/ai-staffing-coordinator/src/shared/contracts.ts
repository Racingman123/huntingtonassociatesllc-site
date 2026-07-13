export type WorkerStatus = "active" | "inactive" | "suspended";
export type ShiftStatus = "draft" | "open" | "filled" | "cancelled" | "completed";
export type AssignmentStatus =
  | "candidate"
  | "offered"
  | "accepted"
  | "declined"
  | "cancelled"
  | "completed"
  | "no_show";
export type CallStatus =
  | "queued"
  | "initiated"
  | "ringing"
  | "in_progress"
  | "completed"
  | "busy"
  | "failed"
  | "no_answer"
  | "cancelled";

export interface WorkerSummary {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
  status: WorkerStatus;
  roles: string[];
  skills: string[];
  timezone: string;
  voiceConsent: boolean;
  smsConsent: boolean;
  doNotCall: boolean;
  doNotText: boolean;
  lastContactedAt: string | null;
  createdAt: string;
}

export interface ShiftSummary {
  id: string;
  clientName: string;
  role: string;
  locationName: string;
  address: string;
  timezone: string;
  startsAt: string;
  endsAt: string;
  headcount: number;
  acceptedCount: number;
  payRateCents: number | null;
  status: ShiftStatus;
  autoFillEnabled: boolean;
}

export interface AssignmentSummary {
  id: string;
  workerId: string;
  workerName: string;
  shiftId: string;
  shiftRole: string;
  shiftStartsAt: string;
  status: AssignmentStatus;
  acceptedAt: string | null;
  declineReason: string | null;
}

export interface DashboardSummary {
  activeWorkers: number;
  openShifts: number;
  unfilledPositions: number;
  callsToday: number;
  upcomingAssignments: AssignmentSummary[];
  recentActivity: Array<{
    id: string;
    action: string;
    entityType: string;
    createdAt: string;
    actorLabel: string;
  }>;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  requestId?: string;
  details?: unknown;
}
