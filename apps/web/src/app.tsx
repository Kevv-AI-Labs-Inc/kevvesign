import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity,
  Archive,
  ArrowLeft,
  BadgeCheck,
  BriefcaseBusiness,
  Building2,
  Check,
  ChevronRight,
  CircleAlert,
  Code2,
  Clock3,
  FileCheck2,
  FilePlus2,
  FileSignature,
  Files,
  FolderKanban,
  KeyRound,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  MailCheck,
  MoreHorizontal,
  PenLine,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useNavigate,
  useParams,
} from 'react-router-dom';
import type {
  ApplicationClient,
  ApplicationScope,
  Envelope,
  EvidencePackage,
  FieldType,
  RecipientRole,
  StaffPrincipal,
  Template,
  TemplateField,
  TemplateVersion,
  Transaction,
} from '@esign/contracts';
import { api, ApiError, idempotencyKey } from './api';
import { PdfCanvas, SigningDocument } from './pdf';
import { SignaturePad } from './signature-pad';

type Notice = { kind: 'success' | 'error'; message: string } | null;

const statusLabels: Record<string, string> = {
  DRAFT: 'Draft',
  PREPARED: 'Prepared',
  APPROVAL_PENDING: 'Approval',
  READY_TO_SEND: 'Ready',
  SENT: 'Sent',
  IN_PROGRESS: 'In progress',
  FINALIZING: 'Finalizing',
  COMPLETED: 'Completed',
  DECLINED: 'Declined',
  VOIDED: 'Voided',
  EXPIRED: 'Expired',
  FAILED_FINALIZATION: 'Needs attention',
  PUBLISHED: 'Published',
  RETIRED: 'Retired',
  ACTIVE: 'Active',
  REVOKED: 'Revoked',
};

function useLoad<T>(loader: () => Promise<T>, dependencies: unknown[] = []) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setError(undefined);
    void loader()
      .then((value) => active && setData(value))
      .catch(
        (caught: unknown) =>
          active && setError(caught instanceof Error ? caught.message : 'Unable to load data.'),
      );
    return () => {
      active = false;
    };
    // The caller owns the stable loader/dependency contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, refresh]);
  return { data, error, reload: () => setRefresh((value) => value + 1) };
}

