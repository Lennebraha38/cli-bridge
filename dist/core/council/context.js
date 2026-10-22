import { randomUUID } from 'node:crypto';
export class CouncilContext {
    ctx;
    constructor(input) {
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
    refreshSnapshot() {
        const last = this.ctx.transcript[this.ctx.transcript.length - 1];
        const lastBy = {};
        for (const entry of this.ctx.transcript)
            lastBy[entry.participantId] = entry.content;
        this.ctx.snapshot = {
            id: this.ctx.id,
            agenda: this.ctx.agenda,
            mode: this.ctx.mode,
            round: this.ctx.transcript.length > 0 ? this.ctx.transcript[this.ctx.transcript.length - 1].round : 0,
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
    addNote(key, value) {
        this.ctx.notes[key] = value;
        this.refreshSnapshot();
    }
    mergeNotes(notes) {
        if (!notes)
            return;
        this.ctx.notes = { ...this.ctx.notes, ...notes };
        this.refreshSnapshot();
    }
    addArtifact(artifact) {
        this.ctx.artifacts.push({ id: `art-${randomUUID().slice(0, 6)}`, at: Date.now(), ...artifact });
        this.refreshSnapshot();
    }
    getContext() {
        return this.ctx;
    }
}
//# sourceMappingURL=context.js.map