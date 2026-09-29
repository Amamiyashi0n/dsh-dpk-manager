/** Persistent system-prompt overrides owned by zcode-provider. */
import { type PromptOverrides } from './official-prompt.js';
export declare function defaultPromptOverridesPath(storageRoot?: string): string;
export declare function readPromptOverrides(path: string): PromptOverrides;
export declare function writePromptOverrides(path: string, value: PromptOverrides): void;
export declare function hasPromptOverrides(value: PromptOverrides): boolean;
