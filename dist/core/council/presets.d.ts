export interface RolePreset {
    id: string;
    name: string;
    title: string;
    role: string;
    goal: string;
    persona: string;
    /** Preferred targets: tool id or op id. Bridge will pick the first available. */
    prefer: string[];
    tags: string[];
}
export declare const ROLE_PRESETS: RolePreset[];
export declare function getPreset(id: string): RolePreset | undefined;
export declare function resolvePreset(id: string): RolePreset;
export declare function autoAssemble(agenda: string): RolePreset[];
//# sourceMappingURL=presets.d.ts.map