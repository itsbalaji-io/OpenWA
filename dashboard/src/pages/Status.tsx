import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Radio,
  Trash2,
  Plus,
  RefreshCw,
  Clock,
  Loader2,
  Smartphone,
  CheckCircle2,
  Rocket,
  Download,
  Sparkles,
  Search,
  AlertCircle,
  Image as ImageIcon,
  Type,
  Film,
} from 'lucide-react';
import {
  statusApi,
  sessionApi,
  type Session,
} from '../services/api';
import StatusComposeModal from '../components/chats/StatusComposeModal';
import MultiSessionBlasterModal from '../components/status/MultiSessionBlasterModal';
import { WhatsAppStatus } from './WhatsAppStatus';
import { useToast } from '../hooks/useToast';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  getBroadcastHistory,
  markHistoryItemRevoked,
  markStatusRevokedInHistory,
  clearBroadcastHistory,
  exportBroadcastHistoryCsv,
  type BroadcastHistoryItem,
} from '../utils/statusHistoryStorage';
import './Status.css';

export function Status() {
  useDocumentTitle('Broadcast History & Status Hub');
  const toast = useToast();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [revokingItemId, setRevokingItemId] = useState<string | null>(null);

  // Modals
  const [isSingleComposeOpen, setIsSingleComposeOpen] = useState<boolean>(false);
  const [isBlasterOpen, setIsBlasterOpen] = useState<boolean>(false);
  const [effectiveSessionId, setEffectiveSessionId] = useState<string>('');

  // Broadcast History State
  const [historyItems, setHistoryItems] = useState<BroadcastHistoryItem[]>(() => getBroadcastHistory());
  const [liveSyncedCount, setLiveSyncedCount] = useState<number>(0);
  const [liveSyncVersion, setLiveSyncVersion] = useState<number>(0);
  const [historyFilter, setHistoryFilter] = useState<'all' | 'passed' | 'revoked' | 'failed'>('all');
  const [historySearch, setHistorySearch] = useState<string>('');

  // Fetch available sessions
  const fetchSessions = useCallback(async () => {
    try {
      const res = await sessionApi.list();
      const list = Array.isArray(res) ? res : [];
      setSessions(list);
      const readySessions = list.filter(s => s.status === 'ready');
      if (readySessions.length > 0 && !effectiveSessionId) {
        setEffectiveSessionId(readySessions[0].id);
      }
    } catch {
      // Session fetch error handled silently
    }
  }, [effectiveSessionId]);

  const refreshHistory = useCallback(() => {
    setIsRefreshing(true);
    setHistoryItems(getBroadcastHistory());
    setTimeout(() => setIsRefreshing(false), 300);
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Flash Sale / Auto-Expire Sweeper
  useEffect(() => {
    const sweepInterval = setInterval(async () => {
      const now = Date.now();
      const currentItems = getBroadcastHistory();
      let changed = false;

      for (const item of currentItems) {
        if (item.status === 'passed' && item.autoExpireAt) {
          const expireTs = new Date(item.autoExpireAt).getTime();
          if (expireTs <= now) {
            // Automatically execute revoke on WhatsApp servers
            for (const sr of item.sessionResults || []) {
              if (sr.statusId && sr.status === 'passed') {
                try {
                  await statusApi.deleteStatus(sr.sessionId, sr.statusId);
                } catch {
                  // ignore
                }
              }
            }
            markHistoryItemRevoked(item.id);
            changed = true;
          }
        }
      }

      if (changed) {
        setHistoryItems(getBroadcastHistory());
        toast.info('Flash Deals Expired', 'Auto-revoked expired flash deal statuses from WhatsApp.');
      }
    }, 15000);

    return () => clearInterval(sweepInterval);
  }, [toast]);

  // Permanently delete & revoke a status broadcast across all posted WhatsApp accounts
  const handleRevokeBroadcastItem = async (item: BroadcastHistoryItem) => {
    const activeTargets = (item.sessionResults || []).filter(
      sr => sr.status === 'passed' || sr.statusId,
    );

    const targetDesc =
      activeTargets.length > 0
        ? `${activeTargets.length} account(s)`
        : `${item.targetAccountNames?.length || 1} account(s)`;

    if (
      !window.confirm(
        `Permanently revoke and delete this status for everyone across ${targetDesc}?\n\nOnce deleted, it will be completely removed from WhatsApp servers and no one will be able to view it anywhere.`,
      )
    ) {
      return;
    }

    setRevokingItemId(item.id);
    let revokedCount = 0;
    let failedCount = 0;

    for (const sr of item.sessionResults || []) {
      if (sr.statusId) {
        try {
          await statusApi.deleteStatus(sr.sessionId, sr.statusId);
          markStatusRevokedInHistory(sr.sessionId, sr.statusId);
          revokedCount++;
        } catch (err) {
          console.error(`Failed to delete status ${sr.statusId} on session ${sr.sessionId}:`, err);
          failedCount++;
        }
      } else {
        failedCount++;
      }
    }

    if (revokedCount > 0 && failedCount === 0) {
      markHistoryItemRevoked(item.id);
    }
    setHistoryItems(getBroadcastHistory());
    setLiveSyncVersion(v => v + 1);
    setRevokingItemId(null);

    if (revokedCount > 0 && failedCount === 0) {
      toast.success(
        'Status Deleted for Everyone',
        `Successfully deleted and revoked status across ${revokedCount} account(s). No viewers can see it now.`,
      );
    } else if (revokedCount > 0 && failedCount > 0) {
      toast.warning(
        'Partially Revoked',
        `Revoked on ${revokedCount} account(s), but ${failedCount} failed. Check that all target sessions are connected.`,
      );
    } else {
      toast.error(
        'Revoke Failed',
        'Could not delete status from WhatsApp servers. Ensure the target session is connected and has a valid status ID.',
      );
    }
  };

  // Revoke for a specific single session within a broadcast
  const handleRevokeSingleSession = async (
    itemId: string,
    sessionId: string,
    statusId: string,
    sessionName: string,
  ) => {
    if (!window.confirm(`Delete status on ${sessionName} for everyone?`)) return;

    try {
      await statusApi.deleteStatus(sessionId, statusId);
      markStatusRevokedInHistory(sessionId, statusId);
      const current = getBroadcastHistory();
      const target = current.find(x => x.id === itemId);
      if (target && target.sessionResults?.every(sr => sr.status === 'revoked')) {
        markHistoryItemRevoked(itemId);
      }
      setHistoryItems(getBroadcastHistory());
      setLiveSyncVersion(v => v + 1);
      toast.success('Status Deleted', `Status deleted for everyone on ${sessionName}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to delete status';
      toast.error('Delete Failed', msg);
    }
  };

  const readySessions = useMemo(() => {
    return sessions.filter(s => s.status === 'ready');
  }, [sessions]);

  // Overall KPIs
  const totalBroadcasts = historyItems.length;
  const activeCount = historyItems.filter(i => i.status === 'passed').length;
  const revokedCount = historyItems.filter(
    i => i.status === 'revoked' || i.status === 'partially_revoked',
  ).length;

  const formatExpiryTime = (autoExpireAt?: string | null) => {
    if (!autoExpireAt) return '24h Standard';
    const diff = new Date(autoExpireAt).getTime() - Date.now();
    if (diff <= 0) return 'Expired';
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    if (hours > 0) return `${hours}h ${mins}m left`;
    return `${mins}m left`;
  };

  // Filtered History Items
  const filteredHistory = useMemo(() => {
    return historyItems.filter(item => {
      if (historyFilter === 'passed' && item.status !== 'passed') return false;
      if (historyFilter === 'revoked' && item.status !== 'revoked' && item.status !== 'partially_revoked')
        return false;
      if (historyFilter === 'failed' && item.status !== 'failed') return false;

      if (historySearch.trim()) {
        const q = historySearch.toLowerCase();
        const matchesCaption = item.caption && item.caption.toLowerCase().includes(q);
        const matchesFile = item.fileName && item.fileName.toLowerCase().includes(q);
        const matchesRoute = item.routeFingerprint && item.routeFingerprint.toLowerCase().includes(q);
        const matchesAccounts = item.targetAccountNames?.some(name => name.toLowerCase().includes(q));
        if (!matchesCaption && !matchesFile && !matchesRoute && !matchesAccounts) return false;
      }
      return true;
    });
  }, [historyItems, historyFilter, historySearch]);

  return (
    <div className="status-page">
      {/* Top Page Header */}
      <div className="status-header">
        <div className="status-header-titles">
          <h1>
            <Radio size={28} className="text-emerald-500" />
            WhatsApp Status Broadcast & Audit Hub
          </h1>
          <p>
            Enterprise broadcast management, instant permanent status deletion for everyone, flight itinerary route tracking, and automated flash deal revocation.
          </p>
        </div>
        <div className="status-header-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={refreshHistory}
            disabled={isRefreshing}
          >
            <RefreshCw size={16} className={isRefreshing ? 'animate-spin' : ''} />
            Refresh
          </button>

          <button
            type="button"
            className="btn-secondary"
            onClick={() => exportBroadcastHistoryCsv(historyItems)}
            disabled={historyItems.length === 0}
          >
            <Download size={16} />
            Export CSV
          </button>

          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              if (readySessions.length === 0) {
                toast.error('No Ready Accounts', 'Please link a WhatsApp account before composing.');
                return;
              }
              setIsSingleComposeOpen(true);
            }}
          >
            <Plus size={16} /> Single Status
          </button>

          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              if (readySessions.length === 0) {
                toast.error('No Ready Accounts', 'Please link WhatsApp accounts before launching blaster.');
                return;
              }
              setIsBlasterOpen(true);
            }}
          >
            <Rocket size={18} /> Multi-Session Blaster
          </button>
        </div>
      </div>

      {/* KPI Overview Cards */}
      <div className="status-stats-grid">
        <div className="status-stat-card">
          <div className="status-stat-icon own">
            <Radio size={24} />
          </div>
          <div className="status-stat-info">
            <span className="status-stat-value">{totalBroadcasts}</span>
            <span className="status-stat-label">Total Broadcasts</span>
          </div>
        </div>

        <div className="status-stat-card">
          <div className="status-stat-icon views">
            <CheckCircle2 size={24} />
          </div>
          <div className="status-stat-info">
            <span className="status-stat-value">{Math.max(activeCount, liveSyncedCount)}</span>
            <span className="status-stat-label">Live / Active Statuses</span>
          </div>
        </div>

        <div className="status-stat-card">
          <div className="status-stat-icon accounts">
            <Trash2 size={24} />
          </div>
          <div className="status-stat-info">
            <span className="status-stat-value">{revokedCount}</span>
            <span className="status-stat-label">Revoked for Everyone</span>
          </div>
        </div>

        <div className="status-stat-card">
          <div className="status-stat-icon mode">
            <Smartphone size={24} />
          </div>
          <div className="status-stat-info">
            <span className="status-stat-value">{readySessions.length}</span>
            <span className="status-stat-label">Ready WhatsApp Accounts</span>
          </div>
        </div>
      </div>

      {/* Live / Active Statuses (Synced from Phone & OpenWA) */}
      <WhatsAppStatus
        key={liveSyncVersion}
        embedded
        onStatusCountChange={setLiveSyncedCount}
        onDeleted={refreshHistory}
      />

      {/* Main Broadcast History & Audit Center */}
      <div className="history-container">
        <div className="history-toolbar">
          <div className="history-search-box">
            <Search size={16} className="history-search-icon" />
            <input
              type="text"
              className="history-search-input"
              placeholder="Search by caption, route (e.g. HYD-DXB), file name, or account..."
              value={historySearch}
              onChange={e => setHistorySearch(e.target.value)}
            />
          </div>

          <div className="history-filter-pills">
            <button
              type="button"
              className={`history-filter-pill ${historyFilter === 'all' ? 'active' : ''}`}
              onClick={() => setHistoryFilter('all')}
            >
              All ({historyItems.length})
            </button>
            <button
              type="button"
              className={`history-filter-pill ${historyFilter === 'passed' ? 'active' : ''}`}
              onClick={() => setHistoryFilter('passed')}
            >
              Live Active ({activeCount})
            </button>
            <button
              type="button"
              className={`history-filter-pill ${historyFilter === 'revoked' ? 'active' : ''}`}
              onClick={() => setHistoryFilter('revoked')}
            >
              Revoked ({revokedCount})
            </button>
            <button
              type="button"
              className={`history-filter-pill ${historyFilter === 'failed' ? 'active' : ''}`}
              onClick={() => setHistoryFilter('failed')}
            >
              Failed
            </button>
          </div>

          {historyItems.length > 0 && (
            <button
              type="button"
              className="btn-secondary text-xs"
              style={{ marginLeft: 'auto' }}
              onClick={() => {
                if (window.confirm('Clear all local broadcast audit logs?')) {
                  clearBroadcastHistory();
                  setHistoryItems([]);
                  toast.info('History Cleared', 'Local audit records cleared.');
                }
              }}
            >
              <Trash2 size={14} /> Clear Logs
            </button>
          )}
        </div>

        {/* History Table */}
        <div className="history-table-wrapper">
          <table className="history-table">
            <thead>
              <tr>
                <th>Broadcast Item</th>
                <th>Flight Route</th>
                <th>Target Accounts</th>
                <th>Time & Expiry</th>
                <th>Status Telemetry</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredHistory.length === 0 ? (
                <tr>
                  <td colSpan={6} className="history-empty-cell">
                    <div className="history-empty-state">
                      <Radio size={40} className="text-gray-400" />
                      <h3>No Broadcast History Found</h3>
                      <p>Use Single Status or Multi-Session Blaster above to broadcast status updates.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredHistory.map(item => {
                  const isRevoking = revokingItemId === item.id;
                  const isFullyRevoked = item.status === 'revoked';
                  const isPassed = item.status === 'passed';

                  return (
                    <tr key={item.id} className={isFullyRevoked ? 'row-revoked' : ''}>
                      {/* Media & Content */}
                      <td>
                        <div className="history-item-content">
                          <div className="history-media-icon">
                            {item.mediaType === 'video' ? (
                              <Film size={20} className="text-purple-400" />
                            ) : item.mediaType === 'image' ? (
                              <ImageIcon size={20} className="text-emerald-400" />
                            ) : (
                              <Type size={20} className="text-blue-400" />
                            )}
                          </div>
                          <div className="history-item-details">
                            <span className="history-item-title" title={item.fileName}>
                              {item.fileName || 'WhatsApp Story'}
                            </span>
                            {item.caption && (
                              <span className="history-item-caption" title={item.caption}>
                                {item.caption}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Route Fingerprint */}
                      <td>
                        {item.routeFingerprint ? (
                          <span className="history-route-badge">
                            <Sparkles size={12} />
                            ✈ {item.routeFingerprint}
                          </span>
                        ) : (
                          <span className="text-xs text-muted">—</span>
                        )}
                      </td>

                      {/* Target Accounts */}
                      <td>
                        <div className="history-accounts-cell">
                          <div className="history-accounts-list">
                            {(item.sessionResults || []).map((sr, idx) => (
                              <span
                                key={idx}
                                className={`history-account-chip ${sr.status === 'revoked' ? 'chip-revoked' : ''}`}
                                title={`${sr.name} (${sr.status})`}
                              >
                                <Smartphone size={10} />
                                <span>{sr.name}</span>
                                {sr.status === 'passed' && !isFullyRevoked && (
                                  <button
                                    type="button"
                                    className="history-chip-del-btn"
                                    title={`Delete status on ${sr.name} for everyone`}
                                    onClick={() =>
                                      handleRevokeSingleSession(
                                        item.id,
                                        sr.sessionId,
                                        sr.statusId || '',
                                        sr.name,
                                      )
                                    }
                                  >
                                    ×
                                  </button>
                                )}
                              </span>
                            ))}
                          </div>
                          <span className="text-xs text-muted">
                            {item.targetAccountNames?.length || 1} account(s) targeted
                          </span>
                        </div>
                      </td>

                      {/* Time & Expiry */}
                      <td>
                        <div className="history-time-cell">
                          <span className="history-date">
                            {new Date(item.createdAt).toLocaleDateString()} {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                          <span className="history-expiry">
                            <Clock size={12} />
                            {formatExpiryTime(item.autoExpireAt)}
                          </span>
                        </div>
                      </td>

                      {/* Status Telemetry */}
                      <td>
                        {isFullyRevoked ? (
                          <span className="status-pill status-pill-revoked">
                            <CheckCircle2 size={12} /> Revoked for Everyone
                          </span>
                        ) : isPassed ? (
                          <span className="status-pill status-pill-active">
                            <span className="status-pulse-dot" /> Live on WhatsApp
                          </span>
                        ) : (
                          <span className="status-pill status-pill-failed">
                            <AlertCircle size={12} /> Failed
                          </span>
                        )}
                      </td>

                      {/* Actions */}
                      <td style={{ textAlign: 'right' }}>
                        {isFullyRevoked ? (
                          <span className="text-xs text-muted font-medium">Deleted</span>
                        ) : (
                          <button
                            type="button"
                            className="btn-revoke-for-everyone"
                            onClick={() => handleRevokeBroadcastItem(item)}
                            disabled={isRevoking}
                            title="Delete and revoke this status for everyone on WhatsApp servers"
                          >
                            {isRevoking ? (
                              <>
                                <Loader2 size={13} className="animate-spin" />
                                <span>Deleting...</span>
                              </>
                            ) : (
                              <>
                                <Trash2 size={13} />
                                <span>Delete for Everyone</span>
                              </>
                            )}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Official Single-Account Compose Modal */}
      {isSingleComposeOpen && (
        <StatusComposeModal
          sessionId={effectiveSessionId || readySessions[0]?.id || ''}
          sessions={sessions}
          onClose={() => setIsSingleComposeOpen(false)}
          onPosted={() => {
            setIsSingleComposeOpen(false);
            setLiveSyncVersion(v => v + 1);
            refreshHistory();
          }}
        />
      )}

      {/* Multi-Session Blaster Modal */}
      {isBlasterOpen && (
        <MultiSessionBlasterModal
          open={isBlasterOpen}
          sessions={sessions}
          onClose={() => setIsBlasterOpen(false)}
          onPosted={() => {
            setIsBlasterOpen(false);
            setLiveSyncVersion(v => v + 1);
            refreshHistory();
          }}
        />
      )}
    </div>
  );
}

export default Status;
