import {
  Activity,
  ArrowRight,
  Bot,
  BriefcaseBusiness,
  CalendarCheck,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Headphones,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Menu,
  MessageSquareText,
  MoreHorizontal,
  Phone,
  PhoneCall,
  Play,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  UserRound,
  UsersRound,
  WandSparkles,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import {
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import type {
  AssignmentStatus,
  AssignmentSummary,
  DashboardSummary,
  ShiftStatus,
  WorkerStatus,
} from "@shared/contracts";
import {
  api,
  ApiClientError,
  type CallRecord,
  type ClientRecord,
  type CurrentUser,
  type LocationRecord,
  type MessageRecord,
  type ShiftDetail,
  type ShiftInput,
  type SimulationResult,
  type WorkerInput,
  type WorkerProfile,
} from "./api";

type Notice = { kind: "success" | "error"; message: string } | null;
type Notify = (notice: NonNullable<Notice>) => void;

const navItems = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/workers", label: "Workers", icon: UsersRound },
  { to: "/shifts", label: "Shifts", icon: CalendarCheck },
  { to: "/assignments", label: "Assignments", icon: BriefcaseBusiness },
  { to: "/communications", label: "Communications", icon: Headphones },
  { to: "/demo", label: "Demo lab", icon: WandSparkles },
];

function displayError(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function formatDateTime(value: string | null | undefined, options?: Intl.DateTimeFormatOptions): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat(undefined, options ?? {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatDay(value: string): { day: string; date: string } {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return { day: "—", date: "—" };
  return {
    day: new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(parsed).toUpperCase(),
    date: new Intl.DateTimeFormat(undefined, { day: "2-digit" }).format(parsed),
  };
}

function relativeTime(value: string | null | undefined): string {
  if (!value) return "Never";
  const date = new Date(value);
  const delta = date.valueOf() - Date.now();
  if (Number.isNaN(delta)) return "Unknown";
  const minutes = Math.round(delta / 60_000);
  if (Math.abs(minutes) < 1) return "Just now";
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function money(cents: number | null): string {
  if (cents === null) return "Rate not set";
  return `${new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(cents / 100)}/hr`;
}

function getInitialShiftTimes(): { startsAt: string; endsAt: string } {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(9, 0, 0, 0);
  const end = new Date(start);
  end.setHours(17, 0, 0, 0);
  const local = (date: Date) => {
    const offset = date.getTimezoneOffset() * 60_000;
    return new Date(date.valueOf() - offset).toISOString().slice(0, 16);
  };
  return { startsAt: local(start), endsAt: local(end) };
}

export function App() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    let active = true;
    api.me()
      .then((currentUser) => active && setUser(currentUser))
      .catch((error: unknown) => {
        if (active && error instanceof ApiClientError && error.status !== 401) {
          setNotice({ kind: "error", message: error.message });
        }
      })
      .finally(() => active && setCheckingSession(false));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const notify: Notify = (nextNotice) => setNotice(nextNotice);

  if (checkingSession) return <AppLoading />;

  return (
    <>
      <Routes>
        <Route
          path="/login"
          element={user ? <Navigate to="/" replace /> : <LoginPage onLogin={setUser} notify={notify} />}
        />
        <Route
          path="*"
          element={user
            ? <AppShell user={user} onLogout={() => setUser(null)} notify={notify} />
            : <Navigate to="/login" replace />}
        />
      </Routes>
      {notice && <Toast notice={notice} onDismiss={() => setNotice(null)} />}
    </>
  );
}

function AppLoading() {
  return (
    <main className="app-loading" aria-label="Loading Relay Staffing">
      <BrandMark />
      <LoaderCircle className="spin" size={22} aria-hidden="true" />
    </main>
  );
}

function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "brand--compact" : ""}`}>
      <span className="brand__mark"><Sparkles size={18} strokeWidth={2.5} /></span>
      <span className="brand__copy">
        <strong>Relay</strong>
        {!compact && <small>STAFFING</small>}
      </span>
    </div>
  );
}

function LoginPage({ onLogin, notify }: { onLogin: (user: CurrentUser) => void; notify: Notify }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      onLogin(await api.login(email, password));
    } catch (error) {
      notify({ kind: "error", message: displayError(error) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-shell">
      <section className="login-story" aria-label="Product introduction">
        <BrandMark />
        <div className="login-story__body">
          <span className="eyebrow eyebrow--light"><span /> Autonomous staffing operations</span>
          <h1>Fill every shift.<br />Without the phone tag.</h1>
          <p>Relay calls qualified workers, confirms availability, and sends reminders—so your team can focus on people, not spreadsheets.</p>
          <div className="voice-preview">
            <div className="voice-preview__top">
              <span className="live-dot" />
              <span>AI call in progress</span>
              <span className="voice-preview__time">01:24</span>
            </div>
            <div className="voice-preview__worker">
              <Avatar name="Maya Thompson" size="large" />
              <div><strong>Maya Thompson</strong><span>CNA · Hartford</span></div>
              <VoiceBars />
            </div>
            <p>“Great, I can work the 7 AM shift on Tuesday.”</p>
          </div>
        </div>
        <p className="login-story__footer">Purpose-built for modern staffing teams</p>
      </section>
      <section className="login-form-wrap">
        <div className="login-form-card">
          <div className="login-mobile-brand"><BrandMark /></div>
          <span className="eyebrow"><span /> Secure operations portal</span>
          <h2>Welcome back</h2>
          <p className="subtle">Sign in to manage your workforce and live schedules.</p>
          <form onSubmit={submit} className="stack-form">
            <label>
              <span>Work email</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                placeholder="you@company.com"
                required
                autoFocus
              />
            </label>
            <label>
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                placeholder="Enter your password"
                required
              />
            </label>
            <button className="button button--primary button--large" type="submit" disabled={submitting}>
              {submitting ? <LoaderCircle className="spin" size={18} /> : <>Sign in <ArrowRight size={17} /></>}
            </button>
          </form>
          <div className="security-note"><ShieldCheck size={17} /><span>Your session is encrypted and access is audited.</span></div>
        </div>
      </section>
    </main>
  );
}

function AppShell({ user, onLogout, notify }: { user: CurrentUser; onLogout: () => void; notify: Notify }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const pageTitle = navItems.find((item) => item.to === location.pathname)?.label ?? "Relay";

  useEffect(() => setMenuOpen(false), [location.pathname]);

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      // The local session should still end if the server cookie already expired.
    }
    onLogout();
    navigate("/login", { replace: true });
  };

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "sidebar--open" : ""}`}>
        <div className="sidebar__brand"><BrandMark /></div>
        <nav aria-label="Primary navigation">
          <span className="nav-label">Workspace</span>
          {navItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => `nav-link ${isActive ? "nav-link--active" : ""}`}>
              <Icon size={19} />
              <span>{label}</span>
              {label === "Demo lab" && <small>LIVE</small>}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar__footer">
          <div className="automation-health">
            <span className="automation-health__icon"><Bot size={18} /></span>
            <div><strong>Agent online</strong><span><i /> All systems operational</span></div>
          </div>
          {user.publicDemo ? (
            <div className="profile-button" aria-label="Public demo session">
              <Avatar name={user.name} />
              <span><strong>{user.name}</strong><small>Public demo</small></span>
            </div>
          ) : (
            <button className="profile-button" type="button" onClick={logout} title="Sign out">
              <Avatar name={user.name} />
              <span><strong>{user.name}</strong><small>{titleCase(user.role)}</small></span>
              <LogOut size={17} />
            </button>
          )}
        </div>
      </aside>
      {menuOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
      <div className="app-main">
        <header className="mobile-header">
          <button className="icon-button" onClick={() => setMenuOpen(true)} aria-label="Open navigation"><Menu /></button>
          <BrandMark compact />
          <Avatar name={user.name} />
        </header>
        <div className="desktop-topbar">
          <div><span className="breadcrumb">Workspace /</span> {pageTitle}</div>
          <div className="topbar-status"><span className="live-dot" /> Agent online</div>
        </div>
        <main className="page-container">
          <Routes>
            <Route path="/" element={<OverviewPage notify={notify} />} />
            <Route path="/workers" element={<WorkersPage notify={notify} />} />
            <Route path="/shifts" element={<ShiftsPage notify={notify} />} />
            <Route path="/assignments" element={<AssignmentsPage />} />
            <Route path="/communications" element={<CommunicationsPage notify={notify} />} />
            <Route path="/demo" element={<DemoPage notify={notify} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description: string; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <span className="eyebrow"><span /> {eyebrow}</span>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  );
}

function OverviewPage({ notify }: { notify: Notify }) {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    api.dashboard().then(setData).catch((reason) => setError(displayError(reason))).finally(() => setLoading(false));
  };
  useEffect(load, []);

  if (loading) return <PageLoading label="Loading operations overview" />;
  if (error) return <PageError message={error} retry={load} />;
  if (!data) return null;

  const metrics = [
    { label: "Active workers", value: data.activeWorkers, detail: "Ready for placement", icon: UsersRound, tone: "sage" },
    { label: "Open shifts", value: data.openShifts, detail: "Across all clients", icon: CalendarCheck, tone: "blue" },
    { label: "Positions to fill", value: data.unfilledPositions, detail: data.unfilledPositions ? "Needs attention" : "All covered", icon: BriefcaseBusiness, tone: "amber" },
    { label: "Calls today", value: data.callsToday, detail: "Handled by Relay", icon: PhoneCall, tone: "violet" },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Live operations"
        title="Good morning"
        description="Here’s what’s happening across your staffing operation."
        actions={<><Link className="button button--ghost" to="/demo"><Play size={16} /> Run demo</Link><Link className="button button--primary" to="/shifts"><Plus size={17} /> New shift</Link></>}
      />
      <section className="metric-grid" aria-label="Operations metrics">
        {metrics.map(({ label, value, detail, icon: Icon, tone }) => (
          <article className="metric-card" key={label}>
            <span className={`metric-card__icon metric-card__icon--${tone}`}><Icon size={21} /></span>
            <div className="metric-card__value">{value.toLocaleString()}</div>
            <div className="metric-card__label">{label}</div>
            <div className="metric-card__detail"><span className={label === "Positions to fill" && value ? "dot dot--amber" : "dot"} /> {detail}</div>
          </article>
        ))}
      </section>
      <div className="overview-grid">
        <section className="panel overview-assignments">
          <PanelHeader title="Upcoming assignments" subtitle="Accepted shifts coming up next" action={<Link to="/assignments">View all <ArrowRight size={15} /></Link>} />
          {data.upcomingAssignments.length ? (
            <div className="assignment-stack">
              {data.upcomingAssignments.slice(0, 5).map((assignment) => <AssignmentRow assignment={assignment} key={assignment.id} />)}
            </div>
          ) : <EmptyState icon={<CalendarCheck />} title="No upcoming assignments" body="Accepted worker assignments will show up here." />}
        </section>
        <section className="panel recent-activity">
          <PanelHeader title="Recent activity" subtitle="Your automation at work" />
          {data.recentActivity.length ? (
            <div className="activity-list">
              {data.recentActivity.slice(0, 7).map((item) => (
                <div className="activity-item" key={item.id}>
                  <span className="activity-item__icon">{activityIcon(item.entityType)}</span>
                  <div><strong>{item.action}</strong><span>{item.actorLabel}</span></div>
                  <time title={formatDateTime(item.createdAt)}>{relativeTime(item.createdAt)}</time>
                </div>
              ))}
            </div>
          ) : <EmptyState icon={<Activity />} title="No activity yet" body="Calls, confirmations, and reminders will appear here." />}
        </section>
      </div>
      <section className="agent-banner">
        <span className="agent-banner__icon"><Bot size={25} /></span>
        <div><strong>Relay is standing by</strong><p>Launch an open shift and the agent will contact matching, consented workers in priority order.</p></div>
        <Link className="button button--light" to="/shifts">Review open shifts <ChevronRight size={17} /></Link>
      </section>
    </>
  );
}

function activityIcon(entityType: string): ReactNode {
  const value = entityType.toLowerCase();
  if (value.includes("call")) return <PhoneCall size={16} />;
  if (value.includes("message")) return <MessageSquareText size={16} />;
  if (value.includes("worker")) return <UserRound size={16} />;
  return <Check size={16} />;
}

function PanelHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="panel-header">
      <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
      {action && <div className="panel-header__action">{action}</div>}
    </div>
  );
}

