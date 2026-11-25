import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  CircleDot,
  RefreshCw,
  Clock,
  Smartphone,
  Image as ImageIcon,
  Film,
  Type,
  Volume2,
  Trash2,
  Loader2,
  Calendar,
  Hourglass,
} from 'lucide-react';
import { sessionApi, statusApi, type MyStatusItem, type Session } from '../services/api';
import StatusMedia from '../components/chats/StatusMedia';
import { useToast } from '../hooks/useToast';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  getBroadcastHistory,
  markHistoryItemRevoked,
  markStatusRevokedInHistory,
} from '../utils/statusHistoryStorage';
import './WhatsAppStatus.css';

const AUTO_SYNC_INTERVAL_MS = 15_000;

function formatRemaining(expiresAt: string | number | Date | undefined, nowMs: number): string {
  if (!expiresAt) return '24h window';
  const diff = new Date(expiresAt).getTime() - nowMs;
  if (Number.isNaN(diff) || diff <= 0) return 'Expired';
  const totalMinutes = Math.floor(diff / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${mins}m remaining`;
  return `${mins}m remaining`;
}

function formatDateTime(value: string | number | Date | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

interface WhatsAppStatusProps {
  embedded?: boolean;
  onStatusCountChange?: (count: number) => void;
  onDeleted?: () => void;
}

export function WhatsAppStatus({ embedded = false, onStatusCountChange, onDeleted }: WhatsAppStatusProps = {}) {
  useDocumentTitle(embedded ? 'Broadcast History & Status Hub' : 'WhatsApp Status');
  const toast = useToast();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [statuses, setStatuses] = useState<MyStatusItem[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'image' | 'video' | 'text'>('all');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const loadData = useCallback(
    async (silent = false) => {
      if (!silent) setIsSyncing(true);
      try {
        const [sessList, myRes] = await Promise.all([
          sessionApi.list(),
          statusApi.getMyStatuses(selectedSessionId === 'all' ? undefined : selectedSessionId),
        ]);
        const nextStatuses = myRes.statuses || [];
        setSessions(sessList);
        setStatuses(nextStatuses);
        onStatusCountChange?.(nextStatuses.length);

        // Reconcile Broadcast History with live synced statuses when viewing all accounts
        if (selectedSessionId === 'all') {
          const knownSessionIds = new Set(sessList.map(s => s.id));
          const liveKeys = new Set(nextStatuses.map(s => `${s.sessionId}:${s.id}`));
          const now = Date.now();
          let historyChanged = false;

          for (const h of getBroadcastHistory()) {
            if (h.status !== 'passed' && h.status !== 'partially_revoked') continue;
            if (now - new Date(h.createdAt).getTime() < 15_000) continue;

            for (const sr of h.sessionResults || []) {
              if (sr.status === 'passed' && sr.statusId && knownSessionIds.has(sr.sessionId)) {
                if (!liveKeys.has(`${sr.sessionId}:${sr.statusId}`)) {
                  markStatusRevokedInHistory(sr.sessionId, sr.statusId);
                  historyChanged = true;
                }
              }
            }
          }

          if (historyChanged) {
            for (const h of getBroadcastHistory()) {
              if (
                (h.status === 'passed' || h.status === 'partially_revoked') &&
                h.sessionResults?.length &&
                h.sessionResults.every(sr => sr.status === 'revoked')
              ) {
                markHistoryItemRevoked(h.id);
              }
            }
            onDeleted?.();
          }
        }

        setLastSyncedAt(new Date());
      } catch (err: unknown) {
        if (!silent) {
          const msg = err instanceof Error ? err.message : 'Failed to sync WhatsApp statuses';
          toast.error('Sync Failed', msg);
        }
      } finally {
        setIsLoading(false);
        setIsSyncing(false);
      }
    },
    [selectedSessionId, toast, onStatusCountChange, onDeleted],
  );

  // Initial load + automatic background sync every 15 seconds
  useEffect(() => {
    void loadData(false);
    const syncTimer = setInterval(() => {
      void loadData(true);
    }, AUTO_SYNC_INTERVAL_MS);
    return () => clearInterval(syncTimer);
  }, [loadData]);

  // Update remaining countdown every 30 seconds
  useEffect(() => {
    const tick = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);

  const filteredStatuses = useMemo(() => {
    return statuses.filter(item => {
      if (typeFilter === 'all') return true;
      return item.type === typeFilter;
    });
  }, [statuses, typeFilter]);

  const handleDeleteStatus = async (item: MyStatusItem) => {
    const label = item.sessionName || item.sessionId;
    if (!window.confirm(`Delete this status on ${label} for everyone?`)) return;

    setDeletingId(item.id);
    try {
      await statusApi.deleteStatus(item.sessionId, item.id);
      markStatusRevokedInHistory(item.sessionId, item.id);
      for (const h of getBroadcastHistory()) {
        if (
          (h.status === 'passed' || h.status === 'partially_revoked') &&
          h.sessionResults?.length &&
          h.sessionResults.every(sr => sr.status === 'revoked')
        ) {
          markHistoryItemRevoked(h.id);
        }
      }
      setStatuses(prev => {
        const next = prev.filter(s => !(s.id === item.id && s.sessionId === item.sessionId));
        onStatusCountChange?.(next.length);
        return next;
      });
      onDeleted?.();
      toast.success('Status Deleted', `Removed status from ${label} for everyone.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to delete status';
      toast.error('Delete Failed', msg);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <section className={embedded ? 'wa-status-section' : 'wa-status-page'}>
      {/* Header */}
      <div className="wa-status-header">
        <div>
          {embedded ? (
            <h2 className="wa-status-section-title">
              <CircleDot size={20} className="text-emerald-500" />
              <span>Live / Active Statuses</span>
            </h2>
          ) : (
            <h1 className="wa-status-title">
              <CircleDot size={24} className="text-emerald-500" />
              <span>WhatsApp Status</span>
            </h1>
          )}
          <p className="wa-status-subtitle">
            Automatically synced feed of all active WhatsApp statuses posted from OpenWA or directly from your phone.
          </p>
        </div>

        <div className="wa-status-header-actions">
          {lastSyncedAt && (
            <span className="wa-status-sync-pill" title="Auto-syncs every 15 seconds">
              <span className="wa-status-live-dot" />
              Synced {lastSyncedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void loadData(false)}
            disabled={isSyncing}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}
          >
            <RefreshCw size={15} className={isSyncing ? 'animate-spin' : ''} />
            <span>{isSyncing ? 'Syncing...' : 'Sync Now'}</span>
          </button>
        </div>
      </div>

      {/* Filters Toolbar */}
      <div className="wa-status-toolbar">
        <div className="wa-status-filter-pills">
          {(
            [
              { id: 'all', label: `All (${statuses.length})` },
              { id: 'image', label: 'Images' },
              { id: 'video', label: 'Videos' },
              { id: 'text', label: 'Text' },
            ] as const
          ).map(tab => (
            <button
              key={tab.id}
              type="button"
              className={`wa-status-pill ${typeFilter === tab.id ? 'active' : ''}`}
              onClick={() => setTypeFilter(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="wa-status-account-select-wrap">
          <Smartphone size={15} className="text-muted" />
          <select
            aria-label="Filter by WhatsApp Account"
            value={selectedSessionId}
            onChange={e => setSelectedSessionId(e.target.value)}
            className="wa-status-account-select"
          >
            <option value="all">All WhatsApp Accounts ({sessions.length})</option>
            {sessions.map(s => (
              <option key={s.id} value={s.id}>
                {s.name || s.id} {s.phone ? `(${s.phone})` : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="wa-status-empty">
          <Loader2 size={32} className="animate-spin text-emerald-500" />
          <p>Syncing WhatsApp statuses...</p>
        </div>
      ) : filteredStatuses.length === 0 ? (
        <div className="wa-status-empty">
          <CircleDot size={44} className="text-gray-400" />
          <h3>No Active WhatsApp Statuses</h3>
          <p>
            Statuses posted from OpenWA or directly from your phone within the last 24 hours will automatically appear here.
          </p>
        </div>
      ) : (
        <div className="wa-status-grid">
          {filteredStatuses.map(item => {
            const isDeleting = deletingId === item.id;
            const itemType = item.type || 'text';
            const mediaType: 'image' | 'video' | 'audio' =
              itemType === 'video' ? 'video' : itemType === 'voice' || itemType === 'audio' ? 'audio' : 'image';
            return (
              <article key={`${item.sessionId}:${item.id}`} className="wa-status-card">
                {/* Media / Text Stage */}
                <div className="wa-status-media-stage">
                  {itemType === 'text' ? (
                    <div
                      className="wa-status-text-card"
                      style={{ backgroundColor: item.backgroundColor || '#075E54' }}
                    >
                      <p>{item.caption || 'Text Status'}</p>
                    </div>
                  ) : (
                    <StatusMedia
                      sessionId={item.sessionId}
                      statusId={item.id}
                      type={mediaType}
                    />
                  )}

                  <span className={`wa-status-type-badge type-${itemType}`}>
                    {itemType === 'image' && <ImageIcon size={12} />}
                    {itemType === 'video' && <Film size={12} />}
                    {(itemType === 'voice' || itemType === 'audio') && <Volume2 size={12} />}
                    {itemType === 'text' && <Type size={12} />}
                    <span>{itemType.toUpperCase()}</span>
                  </span>
                </div>

                {/* Details */}
                <div className="wa-status-card-body">
                  <div className="wa-status-account-row">
                    <span className="wa-status-account-badge">
                      <Smartphone size={12} />
                      <span>{item.sessionName || item.sessionId}</span>
                      {item.sessionPhone && <span className="wa-status-phone">({item.sessionPhone})</span>}
                    </span>

                    <button
                      type="button"
                      className="wa-status-delete-btn"
                      onClick={() => void handleDeleteStatus(item)}
                      disabled={isDeleting}
                      title="Delete status for everyone"
                    >
                      {isDeleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                      <span>{isDeleting ? 'Deleting...' : 'Delete'}</span>
                    </button>
                  </div>

                  {item.type !== 'text' && (
                    <div className="wa-status-caption">
                      {item.caption ? item.caption : <span className="text-muted">No caption</span>}
                    </div>
                  )}

                  <div className="wa-status-meta-list">
                    <div className="wa-status-meta-row">
                      <Calendar size={13} />
                      <span>Posted: {formatDateTime(item.timestamp)}</span>
                    </div>
                    <div className="wa-status-meta-row">
                      <Clock size={13} />
                      <span>Expires: {formatDateTime(item.expiresAt)}</span>
                    </div>
                    <div className="wa-status-meta-row wa-status-remaining">
                      <Hourglass size={13} />
                      <span>{formatRemaining(item.expiresAt, nowMs)}</span>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default WhatsAppStatus;
