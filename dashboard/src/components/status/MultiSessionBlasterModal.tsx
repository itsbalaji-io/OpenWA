import { useState, useRef, useMemo, useCallback } from 'react';
import {
  Radio,
  Image as ImageIcon,
  Type,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ShieldCheck,
  Clock,
  Trash2,
  Send,
  Sparkles,
  Smartphone,
  Search,
  UploadCloud,
} from 'lucide-react';
import { Modal } from '../Modal';
import { statusApi, sessionApi, type Session, type StatusItem } from '../../services/api';
import { useToast } from '../../hooks/useToast';
import { formatPhoneForDisplay } from '../../utils/formatPhone';
import { extractRouteFingerprint, extractRouteDisplayList } from '../../utils/statusRoutes';
import {
  addBroadcastHistoryItem,
  type SessionBroadcastResult,
  type BroadcastHistoryItem,
} from '../../utils/statusHistoryStorage';
import './MultiSessionBlasterModal.css';

interface MultiSessionBlasterModalProps {
  open: boolean;
  onClose: () => void;
  onPosted: () => void;
  sessions?: Session[];
  existingStatuses?: any[];
  readySessions?: Session[];
  liveItems?: StatusItem[];
}

export function MultiSessionBlasterModal({
  open,
  onClose,
  onPosted,
  sessions,
  existingStatuses,
  readySessions: propReadySessions,
  liveItems: propLiveItems,
}: MultiSessionBlasterModalProps) {
  const toast = useToast();

  const readySessions = useMemo(() => {
    if (propReadySessions) return propReadySessions;
    return (sessions || []).filter(s => s.status === 'ready');
  }, [propReadySessions, sessions]);

  const liveItems = useMemo(() => {
    return propLiveItems || existingStatuses || [];
  }, [propLiveItems, existingStatuses]);

  // Mode: Media or Color Text
  const [mode, setMode] = useState<'media' | 'text'>('media');

  // Media state
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaBase64, setMediaBase64] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<'image' | 'video'>('image');
  const [caption, setCaption] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Text state
  const [textContent, setTextContent] = useState('');
  const [bgColor, setBgColor] = useState('#075E54');

  // Multi-session target selection
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>(() =>
    readySessions.map(s => s.id),
  );
  const [searchAccountQuery, setSearchAccountQuery] = useState('');

  // Anti-ban & flash sale configs
  const [antiBanStagger, setAntiBanStagger] = useState(true);
  const [autoExpireHours, setAutoExpireHours] = useState<number>(0);

  // Execution & Progress State
  const [isBlasting, setIsBlasting] = useState(false);
  const [progressIndex, setProgressIndex] = useState(0);
  const [executionLogs, setExecutionLogs] = useState<
    Array<{ sessionId: string; name: string; status: 'pending' | 'success' | 'error'; message?: string }>
  >([]);

  // Calculate duplicate detection by session
  const activeFingerprint = useMemo(() => {
    return extractRouteFingerprint(mode === 'media' ? caption : textContent);
  }, [mode, caption, textContent]);

  const detectedRoutes = useMemo(() => {
    return extractRouteDisplayList(mode === 'media' ? caption : textContent);
  }, [mode, caption, textContent]);

  // Map of sessions that already have an active story matching this route fingerprint
  const liveDuplicatesBySession = useMemo(() => {
    if (!activeFingerprint || !liveItems.length) return new Set<string>();
    const dupes = new Set<string>();
    for (const item of liveItems) {
      const rawText = (item as any)?.caption || (item as any)?.body || (item as any)?.text || '';
      const itemFp = extractRouteFingerprint(rawText);
      if (itemFp && itemFp === activeFingerprint && (item as any)?.sessionId) {
        dupes.add((item as any).sessionId);
      }
    }
    return dupes;
  }, [activeFingerprint, liveItems]);

  // Handle file upload
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const isVideo = file.type.startsWith('video/');
    setMediaType(isVideo ? 'video' : 'image');
    setMediaFile(file);

    const reader = new FileReader();
    reader.onload = ev => {
      setMediaBase64(ev.target?.result as string);
    };
    reader.readAsDataURL(file);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;

    const isVideo = file.type.startsWith('video/');
    setMediaType(isVideo ? 'video' : 'image');
    setMediaFile(file);

    const reader = new FileReader();
    reader.onload = ev => {
      setMediaBase64(ev.target?.result as string);
    };
    reader.readAsDataURL(file);
  }, []);

  // Toggle account selection
  const toggleSession = (sessionId: string) => {
    setSelectedSessionIds(prev =>
      prev.includes(sessionId) ? prev.filter(id => id !== sessionId) : [...prev, sessionId],
    );
  };

  const toggleSelectAll = () => {
    if (selectedSessionIds.length === readySessions.length) {
      setSelectedSessionIds([]);
    } else {
      setSelectedSessionIds(readySessions.map(s => s.id));
    }
  };

  // Perform broadcast
  const handleStartBlast = async () => {
    if (selectedSessionIds.length === 0) {
      toast.warning('No Accounts Selected', 'Select at least one WhatsApp account to broadcast.');
      return;
    }

    if (mode === 'media' && !mediaBase64) {
      toast.warning('Media Required', 'Upload an image or video flyer to broadcast.');
      return;
    }

    if (mode === 'text' && !textContent.trim()) {
      toast.warning('Text Required', 'Enter your status announcement text.');
      return;
    }

    setIsBlasting(true);
    setProgressIndex(0);

    const targetSessions = readySessions.filter(s => selectedSessionIds.includes(s.id));
    const logs: Array<{
      sessionId: string;
      name: string;
      status: 'pending' | 'success' | 'error';
      message?: string;
    }> = targetSessions.map(s => ({
      sessionId: s.id,
      name: s.name || s.id,
      status: 'pending',
      message: 'Queued',
    }));
    setExecutionLogs([...logs]);

    const sessionResults: SessionBroadcastResult[] = [];
    const nowIso = new Date().toISOString();
    const autoExpireAt =
      autoExpireHours > 0
        ? new Date(Date.now() + autoExpireHours * 3600 * 1000).toISOString()
        : null;

    for (let i = 0; i < targetSessions.length; i++) {
      const session = targetSessions[i];
      setProgressIndex(i + 1);

      // Apply anti-ban jitter: 3.0s to 5.0s between dispatches
      if (i > 0 && antiBanStagger) {
        const jitterMs = Math.floor(3000 + Math.random() * 2000);
        logs[i].message = `Anti-ban wait (${(jitterMs / 1000).toFixed(1)}s)...`;
        setExecutionLogs([...logs]);
        await new Promise(res => setTimeout(res, jitterMs));
      }

      try {
        let postRes: { statusId?: string } | null = null;

        if (mode === 'media') {
          const mimeType =
            mediaBase64?.match(/^data:([^;]+);/)?.[1] ||
            (mediaType === 'video' ? 'video/mp4' : 'image/jpeg');

          if (mediaType === 'video') {
            postRes = (await statusApi.postVideo(
              session.id,
              mediaBase64!,
              caption.trim() || undefined,
            )) as { statusId?: string } | null;
          } else {
            postRes = (await sessionApi.postImageStatus(
              session.id,
              { base64: mediaBase64!, mimetype: mimeType },
              undefined,
              caption.trim() || undefined,
            )) as { statusId?: string } | null;
          }
        } else {
          postRes = (await sessionApi.postTextStatus(
            session.id,
            textContent.trim(),
            undefined,
            { backgroundColor: bgColor },
          )) as { statusId?: string } | null;
        }

        const statusId = postRes?.statusId || '';
        logs[i].status = 'success';
        logs[i].message = `Dispatched (${statusId.slice(0, 8)}...)`;

        sessionResults.push({
          sessionId: session.id,
          name: session.name || session.id,
          phone: session.phone || undefined,
          status: 'passed',
          statusId,
          postTimestamp: new Date().toISOString(),
        });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : 'API error';
        logs[i].status = 'error';
        logs[i].message = errMsg;

        sessionResults.push({
          sessionId: session.id,
          name: session.name || session.id,
          phone: session.phone || undefined,
          status: 'failed',
          error: errMsg,
          postTimestamp: new Date().toISOString(),
        });
      }

      setExecutionLogs([...logs]);
    }

    const passedCount = sessionResults.filter(sr => sr.status === 'passed').length;
    const failedCount = sessionResults.filter(sr => sr.status === 'failed').length;

    // Save complete record into local audit history
    const historyItem: BroadcastHistoryItem = {
      id: `item-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      createdAt: nowIso,
      fileName: mediaFile?.name || (mode === 'text' ? 'Color Text Story' : 'Media Flyer'),
      mediaType: mode === 'media' ? mediaType : 'text',
      caption: mode === 'media' ? caption : textContent,
      routeFingerprint: activeFingerprint,
      status: failedCount === 0 ? 'passed' : passedCount > 0 ? 'partially_revoked' : 'failed',
      targetSessionIds: targetSessions.map(s => s.id),
      targetAccountNames: targetSessions.map(s => s.name || s.id),
      sessionResults,
      autoExpireHours: autoExpireHours > 0 ? autoExpireHours : null,
      autoExpireAt,
      antiBanStagger,
      createdBy: 'Operator',
    };

    addBroadcastHistoryItem(historyItem);

    setIsBlasting(false);
    if (passedCount > 0) {
      toast.success(
        'Broadcast Complete',
        `Dispatched to ${passedCount} WhatsApp accounts${failedCount > 0 ? ` (${failedCount} failed)` : ''}.`,
      );
      onPosted();
      onClose();
    } else {
      toast.error('Broadcast Failed', 'All account dispatches failed. Inspect execution logs.');
    }
  };

  const filteredSessions = useMemo(() => {
    if (!searchAccountQuery.trim()) return readySessions;
    const q = searchAccountQuery.toLowerCase();
    return readySessions.filter(
      s => (s.name && s.name.toLowerCase().includes(q)) || (s.phone && s.phone.includes(q)),
    );
  }, [readySessions, searchAccountQuery]);

  const canSubmit =
    !isBlasting &&
    selectedSessionIds.length > 0 &&
    (mode === 'media' ? Boolean(mediaBase64) : Boolean(textContent.trim()));

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!isBlasting) onClose();
      }}
      className="blaster-modal"
      title={
        <div className="blaster-header-title">
          <Radio size={20} className="blaster-header-icon" />
          <span>Multi-Session Status Blaster</span>
          <span className="blaster-header-badge">{readySessions.length} active sessions</span>
        </div>
      }
      footer={
        <>
          <div className="blaster-footer-hint">
            <ShieldCheck size={14} className="text-emerald-500" />
            <span>Anti-ban safeguards active</span>
          </div>
          <button
            type="button"
            className="btn-secondary"
            onClick={onClose}
            disabled={isBlasting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={handleStartBlast}
            disabled={!canSubmit}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}
          >
            {isBlasting ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                <span>
                  Broadcasting ({progressIndex}/{selectedSessionIds.length})...
                </span>
              </>
            ) : (
              <>
                <Send size={16} />
                <span>
                  Broadcast to {selectedSessionIds.length}{' '}
                  {selectedSessionIds.length === 1 ? 'Account' : 'Accounts'}
                </span>
              </>
            )}
          </button>
        </>
      }
    >
      <div className="blaster-grid">
        {/* Left Column: Media / Text Content */}
        <div className="blaster-col">
          {/* Mode Switcher */}
          <div className="blaster-type-toggle">
            <button
              type="button"
              className={`blaster-type-btn ${mode === 'media' ? 'active' : ''}`}
              onClick={() => setMode('media')}
              disabled={isBlasting}
            >
              <ImageIcon size={16} />
              <span>Image / Video</span>
            </button>
            <button
              type="button"
              className={`blaster-type-btn ${mode === 'text' ? 'active' : ''}`}
              onClick={() => setMode('text')}
              disabled={isBlasting}
            >
              <Type size={16} />
              <span>Color Text</span>
            </button>
          </div>

          {mode === 'media' ? (
            <>
              {/* Media Upload / Preview */}
              {!mediaBase64 ? (
                <div
                  className="blaster-dropzone"
                  onDragOver={e => e.preventDefault()}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <input
                    type="file"
                    ref={fileInputRef}
                    accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime"
                    style={{ display: 'none' }}
                    onChange={handleFileChange}
                  />
                  <UploadCloud size={32} className="blaster-dropzone-icon" />
                  <div className="blaster-dropzone-title">Click to upload or drag & drop</div>
                  <div className="blaster-dropzone-subtitle">
                    JPG, PNG, WEBP, MP4, MOV up to 100MB
                  </div>
                </div>
              ) : (
                <div className="blaster-media-card">
                  {mediaType === 'video' ? (
                    <video src={mediaBase64} controls />
                  ) : (
                    <img src={mediaBase64} alt="Flyer Preview" />
                  )}
                  {!isBlasting && (
                    <button
                      type="button"
                      className="blaster-media-remove-btn"
                      onClick={() => {
                        setMediaFile(null);
                        setMediaBase64(null);
                      }}
                    >
                      <Trash2 size={12} />
                      <span>Remove</span>
                    </button>
                  )}
                </div>
              )}

              {/* Caption Editor */}
              <div className="blaster-field">
                <div className="blaster-field-label">
                  <span>Caption</span>
                  <span className="blaster-char-counter">{caption.length} / 700</span>
                </div>
                <textarea
                  className="blaster-textarea"
                  rows={3}
                  placeholder="Enter status caption (e.g. flight itineraries, fares, offers)..."
                  maxLength={700}
                  value={caption}
                  onChange={e => setCaption(e.target.value)}
                  disabled={isBlasting}
                />
              </div>
            </>
          ) : (
            <>
              {/* Text Story Editor */}
              <div className="blaster-field">
                <div className="blaster-field-label">
                  <span>Story Text</span>
                  <span className="blaster-char-counter">{textContent.length} / 700</span>
                </div>
                <textarea
                  className="blaster-textarea"
                  rows={4}
                  placeholder="Write your announcement or deal..."
                  maxLength={700}
                  value={textContent}
                  onChange={e => setTextContent(e.target.value)}
                  disabled={isBlasting}
                />
              </div>

              {/* Background Color Swatches */}
              <div className="blaster-field">
                <div className="blaster-field-label">
                  <span>Background Color</span>
                </div>
                <div className="blaster-color-picker">
                  {[
                    '#075E54',
                    '#128C7E',
                    '#25D366',
                    '#2563EB',
                    '#7C3AED',
                    '#DB2777',
                    '#DC2626',
                    '#1E293B',
                  ].map(c => (
                    <button
                      key={c}
                      type="button"
                      className={`blaster-color-swatch ${bgColor === c ? 'active' : ''}`}
                      onClick={() => setBgColor(c)}
                      style={{ backgroundColor: c }}
                      title={c}
                    />
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Route Fingerprint Banner */}
          {detectedRoutes.length > 0 && (
            <div className="blaster-route-card">
              <div className="blaster-route-card-title">
                <Sparkles size={14} />
                <span>Detected Flight Itinerary Routes</span>
              </div>
              <div className="blaster-route-chips">
                {detectedRoutes.map(r => (
                  <span key={r} className="blaster-route-chip">
                    ✈ {r}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Flash Sale Auto-Expire Selector */}
          <div className="blaster-field">
            <div className="blaster-field-label">
              <span>Auto-Expire / Flash Sale Duration</span>
              {autoExpireHours > 0 && (
                <span className="text-xs text-amber-500 font-semibold flex items-center gap-1">
                  <Clock size={12} /> Auto-Revoke Armed
                </span>
              )}
            </div>
            <select
              className="blaster-select"
              value={autoExpireHours}
              onChange={e => setAutoExpireHours(Number(e.target.value))}
              disabled={isBlasting}
            >
              <option value="0">Standard 24 Hours (WhatsApp Default)</option>
              <option value="2">⚡ 2 Hours (Urgent Flash Deal)</option>
              <option value="4">⚡ 4 Hours (Limited Seats Deal)</option>
              <option value="6">⚡ 6 Hours (Today&apos;s Special)</option>
              <option value="12">⚡ 12 Hours (Half-Day Special)</option>
            </select>
          </div>
        </div>

        {/* Right Column: Multi-Account Selector */}
        <div className="blaster-col">
          {/* Accounts Header & Filter */}
          <div className="blaster-field">
            <div className="blaster-field-label">
              <span>Target WhatsApp Accounts</span>
              <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                {selectedSessionIds.length} of {readySessions.length} selected
              </span>
            </div>

            <div className="blaster-accounts-header">
              <div className="blaster-search-bar">
                <Search size={15} className="blaster-search-icon" />
                <input
                  type="text"
                  className="blaster-search-field"
                  placeholder="Search accounts or phone..."
                  value={searchAccountQuery}
                  onChange={e => setSearchAccountQuery(e.target.value)}
                  disabled={isBlasting}
                />
              </div>
              <button
                type="button"
                className="blaster-btn-toggle-all"
                onClick={toggleSelectAll}
                disabled={isBlasting}
              >
                {selectedSessionIds.length === readySessions.length ? 'Deselect All' : 'Select All'}
              </button>
            </div>
          </div>

          {/* Accounts Checklist */}
          <div className="blaster-accounts-list">
            {filteredSessions.length === 0 ? (
              <div className="blaster-accounts-empty">No matching accounts found</div>
            ) : (
              filteredSessions.map(session => {
                const isSelected = selectedSessionIds.includes(session.id);
                const isDuplicate = liveDuplicatesBySession.has(session.id);
                const phoneDisplay = session.phone ? formatPhoneForDisplay(session.phone) : '';

                return (
                  <div
                    key={session.id}
                    className={`blaster-account-item ${isSelected ? 'selected' : ''}`}
                    onClick={() => {
                      if (!isBlasting) toggleSession(session.id);
                    }}
                  >
                    <div className="blaster-account-left">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {}}
                        disabled={isBlasting}
                        style={{ accentColor: 'var(--primary)', cursor: 'pointer' }}
                      />
                      <div className="blaster-account-avatar">
                        <Smartphone size={14} />
                      </div>
                      <div className="blaster-account-meta">
                        <div className="blaster-account-name-row">
                          <span className="blaster-account-name">{session.name || session.id}</span>
                          {isDuplicate && (
                            <span className="blaster-dup-tag">Already Live</span>
                          )}
                        </div>
                        {phoneDisplay && (
                          <span className="blaster-account-phone">{phoneDisplay}</span>
                        )}
                      </div>
                    </div>

                    <span className="status-pill status-pill-own" style={{ fontSize: '0.6875rem' }}>
                      Ready
                    </span>
                  </div>
                );
              })
            )}
          </div>

          {/* Safety & Anti-Ban Staggering */}
          <div className="blaster-safety-card">
            <label className="blaster-safety-toggle">
              <input
                type="checkbox"
                checked={antiBanStagger}
                onChange={e => setAntiBanStagger(e.target.checked)}
                disabled={isBlasting}
              />
              <ShieldCheck size={16} className="text-emerald-600 dark:text-emerald-400" />
              <span>Anti-Ban Smart Staggering (3s – 5s Jitter)</span>
            </label>
            <p className="blaster-safety-desc">
              Injects randomized intervals between account dispatches to prevent concurrent trigger bans.
            </p>
          </div>

          {/* Execution Progress & Logs */}
          {isBlasting && (
            <div className="blaster-progress-box">
              <div className="blaster-progress-header">
                <span className="blaster-progress-title">
                  <Loader2 size={14} className="animate-spin" />
                  <span>Broadcasting in progress...</span>
                </span>
                <span className="blaster-progress-counter">
                  {progressIndex} / {selectedSessionIds.length}
                </span>
              </div>

              <div className="blaster-progress-track">
                <div
                  className="blaster-progress-fill"
                  style={{
                    width: `${(progressIndex / selectedSessionIds.length) * 100}%`,
                  }}
                />
              </div>

              <div className="blaster-log-scroll">
                {executionLogs.map((log, idx) => (
                  <div key={idx} className="blaster-log-row">
                    <span className="font-medium text-slate-800 dark:text-slate-200">
                      {log.name}
                    </span>
                    {log.status === 'success' && (
                      <span className="blaster-log-success">
                        <CheckCircle2 size={12} />
                        <span>{log.message}</span>
                      </span>
                    )}
                    {log.status === 'error' && (
                      <span className="blaster-log-error">
                        <AlertCircle size={12} />
                        <span>{log.message}</span>
                      </span>
                    )}
                    {log.status === 'pending' && (
                      <span className="blaster-log-pending">
                        <Clock size={12} />
                        <span>{log.message || 'Queued'}</span>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default MultiSessionBlasterModal;
