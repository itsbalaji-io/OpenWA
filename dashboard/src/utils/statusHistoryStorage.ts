/**
 * Persistent Broadcast History & Audit Log Store
 * Backed by browser localStorage with auto-expire evaluation and CSV export.
 */

export interface SessionBroadcastResult {
  sessionId: string;
  name: string;
  phone?: string;
  status: 'passed' | 'failed' | 'revoked';
  statusId?: string;
  postTimestamp?: string;
  revokedAt?: string;
  error?: string;
}

export interface BroadcastHistoryItem {
  id: string;
  createdAt: string;
  fileName: string;
  mediaType: 'image' | 'video' | 'text';
  caption: string;
  routeFingerprint: string;
  status: 'passed' | 'failed' | 'partially_revoked' | 'revoked';
  targetSessionIds: string[];
  targetAccountNames: string[];
  sessionResults: SessionBroadcastResult[];
  autoExpireHours?: number | null;
  autoExpireAt?: string | null;
  antiBanStagger: boolean;
  createdBy?: string;
}

const STORAGE_KEY = 'openwa_status_broadcast_history';

export function getBroadcastHistory(): BroadcastHistoryItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  } catch {
    return [];
  }
}

export function saveBroadcastHistory(items: BroadcastHistoryItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch (err) {
    console.error('Failed to save broadcast history:', err);
  }
}

export function addBroadcastHistoryItem(item: BroadcastHistoryItem): void {
  const current = getBroadcastHistory();
  current.unshift(item);
  saveBroadcastHistory(current);
}

export function updateBroadcastHistoryItem(item: BroadcastHistoryItem): void {
  const current = getBroadcastHistory();
  const idx = current.findIndex(i => i.id === item.id);
  if (idx !== -1) {
    current[idx] = item;
    saveBroadcastHistory(current);
  }
}

export function deleteBroadcastHistoryItem(id: string): void {
  const current = getBroadcastHistory().filter(i => i.id !== id);
  saveBroadcastHistory(current);
}

export function clearBroadcastHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // quiet
  }
}

/**
 * Mark an entire broadcast item as revoked
 */
export function markHistoryItemRevoked(itemId: string): void {
  const items = getBroadcastHistory();
  const item = items.find(i => i.id === itemId);
  if (item) {
    item.status = 'revoked';
    if (item.sessionResults) {
      for (const sr of item.sessionResults) {
        sr.status = 'revoked';
        sr.revokedAt = new Date().toISOString();
      }
    }
    saveBroadcastHistory(items);
  }
}

/**
 * Mark a statusId as revoked across all matching history records
 */
export function markStatusRevokedInHistory(sessionId: string, statusId: string): void {
  const items = getBroadcastHistory();
  let modified = false;

  for (const item of items) {
    if (item.sessionResults) {
      for (const sr of item.sessionResults) {
        if (sr.sessionId === sessionId && sr.statusId === statusId && sr.status !== 'revoked') {
          sr.status = 'revoked';
          sr.revokedAt = new Date().toISOString();
          modified = true;
        }
      }
      const allRevoked = item.sessionResults.every(sr => sr.status === 'revoked' || sr.status === 'failed');
      if (allRevoked && item.status !== 'revoked') {
        item.status = 'revoked';
        modified = true;
      }
    }
  }

  if (modified) {
    saveBroadcastHistory(items);
  }
}

/**
 * Export history items as downloadable CSV
 */
export function exportBroadcastHistoryCsv(items: BroadcastHistoryItem[]): void {
  const headers = ['ID', 'Date (UTC)', 'Media Type', 'File / Text', 'Caption', 'Status', 'Target Accounts Count', 'Passed', 'Failed'];
  const rows = items.map(item => {
    const passedCount = item.sessionResults.filter(sr => sr.status === 'passed').length;
    const failedCount = item.sessionResults.filter(sr => sr.status === 'failed').length;
    return [
      item.id,
      item.createdAt,
      item.mediaType,
      item.fileName || 'Text Status',
      (item.caption || '').replace(/"/g, '""'),
      item.status,
      String(item.targetSessionIds?.length || 0),
      String(passedCount),
      String(failedCount),
    ];
  });

  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(field => `"${String(field).replace(/"/g, '""')}"`).join(',')),
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `openwa-status-broadcast-history-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
