import { createContext } from "react";
import type { KenPromptActionDispatcher } from "./ken-prompt-actions";

export const KenPromptActionContext = createContext<KenPromptActionDispatcher | null>(null);
export const KenPromptActionProvider = KenPromptActionContext.Provider;
