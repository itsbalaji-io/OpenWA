import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Loader2,
  Smartphone,
  Image as ImageIcon,
  Type,
  UploadCloud,
  Trash2,
  Sparkles,
  Clock,
  Send,
} from 'lucide-react';
import { contactApi, sessionApi, type Session } from '../../services/api';
import { useRole } from '../../hooks/useRole';
import { useToast } from '../../hooks/useToast';
import { Modal } from '../Modal';
import { MEDIA_UPLOAD_MAX_BYTES } from '../../utils/mediaUpload';
import { captionLength } from '../../utils/bulkMedia';
import { matches } from '../../utils/chatFilters';
import { statusFontsFor } from '../../utils/statusFonts';
import { extractRouteFingerprint, extractRouteDisplayList } from '../../utils/statusRoutes';
import { addBroadcastHistoryItem, type BroadcastHistoryItem } from '../../utils/statusHistoryStorage';
import './StatusComposeModal.css';

// Mirrors @ArrayMaxSize(256) on the send-status DTOs — the picker caps selection client-side so the
// user can't build a list the backend is guaranteed to reject.
const STATUS_RECIPIENTS_MAX = 256;

interface Props {
  sessionId: string;
  sessions?: Session[];
  onClose: () => void;
  onPosted: () => void;
}

