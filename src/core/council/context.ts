import { randomUUID } from 'node:crypto';
import type { SharedCouncilContext, CouncilParticipant, CouncilInput, CouncilMode } from './types.js';

export class CouncilContext {
  ctx: SharedCouncilContext;

  constructor(input: {
    agenda: string;
    mode: CouncilMode;
    rounds: number;
    participants: CouncilParticipant[];
    councilInput?: CouncilInput;
  }) {
    this.ctx = {
      id: `council-${randomUUID().slice(0, 8)}`,
      startedAt: Date.now(),
      agenda: input.agenda,
      mode: input.mode,
      rounds: input.rounds,
      participants: input.participants,
      input: input.councilInput ?? { agenda: input.agenda },
      transcript: [],
      findings: [],
      decisions: [],
      actionItems: [],
      questions: [],
      notes: {},
      artifacts: [],
      snapshot: {},
    };
    this.refreshSnapshot();
  }

  refreshSnapshot(): void {
    const last = this.ctx.transcript[this.ctx.transcript.length - 1];
    const lastBy: Record<string, string> = {};
    for (const entry of this.ctx.transcript) lastBy[entry.participantId] = entry.content;

    this.ctx.snapshot = {
      id: this.ctx.id,
      agenda: this.ctx.agenda,
      mode: this.ctx.mode,
      round: this.ctx.transcript.length > 0 ? this.ctx.transcript[this.ctx.transcript.length - 1]!.round : 0,
      participantCount: this.ctx.participants.length,
      transcriptCount: this.ctx.transcript.length,
      findings: this.ctx.findings,
      findingsCount: this.ctx.findings.length,
      decisions: this.ctx.decisions,
      decisionsCount: this.ctx.decisions.length,
      actionItems: this.ctx.actionItems,
      actionItemsCount: this.ctx.actionItems.length,
      questions: this.ctx.questions,
      notes: this.ctx.notes,
      artifacts: this.ctx.artifacts,
      lastEntry: last,
      lastBy,
      recent: this.ctx.transcript.slice(-12),
    };
  }

  addNote(key: string, value: unknown): void {
    this.ctx.notes[key] = value;
    this.refreshSnapshot();
  }

  mergeNotes(notes?: Record<string, unknown>): void {
    if (!notes) return;
    this.ctx.notes = { ...this.ctx.notes, ...notes };
    this.refreshSnapshot();
  }

  addArtifact(artifact: Omit<SharedCouncilContext['artifacts'][number], 'id' | 'at'>): void {
    this.ctx.artifacts.push({ id: `art-${randomUUID().slice(0, 6)}`, at: Date.now(), ...artifact });
    this.refreshSnapshot();
  }

  getContext(): SharedCouncilContext {
    return this.ctx;
  }
}
