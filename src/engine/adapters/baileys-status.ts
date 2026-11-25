import type { AnyMessageContent, WAMessage, WASocket } from '@whiskeysockets/baileys';
import { MediaInput, StatusPostOptions, StatusResult } from '../interfaces/whatsapp-engine.interface';
import { BadRequestException, Logger } from '@nestjs/common';
import {
  CONNECTION_LOST_DURING_STATUS_POST,
  CONNECTION_LOST_DURING_STATUS_REVOKE,
  mapSendRefusal,
  resolveMediaBuffer,
  uploadBeforeRelay,
} from './baileys-messaging';
import { describeAudio, describeVideo } from './baileys-audio-probe';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { markNothingSent, markOutcomeUnknown, provesNothingSent } from '../../common/errors/engine-not-sent.error';
import { BAILEYS_QUERY_BUDGET_MS } from './baileys-query-deadline';

/** How long WhatsApp keeps a status up. */
const STATUS_TTL_MS = 24 * 3_600_000;

/** Optional fallback status JIDs configured via STATUS_TEAM_JIDS (comma-separated). */
function getTeamJids(): string[] {
  const raw = process.env.STATUS_TEAM_JIDS || '';
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Status-domain operations extracted from BaileysAdapter. The adapter keeps the public
 * methods as thin forwarders and injects this narrow host surface via closures, so the
 * delegate never touches lifecycle state directly.
 */
export interface BaileysStatusHost {
  /** This session's egress proxy URL (snapshotted at session start), or undefined when direct. */
  sessionProxyUrl(): string | undefined;
  ensureReady(): void;
  /** Post-ensureReady socket handle — call host.ensureReady() first. */
  getSocket(): WASocket;
  /** The live socket or null, read without a readiness check: null once a stop or logout tore it down. */
  getSocketOrNull(): WASocket | null;
  toEngineJid(jid: string): string;
  normalizedSelfJid(): string;
  /** Baileys timestamps are `number | Long`; normalize to unix seconds. */
  toUnixSeconds(ts: number | string | { toNumber(): number } | null | undefined): number;
  /** Record the id of a message this session just sent, so its library echo is recognised as ours. */
  rememberOwnSend(id: string | null | undefined): void;
  listContacts?(): any[];
  listChats?(): any[];
}

export class BaileysStatus {
  private readonly logger = new Logger(BaileysStatus.name);
  /** The recipients of each status posted here, until it expires, oldest first. */
  private readonly audiences = new Map<string, { jids: string[]; expiresAt: number }>();

  constructor(private readonly host: BaileysStatusHost) {}

  /** Post-ensureReady socket handle. */
  private sock(expected?: WASocket): WASocket {
    this.host.ensureReady();
    const socket = this.host.getSocket();
    if (expected && socket !== expected) throw new EngineNotReadyError();
    return socket;
  }

  /**
   * Send to `status@broadcast` with transient retry loop and upstream connection-lost outcome tracking.
   */
  private async sendStatus(
    content: AnyMessageContent,
    options: Parameters<WASocket['sendMessage']>[2],
    expected?: WASocket,
    lost = CONNECTION_LOST_DURING_STATUS_POST,
  ): Promise<WAMessage | undefined> {
    const deadline = this.host.sessionProxyUrl() ? { mediaUploadTimeoutMs: BAILEYS_QUERY_BUDGET_MS } : {};
    let lastError: any;

    for (let attempt = 1; attempt <= 3; attempt++) {
      const sock = this.sock(expected);
      const sendOptions = { ...options, ...deadline, upload: uploadBeforeRelay(sock) };
      try {
        return await sock.sendMessage('status@broadcast', content, sendOptions);
      } catch (error) {
        lastError = error;
        const msg = String((error as any)?.message || error || '');
        const isTransient =
          msg.includes('Media upload failed') ||
          msg.includes('media connection') ||
          msg.includes('attrs') ||
          msg.includes('Connection was lost') ||
          msg.includes('Connection Terminated') ||
          msg.includes('timed out');

        if (attempt < 3 && isTransient && this.host.getSocketOrNull() === sock) {
          this.logger.warn(`sendStatus attempt ${attempt} failed (${msg}), retrying in ${attempt * 2}s...`);
          await new Promise(r => setTimeout(r, attempt * 2000));
          continue;
        }

        if (this.host.getSocketOrNull() !== sock) {
          throw provesNothingSent(error)
            ? markNothingSent(new EngineNotReadyError())
            : markOutcomeUnknown(new EngineNotReadyError(lost));
        }
        throw mapSendRefusal(error);
      }
    }
    throw mapSendRefusal(lastError);
  }

  postTextStatus(text: string, options: StatusPostOptions): Promise<StatusResult> {
    return this.postStatus({ text, linkPreview: null }, options);
  }

  postImageStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.postMediaStatus('image', media, options);
  }

  postVideoStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.postMediaStatus('video', media, options);
  }

  postVoiceStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.postMediaStatus('voice', media, options);
  }

  private async postMediaStatus(
    kind: 'image' | 'video' | 'voice',
    media: MediaInput,
    options: StatusPostOptions,
  ): Promise<StatusResult> {
    const socket = this.sock();
    const fallbackType = kind === 'image' ? 'image/jpeg' : kind === 'video' ? 'video/mp4' : 'audio/ogg; codecs=opus';
    const { data, mimetype } = await resolveMediaBuffer(media, this.host.sessionProxyUrl(), fallbackType);
    const content: AnyMessageContent =
      kind === 'image'
        ? { image: data, caption: options.caption, mimetype }
        : kind === 'video'
          ? { video: data, caption: options.caption, mimetype, ...(await describeVideo(data)) }
          : { audio: data, mimetype, ptt: true, ...(await describeAudio(data, true)) };
    return this.postStatus(content, options, socket);
  }

  private isUserStatusJid(id: unknown): id is string {
    if (typeof id !== 'string' || !id) return false;
    if (id.startsWith('0@')) return false;
    return id.endsWith('@c.us') || id.endsWith('@s.whatsapp.net') || id.endsWith('@lid');
  }

  /** Baileys posts to exactly the statusJidList allow-list, so a status without recipients is a client error. */
  private requireRecipients(options: StatusPostOptions): string[] {
    if (!options.recipients?.length) {
      throw new BadRequestException('recipients is required to post a status on the Baileys engine');
    }
    return options.recipients;
  }

  /**
   * Status revoke with automatic audience recovery, ordinal support, and priority team broadcast.
   */
  async deleteStatus(rawStatusId: string): Promise<void> {
    this.host.ensureReady();
    const target = String(rawStatusId || '').trim();
    const lower = target.toLowerCase();

    let realId = target;
    let audience = this.audiences.get(realId);

    // 0. If "all" is requested
    if (lower === 'all') {
      const keys = Array.from(this.audiences.keys());
      for (const key of keys) {
        try {
          await this.deleteStatus(key);
        } catch (_) {}
      }
      return;
    }

    // 1. If keyword / ordinal requested (e.g. "latest", "last", "1", "oldest")
    if (lower === 'latest' || lower === 'last' || lower === 'newest') {
      const keys = Array.from(this.audiences.keys());
      if (keys.length > 0) {
        realId = keys[keys.length - 1];
        audience = this.audiences.get(realId);
      }
    } else if (lower === '1' || lower === 'oldest' || lower === 'first') {
      const keys = Array.from(this.audiences.keys());
      if (keys.length > 0) {
        realId = keys[0];
        audience = this.audiences.get(realId);
      }
    } else if (/^\d+$/.test(lower)) {
      const idx = parseInt(lower, 10) - 1;
      const keys = Array.from(this.audiences.keys());
      if (idx >= 0 && idx < keys.length) {
        realId = keys[idx];
        audience = this.audiences.get(realId);
      }
    }

    // 2. If ID contains underscores (e.g. true_status@broadcast_3EB0270EC28352521BB5A3_...)
    if (!audience && realId.includes('_')) {
      const parts = realId.split('_');
      const candidate = parts.length >= 3 ? parts[2] : parts[parts.length - 1];
      if (this.audiences.has(candidate)) {
        realId = candidate;
        audience = this.audiences.get(realId);
      } else {
        realId = candidate;
      }
    }

    if (!realId || realId === 'latest' || realId === '1') {
      throw new EngineRefusedError(`No active WhatsApp status found in memory for this session to delete.`);
    }

    let ownJid: string | null = null;
    let ownLidJid: string | null = null;
    try {
      const sock = this.sock();
      if (sock?.user?.id) {
        ownJid = this.host.toEngineJid(sock.user.id);
      }
      if (sock?.user?.lid) {
        const lidUser = String(sock.user.lid).split('@')[0].split(':')[0];
        if (lidUser) ownLidJid = `${lidUser}@lid`;
      }
    } catch (_) {}

    // 3. Collect exact audience: prefer cached audience.jids (exact recipients who received the status);
    // only fall back to contacts (then chats if contacts empty) when audience is not in memory.
    const recipientJids: string[] = [];
    if (audience?.jids && audience.jids.length > 0) {
      recipientJids.push(...audience.jids);
    } else {
      try {
        const contacts = this.host.listContacts ? this.host.listContacts() : [];
        for (const c of contacts) {
          const id = c.id || c.jid;
          if (this.isUserStatusJid(id)) {
            recipientJids.push(this.host.toEngineJid(id));
          }
        }
      } catch (_) {}

      if (recipientJids.length === 0) {
        try {
          const chats = this.host.listChats ? this.host.listChats() : [];
          for (const c of chats) {
            const id = c.id;
            if (this.isUserStatusJid(id)) {
              recipientJids.push(this.host.toEngineJid(id));
            }
          }
        } catch (_) {}
      }
      recipientJids.push(...getTeamJids());
    }

    if (ownJid) recipientJids.push(ownJid);

    const allRecipients = Array.from(new Set(recipientJids.filter(Boolean)));
    const ownPnParticipant = this.host.toEngineJid(this.host.normalizedSelfJid());
    const deletePayloads: AnyMessageContent[] = [
      {
        delete: {
          remoteJid: 'status@broadcast',
          fromMe: true,
          id: realId,
          participant: ownPnParticipant,
        },
      },
    ];
    if (ownLidJid && ownLidJid !== ownPnParticipant) {
      deletePayloads.push({
        delete: {
          remoteJid: 'status@broadcast',
          fromMe: true,
          id: realId,
          participant: ownLidJid,
        },
      });
    }

    let lastSent: WAMessage | undefined = undefined;

    // 4. Send revoke directly to the exact audience (in batches of 500 only if > 500)
    const BATCH_SIZE = 500;
    const batches: string[][] = [];
    for (let i = 0; i < allRecipients.length; i += BATCH_SIZE) {
      batches.push(allRecipients.slice(i, i + BATCH_SIZE));
    }

    this.logger.log(
      `Broadcasting status revoke for ${realId} (${deletePayloads.length} key variant(s)) to ${allRecipients.length} recipients across ${batches.length} batch(es)`,
    );

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      for (let p = 0; p < deletePayloads.length; p++) {
        const payload = deletePayloads[p];
        try {
          const batchSent = await this.sendStatus(
            payload,
            { statusJidList: batch },
            undefined,
            CONNECTION_LOST_DURING_STATUS_REVOKE,
          );
          if (batchSent?.key?.id) {
            this.host.rememberOwnSend(batchSent.key.id);
            if (!lastSent) lastSent = batchSent;
          }
        } catch (batchErr: any) {
          this.logger.warn(
            `Status revoke batch ${i + 1}/${batches.length} (variant ${p + 1}) failed for ${realId}: ${batchErr?.message || batchErr}`,
          );
        }
        if (p < deletePayloads.length - 1) {
          await new Promise(r => setTimeout(r, 350));
        }
      }
      this.logger.log(`Status revoke batch ${i + 1}/${batches.length} sent (${batch.length} recipients) for ${realId}`);
      if (i < batches.length - 1) {
        await new Promise(r => setTimeout(r, 800));
      }
    }

    this.audiences.delete(realId);
  }

  /**
   * Post a status (story) to `status@broadcast`.
   * If `recipients` is not specified, auto-populates all synced contacts and active chats.
   */
  private async postStatus(
    content: AnyMessageContent,
    options: StatusPostOptions,
    expected?: WASocket,
  ): Promise<StatusResult> {
    this.host.ensureReady();

    let recipients = options.recipients;
    if (!recipients || recipients.length === 0) {
      const combined: string[] = [];
      try {
        combined.push(this.host.normalizedSelfJid());
      } catch (_) {}

      try {
        const contacts = this.host.listContacts ? this.host.listContacts() : [];
        for (const c of contacts) {
          const id = c.id || c.jid;
          if (this.isUserStatusJid(id)) {
            combined.push(id);
          }
        }
      } catch (_) {}

      if (combined.length <= 1) {
        try {
          const chats = this.host.listChats ? this.host.listChats() : [];
          for (const c of chats) {
            const id = c.id;
            if (this.isUserStatusJid(id)) {
              combined.push(id);
            }
          }
        } catch (_) {}
      }

      recipients = combined;
    }

    // Final safety fallback: include self and team so Baileys send never throws with 0 recipients
    if (!recipients || recipients.length === 0) {
      try {
        const ownJid = this.host.normalizedSelfJid();
        recipients = [ownJid, ...getTeamJids()];
      } catch (_) {
        recipients = getTeamJids();
      }
    }

    const statusJidList = Array.from(new Set(recipients.map(r => this.host.toEngineJid(r)).filter(Boolean)));
    this.logger.log(`Posting status to status@broadcast (${statusJidList.length} recipients)`);

    const sent = await this.sendStatus(
      content,
      {
        statusJidList,
        backgroundColor: options.backgroundColor,
        font: options.font,
      },
      expected,
    );
    this.logger.log(`Status posted: id=${sent?.key?.id ?? 'NONE'} key=${JSON.stringify(sent?.key ?? null)}`);
    this.host.rememberOwnSend(sent?.key?.id);

    const now = Date.now();
    for (const [id, audience] of this.audiences) {
      if (audience.expiresAt > now) break;
      this.audiences.delete(id);
    }
    if (sent?.key?.id) this.audiences.set(sent.key.id, { jids: statusJidList, expiresAt: now + STATUS_TTL_MS });
    return this.toStatusResult(sent);
  }

  /** Shape a Baileys send result into a StatusResult; expiresAt is timestamp + 24h (WhatsApp status TTL). */
  private toStatusResult(sent: WAMessage | undefined): StatusResult {
    const ts = sent?.messageTimestamp ? new Date(this.host.toUnixSeconds(sent.messageTimestamp) * 1000) : new Date();
    return {
      statusId: sent?.key?.id ?? '',
      timestamp: ts,
      expiresAt: new Date(ts.getTime() + STATUS_TTL_MS),
    };
  }
}
