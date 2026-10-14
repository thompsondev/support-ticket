import {
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { getConfig, saveConfig } from '../db';
import { COLORS } from '../util';
import type { Command } from './index';

export const setup: Command = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure the ticket system for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addRoleOption((o) =>
      o.setName('support_role').setDescription('Role that can answer tickets').setRequired(true),
    )
    .addRoleOption((o) => o.setName('admin_role').setDescription('Extra role treated as staff'))
    .addChannelOption((o) =>
      o
        .setName('log_channel')
        .setDescription('Channel for ticket event logs')
        .addChannelTypes(ChannelType.GuildText),
    )
    .addChannelOption((o) =>
      o
        .setName('transcript_channel')
        .setDescription('Channel where closed-ticket transcripts are posted')
        .addChannelTypes(ChannelType.GuildText),
    )
    .addIntegerOption((o) =>
      o.setName('max_tickets').setDescription('Max open tickets per user').setMinValue(1).setMaxValue(10),
    )
    .addIntegerOption((o) =>
      o
        .setName('autoclose_hours')
        .setDescription('Auto-close tickets idle this many hours (0 = disabled)')
        .setMinValue(0)
        .setMaxValue(168),
    )
    .addIntegerOption((o) =>
      o.setName('cooldown_seconds').setDescription('Cooldown between ticket opens').setMinValue(0),
    )
    .addStringOption((o) => o.setName('panel_title').setDescription('Default panel title'))
    .addStringOption((o) =>
      o.setName('panel_description').setDescription('Default panel description'),
    )
    .addChannelOption((o) =>
      o.setName('welcome_channel').setDescription('Channel for welcome messages').addChannelTypes(ChannelType.GuildText),
    )
    .addStringOption((o) =>
      o.setName('welcome_message').setDescription('Welcome text — {user} {server} {count} placeholders'),
    )
    .addRoleOption((o) => o.setName('autorole').setDescription('Role auto-assigned to new members'))
    .addChannelOption((o) =>
      o.setName('suggestions_channel').setDescription('Channel for /suggest posts').addChannelTypes(ChannelType.GuildText),
    )
    .addIntegerOption((o) =>
      o.setName('escalation_minutes').setDescription('Ping staff if no reply within N minutes (0 = off)').setMinValue(0),
    )
    .addBooleanOption((o) =>
      o.setName('welcome_card').setDescription('Send a generated welcome-card image on join'),
    )
    .addChannelOption((o) =>
      o.setName('starboard_channel').setDescription('Channel where ⭐ messages are reposted').addChannelTypes(ChannelType.GuildText),
    )
    .addIntegerOption((o) =>
      o.setName('starboard_threshold').setDescription('Stars needed to repost (default 3)').setMinValue(1).setMaxValue(50),
    )
    .addChannelOption((o) =>
      o.setName('voice_hub').setDescription('Join-to-create voice hub channel').addChannelTypes(ChannelType.GuildVoice),
    ),

  async execute(i: ChatInputCommandInteraction<'cached'>) {
    if (!i.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await i.reply({ content: 'You need Manage Server to run setup.', flags: MessageFlags.Ephemeral });
      return;
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });

    const guild = i.guild;
    const cfg = await getConfig(guild.id);
    const wcard = i.options.getBoolean('welcome_card');
    const everyone = guild.roles.everyone.id;

    // create the open/closed ticket categories if needed (hidden from @everyone)
    let openCat = cfg.open_category_id;
    if (!openCat || !guild.channels.cache.has(openCat)) {
      openCat = (
        await guild.channels.create({
          name: '🎫 Tickets',
          type: ChannelType.GuildCategory,
          permissionOverwrites: [{ id: everyone, deny: [PermissionFlagsBits.ViewChannel] }],
        })
      ).id;
    }
    let closedCat = cfg.closed_category_id;
    if (!closedCat || !guild.channels.cache.has(closedCat)) {
      closedCat = (
        await guild.channels.create({
          name: 'Closed Tickets',
          type: ChannelType.GuildCategory,
          permissionOverwrites: [{ id: everyone, deny: [PermissionFlagsBits.ViewChannel] }],
        })
      ).id;
    }

    await saveConfig(guild.id, {
      support_role_id: i.options.getRole('support_role', true).id,
      admin_role_id: i.options.getRole('admin_role')?.id ?? null,
      log_channel_id: i.options.getChannel('log_channel')?.id ?? cfg.log_channel_id,
      transcript_channel_id:
        i.options.getChannel('transcript_channel')?.id ?? cfg.transcript_channel_id,
      open_category_id: openCat,
      closed_category_id: closedCat,
      max_tickets: i.options.getInteger('max_tickets') ?? cfg.max_tickets,
      autoclose_hours: i.options.getInteger('autoclose_hours') ?? cfg.autoclose_hours,
      cooldown_seconds: i.options.getInteger('cooldown_seconds') ?? cfg.cooldown_seconds,
      panel_title: i.options.getString('panel_title') ?? cfg.panel_title,
      panel_description: i.options.getString('panel_description') ?? cfg.panel_description,
      welcome_channel_id: i.options.getChannel('welcome_channel')?.id ?? cfg.welcome_channel_id,
      welcome_message: i.options.getString('welcome_message') ?? cfg.welcome_message,
      autorole_id: i.options.getRole('autorole')?.id ?? cfg.autorole_id,
      suggestions_channel_id:
        i.options.getChannel('suggestions_channel')?.id ?? cfg.suggestions_channel_id,
      escalation_minutes: i.options.getInteger('escalation_minutes') ?? cfg.escalation_minutes,
      welcome_card: wcard === null ? cfg.welcome_card : wcard ? 1 : 0,
      starboard_channel_id: i.options.getChannel('starboard_channel')?.id ?? cfg.starboard_channel_id,
      starboard_threshold: i.options.getInteger('starboard_threshold') ?? cfg.starboard_threshold,
      voice_hub_channel_id: i.options.getChannel('voice_hub')?.id ?? cfg.voice_hub_channel_id,
    });

    const updated = await getConfig(guild.id);
    await i.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('✅ Ticket system configured')
          .setColor(COLORS.open)
          .addFields(
            { name: 'Support role', value: `<@&${updated.support_role_id}>`, inline: true },
            {
              name: 'Admin role',
              value: updated.admin_role_id ? `<@&${updated.admin_role_id}>` : '—',
              inline: true,
            },
            {
              name: 'Log channel',
              value: updated.log_channel_id ? `<#${updated.log_channel_id}>` : '—',
              inline: true,
            },
            {
              name: 'Transcripts',
              value: updated.transcript_channel_id ? `<#${updated.transcript_channel_id}>` : '—',
              inline: true,
            },
            { name: 'Max tickets/user', value: String(updated.max_tickets), inline: true },
            { name: 'Auto-close', value: `${updated.autoclose_hours}h idle`, inline: true },
          )
          .setDescription('Run `/panel` in any channel to post the ticket panel.'),
      ],
    });
  },
};