export function App() {
  return (
    <Routes>
      <Route path="/sign/:token" element={<SigningPage />} />
      <Route path="/integration/launch" element={<IntegrationLaunchPage />} />
      <Route path="/portal/launch" element={<IntegrationLaunchPage legacyPath />} />
      <Route element={<StaffShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="templates" element={<TemplatesPage />} />
        <Route path="templates/:templateId/edit" element={<TemplateEditorPage />} />
        <Route path="envelopes" element={<EnvelopesPage />} />
        <Route path="envelopes/new" element={<EnvelopeCreatePage />} />
        <Route path="envelopes/:envelopeId" element={<EnvelopeDetailPage />} />
        <Route path="transactions" element={<TransactionsPage />} />
        <Route path="hr" element={<HrPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function StaffShell() {
  const { data: me, error } = useLoad(() => api<StaffPrincipal>('/v1/me'));
  const returning = useRef(false);
  const isDelegated = me?.actorType === 'integration' || me?.actorType === 'portal';
  const allows = (scope: ApplicationScope) =>
    !isDelegated || Boolean(me?.delegatedScopes?.includes(scope));
  async function returnToSource() {
    if (returning.current || !me?.returnUrl) return;
    returning.current = true;
    try {
      const result = await api<{ returnUrl: string }>('/v1/integration-sessions/logout', {
        method: 'POST',
      });
      window.location.assign(result.returnUrl);
    } catch {
      window.location.assign(me.returnUrl);
    }
  }
  if (error) {
    return (
      <div className="portal-launch-page">
        <div className="portal-launch-card error">
          <CircleAlert />
          <span className="eyebrow">Access unavailable</span>
          <h1>Open this workspace from your connected system</h1>
          <p>{error}</p>
        </div>
      </div>
    );
  }
  if (!me) {
    return (
      <div className="portal-launch-page">
        <div className="portal-launch-card">
          <LoaderCircle className="spin" /> Loading secure workspace…
        </div>
      </div>
    );
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" to="/">
          <span className="brand-seal">
            <FileSignature size={20} />
          </span>
          <span>
            <strong>Closing Room</strong>
            <small>{isDelegated ? 'Connected workspace' : 'Private e-sign'}</small>
          </span>
        </Link>
        <nav aria-label="Primary">
          {allows('envelopes:read') && (
            <SidebarLink to="/" icon={<LayoutDashboard />} label="Overview" end />
          )}
          {allows('transactions:read') && (
            <SidebarLink to="/transactions" icon={<FolderKanban />} label="Transactions" />
          )}
          {allows('envelopes:read') && (
            <SidebarLink to="/envelopes" icon={<MailCheck />} label="Envelopes" />
          )}
          {allows('templates:read') && (
            <SidebarLink to="/templates" icon={<Files />} label="Templates" />
          )}
          {!isDelegated && (
            <SidebarLink to="/hr" icon={<BriefcaseBusiness />} label="HR onboarding" />
          )}
          {!isDelegated && <span className="nav-section">Control</span>}
          {!isDelegated && <SidebarLink to="/audit" icon={<Activity />} label="Audit trail" />}
          {!isDelegated && <SidebarLink to="/settings" icon={<Settings />} label="Workspace" />}
        </nav>
        <a
          className="source-link"
          href="https://github.com/Kevv-AI-Labs-Inc/kevvesign"
          target="_blank"
          rel="noreferrer"
        >
          <Code2 size={15} /> AGPL source
        </a>
        <div className={`sidebar-foot ${isDelegated ? 'portal-user' : ''}`}>
          <span className="avatar">{me?.displayName?.slice(0, 2).toUpperCase() ?? 'ES'}</span>
          <span>
            <strong>{me?.displayName ?? 'Loading…'}</strong>
            <small>
              {me?.role.replaceAll('_', ' ') ?? ''}
              {isDelegated ? ` · via ${me?.sourceApplicationName ?? 'connected system'}` : ''}
            </small>
          </span>
          {isDelegated && me?.returnUrl && (
            <button onClick={() => void returnToSource()} aria-label="Return to connected system">
              <LogOut />
            </button>
          )}
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

function IntegrationLaunchPage({ legacyPath = false }: { legacyPath?: boolean }) {
  const navigate = useNavigate();
  const started = useRef(false);
  const [error, setError] = useState<string>();
  const [ticket] = useState(
    () => new URLSearchParams(window.location.hash.replace(/^#/, '')).get('ticket') ?? '',
  );
  useEffect(() => {
    window.history.replaceState(null, '', legacyPath ? '/portal/launch' : '/integration/launch');
    if (started.current) return;
    started.current = true;
    if (!ticket) {
      setError(
        'The launch ticket is missing. Return to the system that sent you here and try again.',
      );
      return;
    }
    void api<import('@esign/contracts').IntegrationSessionExchange>(
      '/v1/integration-sessions/exchange',
      {
        method: 'POST',
        body: JSON.stringify({ ticket }),
      },
    )
      .then((result) => navigate(result.destination, { replace: true }))
      .catch((caught: unknown) =>
        setError(
          caught instanceof Error ? caught.message : 'Connected access could not be started.',
        ),
      );
  }, [legacyPath, navigate, ticket]);
  return (
    <div className="portal-launch-page">
      <div className={`portal-launch-card ${error ? 'error' : ''}`}>
        <span className="brand-seal">
          {error ? <CircleAlert /> : <LoaderCircle className="spin" />}
        </span>
        <span className="eyebrow">Connected system · secure handoff</span>
        <h1>{error ? 'This workspace could not be opened' : 'Opening your signing workspace'}</h1>
        <p>
          {error ??
            'Verifying the one-time handoff and carrying your existing identity into eSign. No second login is required.'}
        </p>
      </div>
    </div>
  );
}

function SidebarLink({
  to,
  icon,
  label,
  end = false,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  end?: boolean;
}) {
  return (
    <NavLink to={to} end={end}>
      {icon}
      <span>{label}</span>
    </NavLink>
  );
}

function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="header-action">{action}</div>}
    </header>
  );
}

function Loading() {
  return (
    <div className="loading">
      <LoaderCircle className="spin" /> Loading secure workspace…
    </div>
  );
}

function ErrorBlock({ message }: { message: string }) {
  return (
    <div className="error-block">
      <CircleAlert />
      {message}
    </div>
  );
}

function NoticeBar({ notice, clear }: { notice: Notice; clear: () => void }) {
  if (!notice) return null;
  return (
    <div className={`notice ${notice.kind}`} role="status">
      {notice.kind === 'success' ? <Check /> : <CircleAlert />}
      <span>{notice.message}</span>
      <button onClick={clear} aria-label="Dismiss">
        <X />
      </button>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`status status-${status.toLowerCase()}`}>
      {statusLabels[status] ?? status}
    </span>
  );
}

interface DashboardData {
  workspace: { name: string };
  counts: { templates: number; drafts: number; waiting: number; completed: number };
  recentEnvelopes: Envelope[];
  recentAudit: Array<{ id: string; type: string; occurredAt: string; actorType: string }>;
}

function DashboardPage() {
  const { data, error } = useLoad(() => api<DashboardData>('/v1/dashboard'));
  if (error) return <ErrorBlock message={error} />;
  if (!data) return <Loading />;
  return (
    <>
      <PageHeader
        eyebrow="Operations ledger"
        title={`Good morning, ${data.workspace.name}`}
        description="Every agreement, every signer, one defensible chain of custody."
        action={
          <Link to="/envelopes/new" className="button primary">
            <Plus /> New envelope
          </Link>
        }
      />
      <section className="metric-grid">
        <Metric
          label="Active templates"
          value={data.counts.templates}
          icon={<Files />}
          tone="ink"
        />
        <Metric
          label="Needs preparation"
          value={data.counts.drafts}
          icon={<PenLine />}
          tone="sand"
        />
        <Metric
          label="Waiting on people"
          value={data.counts.waiting}
          icon={<Clock3 />}
          tone="blue"
        />
        <Metric
          label="Evidence sealed"
          value={data.counts.completed}
          icon={<ShieldCheck />}
          tone="green"
        />
      </section>
      <section className="dashboard-grid">
        <div className="panel ledger-panel">
          <div className="panel-title">
            <div>
              <span className="eyebrow">Live register</span>
              <h2>Recent envelopes</h2>
            </div>
            <Link to="/envelopes">
              View all <ChevronRight />
            </Link>
          </div>
          {data.recentEnvelopes.length === 0 ? (
            <EmptyState
              icon={<MailCheck />}
              title="No envelopes yet"
              body="Publish a template, then create your first signing packet."
            />
          ) : (
            <div className="list-table">
              {data.recentEnvelopes.map((envelope) => (
                <EnvelopeRow key={envelope.id} envelope={envelope} />
              ))}
            </div>
          )}
        </div>
        <div className="panel evidence-card">
          <span className="eyebrow">Evidence posture</span>
          <ShieldCheck size={38} />
          <h2>Chain intact</h2>
          <p>
            Recipient intent, document digests, audit events, and completed files are bound into one
            verifiable package.
          </p>
          <div className="evidence-line">
            <span>Invitation method</span>
            <strong>Email possession</strong>
          </div>
          <div className="evidence-line">
            <span>Real-estate retention</span>
            <strong>7 years</strong>
          </div>
          <div className="evidence-line">
            <span>Supported packs</span>
            <strong>NY · NJ · CA</strong>
          </div>
          <Link to="/audit" className="text-link">
            Inspect audit controls <ChevronRight />
          </Link>
        </div>
      </section>
    </>
  );
}

function Metric({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: number;
  icon: ReactNode;
  tone: string;
}) {
  return (
    <div className={`metric ${tone}`}>
      <div className="metric-icon">{icon}</div>
      <strong>{String(value).padStart(2, '0')}</strong>
      <span>{label}</span>
    </div>
  );
}

function EnvelopeRow({ envelope }: { envelope: Envelope }) {
  return (
    <Link className="table-row" to={`/envelopes/${envelope.id}`}>
      <div className="doc-mark">
        <FileCheck2 />
      </div>
      <div className="grow">
        <strong>{envelope.subject}</strong>
        <small>{envelope.recipients.map((item) => item.name).join(', ')}</small>
      </div>
      <StatusPill status={envelope.status} />
      <time>{new Date(envelope.updatedAt).toLocaleDateString()}</time>
      <ChevronRight />
    </Link>
  );
}

function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span>{icon}</span>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

function TemplatesPage() {
  const { data, error, reload } = useLoad(() => api<Template[]>('/v1/templates'));
  const [showUpload, setShowUpload] = useState(false);
  return (
    <>
      <PageHeader
        eyebrow="Document library"
        title="Templates"
        description="Licensed source PDFs and immutable field-map versions."
        action={
          <button className="button primary" onClick={() => setShowUpload(true)}>
            <FilePlus2 /> Upload PDF
          </button>
        }
      />
      {error && <ErrorBlock message={error} />}
      {!data ? (
        <Loading />
      ) : data.length === 0 ? (
        <EmptyState
          icon={<Files />}
          title="Your form library is empty"
          body="Upload a licensed PDF to build the first reusable signing template."
          action={
            <button className="button primary" onClick={() => setShowUpload(true)}>
              Upload first PDF
            </button>
          }
        />
      ) : (
        <div className="card-grid">
          {data.map((template) => (
            <TemplateCard key={template.id} template={template} />
          ))}
        </div>
      )}
      {showUpload && (
        <UploadTemplateDialog
          close={() => setShowUpload(false)}
          complete={() => {
            setShowUpload(false);
            reload();
          }}
        />
      )}
    </>
  );
}

function TemplateCard({ template }: { template: Template }) {
  const current =
    template.versions.find((version) => version.id === template.activeVersionId) ??
    template.versions.at(-1)!;
  return (
    <Link className="template-card" to={`/templates/${template.id}/edit`}>
      <div className="template-sheet">
        <span>{current.jurisdiction}</span>
        <FileSignature />
      </div>
      <div>
        <span className="eyebrow">{current.businessDomain.replace('_', ' ')}</span>
        <h3>{template.name}</h3>
        <p>{current.documents[0]?.name}</p>
        <div className="template-meta">
          <span>v{current.version}</span>
          <StatusPill status={current.status} />
          <span>{current.fields.length} fields</span>
        </div>
      </div>
      <ChevronRight className="card-arrow" />
    </Link>
  );
}

function UploadTemplateDialog({ close, complete }: { close: () => void; complete: () => void }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    const form = event.currentTarget;
    const values = new FormData(form);
    const file = values.get('pdf');
    if (!(file instanceof File) || !file.size) {
      setNotice({ kind: 'error', message: 'Choose a PDF file.' });
      setBusy(false);
      return;
    }
    const metadata = {
      name: values.get('name'),
      sourceName: values.get('sourceName'),
      licenseOwner: values.get('licenseOwner'),
      edition: values.get('edition'),
      effectiveDate: values.get('effectiveDate'),
      jurisdiction: values.get('jurisdiction'),
      businessDomain: values.get('businessDomain'),
      approvalRequired: values.get('approvalRequired') === 'on',
      retentionPolicyId: values.get('businessDomain') === 'HR' ? 'hr-general-3y' : 'real-estate-7y',
    };
    const body = new FormData();
    body.append('metadata', JSON.stringify(metadata));
    body.append('pdf', file);
    try {
      await api('/v1/templates', { method: 'POST', body });
      complete();
    } catch (caught) {
      setNotice({
        kind: 'error',
        message: caught instanceof Error ? caught.message : 'Upload failed.',
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="upload-title">
        <button className="icon-button modal-close" onClick={close}>
          <X />
        </button>
        <span className="eyebrow">New source record</span>
        <h2 id="upload-title">Upload licensed PDF</h2>
        <p>
          The PDF is privately stored, hashed, and checked before it enters the template editor.
        </p>
        <NoticeBar notice={notice} clear={() => setNotice(null)} />
        <form onSubmit={submit} className="form-grid">
          <label className="span-2">
            PDF file
            <input required type="file" name="pdf" accept="application/pdf,.pdf" />
          </label>
          <label>
            Template name
            <input required name="name" placeholder="NY Residential Offer" />
          </label>
          <label>
            Form/source name
            <input required name="sourceName" placeholder="Licensed association form" />
          </label>
          <label>
            License owner
            <input required name="licenseOwner" placeholder="Our brokerage" />
          </label>
          <label>
            Edition
            <input required name="edition" placeholder="2026.1" />
          </label>
          <label>
            Effective date
            <input required type="date" name="effectiveDate" />
          </label>
          <label>
            Jurisdiction
            <select name="jurisdiction" defaultValue="NY">
              <option>NY</option>
              <option>NJ</option>
              <option>CA</option>
              <option value="NONE">Not state-specific</option>
            </select>
          </label>
          <label>
            Business use
            <select name="businessDomain" defaultValue="REAL_ESTATE">
              <option value="REAL_ESTATE">Real estate</option>
              <option value="HR">HR onboarding</option>
            </select>
          </label>
          <label className="check-label">
            <input type="checkbox" name="approvalRequired" /> Require approval before send
          </label>
          <div className="modal-actions span-2">
            <button type="button" className="button secondary" onClick={close}>
              Cancel
            </button>
            <button className="button primary" disabled={busy}>
              {busy ? <LoaderCircle className="spin" /> : <FilePlus2 />} Create draft
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const fieldCatalog: Array<{ type: FieldType; label: string }> = [
  { type: 'signature', label: 'Signature' },
  { type: 'initials', label: 'Initials' },
  { type: 'signed_date', label: 'Signed date' },
  { type: 'full_name', label: 'Full name' },
  { type: 'email', label: 'Email' },
  { type: 'text', label: 'Text' },
  { type: 'multiline', label: 'Long text' },
  { type: 'checkbox', label: 'Checkbox' },
  { type: 'dropdown', label: 'Dropdown' },
  { type: 'number', label: 'Number' },
  { type: 'currency', label: 'Currency' },
  { type: 'phone', label: 'Phone' },
];

function TemplateEditorPage() {
  const { templateId = '' } = useParams();
  const navigate = useNavigate();
  const {
    data: template,
    error,
    reload,
  } = useLoad(() => api<Template>(`/v1/templates/${templateId}`), [templateId]);
  const [selected, setSelected] = useState<string>();
  const [documentIndex, setDocumentIndex] = useState(0);
  const [draft, setDraft] = useState<TemplateVersion>();
  const [notice, setNotice] = useState<Notice>(null);
  useEffect(() => {
    if (template)
      setDraft(
        template.versions.find((version) => version.status === 'DRAFT') ?? template.versions.at(-1),
      );
  }, [template]);
  if (error) return <ErrorBlock message={error} />;
  if (!template || !draft) return <Loading />;
  const document = draft.documents[documentIndex] ?? draft.documents[0];
  const role = draft.roles[0];
  if (!document || !role) return <ErrorBlock message="Template draft is incomplete." />;
  function addField(type: FieldType, placement?: { page: number; x: number; y: number }) {
    if (draft!.status !== 'DRAFT') return;
    const item = fieldCatalog.find((candidate) => candidate.type === type)!;
    const field: TemplateField = {
      id: crypto.randomUUID(),
      documentId: document!.id,
      page: placement?.page ?? 1,
      type,
      roleId: type === 'merge' ? null : role!.id,
      label: item.label,
      required: true,
      readOnly: type === 'merge',
      sensitive: false,
      tabIndex: draft!.fields.length,
      rect: {
        x: placement?.x ?? 0.12,
        y: placement?.y ?? 0.18 + (draft!.fields.length % 8) * 0.07,
        width: type === 'signature' ? 0.28 : 0.2,
        height: 0.045,
        rotation: 0,
      },
    };
    setDraft({ ...draft!, fields: [...draft!.fields, field] });
    setSelected(field.id);
  }
  function addRole() {
    if (draft!.status !== 'DRAFT') return;
    const role: RecipientRole = {
      id: crypto.randomUUID(),
      name: `Signer ${draft!.roles.length + 1}`,
      kind: 'signer',
      routingOrder: Math.max(0, ...draft!.roles.map((item) => item.routingOrder)) + 1,
    };
    setDraft({ ...draft!, roles: [...draft!.roles, role] });
  }
  function updateRole(id: string, update: Partial<RecipientRole>) {
    setDraft({
      ...draft!,
      roles: draft!.roles.map((item) => (item.id === id ? { ...item, ...update } : item)),
    });
  }
  function removeRole(id: string) {
    if (draft!.roles.length <= 1 || draft!.fields.some((field) => field.roleId === id)) {
      setNotice({
        kind: 'error',
        message:
          'Remove fields assigned to this role first; every template needs at least one role.',
      });
      return;
    }
    setDraft({ ...draft!, roles: draft!.roles.filter((item) => item.id !== id) });
  }
  async function addDocument(file: File) {
    const body = new FormData();
    body.append('pdf', file);
    body.append(
      'retentionClass',
      draft!.businessDomain === 'HR' ? 'hr-general-3y' : 'real-estate-7y',
    );
    try {
      await api(`/v1/templates/${templateId}/versions/${draft!.id}/documents`, {
        method: 'POST',
        body,
      });
      setDocumentIndex(draft!.documents.length);
      reload();
      setNotice({ kind: 'success', message: 'PDF added to the packet.' });
    } catch (caught) {
      setNotice({
        kind: 'error',
        message: caught instanceof Error ? caught.message : 'Unable to add PDF.',
      });
    }
  }
  function updateField(id: string, update: Partial<TemplateField>) {
    setDraft({
      ...draft!,
      fields: draft!.fields.map((field) => (field.id === id ? { ...field, ...update } : field)),
    });
  }
  function removeField(id: string) {
    setDraft({ ...draft!, fields: draft!.fields.filter((field) => field.id !== id) });
    setSelected(undefined);
  }
  async function save() {
    try {
      const result = await api<TemplateVersion>(
        `/v1/templates/${templateId}/versions/${draft!.id}`,
        { method: 'PATCH', body: JSON.stringify({ roles: draft!.roles, fields: draft!.fields }) },
      );
      setDraft(result);
      setNotice({ kind: 'success', message: 'Draft field map saved.' });
    } catch (caught) {
      setNotice({
        kind: 'error',
        message: caught instanceof Error ? caught.message : 'Save failed.',
      });
    }
  }
  async function publish() {
    try {
      await save();
      await api(`/v1/templates/${templateId}/versions/${draft!.id}/publish`, { method: 'POST' });
      setNotice({ kind: 'success', message: 'Immutable template version published.' });
      reload();
    } catch (caught) {
      setNotice({
        kind: 'error',
        message:
          caught instanceof ApiError && caught.details.length
            ? caught.details.map((item) => item.message).join(' ')
            : caught instanceof Error
              ? caught.message
              : 'Publish failed.',
      });
    }
  }
  const activeField = draft.fields.find((field) => field.id === selected);
  return (
    <div className="editor-page">
      <div className="editor-top">
        <button className="icon-button" onClick={() => navigate('/templates')}>
          <ArrowLeft />
        </button>
        <div>
          <span className="eyebrow">Template editor · v{draft.version}</span>
          <h1>{template.name}</h1>
        </div>
        <div className="editor-actions">
          <StatusPill status={draft.status} />
          {draft.status === 'DRAFT' && (
            <>
              <button className="button secondary" onClick={() => void save()}>
                Save draft
              </button>
              <button className="button primary" onClick={() => void publish()}>
                <BadgeCheck /> Publish version
              </button>
            </>
          )}
        </div>
      </div>
      <NoticeBar notice={notice} clear={() => setNotice(null)} />
      <div className="editor-layout">
        <aside className="field-tray">
          <span className="eyebrow">Fields</span>
          <h2>Drag intent into place</h2>
          <p>Select a field to add it, then move and resize it directly on the page.</p>
          <div className="field-catalog">
            {fieldCatalog.map((item) => (
              <button
                disabled={draft.status !== 'DRAFT'}
                draggable={draft.status === 'DRAFT'}
                key={item.type}
                onClick={() => addField(item.type)}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'copy';
                  event.dataTransfer.setData('application/x-esign-field', item.type);
                }}
              >
                <Plus />
                {item.label}
              </button>
            ))}
          </div>
        </aside>
        <section className="canvas-stage">
          <div className="canvas-toolbar">
            <div className="document-tabs">
              {draft.documents.map((item, index) => (
                <button
                  className={index === documentIndex ? 'active' : ''}
                  key={item.id}
                  onClick={() => setDocumentIndex(index)}
                >
                  {index + 1}. {item.name}
                </button>
              ))}
              {draft.status === 'DRAFT' && (
                <label className="add-pdf">
                  <Plus /> Add PDF
                  <input
                    type="file"
                    accept="application/pdf,.pdf"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void addDocument(file);
                    }}
                  />
                </label>
              )}
            </div>
            <span>
              {document.pageCount} page{document.pageCount > 1 ? 's' : ''}
            </span>
          </div>
          <PdfCanvas
            url={`/v1/templates/${templateId}/documents/${document.id}`}
            fields={draft.fields.filter((field) => field.documentId === document.id)}
            selectedId={selected}
            onSelect={setSelected}
            onChange={updateField}
            onAddField={(type, page, x, y) => addField(type, { page, x, y })}
            editable={draft.status === 'DRAFT'}
          />
        </section>
        <aside className="properties">
          <div className="properties-heading">
            <span className="eyebrow">Recipient roles</span>
            {draft.status === 'DRAFT' && (
              <button
                className="icon-button mini"
                onClick={addRole}
                aria-label="Add recipient role"
              >
                <Plus />
              </button>
            )}
          </div>
          <div className="role-editor">
            {draft.roles.map((item) => (
              <div className="role-edit" key={item.id}>
                <input
                  aria-label="Role name"
                  value={item.name}
                  onChange={(event) => updateRole(item.id, { name: event.target.value })}
                />
                <select
                  aria-label="Role kind"
                  value={item.kind}
                  onChange={(event) =>
                    updateRole(item.id, { kind: event.target.value as RecipientRole['kind'] })
                  }
                >
                  <option value="signer">Signer</option>
                  <option value="approver">Approver</option>
                  <option value="countersigner">Countersigner</option>
                  <option value="viewer">Viewer</option>
                  <option value="copy">Receives copy</option>
                </select>
                <input
                  aria-label="Routing order"
                  type="number"
                  min="1"
                  max="100"
                  value={item.routingOrder}
                  onChange={(event) =>
                    updateRole(item.id, { routingOrder: Number(event.target.value) })
                  }
                />
                <button
                  className="icon-button mini"
                  aria-label={`Remove ${item.name}`}
                  onClick={() => removeRole(item.id)}
                >
                  <X />
                </button>
              </div>
            ))}
          </div>
          <div className="property-divider" />
          <span className="eyebrow">Field properties</span>
          {activeField ? (
            <>
              <h2>{activeField.label}</h2>
              <label>
                Label
                <input
                  value={activeField.label}
                  onChange={(event) => updateField(activeField.id, { label: event.target.value })}
                />
              </label>
              <label>
                Recipient
                <select
                  value={activeField.roleId ?? ''}
                  onChange={(event) => updateField(activeField.id, { roleId: event.target.value })}
                >
                  {draft.roles.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Page
                <input
                  type="number"
                  min="1"
                  max={document.pageCount}
                  value={activeField.page}
                  onChange={(event) =>
                    updateField(activeField.id, { page: Number(event.target.value) })
                  }
                />
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={activeField.required}
                  onChange={(event) =>
                    updateField(activeField.id, { required: event.target.checked })
                  }
                />{' '}
                Required
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={activeField.sensitive}
                  onChange={(event) =>
                    updateField(activeField.id, { sensitive: event.target.checked })
                  }
                />{' '}
                Sensitive value
              </label>
              <button className="button danger ghost" onClick={() => removeField(activeField.id)}>
                Remove field
              </button>
            </>
          ) : (
            <div className="property-empty">
              <PenLine />
              <p>Select a field on the document to adjust ownership and validation.</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function EnvelopesPage() {
  const { data, error } = useLoad(() => api<Envelope[]>('/v1/envelopes'));
  const [query, setQuery] = useState('');
  const filtered = data?.filter((item) => item.subject.toLowerCase().includes(query.toLowerCase()));
  return (
    <>
      <PageHeader
        eyebrow="Signature register"
        title="Envelopes"
        description="Prepared, circulating, and sealed agreements."
        action={
          <Link className="button primary" to="/envelopes/new">
            <Plus /> New envelope
          </Link>
        }
      />
      <div className="filter-bar">
        <div className="search">
          <Search />
          <input
            aria-label="Search envelopes"
            placeholder="Search subject or recipient"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <button className="button secondary">
          <Archive /> Export register
        </button>
      </div>
      {error && <ErrorBlock message={error} />}
      {!filtered ? (
        <Loading />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<MailCheck />}
          title="No matching envelopes"
          body="Create a packet from a published template."
        />
      ) : (
        <div className="panel list-table">
          {filtered.map((envelope) => (
            <EnvelopeRow envelope={envelope} key={envelope.id} />
          ))}
        </div>
      )}
    </>
  );
}

function EnvelopeCreatePage() {
  const navigate = useNavigate();
  const { data: templates } = useLoad(() => api<Template[]>('/v1/templates'));
  const [templateId, setTemplateId] = useState(
    () => new URLSearchParams(window.location.search).get('templateId') ?? '',
  );
  const [notice, setNotice] = useState<Notice>(null);
  const selected = templates?.find((item) => item.id === templateId);
  const version = selected?.versions.find((item) => item.id === selected.activeVersionId);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!version) return;
    const form = new FormData(event.currentTarget);
    try {
      const envelope = await api<Envelope>('/v1/envelopes', {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey() },
        body: JSON.stringify({
          templateId,
          subject: form.get('subject'),
          message: form.get('message'),
          expiresAt: new Date(String(form.get('expiresAt'))).toISOString(),
          recipients: version.roles
            .filter((role) => !['copy', 'viewer'].includes(role.kind))
            .map((role) => ({
              roleId: role.id,
              name: form.get(`name-${role.id}`),
              email: form.get(`email-${role.id}`),
              ...(form.get(`code-${role.id}`) ? { accessCode: form.get(`code-${role.id}`) } : {}),
            })),
          mergeData: {},
        }),
      });
      navigate(`/envelopes/${envelope.id}`);
    } catch (caught) {
      setNotice({
        kind: 'error',
        message: caught instanceof Error ? caught.message : 'Unable to create envelope.',
      });
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="Preparation"
        title="New envelope"
        description="Choose an immutable template version, then assign the real people who will act."
      />
      <NoticeBar notice={notice} clear={() => setNotice(null)} />
      <form className="panel prepare-form" onSubmit={submit}>
        <section>
          <span className="step-number">01</span>
          <div>
            <h2>Choose the record</h2>
            <p>Only active published versions are available.</p>
            <label>
              Published template
              <select
                required
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
              >
                <option value="">Select a template…</option>
                {templates
                  ?.filter((item) => item.activeVersionId)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </label>
            {version && (
              <div className="selection-summary">
                <FileCheck2 />
                <div>
                  <strong>{selected?.name}</strong>
                  <span>
                    {version.jurisdiction} · Edition {version.edition} · {version.documents.length}{' '}
                    document(s)
                  </span>
                </div>
                <BadgeCheck />
              </div>
            )}
          </div>
        </section>
        <section>
          <span className="step-number">02</span>
          <div>
            <h2>Name the request</h2>
            <div className="form-grid">
              <label>
                Subject
                <input required name="subject" placeholder="Please sign: 18 Grove Street offer" />
              </label>
              <label>
                Expires
                <input required name="expiresAt" type="datetime-local" />
              </label>
              <label className="span-2">
                Message
                <textarea
                  name="message"
                  placeholder="A short note shown in the invitation email."
                />
              </label>
            </div>
          </div>
        </section>
        {version && (
          <section>
            <span className="step-number">03</span>
            <div>
              <h2>Assign recipients</h2>
              <p>Recipients in the same routing number sign in parallel.</p>
              <div className="recipient-stack">
                {version.roles
                  .filter((role) => !['copy', 'viewer'].includes(role.kind))
                  .map((role) => (
                    <div className="recipient-row" key={role.id}>
                      <span className="routing-badge">{role.routingOrder}</span>
                      <div>
                        <strong>{role.name}</strong>
                        <small>{role.kind}</small>
                      </div>
                      <label>
                        Name
                        <input required name={`name-${role.id}`} />
                      </label>
                      <label>
                        Email
                        <input required type="email" name={`email-${role.id}`} />
                      </label>
                      <label>
                        Access code <small>optional</small>
                        <input name={`code-${role.id}`} autoComplete="off" />
                      </label>
                    </div>
                  ))}
              </div>
            </div>
          </section>
        )}
        <div className="form-footer">
          <Link to="/envelopes" className="button secondary">
            Cancel
          </Link>
          <button className="button primary" disabled={!version}>
            <ChevronRight /> Review envelope
          </button>
        </div>
      </form>
    </>
  );
}

function EnvelopeDetailPage() {
  const { envelopeId = '' } = useParams();
  const {
    data: envelope,
    error,
    reload,
  } = useLoad(() => api<Envelope>(`/v1/envelopes/${envelopeId}`), [envelopeId]);
  const [notice, setNotice] = useState<Notice>(null);
  const [evidence, setEvidence] = useState<EvidencePackage>();
  useEffect(() => {
    if (envelope?.status === 'COMPLETED')
      void api<EvidencePackage>(`/v1/envelopes/${envelopeId}/evidence`).then(setEvidence);
  }, [envelope, envelopeId]);
  async function action(path: string, body?: object) {
    try {
      const result = await api<{ envelope?: Envelope; invitationUrls?: string[] } | Envelope>(
        `/v1/envelopes/${envelopeId}/${path}`,
        {
          method: 'POST',
          headers: path === 'send' ? { 'idempotency-key': idempotencyKey() } : {},
          body: JSON.stringify(body ?? {}),
        },
      );
      const urls = 'invitationUrls' in result ? result.invitationUrls : undefined;
      setNotice({
        kind: 'success',
        message: urls?.length ? `Sent. Development link: ${urls[0]}` : 'Envelope updated.',
      });
      reload();
    } catch (caught) {
      setNotice({
        kind: 'error',
        message: caught instanceof Error ? caught.message : 'Action failed.',
      });
    }
  }
  if (error) return <ErrorBlock message={error} />;
  if (!envelope) return <Loading />;
  return (
    <>
      <div className="detail-head">
        <div>
          <Link to="/envelopes" className="back-link">
            <ArrowLeft /> Envelopes
          </Link>
          <span className="eyebrow">Envelope · {envelope.id.slice(0, 8)}</span>
          <h1>{envelope.subject}</h1>
          <div className="detail-meta">
            <StatusPill status={envelope.status} />
            <span>{envelope.jurisdiction}</span>
            <span>Expires {new Date(envelope.expiresAt).toLocaleString()}</span>
          </div>
        </div>
        <div className="detail-actions">
          {envelope.status === 'APPROVAL_PENDING' && (
            <button className="button primary" onClick={() => void action('approve')}>
              <BadgeCheck /> Approve
            </button>
          )}
          {['PREPARED', 'READY_TO_SEND'].includes(envelope.status) && (
            <button className="button primary" onClick={() => void action('send')}>
              <MailCheck /> Send
            </button>
          )}
          {!['COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED'].includes(envelope.status) && (
            <button
              className="button danger ghost"
              onClick={() => void action('void', { reason: 'Voided by preparer' })}
            >
              Void
            </button>
          )}
          <button className="icon-button">
            <MoreHorizontal />
          </button>
        </div>
      </div>
      <NoticeBar notice={notice} clear={() => setNotice(null)} />
      <div className="detail-grid">
        <section className="panel">
          <div className="panel-title">
            <div>
              <span className="eyebrow">Routing order</span>
              <h2>People & progress</h2>
            </div>
          </div>
          <div className="routing-list">
            {envelope.recipients.map((recipient) => (
              <div className="route-item" key={recipient.id}>
                <span className="routing-badge">{recipient.routingOrder}</span>
                <span className={`route-dot route-${recipient.status.toLowerCase()}`} />{' '}
                <div className="grow">
                  <strong>{recipient.name}</strong>
                  <small>
                    {recipient.email} · {recipient.kind}
                  </small>
                </div>
                <StatusPill status={recipient.status} />
                {['ACTIVE', 'VIEWED', 'IN_PROGRESS'].includes(recipient.status) && (
                  <button
                    className="button compact"
                    onClick={async () => {
                      const result = await api<{ invitationUrl?: string }>(
                        `/v1/envelopes/${envelope.id}/recipients/${recipient.id}/resend`,
                        { method: 'POST', body: '{}' },
                      );
                      setNotice({
                        kind: 'success',
                        message: result.invitationUrl
                          ? `Resent. Development link: ${result.invitationUrl}`
                          : 'Invitation resent.',
                      });
                    }}
                  >
                    Resend
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
        <aside className="panel facts">
          <span className="eyebrow">Frozen record</span>
          <h2>Envelope facts</h2>
          <Fact label="Template version" value={envelope.templateVersionId.slice(0, 8)} />
          <Fact label="Documents" value={String(envelope.documents.length)} />
          <Fact label="Fields" value={String(envelope.fields.length)} />
          <Fact label="Assurance" value="Email invitation" />
          <Fact label="Retention" value={envelope.retentionPolicyId} />
          <Fact label="Version" value={String(envelope.version)} />
        </aside>
        {evidence && (
          <section className="panel evidence-package span-all">
            <div>
              <span className="eyebrow">Evidence sealed</span>
              <h2>Completion package</h2>
              <p>
                Manifest and completed documents passed hash verification before completion was
                announced.
              </p>
            </div>
            <div className="evidence-badge">
              <ShieldCheck />
              <strong>Verified</strong>
              <small>Retained until {new Date(evidence.retentionUntil).toLocaleDateString()}</small>
            </div>
            <div className="evidence-files">
              {evidence.files.map((file) => (
                <a
                  key={file.objectKey}
                  href={`/v1/envelopes/${envelope.id}/evidence/${encodeURIComponent(file.name)}`}
                >
                  <FileCheck2 />
                  <span>
                    <strong>{file.name}</strong>
                    <small>{file.sha256.slice(0, 16)}…</small>
                  </span>
                </a>
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TransactionsPage() {
  const { data, error, reload } = useLoad(() => api<Transaction[]>('/v1/transactions'));
  const [open, setOpen] = useState(false);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api('/v1/transactions', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'PROPERTY',
        name: form.get('name'),
        jurisdiction: form.get('jurisdiction'),
        propertyAddress: form.get('address'),
        externalReference: form.get('externalReference') || undefined,
      }),
    });
    setOpen(false);
    reload();
  }
  return (
    <>
      <PageHeader
        eyebrow="Real-estate workspace"
        title="Transactions"
        description="Property folders connect offers, counters, amendments, disclosures, and listing agreements without rewriting history."
        action={
          <button className="button primary" onClick={() => setOpen(true)}>
            <Plus /> New property
          </button>
        }
      />
      {error && <ErrorBlock message={error} />}
      {!data ? (
        <Loading />
      ) : data.length === 0 ? (
        <EmptyState
          icon={<Building2 />}
          title="No property folders"
          body="Create a transaction before grouping related agreements."
        />
      ) : (
        <div className="card-grid">
          {data.map((item) => (
            <div className="transaction-card" key={item.id}>
              <span className="jurisdiction-stamp">{item.jurisdiction}</span>
              <Building2 />
              <span className="eyebrow">Property file</span>
              <h3>{item.name}</h3>
              <p>{item.propertyAddress}</p>
              <div>
                <strong>{item.envelopeIds.length}</strong>
                <span> linked agreements</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {open && (
        <div className="modal-backdrop">
          <form className="modal" onSubmit={create}>
            <button
              type="button"
              className="icon-button modal-close"
              onClick={() => setOpen(false)}
            >
              <X />
            </button>
            <span className="eyebrow">New property file</span>
            <h2>Start a transaction</h2>
            <div className="form-grid">
              <label className="span-2">
                Transaction name
                <input required name="name" placeholder="18 Grove Street · Buyer offer" />
              </label>
              <label className="span-2">
                Property address
                <input required name="address" />
              </label>
              <label>
                Jurisdiction
                <select name="jurisdiction">
                  <option>NY</option>
                  <option>NJ</option>
                  <option>CA</option>
                </select>
              </label>
              <label>
                External reference
                <input name="externalReference" />
              </label>
            </div>
            <div className="modal-actions">
              <button type="button" className="button secondary" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className="button primary">Create file</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

function HrPage() {
  const { data } = useLoad(() => api<Template[]>('/v1/templates'));
  const hr =
    data?.filter((item) => item.versions.some((version) => version.businessDomain === 'HR')) ?? [];
  return (
    <>
      <PageHeader
        eyebrow="People operations"
        title="HR onboarding"
        description="Ordinary employment records share the signing engine while keeping document-specific retention and stricter data minimization."
        action={
          <Link to="/templates" className="button primary">
            <FilePlus2 /> Build HR packet
          </Link>
        }
      />
      <div className="scope-banner">
        <LockKeyhole />
        <div>
          <strong>Purposefully limited in version one</strong>
          <p>
            I-9, W-4, tax, medical, benefits, government ID, KBA, and notarized workflows cannot be
            marked supported.
          </p>
        </div>
      </div>
      <section className="dashboard-grid">
        <div className="panel">
          <span className="eyebrow">Approved packet shape</span>
          <h2>Offer · NDA · Policy</h2>
          <ol className="ceremony-list">
            <li>
              <span>1</span>HR prefills approved employee facts
            </li>
            <li>
              <span>2</span>Employee reviews and signs in one session
            </li>
            <li>
              <span>3</span>Employer countersigner becomes active
            </li>
            <li>
              <span>4</span>Secure completion link is delivered
            </li>
          </ol>
        </div>
        <div className="panel">
          <span className="eyebrow">Available templates</span>
          <h2>
            {hr.length} HR packet{hr.length === 1 ? '' : 's'}
          </h2>
          {hr.length ? (
            hr.map((template) => <TemplateCard key={template.id} template={template} />)
          ) : (
            <p className="muted">
              Upload ordinary onboarding PDFs and classify each document before publishing.
            </p>
          )}
        </div>
      </section>
    </>
  );
}

function AuditPage() {
  const { data } = useLoad(() => api<DashboardData>('/v1/dashboard'));
  return (
    <>
      <PageHeader
        eyebrow="Tamper-evident history"
        title="Audit trail"
        description="Security-relevant actions are chained by hash and exported with each completion package."
      />
      <div className="panel">
        <div className="audit-head">
          <ShieldCheck />
          <div>
            <strong>Append-only event chain</strong>
            <span>
              Payloads exclude signature marks, field values, document contents, and credentials.
            </span>
          </div>
        </div>
        <div className="timeline">
          {data?.recentAudit.map((event) => (
            <div key={event.id}>
              <span className="timeline-dot" />
              <time>{new Date(event.occurredAt).toLocaleString()}</time>
              <strong>{event.type}</strong>
              <small>
                {event.actorType} · {event.id.slice(0, 8)}
              </small>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function SettingsPage() {
  const {
    data: clients,
    error,
    reload,
  } = useLoad(() => api<Array<Omit<ApplicationClient, 'secretHash'>>>('/v1/application-clients'));
  const [notice, setNotice] = useState<Notice>(null);
  const [credential, setCredential] = useState<string>();
  async function createClient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const result = await api<{
        client: Omit<ApplicationClient, 'secretHash'>;
        credential: string;
      }>('/v1/application-clients', {
        method: 'POST',
        body: JSON.stringify({
          name: form.get('name'),
          scopes: [
            'templates:read',
            'templates:write',
            'transactions:read',
            'transactions:write',
            'envelopes:read',
            'envelopes:write',
            'envelopes:send',
            'evidence:read',
            'integration-sessions:create',
          ],
          connectorKey: form.get('connectorKey'),
          allowedReturnUrls: [form.get('returnUrl')],
        }),
      });
      setCredential(result.credential);
      setNotice({ kind: 'success', message: 'Integration credential created.' });
      formElement.reset();
      reload();
    } catch (caught) {
      setNotice({
        kind: 'error',
        message: caught instanceof Error ? caught.message : 'Unable to create credential.',
      });
    }
  }
  async function rotateClient(clientId: string) {
    try {
      const result = await api<{ credential: string }>(
        `/v1/application-clients/${clientId}/rotate`,
        { method: 'POST' },
      );
      setCredential(result.credential);
      setNotice({ kind: 'success', message: 'Credential rotated. The previous value is invalid.' });
      reload();
    } catch (caught) {
      setNotice({
        kind: 'error',
        message: caught instanceof Error ? caught.message : 'Unable to rotate credential.',
      });
    }
  }
  async function revokeClient(clientId: string) {
    try {
      await api(`/v1/application-clients/${clientId}/revoke`, { method: 'POST' });
      setCredential(undefined);
      setNotice({ kind: 'success', message: 'Integration credential revoked.' });
      reload();
    } catch (caught) {
      setNotice({
        kind: 'error',
        message: caught instanceof Error ? caught.message : 'Unable to revoke credential.',
      });
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="Workspace control"
        title="Security & policy"
        description="Production values are intentionally unavailable until Azure deployment credentials and named owners are supplied."
      />
      <div className="settings-grid">
        <Setting
          icon={<KeyRound />}
          title="Primary staff entry"
          value="Connected systems + OIDC"
          body="Homix, future portals, and configured identity providers use the same pluggable boundary."
        />
        <Setting
          icon={<MailCheck />}
          title="Recipient access"
          value="One secure email"
          body="Optional separately communicated access code; no second email OTP."
        />
        <Setting
          icon={<ShieldCheck />}
          title="Evidence"
          value="Manifest + audit chain"
          body="Key Vault signature and Azure SQL Ledger digest in production."
        />
        <Setting
          icon={<Archive />}
          title="Real-estate retention"
          value="7 years"
          body="Pending named broker/counsel policy approval before production."
        />
        <Setting
          icon={<Building2 />}
          title="Jurisdiction packs"
          value="NY · NJ · CA"
          body="Versioned enablement; retired editions cannot create new envelopes."
        />
        <Setting
          icon={<Users />}
          title="Direct admin console"
          value="Exception only"
          body="Reserved for template governance, credential management, and operational recovery."
        />
      </div>
      <section className="panel integration-panel">
        <div className="panel-title">
          <div>
            <span className="eyebrow">Project integrations</span>
            <h2>Application credentials</h2>
            <p>
              Connected backends use a workspace-scoped credential to call the API and issue
              one-time editor handoffs. Credentials never enter the employee's browser.
            </p>
          </div>
        </div>
        <NoticeBar notice={notice} clear={() => setNotice(null)} />
        {error && <ErrorBlock message={error} />}
        {credential && (
          <div className="credential-once" role="status">
            <div>
              <strong>Copy this credential now</strong>
              <p>Only its SHA-256 hash is retained; this value will not be shown again.</p>
            </div>
            <code>{credential}</code>
            <button
              className="button secondary"
              onClick={() => void navigator.clipboard.writeText(credential)}
            >
              Copy credential
            </button>
          </div>
        )}
        <form className="inline-create" onSubmit={createClient}>
          <label>
            Integration name
            <input name="name" required minLength={2} placeholder="Listing portal · production" />
          </label>
          <label>
            Connector key
            <input
              name="connectorKey"
              required
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              placeholder="homix-portal"
            />
          </label>
          <label>
            Allowed return URL
            <input
              name="returnUrl"
              type="url"
              required
              placeholder="https://app.example.com/esign/return"
            />
          </label>
          <button className="button primary">
            <KeyRound /> Issue credential
          </button>
        </form>
        <div className="client-list">
          {clients?.map((client) => (
            <div className="client-row" key={client.id}>
              <div>
                <strong>{client.name}</strong>
                <small>{client.scopes.join(' · ')}</small>
                <small>Connector: {client.connectorKey ?? 'legacy'}</small>
                <small>{client.allowedReturnUrls.join(' · ') || 'No return URL'}</small>
              </div>
              <StatusPill status={client.status} />
              {client.status === 'ACTIVE' && (
                <div className="row-actions">
                  <button className="button secondary" onClick={() => void rotateClient(client.id)}>
                    Rotate
                  </button>
                  <button
                    className="button danger ghost"
                    onClick={() => void revokeClient(client.id)}
                  >
                    Revoke
                  </button>
                </div>
              )}
            </div>
          ))}
          {clients?.length === 0 && (
            <p className="muted">No application credential has been issued for this workspace.</p>
          )}
        </div>
      </section>
    </>
  );
}

function Setting({
  icon,
  title,
  value,
  body,
}: {
  icon: ReactNode;
  title: string;
  value: string;
  body: string;
}) {
  return (
    <div className="setting-card">
      <span>{icon}</span>
      <div>
        <small>{title}</small>
        <h3>{value}</h3>
        <p>{body}</p>
      </div>
    </div>
  );
}

function SigningPage() {
  const { token = '' } = useParams();
  const [context, setContext] = useState<import('@esign/contracts').SigningContext>();
  const [phase, setPhase] = useState<
    'opening' | 'access-code' | 'consent' | 'sign' | 'done' | 'unavailable'
  >('opening');
  const [notice, setNotice] = useState<Notice>(null);
  const [accessCode, setAccessCode] = useState('');
  const [values, setValues] = useState<Record<string, string | boolean | string[]>>({});
  const [signatureOpen, setSignatureOpen] = useState(false);
  const [signature, setSignature] = useState<{
    kind: 'typed' | 'drawn';
    value: string;
    intentText: string;
  }>();
  const exchange = useCallback(
    async (code?: string) => {
      try {
        const result = await api<import('@esign/contracts').SigningContext>(
          '/v1/signing/session/exchange',
          {
            method: 'POST',
            body: JSON.stringify({ token, ...(code ? { accessCode: code } : {}) }),
          },
        );
        setContext(result);
        setValues(result.recipient.values);
        setSignature(
          result.recipient.signature
            ? {
                kind: result.recipient.signature.kind,
                value: result.recipient.signature.value,
                intentText: result.recipient.signature.intentText,
              }
            : undefined,
        );
        setPhase(result.recipient.consentedAt ? 'sign' : 'consent');
      } catch (caught) {
        if (caught instanceof ApiError && caught.code === 'access_code_invalid')
          setPhase('access-code');
        else setPhase('unavailable');
      }
    },
    [token],
  );
  useEffect(() => {
    void api<{ valid: boolean }>(`/v1/invitations/${encodeURIComponent(token)}`)
      .then((status) => (status.valid ? exchange() : setPhase('unavailable')))
      .catch(() => setPhase('unavailable'));
  }, [token, exchange]);
  async function consent() {
    if (!context) return;
    try {
      const next = await api<import('@esign/contracts').SigningContext>('/v1/signing/consent', {
        method: 'POST',
        body: JSON.stringify({ accepted: true, disclosureVersion: context.disclosure.version }),
      });
      setContext(next);
      setPhase('sign');
    } catch (caught) {
      setNotice({
        kind: 'error',
        message: caught instanceof Error ? caught.message : 'Consent failed.',
      });
    }
  }
  async function save(showNotice = true) {
    if (!context) return;
    const next = await api<import('@esign/contracts').SigningContext>('/v1/signing/progress', {
      method: 'POST',
      body: JSON.stringify({
        expectedEnvelopeVersion: context.envelope.version,
        values,
        ...(signature ? { signature } : {}),
      }),
    });
    setContext(next);
    if (showNotice) setNotice({ kind: 'success', message: 'Progress saved securely.' });
  }
  async function finish() {
    try {
      await save(false);
      await api('/v1/signing/finish', { method: 'POST', body: '{}' });
      setPhase('done');
    } catch (caught) {
      setNotice({
        kind: 'error',
        message:
          caught instanceof ApiError && caught.details.length
            ? caught.details.map((item) => item.message).join(' ')
            : caught instanceof Error
              ? caught.message
              : 'Unable to finish.',
      });
    }
  }
  if (phase === 'opening')
    return (
      <SignerFrame>
        <div className="signer-center">
          <LoaderCircle className="spin large" />
          <span className="eyebrow">Opening secure record</span>
          <h1>Preparing your documents…</h1>
          <p>No account or second verification email is required.</p>
        </div>
      </SignerFrame>
    );
  if (phase === 'access-code')
    return (
      <SignerFrame>
        <div className="signer-card">
          <KeyRound />
          <span className="eyebrow">Additional protection</span>
          <h1>Enter the access code</h1>
          <p>
            The sender communicated this code separately; it is never included in the invitation
            email.
          </p>
          <label>
            Access code
            <input
              autoFocus
              value={accessCode}
              onChange={(event) => setAccessCode(event.target.value)}
            />
          </label>
          <button className="button primary wide" onClick={() => void exchange(accessCode)}>
            Continue
          </button>
        </div>
      </SignerFrame>
    );
  if (phase === 'unavailable')
    return (
      <SignerFrame>
        <div className="signer-card">
          <CircleAlert />
          <span className="eyebrow">Link unavailable</span>
          <h1>This invitation can’t be used</h1>
          <p>
            It may have expired, been replaced, or the envelope may already be complete. Contact the
            sender for a new invitation.
          </p>
        </div>
      </SignerFrame>
    );
  if (phase === 'done')
    return (
      <SignerFrame>
        <div className="signer-card done">
          <BadgeCheck />
          <span className="eyebrow">Your action is recorded</span>
          <h1>Thank you. You’re finished.</h1>
          <p>
            The platform is finalizing the completed PDF and evidence package. The sender can
            retrieve the verified package and provide your entitled copy.
          </p>
        </div>
      </SignerFrame>
    );
  if (!context) return null;
  if (phase === 'consent')
    return (
      <SignerFrame>
        <div className="disclosure">
          <div className="disclosure-mark">
            <FileSignature />
          </div>
          <span className="eyebrow">Before you continue</span>
          <h1>{context.disclosure.title}</h1>
          <p>{context.disclosure.body}</p>
          <div className="paper-notice">
            <strong>Paper option and withdrawal</strong>
            <span>
              You may download or print the records and contact the sender before finishing if you
              prefer not to sign electronically.
            </span>
          </div>
          <button className="button primary wide" onClick={() => void consent()}>
            <Check /> I agree and want to continue
          </button>
          <small>Disclosure version {context.disclosure.version}</small>
        </div>
      </SignerFrame>
    );
  return (
    <div className="signing-workspace">
      <header className="signing-header">
        <div className="brand compact">
          <span className="brand-seal">
            <FileSignature />
          </span>
          <span>
            <strong>Closing Room</strong>
            <small>Secure signing</small>
          </span>
        </div>
        <div className="signer-subject">
          <strong>{context.envelope.subject}</strong>
          <span>Assigned to {context.recipient.name}</span>
        </div>
        <div className="secure-chip">
          <LockKeyhole /> Secure session
        </div>
      </header>
      <NoticeBar notice={notice} clear={() => setNotice(null)} />
      <main className="signer-main">
        <aside className="signer-guide">
          <span className="eyebrow">Your checklist</span>
          <h2>Finish every marked field</h2>
          <div className="progress-ring">
            <strong>{Object.keys(values).length}</strong>
            <span>of {context.fields.filter((field) => field.required).length}</span>
          </div>
          <p>
            Required fields are outlined in green. Your progress can be saved and resumed from the
            same invitation.
          </p>
          <button className="button secondary wide" onClick={() => void save()}>
            <Clock3 /> Save progress
          </button>
          <button
            className="text-button danger"
            onClick={() => {
              if (confirm('Decline this envelope?'))
                void api('/v1/signing/decline', {
                  method: 'POST',
                  body: JSON.stringify({ reason: '' }),
                }).then(() => setPhase('done'));
            }}
          >
            Decline to sign
          </button>
        </aside>
        <section className="signer-document">
          {context.envelope.documents.map((document, index) => (
            <article className="signer-packet-document" key={document.id}>
              <header>
                <span>
                  Document {index + 1} of {context.envelope.documents.length}
                </span>
                <strong>{document.name}</strong>
              </header>
              <SigningDocument
                url={`/v1/signing/documents/${document.id}`}
                fields={context.fields.filter((field) => field.documentId === document.id)}
                values={values}
                signature={signature?.value}
                onValue={(fieldId, value) =>
                  setValues((current) => ({ ...current, [fieldId]: value }))
                }
                onSignature={() => setSignatureOpen(true)}
              />
            </article>
          ))}
        </section>
      </main>
      <footer className="signing-footer">
        <div>
          <ShieldCheck />
          <span>
            <strong>Your actions are evidence-bound</strong>
            <small>Email invitation possession · Encrypted transport · Audit recorded</small>
          </span>
        </div>
        <button className="button primary finish" onClick={() => void finish()}>
          Adopt & finish <ChevronRight />
        </button>
      </footer>
      {signatureOpen && (
        <SignaturePad
          name={context.recipient.name}
          close={() => setSignatureOpen(false)}
          adopt={(next) => {
            setSignature({
              ...next,
              intentText:
                'I intend this electronic mark to be my signature for the assigned records.',
            });
            setSignatureOpen(false);
          }}
        />
      )}
    </div>
  );
}

function SignerFrame({ children }: { children: ReactNode }) {
  return (
    <div className="signer-frame">
      <div className="signer-brand">
        <span className="brand-seal">
          <FileSignature />
        </span>
        <strong>Closing Room</strong>
        <span className="secure-chip">
          <LockKeyhole /> Secure invitation
        </span>
      </div>
      {children}
      <footer>Electronic signing service · The sender can provide a paper copy on request.</footer>
    </div>
  );
}
