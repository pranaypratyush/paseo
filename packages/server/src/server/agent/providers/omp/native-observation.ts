import { randomUUID } from "node:crypto";
import { z } from "zod";
import { NativeObservationOptionsSchema, writeNativeObservation } from "../native-observation.js";
import type { OmpBridgedToolIdentity } from "./mcp-bridge.js";
import type { OmpRuntimeEvent, OmpSessionState } from "./rpc-types.js";
import {
  OMP_QUALIFICATION_RECIPE,
  type OmpQualification,
  type QualificationTerminal,
} from "./qualification.js";

const OBSERVATION_FAILURE = "OMP native schema observation failed; qualification is unknown";

export const OmpNativeObservationOptionsSchema = NativeObservationOptionsSchema.extend({
  tools: z
    .array(z.object({ server: z.string().min(1), tool: z.string().min(1) }).strict())
    .min(1)
    .max(256),
  qualificationRecipe: z.literal(OMP_QUALIFICATION_RECIPE).optional(),
})
  .strict()
  .refine(
    (options) =>
      new Set(options.tools.map((tool) => `${tool.server}\0${tool.tool}`)).size ===
      options.tools.length,
    "Duplicate observation tool selection",
  );
export type OmpNativeObservationOptions = z.infer<typeof OmpNativeObservationOptionsSchema>;

const NativeToolSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  examples: z.unknown().optional(),
});

interface SelectedMapping extends OmpBridgedToolIdentity {
  nativeName: string;
}
interface StateSnapshot {
  nativeSessionId: string;
  stateRpcId: string;
  registrationRpcId: string;
  mappings: SelectedMapping[];
  tools: Array<z.infer<typeof NativeToolSchema>>;
}

interface PromptSnapshot extends StateSnapshot {
  ownerTurnId: string;
}

export class OmpNativeObservation {
  private readonly localProcessGeneration = randomUUID();
  private registrationRpcId: string | null = null;
  private mappings: SelectedMapping[] = [];
  private snapshot: StateSnapshot | null = null;
  private ownerTurnId: string | null = null;
  private attempted = false;
  private pendingQualified: { snapshot: PromptSnapshot; requestId: string } | null = null;
  private pendingTerminal: QualificationTerminal | null = null;
  private terminalAttempted = false;
  private disposition: "pending" | "recorded" | "failed" = "pending";

  constructor(
    private readonly options: OmpNativeObservationOptions,
    readonly qualification?: OmpQualification,
  ) {}

  outcome(ownerTurnId: string | undefined): "pending" | "recorded" | "failed" | null {
    const selectedOwner = this.pendingQualified?.snapshot.ownerTurnId ?? this.ownerTurnId;
    if (!this.qualification || !this.attempted || !selectedOwner || selectedOwner !== ownerTurnId)
      return null;
    return this.disposition;
  }

  failureForOwner(ownerTurnId: string | undefined): string | null {
    return this.outcome(ownerTurnId) === "failed" ? OBSERVATION_FAILURE : null;
  }

  fail(): void {
    this.disposition = "failed";
    this.terminalAttempted = true;
  }

  setMappings(identities: ReadonlyMap<string, OmpBridgedToolIdentity>): void {
    this.mappings = this.options.tools.map((selected) => {
      const matches = [...identities].filter(
        ([, identity]) => identity.server === selected.server && identity.tool === selected.tool,
      );
      const match = matches[0];
      if (matches.length !== 1 || !match)
        throw new Error("Native observation tool mapping is missing or ambiguous");
      return { nativeName: match[0], server: selected.server, tool: selected.tool };
    });
    this.snapshot = null;
  }

  registered(requestId: string): void {
    this.registrationRpcId = requestId;
    this.snapshot = null;
  }