function StatusComposeModal({ sessionId, sessions, onClose, onPosted }: Props) {
  const { t } = useTranslation();
  const { success: showSuccessToast, error: showErrorToast } = useToast();
  // From the sign-in validate response: GET /infra/engines/current is admin-only, and operators post too.
  const { engineType } = useRole();

  // Active target session state (defaults to provided prop sessionId, with dropdown switch support)
  const [activeSessionId, setActiveSessionId] = useState<string>(sessionId);

  useEffect(() => {
    if (sessionId) setActiveSessionId(sessionId);
  }, [sessionId]);

  // If sessions prop is not provided, query the sessions list
  const sessionsQuery = useQuery({
    queryKey: ['sessions'],
    queryFn: () => sessionApi.list(),
    enabled: !sessions || sessions.length === 0,
  });

  const availableSessions = useMemo(() => {
    const list = sessions && sessions.length > 0 ? sessions : (sessionsQuery.data ?? []);
    return list;
  }, [sessions, sessionsQuery.data]);

  const activeSession = useMemo(() => {
    return availableSessions.find(s => s.id === activeSessionId);
  }, [availableSessions, activeSessionId]);

  // Baileys targets a status post to an explicit allow-list (statusJidList); whatsapp-web.js has no
  // per-recipient concept and broadcasts to the account's status-privacy audience instead, so the
  // recipient picker is Baileys-only.
  const isBaileysEngine = engineType === 'baileys';

  const [composeType, setComposeType] = useState<'image' | 'text'>('image');
  const [composeText, setComposeText] = useState<string>('');
  const [composeBgColor, setComposeBgColor] = useState<string>('#075E54');
  const [composeFont, setComposeFont] = useState<string>('');
  const [composeImageUrl, setComposeImageUrl] = useState<string>('');
  const [composeImageBase64, setComposeImageBase64] = useState<string | null>(null);
  const [composeCaption, setComposeCaption] = useState<string>('');
  const [autoExpireHours, setAutoExpireHours] = useState<number>(0);
  const [composeRecipients, setComposeRecipients] = useState<string[]>([]);
  const [composeRecipientSearch, setComposeRecipientSearch] = useState<string>('');
  const [composePosting, setComposePosting] = useState<boolean>(false);
  const composeFileInputRef = useRef<HTMLInputElement | null>(null);
  const composeImageReadSeq = useRef(0);

  useEffect(() => {
    return () => {
      composeImageReadSeq.current += 1;
    };
  }, []);

  const composeContactsQuery = useQuery({
    queryKey: ['status-compose-contacts', activeSessionId],
    queryFn: () => contactApi.list(activeSessionId!),
    enabled: isBaileysEngine && Boolean(activeSessionId),
    retry: false,
  });
  const composeContacts = composeContactsQuery.data ?? [];
  const filteredComposeContacts = composeContacts.filter(c =>
    matches(composeRecipientSearch, c.name, c.pushName, c.number, c.id),
  );

  const detectedRoutes = useMemo(() => {
    return extractRouteDisplayList(composeType === 'image' ? composeCaption : composeText);
  }, [composeType, composeCaption, composeText]);

  const activeFingerprint = useMemo(() => {
    return extractRouteFingerprint(composeType === 'image' ? composeCaption : composeText);
  }, [composeType, composeCaption, composeText]);

  const resetComposeForm = useCallback(() => {
    composeImageReadSeq.current += 1;
    setComposeType('image');
    setComposeText('');
    setComposeBgColor('#075E54');
    setComposeFont('');
    setComposeImageUrl('');
    setComposeImageBase64(null);
    setComposeCaption('');
    setAutoExpireHours(0);
    setComposeRecipients([]);
    setComposeRecipientSearch('');
    if (composeFileInputRef.current) composeFileInputRef.current.value = '';
  }, []);

  const closeComposeModal = useCallback(() => {
    onClose();
    resetComposeForm();
  }, [onClose, resetComposeForm]);

  const toggleComposeRecipient = (id: string) => {
    setComposeRecipients(prev =>
      prev.includes(id) ? prev.filter(r => r !== id) : prev.length >= STATUS_RECIPIENTS_MAX ? prev : [...prev, id],
    );
  };

  const allFilteredRecipientIds = useMemo(() => {
    return filteredComposeContacts.map(c => c.id).slice(0, STATUS_RECIPIENTS_MAX);
  }, [filteredComposeContacts]);

  const areAllFilteredSelected = useMemo(() => {
    if (allFilteredRecipientIds.length === 0) return false;
    return allFilteredRecipientIds.every(id => composeRecipients.includes(id));
  }, [allFilteredRecipientIds, composeRecipients]);

  const toggleSelectAllRecipients = () => {
    if (areAllFilteredSelected) {
      setComposeRecipients(prev => prev.filter(id => !allFilteredRecipientIds.includes(id)));
    } else {
      setComposeRecipients(prev => {
        const combined = new Set([...prev, ...allFilteredRecipientIds]);
        return Array.from(combined).slice(0, STATUS_RECIPIENTS_MAX);
      });
    }
  };

  const handleComposeImageUrlChange = (value: string) => {
    composeImageReadSeq.current += 1;
    setComposeImageUrl(value);
    setComposeImageBase64(null);
    if (composeFileInputRef.current) composeFileInputRef.current.value = '';
  };

  const handleComposeImageFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MEDIA_UPLOAD_MAX_BYTES) {
      showErrorToast(
        t('chats.media.fileTooLargeTitle'),
        t('chats.media.fileTooLarge', { max: Math.round(MEDIA_UPLOAD_MAX_BYTES / (1024 * 1024)) }),
      );
      if (composeFileInputRef.current) composeFileInputRef.current.value = '';
      return;
    }
    setComposeImageUrl('');
    const myRead = ++composeImageReadSeq.current;
    const reader = new FileReader();
    reader.onload = event => {
      if (composeImageReadSeq.current !== myRead) return;
      setComposeImageBase64(event.target?.result as string);
    };
    reader.readAsDataURL(file);
  };

  const composeTextLength = captionLength(composeText.trim());
  const composeCaptionLength = captionLength(composeCaption.trim());
  const composeCanSubmit =
    Boolean(activeSessionId) &&
    !composePosting &&
    Boolean(engineType) &&
    (composeType === 'text' ? composeText.trim().length > 0 : Boolean(composeImageBase64 || composeImageUrl.trim())) &&
    (composeType === 'text' ? composeTextLength <= 4096 : composeCaptionLength <= 1024) &&
    (!isBaileysEngine || composeRecipients.length > 0);

  const handleComposeSubmit = async () => {
    if (!activeSessionId || !composeCanSubmit) return;
    setComposePosting(true);
    try {
      const selfJid = activeSession?.phone ? `${activeSession.phone.replace(/\D/g, '')}@c.us` : undefined;
      const recipients = isBaileysEngine
        ? Array.from(new Set([...(selfJid ? [selfJid] : []), ...composeRecipients]))
        : undefined;
      let postRes: { statusId?: string } | null = null;

      if (composeType === 'text') {
        postRes = (await sessionApi.postTextStatus(activeSessionId, composeText.trim(), recipients, {
          backgroundColor: composeBgColor || undefined,
          font: composeFont === '' ? undefined : Number(composeFont),
        })) as { statusId?: string } | null;
      } else {
        const image = composeImageBase64
          ? { base64: composeImageBase64, mimetype: /^data:(image\/[^;,]+)/.exec(composeImageBase64)?.[1] }
          : { url: composeImageUrl.trim() };
        postRes = (await sessionApi.postImageStatus(activeSessionId, image, recipients, composeCaption.trim() || undefined)) as { statusId?: string } | null;
      }

      const statusId = postRes?.statusId || '';
      const autoExpireAt = autoExpireHours > 0 ? new Date(Date.now() + autoExpireHours * 3600 * 1000).toISOString() : null;

      // Add to broadcast audit history so user can view & delete/revoke directly from the dashboard
      const historyRecord: BroadcastHistoryItem = {
        id: `item-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        createdAt: new Date().toISOString(),
        fileName: composeType === 'image' ? (composeImageBase64 ? 'Image Flyer' : composeImageUrl || 'Flyer') : 'Color Text Story',
        mediaType: composeType,
        caption: composeType === 'image' ? composeCaption : composeText,
        routeFingerprint: activeFingerprint,
        status: 'passed',
        targetSessionIds: [activeSessionId],
        targetAccountNames: [activeSession?.name || activeSessionId],
        sessionResults: [
          {
            sessionId: activeSessionId,
            name: activeSession?.name || activeSessionId,
            phone: activeSession?.phone || undefined,
            status: 'passed',
            statusId,
            postTimestamp: new Date().toISOString(),
          },
        ],
        autoExpireHours: autoExpireHours > 0 ? autoExpireHours : null,
        autoExpireAt,
        antiBanStagger: false,
        createdBy: 'Single Operator',
      };
      addBroadcastHistoryItem(historyRecord);

      showSuccessToast(t('chats.status.posted'));
      closeComposeModal();
      onPosted();
    } catch (err) {
      showErrorToast(t('chats.status.postFailed'), err instanceof Error ? err.message : undefined);
    } finally {
      setComposePosting(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => !composePosting && closeComposeModal()}
      hideCloseButton={composePosting}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
          <Smartphone size={20} className="text-emerald-500" />
          <span>Post WhatsApp Status</span>
          {activeSession && (
            <span
              style={{
                fontSize: '0.75rem',
                fontWeight: 600,
                padding: '0.125rem 0.5rem',
                borderRadius: '9999px',
                background: 'var(--primary-soft)',
                color: 'var(--primary-text)',
              }}
            >
              {activeSession.name || activeSession.id}
            </span>
          )}
        </div>
      }
      closeLabel={t('common.close')}
      className="status-compose-modal blaster-modal"
      footer={
        <>
          <button className="btn-secondary" onClick={closeComposeModal} disabled={composePosting}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            onClick={handleComposeSubmit}
            disabled={!composeCanSubmit}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}
          >
            {composePosting ? (
              <>
                <Loader2 className="animate-spin" size={16} />
                <span>Posting...</span>
              </>
            ) : (
              <>
                <Send size={16} />
                <span>{t('chats.status.post')}</span>
              </>
            )}
          </button>
        </>
      }
    >
      <div className="status-compose-content">
        {/* Session / Account Selector */}
        {availableSessions.length > 0 && (
          <div className="compose-field">
            <label htmlFor="scm-session-select" style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontWeight: 600 }}>
              <Smartphone size={14} className="text-emerald-500" />
              <span>Target WhatsApp Account</span>
            </label>
            <select
              id="scm-session-select"
              value={activeSessionId}
              onChange={e => setActiveSessionId(e.target.value)}
              disabled={composePosting}
              style={{
                width: '100%',
                padding: '0.625rem 0.75rem',
                borderRadius: 'var(--radius, 8px)',
                border: '1px solid var(--border)',
                background: 'var(--bg-light)',
                color: 'var(--text-primary)',
                fontSize: '0.875rem',
              }}
            >
              {availableSessions.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name || s.id} {s.phone ? `(${s.phone})` : ''} [{s.status}]
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Segmented Type Toggle */}
        <div className="compose-type-toggle">
          <button
            type="button"
            className={composeType === 'image' ? 'active' : ''}
            aria-pressed={composeType === 'image'}
            onClick={() => setComposeType('image')}
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem' }}
          >
            <ImageIcon size={15} />
            <span>{t('chats.status.composeImage')}</span>
          </button>
          <button
            type="button"
            className={composeType === 'text' ? 'active' : ''}
            aria-pressed={composeType === 'text'}
            onClick={() => setComposeType('text')}
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem' }}
          >
            <Type size={15} />
            <span>{t('chats.status.composeText')}</span>
          </button>
        </div>

        {composeType === 'image' ? (
          <>
            {/* Drag & Drop Upload Zone or Preview */}
            {!composeImageBase64 ? (
              <div
                className="single-compose-dropzone"
                onClick={() => composeFileInputRef.current?.click()}
              >
                <input
                  id="scm-file"
                  type="file"
                  accept="image/*"
                  aria-label={t('chats.status.imageFile')}
                  ref={composeFileInputRef}
                  style={{ display: 'none' }}
                  onChange={handleComposeImageFile}
                />
                <UploadCloud size={32} className="text-emerald-500" />
                <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--text-primary)' }}>
                  Click to select flyer or drag & drop
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Supports JPG, PNG, WEBP up to 18MB
                </div>
              </div>
            ) : (
              <div className="single-compose-preview-card">
                <img src={composeImageBase64} alt="Status Preview" />
                {!composePosting && (
                  <button
                    type="button"
                    className="single-compose-remove-btn"
                    onClick={() => {
                      setComposeImageBase64(null);
                      if (composeFileInputRef.current) composeFileInputRef.current.value = '';
                    }}
                  >
                    <Trash2 size={12} />
                    <span>Remove</span>
                  </button>
                )}
              </div>
            )}

            <div className="compose-field">
              <label htmlFor="scm-4" style={{ fontSize: '0.8125rem' }}>Image URL (Optional Alternative)</label>
              <input
                id="scm-4"
                type="url"
                placeholder="https://example.com/image.jpg"
                value={composeImageUrl}
                onChange={e => handleComposeImageUrlChange(e.target.value)}
              />
            </div>

            <div className="compose-field">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.375rem' }}>
                <label htmlFor="scm-5" style={{ margin: 0 }}>{t('chats.status.caption')}</label>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{composeCaptionLength} / 1024</span>
              </div>
              <textarea
                id="scm-5"
                rows={3}
                placeholder={t('chats.captionPlaceholder')}
                value={composeCaption}
                onChange={e => setComposeCaption(e.target.value)}
                style={{ width: '100%', boxSizing: 'border-box' }}
              />
              <span className={composeCaptionLength > 1024 ? 'input-hint' : undefined} role="status">
                {composeCaptionLength > 1024 ? t('common.fieldTooLong', { max: 1024, count: composeCaptionLength }) : ''}
              </span>
            </div>
          </>
        ) : (
          <>
            <div className="compose-field">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.375rem' }}>
                <label htmlFor="scm-1" style={{ margin: 0 }}>{t('chats.status.composeText')}</label>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{composeTextLength} / 4096</span>
              </div>
              <textarea
                id="scm-1"
                value={composeText}
                onChange={e => setComposeText(e.target.value)}
                placeholder={t('chats.status.composeText')}
                rows={4}
                style={{ width: '100%', boxSizing: 'border-box' }}
              />
              <span className={composeTextLength > 4096 ? 'input-hint' : undefined} role="status">
                {composeTextLength > 4096 ? t('common.fieldTooLong', { max: 4096, count: composeTextLength }) : ''}
              </span>
            </div>

            {/* Background Color Swatches */}
            <div className="compose-field">
              <label htmlFor="scm-2">{t('chats.status.backgroundColor')}</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.375rem' }}>
                {['#075E54', '#128C7E', '#25D366', '#2563EB', '#7C3AED', '#DB2777', '#DC2626', '#1E293B'].map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setComposeBgColor(c)}
                    style={{
                      width: '28px',
                      height: '28px',
                      borderRadius: '50%',
                      backgroundColor: c,
                      border: composeBgColor === c ? '2px solid var(--text-primary)' : '2px solid transparent',
                      cursor: 'pointer',
                      padding: 0,
                    }}
                  />
                ))}
              </div>
              <input
                id="scm-2"
                type="color"
                value={composeBgColor || '#075E54'}
                onChange={e => setComposeBgColor(e.target.value)}
              />
            </div>

            <div className="compose-field">
              <label htmlFor="scm-3">{t('chats.status.font')}</label>
              <select id="scm-3" value={composeFont} onChange={e => setComposeFont(e.target.value)}>
                <option value="">{t('chats.status.fontDefault')}</option>
                {statusFontsFor(engineType).map(f => (
                  <option key={f.id} value={f.id}>
                    {t(f.labelKey)}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        {/* Route Fingerprint Detection Banner */}
        {detectedRoutes.length > 0 && (
          <div className="single-compose-route-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.75rem', fontWeight: 600, color: 'var(--info)' }}>
              <Sparkles size={14} />
              <span>Detected Flight Itinerary Routes</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', marginTop: '0.25rem' }}>
              {detectedRoutes.map(r => (
                <span
                  key={r}
                  style={{
                    padding: '0.125rem 0.5rem',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    borderRadius: '4px',
                    background: 'color-mix(in srgb, var(--info) 16%, var(--bg-white))',
                    color: 'var(--info)',
                    border: '1px solid color-mix(in srgb, var(--info) 30%, transparent)',
                  }}
                >
                  ✈ {r}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Auto-Expire Duration Selector */}
        <div className="compose-field">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <label htmlFor="scm-auto-expire" style={{ margin: 0 }}>Flash Sale / Auto-Expire Duration</label>
            {autoExpireHours > 0 && (
              <span style={{ fontSize: '0.75rem', color: 'var(--warning-text)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <Clock size={12} /> Auto-Revoke Armed
              </span>
            )}
          </div>
          <select
            id="scm-auto-expire"
            value={autoExpireHours}
            onChange={e => setAutoExpireHours(Number(e.target.value))}
            style={{
              width: '100%',
              padding: '0.625rem 0.75rem',
              borderRadius: 'var(--radius, 8px)',
              border: '1px solid var(--border)',
              background: 'var(--bg-light)',
              color: 'var(--text-primary)',
              fontSize: '0.875rem',
            }}
          >
            <option value="0">Standard 24 Hours (WhatsApp Default)</option>
            <option value="2">⚡ 2 Hours (Urgent Flash Deal)</option>
            <option value="4">⚡ 4 Hours (Limited Seats Deal)</option>
            <option value="6">⚡ 6 Hours (Today&apos;s Special)</option>
            <option value="12">⚡ 12 Hours (Half-Day Special)</option>
          </select>
        </div>

        {/* Baileys engine recipients selection */}
        {isBaileysEngine && (
          <div className="compose-field">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <label htmlFor="scm-6" style={{ margin: 0 }}>
                {t('chats.status.recipients')}{' '}
                <span style={{ fontSize: '0.8em', color: 'var(--text-secondary)' }}>
                  ({composeRecipients.length} / {STATUS_RECIPIENTS_MAX} selected)
                </span>
              </label>
              {filteredComposeContacts.length > 0 && (
                <button
                  type="button"
                  className="btn-link"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--primary, #10b981)',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    padding: 0,
                    textDecoration: 'underline',
                  }}
                  onClick={toggleSelectAllRecipients}
                >
                  {areAllFilteredSelected
                    ? 'Deselect All'
                    : `Select All (${Math.min(filteredComposeContacts.length, STATUS_RECIPIENTS_MAX)})`}
                </button>
              )}
            </div>
            <input
              id="scm-6"
              type="text"
              placeholder={t('common.search')}
              value={composeRecipientSearch}
              onChange={e => setComposeRecipientSearch(e.target.value)}
            />
            <div className="compose-recipients">
              {composeContactsQuery.isLoading ? (
                <div className="compose-recipients-empty">
                  <Loader2 className="animate-spin" size={16} />
                </div>
              ) : composeContactsQuery.isError ? (
                <div className="compose-recipients-empty">{t('dashboard.loadError')}</div>
              ) : filteredComposeContacts.length === 0 ? (
                <div className="compose-recipients-empty">{t('chats.status.noContacts')}</div>
              ) : (
                filteredComposeContacts.map(c => (
                  <label key={c.id} className="compose-recipient-row">
                    <input
                      type="checkbox"
                      checked={composeRecipients.includes(c.id)}
                      disabled={!composeRecipients.includes(c.id) && composeRecipients.length >= STATUS_RECIPIENTS_MAX}
                      onChange={() => toggleComposeRecipient(c.id)}
                    />
                    <span>{c.name || c.pushName || c.number || c.id}</span>
                  </label>
                ))
              )}
            </div>
            <p className="input-hint">{t('chats.status.recipientsHint')}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default StatusComposeModal;
