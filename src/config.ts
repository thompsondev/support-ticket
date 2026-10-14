import { readFileSync } from 'node:fs';

export interface TicketType {
  id: string;
  label: string;
  description: string;
  emoji?: string;
}

export interface LinkDef {
  label: string;
  url: string;
  description?: string;
}

export interface BotConfig {
  ticketTypes: TicketType[];
  links: LinkDef[];
  panel: { title: string; description: string };
}

export const botConfig: BotConfig = JSON.parse(readFileSync('config.json', 'utf8'));

export function getType(id: string): TicketType | undefined {
  return botConfig.ticketTypes.find((t) => t.id === id);
}