  stateReceived(state: OmpSessionState, requestId: string): void {
    if (this.attempted || !this.registrationRpcId || this.mappings.length === 0) return;
    if (!Array.isArray(state.dumpTools))
      throw new Error("Native active tool schemas are unavailable");
    const rawTools: unknown[] = state.dumpTools;
    const tools = this.mappings.map((mapping) => {
      const matches = rawTools.filter(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          "name" in value &&
          value.name === mapping.nativeName,
      );
      if (matches.length !== 1)
        throw new Error("Native active tool schema is missing or duplicated");
      return NativeToolSchema.parse(matches[0]);
    });
    const snapshot = {
      nativeSessionId: state.sessionId,
      stateRpcId: requestId,
      registrationRpcId: this.registrationRpcId,
      mappings: this.mappings,
      tools,
    };
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > 1024 * 1024)
      throw new Error("Native tool schema exceeds observation limit");
    this.qualification?.stateReceived(state);
    this.snapshot = structuredClone(snapshot);
  }

  selectOwnerTurn(ownerTurnId: string, clientMessageId: string | null): void {
    const selected = clientMessageId === this.options.ownerClientMessageId ? ownerTurnId : null;
    if (this.ownerTurnId && this.ownerTurnId !== selected) this.qualification?.ownerChanged();
    this.ownerTurnId = selected;
  }

  preparePrompt(message: string): PromptSnapshot | null {
    this.qualification?.prompt(message, this.ownerTurnId !== null);
    if (!this.ownerTurnId || this.attempted) return null;
    if (!this.snapshot) throw new Error("Selected native schema observation is unavailable");
    this.attempted = true;
    return { ...this.snapshot, ownerTurnId: this.ownerTurnId };
  }

  promptAccepted(snapshot: PromptSnapshot | null, requestId: string): void {
    if (!snapshot) return;
    if (this.qualification) {
      this.pendingQualified = { snapshot, requestId };
      try {
        this.flushQualified();
      } catch {
        this.fail();
        throw new Error(OBSERVATION_FAILURE);
      }
      return;
    }
    this.writeRecord(snapshot, requestId);
  }

  event(event: OmpRuntimeEvent): void {
    if (!this.qualification || this.disposition === "failed") return;
    const selectedTool =
      event.type === "tool_execution_start" &&
      this.mappings.some((mapping) => mapping.nativeName === event.toolName);
    this.qualification.event(event.type, selectedTool);
    if (event.type !== "prompt_result" || !this.attempted || this.terminalAttempted) return;
    if (
      this.pendingTerminal ||
      typeof event.id !== "string" ||
      typeof event.agentInvoked !== "boolean" ||
      typeof event.status !== "string" ||
      typeof event.sessionSettled !== "boolean"
    ) {
      this.terminalAttempted = true;
      throw new Error("Qualification terminal is missing or ambiguous");
    }
    this.pendingTerminal = {
      type: "prompt_result",
      id: event.id,
      agentInvoked: event.agentInvoked,
      status: event.status,
      sessionSettled: event.sessionSettled,
    };
    this.flushQualified();
  }

  private flushQualified(): void {
    if (!this.pendingQualified || !this.pendingTerminal || this.terminalAttempted) return;
    this.terminalAttempted = true;
    if (this.pendingQualified.requestId !== this.pendingTerminal.id)
      throw new Error("Qualification terminal belongs to another native prompt");
    this.writeRecord(
      this.pendingQualified.snapshot,
      this.pendingQualified.requestId,
      this.pendingTerminal,
    );
  }

  private writeRecord(
    snapshot: PromptSnapshot,
    requestId: string,
    terminal?: QualificationTerminal,
  ): void {
    const qualificationContext = terminal ? this.qualification?.terminal(terminal) : undefined;
    writeNativeObservation(
      this.options.path,
      {
        format: "paseo.omp-active-state.v1",
        provider: "omp",
        observation: "native-active-state",
        localObservationId: randomUUID(),
        actorId: this.options.actorId,
        localProcessGeneration: this.localProcessGeneration,
        nativeSessionId: snapshot.nativeSessionId,
        registrationRpcId: snapshot.registrationRpcId,
        stateRpcId: snapshot.stateRpcId,
        ownerTurnId: snapshot.ownerTurnId,
        ownerClientMessageId: this.options.ownerClientMessageId,
        promptRpcId: requestId,
        tools: snapshot.tools,
        mappings: snapshot.mappings,
        ...(qualificationContext ? { qualificationContext } : {}),
      },
      1024 * 1024,
    );
    if (this.disposition !== "failed") this.disposition = "recorded";
  }
}
