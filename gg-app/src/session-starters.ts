/**
 * One-click starting points for an empty Code or Chat session. Picking one fills
 * the composer; the user finishes or edits the sentence before sending.
 * Labels are verb + object; prompts either stand alone or end ready to finish.
 */
export const CODE_STARTERS = [
  {
    label: "Explain this project",
    prompt: "Explain how this project is organized and where I should start reading.",
  },
  { label: "Fix a bug", prompt: "Find and fix this bug: " },
  { label: "Add a feature", prompt: "Add this feature: " },
  {
    label: "Review my changes",
    prompt: "Review my uncommitted changes and point out real problems.",
  },
] as const;

export const CHAT_STARTERS = [
  { label: "Explain a topic", prompt: "Explain this simply: " },
  { label: "Draft a message", prompt: "Help me write a message about: " },
  { label: "Brainstorm ideas", prompt: "Brainstorm ideas for: " },
] as const;

/** Drafted by the empty Tasks view. It asks the agent to add tasks; nothing runs. */
export const TASKS_DRAFT_PROMPT = "Break this work into project tasks I can run later: ";