function AssignmentRow({ assignment }: { assignment: AssignmentSummary }) {
  const date = formatDay(assignment.shiftStartsAt);
  return (
    <div className="assignment-row">
      <div className="date-tile"><span>{date.day}</span><strong>{date.date}</strong></div>
      <Avatar name={assignment.workerName} />
      <div className="assignment-row__main"><strong>{assignment.workerName}</strong><span>{assignment.shiftRole} · {formatDateTime(assignment.shiftStartsAt, { hour: "numeric", minute: "2-digit" })}</span></div>
      <StatusBadge value={assignment.status} />
    </div>
  );
}

function WorkersPage({ notify }: { notify: Notify }) {
  const [workers, setWorkers] = useState<WorkerProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [editing, setEditing] = useState<WorkerProfile | "new" | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    api.workers({ search: search || undefined, status: status === "all" ? undefined : status })
      .then(setWorkers)
      .catch((reason) => setError(displayError(reason)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    const timer = window.setTimeout(load, 250);
    return () => window.clearTimeout(timer);
  }, [search, status]);

  const saved = () => {
    setEditing(null);
    notify({ kind: "success", message: editing === "new" ? "Worker profile created." : "Worker profile updated." });
    load();
  };

  return (
    <>
      <PageHeader
        eyebrow="Talent network"
        title="Workers"
        description="Manage worker profiles, qualifications, and communication consent."
        actions={<button className="button button--primary" onClick={() => setEditing("new")}><Plus size={17} /> Add worker</button>}
      />
      <section className="panel table-panel">
        <div className="toolbar">
          <label className="search-field"><Search size={17} /><span className="sr-only">Search workers</span><input placeholder="Search name, phone, or email…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <label className="select-field"><span className="sr-only">Filter by status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option><option value="suspended">Suspended</option></select></label>
          <span className="toolbar__count">{workers.length} worker{workers.length === 1 ? "" : "s"}</span>
        </div>
        {loading ? <InlineLoading /> : error ? <PageError message={error} retry={load} compact /> : workers.length ? (
          <div className="data-table-wrap">
            <table className="data-table worker-table">
              <thead><tr><th>Worker</th><th>Roles & skills</th><th>Contact permissions</th><th>Status</th><th>Last contact</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {workers.map((worker) => (
                  <tr key={worker.id}>
                    <td data-label="Worker"><button className="person-cell person-cell--button" onClick={() => setEditing(worker)}><Avatar name={`${worker.firstName} ${worker.lastName}`} /><span><strong>{worker.firstName} {worker.lastName}</strong><small>{worker.phone}{worker.email ? ` · ${worker.email}` : ""}</small></span></button></td>
                    <td data-label="Roles & skills"><div className="tag-list">{worker.roles.slice(0, 2).map((role) => <span className="tag" key={role}>{role}</span>)}{worker.skills.length > 0 && <span className="tag tag--muted">+{worker.skills.length} skill{worker.skills.length === 1 ? "" : "s"}</span>}</div></td>
                    <td data-label="Permissions"><div className="permission-list"><PermissionIcon allowed={worker.voiceConsent && !worker.doNotCall} label="Voice" icon={<Phone size={13} />} /><PermissionIcon allowed={worker.smsConsent && !worker.doNotText} label="SMS" icon={<MessageSquareText size={13} />} /></div></td>
                    <td data-label="Status"><StatusBadge value={worker.status} /></td>
                    <td data-label="Last contact"><span className="muted-cell">{relativeTime(worker.lastContactedAt)}</span></td>
                    <td><button className="icon-button icon-button--small" onClick={() => setEditing(worker)} aria-label={`Edit ${worker.firstName} ${worker.lastName}`}><MoreHorizontal size={18} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState icon={<UsersRound />} title="No workers found" body={search ? "Try a different search or clear your filters." : "Add your first worker to begin filling shifts."} action={!search && <button className="button button--primary" onClick={() => setEditing("new")}><Plus size={16} /> Add worker</button>} />}
      </section>
      {editing && <WorkerDialog worker={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={saved} notify={notify} />}
    </>
  );
}

function PermissionIcon({ allowed, label, icon }: { allowed: boolean; label: string; icon: ReactNode }) {
  return <span className={`permission ${allowed ? "permission--allowed" : "permission--blocked"}`} title={`${label} ${allowed ? "allowed" : "blocked"}`}>{icon}<span>{label}</span></span>;
}

const blankWorker: WorkerInput = {
  firstName: "",
  lastName: "",
  phone: "",
  email: null,
  status: "active",
  roles: [],
  skills: [],
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York",
  address: null,
  notes: null,
  voiceConsent: false,
  voiceConsentSource: null,
  smsConsent: false,
  smsConsentSource: null,
  doNotCall: false,
  doNotText: false,
};

function WorkerDialog({ worker, onClose, onSaved, notify }: { worker: WorkerProfile | null; onClose: () => void; onSaved: () => void; notify: Notify }) {
  const [form, setForm] = useState<WorkerInput>(() => worker ? {
    firstName: worker.firstName,
    lastName: worker.lastName,
    phone: worker.phone,
    email: worker.email,
    status: worker.status,
    roles: worker.roles,
    skills: worker.skills,
    timezone: worker.timezone,
    address: worker.address ?? null,
    notes: worker.notes ?? null,
    voiceConsent: worker.voiceConsent,
    voiceConsentSource: worker.voiceConsentSource ?? null,
    smsConsent: worker.smsConsent,
    smsConsentSource: worker.smsConsentSource ?? null,
    doNotCall: worker.doNotCall,
    doNotText: worker.doNotText,
  } : { ...blankWorker });
  const [saving, setSaving] = useState(false);
  const [roles, setRoles] = useState(form.roles.join(", "));
  const [skills, setSkills] = useState(form.skills.join(", "));
  const field = <K extends keyof WorkerInput>(key: K, value: WorkerInput[K]) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    const payload = {
      ...form,
      email: form.email || null,
      address: form.address || null,
      notes: form.notes || null,
      roles: roles.split(",").map((value) => value.trim()).filter(Boolean),
      skills: skills.split(",").map((value) => value.trim()).filter(Boolean),
      voiceConsentSource: form.voiceConsent ? form.voiceConsentSource?.trim() || null : null,
      smsConsentSource: form.smsConsent ? form.smsConsentSource?.trim() || null : null,
    };
    try {
      if (worker) await api.updateWorker(worker.id, payload);
      else await api.createWorker(payload);
      onSaved();
    } catch (error) {
      notify({ kind: "error", message: displayError(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title={worker ? "Edit worker profile" : "Add a worker"} description="Profile, qualifications, and communication permissions" onClose={onClose} wide>
      <form onSubmit={submit} className="dialog-form">
        <FormSection title="Basic information" description="The details schedulers and the voice agent use.">
          <div className="form-grid form-grid--2">
            <Field label="First name" required><input value={form.firstName} onChange={(e) => field("firstName", e.target.value)} required /></Field>
            <Field label="Last name" required><input value={form.lastName} onChange={(e) => field("lastName", e.target.value)} required /></Field>
            <Field label="Mobile number" required hint="Use an E.164 number when possible"><input type="tel" value={form.phone} onChange={(e) => field("phone", e.target.value)} placeholder="+1 860 555 0142" required /></Field>
            <Field label="Email"><input type="email" value={form.email ?? ""} onChange={(e) => field("email", e.target.value)} /></Field>
            <Field label="Status"><select value={form.status} onChange={(e) => field("status", e.target.value as WorkerStatus)}><option value="active">Active</option><option value="inactive">Inactive</option><option value="suspended">Suspended</option></select></Field>
            <Field label="Timezone"><input value={form.timezone} onChange={(e) => field("timezone", e.target.value)} required /></Field>
            <Field label="Address" className="form-grid__full"><input value={form.address ?? ""} onChange={(e) => field("address", e.target.value)} /></Field>
          </div>
        </FormSection>
        <FormSection title="Qualifications" description="Separate multiple entries with commas.">
          <div className="form-grid form-grid--2">
            <Field label="Eligible roles" hint="e.g. CNA, Forklift Operator"><input value={roles} onChange={(e) => setRoles(e.target.value)} /></Field>
            <Field label="Skills" hint="e.g. BLS, warehouse, bilingual"><input value={skills} onChange={(e) => setSkills(e.target.value)} /></Field>
          </div>
        </FormSection>
        <FormSection title="Communication consent" description="Relay only contacts workers through channels they have authorized.">
          <div className="consent-grid">
            <Toggle label="Voice call consent" description="Worker agreed to receive automated staffing calls." checked={form.voiceConsent} onChange={(value) => { field("voiceConsent", value); if (!value) field("voiceConsentSource", null); }} icon={<PhoneCall size={18} />} />
            {form.voiceConsent && <Field label="Voice consent evidence" required hint="Record how and when consent was captured"><input value={form.voiceConsentSource ?? ""} onChange={(event) => field("voiceConsentSource", event.target.value)} placeholder="e.g. signed onboarding form 2026-07-12" required /></Field>}
            <Toggle label="SMS consent" description="Worker agreed to receive shift texts and reminders." checked={form.smsConsent} onChange={(value) => { field("smsConsent", value); if (!value) field("smsConsentSource", null); }} icon={<MessageSquareText size={18} />} />
            {form.smsConsent && <Field label="SMS consent evidence" required hint="Record how and when consent was captured"><input value={form.smsConsentSource ?? ""} onChange={(event) => field("smsConsentSource", event.target.value)} placeholder="e.g. signed onboarding form 2026-07-12" required /></Field>}
            <Toggle label="Do not call" description="Immediately suppress all automated voice calls." checked={form.doNotCall} onChange={(value) => field("doNotCall", value)} danger />
            <Toggle label="Do not text" description="Immediately suppress all automated text messages." checked={form.doNotText} onChange={(value) => field("doNotText", value)} danger />
          </div>
        </FormSection>
        <FormSection title="Internal notes" description="Visible to your scheduling team only.">
          <Field label="Notes"><textarea rows={3} value={form.notes ?? ""} onChange={(e) => field("notes", e.target.value)} placeholder="Preferences, scheduling context, or follow-up details…" /></Field>
        </FormSection>
        <DialogActions onClose={onClose} saving={saving} saveLabel={worker ? "Save changes" : "Create worker"} />
      </form>
    </Dialog>
  );
}

function ShiftsPage({ notify }: { notify: Notify }) {
  const [shifts, setShifts] = useState<ShiftDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("all");
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<ShiftDetail | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    api.shifts({ status: status === "all" ? undefined : status }).then(setShifts).catch((reason) => setError(displayError(reason))).finally(() => setLoading(false));
  };
  useEffect(load, [status]);

  const openShift = async (shift: ShiftDetail) => {
    setSelected(shift);
    try { setSelected(await api.shift(shift.id)); } catch { /* summary remains useful */ }
  };

  return (
    <>
      <PageHeader
        eyebrow="Scheduling"
        title="Shifts"
        description="Create requirements, monitor coverage, and launch automated filling."
        actions={<button className="button button--primary" onClick={() => setCreating(true)}><Plus size={17} /> Create shift</button>}
      />
      <div className="filter-tabs" role="group" aria-label="Filter shifts">
        {(["all", "open", "filled", "draft", "completed", "cancelled"] as const).map((value) => <button key={value} className={status === value ? "active" : ""} onClick={() => setStatus(value)}>{titleCase(value)}</button>)}
      </div>
      {loading ? <PageLoading label="Loading shifts" /> : error ? <PageError message={error} retry={load} /> : shifts.length ? (
        <section className="shift-grid">
          {shifts.map((shift) => <ShiftCard key={shift.id} shift={shift} onOpen={() => openShift(shift)} onAutoFill={async () => {
            try {
              await api.autoFillShift(shift.id);
              notify({ kind: "success", message: `Auto-fill started for ${shift.role}.` });
              load();
            } catch (reason) { notify({ kind: "error", message: displayError(reason) }); }
          }} />)}
        </section>
      ) : <section className="panel"><EmptyState icon={<CalendarCheck />} title="No shifts here" body={status === "all" ? "Create a shift to start scheduling workers." : `There are no ${status} shifts right now.`} action={status === "all" && <button className="button button--primary" onClick={() => setCreating(true)}><Plus size={16} /> Create shift</button>} /></section>}
      {creating && <ShiftDialog onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); notify({ kind: "success", message: "Shift created." }); }} notify={notify} />}
      {selected && <ShiftDetailDialog shift={selected} onClose={() => setSelected(null)} onAutoFill={async () => {
        try {
          await api.autoFillShift(selected.id);
          setSelected(await api.shift(selected.id));
          notify({ kind: "success", message: "Relay started contacting matching workers." });
          load();
        } catch (reason) { notify({ kind: "error", message: displayError(reason) }); }
      }} />}
    </>
  );
}

function ShiftCard({ shift, onOpen, onAutoFill }: { shift: ShiftDetail; onOpen: () => void; onAutoFill: () => void }) {
  const remaining = Math.max(shift.headcount - shift.acceptedCount, 0);
  const coverage = shift.headcount ? Math.min((shift.acceptedCount / shift.headcount) * 100, 100) : 0;
  const date = formatDay(shift.startsAt);
  return (
    <article className="shift-card">
      <button className="shift-card__main" onClick={onOpen}>
        <div className="shift-card__top"><div className="date-tile date-tile--large"><span>{date.day}</span><strong>{date.date}</strong></div><StatusBadge value={shift.status} /></div>
        <h2>{shift.role}</h2>
        <p className="shift-card__client">{shift.clientName}</p>
        <div className="shift-meta"><span><Clock3 size={15} /> {formatDateTime(shift.startsAt, { hour: "numeric", minute: "2-digit" })}–{formatDateTime(shift.endsAt, { hour: "numeric", minute: "2-digit" })}</span><span><BriefcaseBusiness size={15} /> {shift.locationName}</span></div>
        <div className="coverage">
          <div><span>Coverage</span><strong>{shift.acceptedCount} of {shift.headcount} filled</strong></div>
          <div className="progress"><span style={{ width: `${coverage}%` }} /></div>
        </div>
      </button>
      <div className="shift-card__footer">
        <span>{money(shift.payRateCents)}</span>
        {remaining > 0 && shift.status === "open" ? <button className="button button--small button--agent" onClick={onAutoFill}><Bot size={15} /> Auto-fill {remaining}</button> : <button className="button button--small button--ghost" onClick={onOpen}>View details</button>}
      </div>
    </article>
  );
}

function ShiftDialog({ onClose, onSaved, notify }: { onClose: () => void; onSaved: () => void; notify: Notify }) {
  const times = getInitialShiftTimes();
  const [form, setForm] = useState<ShiftInput>({
    clientId: "",
    locationId: "",
    role: "",
    requiredSkills: [],
    startsAt: times.startsAt,
    endsAt: times.endsAt,
    headcount: 1,
    payRateCents: null,
    status: "open",
    notes: null,
    autoFillEnabled: true,
  });
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [locations, setLocations] = useState<LocationRecord[]>([]);
  const [loadingReferences, setLoadingReferences] = useState(true);
  const [skills, setSkills] = useState("");
  const [payRate, setPayRate] = useState("");
  const [saving, setSaving] = useState(false);
  const field = <K extends keyof ShiftInput>(key: K, value: ShiftInput[K]) => setForm((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    api.clients()
      .then((data) => {
        setClients(data);
        setForm((current) => ({ ...current, clientId: current.clientId || data[0]?.id || "" }));
      })
      .catch((error) => notify({ kind: "error", message: displayError(error) }))
      .finally(() => setLoadingReferences(false));
  }, []);

  useEffect(() => {
    if (!form.clientId) { setLocations([]); return; }
    setLoadingReferences(true);
    api.locations(form.clientId)
      .then((data) => {
        setLocations(data);
        setForm((current) => ({
          ...current,
          locationId: data.some((location) => location.id === current.locationId) ? current.locationId : data[0]?.id || "",
        }));
      })
      .catch((error) => notify({ kind: "error", message: displayError(error) }))
      .finally(() => setLoadingReferences(false));
  }, [form.clientId]);

  const selectedLocation = locations.find((location) => location.id === form.locationId);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (new Date(form.endsAt) <= new Date(form.startsAt)) {
      notify({ kind: "error", message: "The shift end must be after its start." });
      return;
    }
    setSaving(true);
    try {
      await api.createShift({
        ...form,
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt: new Date(form.endsAt).toISOString(),
        requiredSkills: skills.split(",").map((value) => value.trim()).filter(Boolean),
        payRateCents: payRate ? Math.round(Number(payRate) * 100) : null,
        notes: form.notes || null,
      });
      onSaved();
    } catch (error) {
      notify({ kind: "error", message: displayError(error) });
    } finally { setSaving(false); }
  };

  return (
    <Dialog title="Create a shift" description="Define the work, coverage, and automation settings" onClose={onClose} wide>
      <form onSubmit={submit} className="dialog-form">
        <FormSection title="Client & role" description="What kind of worker does this assignment need?">
          <div className="form-grid form-grid--2">
            <Field label="Client" required><select value={form.clientId} onChange={(e) => field("clientId", e.target.value)} required disabled={loadingReferences || !clients.length}><option value="" disabled>{loadingReferences ? "Loading clients…" : "Select a client"}</option>{clients.map((client) => <option value={client.id} key={client.id}>{client.name}</option>)}</select></Field>
            <Field label="Role" required><input value={form.role} onChange={(e) => field("role", e.target.value)} placeholder="e.g. Certified Nursing Assistant" required /></Field>
            <Field label="Required skills" hint="Separate with commas" className="form-grid__full"><input value={skills} onChange={(e) => setSkills(e.target.value)} placeholder="BLS, patient care" /></Field>
            {!loadingReferences && !clients.length && <div className="inline-alert form-grid__full"><CircleAlert size={18} /><span><strong>No active clients found</strong>Add a client and location before creating a shift.</span></div>}
          </div>
        </FormSection>
        <FormSection title="When & where" description="Relay will state these details clearly on every call.">
          <div className="form-grid form-grid--2">
            <Field label="Starts" required><input type="datetime-local" value={form.startsAt} onChange={(e) => field("startsAt", e.target.value)} required /></Field>
            <Field label="Ends" required><input type="datetime-local" value={form.endsAt} onChange={(e) => field("endsAt", e.target.value)} required /></Field>
            <Field label="Location" required className="form-grid__full"><select value={form.locationId} onChange={(e) => field("locationId", e.target.value)} required disabled={loadingReferences || !locations.length}><option value="" disabled>{loadingReferences ? "Loading locations…" : locations.length ? "Select a location" : "No locations for this client"}</option>{locations.map((location) => <option value={location.id} key={location.id}>{location.name}</option>)}</select></Field>
            {selectedLocation && <div className="location-preview form-grid__full"><BriefcaseBusiness size={17} /><span><strong>{selectedLocation.name}</strong><small>{selectedLocation.address} · {selectedLocation.timezone}</small></span></div>}
          </div>
        </FormSection>
        <FormSection title="Coverage & automation" description="Set capacity, compensation, and how Relay should help.">
          <div className="form-grid form-grid--2">
            <Field label="Workers needed" required><input type="number" min="1" max="500" value={form.headcount} onChange={(e) => field("headcount", Number(e.target.value))} required /></Field>
            <Field label="Hourly pay rate" hint="USD"><div className="input-prefix"><span>$</span><input type="number" min="0" step="0.01" value={payRate} onChange={(e) => setPayRate(e.target.value)} placeholder="24.00" /></div></Field>
            <Field label="Initial status"><select value={form.status} onChange={(e) => field("status", e.target.value as "draft" | "open")}><option value="open">Open — ready to fill</option><option value="draft">Draft — save for later</option></select></Field>
            <div className="form-grid__full"><Toggle label="Enable automatic filling" description="Relay will call eligible, consented workers until this shift is full." checked={form.autoFillEnabled} onChange={(value) => field("autoFillEnabled", value)} icon={<Bot size={18} />} /></div>
            <Field label="Internal notes" className="form-grid__full"><textarea rows={3} value={form.notes ?? ""} onChange={(e) => field("notes", e.target.value)} /></Field>
          </div>
        </FormSection>
        <DialogActions onClose={onClose} saving={saving} saveLabel="Create shift" />
      </form>
    </Dialog>
  );
}

function ShiftDetailDialog({ shift, onClose, onAutoFill }: { shift: ShiftDetail; onClose: () => void; onAutoFill: () => void }) {
  const remaining = Math.max(shift.headcount - shift.acceptedCount, 0);
  const coverage = shift.headcount ? Math.min((shift.acceptedCount / shift.headcount) * 100, 100) : 0;
  return (
    <Dialog title={shift.role} description={`${shift.clientName} · ${shift.locationName}`} onClose={onClose} wide>
      <div className="shift-detail-hero">
        <div><StatusBadge value={shift.status} /><h3>{formatDateTime(shift.startsAt, { weekday: "long", month: "long", day: "numeric" })}</h3><p>{formatDateTime(shift.startsAt, { hour: "numeric", minute: "2-digit" })}–{formatDateTime(shift.endsAt, { hour: "numeric", minute: "2-digit" })} · {shift.timezone}</p></div>
        <div className="coverage-ring" style={{ "--coverage": `${coverage * 3.6}deg` } as React.CSSProperties}><span><strong>{shift.acceptedCount}/{shift.headcount}</strong><small>filled</small></span></div>
      </div>
      <div className="detail-grid">
        <div><span>Location</span><strong>{shift.locationName}</strong><small>{shift.address}</small></div>
        <div><span>Pay rate</span><strong>{money(shift.payRateCents)}</strong></div>
        <div><span>Required skills</span><div className="tag-list">{shift.requiredSkills?.length ? shift.requiredSkills.map((skill) => <span className="tag" key={skill}>{skill}</span>) : <span>None specified</span>}</div></div>
        <div><span>Automation</span><strong>{shift.autoFillEnabled ? "Enabled" : "Manual"}</strong></div>
      </div>
      <section className="detail-section">
        <PanelHeader title="Worker assignments" subtitle={`${shift.assignments?.length ?? 0} workers in the pipeline`} />
        {shift.assignments?.length ? <div className="assignment-stack">{shift.assignments.map((assignment) => <AssignmentRow key={assignment.id} assignment={assignment} />)}</div> : <EmptyState icon={<UsersRound />} title="No assignments yet" body="Start auto-fill to have Relay contact qualified workers." />}
      </section>
      <div className="dialog-actions">
        <button type="button" className="button button--ghost" onClick={onClose}>Close</button>
        {remaining > 0 && shift.status === "open" && <button type="button" className="button button--primary" onClick={onAutoFill}><Bot size={17} /> Auto-fill {remaining} position{remaining === 1 ? "" : "s"}</button>}
      </div>
    </Dialog>
  );
}

function AssignmentsPage() {
  const [assignments, setAssignments] = useState<AssignmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("all");
  const load = () => {
    setLoading(true);
    api.assignments({ status: status === "all" ? undefined : status }).then(setAssignments).catch((reason) => setError(displayError(reason))).finally(() => setLoading(false));
  };
  useEffect(load, [status]);
  return (
    <>
      <PageHeader eyebrow="Placement pipeline" title="Assignments" description="Follow every worker from first offer through shift completion." />
      <section className="panel table-panel">
        <div className="toolbar"><label className="select-field"><span className="sr-only">Filter assignments</span><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="all">All statuses</option>{(["candidate", "offered", "accepted", "declined", "completed", "no_show"] as AssignmentStatus[]).map((value) => <option key={value} value={value}>{titleCase(value)}</option>)}</select></label><span className="toolbar__count">{assignments.length} assignment{assignments.length === 1 ? "" : "s"}</span></div>
        {loading ? <InlineLoading /> : error ? <PageError message={error} retry={load} compact /> : assignments.length ? (
          <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Worker</th><th>Shift</th><th>Starts</th><th>Status</th><th>Response</th></tr></thead><tbody>{assignments.map((assignment) => <tr key={assignment.id}><td data-label="Worker"><div className="person-cell"><Avatar name={assignment.workerName} /><span><strong>{assignment.workerName}</strong><small>ID {assignment.workerId.slice(0, 8)}</small></span></div></td><td data-label="Shift"><strong>{assignment.shiftRole}</strong></td><td data-label="Starts"><span className="date-cell"><strong>{formatDateTime(assignment.shiftStartsAt, { month: "short", day: "numeric" })}</strong><small>{formatDateTime(assignment.shiftStartsAt, { hour: "numeric", minute: "2-digit" })}</small></span></td><td data-label="Status"><StatusBadge value={assignment.status} /></td><td data-label="Response"><span className="muted-cell">{assignment.acceptedAt ? `Accepted ${relativeTime(assignment.acceptedAt)}` : assignment.declineReason ?? "Awaiting response"}</span></td></tr>)}</tbody></table></div>
        ) : <EmptyState icon={<BriefcaseBusiness />} title="No assignments found" body="Assignments are created when workers enter a shift pipeline." />}
      </section>
    </>
  );
}

function CommunicationsPage({ notify }: { notify: Notify }) {
  const [tab, setTab] = useState<"calls" | "messages">("calls");
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [selectedCall, setSelectedCall] = useState<CallRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    Promise.all([
      api.calls(),
      api.messages().catch((reason) => {
        if (reason instanceof ApiClientError && reason.status === 404) return [];
        throw reason;
      }),
    ]).then(([callData, messageData]) => { setCalls(callData); setMessages(messageData); }).catch((reason) => setError(displayError(reason))).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const openCall = async (call: CallRecord) => {
    setSelectedCall(call);
    try {
      const detail = await api.call(call.id);
      setSelectedCall({ ...detail, workerName: call.workerName, shiftLabel: call.shiftLabel ?? detail.shiftLabel });
    } catch (reason) { notify({ kind: "error", message: displayError(reason) }); }
  };

  const completedCalls = calls.filter((call) => call.status === "completed").length;
  const deliveredMessages = messages.filter((message) => message.status === "delivered" || message.status === "sent").length;
  return (
    <>
      <PageHeader eyebrow="Worker outreach" title="Communications" description="Audit every automated call, conversation outcome, and SMS reminder." actions={<Link className="button button--primary" to="/demo"><Play size={16} /> Simulate a call</Link>} />
      <section className="communication-stats">
        <div><span className="metric-card__icon metric-card__icon--sage"><PhoneCall size={20} /></span><p><strong>{calls.length}</strong><span>Total calls</span></p></div>
        <div><span className="metric-card__icon metric-card__icon--blue"><Check size={20} /></span><p><strong>{completedCalls}</strong><span>Completed calls</span></p></div>
        <div><span className="metric-card__icon metric-card__icon--violet"><MessageSquareText size={20} /></span><p><strong>{messages.length}</strong><span>Text messages</span></p></div>
        <div><span className="metric-card__icon metric-card__icon--amber"><ArrowRight size={20} /></span><p><strong>{deliveredMessages}</strong><span>Messages sent</span></p></div>
      </section>
      <section className="panel table-panel">
        <div className="panel-tabs"><button className={tab === "calls" ? "active" : ""} onClick={() => setTab("calls")}><PhoneCall size={16} /> Calls <span>{calls.length}</span></button><button className={tab === "messages" ? "active" : ""} onClick={() => setTab("messages")}><MessageSquareText size={16} /> Messages <span>{messages.length}</span></button></div>
        {loading ? <InlineLoading /> : error ? <PageError message={error} retry={load} compact /> : tab === "calls" ? <CallTable calls={calls} onOpen={openCall} /> : <MessageTable messages={messages} />}
      </section>
      {selectedCall && <CallDialog call={selectedCall} onClose={() => setSelectedCall(null)} />}
    </>
  );
}

function CallTable({ calls, onOpen }: { calls: CallRecord[]; onOpen: (call: CallRecord) => void }) {
  if (!calls.length) return <EmptyState icon={<PhoneCall />} title="No calls yet" body="Automated and simulated calls will appear here." />;
  return <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Worker</th><th>Direction</th><th>Started</th><th>Duration</th><th>Outcome</th><th>Status</th><th><span className="sr-only">Open</span></th></tr></thead><tbody>{calls.map((call) => <tr key={call.id} className="clickable-row" onClick={() => onOpen(call)}><td data-label="Worker"><div className="person-cell"><Avatar name={call.workerName} /><span><strong>{call.workerName}</strong><small>{call.shiftLabel ?? (call.shiftId ? "Shift outreach" : "General outreach")}</small></span></div></td><td data-label="Direction"><span className="direction"><ArrowRight size={14} /> {titleCase(call.direction)}</span></td><td data-label="Started"><span className="date-cell"><strong>{formatDateTime(call.startedAt ?? call.createdAt, { month: "short", day: "numeric" })}</strong><small>{formatDateTime(call.startedAt ?? call.createdAt, { hour: "numeric", minute: "2-digit" })}</small></span></td><td data-label="Duration">{call.durationSeconds != null ? `${Math.floor(call.durationSeconds / 60)}m ${call.durationSeconds % 60}s` : "—"}</td><td data-label="Outcome"><span className="muted-cell">{call.outcome ? titleCase(call.outcome) : "—"}</span></td><td data-label="Status"><StatusBadge value={call.status} /></td><td><ChevronRight size={17} /></td></tr>)}</tbody></table></div>;
}

function MessageTable({ messages }: { messages: MessageRecord[] }) {
  if (!messages.length) return <EmptyState icon={<MessageSquareText />} title="No messages yet" body="Shift confirmations and reminders will appear here." />;
  return <div className="data-table-wrap"><table className="data-table message-table"><thead><tr><th>Worker</th><th>Message</th><th>Direction</th><th>Sent</th><th>Status</th></tr></thead><tbody>{messages.map((message) => <tr key={message.id}><td data-label="Worker"><div className="person-cell"><Avatar name={message.workerName} /><span><strong>{message.workerName}</strong></span></div></td><td data-label="Message"><span className="message-preview">{message.body}</span></td><td data-label="Direction"><span className="direction"><ArrowRight size={14} /> {titleCase(message.direction)}</span></td><td data-label="Sent"><span className="muted-cell">{formatDateTime(message.sentAt ?? message.createdAt)}</span></td><td data-label="Status"><StatusBadge value={message.status} /></td></tr>)}</tbody></table></div>;
}

function CallDialog({ call, onClose }: { call: CallRecord; onClose: () => void }) {
  return (
    <Dialog title="Call details" description={`${call.workerName} · ${formatDateTime(call.startedAt ?? call.createdAt)}`} onClose={onClose} wide>
      <div className="call-summary">
        <div><span className="call-summary__icon"><PhoneCall size={23} /></span><div><StatusBadge value={call.status} /><h3>{call.outcome ? titleCase(call.outcome) : "No outcome recorded"}</h3><p>{call.shiftLabel ?? "Worker outreach"}</p></div></div>
        <dl><div><dt>Direction</dt><dd>{titleCase(call.direction)}</dd></div><div><dt>Attempt</dt><dd>#{call.attempt}</dd></div><div><dt>Duration</dt><dd>{call.durationSeconds != null ? `${call.durationSeconds}s` : "—"}</dd></div></dl>
      </div>
      <section className="transcript">
        <PanelHeader title="Conversation transcript" subtitle="AI-generated transcript for operational review" />
        {call.transcript?.length ? call.transcript.map((turn) => <div className={`transcript-turn transcript-turn--${turn.speaker}`} key={turn.id}><Avatar name={turn.speaker === "agent" ? "Relay Agent" : call.workerName} /><div><span>{turn.speaker === "agent" ? "Relay" : turn.speaker === "worker" ? call.workerName : "System"}</span><p>{turn.text}</p><time>{formatDateTime(turn.createdAt, { hour: "numeric", minute: "2-digit", second: "2-digit" })}</time></div></div>) : <EmptyState icon={<MessageSquareText />} title="No transcript available" body="A transcript will appear after a connected voice conversation." />}
      </section>
      {call.errorMessage && <div className="inline-alert"><CircleAlert size={18} /><span><strong>Call error</strong>{call.errorMessage}</span></div>}
      <div className="dialog-actions"><button type="button" className="button button--primary" onClick={onClose}>Done</button></div>
    </Dialog>
  );
}

function DemoPage({ notify }: { notify: Notify }) {
  const [workers, setWorkers] = useState<WorkerProfile[]>([]);
  const [shifts, setShifts] = useState<ShiftDetail[]>([]);
  const [workerId, setWorkerId] = useState("");
  const [shiftId, setShiftId] = useState("");
  const [response, setResponse] = useState<"accept" | "decline" | "no_answer" | "busy">("accept");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.workers({ status: "active" }), api.shifts({ status: "open" })]).then(([workerData, shiftData]) => {
      setWorkers(workerData); setShifts(shiftData);
      setWorkerId(workerData[0]?.id ?? ""); setShiftId(shiftData[0]?.id ?? "");
    }).catch((error) => notify({ kind: "error", message: displayError(error) })).finally(() => setLoading(false));
  }, []);

  const selectedWorker = workers.find((worker) => worker.id === workerId);
  const selectedShift = shifts.find((shift) => shift.id === shiftId);
  const run = async (event: FormEvent) => {
    event.preventDefault();
    setRunning(true); setResult(null);
    try {
      const simulation = await api.simulate({ workerId, shiftId, response });
      setResult(simulation);
      notify({ kind: "success", message: "Simulation completed and activity was recorded." });
    } catch (error) { notify({ kind: "error", message: displayError(error) }); }
    finally { setRunning(false); }
  };

  return (
    <>
      <PageHeader eyebrow="Safe test environment" title="Demo lab" description="Run a complete scheduling conversation without placing a real phone call." actions={<span className="sandbox-badge"><ShieldCheck size={15} /> Simulation mode</span>} />
      <div className="demo-layout">
        <section className="panel demo-controls">
          <PanelHeader title="Configure the call" subtitle="Choose the worker, shift, and simulated response." />
          {loading ? <InlineLoading /> : <form onSubmit={run} className="stack-form">
            <Field label="Worker" required><select value={workerId} onChange={(event) => setWorkerId(event.target.value)} required><option value="" disabled>Select a worker</option>{workers.map((worker) => <option key={worker.id} value={worker.id}>{worker.firstName} {worker.lastName} · {worker.roles[0] ?? "Worker"}</option>)}</select></Field>
            {selectedWorker && <div className="selection-preview"><Avatar name={`${selectedWorker.firstName} ${selectedWorker.lastName}`} /><div><strong>{selectedWorker.firstName} {selectedWorker.lastName}</strong><span>{selectedWorker.phone} · {selectedWorker.voiceConsent && !selectedWorker.doNotCall ? "Voice consent verified" : "Voice contact restricted"}</span></div><PermissionIcon allowed={selectedWorker.voiceConsent && !selectedWorker.doNotCall} label="Voice" icon={<Phone size={13} />} /></div>}
            <Field label="Open shift" required><select value={shiftId} onChange={(event) => setShiftId(event.target.value)} required><option value="" disabled>Select a shift</option>{shifts.map((shift) => <option key={shift.id} value={shift.id}>{shift.role} · {shift.clientName} · {formatDateTime(shift.startsAt)}</option>)}</select></Field>
            {selectedShift && <div className="selection-preview selection-preview--shift"><span className="selection-preview__icon"><CalendarCheck size={19} /></span><div><strong>{selectedShift.role}</strong><span>{formatDateTime(selectedShift.startsAt)} · {money(selectedShift.payRateCents)}</span></div></div>}
            <fieldset className="scenario-fieldset"><legend>Simulated worker response</legend><div className="scenario-options">{([{"value":"accept","label":"Accepts shift","copy":"Worker confirms availability"},{"value":"decline","label":"Declines","copy":"Worker cannot take the shift"},{"value":"no_answer","label":"No answer","copy":"Call goes unanswered"},{"value":"busy","label":"Busy","copy":"Line is currently busy"}] as const).map((option) => <label key={option.value} className={response === option.value ? "selected" : ""}><input type="radio" name="response" value={option.value} checked={response === option.value} onChange={() => setResponse(option.value)} /><span><strong>{option.label}</strong><small>{option.copy}</small></span><i>{response === option.value && <Check size={13} />}</i></label>)}</div></fieldset>
            <button className="button button--primary button--large" disabled={running || !workerId || !shiftId}>{running ? <><LoaderCircle className="spin" size={18} /> Running conversation…</> : <><Play size={17} /> Run simulation</>}</button>
          </form>}
        </section>
        <section className="demo-stage">
          <div className="demo-stage__ambient" />
          <div className="demo-phone">
            <div className="demo-phone__notch" />
            <div className="demo-phone__status"><span>9:41</span><span>● ● ▰</span></div>
            <div className="demo-phone__content">
              {result ? <>
                <span className="result-check"><Check size={28} /></span>
                <small>SIMULATION COMPLETE</small>
                <h2>{result.status ? titleCase(result.status) : "Call complete"}</h2>
                <p>{result.message}</p>
                <div className="result-reference"><span>Call reference</span><strong>{result.callId}</strong></div>
                <Link className="button button--light" to="/communications">View call record <ArrowRight size={16} /></Link>
              </> : <>
                <span className="demo-phone__agent"><Bot size={29} /></span>
                <small>RELAY VOICE AGENT</small>
                <h2>{running ? `Calling ${selectedWorker?.firstName ?? "worker"}…` : "Ready to simulate"}</h2>
                <p>{running ? `Offering the ${selectedShift?.role ?? "selected"} shift and listening for a response.` : "Configure a scenario to preview the full scheduling workflow."}</p>
                {running ? <VoiceBars active /> : <VoiceBars />}
                <div className="demo-call-flow"><span className={running ? "complete" : ""}><Check size={12} /> Verify consent</span><i /><span className={running ? "active" : ""}><PhoneCall size={12} /> Place call</span><i /><span><CalendarCheck size={12} /> Update shift</span></div>
              </>}
            </div>
          </div>
          <p className="demo-stage__note"><ShieldCheck size={15} /> No external call is placed in simulation mode.</p>
        </section>
      </div>
    </>
  );
}

