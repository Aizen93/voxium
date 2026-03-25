import { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useServerStore } from '../../stores/serverStore';
import { toast } from '../../stores/toastStore';
import { Shield, Plus, Trash2, Check, X } from 'lucide-react';
import {
  Permissions,
  PERMISSION_LIST,
  permissionsFromString,
  permissionsToString,
  LIMITS,
} from '@voxium/shared';
import type { Role, PermissionInfo } from '@voxium/shared';
import axios from 'axios';

interface RoleEditorProps {
  serverId: string;
  roles: Role[];
  canManageRoles: boolean;
}

type PermissionCategory = PermissionInfo['category'];

const CATEGORY_ORDER: PermissionCategory[] = ['general', 'membership', 'text', 'voice', 'special'];

function getErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    return err.response?.data?.error || 'An error occurred';
  }
  return 'An error occurred';
}

export function RoleEditor({ serverId, roles, canManageRoles }: RoleEditorProps) {
  const { t } = useTranslation();
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Sort roles: highest position first, @everyone always at bottom
  const sortedRoles = useMemo(() => {
    const nonDefault = roles
      .filter((r) => !r.isDefault)
      .sort((a, b) => b.position - a.position);
    const defaultRole = roles.find((r) => r.isDefault);
    return defaultRole ? [...nonDefault, defaultRole] : nonDefault;
  }, [roles]);

  const selectedRole = useMemo(
    () => sortedRoles.find((r) => r.id === selectedRoleId) ?? null,
    [sortedRoles, selectedRoleId],
  );

  // Auto-select first role if current selection is gone
  const effectiveSelectedId = selectedRole ? selectedRole.id : sortedRoles[0]?.id ?? null;
  const effectiveRole = sortedRoles.find((r) => r.id === effectiveSelectedId) ?? null;

  const handleCreate = useCallback(async () => {
    setCreating(true);
    try {
      // Generate a unique name
      const existingNames = new Set(roles.map((r) => r.name));
      let newName = t('roles.newRole');
      let counter = 2;
      while (existingNames.has(newName)) {
        newName = `${t('roles.newRole')} ${counter++}`;
      }
      const role = await useServerStore.getState().createRole(serverId, newName);
      setSelectedRoleId(role.id);
      toast.success(t('roles.roleCreated'));
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setCreating(false);
    }
  }, [serverId, t]);

  const canCreateRole = roles.filter((r) => !r.isDefault).length < LIMITS.MAX_ROLES_PER_SERVER;

  return (
    <div className="flex gap-4 min-h-[400px]">
      {/* Left panel: role list */}
      <div className="w-48 shrink-0 flex flex-col">
        {/* Create button */}
        {canManageRoles && (
          <button
            onClick={handleCreate}
            disabled={creating || !canCreateRole}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-vox-accent-primary px-3 py-2 text-xs font-medium text-white hover:bg-vox-accent-hover transition-colors disabled:opacity-50 mb-3"
          >
            <Plus size={14} />
            {creating ? t('common.creating') : t('roles.createRole')}
          </button>
        )}

        {/* Role list */}
        <div className="flex-1 overflow-y-auto space-y-0.5">
          {sortedRoles.map((role) => {
            const isSelected = role.id === effectiveSelectedId;
            return (
              <button
                key={role.id}
                onClick={() => setSelectedRoleId(role.id)}
                className={`flex items-center gap-2 w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  isSelected
                    ? 'bg-vox-bg-active text-vox-text-primary'
                    : 'text-vox-text-secondary hover:bg-vox-bg-hover hover:text-vox-text-primary'
                }`}
              >
                <div
                  className="h-3 w-3 shrink-0 rounded-full border border-vox-border"
                  style={{ backgroundColor: role.color || '#99aab5' }}
                />
                <span className="truncate">
                  {role.isDefault ? '@everyone' : role.name}
                </span>
              </button>
            );
          })}
        </div>

        {!canCreateRole && canManageRoles && (
          <p className="text-[10px] text-vox-text-muted mt-2 px-1">
            {t('roles.maxRolesReached', { max: LIMITS.MAX_ROLES_PER_SERVER })}
          </p>
        )}
      </div>

      {/* Right panel: role editor */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {effectiveRole ? (
          <RoleDetailEditor
            key={`${effectiveRole.id}-${effectiveRole.permissions}-${effectiveRole.color}-${effectiveRole.name}`}
            serverId={serverId}
            role={effectiveRole}
            canManageRoles={canManageRoles}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-vox-text-muted">
            <Shield size={40} className="mb-3 opacity-40" />
            <p className="text-sm">{t('roles.noRoles')}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Role Detail Editor ──────────────────────────────────────────────────────

interface RoleDetailEditorProps {
  serverId: string;
  role: Role;
  canManageRoles: boolean;
}

function RoleDetailEditor({ serverId, role, canManageRoles }: RoleDetailEditorProps) {
  const { t } = useTranslation();

  const CATEGORY_LABELS: Record<PermissionCategory, string> = {
    general: t('roles.categories.general'),
    membership: t('roles.categories.membership'),
    text: t('roles.categories.textChannels'),
    voice: t('roles.categories.voiceChannels'),
    special: t('roles.categories.special'),
  };

  const [name, setName] = useState(role.name);
  const [color, setColor] = useState(role.color || '#99aab5');
  const [permissions, setPermissions] = useState(() => permissionsFromString(role.permissions));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const hasChanges = useMemo(() => {
    const nameChanged = !role.isDefault && name.trim() !== role.name;
    const colorChanged = color !== (role.color || '#99aab5');
    const permsChanged = permissionsToString(permissions) !== role.permissions;
    return nameChanged || colorChanged || permsChanged;
  }, [name, color, permissions, role]);

  const handleTogglePermission = useCallback((flag: bigint) => {
    setPermissions((prev) => {
      if ((prev & flag) === flag) {
        return prev & ~flag;
      }
      return prev | flag;
    });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const fields: { name?: string; color?: string | null; permissions?: string } = {};

      if (!role.isDefault && name.trim() !== role.name) {
        fields.name = name.trim();
      }

      const newColor = color === '#99aab5' ? null : color;
      if (newColor !== role.color) {
        fields.color = newColor;
      }

      const permsStr = permissionsToString(permissions);
      if (permsStr !== role.permissions) {
        fields.permissions = permsStr;
      }

      if (Object.keys(fields).length > 0) {
        await useServerStore.getState().updateRole(serverId, role.id, fields);
        toast.success(t('roles.roleUpdated'));
      }
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await useServerStore.getState().deleteRole(serverId, role.id);
      toast.success(t('roles.roleDeleted'));
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const handleReset = () => {
    setName(role.name);
    setColor(role.color || '#99aab5');
    setPermissions(permissionsFromString(role.permissions));
  };

  // Group permissions by category
  const groupedPermissions = useMemo(() => {
    const groups = new Map<PermissionCategory, PermissionInfo[]>();
    for (const cat of CATEGORY_ORDER) {
      groups.set(cat, []);
    }
    for (const perm of PERMISSION_LIST) {
      const list = groups.get(perm.category);
      if (list) list.push(perm);
    }
    return groups;
  }, []);

  return (
    <div className="space-y-5">
      {/* Role header */}
      <div className="flex items-center gap-2">
        <Shield size={18} className="text-vox-text-muted" />
        <h3 className="text-base font-semibold text-vox-text-primary">
          {role.isDefault ? '@everyone' : role.name}
        </h3>
        {role.isDefault && (
          <span className="rounded bg-vox-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-vox-text-muted">
            {t('roles.default')}
          </span>
        )}
      </div>

      {/* Name */}
      {!role.isDefault && (
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-vox-text-muted mb-1.5">
            {t('roles.roleName')}
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={LIMITS.ROLE_NAME_MAX}
            disabled={!canManageRoles}
            className="w-full rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-sm text-vox-text-primary focus:outline-none focus:border-vox-accent-primary disabled:opacity-60"
          />
        </div>
      )}

      {/* Color */}
      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-vox-text-muted mb-1.5">
          {t('roles.roleColor')}
        </label>
        <div className="flex items-center gap-3">
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            disabled={!canManageRoles}
            className="h-9 w-9 shrink-0 cursor-pointer rounded-lg border border-vox-border bg-transparent p-0.5 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <input
            type="text"
            value={color}
            onChange={(e) => {
              const val = e.target.value;
              if (/^#[0-9A-Fa-f]{0,6}$/.test(val)) {
                setColor(val);
              }
            }}
            maxLength={7}
            disabled={!canManageRoles}
            className="w-28 rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-sm font-mono text-vox-text-primary focus:outline-none focus:border-vox-accent-primary disabled:opacity-60"
          />
          <div
            className="h-6 w-6 rounded-full border border-vox-border"
            style={{ backgroundColor: color }}
            title={color}
          />
        </div>
      </div>

      {/* Permissions */}
      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-vox-text-muted mb-3">
          {t('roles.permissions')}
        </label>

        <div className="space-y-4">
          {CATEGORY_ORDER.map((category) => {
            const perms = groupedPermissions.get(category);
            if (!perms || perms.length === 0) return null;
            return (
              <div key={category} className="rounded-lg border border-vox-border bg-vox-bg-secondary overflow-hidden">
                <div className="px-3 py-2 bg-vox-bg-primary/50 border-b border-vox-border">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-vox-text-muted">
                    {CATEGORY_LABELS[category]}
                  </h4>
                </div>
                <div className="divide-y divide-vox-border">
                  {perms.map((perm) => {
                    const isChecked = (permissions & perm.flag) === perm.flag;
                    const isAdmin = perm.flag === Permissions.ADMINISTRATOR;
                    return (
                      <label
                        key={perm.key}
                        className={`flex items-start gap-3 px-3 py-2.5 cursor-pointer transition-colors hover:bg-vox-bg-hover ${
                          !canManageRoles ? 'opacity-60 cursor-not-allowed' : ''
                        } ${isAdmin ? 'bg-vox-accent-danger/5' : ''}`}
                      >
                        <div className="pt-0.5 shrink-0">
                          <div
                            className={`flex h-4 w-4 items-center justify-center rounded border transition-colors ${
                              isChecked
                                ? 'border-vox-accent-primary bg-vox-accent-primary'
                                : 'border-vox-text-muted bg-vox-bg-primary'
                            }`}
                          >
                            {isChecked && <Check size={12} className="text-white" />}
                          </div>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => handleTogglePermission(perm.flag)}
                            disabled={!canManageRoles}
                            className="sr-only"
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className={`text-sm font-medium ${isAdmin ? 'text-vox-accent-danger' : 'text-vox-text-primary'}`}>
                              {t(`permissions.${perm.key}.name`)}
                            </span>
                            {isAdmin && (
                              <span className="rounded bg-vox-accent-danger/20 px-1 py-0.5 text-[9px] font-bold uppercase text-vox-accent-danger">
                                {t('roles.dangerous')}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-vox-text-muted mt-0.5 leading-relaxed">
                            {t(`permissions.${perm.key}.description`)}
                          </p>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Save / Reset bar */}
      {canManageRoles && hasChanges && (
        <div className="sticky bottom-0 flex items-center justify-between rounded-lg border border-vox-border bg-vox-bg-floating px-4 py-3 shadow-lg">
          <span className="text-xs text-vox-text-muted">{t('roles.unsavedChanges')}</span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleReset}
              className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium text-vox-text-secondary hover:bg-vox-bg-hover transition-colors"
            >
              <X size={14} />
              {t('common.reset')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving || (!role.isDefault && name.trim().length < LIMITS.ROLE_NAME_MIN)}
              className="flex items-center gap-1 rounded-lg bg-vox-accent-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-vox-accent-hover transition-colors disabled:opacity-50"
            >
              <Check size={14} />
              {saving ? t('common.saving') : t('settings.profile.saveChanges')}
            </button>
          </div>
        </div>
      )}

      {/* Delete */}
      {canManageRoles && !role.isDefault && (
        <div className="border-t border-vox-accent-danger/30 pt-4 mt-6">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-vox-accent-danger mb-2">
            {t('roles.dangerZone')}
          </h4>
          {!showDeleteConfirm ? (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="flex items-center gap-1.5 rounded-lg border border-vox-accent-danger/50 px-3 py-2 text-xs font-medium text-vox-accent-danger hover:bg-vox-accent-danger/10 transition-colors"
            >
              <Trash2 size={14} />
              {t('roles.deleteRole')}
            </button>
          ) : (
            <div className="flex items-center gap-2 rounded-lg border border-vox-accent-danger/30 bg-vox-accent-danger/5 p-3">
              <p className="flex-1 text-xs text-vox-text-secondary">
                Delete <span className="font-semibold text-vox-text-primary">{role.name}</span>? {t('roles.deleteRoleConfirm')}
              </p>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="rounded-lg bg-vox-accent-danger px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 hover:bg-vox-accent-danger/80 transition-colors"
              >
                {deleting ? t('common.deleting') : t('common.confirm')}
              </button>
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="rounded-lg border border-vox-border px-3 py-1.5 text-xs font-medium text-vox-text-secondary hover:bg-vox-bg-hover transition-colors"
              >
                {t('common.cancel')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
