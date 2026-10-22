import type { SharedCouncilContext, CouncilParticipant, CouncilInput, CouncilMode } from './types.js';
export declare class CouncilContext {
    ctx: SharedCouncilContext;
    constructor(input: {
        agenda: string;
        mode: CouncilMode;
        rounds: number;
        participants: CouncilParticipant[];
        councilInput?: CouncilInput;
    });
    refreshSnapshot(): void;
    addNote(key: string, value: unknown): void;
    mergeNotes(notes?: Record<string, unknown>): void;
    addArtifact(artifact: Omit<SharedCouncilContext['artifacts'][number], 'id' | 'at'>): void;
    getContext(): SharedCouncilContext;
}
//# sourceMappingURL=context.d.ts.map