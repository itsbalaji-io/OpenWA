import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Readable } from 'stream';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { StatusStoreService } from '../status-store/status-store.service';
import { Session } from '../session/entities/session.entity';
import { StorageService, isMissingObjectError } from '../../common/storage/storage.service';
import type { Status, StatusResult, StatusPostOptions } from '../../engine/interfaces/whatsapp-engine.interface';
import { assertBase64WithinMediaCap, resolveMediaBody, stripBase64DataUri } from '../message/media-cap.util';
import { HookManager, applySendingGate } from '../../core/hooks';
import { SendPacingService, countsTowardSendBreaker } from '../message/send-pacing.service';
import { clientFacingSsrfError } from '../../common/media/client-facing-ssrf-error';
import { isMediaUrl } from '../../common/media/media-url';
import { createLogger } from '../../common/services/logger.service';

/** Stored status media is only ever an image, a video or a voice note; a sender-declared mimetype
 * outside that is served as inert octet-stream so the media endpoint can't be turned into active
 * content (HTML/JS) on the API origin. Audio belongs here because a voice status is a first-class
 * status type — without it the dashboard's audio player is handed an octet-stream it cannot play.
 * `image/svg+xml` is excluded despite the image/ prefix: SVG is scriptable, so serving it with its
 * declared Content-Type would make the endpoint stored-XSS material — same exclusion the chat-media
 * path applies. The stored mimetype is engine-reported verbatim, so only its essence (the part before
 * any `;`, trimmed and lowercased) is checked and served, and it must be a single well-formed type:
 * a parameter list or a comma-joined second type could otherwise make a browser read the header as
 * something else. */
const SAFE_STATUS_MIMETYPE = /^(image|video|audio)\/[a-z0-9][a-z0-9.+-]*$/;

// The padding and its trailing whitespace are one optional group: a bare `=*\s*` after a class that
// also matches whitespace let a long whitespace run followed by any other character backtrack
// quadratically, and one request of padded spaces held the event loop for minutes.
const BASE64_TEXT = /^[A-Za-z0-9+/_\-\s]*(?:=+\s*)?$/;

@Injectable()
export class StatusService {
  private readonly logger = createLogger('StatusService');
  // HookManager comes from the @Global() HooksModule, StorageService from the @Global()
  // StorageModule — neither needs a module import here.
  constructor(
    private readonly engines: EngineRegistry,
    private readonly hookManager: HookManager,
    private readonly store: StatusStoreService,
    private readonly storageService: StorageService,
    private readonly pacing: SendPacingService,
    @Optional()
    @InjectRepository(Session, 'data')
    private readonly sessionRepo?: Repository<Session>,
  ) {}

  /**
   * A status post is content published from the account, so it goes through the same
   * `message:sending` moderation gate as a chat send. `source` distinguishes it from MessageService
   * for plugins that only want to police one of the two.
   *
   * Note for plugin authors: `input` here is NOT a send DTO — it carries no `chatId`. Text posts
   * receive `{ text, options }` and media posts `{ media: { mimetype, data }, options }`.
   */
  private async gate<T extends object>(sessionId: string, type: string, input: T): Promise<T> {
    // Pacing first, for the same reason as the chat path: a post the policy forbids is never offered
    // to plugins. A status post is published to the account's contacts, so it counts as outbound
    // traffic even though it addresses no single chat.
    await this.pacing.assertSendAllowed(sessionId);
    return applySendingGate(this.hookManager, sessionId, type, input, 'StatusService');
  }

  /**
   * Re-apply the media guards to whatever the gate returned. A plugin may rewrite `media.data`, and
   * a rewritten payload has to clear the same data-URI, url and size checks as the original — this is
   * what the chat path gets for free by gating first and calling buildMediaInput afterwards
   * (`message.service.ts`). Here the size guard runs before the gate too, so a plugin cannot use a
   * rewrite to slip past `MEDIA_DOWNLOAD_MAX_BYTES`.
   */
  private guardGatedMedia(media: { mimetype: string; data: string }): { mimetype: string; data: string } {
    // `data` carries either a URL or base64 — the two are indistinguishable once merged into one
    // field. Both helpers are safe over either form: stripping a data-URI prefix leaves a URL
    // untouched, and the decoded-byte cap on a URL-length string is trivially satisfied.
    const data = stripBase64DataUri(media.data) ?? media.data;
    // Both engines fetch only an http(s) URL and decode anything else as base64, so a value with another
    // scheme, or with a character base64 does not use (a path with an extension), would be posted as
    // noise. A path made only of base64 characters cannot be told apart from base64 and is sent as such.
    if (!isMediaUrl(data) && !BASE64_TEXT.test(data)) {
      throw new BadRequestException('media must be an absolute http(s) URL or base64');
    }
    assertBase64WithinMediaCap(data);
    return { mimetype: media.mimetype, data };
  }

