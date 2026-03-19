import { useState, useEffect, useCallback } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { toast } from '../../stores/toastStore';
import { X, Check, Minus, Shield, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import {
  PERMISSION_LIST,
  permissionsFromString,
  permissionsToString,
  hasPermission,
} from '@voxium/shared';
import type { ChannelPermissionOverride, PermissionInfo } from '@voxium/shared';

interface ChannelPermissionsEditorProps {
  serverId: string;
  channelId: string;
  channelName: string;
  channelType: 'text' | 'voice';
  onClose: () => void;
}

type TriState = 'allow' | 'deny' | 'inherit';

interface OverrideState {
  allow: bigint;
  deny: bigint;
}

const CATEGORIES = [
  { key: 'general', label: 'General' },
  { key: 'membership', label: 'Membership' },
  { key: 'text', label: 'Text' },
  { key: 'voice', label: 'Voice' },
] as const;

// ADMINISTRATOR and special permissions are not valid channel overrides
const CHANNEL_PERMISSIONS = PERMISSION_LIST.filter(
  (p) => p.category !== 'special',
);

function getTriState(flag: bigint, override: OverrideState): TriState {
  if ((override.allow & flag) === flag) return 'allow';
  if ((override.deny & flag) === flag) return 'deny';
  return 'inherit';
}

function cycleTriState(current: TriState): TriState {
  if (current === 'inherit') return 'allow';
  if (current === 'allow') return 'deny';
  return 'inherit';
}

function applyTriState(
  override: OverrideState,
  flag: bigint,
  state: TriState,
): OverrideState {
  // Remove flag from both masks first
  let allow = override.allow & ~flag;
  let deny = override.deny & ~flag;

  if (state === 'allow') {
    allow |= flag;
  } else if (state === 'deny') {
    deny |= flag;
  }

  return { allow, deny };
}

export function ChannelPermissionsEditor({
  serverId,
  channelId,
  channelName,
  channelType,
  onClose,
}: ChannelPermissionsEditorProps) {
  // Filter permissions and categories by channel type:
  // Text channels: general + membership + text (no voice permissions)
  // Voice channels: general + membership + voice (no text permissions)
  const relevantCategories = CATEGORIES.filter((c) =>
    c.key === 'general' || c.key === 'membership' ||
    (channelType === 'text' ? c.key === 'text' : c.key === 'voice')
  );
  const relevantPermissions = CHANNEL_PERMISSIONS.filter((p) =>
    p.category === 'general' || p.category === 'membership' ||
    (channelType === 'text' ? p.category === 'text' : p.category === 'voice')
  );
  const roles = useServerStore((s) => s.roles);
  const fetchChannelPermissions = useServerStore((s) => s.fetchChannelPermissions);
  const setChannelPermissionOverride = useServerStore((s) => s.setChannelPermissionOverride);
  const deleteChannelPermissionOverride = useServerStore((s) => s.deleteChannelPermissionOverride);

  const [overrides, setOverrides] = useState<Record<string, OverrideState>>({});
  const [originalOverrides, setOriginalOverrides] = useState<Record<string, OverrideState>>({});
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(relevantCategories.map((c) => c.key)),
  );

  const sortedRoles = [...roles].sort((a, b) => a.position - b.position);

  // Initialize selected role to the first role (usually @everyone)
  useEffect(() => {
    if (!selectedRoleId && sortedRoles.length > 0) {
      const defaultRole = sortedRoles.find((r) => r.isDefault) || sortedRoles[0];
      setSelectedRoleId(defaultRole.id);
    }
  }, [sortedRoles, selectedRoleId]);

  // Fetch overrides on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const data: ChannelPermissionOverride[] = await fetchChannelPermissions(
          serverId,
          channelId,
        );
        if (cancelled) return;

        const parsed: Record<string, OverrideState> = {};
        for (const override of data) {
          parsed[override.roleId] = {
            allow: permissionsFromString(override.allow),
            deny: permissionsFromString(override.deny),
          };
        }
        setOverrides(parsed);
        setOriginalOverrides(parsed);
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to fetch channel permissions:', err);
          toast.error('Failed to load channel permissions');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverId, channelId, fetchChannelPermissions]);

  const toggleCategory = useCallback((key: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handleToggle = useCallback(
    (roleId: string, flag: bigint) => {
      setOverrides((prev) => {
        const current = prev[roleId] || { allow: 0n, deny: 0n };
        const currentState = getTriState(flag, current);
        const nextState = cycleTriState(currentState);
        const updated = applyTriState(current, flag, nextState);
        return { ...prev, [roleId]: updated };
      });
    },
    [],
  );

  const handleSave = useCallback(async () => {
    if (!selectedRoleId) return;
    setSaving(true);
    try {
      const override = overrides[selectedRoleId];
      if (!override || (override.allow === 0n && override.deny === 0n)) {
        // If both masks are empty, delete the override entirely
        const hadOriginal = originalOverrides[selectedRoleId];
        if (hadOriginal) {
          await deleteChannelPermissionOverride(serverId, channelId, selectedRoleId);
        }
      } else {
        await setChannelPermissionOverride(
          serverId,
          channelId,
          selectedRoleId,
          permissionsToString(override.allow),
          permissionsToString(override.deny),
        );
      }

      // Update original to track new baseline
      setOriginalOverrides((prev) => ({
        ...prev,
        [selectedRoleId]: override || { allow: 0n, deny: 0n },
      }));
      toast.success('Channel permissions updated');
    } catch (err) {
      console.error('Failed to save channel permissions:', err);
      toast.error('Failed to save channel permissions');
    } finally {
      setSaving(false);
    }
  }, [
    selectedRoleId,
    overrides,
    originalOverrides,
    serverId,
    channelId,
    setChannelPermissionOverride,
    deleteChannelPermissionOverride,
  ]);

  const handleReset = useCallback(() => {
    if (!selectedRoleId) return;
    setOverrides((prev) => {
      const next = { ...prev };
      if (originalOverrides[selectedRoleId]) {
        next[selectedRoleId] = originalOverrides[selectedRoleId];
      } else {
        delete next[selectedRoleId];
      }
      return next;
    });
  }, [selectedRoleId, originalOverrides]);

  const hasChanges = (() => {
    if (!selectedRoleId) return false;
    const current = overrides[selectedRoleId] || { allow: 0n, deny: 0n };
    const original = originalOverrides[selectedRoleId] || { allow: 0n, deny: 0n };
    return current.allow !== original.allow || current.deny !== original.deny;
  })();

  const selectedRole = sortedRoles.find((r) => r.id === selectedRoleId);
  const currentOverride = selectedRoleId
    ? overrides[selectedRoleId] || { allow: 0n, deny: 0n }
    : { allow: 0n, deny: 0n };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        className="relative flex w-full max-w-2xl flex-col rounded-xl border border-vox-border bg-vox-bg-floating shadow-2xl animate-slide-up"
        style={{ maxHeight: '85vh' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-vox-border px-6 py-4">
          <div className="flex items-center gap-2.5">
            <Shield size={18} className="text-vox-accent-primary" />
            <div>
              <h2 className="text-lg font-bold text-vox-text-primary">
                Channel Permissions
              </h2>
              <p className="text-xs text-vox-text-muted">
                #{channelName}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-vox-text-muted hover:text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2
              size={24}
              className="animate-spin text-vox-accent-primary"
            />
          </div>
        ) : (
          <div className="flex flex-1 overflow-hidden">
            {/* Role list sidebar */}
            <div className="w-48 shrink-0 border-r border-vox-border overflow-y-auto p-3">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-vox-text-muted">
                Roles
              </p>
              <div className="space-y-0.5">
                {sortedRoles.map((role) => {
                  const isSelected = role.id === selectedRoleId;
                  const roleOverride = overrides[role.id];
                  const hasOverride =
                    roleOverride &&
                    (roleOverride.allow !== 0n || roleOverride.deny !== 0n);

                  return (
                    <button
                      key={role.id}
                      onClick={() => setSelectedRoleId(role.id)}
                      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
                        isSelected
                          ? 'bg-vox-bg-active text-vox-text-primary'
                          : 'text-vox-text-secondary hover:bg-vox-bg-hover hover:text-vox-text-primary'
                      }`}
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{
                          backgroundColor: role.color || '#6b7089',
                        }}
                      />
                      <span className="truncate">{role.name}</span>
                      {hasOverride && (
                        <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-vox-accent-primary" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Permission toggles */}
            <div className="flex-1 overflow-y-auto p-4">
              {selectedRole ? (
                <>
                  <div className="mb-4">
                    <div className="flex items-center gap-2">
                      <span
                        className="h-3 w-3 rounded-full"
                        style={{
                          backgroundColor: selectedRole.color || '#6b7089',
                        }}
                      />
                      <h3 className="text-sm font-semibold text-vox-text-primary">
                        {selectedRole.name}
                      </h3>
                      {selectedRole.isDefault && (
                        <span className="rounded bg-vox-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-vox-text-muted">
                          @everyone
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-vox-text-muted">
                      Configure channel-specific permission overrides for this
                      role. Overrides take priority over role permissions.
                    </p>
                  </div>

                  {/* Legend */}
                  <div className="mb-4 flex items-center gap-4 rounded-lg bg-vox-bg-secondary px-3 py-2 border border-vox-border">
                    <div className="flex items-center gap-1.5">
                      <TriStateIcon state="allow" size={14} />
                      <span className="text-xs text-vox-text-secondary">
                        Allow
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <TriStateIcon state="deny" size={14} />
                      <span className="text-xs text-vox-text-secondary">
                        Deny
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <TriStateIcon state="inherit" size={14} />
                      <span className="text-xs text-vox-text-secondary">
                        Inherit
                      </span>
                    </div>
                  </div>

                  {/* Permission categories */}
                  <div className="space-y-2">
                    {relevantCategories.map((cat) => {
                      const perms = relevantPermissions.filter(
                        (p) => p.category === cat.key,
                      );
                      if (perms.length === 0) return null;

                      const isExpanded = expandedCategories.has(cat.key);

                      return (
                        <div key={cat.key}>
                          <button
                            onClick={() => toggleCategory(cat.key)}
                            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-vox-text-muted hover:text-vox-text-secondary transition-colors"
                          >
                            {isExpanded ? (
                              <ChevronDown size={12} />
                            ) : (
                              <ChevronRight size={12} />
                            )}
                            {cat.label}
                          </button>

                          {isExpanded && (
                            <div className="mt-1 space-y-0.5">
                              {perms.map((perm) => (
                                <PermissionRow
                                  key={perm.key}
                                  permission={perm}
                                  state={getTriState(
                                    perm.flag,
                                    currentOverride,
                                  )}
                                  rolePermissions={permissionsFromString(
                                    selectedRole.permissions,
                                  )}
                                  onToggle={() =>
                                    handleToggle(selectedRole.id, perm.flag)
                                  }
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-center py-16 text-sm text-vox-text-muted">
                  Select a role to configure permissions
                </div>
              )}
            </div>
          </div>
        )}

        {/* Footer */}
        {!loading && (
          <div className="flex items-center justify-between border-t border-vox-border px-6 py-3">
            <p className="text-xs text-vox-text-muted">
              {hasChanges
                ? 'You have unsaved changes'
                : 'No unsaved changes'}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={handleReset}
                disabled={!hasChanges || saving}
                className="rounded-lg border border-vox-border px-3 py-1.5 text-xs font-medium text-vox-text-secondary hover:bg-vox-bg-hover transition-colors disabled:opacity-50"
              >
                Reset
              </button>
              <button
                onClick={handleSave}
                disabled={!hasChanges || saving}
                className="rounded-lg bg-vox-accent-primary px-4 py-1.5 text-xs font-medium text-white hover:bg-vox-accent-hover transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Sub-Components ──────────────────────────────────────────────────────────

function TriStateIcon({ state, size = 16 }: { state: TriState; size?: number }) {
  if (state === 'allow') {
    return (
      <div className="flex items-center justify-center rounded bg-green-500/20">
        <Check size={size} className="text-green-400" />
      </div>
    );
  }
  if (state === 'deny') {
    return (
      <div className="flex items-center justify-center rounded bg-red-500/20">
        <X size={size} className="text-red-400" />
      </div>
    );
  }
  return (
    <div className="flex items-center justify-center rounded bg-vox-bg-tertiary">
      <Minus size={size} className="text-vox-text-muted" />
    </div>
  );
}

function PermissionRow({
  permission,
  state,
  rolePermissions,
  onToggle,
}: {
  permission: PermissionInfo;
  state: TriState;
  rolePermissions: bigint;
  onToggle: () => void;
}) {
  const isGrantedByRole = hasPermission(rolePermissions, permission.flag);

  return (
    <div className="group flex items-center justify-between rounded-md px-3 py-2 hover:bg-vox-bg-hover transition-colors">
      <div className="min-w-0 flex-1 mr-3">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-vox-text-primary">
            {permission.name}
          </p>
          {state === 'inherit' && (
            <span
              className={`text-[10px] font-medium rounded px-1.5 py-0.5 ${
                isGrantedByRole
                  ? 'bg-green-500/10 text-green-400/70'
                  : 'bg-red-500/10 text-red-400/70'
              }`}
            >
              {isGrantedByRole ? 'Role: Allowed' : 'Role: Denied'}
            </span>
          )}
        </div>
        <p className="text-xs text-vox-text-muted leading-relaxed">
          {permission.description}
        </p>
      </div>

      <button
        onClick={onToggle}
        className="shrink-0 rounded-md p-1 hover:bg-vox-bg-active transition-colors"
        title={`Current: ${state}. Click to cycle.`}
      >
        <TriStateIcon state={state} size={18} />
      </button>
    </div>
  );
}
