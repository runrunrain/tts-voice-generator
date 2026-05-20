import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, FileKey2, Loader2, RefreshCw, RotateCcw, Search, ShieldAlert, ShieldCheck, Sparkles, XCircle } from "lucide-react";
import { ApiError } from "../services/httpAdapter";
import { useAppState } from "../state/AppContext";
import type { CreateLicenseRecordRequest, CreateSourceTermsRequest, CreateVoiceAssetRequest, LicenseStatus, ProviderId, VoiceAsset, VoiceAssetDetail, VoiceAssetStatus, VoiceAssetType } from "../types";

const ASSET_TYPES: Array<{ value: VoiceAssetType | "all"; label: string }> = [
  { value: "all", label: "全部类型" },
  { value: "gemini_preset", label: "Gemini 预设" },
  { value: "fish_platform", label: "Fish 平台音色" },
  { value: "custom_cloned", label: "授权克隆" },
  { value: "custom_designed", label: "设计音色" },
  { value: "custom_imported", label: "导入音色" },
];

const ASSET_STATUSES: Array<{ value: VoiceAssetStatus | "all"; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "draft", label: "草稿" },
  { value: "license_pending", label: "待授权" },
  { value: "legal_review_required", label: "待法务" },
  { value: "ready_for_model_creation", label: "可建模" },
  { value: "model_creating", label: "建模中" },
  { value: "active", label: "可用" },
  { value: "revoked", label: "已撤销" },
  { value: "failed", label: "失败" },
];

const PROVIDERS: Array<{ value: ProviderId | "all"; label: string }> = [
  { value: "all", label: "全部供应商" },
  { value: "openrouter-gemini", label: "Gemini" },
  { value: "elevenlabs", label: "ElevenLabs STS" },
  { value: "fish-audio", label: "Fish Audio TTS" },
];

const LICENSE_STATUSES: Array<{ value: LicenseStatus; label: string }> = [
  { value: "pending", label: "pending" },
  { value: "approved", label: "approved" },
  { value: "revoked", label: "revoked" },
  { value: "expired", label: "expired" },
  { value: "legal_review_required", label: "legal_review_required" },
];

function getErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const record = body as Record<string, unknown>;
      const code = typeof record.code === "string" ? record.code : `HTTP_${err.status}`;
      const message = typeof record.message === "string" ? record.message : err.message;
      const details = record.details ? ` · ${formatJsonBrief(record.details)}` : "";
      return `${code}: ${message}${details}`;
    }
  }
  return err instanceof Error ? err.message : "未知错误";
}

function formatJsonBrief(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 180 ? `${text.slice(0, 180)}...` : text;
  } catch {
    return String(value);
  }
}

function statusTone(status: VoiceAssetStatus) {
  if (status === "active") return "border-success/20 bg-success-muted/20 text-success";
  if (status === "revoked" || status === "failed") return "border-error/20 bg-error-muted/25 text-error";
  if (status === "legal_review_required" || status === "license_pending") return "border-warning/25 bg-warning-muted/25 text-warning";
  return "border-border-subtle bg-bg-sunken text-text-secondary";
}

function labelFor<T extends string>(items: Array<{ value: T | "all"; label: string }>, value: T | null | undefined) {
  return items.find((item) => item.value === value)?.label ?? value ?? "未绑定";
}

function deriveGateBlocks(asset: VoiceAsset): string[] {
  const blocks: string[] = [];
  if (asset.type.startsWith("custom_") && !asset.licenseRecordId) blocks.push("LICENSE_REQUIRED");
  if (asset.status === "legal_review_required") blocks.push("LEGAL_REVIEW_REQUIRED");
  if (asset.status === "license_pending") blocks.push("LICENSE_PENDING");
  if (asset.status === "revoked") blocks.push("ASSET_REVOKED");
  if (asset.status === "failed") blocks.push("ASSET_FAILED");
  if (asset.provider === "elevenlabs" && !asset.providerVoiceId) blocks.push("PROVIDER_VOICE_ID_REQUIRED");
  if (asset.provider === "fish-audio" && !asset.fishReferenceId) blocks.push("FISH_REFERENCE_ID_REQUIRED");
  return blocks;
}