function Dialog({ title, description, onClose, children, wide = false }: { title: string; description?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const titleId = useId();
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", handleKey);
    document.body.classList.add("modal-open");
    return () => { document.removeEventListener("keydown", handleKey); document.body.classList.remove("modal-open"); };
  }, [onClose]);
  return (
    <div className="dialog-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className={`dialog ${wide ? "dialog--wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="dialog__header"><div><h2 id={titleId}>{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={21} /></button></header>
        <div className="dialog__body">{children}</div>
      </section>
    </div>
  );
}

function FormSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section className="form-section"><header><h3>{title}</h3>{description && <p>{description}</p>}</header><div>{children}</div></section>;
}

function Field({ label, hint, required, className = "", children }: { label: string; hint?: string; required?: boolean; className?: string; children: ReactNode }) {
  return <label className={`field ${className}`}><span>{label}{required && <i aria-hidden="true"> *</i>}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function Toggle({ label, description, checked, onChange, icon, danger = false }: { label: string; description: string; checked: boolean; onChange: (value: boolean) => void; icon?: ReactNode; danger?: boolean }) {
  return <label className={`toggle-row ${danger ? "toggle-row--danger" : ""}`}><span className="toggle-row__copy">{icon && <i>{icon}</i>}<span><strong>{label}</strong><small>{description}</small></span></span><input className="sr-only" type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span className="toggle" aria-hidden="true"><i /></span></label>;
}

function DialogActions({ onClose, saving, saveLabel }: { onClose: () => void; saving: boolean; saveLabel: string }) {
  return <div className="dialog-actions"><button type="button" className="button button--ghost" onClick={onClose}>Cancel</button><button type="submit" className="button button--primary" disabled={saving}>{saving ? <><LoaderCircle className="spin" size={17} /> Saving…</> : saveLabel}</button></div>;
}

function StatusBadge({ value }: { value: string }) {
  const normalized = value.toLowerCase();
  return <span className={`status-badge status-badge--${normalized}`}><i /> {titleCase(value)}</span>;
}

function Avatar({ name, size = "normal" }: { name: string; size?: "normal" | "large" }) {
  const colors = ["teal", "blue", "plum", "sand", "rose"];
  const index = Array.from(name).reduce((sum, character) => sum + character.charCodeAt(0), 0) % colors.length;
  return <span className={`avatar avatar--${colors[index]} ${size === "large" ? "avatar--large" : ""}`} aria-hidden="true">{initials(name)}</span>;
}

function VoiceBars({ active = false }: { active?: boolean }) {
  return <span className={`voice-bars ${active ? "voice-bars--active" : ""}`} aria-hidden="true">{Array.from({ length: 12 }, (_, index) => <i key={index} style={{ animationDelay: `${index * 70}ms`, height: `${8 + (index * 7) % 20}px` }} />)}</span>;
}

function PageLoading({ label }: { label: string }) {
  return <div className="page-state"><LoaderCircle className="spin" size={25} /><span>{label}</span></div>;
}

function InlineLoading() {
  return <div className="inline-loading"><LoaderCircle className="spin" size={22} /><span>Loading…</span></div>;
}

function PageError({ message, retry, compact = false }: { message: string; retry: () => void; compact?: boolean }) {
  return <div className={`page-state page-state--error ${compact ? "page-state--compact" : ""}`}><CircleAlert size={26} /><strong>We couldn’t load this view</strong><span>{message}</span><button className="button button--ghost" onClick={retry}>Try again</button></div>;
}

function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action?: ReactNode }) {
  return <div className="empty-state"><span>{icon}</span><strong>{title}</strong><p>{body}</p>{action}</div>;
}

function Toast({ notice, onDismiss }: { notice: NonNullable<Notice>; onDismiss: () => void }) {
  return <div className={`toast toast--${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}><span>{notice.kind === "success" ? <Check size={17} /> : <CircleAlert size={17} />}</span><p>{notice.message}</p><button onClick={onDismiss} aria-label="Dismiss notification"><X size={16} /></button></div>;
}
