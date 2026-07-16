#!/usr/bin/env node
declare function inspectCodexSkill(codexHome?: string): import("./core/skill-installer.ts").CodexSkillInspection;
export declare function formatSkillUpdateNotice(skill: ReturnType<typeof inspectCodexSkill>): string | null;
export declare function main(argv?: string[]): Promise<number>;
export {};
