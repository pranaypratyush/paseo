import { randomUUID } from "node:crypto";
import { type NativeObservationOptions, writeNativeObservation } from "../native-observation.js";

interface OwnerSelection {
  ownerTurnId: string;
  nativeSessionId: string;
}
interface NativeTurnLink extends OwnerSelection {
  nativeTurnId: string;
  nativeUserItemId?: string;
}

export class CodexNativeObservation {
  private localProcessGeneration: string | null = null;
  private selection: OwnerSelection | null = null;
  private link: NativeTurnLink | null = null;
  private attempted = false;
  private invalid = false;

  constructor(private readonly options: NativeObservationOptions) {}

  connected(): void {
    this.localProcessGeneration = randomUUID();
    if (this.selection) this.invalid = true;
  }

  selectOwnerTurn(
    ownerTurnId: string,
    clientMessageId: string | null,
    nativeSessionId: string,
  ): void {
    if (clientMessageId !== this.options.ownerClientMessageId) return;
    if (this.selection || this.attempted) {
      this.invalid = true;
      return;
    }
    this.selection = { ownerTurnId, nativeSessionId };
  }

  started(
    nativeSessionId: string | null,
    nativeTurnId: string,
    pendingOwnerTurnId: string | null,
  ): void {
    if (!this.selection) return;
    if (
      this.link ||
      nativeSessionId !== this.selection.nativeSessionId ||
      pendingOwnerTurnId !== this.selection.ownerTurnId
    ) {
      this.invalid = true;
      return;
    }
    this.link = { ...this.selection, nativeTurnId };
  }

  userItem(
    nativeSessionId: string | null | undefined,
    nativeTurnId: string | null | undefined,
    clientMessageId: string | null | undefined,
    itemId: string | undefined,
  ): void {
    if (!this.link || clientMessageId !== this.options.ownerClientMessageId || !itemId) return;
    if (nativeSessionId !== this.link.nativeSessionId || nativeTurnId !== this.link.nativeTurnId) {
      this.invalid = true;
      return;
    }
    if (this.link.nativeUserItemId && this.link.nativeUserItemId !== itemId) this.invalid = true;
    this.link.nativeUserItemId = itemId;
  }

  completed(
    nativeSessionId: string | null,
    nativeTurnId: string | null,
    successful: boolean,
  ): void {
    if (!this.selection || this.attempted) return;
    this.attempted = true;
    if (
      !successful ||
      this.invalid ||
      !this.link ||
      !this.localProcessGeneration ||
      nativeSessionId !== this.link.nativeSessionId ||
      nativeTurnId !== this.link.nativeTurnId
    )
      return;
    writeNativeObservation(
      this.options.path,
      {
        format: "paseo.codex-turn-link.v1",
        actorId: this.options.actorId,
        localProcessGeneration: this.localProcessGeneration,
        ...this.link,
        ownerClientMessageId: this.options.ownerClientMessageId,
      },
      8192,
    );
  }
}