  // Reads come from the store (StatusStoreService ingests status broadcasts as they arrive, plus a
  // best-effort seed on connect), not the engine — Baileys never implemented
  // `getContactStatuses`/`getContactStatus`, so both engines now answer reads identically from the
  // same 24h-TTL store.
  async getStatuses(sessionId: string): Promise<Status[]> {
    return this.store.list(sessionId);
  }

  async getContactStatus(sessionId: string, contactId: string): Promise<Status[]> {
    return this.store.listByContact(sessionId, contactId);
  }

  /** Opens the stored file as a stream, so a large video is never held in memory whole. */
  async getStatusMedia(
    sessionId: string,
    statusId: string,
  ): Promise<{ stream: Readable; size?: number; mimetype: string }> {
    const media = await this.store.getMedia(sessionId, statusId);
    if (!media) {
      throw new NotFoundException('Status media not found or expired');
    }
    try {
      // A missing or unreadable file rejects here, before anything is answered.
      const { stream, size } = await this.storageService.openFile(media.path);
      // MIME types are case-insensitive, and a browser treats `image/SVG+XML` exactly as it treats
      // `image/svg+xml`: the check runs on the normalized essence, and that is what gets served.
      const essence = media.mimetype.split(';')[0].trim().toLowerCase();
      const mimetype =
        SAFE_STATUS_MIMETYPE.test(essence) && essence !== 'image/svg+xml' ? essence : 'application/octet-stream';
      return { stream, size, mimetype };
    } catch (error) {
      // The row outlived its file: purgeExpired (or a concurrent delete) removed it between the
      // DB read and this read. That's "gone", not a server fault — surface a 404. The helper covers
      // both backends: the local ENOENT and the codeless NoSuchKey/NotFound an S3 miss raises.
      if (isMissingObjectError(error)) {
        throw new NotFoundException('Status media not found or expired');
      }
      throw error;
    }
  }

  /**
   * Report the engine post's outcome to the pacing breaker, exactly as the chat send path does
   * (message.service failSend/persistSentState): the engine was asked, so a refusal counts toward
   * the failure streak and an accept resets it. The pre-engine pacing/plugin gate runs OUTSIDE this
   * wrapper, so a policy refusal never feeds the breaker — and neither do the client-fault checks
   * the adapters run inside the call (Baileys refuses a status with no recipients, a media URL can
   * be SSRF-blocked): those say nothing about the account's standing. See countsTowardSendBreaker.
   * A media URL the SSRF guard refused leaves as the caller's 400, not as the guard's own error.
   */
  private async recordedPost(
    sessionId: string,
    kind: string,
    post: () => Promise<StatusResult>,
  ): Promise<StatusResult> {
    try {
      const result = await post();
      this.pacing.recordSendSuccess(sessionId);
      return result;
    } catch (error) {
      if (countsTowardSendBreaker(error)) {
        this.pacing.recordSendFailure(sessionId);
        // The same classification picks the failures worth a log line. Otherwise an engine-side failure
        // leaves only Nest's generic `[ExceptionsHandler]` line, with no session to correlate it with.
        this.logger.warn(`Status post failed in the engine (${kind})`, {
          sessionId,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          ...(error instanceof Error && error.cause instanceof Error ? { cause: error.cause.message } : {}),
        });
      }
      throw clientFacingSsrfError(error);
    }
  }

  private async resolveOwnStatusJid(sessionId: string): Promise<string> {
    if (this.sessionRepo) {
      const session = await this.sessionRepo.findOne({ where: { id: sessionId } }).catch(() => null);
      const digits = session?.phone?.replace(/\D/g, '');
      if (digits) return `${digits}@c.us`;
    }
    return 'me@c.us';
  }

