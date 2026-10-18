import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import { setup } from './setup';
import { panel } from './panel';
import { ticket } from './ticket';
import { types } from './types';
import { link } from './link';
import { blacklist } from './blacklist';
import { stats } from './stats';
import { tag } from './tag';
import { suggest } from './suggest';
import { poll } from './poll';
import { mod } from './mod';
import { announce } from './announce';
import { giveaway } from './giveaway';
import { remind } from './remind';
import { automod } from './automod';
import { reactionrole } from './reactionrole';
import { sticky } from './sticky';
import { afk } from './afk';
import { userinfo, serverinfo } from './info';
import { cmd } from './cmd';
import { form } from './form';
import { help } from './help';
import { satellite } from './satellite';
import { issues } from './issues';

export interface Command {
  data:
    | SlashCommandBuilder
    | SlashCommandSubcommandsOnlyBuilder
    | SlashCommandOptionsOnlyBuilder;
  execute(i: ChatInputCommandInteraction<'cached'>): Promise<void>;
}

const all: Command[] = [
  setup, panel, ticket, types, link, blacklist, stats, tag, suggest, poll,
  mod, announce, giveaway, remind, automod, reactionrole, sticky, afk,
  userinfo, serverinfo, cmd, form, help, satellite, issues,
];

export const commands = new Map<string, Command>(all.map((c) => [c.data.name, c]));