export function VoiceAssetsPage() {
  const { adapter } = useAppState();
  const [items, setItems] = useState<VoiceAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [phase, setPhase] = useState<"loading" | "success" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [type, setType] = useState<VoiceAssetType | "all">("all");
  const [status, setStatus] = useState<VoiceAssetStatus | "all">("all");
  const [provider, setProvider] = useState<ProviderId | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<VoiceAssetDetail | null>(null);
  const [detailPhase, setDetailPhase] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [detailError, setDetailError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const [createForm, setCreateForm] = useState<CreateVoiceAssetRequest>({
    name: "",
    type: "custom_imported",
    provider: "fish-audio",
    fishReferenceId: "",
    providerVoiceId: "",
    licenseRecordId: "",
    sourceTermsSnapshotId: "",
    metadata: {},
  });
  const [createPhase, setCreatePhase] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [createError, setCreateError] = useState<string | null>(null);

  const [licenseForm, setLicenseForm] = useState({ status: "pending" as LicenseStatus, scope: "production_generate,audition", evidenceUri: "", crossPlatformCloneAllowed: false, notes: "" });
  const [sourceForm, setSourceForm] = useState({ sourceType: "voice_design", sourceTool: "", termsVersion: "", contractUri: "", termsTextHash: "" });

  const supportsRegistry = Boolean(adapter.listVoiceAssets && adapter.getVoiceAsset);

  const loadList = useCallback(async () => {
    if (!adapter.listVoiceAssets) return;
    setPhase("loading");
    setError(null);
    try {
      const result = await adapter.listVoiceAssets({ q, type, status, provider });
      setItems(result.items);
      setTotal(result.total);
      setPhase("success");
      setSelectedId((current) => current ?? result.items[0]?.id ?? null);
    } catch (err) {
      setError(getErrorMessage(err));
      setPhase("error");
    }
  }, [adapter, provider, q, status, type]);

  useEffect(() => { void loadList(); }, [loadList]);

  const loadDetail = useCallback(async (id: string) => {
    if (!adapter.getVoiceAsset) return;
    setDetailPhase("loading");
    setDetailError(null);
    try {
      const result = await adapter.getVoiceAsset(id);
      setDetail(result);
      setDetailPhase("success");
    } catch (err) {
      setDetailError(getErrorMessage(err));
      setDetailPhase("error");
    }
  }, [adapter]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailPhase("idle");
      return;
    }
    void loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  const selected = detail?.voiceAsset ?? items.find((item) => item.id === selectedId) ?? null;
  const selectedBlocks = useMemo(() => selected ? deriveGateBlocks(selected) : [], [selected]);

  const handleCreate = async () => {
    if (!adapter.createVoiceAsset) return;
    setCreatePhase("loading");
    setCreateError(null);
    const payload: CreateVoiceAssetRequest = {
      name: createForm.name.trim(),
      type: createForm.type,
      provider: createForm.provider,
      providerVoiceId: createForm.providerVoiceId?.trim() || undefined,
      fishReferenceId: createForm.fishReferenceId?.trim() || undefined,
      licenseRecordId: createForm.licenseRecordId?.trim() || undefined,
      sourceTermsSnapshotId: createForm.sourceTermsSnapshotId?.trim() || undefined,
      metadata: { uiCreated: true, strategy: "voice-asset-registry" },
    };
    try {
      const result = await adapter.createVoiceAsset(payload);
      setCreatePhase("success");
      setActionMessage({ tone: "success", text: `已创建资产：${result.voiceAsset.name}` });
      setSelectedId(result.voiceAsset.id);
      setCreateForm((prev) => ({ ...prev, name: "", providerVoiceId: "", fishReferenceId: "", licenseRecordId: "", sourceTermsSnapshotId: "" }));
      await loadList();
    } catch (err) {
      setCreatePhase("error");
      setCreateError(getErrorMessage(err));
    }
  };

  const handleUpdateName = async () => {
    if (!selected || !adapter.updateVoiceAsset) return;
    const nextName = window.prompt("输入新的资产名称", selected.name)?.trim();
    if (!nextName) return;
    try {
      const result = await adapter.updateVoiceAsset(selected.id, { name: nextName });
      setActionMessage({ tone: "success", text: `已更新名称：${result.voiceAsset.name}` });
      await loadList();
      await loadDetail(selected.id);
    } catch (err) {
      setActionMessage({ tone: "error", text: getErrorMessage(err) });
    }
  };

  const handleActivate = async () => {
    if (!selected || !adapter.activateVoiceAsset) return;
    try {
      const result = await adapter.activateVoiceAsset(selected.id);
      setActionMessage({ tone: "success", text: `后端 Gate 通过，资产已激活：${result.voiceAsset.name}` });
      await loadList();
      await loadDetail(selected.id);
    } catch (err) {
      setActionMessage({ tone: "error", text: getErrorMessage(err) });
    }
  };

  const handleRevoke = async () => {
    if (!selected || !adapter.revokeVoiceAsset) return;
    const reason = window.prompt("撤销原因（会写入资产元数据）", "用户在前端 Registry 撤销")?.trim();
    if (!reason) return;
    try {
      const result = await adapter.revokeVoiceAsset(selected.id, reason);
      setActionMessage({ tone: "success", text: `已撤销资产：${result.voiceAsset.name}` });
      await loadList();
      await loadDetail(selected.id);
    } catch (err) {
      setActionMessage({ tone: "error", text: getErrorMessage(err) });
    }
  };

  const handleCreateLicense = async () => {
    if (!selected || !adapter.createLicenseRecord) return;
    const payload: CreateLicenseRecordRequest = {
      voiceAssetId: selected.id,
      status: licenseForm.status,
      scope: { actions: licenseForm.scope.split(",").map((item) => item.trim()).filter(Boolean) },
      evidenceUri: licenseForm.evidenceUri.trim() || undefined,
      crossPlatformCloneAllowed: licenseForm.crossPlatformCloneAllowed,
      notes: licenseForm.notes.trim() || undefined,
    };
    try {
      const result = await adapter.createLicenseRecord(payload);
      setActionMessage({ tone: "success", text: `已创建授权记录：${result.licenseRecord.id}` });
      await loadDetail(selected.id);
      await loadList();
    } catch (err) {
      setActionMessage({ tone: "error", text: getErrorMessage(err) });
    }
  };

  const handleCreateSourceTerms = async () => {
    if (!adapter.createSourceTerms) return;
    const payload: CreateSourceTermsRequest = {
      sourceType: sourceForm.sourceType.trim(),
      sourceTool: sourceForm.sourceTool.trim() || undefined,
      termsVersion: sourceForm.termsVersion.trim() || undefined,
      contractUri: sourceForm.contractUri.trim() || undefined,
      termsTextHash: sourceForm.termsTextHash.trim() || undefined,
      metadata: { capturedBy: "voice-assets-ui" },
    };
    try {
      const result = await adapter.createSourceTerms(payload);
      setActionMessage({ tone: "success", text: `已创建来源条款快照，可在创建资产时填入：${result.sourceTermsSnapshot.id}` });
      setCreateForm((prev) => ({ ...prev, sourceTermsSnapshotId: result.sourceTermsSnapshot.id }));
    } catch (err) {
      setActionMessage({ tone: "error", text: getErrorMessage(err) });
    }
  };

  if (!supportsRegistry) {
    return <div className="flex h-full items-center justify-center text-sm text-error">当前适配器不支持 Voice Asset Registry。</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="border-b border-border-subtle px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-display text-lg font-semibold text-text-primary">Voice Asset Registry</h1>
            <p className="mt-1 text-xs text-text-tertiary">高识别度音色资产、授权与后端 Gate 状态入口。前端只解释阻断，最终判断仍由后端 License Gate 执行。</p>
          </div>
          <button className="flex items-center gap-2 rounded-md border border-border bg-bg-surface px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-hover" onClick={loadList} disabled={phase === "loading"}>
            <RefreshCw size={14} className={phase === "loading" ? "animate-spin" : undefined} /> 刷新
          </button>
        </div>
      </div>

      <div className="grid flex-1 min-h-0 grid-cols-1 overflow-hidden @6xl/main:grid-cols-[minmax(360px,0.9fr)_minmax(420px,1.1fr)]">
        <section className="flex min-h-0 flex-col border-r border-border-subtle">
          <div className="shrink-0 space-y-3 border-b border-border-subtle bg-bg-sunken/45 px-4 py-3">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
              <input className="w-full rounded-md border border-border bg-bg-surface py-1.5 pl-8 pr-3 text-sm text-text-primary outline-none focus:border-border-focus" placeholder="搜索资产名称" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <select className="rounded border border-border bg-bg-surface px-2 py-1 text-xs text-text-primary" value={type} onChange={(e) => setType(e.target.value as VoiceAssetType | "all")}>{ASSET_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
              <select className="rounded border border-border bg-bg-surface px-2 py-1 text-xs text-text-primary" value={status} onChange={(e) => setStatus(e.target.value as VoiceAssetStatus | "all")}>{ASSET_STATUSES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
              <select className="rounded border border-border bg-bg-surface px-2 py-1 text-xs text-text-primary" value={provider} onChange={(e) => setProvider(e.target.value as ProviderId | "all")}>{PROVIDERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {phase === "loading" && items.length === 0 ? <StateBlock icon={<Loader2 className="animate-spin" size={22} />} title="正在加载资产" text="调用 GET /api/voice-assets" /> : null}
            {phase === "error" && items.length === 0 ? <StateBlock icon={<AlertCircle size={22} />} title="加载失败" text={error ?? "未知错误"} tone="error" /> : null}
            {phase === "success" && items.length === 0 ? <StateBlock icon={<Sparkles size={22} />} title="暂无音色资产" text="可先创建来源条款或登记 Gemini/Fish/ElevenLabs 资产。" /> : null}
            {items.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs text-text-tertiary">共 {total} 个资产</div>
                {items.map((asset) => {
                  const blocks = deriveGateBlocks(asset);
                  return (
                    <button key={asset.id} className={`w-full rounded-lg border p-3 text-left transition-colors ${selectedId === asset.id ? "border-accent/40 bg-accent-subtle" : "border-border bg-bg-surface hover:bg-bg-hover"}`} onClick={() => setSelectedId(asset.id)}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-text-primary">{asset.name}</div>
                          <div className="mt-1 truncate font-mono text-[11px] text-text-tertiary">{asset.id}</div>
                        </div>
                        <span className={`shrink-0 rounded border px-2 py-0.5 text-[10px] ${statusTone(asset.status)}`}>{labelFor(ASSET_STATUSES, asset.status)}</span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-text-secondary">
                        <span className="rounded bg-bg-sunken px-1.5 py-0.5">{labelFor(ASSET_TYPES, asset.type)}</span>
                        <span className="rounded bg-bg-sunken px-1.5 py-0.5">{labelFor(PROVIDERS, asset.provider)}</span>
                        <span className={`rounded px-1.5 py-0.5 ${blocks.length ? "bg-warning-muted text-warning" : "bg-success-muted text-success"}`}>{blocks.length ? `${blocks.length} 个阻断提示` : "无本地阻断"}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <section className="min-h-0 overflow-y-auto p-4 sm:p-6">
          {actionMessage && <div className={`mb-4 rounded-md border px-3 py-2 text-xs ${actionMessage.tone === "success" ? "border-success/20 bg-success-muted/20 text-success" : "border-error/20 bg-error-muted/25 text-error"}`}>{actionMessage.text}</div>}

          <div className="grid gap-4 @6xl/main:grid-cols-2">
            <div className="rounded-lg border border-border bg-bg-surface p-4">
              <h2 className="text-sm font-semibold text-text-primary">创建资产</h2>
              <p className="mt-1 text-xs text-text-tertiary">自定义资产缺授权时后端会返回 LICENSE_REQUIRED，不在前端伪造可用。</p>
              <div className="mt-3 space-y-2 text-xs">
                <input className="w-full rounded border border-border bg-bg-sunken px-2 py-1.5 text-text-primary" placeholder="资产名称" value={createForm.name} onChange={(e) => setCreateForm((prev) => ({ ...prev, name: e.target.value }))} />
                <div className="grid grid-cols-2 gap-2">
                  <select className="rounded border border-border bg-bg-sunken px-2 py-1.5 text-text-primary" value={createForm.type} onChange={(e) => setCreateForm((prev) => ({ ...prev, type: e.target.value as VoiceAssetType }))}>{ASSET_TYPES.filter((item) => item.value !== "all").map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
                  <select className="rounded border border-border bg-bg-sunken px-2 py-1.5 text-text-primary" value={createForm.provider ?? "fish-audio"} onChange={(e) => setCreateForm((prev) => ({ ...prev, provider: e.target.value as ProviderId }))}>{PROVIDERS.filter((item) => item.value !== "all").map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
                </div>
                <input className="w-full rounded border border-border bg-bg-sunken px-2 py-1.5 text-text-primary" placeholder="ElevenLabs voice_id（路线 A 需要）" value={createForm.providerVoiceId ?? ""} onChange={(e) => setCreateForm((prev) => ({ ...prev, providerVoiceId: e.target.value }))} />
                <input className="w-full rounded border border-border bg-bg-sunken px-2 py-1.5 text-text-primary" placeholder="Fish reference_id（路线 B 需要）" value={createForm.fishReferenceId ?? ""} onChange={(e) => setCreateForm((prev) => ({ ...prev, fishReferenceId: e.target.value }))} />
                <input className="w-full rounded border border-border bg-bg-sunken px-2 py-1.5 text-text-primary" placeholder="licenseRecordId（自定义资产必填）" value={createForm.licenseRecordId ?? ""} onChange={(e) => setCreateForm((prev) => ({ ...prev, licenseRecordId: e.target.value }))} />
                <input className="w-full rounded border border-border bg-bg-sunken px-2 py-1.5 text-text-primary" placeholder="sourceTermsSnapshotId" value={createForm.sourceTermsSnapshotId ?? ""} onChange={(e) => setCreateForm((prev) => ({ ...prev, sourceTermsSnapshotId: e.target.value }))} />
                {createError && <div className="rounded border border-error/20 bg-error-muted/25 px-2 py-1.5 text-error">{createError}</div>}
                <button className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 font-medium text-bg-base disabled:opacity-50" onClick={handleCreate} disabled={createPhase === "loading" || !createForm.name.trim()}>{createPhase === "loading" && <Loader2 size={14} className="animate-spin" />}创建真实后端资产</button>
              </div>
            </div>

            <div className="rounded-lg border border-border bg-bg-surface p-4">
              <h2 className="text-sm font-semibold text-text-primary">来源条款快照</h2>
              <p className="mt-1 text-xs text-text-tertiary">需提供 contractUri 或 termsTextHash；保存后将 ID 填入创建表单。</p>
              <div className="mt-3 space-y-2 text-xs">
                <input className="w-full rounded border border-border bg-bg-sunken px-2 py-1.5 text-text-primary" placeholder="sourceType" value={sourceForm.sourceType} onChange={(e) => setSourceForm((prev) => ({ ...prev, sourceType: e.target.value }))} />
                <input className="w-full rounded border border-border bg-bg-sunken px-2 py-1.5 text-text-primary" placeholder="sourceTool" value={sourceForm.sourceTool} onChange={(e) => setSourceForm((prev) => ({ ...prev, sourceTool: e.target.value }))} />
                <input className="w-full rounded border border-border bg-bg-sunken px-2 py-1.5 text-text-primary" placeholder="termsVersion" value={sourceForm.termsVersion} onChange={(e) => setSourceForm((prev) => ({ ...prev, termsVersion: e.target.value }))} />
                <input className="w-full rounded border border-border bg-bg-sunken px-2 py-1.5 text-text-primary" placeholder="contractUri" value={sourceForm.contractUri} onChange={(e) => setSourceForm((prev) => ({ ...prev, contractUri: e.target.value }))} />
                <input className="w-full rounded border border-border bg-bg-sunken px-2 py-1.5 text-text-primary" placeholder="termsTextHash" value={sourceForm.termsTextHash} onChange={(e) => setSourceForm((prev) => ({ ...prev, termsTextHash: e.target.value }))} />
                <button className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-bg-sunken px-3 py-2 font-medium text-text-primary hover:bg-bg-hover" onClick={handleCreateSourceTerms}><FileKey2 size={14} />保存条款快照</button>
              </div>
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-border bg-bg-surface p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-text-primary">资产详情与 Gate 状态</h2>
                <p className="mt-1 text-xs text-text-tertiary">显示 source/license/provider binding，阻断原因按后端契约原码展示。</p>
              </div>
              {selected && <div className="flex flex-wrap gap-2 text-xs"><button className="rounded border border-border px-2 py-1 hover:bg-bg-hover" onClick={handleUpdateName}>编辑名称</button><button className="rounded border border-success/30 px-2 py-1 text-success hover:bg-success-muted" onClick={handleActivate}><ShieldCheck size={12} className="mr-1 inline" />激活</button><button className="rounded border border-error/30 px-2 py-1 text-error hover:bg-error-muted" onClick={handleRevoke}><RotateCcw size={12} className="mr-1 inline" />撤销</button></div>}
            </div>

            {!selectedId && <StateBlock icon={<Sparkles size={22} />} title="选择一个资产" text="左侧列表用于查看后端返回的真实资产。" />}
            {detailPhase === "loading" && <StateBlock icon={<Loader2 className="animate-spin" size={22} />} title="正在加载详情" text="调用 GET /api/voice-assets/:id" />}
            {detailPhase === "error" && <StateBlock icon={<AlertCircle size={22} />} title="详情加载失败" text={detailError ?? "未知错误"} tone="error" />}
            {selected && detailPhase !== "loading" && (
              <div className="mt-4 space-y-4 text-xs">
                <div className="grid gap-2 sm:grid-cols-2">
                  <Info label="名称" value={selected.name} />
                  <Info label="状态" value={labelFor(ASSET_STATUSES, selected.status)} toneClass={statusTone(selected.status)} />
                  <Info label="类型" value={labelFor(ASSET_TYPES, selected.type)} />
                  <Info label="供应商" value={labelFor(PROVIDERS, selected.provider)} />
                  <Info label="providerVoiceId" value={selected.providerVoiceId ?? "未绑定"} mono />
                  <Info label="fishReferenceId" value={selected.fishReferenceId ?? "未绑定"} mono />
                  <Info label="licenseRecordId" value={selected.licenseRecordId ?? "未绑定"} mono />
                  <Info label="sourceTermsSnapshotId" value={selected.sourceTermsSnapshotId ?? "未绑定"} mono />
                </div>
                <div className={`rounded-md border p-3 ${selectedBlocks.length ? "border-warning/25 bg-warning-muted/20" : "border-success/20 bg-success-muted/15"}`}>
                  <div className="flex items-center gap-2 font-medium"><ShieldAlert size={14} />本地 Gate 摘要</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">{selectedBlocks.length ? selectedBlocks.map((block) => <span key={block} className="rounded bg-bg-base px-2 py-1 font-mono text-warning">{block}</span>) : <span className="text-success">无本地阻断；仍需后端 Gate 最终确认。</span>}</div>
                </div>
                <div>
                  <h3 className="mb-2 font-semibold text-text-primary">授权记录</h3>
                  {detail?.licenses.length ? detail.licenses.map((lic) => <div key={lic.id} className="mb-2 rounded border border-border-subtle bg-bg-sunken p-2"><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-text-primary">{lic.id}</span><span className={`rounded px-1.5 py-0.5 ${lic.status === "approved" ? "bg-success-muted text-success" : "bg-warning-muted text-warning"}`}>{lic.status}</span><span>{lic.crossPlatformCloneAllowed ? "cross-platform allowed" : "cross-platform blocked"}</span></div><div className="mt-1 text-text-tertiary">scope: {formatJsonBrief(lic.scope)}</div></div>) : <p className="text-text-tertiary">暂无授权记录。</p>}
                  {selected && <div className="mt-3 rounded border border-border-subtle bg-bg-sunken p-3"><div className="mb-2 font-medium text-text-primary">为当前资产创建授权</div><div className="grid gap-2 sm:grid-cols-2"><select className="rounded border border-border bg-bg-surface px-2 py-1.5 text-text-primary" value={licenseForm.status} onChange={(e) => setLicenseForm((prev) => ({ ...prev, status: e.target.value as LicenseStatus }))}>{LICENSE_STATUSES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select><input className="rounded border border-border bg-bg-surface px-2 py-1.5 text-text-primary" value={licenseForm.scope} onChange={(e) => setLicenseForm((prev) => ({ ...prev, scope: e.target.value }))} /><input className="rounded border border-border bg-bg-surface px-2 py-1.5 text-text-primary" placeholder="evidenceUri" value={licenseForm.evidenceUri} onChange={(e) => setLicenseForm((prev) => ({ ...prev, evidenceUri: e.target.value }))} /><label className="flex items-center gap-2 text-text-secondary"><input type="checkbox" checked={licenseForm.crossPlatformCloneAllowed} onChange={(e) => setLicenseForm((prev) => ({ ...prev, crossPlatformCloneAllowed: e.target.checked }))} />允许跨平台克隆</label></div><textarea className="mt-2 w-full rounded border border-border bg-bg-surface px-2 py-1.5 text-text-primary" placeholder="notes" value={licenseForm.notes} onChange={(e) => setLicenseForm((prev) => ({ ...prev, notes: e.target.value }))} /><button className="mt-2 rounded-md border border-border bg-bg-surface px-3 py-1.5 text-text-primary hover:bg-bg-hover" onClick={handleCreateLicense}>创建授权记录</button></div>}
                </div>
                <div>
                  <h3 className="mb-2 font-semibold text-text-primary">Reference 绑定</h3>
                  {detail?.references.length ? detail.references.map((ref) => <div key={ref.id} className="mb-2 rounded border border-border-subtle bg-bg-sunken p-2"><span className="font-mono text-text-primary">{ref.referenceId ?? ref.id}</span><span className="ml-2 text-text-tertiary">{ref.provider} · quality {ref.qualityStatus ?? "unknown"} · transcript {ref.transcriptStatus ?? "unknown"}</span></div>) : <p className="text-text-tertiary">暂无 reference 绑定。</p>}
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function StateBlock({ icon, title, text, tone = "muted" }: { icon: React.ReactNode; title: string; text: string; tone?: "muted" | "error" }) {
  return <div className={`flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed p-6 text-center ${tone === "error" ? "border-error/20 text-error" : "border-border-subtle text-text-tertiary"}`}>{icon}<div className="mt-3 text-sm font-semibold text-text-primary">{title}</div><p className="mt-1 max-w-[28rem] text-xs leading-relaxed">{text}</p></div>;
}

function Info({ label, value, mono, toneClass }: { label: string; value: string; mono?: boolean; toneClass?: string }) {
  return <div className="rounded border border-border-subtle bg-bg-sunken p-2"><div className="text-text-tertiary">{label}</div><div className={`mt-1 break-all rounded px-1.5 py-0.5 text-text-primary ${mono ? "font-mono" : ""} ${toneClass ?? ""}`}>{value}</div></div>;
}