  private async recordOwnPostedStatus(
    sessionId: string,
    result: StatusResult,
    details: {
      type: 'text' | 'image' | 'video' | 'voice';
      caption?: string;
      backgroundColor?: string;
      font?: number;
      media?: { mimetype: string; data: string };
    },
  ): Promise<void> {
    if (!result?.statusId) return;
    try {
      const contactJid = await this.resolveOwnStatusJid(sessionId);
      const isBase64 = details.media && !isMediaUrl(details.media.data);
      await this.store.ingest(sessionId, {
        waStatusId: result.statusId,
        contactJid,
        contactName: 'My Status',
        type: details.type,
        caption: details.caption,
        backgroundColor: details.backgroundColor,
        font: details.font,
        media:
          details.media && isBase64
            ? { mimetype: details.media.mimetype, data: details.media.data }
            : undefined,
        postedAt: result.timestamp ? new Date(result.timestamp).getTime() : Date.now(),
      });
    } catch (err) {
      this.logger.warn(`Failed to record own posted status ${result.statusId} in status store`, {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async getMyStatuses(
    sessionId?: string,
  ): Promise<Array<Status & { sessionId: string; sessionName?: string; sessionPhone?: string }>> {
    const sessions = this.sessionRepo
      ? sessionId
        ? await this.sessionRepo.find({ where: { id: sessionId } })
        : await this.sessionRepo.find()
      : sessionId
        ? [{ id: sessionId, name: sessionId, phone: undefined }]
        : [];

    const collected: Array<Status & { sessionId: string; sessionName?: string; sessionPhone?: string }> = [];
    for (const s of sessions) {
      const seen = new Set<string>();
      const digits = s.phone?.replace(/\D/g, '');
      const candidates = Array.from(new Set([...(digits ? [`${digits}@c.us`] : []), 'me@c.us']));
      for (const jid of candidates) {
        const items = await this.store.listByContact(s.id, jid);
        for (const item of items) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          collected.push({
            ...item,
            sessionId: s.id,
            sessionName: s.name || s.id,
            sessionPhone: s.phone || undefined,
          });
        }
      }
    }
    collected.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return collected;
  }

  async postTextStatus(sessionId: string, text: string, options: StatusPostOptions): Promise<StatusResult> {
    const engine = this.engines.require(
      sessionId,
      () => new NotFoundException(`Session ${sessionId} not found or not connected`),
    );
    const gated = await this.gate(sessionId, 'status-text', { text, options });
    const result = await this.recordedPost(sessionId, 'text', () =>
      engine.postTextStatus(gated.text, gated.options),
    );
    await this.recordOwnPostedStatus(sessionId, result, {
      type: 'text',
      caption: gated.text,
      backgroundColor: gated.options.backgroundColor,
      font: gated.options.font,
    });
    return result;
  }

  async postImageStatus(
    sessionId: string,
    media: { url?: string; base64?: string; mimetype?: string } | undefined,
    options: StatusPostOptions,
  ): Promise<StatusResult> {
    const payload = resolveMediaBody(media, { fallbackMimetype: 'image/jpeg' });
    const engine = this.engines.require(
      sessionId,
      () => new NotFoundException(`Session ${sessionId} not found or not connected`),
    );
    const gated = await this.gate(sessionId, 'status-image', { media: payload, options });
    const guarded = this.guardGatedMedia(gated.media);
    const result = await this.recordedPost(sessionId, 'image', () =>
      engine.postImageStatus(guarded, gated.options),
    );
    await this.recordOwnPostedStatus(sessionId, result, {
      type: 'image',
      caption: gated.options.caption,
      media: guarded,
    });
    return result;
  }

  async postVideoStatus(
    sessionId: string,
    media: { url?: string; base64?: string; mimetype?: string } | undefined,
    options: StatusPostOptions,
  ): Promise<StatusResult> {
    const payload = resolveMediaBody(media, { fallbackMimetype: 'video/mp4' });
    const engine = this.engines.require(
      sessionId,
      () => new NotFoundException(`Session ${sessionId} not found or not connected`),
    );
    const gated = await this.gate(sessionId, 'status-video', { media: payload, options });
    const guarded = this.guardGatedMedia(gated.media);
    const result = await this.recordedPost(sessionId, 'video', () =>
      engine.postVideoStatus(guarded, gated.options),
    );
    await this.recordOwnPostedStatus(sessionId, result, {
      type: 'video',
      caption: gated.options.caption,
      media: guarded,
    });
    return result;
  }

  /**
   * Post an audio status as a voice note.
   *
   * The mimetype defaults to Ogg/Opus because that is the only thing WhatsApp plays as a status
   * voice note, and neither engine transcodes — the media conversion endpoints produce it. A caller
   * that supplies another type is taken at its word; the result is an unplayable bubble, exactly as
   * it is for a voice message.
   *
   * There is no caption: WhatsApp has nowhere to render one on a status voice note.
   */
  async postVoiceStatus(
    sessionId: string,
    media: { url?: string; base64?: string; mimetype?: string } | undefined,
    options: StatusPostOptions,
  ): Promise<StatusResult> {
    const payload = resolveMediaBody(media, { fallbackMimetype: 'audio/ogg; codecs=opus' });
    const engine = this.engines.require(
      sessionId,
      () => new NotFoundException(`Session ${sessionId} not found or not connected`),
    );
    const gated = await this.gate(sessionId, 'status-voice', { media: payload, options });
    const guarded = this.guardGatedMedia(gated.media);
    const result = await this.recordedPost(sessionId, 'voice', () =>
      engine.postVoiceStatus(guarded, gated.options),
    );
    await this.recordOwnPostedStatus(sessionId, result, {
      type: 'voice',
      backgroundColor: gated.options.backgroundColor,
      media: guarded,
    });
    return result;
  }

  async deleteStatus(sessionId: string, statusId: string): Promise<void> {
    const engine = this.engines.require(
      sessionId,
      () => new NotFoundException(`Session ${sessionId} not found or not connected`),
    );
    try {
      await engine.deleteStatus(statusId);
    } finally {
      await this.store.remove(sessionId, statusId).catch(() => {});
    }
  }
}
