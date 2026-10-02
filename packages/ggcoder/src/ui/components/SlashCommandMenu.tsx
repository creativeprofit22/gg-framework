import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "../theme/theme.js";

export interface SlashCommandInfo {
  name: string;
  aliases: string[];
  description: string;
  /** Muted placeholder for accepted arguments, from `argument-hint` frontmatter. */
  argumentHint?: string;
  sectionTitle?: string;
}

interface SlashCommandMenuProps {
  commands: SlashCommandInfo[];
  selectedIndex: number;
  width: number;
}

const MAX_SUGGESTIONS_TO_SHOW = 8;

export function SlashCommandMenu({ commands, selectedIndex, width }: SlashCommandMenuProps) {
  const theme = useTheme();

  if (commands.length === 0) return null;

  const total = commands.length;
  const idx = Math.min(Math.max(selectedIndex, 0), total - 1);
  const start =
    total <= MAX_SUGGESTIONS_TO_SHOW
      ? 0
      : Math.max(
          0,
          Math.min(idx - Math.floor(MAX_SUGGESTIONS_TO_SHOW / 2), total - MAX_SUGGESTIONS_TO_SHOW),
        );
  const end = Math.min(start + MAX_SUGGESTIONS_TO_SHOW, total);
  const visible = commands.slice(start, end);
  const maxLabelLength = Math.max(...commands.map((cmd) => cmd.name.length));
  const commandColumnWidth = Math.min(maxLabelLength, Math.floor(width * 0.5));
  const selectedHint = commands[idx]?.argumentHint;

  return (
    <Box flexDirection="column" paddingX={1} width={width}>
      {start > 0 && <Text color={theme.text}>▲</Text>}
      {visible.map((cmd, i) => {
        const actualIndex = start + i;
        const previousSectionTitle = commands[actualIndex - 1]?.sectionTitle;
        const shouldRenderSectionHeader =
          !!cmd.sectionTitle && cmd.sectionTitle !== previousSectionTitle;
        const isSelected = actualIndex === idx;
        const textColor = isSelected ? theme.commandColor : theme.textDim;

        return (
          <Box key={cmd.name} flexDirection="column">
            {shouldRenderSectionHeader && (
              <Text color={theme.textDim}>-- {cmd.sectionTitle} --</Text>
            )}
            <Box flexDirection="row" backgroundColor={isSelected ? theme.border : undefined}>
              <Box width={commandColumnWidth} flexShrink={0}>
                <Text color={textColor}>{cmd.name}</Text>
              </Box>
              <Box flexGrow={1} paddingLeft={3}>
                <Text color={textColor} wrap="truncate">
                  {cmd.description.slice(0, 100)}
                </Text>
              </Box>
            </Box>
          </Box>
        );
      })}
      {end < total && <Text color={theme.textDim}>▼</Text>}
      {selectedHint && (
        <Text color={theme.textDim} italic wrap="truncate">
          /{commands[idx]?.name} {selectedHint}
        </Text>
      )}
      {total > MAX_SUGGESTIONS_TO_SHOW && (
        <Text color={theme.textDim}>
          ({idx + 1}/{total})
        </Text>
      )}
    </Box>
  );
}

/** Filter commands by partial name/alias fuzzy-ish prefix priority. */
export function filterCommands(commands: SlashCommandInfo[], filter: string): SlashCommandInfo[] {
  if (!filter) return commands;
  const lower = filter.toLowerCase();
  return commands
    .filter(
      (cmd) =>
        cmd.name.toLowerCase().includes(lower) ||
        cmd.aliases.some((a) => a.toLowerCase().includes(lower)),
    )
    .sort((a, b) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const aExact = aName === lower;
      const bExact = bName === lower;
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;
      const aPrefix = aName.startsWith(lower);
      const bPrefix = bName.startsWith(lower);
      if (aPrefix && !bPrefix) return -1;
      if (!aPrefix && bPrefix) return 1;
      return 0;
    });
}
