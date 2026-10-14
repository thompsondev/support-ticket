import {
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { getSatellite, removeSatellite, setSatellite, updateSatellite, referralsForGuild } from '../db';
import { COLORS, ephemeral } from '../util';
import { isSupportMessage, satelliteReplyText } from '../satellites';
import type { Command } from './index';

export const satellite: Command = {
  data: new SlashCommandBuilder()
    .setName('satellite')
    .setDescription('Route support questions in this server to a ticket hub (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('link')
        .setDescription('Turn this server into a satellite of a support hub')
        .addStringOption((o) =>
          o.setName('invite').setDescription('Invite URL to the support server (discord.gg/…)').setRequired(true),
        )
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Only watch this channel (omit = all channels)').addChannelTypes(ChannelType.GuildText),
        )
        .addStringOption((o) => o.setName('reply').setDescription('Custom reply text — {invite} is added automatically')),
    )
    .addSubcommand((s) => s.setName('status').setDescription('Show satellite config + referral stats'))
    .addSubcommand((s) =>
      s
        .setName('test')
        .setDescription('Dry-run the auto-responder on sample text')
        .addStringOption((o) => o.setName('text').setDescription('Message to test').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('toggle')
        .setDescription('Enable/disable the auto-responder')
        .addBooleanOption((o) => o.setName('enabled').setDescription('on/off').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('ratelimit')
        .setDescription('Minutes between replies to the same user')
        .addIntegerOption((o) => o.setName('minutes').setDescription('Minutes').setRequired(true).setMinValue(1).setMaxValue(1440)),
    )
    .addSubcommand((s) =>
      s
        .setName('ai')
        .setDescription('Toggle AI intent detection (catches vague questions)')
        .addBooleanOption((o) => o.setName('enabled').setDescription('on/off').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('unlink').setDescription('Stop satellite mode in this server')),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    if (!i.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await i.reply(ephemeral('You need Manage Server.'));
      return;
    }
    const sub = i.options.getSubcommand();

    if (sub === 'link') {
      const raw = i.options.getString('invite', true).trim();
      const code = raw.match(/(?:discord\.gg\/|discord\.com\/invite\/)([\w-]+)/i)?.[1] ?? raw;
      const invite = await i.client.fetchInvite(code).catch(() => null);
      if (!invite?.guild) {
        await i.reply(ephemeral('Invalid invite — use a full `discord.gg/code` link.'));
        return;
      }
      if (invite.guild.id === i.guildId) {
        await i.reply(ephemeral('The invite points at this same server — pick the support hub server.'));
        return;
      }
      const channel = i.options.getChannel('channel');
      const existing = await getSatellite(i.guildId);
      const existingChannels = existing ? (JSON.parse(existing.channels || '[]') as string[]) : [];
      const channels = channel ? [channel.id] : existingChannels;
      const inviteUrl = `https://discord.gg/${invite.code}`;
      await setSatellite(i.guildId, invite.guild.id, inviteUrl, {
        channels,
        reply_text: i.options.getString('reply')?.slice(0, 500) ?? existing?.reply_text ?? null,
      });
      await i.reply(
        ephemeral(
          `🛰️ **Satellite mode linked** → **${invite.guild.name}**\n` +
            `Support questions here will be answered with the invite ${inviteUrl}` +
            `${channel ? `\nWatching: <#${channel.id}> only.` : '\nWatching: all channels.'}`,
        ),
      );
      return;
    }

    const sat = await getSatellite(i.guildId);
    if (!sat) {
      await i.reply(ephemeral('This server is not linked — run `/satellite link invite:…` first.'));
      return;
    }

    switch (sub) {
      case 'status': {
        const channels = JSON.parse(sat.channels || '[]') as string[];
        const refs = await referralsForGuild(i.guildId, 500);
        const converted = refs.filter((r) => r.converted_at).length;
        await i.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle('🛰️ Satellite status')
              .setColor(sat.enabled ? COLORS.open : COLORS.closed)
              .addFields(
                { name: 'Status', value: sat.enabled ? '✅ Active' : '⏸️ Paused', inline: true },
                { name: 'AI detection', value: sat.ai_enabled ? 'On' : 'Off', inline: true },
                { name: 'Rate limit', value: `${sat.rate_limit_minutes}m / user`, inline: true },
                { name: 'Hub invite', value: sat.hub_invite },
                {
                  name: 'Watched channels',
                  value: channels.length ? channels.map((c) => `<#${c}>`).join(', ') : 'All channels',
                },
                { name: 'Referrals sent', value: String(refs.length), inline: true },
                { name: 'Joined hub', value: String(converted), inline: true },
              ),
          ],
          flags: ephemeral('').flags,
        });
        break;
      }
      case 'test': {
        const text = i.options.getString('text', true);
        const hit = await isSupportMessage(sat, text, i.guild.name);
        const preview = hit ? await satelliteReplyText(sat, text, i.guild.name) : null;
        await i.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle(`🛰️ Responder test — ${hit ? 'would reply ✅' : 'would NOT reply ❌'}`)
              .setColor(hit ? COLORS.open : COLORS.closed)
              .setDescription(preview ?? 'Message did not look like a support issue.'),
          ],
          flags: ephemeral('').flags,
        });
        break;
      }
      case 'toggle': {
        await updateSatellite(i.guildId, { enabled: i.options.getBoolean('enabled', true) ? 1 : 0 });
        await i.reply(ephemeral(i.options.getBoolean('enabled', true) ? '🛰️ Responder enabled.' : '⏸️ Responder paused.'));
        break;
      }
      case 'ratelimit': {
        await updateSatellite(i.guildId, { rate_limit_minutes: i.options.getInteger('minutes', true) });
        await i.reply(ephemeral(`Rate limit set to ${i.options.getInteger('minutes', true)}m per user.`));
        break;
      }
      case 'ai': {
        await updateSatellite(i.guildId, { ai_enabled: i.options.getBoolean('enabled', true) ? 1 : 0 });
        await i.reply(ephemeral(i.options.getBoolean('enabled', true) ? '🤖 AI detection on.' : '🤖 AI detection off — keyword matching only.'));
        break;
      }
      case 'unlink': {
        await removeSatellite(i.guildId);
        await i.reply(ephemeral('🛰️ Satellite mode removed.'));
        break;
      }
    }
  },
};
