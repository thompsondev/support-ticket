import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildMember,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { addWarning, clearWarnings, getWarnings } from '../db';
import { logToGuild } from '../tickets';
import { COLORS, ephemeral, isStaff } from '../util';
import type { Command } from './index';

const STAFF_ONLY = new Set(['warn', 'warnings', 'clearwarnings', 'kick', 'ban', 'timeout', 'untimeout']);

async function dmUser(member: GuildMember, text: string): Promise<void> {
  await member.send({ embeds: [new EmbedBuilder().setDescription(text).setColor(COLORS.warn)] }).catch(() => {});
}

function modLog(title: string, target: string, mod: string, reason: string | null): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(COLORS.closed)
    .addFields(
      { name: 'User', value: `<@${target}>`, inline: true },
      { name: 'Moderator', value: `<@${mod}>`, inline: true },
      { name: 'Reason', value: reason ?? '—' },
    )
    .setTimestamp(Date.now());
}

export const mod: Command = {
  data: new SlashCommandBuilder()
    .setName('mod')
    .setDescription('Moderation tools (staff)')
    .addSubcommand((s) =>
      s.setName('warn').setDescription('Warn a user')
        .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName('warnings').setDescription('List a user\'s warnings')
        .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName('clearwarnings').setDescription('Clear a user\'s warnings')
        .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName('kick').setDescription('Kick a user')
        .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Reason')),
    )
    .addSubcommand((s) =>
      s.setName('ban').setDescription('Ban a user')
        .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Reason'))
        .addIntegerOption((o) =>
          o.setName('delete_days').setDescription('Days of messages to delete (0-7)').setMinValue(0).setMaxValue(7),
        ),
    )
    .addSubcommand((s) =>
      s.setName('timeout').setDescription('Timeout a user')
        .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
        .addIntegerOption((o) =>
          o.setName('minutes').setDescription('Duration').setRequired(true).setMinValue(1).setMaxValue(40320),
        )
        .addStringOption((o) => o.setName('reason').setDescription('Reason')),
    )
    .addSubcommand((s) =>
      s.setName('untimeout').setDescription('Remove a timeout')
        .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)),
    ),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    const sub = i.options.getSubcommand();
    if (!STAFF_ONLY.has(sub) || !await isStaff(i.member)) {
      await i.reply(ephemeral('Staff only.'));
      return;
    }

    const user = i.options.getUser('user', true);
    const member = await i.guild.members.fetch(user.id).catch(() => null);
    const reason = i.options.getString('reason');

    switch (sub) {
      case 'warn': {
        await addWarning(i.guildId, user.id, i.user.id, reason!);
        if (member) await dmUser(member, `⚠️ You were warned in **${i.guild.name}**: ${reason}`);
        await logToGuild(i.guild, modLog('User warned', user.id, i.user.id, reason));
        const count = (await getWarnings(i.guildId, user.id)).length;
        await i.reply(ephemeral(`⚠️ Warned ${user.tag} (now ${count} warning${count === 1 ? '' : 's'}).`));
        break;
      }
      case 'warnings': {
        const rows = await getWarnings(i.guildId, user.id);
        await i.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle(`Warnings — ${user.tag}`)
              .setColor(COLORS.warn)
              .setDescription(
                rows
                  .map((w) => `• <@${w.moderator_id}>: ${w.reason} — <t:${Math.floor(w.created_at / 1000)}:d>`)
                  .join('\n') || 'No warnings.',
              ),
          ],
          flags: ephemeral('').flags,
        });
        break;
      }
      case 'clearwarnings': {
        const n = await clearWarnings(i.guildId, user.id);
        await i.reply(ephemeral(n ? `Cleared ${n} warning(s) for ${user.tag}.` : `${user.tag} had no warnings.`));
        break;
      }
      case 'kick': {
        if (!member) return void (await i.reply(ephemeral('User is not in the server.')));
        if (!member.kickable) return void (await i.reply(ephemeral('I can\'t kick that user — check role hierarchy.')));
        await dmUser(member, `👢 You were kicked from **${i.guild.name}**${reason ? `: ${reason}` : ''}`);
        await member.kick(reason ?? undefined);
        await logToGuild(i.guild, modLog('User kicked', user.id, i.user.id, reason));
        await i.reply(`👢 Kicked ${user.tag}.`);
        break;
      }
      case 'ban': {
        const days = i.options.getInteger('delete_days') ?? 0;
        if (member && !member.bannable) return void (await i.reply(ephemeral('I can\'t ban that user — check role hierarchy.')));
        if (member) await dmUser(member, `🔨 You were banned from **${i.guild.name}**${reason ? `: ${reason}` : ''}`);
        await i.guild.members.ban(user.id, { deleteMessageSeconds: days * 86400, reason: reason ?? undefined });
        await logToGuild(i.guild, modLog('User banned', user.id, i.user.id, reason));
        await i.reply(`🔨 Banned ${user.tag}.`);
        break;
      }
      case 'timeout': {
        if (!member) return void (await i.reply(ephemeral('User is not in the server.')));
        if (!member.moderatable) return void (await i.reply(ephemeral('I can\'t timeout that user — check role hierarchy.')));
        const mins = i.options.getInteger('minutes', true);
        await member.timeout(mins * 60_000, reason ?? undefined);
        await dmUser(member, `⏱️ You were timed out in **${i.guild.name}** for ${mins}m${reason ? `: ${reason}` : ''}`);
        await logToGuild(i.guild, modLog(`User timed out (${mins}m)`, user.id, i.user.id, reason));
        await i.reply(`⏱️ Timed out ${user.tag} for ${mins}m.`);
        break;
      }
      case 'untimeout': {
        if (!member) return void (await i.reply(ephemeral('User is not in the server.')));
        await member.timeout(null);
        await logToGuild(i.guild, modLog('Timeout removed', user.id, i.user.id, null));
        await i.reply(`Timeout removed for ${user.tag}.`);
        break;
      }
    }
  },
};
